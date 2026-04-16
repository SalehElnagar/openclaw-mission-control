# ruff: noqa: INP001
"""Tests for cross-board task scope, hierarchy, and standby status."""

from __future__ import annotations

from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, asc, col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api import agent as agent_api
from app.api import tasks as tasks_api_module
from app.api.deps import ActorContext
from app.core.agent_auth import AgentAuthContext
from app.core.time import utcnow
from app.models.activity_events import ActivityEvent
from app.models.agents import Agent
from app.models.board_groups import BoardGroup
from app.models.boards import Board
from app.models.gateways import Gateway
from app.models.organizations import Organization
from app.models.task_dependencies import TaskDependency
from app.models.tasks import Task
from app.schemas.tasks import TaskUpdate
from app.services.openclaw.constants import DEFAULT_HEARTBEAT_CONFIG, HEARTBEAT_STALE_GRACE
from app.services.openclaw.presence_policy import (
    desired_heartbeat_config_for_agent,
    heartbeat_offline_after,
)
from app.services.openclaw.provisioning_db import AgentLifecycleService
from app.services.task_dependencies import validate_dependency_update
from app.services.task_hierarchy import validate_parent_task_update


async def _make_engine() -> AsyncEngine:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    return engine


@pytest.mark.asyncio
async def test_parent_and_dependency_updates_allow_same_board_group_scope() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            requirements = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Requirements",
                slug="requirements",
            )
            in_progress = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="In Progress",
                slug="in-progress",
            )
            parent = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=requirements.id,
                title="Parent initiative",
            )
            child = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=in_progress.id,
                title="Builder task",
            )
            session.add(org)
            session.add(gateway)
            session.add(group)
            session.add(requirements)
            session.add(in_progress)
            session.add(parent)
            session.add(child)
            await session.commit()

            normalized_parent = await validate_parent_task_update(
                session,
                board_id=in_progress.id,
                task_id=child.id,
                parent_task_id=parent.id,
            )
            normalized_deps = await validate_dependency_update(
                session,
                board_id=in_progress.id,
                task_id=child.id,
                depends_on_task_ids=[parent.id],
            )

            assert normalized_parent == parent.id
            assert normalized_deps == [parent.id]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_parent_and_dependency_updates_reject_out_of_scope_tasks() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            requirements = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Requirements",
                slug="requirements",
            )
            inbox = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                name="Inbox",
                slug="inbox",
            )
            parent = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=requirements.id,
                title="Parent initiative",
            )
            unrelated = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=inbox.id,
                title="Unrelated work",
            )
            session.add(org)
            session.add(gateway)
            session.add(group)
            session.add(requirements)
            session.add(inbox)
            session.add(parent)
            session.add(unrelated)
            await session.commit()

            with pytest.raises(HTTPException) as parent_exc:
                await validate_parent_task_update(
                    session,
                    board_id=inbox.id,
                    task_id=unrelated.id,
                    parent_task_id=parent.id,
                )
            with pytest.raises(HTTPException) as dep_exc:
                await validate_dependency_update(
                    session,
                    board_id=inbox.id,
                    task_id=unrelated.id,
                    depends_on_task_ids=[parent.id],
                )

            assert parent_exc.value.status_code == 404
            assert dep_exc.value.status_code == 404
    finally:
        await engine.dispose()


def test_default_heartbeat_config_is_standby_first() -> None:
    assert DEFAULT_HEARTBEAT_CONFIG["every"] == "0m"
    assert DEFAULT_HEARTBEAT_CONFIG["target"] == "none"
    assert DEFAULT_HEARTBEAT_CONFIG["includeReasoning"] is False


def test_with_computed_status_uses_standby_for_event_driven_agents() -> None:
    agent = Agent(
        gateway_id=uuid4(),
        name="Security",
        status="online",
        heartbeat_config={"every": "0m", "target": "none"},
        last_seen_at=utcnow(),
    )

    computed = AgentLifecycleService.with_computed_status(agent)

    assert computed.status == "standby"
    assert AgentLifecycleService.status_reason(computed) == (
        "Standby by default; the agent is healthy and will wake only for real work."
    )


def test_with_computed_status_keeps_stale_heartbeat_agents_offline() -> None:
    offline_after = heartbeat_offline_after({"every": "5m", "target": "last"})
    assert offline_after == timedelta(minutes=5) + HEARTBEAT_STALE_GRACE
    agent = Agent(
        gateway_id=uuid4(),
        name="Builder",
        status="online",
        heartbeat_config={"every": "5m", "target": "api"},
        last_seen_at=utcnow() - offline_after - timedelta(seconds=1),
    )

    computed = AgentLifecycleService.with_computed_status(agent)

    assert computed.status == "offline"
    assert AgentLifecycleService.status_reason(computed) == (
        "Missed the expected active heartbeat window (10m timeout including grace)."
    )


def test_desired_heartbeat_config_wakes_lead_for_top_level_planning_work() -> None:
    requirements_id = uuid4()
    lead = Agent(
        id=uuid4(),
        gateway_id=uuid4(),
        board_id=requirements_id,
        name="Lead",
        is_board_lead=True,
        heartbeat_config={"every": "0m", "target": "none"},
    )
    planning_task = Task(
        id=uuid4(),
        organization_id=uuid4(),
        board_id=requirements_id,
        title="New initiative",
        status="inbox",
        parent_task_id=None,
    )

    desired = desired_heartbeat_config_for_agent(
        lead,
        board_name_by_id={requirements_id: "Requirements"},
        tasks=[planning_task],
        paused_board_ids=set(),
    )

    assert desired["every"] == "10m"
    assert desired["target"] == "last"


def test_desired_heartbeat_config_keeps_worker_in_standby_without_active_work() -> None:
    review_id = uuid4()
    reviewer = Agent(
        id=uuid4(),
        gateway_id=uuid4(),
        board_id=review_id,
        name="Reviewer",
        heartbeat_config={"every": "20m", "target": "last"},
    )

    desired = desired_heartbeat_config_for_agent(
        reviewer,
        board_name_by_id={review_id: "Review"},
        tasks=[],
        paused_board_ids=set(),
    )

    assert desired["every"] == "0m"
    assert desired["target"] == "none"


def test_desired_heartbeat_config_keeps_assigned_worker_active_even_on_generic_board() -> None:
    board_id = uuid4()
    worker = Agent(
        id=uuid4(),
        gateway_id=uuid4(),
        board_id=board_id,
        name="Builder",
        heartbeat_config={"every": "0m", "target": "none"},
    )
    assigned_task = Task(
        id=uuid4(),
        organization_id=uuid4(),
        board_id=board_id,
        title="Assigned implementation task",
        status="in_progress",
        assigned_agent_id=worker.id,
    )

    desired = desired_heartbeat_config_for_agent(
        worker,
        board_name_by_id={board_id: "Board"},
        tasks=[assigned_task],
        paused_board_ids=set(),
    )

    assert desired["every"] == "20m"
    assert desired["target"] == "last"


@pytest.mark.asyncio
async def test_scope_lead_can_list_same_group_boards_and_agents(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            requirements = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Requirements",
                slug="requirements",
            )
            in_progress = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="In Progress",
                slug="in-progress",
            )
            review = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Review",
                slug="review",
            )
            isolated = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                name="Unrelated",
                slug="unrelated",
            )
            lead = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=requirements.id,
                name="Lead",
                is_board_lead=True,
            )
            builder = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=in_progress.id,
                name="Builder",
            )
            reviewer = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=review.id,
                name="Reviewer",
            )
            outsider = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=isolated.id,
                name="Outsider",
            )
            session.add_all(
                [
                    org,
                    gateway,
                    group,
                    requirements,
                    in_progress,
                    review,
                    isolated,
                    lead,
                    builder,
                    reviewer,
                    outsider,
                ],
            )
            await session.commit()

            async def _fake_paginate(_session: AsyncSession, statement: object, transformer=None):
                items = list((await _session.exec(statement)).all())
                return list(transformer(items) if transformer else items)

            monkeypatch.setattr(agent_api, "paginate", _fake_paginate)

            agent_ctx = AgentAuthContext(actor_type="agent", agent=lead)
            visible_boards = await agent_api.list_boards(session=session, agent_ctx=agent_ctx)
            visible_agents = await agent_api.list_agents(
                board_id=None,
                session=session,
                agent_ctx=agent_ctx,
            )

            assert {board.id for board in visible_boards} == {
                requirements.id,
                in_progress.id,
                review.id,
            }
            assert {agent.id for agent in visible_agents} == {
                lead.id,
                builder.id,
                reviewer.id,
            }
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_scope_lead_can_read_same_group_board_task_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            requirements = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Requirements",
                slug="requirements",
            )
            review = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Review",
                slug="review",
            )
            lead = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=requirements.id,
                name="Lead",
                is_board_lead=True,
            )
            session.add_all([org, gateway, group, requirements, review, lead])
            await session.commit()

            called: dict[str, object] = {}

            async def _fake_list_tasks(**kwargs):
                called["board_id"] = kwargs["board"].id
                return []

            monkeypatch.setattr(agent_api.tasks_api, "list_tasks", _fake_list_tasks)

            agent_ctx = AgentAuthContext(actor_type="agent", agent=lead)
            response = await agent_api.list_tasks(
                filters=agent_api.AgentTaskListFilters(),
                board=review,
                session=session,
                agent_ctx=agent_ctx,
            )

            assert response == []
            assert called["board_id"] == review.id
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_agent_task_dependency_uses_board_scoped_loader_for_same_group_tasks() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            requirements = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Requirements",
                slug="requirements",
            )
            review = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Review",
                slug="review",
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=review.id,
                title="Review handoff",
            )
            session.add_all([org, gateway, group, requirements, review, task])
            await session.commit()

            loaded = await agent_api._get_agent_task_or_404(
                task_id=task.id,
                board=review,
                session=session,
            )

            assert agent_api.TASK_DEP.dependency is agent_api._get_agent_task_or_404
            assert loaded.id == task.id
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_new_top_level_task_delivers_lead_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            requirements = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Requirements",
                slug="requirements",
            )
            lead = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=requirements.id,
                name="Lead",
                is_board_lead=True,
                openclaw_session_id="agent:lead-session",
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=requirements.id,
                title="Epic",
            )
            session.add_all([org, gateway, group, requirements, lead, task])
            await session.commit()

            captured: dict[str, object] = {}

            async def _fake_optional_gateway_config_for_board(self, board):
                return object()

            async def _fake_wake(**kwargs):
                return None

            async def _fake_send_lead_task_message(**kwargs):
                captured["deliver"] = kwargs["deliver"]
                return None

            monkeypatch.setattr(
                tasks_api_module.GatewayDispatchService,
                "optional_gateway_config_for_board",
                _fake_optional_gateway_config_for_board,
            )
            monkeypatch.setattr(tasks_api_module, "_wake_agent_online_for_task", _fake_wake)
            monkeypatch.setattr(
                tasks_api_module,
                "_send_lead_task_message",
                _fake_send_lead_task_message,
            )

            await tasks_api_module._notify_lead_on_task_create(
                session=session,
                board=requirements,
                task=task,
            )

            assert captured["deliver"] is True
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_assignment_notification_delivers_worker_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                name="In Progress",
                slug="in-progress",
            )
            builder = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=board.id,
                name="Builder",
                openclaw_session_id="agent:builder-session",
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=board.id,
                title="Implement slice",
                assigned_agent_id=builder.id,
            )
            session.add_all([org, gateway, board, builder, task])
            await session.commit()

            captured: dict[str, object] = {}

            async def _fake_optional_gateway_config_for_board(self, board):
                return object()

            async def _fake_wake(**kwargs):
                return None

            async def _fake_send_agent_task_message(**kwargs):
                captured["deliver"] = kwargs["deliver"]
                return None

            monkeypatch.setattr(
                tasks_api_module.GatewayDispatchService,
                "optional_gateway_config_for_board",
                _fake_optional_gateway_config_for_board,
            )
            monkeypatch.setattr(tasks_api_module, "_wake_agent_online_for_task", _fake_wake)
            monkeypatch.setattr(
                tasks_api_module,
                "_send_agent_task_message",
                _fake_send_agent_task_message,
            )

            await tasks_api_module._notify_agent_on_task_assign(
                session=session,
                board=board,
                task=task,
                agent=builder,
            )

            assert captured["deliver"] is True
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_worker_comment_targets_scope_lead(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            requirements = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Requirements",
                slug="requirements",
            )
            in_progress = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="In Progress",
                slug="in-progress",
            )
            lead = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=requirements.id,
                name="Lead",
                is_board_lead=True,
                openclaw_session_id="agent:lead-session",
            )
            builder = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=in_progress.id,
                name="Builder",
                openclaw_session_id="agent:builder-session",
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=in_progress.id,
                title="Implement slice",
                assigned_agent_id=builder.id,
            )
            session.add_all([org, gateway, group, requirements, in_progress, lead, builder, task])
            await session.commit()

            targets, _mentions = await tasks_api_module._comment_targets(
                session,
                task=task,
                message="Progress update posted.",
                actor=ActorContext(actor_type="agent", agent=builder),
            )

            assert set(targets) == {lead.id}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_scope_mentions_resolve_same_group_agents() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            requirements = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Requirements",
                slug="requirements",
            )
            security_board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Security Review",
                slug="security-review",
            )
            lead = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=requirements.id,
                name="Lead",
                is_board_lead=True,
                openclaw_session_id="agent:lead-session",
            )
            security = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=security_board.id,
                name="Security",
                openclaw_session_id="agent:security-session",
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=security_board.id,
                title="Security validation",
                assigned_agent_id=security.id,
            )
            session.add_all(
                [org, gateway, group, requirements, security_board, lead, security, task]
            )
            await session.commit()

            targets, mentions = await tasks_api_module._comment_targets(
                session,
                task=task,
                message="@lead Please validate the downstream handoff.",
                actor=ActorContext(actor_type="agent", agent=security),
            )

            assert mentions == {"lead"}
            assert set(targets) == {lead.id}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_lead_review_comment_targets_last_worker() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            requirements = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Requirements",
                slug="requirements",
            )
            implementation = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="In Progress",
                slug="in-progress",
            )
            lead = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=requirements.id,
                name="Lead",
                is_board_lead=True,
                openclaw_session_id="agent:lead-session",
            )
            builder = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=implementation.id,
                name="Builder",
                openclaw_session_id="agent:builder-session",
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=implementation.id,
                title="Implement cockpit slice",
                status="review",
                assigned_agent_id=lead.id,
            )
            session.add_all(
                [org, gateway, group, requirements, implementation, lead, builder, task]
            )
            await session.commit()

            session.add(
                ActivityEvent(
                    event_type="task.status_changed",
                    message=f"Task moved to review: {task.title}.",
                    task_id=task.id,
                    board_id=implementation.id,
                    agent_id=builder.id,
                ),
            )
            await session.commit()

            targets, mentions = await tasks_api_module._comment_targets(
                session,
                task=task,
                message="Please add a reviewable patch summary for Reviewer.",
                actor=ActorContext(actor_type="agent", agent=lead),
            )

            assert mentions == set()
            assert set(targets) == {builder.id}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_task_comment_notifications_deliver_immediately(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                name="In Progress",
                slug="in-progress",
            )
            builder = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=board.id,
                name="Builder",
            )
            lead = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=board.id,
                name="Lead",
                is_board_lead=True,
                openclaw_session_id="agent:lead-session",
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=board.id,
                title="Implement slice",
            )
            session.add_all([org, gateway, board, builder, lead, task])
            await session.commit()

            captured: dict[str, object] = {}

            async def _fake_optional_gateway_config_for_board(self, board):
                return object()

            async def _fake_send_agent_task_message(**kwargs):
                captured["deliver"] = kwargs["deliver"]
                captured["agent_name"] = kwargs["agent_name"]
                return None

            async def _fake_send_lead_task_message(**kwargs):
                captured["lead_deliver"] = kwargs["deliver"]
                captured["lead_message"] = kwargs["message"]
                return None

            async def _fake_wake(**kwargs):
                captured["wake_reason"] = kwargs["reason"]

            monkeypatch.setattr(
                tasks_api_module.GatewayDispatchService,
                "optional_gateway_config_for_board",
                _fake_optional_gateway_config_for_board,
            )
            monkeypatch.setattr(
                tasks_api_module,
                "_send_agent_task_message",
                _fake_send_agent_task_message,
            )
            monkeypatch.setattr(
                tasks_api_module,
                "_send_lead_task_message",
                _fake_send_lead_task_message,
            )
            monkeypatch.setattr(
                tasks_api_module,
                "_wake_agent_online_for_task",
                _fake_wake,
            )

            await tasks_api_module._notify_task_comment_targets(
                session,
                request=tasks_api_module._TaskCommentNotifyRequest(
                    task=task,
                    actor=ActorContext(actor_type="agent", agent=builder),
                    message="Progress update posted.",
                    targets={lead.id: lead},
                    mention_names=set(),
                ),
            )

            assert captured["lead_deliver"] is True
            assert captured["wake_reason"] == "task_comment"
            assert "LEAD TASK UPDATE" in str(captured["lead_message"])
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_review_outcome_notifies_scope_lead_with_structured_signal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            requirements = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Requirements",
                slug="requirements",
            )
            review = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Review",
                slug="review",
            )
            lead = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=requirements.id,
                name="Lead",
                is_board_lead=True,
                openclaw_session_id="agent:lead-session",
            )
            reviewer = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=review.id,
                name="Reviewer",
                openclaw_session_id="agent:reviewer-session",
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=review.id,
                title="Review main-board flow",
                description=(
                    "Clears referenced planning slices "
                    "`10c7ad33-1650-43d5-8eeb-1b47f1a8f4ae` and "
                    "`df541a34-7b92-472a-b1a7-7bcabdfa6178`."
                ),
                assigned_agent_id=reviewer.id,
            )
            planning_one = Task(
                id=UUID("10c7ad33-1650-43d5-8eeb-1b47f1a8f4ae"),
                organization_id=org.id,
                board_id=requirements.id,
                title="Define stage mapping",
                status="inbox",
            )
            planning_two = Task(
                id=UUID("df541a34-7b92-472a-b1a7-7bcabdfa6178"),
                organization_id=org.id,
                board_id=requirements.id,
                title="Define routing rules",
                status="inbox",
            )
            validation = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=requirements.id,
                title="Validate single-Epic flow",
                status="inbox",
            )
            dependency = TaskDependency(
                id=uuid4(),
                board_id=requirements.id,
                task_id=validation.id,
                depends_on_task_id=planning_one.id,
            )
            session.add_all(
                [
                    org,
                    gateway,
                    group,
                    requirements,
                    review,
                    lead,
                    reviewer,
                    task,
                    planning_one,
                    planning_two,
                    validation,
                    dependency,
                ],
            )
            await session.commit()

            captured: dict[str, object] = {}

            async def _fake_optional_gateway_config_for_board(self, board):
                return object()

            async def _fake_send_lead_task_message(**kwargs):
                captured["deliver"] = kwargs["deliver"]
                captured["message"] = kwargs["message"]
                return None

            async def _fake_wake(**kwargs):
                captured["wake_reason"] = kwargs["reason"]

            monkeypatch.setattr(
                tasks_api_module.GatewayDispatchService,
                "optional_gateway_config_for_board",
                _fake_optional_gateway_config_for_board,
            )
            monkeypatch.setattr(
                tasks_api_module,
                "_send_lead_task_message",
                _fake_send_lead_task_message,
            )
            monkeypatch.setattr(
                tasks_api_module,
                "_wake_agent_online_for_task",
                _fake_wake,
            )

            await tasks_api_module._notify_scope_lead_on_downstream_outcome(
                session,
                task=task,
                actor=ActorContext(actor_type="agent", agent=reviewer),
                message="Final code-level review pass. No further review findings.",
            )

            assert captured["deliver"] is True
            assert captured["wake_reason"] == "review_outcome"
            assert "REVIEW OUTCOME: CLEARED" in str(captured["message"])
            message = str(captured["message"]).lower()
            assert "open referenced prerequisite tasks" in message
            assert "define stage mapping" in message
            assert "validate single-epic flow" in message
            assert "request/create any required approval" in message
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_lead_patch_can_include_comment_and_records_task_comment() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                name="Requirements",
                slug="requirements",
                require_approval_for_done=False,
            )
            lead = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=board.id,
                name="Lead",
                is_board_lead=True,
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=board.id,
                title="Define routing contract",
                description="Initial scope.",
            )
            session.add_all([org, gateway, board, lead, task])
            await session.commit()

            result = await tasks_api_module.update_task(
                payload=TaskUpdate(
                    description="Updated scope.",
                    status="done",
                    comment="Lead ruling: reconcile this prerequisite now.",
                ),
                task=task,
                session=session,
                actor=ActorContext(actor_type="agent", agent=lead),
            )

            assert result.description == "Updated scope."
            assert result.status == "done"
            comments = list(
                await session.exec(
                    select(ActivityEvent).where(
                        col(ActivityEvent.task_id) == task.id,
                        col(ActivityEvent.event_type) == "task.comment",
                    ),
                ),
            )
            assert len(comments) == 1
            assert comments[0].message == "Lead ruling: reconcile this prerequisite now."
            assert comments[0].agent_id == lead.id
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_patch_comment_notifications_deliver_immediately(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                name="In Progress",
                slug="in-progress",
            )
            builder = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=board.id,
                name="Builder",
            )
            lead = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=board.id,
                name="Lead",
                is_board_lead=True,
                openclaw_session_id="agent:lead-session",
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=board.id,
                title="Implement slice",
            )
            session.add_all([org, gateway, board, builder, lead, task])
            await session.commit()

            captured: dict[str, object] = {}

            async def _fake_optional_gateway_config_for_board(self, board):
                return object()

            async def _fake_send_agent_task_message(**kwargs):
                captured["deliver"] = kwargs["deliver"]
                captured["agent_name"] = kwargs["agent_name"]
                return None

            async def _fake_send_lead_task_message(**kwargs):
                captured["deliver"] = kwargs["deliver"]
                captured["agent_name"] = "Lead"
                return None

            async def _fake_wake(**kwargs):
                captured["wake_reason"] = kwargs["reason"]

            monkeypatch.setattr(
                tasks_api_module.GatewayDispatchService,
                "optional_gateway_config_for_board",
                _fake_optional_gateway_config_for_board,
            )
            monkeypatch.setattr(
                tasks_api_module,
                "_send_agent_task_message",
                _fake_send_agent_task_message,
            )
            monkeypatch.setattr(
                tasks_api_module,
                "_send_lead_task_message",
                _fake_send_lead_task_message,
            )
            monkeypatch.setattr(
                tasks_api_module,
                "_wake_agent_online_for_task",
                _fake_wake,
            )

            await tasks_api_module._record_task_comment_from_update(
                session,
                update=tasks_api_module._TaskUpdateInput(
                    task=task,
                    actor=ActorContext(actor_type="agent", agent=builder),
                    board_id=board.id,
                    previous_status=task.status,
                    previous_assigned=task.assigned_agent_id,
                    status_requested=False,
                    updates={},
                    comment="@Lead Please review this task update.",
                    depends_on_task_ids=None,
                    tag_ids=None,
                    custom_field_values={},
                    custom_field_values_set=False,
                ),
            )

            assert captured["deliver"] is True
            assert captured["agent_name"] == "Lead"
            assert captured["wake_reason"] == "task_comment"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_scope_lead_can_comment_on_same_scope_task_created_via_coordinator() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            requirements = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Requirements",
                slug="requirements",
            )
            review = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Review",
                slug="review",
            )
            lead = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=requirements.id,
                name="Lead",
                is_board_lead=True,
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=review.id,
                title="Review handoff",
                auto_created=True,
                auto_reason=f"coordinator_agent:{lead.id}",
            )
            session.add_all([org, gateway, group, requirements, review, lead, task])
            await session.commit()

            await tasks_api_module._validate_task_comment_access(
                session,
                task=task,
                actor=ActorContext(actor_type="agent", agent=lead),
            )
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_scope_lead_comment_access_rejects_same_scope_task_not_created_or_mentioned() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            requirements = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Requirements",
                slug="requirements",
            )
            review = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Review",
                slug="review",
            )
            lead = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=requirements.id,
                name="Lead",
                is_board_lead=True,
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=review.id,
                title="Review handoff",
            )
            session.add_all([org, gateway, group, requirements, review, lead, task])
            await session.commit()

            with pytest.raises(HTTPException) as excinfo:
                await tasks_api_module._validate_task_comment_access(
                    session,
                    task=task,
                    actor=ActorContext(actor_type="agent", agent=lead),
                )

            assert excinfo.value.status_code == 403
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_same_scope_reviewer_can_read_upstream_task_comments_but_not_write_task() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            group = BoardGroup(
                id=uuid4(),
                organization_id=org.id,
                name="Development",
                slug="development",
            )
            in_progress = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="In Progress",
                slug="in-progress",
            )
            review = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                board_group_id=group.id,
                name="Review",
                slug="review",
            )
            builder = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=in_progress.id,
                name="Builder",
            )
            reviewer = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=review.id,
                name="Reviewer",
            )
            task = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=in_progress.id,
                title="Builder implementation",
                assigned_agent_id=builder.id,
            )
            comment_event = ActivityEvent(
                id=uuid4(),
                organization_id=org.id,
                board_id=in_progress.id,
                task_id=task.id,
                agent_id=builder.id,
                event_type="task.comment",
                message="Implementation evidence is ready for review.",
            )
            session.add_all(
                [
                    org,
                    gateway,
                    group,
                    in_progress,
                    review,
                    builder,
                    reviewer,
                    task,
                    comment_event,
                ]
            )
            await session.commit()

            agent_ctx = AgentAuthContext(actor_type="agent", agent=reviewer)
            await agent_api._guard_task_comment_read_access(
                task=task,
                session=session,
                agent_ctx=agent_ctx,
            )

            comments = list(
                await session.exec(
                    select(ActivityEvent)
                    .where(col(ActivityEvent.task_id) == task.id)
                    .where(col(ActivityEvent.event_type) == "task.comment")
                    .order_by(asc(col(ActivityEvent.created_at)))
                )
            )

            assert len(comments) == 1
            assert comments[0].message == "Implementation evidence is ready for review."

            with pytest.raises(HTTPException) as excinfo:
                await agent_api._guard_task_access(
                    session,
                    agent_ctx=agent_ctx,
                    task=task,
                )

            assert excinfo.value.status_code == 403
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_task_read_page_returns_child_counts() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                name="Requirements",
                slug="requirements",
            )
            parent = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=board.id,
                title="Parent initiative",
            )
            child = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=board.id,
                title="Child slice",
                parent_task_id=parent.id,
            )
            session.add_all([org, gateway, board, parent, child])
            await session.commit()

            page = await tasks_api_module._task_read_page(
                session=session,
                board_id=board.id,
                tasks=[parent, child],
            )

            by_id = {task.id: task for task in page}
            assert by_id[parent.id].child_count == 1
            assert by_id[child.id].child_count == 0
    finally:
        await engine.dispose()
