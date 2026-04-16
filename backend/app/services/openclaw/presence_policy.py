"""Standby-first heartbeat policy helpers for managed OpenClaw agents."""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import func
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.logging import get_logger
from app.core.time import utcnow
from app.models.agents import Agent
from app.models.board_memory import BoardMemory
from app.models.boards import Board
from app.models.gateways import Gateway
from app.models.tasks import Task
from app.services.openclaw.constants import DEFAULT_HEARTBEAT_CONFIG, HEARTBEAT_STALE_GRACE
from app.services.openclaw.gateway_rpc import OpenClawGatewayError
from app.services.openclaw.provisioning import OpenClawGatewayProvisioner
from app.services.task_scope import board_scope_board_ids

logger = get_logger(__name__)

_DURATION_RE = re.compile(r"^(?P<value>\d+)\s*(?P<unit>[smhd])$")
_STANDBY_EVERY_VALUES = {"0", "0m", "0s", "0h", "0d"}
_PLANNING_BOARD_NAMES = {"requirements", "ready"}


def _normalized_name(value: str | None) -> str:
    return (value or "").strip().lower()


def heartbeat_is_standby(config: Mapping[str, Any] | None) -> bool:
    """Return whether a heartbeat config represents standby/event-driven mode."""

    if not isinstance(config, Mapping):
        return False
    every = str(config.get("every") or "").strip().lower()
    target = str(config.get("target") or "").strip().lower()
    return every in _STANDBY_EVERY_VALUES or target == "none"


def heartbeat_interval(config: Mapping[str, Any] | None) -> timedelta | None:
    """Parse ``heartbeat.every`` into a timedelta when it represents active cadence."""

    if not isinstance(config, Mapping) or heartbeat_is_standby(config):
        return None
    raw = str(config.get("every") or "").strip().lower()
    match = _DURATION_RE.match(raw)
    if match is None:
        return None
    value = int(match.group("value"))
    unit = match.group("unit")
    if unit == "s":
        return timedelta(seconds=value)
    if unit == "m":
        return timedelta(minutes=value)
    if unit == "h":
        return timedelta(hours=value)
    if unit == "d":
        return timedelta(days=value)
    return None


def heartbeat_offline_after(config: Mapping[str, Any] | None) -> timedelta | None:
    """Return the stale timeout for an active heartbeat cadence."""

    interval = heartbeat_interval(config)
    if interval is None:
        return None
    return interval + HEARTBEAT_STALE_GRACE


def preferred_active_every_for_agent(
    agent: Agent,
    *,
    board_name: str | None = None,
) -> str:
    """Return the active heartbeat cadence for a managed agent role."""

    existing = agent.heartbeat_config or {}
    configured_every = str(existing.get("every") or "").strip().lower()
    if configured_every and configured_every not in _STANDBY_EVERY_VALUES:
        return configured_every
    if agent.is_board_lead:
        return "10m"
    normalized_board_name = _normalized_name(board_name)
    if normalized_board_name == "requirements":
        return "10m"
    return "20m"


def merge_heartbeat_config(
    existing: Mapping[str, Any] | None,
    *,
    every: str,
    target: str | None = None,
    active_every: str | None = None,
    auto_wake: bool | None = None,
) -> dict[str, Any]:
    """Merge a heartbeat config while preserving non-policy keys."""

    heartbeat = DEFAULT_HEARTBEAT_CONFIG.copy()
    if isinstance(existing, Mapping):
        include_reasoning = existing.get("includeReasoning")
        if isinstance(include_reasoning, bool):
            heartbeat["includeReasoning"] = include_reasoning
    heartbeat["every"] = every
    heartbeat["target"] = target or ("none" if every in _STANDBY_EVERY_VALUES else "last")
    return heartbeat


def standby_heartbeat_config(
    existing: Mapping[str, Any] | None,
    *,
    active_every: str | None = None,
) -> dict[str, Any]:
    """Return a standby/event-driven heartbeat config."""

    return merge_heartbeat_config(
        existing,
        every="0m",
        target="none",
        active_every=active_every,
        auto_wake=True,
    )


def active_heartbeat_config(
    existing: Mapping[str, Any] | None,
    *,
    every: str,
) -> dict[str, Any]:
    """Return an active periodic heartbeat config."""

    return merge_heartbeat_config(
        existing,
        every=every,
        target="last",
        active_every=every,
        auto_wake=True,
    )


async def paused_board_ids_for_boards(
    session: AsyncSession,
    board_ids: list[UUID],
) -> set[UUID]:
    if not board_ids:
        return set()

    commands = {"/pause", "/resume"}
    statement = (
        select(BoardMemory.board_id, BoardMemory.content)
        .where(col(BoardMemory.board_id).in_(board_ids))
        .where(col(BoardMemory.is_chat).is_(True))
        .where(func.lower(func.trim(col(BoardMemory.content))).in_(commands))
        .order_by(col(BoardMemory.board_id), col(BoardMemory.created_at).desc())
        .distinct(col(BoardMemory.board_id))
    )

    paused: set[UUID] = set()
    for board_id, content in await session.exec(statement):
        if (content or "").strip().lower() == "/pause":
            paused.add(board_id)
    return paused


async def _sync_gateway_heartbeats(
    session: AsyncSession,
    *,
    agents: Sequence[Agent],
) -> None:
    syncable_agents = [agent for agent in agents if agent.board_id is not None]
    if not syncable_agents:
        return
    agents_by_gateway_id: dict[UUID, list[Agent]] = defaultdict(list)
    for agent in syncable_agents:
        agents_by_gateway_id[agent.gateway_id].append(agent)
    gateways = await Gateway.objects.by_ids(list(agents_by_gateway_id.keys())).all(session)
    gateway_by_id = {gateway.id: gateway for gateway in gateways}
    for gateway_id, gateway_agents in agents_by_gateway_id.items():
        gateway = gateway_by_id.get(gateway_id)
        if gateway is None or not gateway.url or not gateway.workspace_root:
            continue
        try:
            await OpenClawGatewayProvisioner().sync_gateway_agent_heartbeats(gateway, gateway_agents)
        except OpenClawGatewayError as exc:  # pragma: no cover - best effort sync
            logger.warning(
                "presence_policy.sync_gateway_heartbeats failed gateway_id=%s agent_ids=%s error=%s",
                gateway_id,
                [str(agent.id) for agent in gateway_agents],
                exc,
            )


def _lead_has_active_work(
    tasks: Sequence[Task],
    *,
    board_name_by_id: Mapping[UUID, str],
    lead: Agent,
    paused_board_ids: set[UUID],
) -> bool:
    if any(
        task.assigned_agent_id == lead.id
        and task.status != "done"
        and task.board_id not in paused_board_ids
        for task in tasks
    ):
        return True
    for task in tasks:
        if task.status == "done" or task.board_id in paused_board_ids:
            continue
        board_name = _normalized_name(board_name_by_id.get(task.board_id))
        if task.parent_task_id is None and board_name in _PLANNING_BOARD_NAMES:
            return True
        if board_name == "qa":
            return True
    return False


def _worker_has_active_work(
    tasks: Sequence[Task],
    *,
    board_name_by_id: Mapping[UUID, str],
    agent: Agent,
    paused_board_ids: set[UUID],
) -> bool:
    if any(
        task.assigned_agent_id == agent.id
        and task.status != "done"
        and task.board_id not in paused_board_ids
        for task in tasks
    ):
        return True
    if agent.board_id is None:
        return False
    if agent.board_id in paused_board_ids:
        return False
    board_name = _normalized_name(board_name_by_id.get(agent.board_id))
    if board_name not in {"in progress", "review", "security review"}:
        return False
    return any(task.board_id == agent.board_id and task.status != "done" for task in tasks)


def desired_heartbeat_config_for_agent(
    agent: Agent,
    *,
    board_name_by_id: Mapping[UUID, str],
    tasks: Sequence[Task],
    paused_board_ids: set[UUID],
) -> dict[str, Any]:
    """Return the desired heartbeat config for a scope-managed agent."""

    if agent.board_id is None:
        return standby_heartbeat_config(
            agent.heartbeat_config,
            active_every=preferred_active_every_for_agent(agent),
        )
    if agent.board_id in paused_board_ids:
        return standby_heartbeat_config(
            agent.heartbeat_config,
            active_every=preferred_active_every_for_agent(
                agent,
                board_name=board_name_by_id.get(agent.board_id),
            ),
        )
    if agent.is_board_lead:
        if _lead_has_active_work(
            tasks,
            board_name_by_id=board_name_by_id,
            lead=agent,
            paused_board_ids=paused_board_ids,
        ):
            return active_heartbeat_config(
                agent.heartbeat_config,
                every=preferred_active_every_for_agent(
                    agent,
                    board_name=board_name_by_id.get(agent.board_id),
                ),
            )
        return standby_heartbeat_config(
            agent.heartbeat_config,
            active_every=preferred_active_every_for_agent(
                agent,
                board_name=board_name_by_id.get(agent.board_id),
            ),
        )
    if _worker_has_active_work(
        tasks,
        board_name_by_id=board_name_by_id,
        agent=agent,
        paused_board_ids=paused_board_ids,
    ):
        return active_heartbeat_config(
            agent.heartbeat_config,
            every=preferred_active_every_for_agent(
                agent,
                board_name=board_name_by_id.get(agent.board_id),
            ),
        )
    return standby_heartbeat_config(
        agent.heartbeat_config,
        active_every=preferred_active_every_for_agent(
            agent,
            board_name=board_name_by_id.get(agent.board_id),
        ),
    )


async def set_agent_presence_active(
    session: AsyncSession,
    *,
    agent: Agent,
    board_name: str | None = None,
) -> None:
    """Switch a single agent into active low-cadence mode and sync the gateway."""

    desired = active_heartbeat_config(
        agent.heartbeat_config,
        every=preferred_active_every_for_agent(agent, board_name=board_name),
    )
    if agent.heartbeat_config == desired:
        return
    agent.heartbeat_config = desired
    agent.updated_at = utcnow()
    session.add(agent)
    await session.commit()
    await session.refresh(agent)
    await _sync_gateway_heartbeats(session, agents=[agent])


async def reconcile_scope_presence(
    session: AsyncSession,
    *,
    board_id: UUID,
) -> list[UUID]:
    """Reconcile all agents in a task scope back to standby/active defaults."""

    scope_ids = await board_scope_board_ids(session, board_id=board_id)
    if not scope_ids:
        return []
    boards = await Board.objects.by_ids(scope_ids).all(session)
    board_by_id = {board.id: board for board in boards}
    board_name_by_id = {board.id: board.name for board in boards}
    paused_board_ids = await paused_board_ids_for_boards(session, scope_ids)
    tasks = list(
        await session.exec(
            select(Task).where(
                col(Task.board_id).in_(scope_ids),
                col(Task.status) != "done",
            ),
        ),
    )
    agents = list(
        await session.exec(
            select(Agent).where(col(Agent.board_id).in_(scope_ids)),
        ),
    )
    changed: list[Agent] = []
    for agent in agents:
        desired = desired_heartbeat_config_for_agent(
            agent,
            board_name_by_id=board_name_by_id,
            tasks=tasks,
            paused_board_ids=paused_board_ids,
        )
        if agent.heartbeat_config == desired:
            continue
        agent.heartbeat_config = desired
        agent.updated_at = utcnow()
        session.add(agent)
        changed.append(agent)
    if not changed:
        return []
    await session.commit()
    for agent in changed:
        await session.refresh(agent)
    await _sync_gateway_heartbeats(session, agents=changed)
    return [agent.id for agent in changed]
