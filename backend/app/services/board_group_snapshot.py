"""Helpers for assembling board-group snapshot view models."""

from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import case, func, or_
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.time import utcnow
from app.models.activity_events import ActivityEvent
from app.models.agents import Agent
from app.models.approvals import Approval
from app.models.board_group_memory import BoardGroupMemory
from app.models.board_groups import BoardGroup
from app.models.boards import Board
from app.models.tasks import Task
from app.schemas.activity_events import ActivityEventRead
from app.schemas.board_group_memory import BoardGroupMemoryRead
from app.schemas.board_groups import BoardGroupRead
from app.schemas.boards import BoardRead
from app.schemas.view_models import (
    BoardGroupAgenda,
    BoardGroupAgentWorkload,
    BoardGroupBoardSnapshot,
    BoardGroupSnapshot,
    BoardGroupTaskSummary,
)
from app.services.openclaw.provisioning_db import AgentLifecycleService
from app.services.tags import TagState, load_tag_state
from app.services.task_dependencies import (
    blocked_by_dependency_ids,
    dependency_ids_by_task_id,
    dependency_status_by_id_for_boards,
)
from app.services.task_hierarchy import child_counts_by_parent_id

if TYPE_CHECKING:
    from sqlalchemy.sql.elements import ColumnElement

_STATUS_ORDER = {"in_progress": 0, "review": 1, "inbox": 2, "done": 3}
_PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2}
_RUNTIME_TYPE_REFERENCES = (UUID, AsyncSession)


def _status_weight_expr() -> ColumnElement[int]:
    """Return a SQL expression that sorts task statuses by configured order."""
    whens = [(col(Task.status) == key, weight) for key, weight in _STATUS_ORDER.items()]
    return case(*whens, else_=99)


def _priority_weight_expr() -> ColumnElement[int]:
    """Return a SQL expression that sorts task priorities by configured order."""
    whens = [(col(Task.priority) == key, weight) for key, weight in _PRIORITY_ORDER.items()]
    return case(*whens, else_=99)


async def _boards_for_group(
    session: AsyncSession,
    *,
    group_id: UUID,
    exclude_board_id: UUID | None = None,
    allowed_board_ids: set[UUID] | None = None,
) -> list[Board]:
    """Return boards belonging to a board group with optional exclusion."""
    statement = Board.objects.filter_by(board_group_id=group_id).statement
    if exclude_board_id is not None:
        statement = statement.where(col(Board.id) != exclude_board_id)
    if allowed_board_ids is not None:
        if not allowed_board_ids:
            return []
        statement = statement.where(col(Board.id).in_(allowed_board_ids))
    return list(
        await session.exec(
            statement.order_by(func.lower(col(Board.name)).asc()),
        ),
    )


async def _task_counts_by_board(
    session: AsyncSession,
    board_ids: list[UUID],
) -> dict[UUID, dict[str, int]]:
    """Return per-board task counts keyed by task status."""
    task_counts: dict[UUID, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for board_id, status_value, total in list(
        await session.exec(
            select(col(Task.board_id), col(Task.status), func.count(col(Task.id)))
            .where(col(Task.board_id).in_(board_ids))
            .group_by(col(Task.board_id), col(Task.status)),
        ),
    ):
        if board_id is None:
            continue
        task_counts[board_id][str(status_value)] = int(total or 0)
    return task_counts


async def _ordered_tasks_for_boards(
    session: AsyncSession,
    board_ids: list[UUID],
    *,
    include_done: bool,
) -> list[Task]:
    """Return sorted tasks for boards, optionally excluding completed tasks."""
    task_statement = select(Task).where(col(Task.board_id).in_(board_ids))
    if not include_done:
        task_statement = task_statement.where(col(Task.status) != "done")
    task_statement = task_statement.order_by(
        col(Task.board_id).asc(),
        _status_weight_expr().asc(),
        _priority_weight_expr().asc(),
        col(Task.updated_at).desc(),
        col(Task.created_at).desc(),
    )
    return list(await session.exec(task_statement))


async def _agent_names(
    session: AsyncSession,
    tasks: list[Task],
) -> dict[UUID, str]:
    """Return agent names keyed by assigned agent ids in the provided tasks."""
    assigned_ids = {task.assigned_agent_id for task in tasks if task.assigned_agent_id is not None}
    if not assigned_ids:
        return {}
    return dict(
        list(
            await session.exec(
                select(col(Agent.id), col(Agent.name)).where(
                    col(Agent.id).in_(assigned_ids),
                ),
            ),
        ),
    )


def _task_summary(
    *,
    task: Task,
    board: Board,
    agent_name_by_id: dict[UUID, str],
    child_count_by_parent_id: dict[UUID, int],
    deps_by_task_id: dict[UUID, list[UUID]],
    dependency_status_by_id_map: dict[UUID, str],
    tag_state_by_task_id: dict[UUID, TagState],
) -> BoardGroupTaskSummary:
    """Build a single task summary row for cockpit and board views."""
    depends_on_task_ids = deps_by_task_id.get(task.id, [])
    blocked_by_task_ids = (
        []
        if task.status == "done"
        else blocked_by_dependency_ids(
            dependency_ids=depends_on_task_ids,
            status_by_id=dependency_status_by_id_map,
        )
    )
    return BoardGroupTaskSummary(
        id=task.id,
        board_id=task.board_id,
        board_name=board.name,
        parent_task_id=task.parent_task_id,
        title=task.title,
        status=task.status,
        priority=task.priority,
        child_count=child_count_by_parent_id.get(task.id, 0),
        assigned_agent_id=task.assigned_agent_id,
        assignee=(
            agent_name_by_id.get(task.assigned_agent_id)
            if task.assigned_agent_id is not None
            else None
        ),
        due_at=task.due_at,
        in_progress_at=task.in_progress_at,
        depends_on_task_ids=depends_on_task_ids,
        blocked_by_task_ids=blocked_by_task_ids,
        is_blocked=bool(task.status != "done" and blocked_by_task_ids),
        tags=tag_state_by_task_id.get(task.id, TagState()).tags,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


def _task_summaries_by_board(
    *,
    boards_by_id: dict[UUID, Board],
    tasks: list[Task],
    agent_name_by_id: dict[UUID, str],
    child_count_by_parent_id: dict[UUID, int],
    deps_by_task_id: dict[UUID, list[UUID]],
    dependency_status_by_id_map: dict[UUID, str],
    tag_state_by_task_id: dict[UUID, TagState],
    per_board_task_limit: int,
) -> tuple[dict[UUID, list[BoardGroupTaskSummary]], list[BoardGroupTaskSummary]]:
    """Build limited per-board task summary lists."""
    tasks_by_board: dict[UUID, list[BoardGroupTaskSummary]] = defaultdict(list)
    all_task_summaries: list[BoardGroupTaskSummary] = []
    for task in tasks:
        if task.board_id is None:
            continue
        board = boards_by_id.get(task.board_id)
        if board is None:
            continue
        summary = _task_summary(
            task=task,
            board=board,
            agent_name_by_id=agent_name_by_id,
            child_count_by_parent_id=child_count_by_parent_id,
            deps_by_task_id=deps_by_task_id,
            dependency_status_by_id_map=dependency_status_by_id_map,
            tag_state_by_task_id=tag_state_by_task_id,
        )
        all_task_summaries.append(summary)
        if per_board_task_limit <= 0:
            continue
        current = tasks_by_board[task.board_id]
        if len(current) >= per_board_task_limit:
            continue
        current.append(summary)
    return tasks_by_board, all_task_summaries


async def _pending_approvals_count(
    session: AsyncSession,
    *,
    board_ids: list[UUID],
) -> int:
    """Return the number of pending approvals visible in the board group."""
    if not board_ids:
        return 0
    total = await session.scalar(
        select(func.count(col(Approval.id))).where(
            col(Approval.board_id).in_(board_ids),
            col(Approval.status) == "pending",
        ),
    )
    return int(total or 0)


async def _recent_activity(
    session: AsyncSession,
    *,
    board_ids: list[UUID],
    limit: int = 8,
) -> list[ActivityEventRead]:
    """Return recent activity rows that touch boards in the group."""
    if not board_ids or limit <= 0:
        return []
    rows = list(
        await session.exec(
            select(ActivityEvent)
            .outerjoin(Task, col(ActivityEvent.task_id) == col(Task.id))
            .where(
                or_(
                    col(ActivityEvent.board_id).in_(board_ids),
                    col(Task.board_id).in_(board_ids),
                ),
            )
            .order_by(col(ActivityEvent.created_at).desc())
            .limit(limit),
        ),
    )
    return [ActivityEventRead.model_validate(item, from_attributes=True) for item in rows]


def _memory_priority(tags: list[str] | None) -> tuple[int, int]:
    normalized = {tag.strip().lower() for tag in tags or []}
    if "pinned" in normalized:
        return (0, 0)
    if "decision" in normalized:
        return (0, 1)
    if "context" in normalized:
        return (1, 0)
    return (2, 0)


async def _memory_preview(
    session: AsyncSession,
    *,
    board_group_id: UUID,
    limit: int = 4,
) -> list[BoardGroupMemoryRead]:
    """Return the most useful recent note entries for the group."""
    if limit <= 0:
        return []
    rows = list(
        await session.exec(
            select(BoardGroupMemory)
            .where(
                col(BoardGroupMemory.board_group_id) == board_group_id,
                col(BoardGroupMemory.is_chat).is_(False),
            )
            .order_by(col(BoardGroupMemory.created_at).desc())
            .limit(max(limit * 3, limit)),
        ),
    )
    prioritized = sorted(
        rows,
        key=lambda item: (_memory_priority(item.tags), -item.created_at.timestamp()),
    )[:limit]
    return [BoardGroupMemoryRead.model_validate(item, from_attributes=True) for item in prioritized]


def _agenda_bucket(
    summaries: list[BoardGroupTaskSummary],
    *,
    max_items: int = 5,
) -> BoardGroupAgenda:
    """Build overdue, today, and upcoming agenda buckets from due dates."""
    now = utcnow()
    start_of_today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start_of_tomorrow = start_of_today + timedelta(days=1)
    overdue: list[BoardGroupTaskSummary] = []
    today: list[BoardGroupTaskSummary] = []
    upcoming: list[BoardGroupTaskSummary] = []
    due_summaries = sorted(
        [
            summary
            for summary in summaries
            if summary.due_at is not None and summary.status != "done"
        ],
        key=lambda summary: summary.due_at or summary.updated_at,
    )
    for summary in due_summaries:
        due_at = summary.due_at
        if due_at is None:
            continue
        if due_at < now and len(overdue) < max_items:
            overdue.append(summary)
            continue
        if start_of_today <= due_at < start_of_tomorrow and len(today) < max_items:
            today.append(summary)
            continue
        if due_at >= start_of_tomorrow and len(upcoming) < max_items:
            upcoming.append(summary)
    return BoardGroupAgenda(overdue=overdue, today=today, upcoming=upcoming)


def _blocked_task_callouts(
    summaries: list[BoardGroupTaskSummary],
    *,
    max_items: int = 5,
) -> list[BoardGroupTaskSummary]:
    """Return the most urgent blocked tasks for the cockpit rail."""
    blocked = [summary for summary in summaries if summary.is_blocked and summary.status != "done"]
    blocked.sort(
        key=lambda summary: (
            summary.due_at or summary.updated_at,
            -summary.child_count,
        ),
    )
    return blocked[:max_items]


async def _agent_workload(
    session: AsyncSession,
    *,
    board_ids: list[UUID],
    gateway_ids: list[UUID],
    summaries: list[BoardGroupTaskSummary],
) -> list[BoardGroupAgentWorkload]:
    """Return agent workload summaries for boards and group gateways."""
    if not board_ids and not gateway_ids:
        return []
    statement = select(Agent)
    board_clause = col(Agent.board_id).in_(board_ids) if board_ids else None
    gateway_clause = (
        (col(Agent.board_id).is_(None) & col(Agent.gateway_id).in_(gateway_ids))
        if gateway_ids
        else None
    )
    if board_clause is not None and gateway_clause is not None:
        statement = statement.where(or_(board_clause, gateway_clause))
    elif board_clause is not None:
        statement = statement.where(board_clause)
    elif gateway_clause is not None:
        statement = statement.where(gateway_clause)
    agents = list(await session.exec(statement.order_by(func.lower(col(Agent.name)).asc())))
    tasks_by_agent_id: dict[UUID, list[BoardGroupTaskSummary]] = defaultdict(list)
    for summary in summaries:
        if summary.assigned_agent_id is None:
            continue
        tasks_by_agent_id[summary.assigned_agent_id].append(summary)

    def _sort_key(summary: BoardGroupTaskSummary) -> tuple[int, int, str]:
        status_weight = _STATUS_ORDER.get(summary.status, 99)
        priority_weight = _PRIORITY_ORDER.get(summary.priority, 99)
        return (status_weight, priority_weight, summary.updated_at.isoformat())

    status_order = {"online": 0, "standby": 1, "provisioning": 2, "offline": 3, "updating": 4}
    workload: list[BoardGroupAgentWorkload] = []
    for agent in agents:
        scoped_tasks = sorted(tasks_by_agent_id.get(agent.id, []), key=_sort_key)
        computed = AgentLifecycleService.with_computed_status(agent)
        workload.append(
            BoardGroupAgentWorkload(
                agent=AgentLifecycleService.to_agent_read(computed),
                active_task_count=len([task for task in scoped_tasks if task.status != "done"]),
                current_task=next((task for task in scoped_tasks if task.status != "done"), None)
                or (scoped_tasks[0] if scoped_tasks else None),
            ),
        )
    workload.sort(
        key=lambda item: (
            status_order.get(item.agent.status or "offline", 99),
            -item.active_task_count,
            item.agent.name.lower(),
        ),
    )
    return workload


async def build_group_snapshot(
    session: AsyncSession,
    *,
    group: BoardGroup,
    exclude_board_id: UUID | None = None,
    allowed_board_ids: set[UUID] | None = None,
    include_done: bool = False,
    per_board_task_limit: int = 5,
) -> BoardGroupSnapshot:
    """Build a board-group snapshot with board/task summaries."""
    boards = await _boards_for_group(
        session,
        group_id=group.id,
        exclude_board_id=exclude_board_id,
        allowed_board_ids=allowed_board_ids,
    )
    if not boards:
        return BoardGroupSnapshot(
            group=BoardGroupRead.model_validate(group, from_attributes=True),
        )
    boards_by_id = {board.id: board for board in boards}
    board_ids = list(boards_by_id.keys())
    task_counts = await _task_counts_by_board(session, board_ids)
    tasks = await _ordered_tasks_for_boards(
        session,
        board_ids,
        include_done=include_done,
    )
    agent_name_by_id = await _agent_names(session, tasks)
    child_count_by_parent_id = await child_counts_by_parent_id(
        session,
        parent_ids=[task.id for task in tasks],
    )
    deps_by_task_id = await dependency_ids_by_task_id(
        session,
        board_id=board_ids[0],
        task_ids=[task.id for task in tasks],
    )
    all_dependency_ids: list[UUID] = []
    for values in deps_by_task_id.values():
        all_dependency_ids.extend(values)
    dependency_status_by_id_map = await dependency_status_by_id_for_boards(
        session,
        board_ids=board_ids,
        dependency_ids=list({*all_dependency_ids}),
    )
    tag_state_by_task_id = await load_tag_state(
        session,
        task_ids=[task.id for task in tasks],
    )
    tasks_by_board, all_task_summaries = _task_summaries_by_board(
        boards_by_id=boards_by_id,
        tasks=tasks,
        agent_name_by_id=agent_name_by_id,
        child_count_by_parent_id=child_count_by_parent_id,
        deps_by_task_id=deps_by_task_id,
        dependency_status_by_id_map=dependency_status_by_id_map,
        tag_state_by_task_id=tag_state_by_task_id,
        per_board_task_limit=per_board_task_limit,
    )
    snapshots = [
        BoardGroupBoardSnapshot(
            board=BoardRead.model_validate(board, from_attributes=True),
            task_counts=dict(task_counts.get(board.id, {})),
            tasks=tasks_by_board.get(board.id, []),
        )
        for board in boards
    ]
    gateway_ids = [board.gateway_id for board in boards if board.gateway_id is not None]
    return BoardGroupSnapshot(
        group=BoardGroupRead.model_validate(group, from_attributes=True),
        boards=snapshots,
        pending_approvals_count=await _pending_approvals_count(session, board_ids=board_ids),
        blocked_tasks=_blocked_task_callouts(all_task_summaries),
        activity_feed=await _recent_activity(session, board_ids=board_ids),
        agenda=_agenda_bucket(all_task_summaries),
        agent_workload=await _agent_workload(
            session,
            board_ids=board_ids,
            gateway_ids=gateway_ids,
            summaries=all_task_summaries,
        ),
        memory_preview=await _memory_preview(session, board_group_id=group.id),
    )


async def build_board_group_snapshot(
    session: AsyncSession,
    *,
    board: Board,
    include_self: bool = False,
    include_done: bool = False,
    per_board_task_limit: int = 5,
) -> BoardGroupSnapshot:
    """Build a board-group snapshot anchored to a board context."""
    if not board.board_group_id:
        return BoardGroupSnapshot(group=None, boards=[])
    group = await BoardGroup.objects.by_id(board.board_group_id).first(session)
    if group is None:
        return BoardGroupSnapshot(group=None, boards=[])
    return await build_group_snapshot(
        session,
        group=group,
        exclude_board_id=None if include_self else board.id,
        include_done=include_done,
        per_board_task_limit=per_board_task_limit,
    )
