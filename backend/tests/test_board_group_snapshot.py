# ruff: noqa: INP001
"""Tests for board-group cockpit snapshot enrichment."""

from __future__ import annotations

from datetime import datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.time import utcnow
from app.models.activity_events import ActivityEvent
from app.models.agents import Agent
from app.models.approvals import Approval
from app.models.board_group_memory import BoardGroupMemory
from app.models.board_groups import BoardGroup
from app.models.boards import Board
from app.models.gateways import Gateway
from app.models.organizations import Organization
from app.models.tasks import Task
from app.models.task_dependencies import TaskDependency
from app.services import board_group_snapshot as board_group_snapshot_service
from app.services.board_group_snapshot import build_group_snapshot


async def _make_engine() -> AsyncEngine:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    return engine


@pytest.mark.asyncio
async def test_build_group_snapshot_returns_cockpit_sections(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    now = datetime(2026, 1, 15, 12, 0, 0)
    try:
        monkeypatch.setattr(board_group_snapshot_service, "utcnow", lambda: now)
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
            builder = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=in_progress.id,
                name="Builder",
                status="online",
                heartbeat_config={"every": "5m", "target": "last"},
                last_seen_at=now,
                model_primary="azure-foundry/model-router",
            )
            security = Agent(
                id=uuid4(),
                gateway_id=gateway.id,
                board_id=in_progress.id,
                name="Security",
                status="online",
                heartbeat_config={"every": "0m", "target": "none"},
                last_seen_at=now,
            )
            parent = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=requirements.id,
                title="Roll out cockpit redesign",
                priority="high",
                due_at=now + timedelta(hours=2),
            )
            blocked = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=in_progress.id,
                title="Implement workflow lane view",
                parent_task_id=parent.id,
                assigned_agent_id=builder.id,
                status="in_progress",
                priority="high",
                due_at=now - timedelta(hours=1),
            )
            upcoming = Task(
                id=uuid4(),
                organization_id=org.id,
                board_id=in_progress.id,
                title="Security sign-off",
                assigned_agent_id=security.id,
                status="review",
                due_at=now + timedelta(days=2),
            )
            dependency = TaskDependency(
                id=uuid4(),
                organization_id=org.id,
                board_id=in_progress.id,
                task_id=blocked.id,
                depends_on_task_id=parent.id,
            )
            approval = Approval(
                id=uuid4(),
                board_id=in_progress.id,
                task_id=blocked.id,
                agent_id=builder.id,
                action_type="merge",
                confidence=0.75,
                status="pending",
            )
            latest_event = ActivityEvent(
                id=uuid4(),
                event_type="task.status_changed",
                message="Builder moved workflow lane view into progress.",
                task_id=blocked.id,
                board_id=in_progress.id,
                created_at=now,
            )
            older_event = ActivityEvent(
                id=uuid4(),
                event_type="task.created",
                message="Lead created the cockpit rollout initiative.",
                task_id=parent.id,
                board_id=requirements.id,
                created_at=now - timedelta(minutes=5),
            )
            pinned_note = BoardGroupMemory(
                id=uuid4(),
                board_group_id=group.id,
                content="Pinned operating note",
                tags=["pinned", "decision"],
                is_chat=False,
                source="Lead",
                created_at=now - timedelta(minutes=10),
            )
            fresh_note = BoardGroupMemory(
                id=uuid4(),
                board_group_id=group.id,
                content="Fresh context note",
                tags=["context"],
                is_chat=False,
                source="Lead",
                created_at=now - timedelta(minutes=1),
            )
            session.add(org)
            session.add(gateway)
            session.add(group)
            session.add(requirements)
            session.add(in_progress)
            session.add(builder)
            session.add(security)
            session.add(parent)
            session.add(blocked)
            session.add(upcoming)
            session.add(dependency)
            session.add(approval)
            session.add(latest_event)
            session.add(older_event)
            session.add(pinned_note)
            session.add(fresh_note)
            await session.commit()

            snapshot = await build_group_snapshot(
                session,
                group=group,
                include_done=False,
                per_board_task_limit=10,
            )

            assert snapshot.pending_approvals_count == 1
            assert [item.title for item in snapshot.agenda.overdue] == [
                "Implement workflow lane view",
            ]
            assert [item.title for item in snapshot.agenda.today] == [
                "Roll out cockpit redesign",
            ]
            assert [item.title for item in snapshot.agenda.upcoming] == [
                "Security sign-off",
            ]
            assert [item.title for item in snapshot.blocked_tasks] == [
                "Implement workflow lane view",
            ]
            assert [item.message for item in snapshot.activity_feed[:2]] == [
                "Builder moved workflow lane view into progress.",
                "Lead created the cockpit rollout initiative.",
            ]
            assert snapshot.memory_preview[0].content == "Pinned operating note"
            builder_workload = next(
                item for item in snapshot.agent_workload if item.agent.name == "Builder"
            )
            assert builder_workload.active_task_count == 1
            assert builder_workload.current_task is not None
            assert builder_workload.current_task.title == "Implement workflow lane view"
            assert any(
                item.agent.name == "Security" and item.agent.status == "standby"
                for item in snapshot.agent_workload
            )
    finally:
        await engine.dispose()
