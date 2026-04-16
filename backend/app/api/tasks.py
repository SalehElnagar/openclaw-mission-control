"""Task API routes for listing, streaming, and mutating board tasks."""

from __future__ import annotations

import asyncio
import inspect
import json
import re
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import asc, desc, or_
from sqlmodel import col, select
from sse_starlette.sse import EventSourceResponse

from app.api.deps import (
    ActorContext,
    get_board_for_actor_read,
    get_board_for_user_write,
    get_task_or_404,
    require_user_auth,
    require_user_or_agent,
)
from app.core.time import utcnow
from app.db import crud
from app.db.pagination import paginate
from app.db.session import async_session_maker, get_session
from app.models.activity_events import ActivityEvent
from app.models.agents import Agent
from app.models.approval_task_links import ApprovalTaskLink
from app.models.approvals import Approval
from app.models.boards import Board
from app.models.tag_assignments import TagAssignment
from app.models.task_custom_fields import (
    BoardTaskCustomField,
    TaskCustomFieldDefinition,
    TaskCustomFieldValue,
)
from app.models.task_dependencies import TaskDependency
from app.models.task_fingerprints import TaskFingerprint
from app.models.tasks import Task
from app.schemas.activity_events import ActivityEventRead
from app.schemas.common import OkResponse
from app.schemas.errors import BlockedTaskError
from app.schemas.pagination import DefaultLimitOffsetPage
from app.schemas.task_custom_fields import (
    TaskCustomFieldType,
    TaskCustomFieldValues,
    validate_custom_field_value,
)
from app.schemas.tasks import TaskCommentCreate, TaskCommentRead, TaskCreate, TaskRead, TaskUpdate
from app.services.activity_log import record_activity
from app.services.approval_task_links import (
    load_task_ids_by_approval,
    pending_approval_conflicts_by_task,
)
from app.services.mentions import extract_mentions, matches_agent_mention
from app.services.openclaw.gateway_dispatch import GatewayDispatchService
from app.services.openclaw.gateway_rpc import GatewayConfig as GatewayClientConfig
from app.services.openclaw.gateway_rpc import OpenClawGatewayError
from app.services.openclaw.presence_policy import (
    paused_board_ids_for_boards,
    reconcile_scope_presence,
    set_agent_presence_active,
)
from app.services.openclaw.provisioning_db import AgentLifecycleService
from app.services.organizations import require_board_access
from app.services.tags import (
    TagState,
    load_tag_state,
    replace_tags,
    validate_tag_ids,
)
from app.services.task_dependencies import (
    blocked_by_dependency_ids,
    dependency_ids_by_task_id,
    dependency_status_by_id,
    dependent_task_ids,
    replace_task_dependencies,
    validate_dependency_update,
)
from app.services.task_hierarchy import child_counts_by_parent_id, validate_parent_task_update
from app.services.task_scope import (
    board_ids_share_scope,
    board_scope_board_ids,
    resolve_scope_lead,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Sequence

    from fastapi_pagination.limit_offset import LimitOffsetPage
    from sqlmodel.ext.asyncio.session import AsyncSession
    from sqlmodel.sql.expression import SelectOfScalar

    from app.core.auth import AuthContext
    from app.models.users import User

router = APIRouter(prefix="/boards/{board_id}/tasks", tags=["tasks"])

ALLOWED_STATUSES = {"inbox", "in_progress", "review", "done"}
TASK_EVENT_TYPES = {
    "task.created",
    "task.updated",
    "task.status_changed",
    "task.comment",
}
SSE_SEEN_MAX = 2000
TASK_SNIPPET_MAX_LEN = 500
TASK_SNIPPET_TRUNCATED_LEN = 497
TASK_EVENT_ROW_LEN = 2
BOARD_READ_DEP = Depends(get_board_for_actor_read)
ACTOR_DEP = Depends(require_user_or_agent)
SINCE_QUERY = Query(default=None)
STATUS_QUERY = Query(default=None, alias="status")
BOARD_WRITE_DEP = Depends(get_board_for_user_write)
SESSION_DEP = Depends(get_session)
USER_AUTH_DEP = Depends(require_user_auth)
TASK_DEP = Depends(get_task_or_404)
TASK_REFERENCE_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b",
)


@dataclass(frozen=True, slots=True)
class _BoardCustomFieldDefinition:
    id: UUID
    field_key: str
    field_type: TaskCustomFieldType
    validation_regex: str | None
    required: bool
    default_value: object | None


def _comment_validation_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail="Comment is required.",
    )


def _task_update_forbidden_error(*, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "message": message,
            "code": code,
        },
    )


def _blocked_task_error(blocked_by_task_ids: Sequence[UUID]) -> HTTPException:
    # NOTE: Keep this payload machine-readable; UI and automation rely on it.
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "message": "Task is blocked by incomplete dependencies.",
            "code": "task_blocked_cannot_transition",
            "blocked_by_task_ids": [str(value) for value in blocked_by_task_ids],
        },
    )


async def _validate_assigned_agent_for_task(
    session: AsyncSession,
    *,
    task_board_id: UUID,
    assigned_agent_id: UUID | None,
) -> Agent | None:
    if assigned_agent_id is None:
        return None
    agent = await Agent.objects.by_id(assigned_agent_id).first(session)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    if agent.is_board_lead or agent.board_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tasks may only be assigned to board-scoped worker agents.",
        )
    if not await board_ids_share_scope(
        session,
        anchor_board_id=task_board_id,
        candidate_board_id=agent.board_id,
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Assigned agent must be in the same board scope as the task.",
        )
    return agent


def _approval_required_for_done_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "message": ("Task can only be marked done when a linked approval has been approved."),
            "blocked_by_task_ids": [],
        },
    )


def _review_required_for_done_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "message": ("Task can only be marked done from review when the board rule is enabled."),
            "blocked_by_task_ids": [],
        },
    )


def _pending_approval_blocks_status_change_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "message": ("Task status cannot be changed while a linked approval is pending."),
            "blocked_by_task_ids": [],
        },
    )


async def _task_has_approved_linked_approval(
    session: AsyncSession,
    *,
    board_id: UUID,
    task_id: UUID,
) -> bool:
    linked_approval_ids = select(col(ApprovalTaskLink.approval_id)).where(
        col(ApprovalTaskLink.task_id) == task_id,
    )
    statement = (
        select(col(Approval.id))
        .where(col(Approval.board_id) == board_id)
        .where(col(Approval.status) == "approved")
        .where(
            or_(
                col(Approval.task_id) == task_id,
                col(Approval.id).in_(linked_approval_ids),
            ),
        )
        .limit(1)
    )
    return (await session.exec(statement)).first() is not None


async def _task_has_pending_linked_approval(
    session: AsyncSession,
    *,
    board_id: UUID,
    task_id: UUID,
) -> bool:
    conflicts = await pending_approval_conflicts_by_task(
        session,
        board_id=board_id,
        task_ids=[task_id],
    )
    return task_id in conflicts


async def _require_approved_linked_approval_for_done(
    session: AsyncSession,
    *,
    board_id: UUID,
    task_id: UUID,
    previous_status: str,
    target_status: str,
) -> None:
    if previous_status == "done" or target_status != "done":
        return
    requires_approval = (
        await session.exec(
            select(col(Board.require_approval_for_done)).where(col(Board.id) == board_id),
        )
    ).first()
    if requires_approval is False:
        return
    if not await _task_has_approved_linked_approval(
        session,
        board_id=board_id,
        task_id=task_id,
    ):
        raise _approval_required_for_done_error()


async def _require_review_before_done_when_enabled(
    session: AsyncSession,
    *,
    board_id: UUID,
    previous_status: str,
    target_status: str,
) -> None:
    if previous_status == "done" or target_status != "done":
        return
    requires_review = (
        await session.exec(
            select(col(Board.require_review_before_done)).where(col(Board.id) == board_id),
        )
    ).first()
    if requires_review and previous_status != "review":
        raise _review_required_for_done_error()


async def _require_comment_for_review_when_enabled(
    session: AsyncSession,
    *,
    board_id: UUID,
) -> bool:
    requires_comment = (
        await session.exec(
            select(col(Board.comment_required_for_review)).where(col(Board.id) == board_id),
        )
    ).first()
    return bool(requires_comment)


async def _require_no_pending_approval_for_status_change_when_enabled(
    session: AsyncSession,
    *,
    board_id: UUID,
    task_id: UUID,
    previous_status: str,
    target_status: str,
    status_requested: bool,
) -> None:
    if not status_requested or previous_status == target_status:
        return
    blocks_status_change = (
        await session.exec(
            select(col(Board.block_status_changes_with_pending_approval)).where(
                col(Board.id) == board_id,
            ),
        )
    ).first()
    if not blocks_status_change:
        return
    if await _task_has_pending_linked_approval(
        session,
        board_id=board_id,
        task_id=task_id,
    ):
        raise _pending_approval_blocks_status_change_error()


def _truncate_snippet(value: str) -> str:
    text = value.strip()
    if len(text) <= TASK_SNIPPET_MAX_LEN:
        return text
    return f"{text[:TASK_SNIPPET_TRUNCATED_LEN]}..."


async def has_valid_recent_comment(
    session: AsyncSession,
    task: Task,
    agent_id: UUID | None,
    since: datetime | None,
) -> bool:
    """Check whether the task has a recent non-empty comment by the agent."""
    if agent_id is None or since is None:
        return False
    statement = (
        select(ActivityEvent)
        .where(col(ActivityEvent.task_id) == task.id)
        .where(col(ActivityEvent.event_type) == "task.comment")
        .where(col(ActivityEvent.agent_id) == agent_id)
        .where(col(ActivityEvent.created_at) >= since)
        .order_by(desc(col(ActivityEvent.created_at)))
    )
    event = (await session.exec(statement)).first()
    if event is None or event.message is None:
        return False
    return bool(event.message.strip())


def _parse_since(value: str | None) -> datetime | None:
    """Parse an optional ISO-8601 timestamp into a naive UTC `datetime`.

    The API accepts either naive timestamps (treated as UTC) or timezone-aware values.
    Returning naive UTC simplifies SQLModel comparisons against stored naive UTC values.
    """

    if not value:
        return None

    normalized = value.strip()
    if not normalized:
        return None

    # Allow common ISO-8601 `Z` suffix (UTC) even though `datetime.fromisoformat` expects `+00:00`.
    normalized = normalized.replace("Z", "+00:00")

    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None

    if parsed.tzinfo is not None:
        return parsed.astimezone(UTC).replace(tzinfo=None)

    # No tzinfo: interpret as UTC for consistency with other API timestamps.
    return parsed


def _coerce_task_items(items: Sequence[object]) -> list[Task]:
    """Validate/convert paginated query results to a concrete `list[Task]`.

    SQLModel pagination helpers return `Sequence[object]`; we validate types early so the
    rest of the route logic can assume real `Task` instances.
    """

    tasks: list[Task] = []
    for item in items:
        if not isinstance(item, Task):
            msg = "Expected Task items from paginated query"
            raise TypeError(msg)
        tasks.append(item)
    return tasks


def _coerce_task_event_rows(
    items: Sequence[object],
) -> list[tuple[ActivityEvent, Task | None]]:
    """Normalize DB rows into `(ActivityEvent, Task | None)` tuples.

    Depending on the SQLAlchemy/SQLModel execution path, result rows may arrive as:
    - real Python tuples, or
    - row-like objects supporting `__len__` and `__getitem__`.

    This helper centralizes validation so SSE/event-stream logic can assume a stable shape.
    """

    rows: list[tuple[ActivityEvent, Task | None]] = []
    for item in items:
        first: object
        second: object

        if isinstance(item, tuple):
            if len(item) != TASK_EVENT_ROW_LEN:
                msg = "Expected (ActivityEvent, Task | None) rows"
                raise TypeError(msg)
            first, second = item
        else:
            try:
                row_len = len(item)  # type: ignore[arg-type]
                first = item[0]  # type: ignore[index]
                second = item[1]  # type: ignore[index]
            except (IndexError, KeyError, TypeError):
                msg = "Expected (ActivityEvent, Task | None) rows"
                raise TypeError(msg) from None
            if row_len != TASK_EVENT_ROW_LEN:
                msg = "Expected (ActivityEvent, Task | None) rows"
                raise TypeError(msg)

        if isinstance(first, ActivityEvent) and (isinstance(second, Task) or second is None):
            rows.append((first, second))
            continue

        msg = "Expected (ActivityEvent, Task | None) rows"
        raise TypeError(msg)
    return rows


async def _lead_was_mentioned(
    session: AsyncSession,
    task: Task,
    lead: Agent,
) -> bool:
    """Return `True` if the lead agent is mentioned in any comment on the task.

    This is used to avoid redundant lead pings (especially in auto-created tasks) while still
    ensuring escalation happens when explicitly requested.
    """

    statement = (
        select(ActivityEvent.message)
        .where(col(ActivityEvent.task_id) == task.id)
        .where(col(ActivityEvent.event_type) == "task.comment")
        .order_by(desc(col(ActivityEvent.created_at)))
    )
    for message in await session.exec(statement):
        if not message:
            continue
        mentions = extract_mentions(message)
        if matches_agent_mention(lead, mentions):
            return True
    return False


def _lead_created_task(task: Task, lead: Agent) -> bool:
    """Return `True` if `task` was auto-created by the lead agent."""

    if not task.auto_created or not task.auto_reason:
        return False
    return task.auto_reason in {
        f"lead_agent:{lead.id}",
        f"coordinator_agent:{lead.id}",
    }


async def _reconcile_dependents_for_dependency_toggle(
    session: AsyncSession,
    *,
    board_id: UUID,
    dependency_task: Task,
    previous_status: str,
    actor_agent_id: UUID | None,
) -> None:
    """Apply dependency side-effects when a dependency task toggles done/undone.

    The UI models dependencies as a DAG: when a dependency is reopened, dependents that were
    previously marked done may need to be reopened or flagged. This helper keeps dependent state
    consistent with the dependency graph without duplicating logic across endpoints.
    """

    done_toggled = (previous_status == "done") != (dependency_task.status == "done")
    if not done_toggled:
        return

    dependent_ids = await dependent_task_ids(
        session,
        board_id=board_id,
        dependency_task_id=dependency_task.id,
    )
    if not dependent_ids:
        return

    dependents = list(
        await session.exec(
            select(Task)
            .where(col(Task.board_id) == board_id)
            .where(col(Task.id).in_(dependent_ids)),
        ),
    )
    reopened = previous_status == "done" and dependency_task.status != "done"

    for dependent in dependents:
        if dependent.status == "done":
            continue
        if reopened:
            should_reset = (
                dependent.status != "inbox"
                or dependent.assigned_agent_id is not None
                or dependent.in_progress_at is not None
            )
            if should_reset:
                dependent.status = "inbox"
                dependent.assigned_agent_id = None
                dependent.in_progress_at = None
                dependent.updated_at = utcnow()
                session.add(dependent)
                record_activity(
                    session,
                    event_type="task.status_changed",
                    task_id=dependent.id,
                    message=(
                        "Task returned to inbox: dependency reopened " f"({dependency_task.title})."
                    ),
                    agent_id=actor_agent_id,
                    board_id=dependent.board_id,
                )
            else:
                record_activity(
                    session,
                    event_type="task.updated",
                    task_id=dependent.id,
                    message=f"Dependency completion changed: {dependency_task.title}.",
                    agent_id=actor_agent_id,
                    board_id=dependent.board_id,
                )
        else:
            record_activity(
                session,
                event_type="task.updated",
                task_id=dependent.id,
                message=f"Dependency completion changed: {dependency_task.title}.",
                agent_id=actor_agent_id,
                board_id=dependent.board_id,
            )


async def _fetch_task_events(
    session: AsyncSession,
    board_id: UUID,
    since: datetime,
) -> list[tuple[ActivityEvent, Task | None]]:
    task_ids = list(
        await session.exec(select(Task.id).where(col(Task.board_id) == board_id)),
    )
    if not task_ids:
        return []
    statement = (
        select(ActivityEvent, Task)
        .outerjoin(Task, col(ActivityEvent.task_id) == col(Task.id))
        .where(col(ActivityEvent.task_id).in_(task_ids))
        .where(col(ActivityEvent.event_type).in_(TASK_EVENT_TYPES))
        .where(col(ActivityEvent.created_at) >= since)
        .order_by(asc(col(ActivityEvent.created_at)))
    )
    result = await session.execute(statement)
    return _coerce_task_event_rows(list(result.tuples().all()))


def _serialize_comment(event: ActivityEvent) -> dict[str, object]:
    return TaskCommentRead.model_validate(event).model_dump(mode="json")


async def _send_lead_task_message(
    *,
    dispatch: GatewayDispatchService,
    session_key: str,
    config: GatewayClientConfig,
    message: str,
    deliver: bool = False,
) -> OpenClawGatewayError | None:
    return await dispatch.try_send_agent_message(
        session_key=session_key,
        config=config,
        agent_name="Lead Agent",
        message=message,
        deliver=deliver,
    )


async def _send_agent_task_message(
    *,
    dispatch: GatewayDispatchService,
    session_key: str,
    config: GatewayClientConfig,
    agent_name: str,
    message: str,
    deliver: bool = False,
) -> OpenClawGatewayError | None:
    return await dispatch.try_send_agent_message(
        session_key=session_key,
        config=config,
        agent_name=agent_name,
        message=message,
        deliver=deliver,
    )


def _supports_keyword_argument(func: object, keyword: str) -> bool:
    try:
        params = inspect.signature(func).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(
        param.name == keyword or param.kind is inspect.Parameter.VAR_KEYWORD for param in params
    )


async def _send_lead_task_message_compat(
    *,
    dispatch: GatewayDispatchService,
    session_key: str,
    config: GatewayClientConfig,
    message: str,
    deliver: bool = False,
) -> OpenClawGatewayError | None:
    kwargs = {
        "dispatch": dispatch,
        "session_key": session_key,
        "config": config,
        "message": message,
    }
    if _supports_keyword_argument(_send_lead_task_message, "deliver"):
        kwargs["deliver"] = deliver
    return await _send_lead_task_message(**kwargs)


async def _send_agent_task_message_compat(
    *,
    dispatch: GatewayDispatchService,
    session_key: str,
    config: GatewayClientConfig,
    agent_name: str,
    message: str,
    deliver: bool = False,
) -> OpenClawGatewayError | None:
    kwargs = {
        "dispatch": dispatch,
        "session_key": session_key,
        "config": config,
        "agent_name": agent_name,
        "message": message,
    }
    if _supports_keyword_argument(_send_agent_task_message, "deliver"):
        kwargs["deliver"] = deliver
    return await _send_agent_task_message(**kwargs)


def _assignment_notification_message(*, board: Board, task: Task, agent: Agent) -> str:
    description = _truncate_snippet(task.description or "")
    details = [
        f"Board: {board.name}",
        f"Task: {task.title}",
        f"Task ID: {task.id}",
        f"Status: {task.status}",
    ]
    if description:
        details.append(f"Description: {description}")
    if task.status == "review" and agent.is_board_lead:
        action = (
            "Take action: review the deliverables now. "
            "Approve by moving to done or return to inbox with clear feedback."
        )
        return "TASK READY FOR LEAD REVIEW\n" + "\n".join(details) + f"\n\n{action}"
    return (
        "TASK ASSIGNED\n"
        + "\n".join(details)
        + ("\n\nTake action: open the task and begin work. " "Post updates as task comments.")
    )


def _rework_notification_message(
    *,
    board: Board,
    task: Task,
    feedback: str | None,
) -> str:
    description = _truncate_snippet(task.description or "")
    details = [
        f"Board: {board.name}",
        f"Task: {task.title}",
        f"Task ID: {task.id}",
        f"Status: {task.status}",
    ]
    if description:
        details.append(f"Description: {description}")
    requested_changes = (
        _truncate_snippet(feedback)
        if feedback and feedback.strip()
        else "Lead requested changes. Review latest task comments for exact required updates."
    )
    return (
        "CHANGES REQUESTED\n"
        + "\n".join(details)
        + "\n\nRequested changes:\n"
        + requested_changes
        + "\n\nTake action: address the requested changes, then move the task back to review."
    )


async def _latest_task_comment_by_agent(
    session: AsyncSession,
    *,
    task_id: UUID,
    agent_id: UUID,
) -> str | None:
    statement = (
        select(col(ActivityEvent.message))
        .where(col(ActivityEvent.task_id) == task_id)
        .where(col(ActivityEvent.event_type) == "task.comment")
        .where(col(ActivityEvent.agent_id) == agent_id)
        .order_by(desc(col(ActivityEvent.created_at)))
        .limit(1)
    )
    return (await session.exec(statement)).first()


async def _wake_agent_online_for_task(
    *,
    session: AsyncSession,
    board: Board,
    task: Task,
    agent: Agent,
    reason: str,
) -> None:
    if not agent.openclaw_session_id:
        return
    if board.id in await paused_board_ids_for_boards(session, [board.id]):
        return
    service = AgentLifecycleService(session)
    try:
        await set_agent_presence_active(
            session,
            agent=agent,
            board_name=board.name,
        )
        await service.commit_heartbeat(agent=agent, status_value="online")
        record_activity(
            session,
            event_type="task.assignee_woken",
            message=(f"Assignee heartbeat set online ({reason}): {agent.name}."),
            agent_id=agent.id,
            task_id=task.id,
            board_id=board.id,
        )
    except Exception as exc:  # pragma: no cover - best effort wake path
        record_activity(
            session,
            event_type="task.assignee_wake_failed",
            message=(f"Assignee wake failed ({reason}): {agent.name}. Error: {exc!s}"),
            agent_id=agent.id,
            task_id=task.id,
            board_id=board.id,
        )
    await session.commit()


def _should_wake_lead_for_new_task(
    *,
    board: Board,
    task: Task,
) -> bool:
    if task.parent_task_id is not None:
        return False
    return board.name.strip().lower() in {"requirements", "ready"}


async def _reconcile_presence_after_task_change(
    session: AsyncSession,
    *,
    board_id: UUID,
) -> None:
    try:
        await reconcile_scope_presence(session, board_id=board_id)
    except Exception as exc:  # pragma: no cover - best effort policy sync
        record_activity(
            session,
            event_type="task.presence_reconcile_failed",
            message=f"Presence reconcile failed: {exc!s}",
            board_id=board_id,
        )
        await session.commit()


async def _notify_agent_on_task_assign(
    *,
    session: AsyncSession,
    board: Board,
    task: Task,
    agent: Agent,
    wake_assignee: bool = True,
) -> None:
    if not agent.openclaw_session_id:
        return
    if wake_assignee:
        await _wake_agent_online_for_task(
            session=session,
            board=board,
            task=task,
            agent=agent,
            reason="assignment",
        )
    dispatch = GatewayDispatchService(session)
    config = await dispatch.optional_gateway_config_for_board(board)
    if config is None:
        return
    message = _assignment_notification_message(board=board, task=task, agent=agent)
    error = await _send_agent_task_message_compat(
        dispatch=dispatch,
        session_key=agent.openclaw_session_id,
        config=config,
        agent_name=agent.name,
        message=message,
        deliver=True,
    )
    if error is None:
        record_activity(
            session,
            event_type="task.assignee_notified",
            message=f"Agent notified for assignment: {agent.name}.",
            agent_id=agent.id,
            task_id=task.id,
            board_id=board.id,
        )
        await session.commit()
    else:
        record_activity(
            session,
            event_type="task.assignee_notify_failed",
            message=f"Assignee notify failed: {error}",
            agent_id=agent.id,
            task_id=task.id,
            board_id=board.id,
        )
        await session.commit()


async def _notify_agent_on_task_rework(
    *,
    session: AsyncSession,
    board: Board,
    task: Task,
    agent: Agent,
    lead: Agent,
) -> None:
    if not agent.openclaw_session_id:
        return
    dispatch = GatewayDispatchService(session)
    config = await dispatch.optional_gateway_config_for_board(board)
    if config is None:
        return
    feedback = await _latest_task_comment_by_agent(
        session,
        task_id=task.id,
        agent_id=lead.id,
    )
    message = _rework_notification_message(
        board=board,
        task=task,
        feedback=feedback,
    )
    error = await _send_agent_task_message_compat(
        dispatch=dispatch,
        session_key=agent.openclaw_session_id,
        config=config,
        agent_name=agent.name,
        message=message,
        deliver=True,
    )
    if error is None:
        record_activity(
            session,
            event_type="task.rework_notified",
            message=f"Assignee notified about requested changes: {agent.name}.",
            agent_id=agent.id,
            task_id=task.id,
            board_id=board.id,
        )
        await session.commit()
    else:
        record_activity(
            session,
            event_type="task.rework_notify_failed",
            message=f"Rework notify failed: {error}",
            agent_id=agent.id,
            task_id=task.id,
            board_id=board.id,
        )
        await session.commit()


async def notify_agent_on_task_assign(
    *,
    session: AsyncSession,
    board: Board,
    task: Task,
    agent: Agent,
) -> None:
    """Notify an assignee via gateway after task assignment."""
    await _notify_agent_on_task_assign(
        session=session,
        board=board,
        task=task,
        agent=agent,
    )


async def _notify_lead_on_task_create(
    *,
    session: AsyncSession,
    board: Board,
    task: Task,
) -> None:
    lead = await resolve_scope_lead(session, board_id=board.id)
    if lead is None or not lead.openclaw_session_id:
        return
    if _should_wake_lead_for_new_task(board=board, task=task):
        await _wake_agent_online_for_task(
            session=session,
            board=board,
            task=task,
            agent=lead,
            reason="new_top_level_task",
        )
    dispatch = GatewayDispatchService(session)
    config = await dispatch.optional_gateway_config_for_board(board)
    if config is None:
        return
    description = _truncate_snippet(task.description or "")
    details = [
        f"Board: {board.name}",
        f"Task: {task.title}",
        f"Task ID: {task.id}",
        f"Status: {task.status}",
    ]
    if description:
        details.append(f"Description: {description}")
    message = (
        "NEW TASK ADDED\n"
        + "\n".join(details)
        + "\n\nTake action now:\n"
        + "1. Triage the epic/task and confirm the next executable slices.\n"
        + "2. Use `GET /api/v1/agent/boards` to discover all boards in your visible scope.\n"
        + "3. Use `GET /api/v1/agent/agents` to discover board-scoped worker agents you can route.\n"
        + "4. Create or update downstream tasks using the documented agent board routes.\n"
        + "5. If a routing or permission boundary blocks you, record the exact blocker in board memory."
    )
    error = await _send_lead_task_message_compat(
        dispatch=dispatch,
        session_key=lead.openclaw_session_id,
        config=config,
        message=message,
        deliver=True,
    )
    if error is None:
        record_activity(
            session,
            event_type="task.lead_notified",
            message=f"Lead agent notified for task: {task.title}.",
            agent_id=lead.id,
            task_id=task.id,
            board_id=board.id,
        )
        await session.commit()
    else:
        record_activity(
            session,
            event_type="task.lead_notify_failed",
            message=f"Lead notify failed: {error}",
            agent_id=lead.id,
            task_id=task.id,
            board_id=board.id,
        )
        await session.commit()


async def _notify_lead_on_task_unassigned(
    *,
    session: AsyncSession,
    board: Board,
    task: Task,
) -> None:
    lead = await resolve_scope_lead(session, board_id=board.id)
    if lead is None or not lead.openclaw_session_id:
        return
    dispatch = GatewayDispatchService(session)
    config = await dispatch.optional_gateway_config_for_board(board)
    if config is None:
        return
    description = _truncate_snippet(task.description or "")
    details = [
        f"Board: {board.name}",
        f"Task: {task.title}",
        f"Task ID: {task.id}",
        f"Status: {task.status}",
    ]
    if description:
        details.append(f"Description: {description}")
    message = (
        "TASK BACK IN INBOX\n"
        + "\n".join(details)
        + "\n\nTake action: assign a new owner or adjust the plan."
    )
    error = await _send_lead_task_message_compat(
        dispatch=dispatch,
        session_key=lead.openclaw_session_id,
        config=config,
        message=message,
        deliver=True,
    )
    if error is None:
        record_activity(
            session,
            event_type="task.lead_unassigned_notified",
            message=f"Lead notified task returned to inbox: {task.title}.",
            agent_id=lead.id,
            task_id=task.id,
            board_id=board.id,
        )
        await session.commit()
    else:
        record_activity(
            session,
            event_type="task.lead_unassigned_notify_failed",
            message=f"Lead notify failed: {error}",
            agent_id=lead.id,
            task_id=task.id,
            board_id=board.id,
        )
        await session.commit()


def _status_values(status_filter: str | None) -> list[str]:
    if not status_filter:
        return []
    values = [s.strip() for s in status_filter.split(",") if s.strip()]
    if any(value not in ALLOWED_STATUSES for value in values):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Unsupported task status filter.",
        )
    return values


async def _organization_custom_field_definitions_for_board(
    session: AsyncSession,
    *,
    board_id: UUID,
) -> dict[str, _BoardCustomFieldDefinition]:
    organization_id = (
        await session.exec(
            select(Board.organization_id).where(col(Board.id) == board_id),
        )
    ).first()
    if organization_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    definitions = list(
        await session.exec(
            select(TaskCustomFieldDefinition)
            .join(
                BoardTaskCustomField,
                col(BoardTaskCustomField.task_custom_field_definition_id)
                == col(TaskCustomFieldDefinition.id),
            )
            .where(
                col(BoardTaskCustomField.board_id) == board_id,
                col(TaskCustomFieldDefinition.organization_id) == organization_id,
            ),
        ),
    )
    return {
        definition.field_key: _BoardCustomFieldDefinition(
            id=definition.id,
            field_key=definition.field_key,
            field_type=cast(TaskCustomFieldType, definition.field_type),
            validation_regex=definition.validation_regex,
            required=definition.required,
            default_value=definition.default_value,
        )
        for definition in definitions
    }


def _reject_unknown_custom_field_keys(
    *,
    custom_field_values: TaskCustomFieldValues,
    definitions_by_key: dict[str, _BoardCustomFieldDefinition],
) -> None:
    unknown_field_keys = sorted(set(custom_field_values) - set(definitions_by_key))
    if not unknown_field_keys:
        return
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail={
            "message": "Unknown custom field keys for this board.",
            "unknown_field_keys": unknown_field_keys,
        },
    )


def _reject_missing_required_custom_field_keys(
    *,
    effective_values: TaskCustomFieldValues,
    definitions_by_key: dict[str, _BoardCustomFieldDefinition],
) -> None:
    missing_field_keys = [
        definition.field_key
        for definition in definitions_by_key.values()
        if definition.required and effective_values.get(definition.field_key) is None
    ]
    if not missing_field_keys:
        return
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail={
            "message": "Required custom fields must have values.",
            "missing_field_keys": sorted(missing_field_keys),
        },
    )


def _reject_invalid_custom_field_values(
    *,
    custom_field_values: TaskCustomFieldValues,
    definitions_by_key: dict[str, _BoardCustomFieldDefinition],
) -> None:
    for field_key, value in custom_field_values.items():
        definition = definitions_by_key[field_key]
        try:
            validate_custom_field_value(
                field_type=definition.field_type,
                value=value,
                validation_regex=definition.validation_regex,
            )
        except ValueError as err:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail={
                    "message": "Invalid custom field value.",
                    "field_key": field_key,
                    "field_type": definition.field_type,
                    "reason": str(err),
                },
            ) from err


async def _task_custom_field_rows_by_definition_id(
    session: AsyncSession,
    *,
    task_id: UUID,
    definition_ids: list[UUID],
) -> dict[UUID, TaskCustomFieldValue]:
    if not definition_ids:
        return {}
    rows = list(
        await session.exec(
            select(TaskCustomFieldValue).where(
                col(TaskCustomFieldValue.task_id) == task_id,
                col(TaskCustomFieldValue.task_custom_field_definition_id).in_(definition_ids),
            ),
        ),
    )
    return {row.task_custom_field_definition_id: row for row in rows}


async def _set_task_custom_field_values_for_create(
    session: AsyncSession,
    *,
    board_id: UUID,
    task_id: UUID,
    custom_field_values: TaskCustomFieldValues,
) -> None:
    definitions_by_key = await _organization_custom_field_definitions_for_board(
        session,
        board_id=board_id,
    )
    _reject_unknown_custom_field_keys(
        custom_field_values=custom_field_values,
        definitions_by_key=definitions_by_key,
    )
    _reject_invalid_custom_field_values(
        custom_field_values=custom_field_values,
        definitions_by_key=definitions_by_key,
    )

    effective_values: TaskCustomFieldValues = {}
    for field_key, definition in definitions_by_key.items():
        if field_key in custom_field_values:
            effective_values[field_key] = custom_field_values[field_key]
        else:
            effective_values[field_key] = definition.default_value

    _reject_missing_required_custom_field_keys(
        effective_values=effective_values,
        definitions_by_key=definitions_by_key,
    )

    for field_key, definition in definitions_by_key.items():
        value = effective_values.get(field_key)
        if value is None:
            continue
        session.add(
            TaskCustomFieldValue(
                task_id=task_id,
                task_custom_field_definition_id=definition.id,
                value=value,
            ),
        )


async def _set_task_custom_field_values_for_update(
    session: AsyncSession,
    *,
    board_id: UUID,
    task_id: UUID,
    custom_field_values: TaskCustomFieldValues,
) -> None:
    definitions_by_key = await _organization_custom_field_definitions_for_board(
        session,
        board_id=board_id,
    )
    _reject_unknown_custom_field_keys(
        custom_field_values=custom_field_values,
        definitions_by_key=definitions_by_key,
    )
    _reject_invalid_custom_field_values(
        custom_field_values=custom_field_values,
        definitions_by_key=definitions_by_key,
    )
    definitions_by_id = {definition.id: definition for definition in definitions_by_key.values()}
    rows_by_definition_id = await _task_custom_field_rows_by_definition_id(
        session,
        task_id=task_id,
        definition_ids=list(definitions_by_id),
    )

    effective_values: TaskCustomFieldValues = {}
    for field_key, definition in definitions_by_key.items():
        current_row = rows_by_definition_id.get(definition.id)
        if field_key in custom_field_values:
            effective_values[field_key] = custom_field_values[field_key]
        elif current_row is not None:
            effective_values[field_key] = current_row.value
        else:
            effective_values[field_key] = definition.default_value

    _reject_missing_required_custom_field_keys(
        effective_values=effective_values,
        definitions_by_key=definitions_by_key,
    )

    for field_key, value in custom_field_values.items():
        definition = definitions_by_key[field_key]
        row = rows_by_definition_id.get(definition.id)
        if value is None:
            if row is not None:
                await session.delete(row)
            continue
        if row is None:
            session.add(
                TaskCustomFieldValue(
                    task_id=task_id,
                    task_custom_field_definition_id=definition.id,
                    value=value,
                ),
            )
            continue
        row.value = value
        row.updated_at = utcnow()
        session.add(row)


async def _task_custom_field_values_by_task_id(
    session: AsyncSession,
    *,
    board_id: UUID,
    task_ids: Sequence[UUID],
) -> dict[UUID, TaskCustomFieldValues]:
    unique_task_ids = list({*task_ids})
    if not unique_task_ids:
        return {}

    definitions_by_key = await _organization_custom_field_definitions_for_board(
        session,
        board_id=board_id,
    )
    if not definitions_by_key:
        return {task_id: {} for task_id in unique_task_ids}

    definitions_by_id = {definition.id: definition for definition in definitions_by_key.values()}
    default_values = {
        field_key: definition.default_value for field_key, definition in definitions_by_key.items()
    }
    values_by_task_id: dict[UUID, TaskCustomFieldValues] = {
        task_id: dict(default_values) for task_id in unique_task_ids
    }

    rows = (
        await session.exec(
            select(
                col(TaskCustomFieldValue.task_id),
                col(TaskCustomFieldValue.task_custom_field_definition_id),
                col(TaskCustomFieldValue.value),
            ).where(
                col(TaskCustomFieldValue.task_id).in_(unique_task_ids),
                col(TaskCustomFieldValue.task_custom_field_definition_id).in_(
                    list(definitions_by_id),
                ),
            ),
        )
    ).all()
    for task_id, definition_id, value in rows:
        definition = definitions_by_id.get(definition_id)
        if definition is None:
            continue
        values_by_task_id[task_id][definition.field_key] = value
    return values_by_task_id


def _task_list_statement(
    *,
    board_id: UUID,
    status_filter: str | None,
    assigned_agent_id: UUID | None,
    unassigned: bool | None,
) -> SelectOfScalar[Task]:
    statement = select(Task).where(Task.board_id == board_id)
    statuses = _status_values(status_filter)
    if statuses:
        statement = statement.where(col(Task.status).in_(statuses))
    if assigned_agent_id is not None:
        statement = statement.where(col(Task.assigned_agent_id) == assigned_agent_id)
    if unassigned:
        statement = statement.where(col(Task.assigned_agent_id).is_(None))
    return statement.order_by(col(Task.created_at).desc())


async def _task_read_page(
    *,
    session: AsyncSession,
    board_id: UUID,
    tasks: Sequence[Task],
) -> list[TaskRead]:
    if not tasks:
        return []

    task_ids = [task.id for task in tasks]
    tag_state_by_task_id = await load_tag_state(
        session,
        task_ids=task_ids,
    )
    deps_map = await dependency_ids_by_task_id(
        session,
        board_id=board_id,
        task_ids=task_ids,
    )
    dep_ids: list[UUID] = []
    for value in deps_map.values():
        dep_ids.extend(value)
    dep_status = await dependency_status_by_id(
        session,
        board_id=board_id,
        dependency_ids=list({*dep_ids}),
    )
    custom_field_values_by_task_id = await _task_custom_field_values_by_task_id(
        session,
        board_id=board_id,
        task_ids=task_ids,
    )
    child_count_by_parent_id = await child_counts_by_parent_id(
        session,
        parent_ids=task_ids,
    )

    output: list[TaskRead] = []
    for task in tasks:
        tag_state = tag_state_by_task_id.get(task.id, TagState())
        dep_list = deps_map.get(task.id, [])
        blocked_by = blocked_by_dependency_ids(
            dependency_ids=dep_list,
            status_by_id=dep_status,
        )
        if task.status == "done":
            blocked_by = []
        output.append(
            TaskRead.model_validate(task, from_attributes=True).model_copy(
                update={
                    "depends_on_task_ids": dep_list,
                    "child_count": child_count_by_parent_id.get(task.id, 0),
                    "tag_ids": tag_state.tag_ids,
                    "tags": tag_state.tags,
                    "blocked_by_task_ids": blocked_by,
                    "is_blocked": bool(blocked_by),
                    "custom_field_values": custom_field_values_by_task_id.get(task.id, {}),
                },
            ),
        )
    return output


async def _stream_task_state(
    session: AsyncSession,
    *,
    board_id: UUID,
    rows: list[tuple[ActivityEvent, Task | None]],
) -> tuple[
    dict[UUID, list[UUID]],
    dict[UUID, str],
    dict[UUID, TagState],
    dict[UUID, int],
    dict[UUID, TaskCustomFieldValues],
]:
    task_ids = [
        task.id for event, task in rows if task is not None and event.event_type != "task.comment"
    ]
    if not task_ids:
        return {}, {}, {}, {}

    tag_state_by_task_id = await load_tag_state(
        session,
        task_ids=list({*task_ids}),
    )
    child_count_by_parent_id = await child_counts_by_parent_id(
        session,
        parent_ids=list({*task_ids}),
    )
    deps_map = await dependency_ids_by_task_id(
        session,
        board_id=board_id,
        task_ids=list({*task_ids}),
    )
    dep_ids: list[UUID] = []
    for value in deps_map.values():
        dep_ids.extend(value)
    custom_field_values_by_task_id = await _task_custom_field_values_by_task_id(
        session,
        board_id=board_id,
        task_ids=list({*task_ids}),
    )
    if not dep_ids:
        return (
            deps_map,
            {},
            tag_state_by_task_id,
            child_count_by_parent_id,
            custom_field_values_by_task_id,
        )

    dep_status = await dependency_status_by_id(
        session,
        board_id=board_id,
        dependency_ids=list({*dep_ids}),
    )
    return (
        deps_map,
        dep_status,
        tag_state_by_task_id,
        child_count_by_parent_id,
        custom_field_values_by_task_id,
    )


def _task_event_payload(
    event: ActivityEvent,
    task: Task | None,
    *,
    deps_map: dict[UUID, list[UUID]],
    dep_status: dict[UUID, str],
    tag_state_by_task_id: dict[UUID, TagState],
    child_count_by_parent_id: dict[UUID, int] | None = None,
    custom_field_values_by_task_id: dict[UUID, TaskCustomFieldValues] | None = None,
) -> dict[str, object]:
    resolved_custom_field_values_by_task_id = custom_field_values_by_task_id or {}
    resolved_child_count_by_parent_id = child_count_by_parent_id or {}
    activity = ActivityEventRead.model_validate(event).model_dump(
        mode="json",
        exclude={"board_id", "route_name", "route_params"},
        exclude_none=True,
    )
    activity["agent_id"] = str(event.agent_id) if event.agent_id is not None else None
    payload: dict[str, object] = {
        "type": event.event_type,
        "activity": activity,
    }
    if event.event_type == "task.comment":
        payload["comment"] = _serialize_comment(event)
        return payload
    if task is None:
        payload["task"] = None
        return payload

    tag_state = tag_state_by_task_id.get(task.id, TagState())
    dep_list = deps_map.get(task.id, [])
    blocked_by = blocked_by_dependency_ids(
        dependency_ids=dep_list,
        status_by_id=dep_status,
    )
    if task.status == "done":
        blocked_by = []
    payload["task"] = (
        TaskRead.model_validate(task, from_attributes=True)
        .model_copy(
            update={
                "depends_on_task_ids": dep_list,
                "child_count": resolved_child_count_by_parent_id.get(task.id, 0),
                "tag_ids": tag_state.tag_ids,
                "tags": tag_state.tags,
                "blocked_by_task_ids": blocked_by,
                "is_blocked": bool(blocked_by),
                "custom_field_values": resolved_custom_field_values_by_task_id.get(
                    task.id,
                    {},
                ),
            },
        )
        .model_dump(mode="json")
    )
    return payload


async def _task_event_generator(
    *,
    request: Request,
    board_id: UUID,
    since_dt: datetime,
) -> AsyncIterator[dict[str, str]]:
    last_seen = since_dt
    seen_ids: set[UUID] = set()
    seen_queue: deque[UUID] = deque()

    while True:
        if await request.is_disconnected():
            break

        async with async_session_maker() as session:
            rows = await _fetch_task_events(session, board_id, last_seen)
            (
                deps_map,
                dep_status,
                tag_state_by_task_id,
                child_count_by_parent_id,
                custom_field_values_by_task_id,
            ) = await _stream_task_state(
                session,
                board_id=board_id,
                rows=rows,
            )

        for event, task in rows:
            if event.id in seen_ids:
                continue
            seen_ids.add(event.id)
            seen_queue.append(event.id)
            if len(seen_queue) > SSE_SEEN_MAX:
                oldest = seen_queue.popleft()
                seen_ids.discard(oldest)
            last_seen = max(event.created_at, last_seen)

            payload = _task_event_payload(
                event,
                task,
                deps_map=deps_map,
                dep_status=dep_status,
                tag_state_by_task_id=tag_state_by_task_id,
                child_count_by_parent_id=child_count_by_parent_id,
                custom_field_values_by_task_id=custom_field_values_by_task_id,
            )
            yield {"event": "task", "data": json.dumps(payload)}
        await asyncio.sleep(2)


@router.get("/stream")
async def stream_tasks(
    request: Request,
    board: Board = BOARD_READ_DEP,
    _actor: ActorContext = ACTOR_DEP,
    since: str | None = SINCE_QUERY,
) -> EventSourceResponse:
    """Stream task and task-comment events as SSE payloads."""
    since_dt = _parse_since(since) or utcnow()
    return EventSourceResponse(
        _task_event_generator(
            request=request,
            board_id=board.id,
            since_dt=since_dt,
        ),
        ping=15,
    )


@router.get("", response_model=DefaultLimitOffsetPage[TaskRead])
async def list_tasks(
    status_filter: str | None = STATUS_QUERY,
    assigned_agent_id: UUID | None = None,
    unassigned: bool | None = None,
    board: Board = BOARD_READ_DEP,
    session: AsyncSession = SESSION_DEP,
    _actor: ActorContext = ACTOR_DEP,
) -> LimitOffsetPage[TaskRead]:
    """List board tasks with optional status and assignment filters."""
    statement = _task_list_statement(
        board_id=board.id,
        status_filter=status_filter,
        assigned_agent_id=assigned_agent_id,
        unassigned=unassigned,
    )

    async def _transform(items: Sequence[object]) -> Sequence[object]:
        tasks = _coerce_task_items(items)
        return await _task_read_page(
            session=session,
            board_id=board.id,
            tasks=tasks,
        )

    return await paginate(session, statement, transformer=_transform)


@router.post("", response_model=TaskRead, responses={409: {"model": BlockedTaskError}})
async def create_task(
    payload: TaskCreate,
    board: Board = BOARD_WRITE_DEP,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = USER_AUTH_DEP,
) -> TaskRead:
    """Create a task and initialize dependency rows."""
    data = payload.model_dump(
        exclude={"depends_on_task_ids", "tag_ids", "custom_field_values"},
    )
    depends_on_task_ids = list(payload.depends_on_task_ids)
    tag_ids = list(payload.tag_ids)
    custom_field_values = dict(payload.custom_field_values)

    task = Task.model_validate(data)
    task.board_id = board.id
    if task.created_by_user_id is None and auth.user is not None:
        task.created_by_user_id = auth.user.id
    task.parent_task_id = await validate_parent_task_update(
        session,
        board_id=board.id,
        task_id=task.id,
        parent_task_id=task.parent_task_id,
    )
    await _validate_assigned_agent_for_task(
        session,
        task_board_id=board.id,
        assigned_agent_id=task.assigned_agent_id,
    )

    normalized_deps = await validate_dependency_update(
        session,
        board_id=board.id,
        task_id=task.id,
        depends_on_task_ids=depends_on_task_ids,
    )
    normalized_tag_ids = await validate_tag_ids(
        session,
        organization_id=board.organization_id,
        tag_ids=tag_ids,
    )
    dep_status = await dependency_status_by_id(
        session,
        board_id=board.id,
        dependency_ids=normalized_deps,
    )
    blocked_by = blocked_by_dependency_ids(
        dependency_ids=normalized_deps,
        status_by_id=dep_status,
    )
    if blocked_by and (task.assigned_agent_id is not None or task.status != "inbox"):
        raise _blocked_task_error(blocked_by)
    session.add(task)
    # Ensure the task exists in the DB before inserting dependency rows.
    await session.flush()
    await _set_task_custom_field_values_for_create(
        session,
        board_id=board.id,
        task_id=task.id,
        custom_field_values=custom_field_values,
    )
    for dep_id in normalized_deps:
        session.add(
            TaskDependency(
                board_id=board.id,
                task_id=task.id,
                depends_on_task_id=dep_id,
            ),
        )
    await replace_tags(
        session,
        task_id=task.id,
        tag_ids=normalized_tag_ids,
    )
    await session.commit()
    await session.refresh(task)

    record_activity(
        session,
        event_type="task.created",
        task_id=task.id,
        message=f"Task created: {task.title}.",
        board_id=board.id,
    )
    await session.commit()
    await _notify_lead_on_task_create(session=session, board=board, task=task)
    if task.assigned_agent_id:
        assigned_agent = await Agent.objects.by_id(task.assigned_agent_id).first(
            session,
        )
        if assigned_agent:
            await _notify_agent_on_task_assign(
                session=session,
                board=board,
                task=task,
                agent=assigned_agent,
            )
    await _reconcile_presence_after_task_change(session, board_id=board.id)
    return await _task_read_response(
        session,
        task=task,
        board_id=board.id,
    )


@router.patch(
    "/{task_id}",
    response_model=TaskRead,
    responses={409: {"model": BlockedTaskError}},
)
async def update_task(
    payload: TaskUpdate,
    task: Task = TASK_DEP,
    session: AsyncSession = SESSION_DEP,
    actor: ActorContext = ACTOR_DEP,
) -> TaskRead:
    """Update task status, assignment, comment, and dependency state."""
    if task.board_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Task board_id is required.",
        )
    board_id = task.board_id
    if actor.actor_type == "user" and actor.user is not None:
        await _require_task_user_write_access(
            session,
            board_id=board_id,
            user=actor.user,
        )
    previous_status = task.status
    previous_assigned = task.assigned_agent_id
    updates = payload.model_dump(exclude_unset=True)
    comment = payload.comment if "comment" in payload.model_fields_set else None
    depends_on_task_ids = (
        payload.depends_on_task_ids if "depends_on_task_ids" in payload.model_fields_set else None
    )
    tag_ids = payload.tag_ids if "tag_ids" in payload.model_fields_set else None
    custom_field_values = (
        payload.custom_field_values if "custom_field_values" in payload.model_fields_set else None
    )
    custom_field_values_set = "custom_field_values" in payload.model_fields_set
    updates.pop("comment", None)
    updates.pop("depends_on_task_ids", None)
    updates.pop("tag_ids", None)
    updates.pop("custom_field_values", None)
    requested_status = payload.status if "status" in payload.model_fields_set else None
    update = _TaskUpdateInput(
        task=task,
        actor=actor,
        board_id=board_id,
        previous_status=previous_status,
        previous_assigned=previous_assigned,
        previous_in_progress_at=task.in_progress_at,
        status_requested=(requested_status is not None and requested_status != previous_status),
        updates=updates,
        comment=comment,
        depends_on_task_ids=depends_on_task_ids,
        tag_ids=tag_ids,
        custom_field_values=custom_field_values or {},
        custom_field_values_set=custom_field_values_set,
    )
    if actor.actor_type == "agent" and _is_task_coordinator_agent(actor.agent):
        return await _apply_lead_task_update(session, update=update)

    if actor.actor_type == "agent":
        await _apply_non_lead_agent_task_rules(session, update=update)
    else:
        await _apply_admin_task_rules(session, update=update)
    return await _finalize_updated_task(
        session,
        update=update,
    )


async def delete_task_and_related_records(
    session: AsyncSession,
    *,
    task: Task,
) -> None:
    """Delete a task and associated relational records, then commit."""
    anchor_board_id = task.board_id
    child_rows = list(
        await session.exec(
            select(Task).where(col(Task.parent_task_id) == task.id),
        ),
    )
    for child in child_rows:
        child.parent_task_id = None
        child.updated_at = utcnow()
        session.add(child)
    await crud.delete_where(
        session,
        ActivityEvent,
        col(ActivityEvent.task_id) == task.id,
        commit=False,
    )
    await crud.delete_where(
        session,
        TaskFingerprint,
        col(TaskFingerprint.task_id) == task.id,
        commit=False,
    )

    primary_approvals = list(
        await Approval.objects.filter(col(Approval.task_id) == task.id).all(session),
    )
    await crud.delete_where(
        session,
        ApprovalTaskLink,
        col(ApprovalTaskLink.task_id) == task.id,
        commit=False,
    )
    if primary_approvals:
        primary_ids = [approval.id for approval in primary_approvals]
        remaining_by_approval = await load_task_ids_by_approval(session, approval_ids=primary_ids)
        for approval in primary_approvals:
            remaining_task_ids = remaining_by_approval.get(approval.id, [])
            if remaining_task_ids:
                approval.task_id = remaining_task_ids[0]
                session.add(approval)
                continue
            await session.delete(approval)
    await crud.delete_where(
        session,
        TaskDependency,
        or_(
            col(TaskDependency.task_id) == task.id,
            col(TaskDependency.depends_on_task_id) == task.id,
        ),
        commit=False,
    )
    await crud.delete_where(
        session,
        TagAssignment,
        col(TagAssignment.task_id) == task.id,
        commit=False,
    )
    await crud.delete_where(
        session,
        TaskCustomFieldValue,
        col(TaskCustomFieldValue.task_id) == task.id,
        commit=False,
    )
    await session.delete(task)
    await session.commit()
    if anchor_board_id is not None:
        await _reconcile_presence_after_task_change(session, board_id=anchor_board_id)


@router.delete("/{task_id}", response_model=OkResponse)
async def delete_task(
    session: AsyncSession = SESSION_DEP,
    task: Task = TASK_DEP,
    auth: AuthContext = USER_AUTH_DEP,
) -> OkResponse:
    """Delete a task and related records."""
    if task.board_id is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT)
    board = await Board.objects.by_id(task.board_id).first(session)
    if board is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    if auth.user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    await require_board_access(session, user=auth.user, board=board, write=True)
    await delete_task_and_related_records(session, task=task)
    return OkResponse()


@router.get(
    "/{task_id}/comments",
    response_model=DefaultLimitOffsetPage[TaskCommentRead],
)
async def list_task_comments(
    task: Task = TASK_DEP,
    session: AsyncSession = SESSION_DEP,
) -> LimitOffsetPage[TaskCommentRead]:
    """List comments for a task in chronological order."""
    statement = (
        select(ActivityEvent)
        .where(col(ActivityEvent.task_id) == task.id)
        .where(col(ActivityEvent.event_type) == "task.comment")
        .order_by(asc(col(ActivityEvent.created_at)))
    )
    return await paginate(session, statement)


async def _validate_task_comment_access(
    session: AsyncSession,
    *,
    task: Task,
    actor: ActorContext,
) -> None:
    if task.board_id is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT)

    if actor.actor_type == "user" and actor.user is not None:
        board = await Board.objects.by_id(task.board_id).first(session)
        if board is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
        await require_board_access(session, user=actor.user, board=board, write=True)

    if (
        actor.actor_type == "agent"
        and actor.agent
        and actor.agent.is_board_lead
        and task.status != "review"
        and not await _lead_was_mentioned(session, task, actor.agent)
        and not _lead_created_task(task, actor.agent)
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Board leads can only comment during review, when mentioned, "
                "or on tasks they created."
            ),
        )


def _comment_actor_id(actor: ActorContext) -> UUID | None:
    if actor.actor_type == "agent" and actor.agent:
        return actor.agent.id
    return None


def _comment_actor_name(actor: ActorContext) -> str:
    if actor.actor_type == "agent" and actor.agent:
        return actor.agent.name
    return "User"


async def _comment_targets(
    session: AsyncSession,
    *,
    task: Task,
    message: str,
    actor: ActorContext,
) -> tuple[dict[UUID, Agent], set[str]]:
    mention_names = extract_mentions(message)
    targets: dict[UUID, Agent] = {}
    if mention_names and task.board_id:
        scope_board_ids = await board_scope_board_ids(session, board_id=task.board_id)
        for agent in await Agent.objects.by_field_in("board_id", scope_board_ids).all(
            session,
        ):
            if matches_agent_mention(agent, mention_names):
                targets[agent.id] = agent
    if not mention_names and task.assigned_agent_id:
        assigned_agent = await Agent.objects.by_id(task.assigned_agent_id).first(
            session,
        )
        if assigned_agent:
            targets[assigned_agent.id] = assigned_agent

    if (
        actor.actor_type == "agent"
        and actor.agent
        and _is_task_coordinator_agent(actor.agent)
        and task.board_id is not None
        and task.status == "review"
    ):
        previous_worker_id = await _last_worker_who_moved_task_to_review(
            session,
            task_id=task.id,
            board_id=task.board_id,
            lead_agent_id=actor.agent.id,
        )
        if previous_worker_id is not None:
            previous_worker = await Agent.objects.by_id(previous_worker_id).first(session)
            if previous_worker is not None:
                targets[previous_worker.id] = previous_worker

    if (
        actor.actor_type == "agent"
        and actor.agent
        and task.board_id is not None
        and not actor.agent.is_board_lead
    ):
        scope_lead = await resolve_scope_lead(session, board_id=task.board_id)
        if scope_lead is not None:
            targets[scope_lead.id] = scope_lead

    if actor.actor_type == "agent" and actor.agent:
        targets.pop(actor.agent.id, None)
    return targets, mention_names


@dataclass(frozen=True, slots=True)
class _TaskCommentNotifyRequest:
    task: Task
    actor: ActorContext
    message: str
    targets: dict[UUID, Agent]
    mention_names: set[str]


async def _notify_task_comment_targets(
    session: AsyncSession,
    *,
    request: _TaskCommentNotifyRequest,
) -> None:
    if not request.targets:
        return
    board = (
        await Board.objects.by_id(request.task.board_id).first(session)
        if request.task.board_id
        else None
    )
    if board is None:
        return
    dispatch = GatewayDispatchService(session)
    config = await dispatch.optional_gateway_config_for_board(board)
    if not config:
        return

    snippet = _truncate_snippet(request.message)
    actor_name = _comment_actor_name(request.actor)
    for agent in request.targets.values():
        if not agent.openclaw_session_id:
            continue
        mentioned = matches_agent_mention(agent, request.mention_names)
        if agent.is_board_lead:
            await _wake_agent_online_for_task(
                session=session,
                board=board,
                task=request.task,
                agent=agent,
                reason="task_comment",
            )
            header = "LEAD TASK MENTION" if mentioned else "LEAD TASK UPDATE"
            action_line = (
                "You were mentioned in this task comment."
                if mentioned
                else "A downstream task comment needs lead attention."
            )
            notification = (
                f"{header}\n"
                f"Board: {board.name}\n"
                f"Task: {request.task.title}\n"
                f"Task ID: {request.task.id}\n"
                f"From: {actor_name}\n\n"
                f"{action_line}\n\n"
                f"Comment:\n{snippet}\n\n"
                "Take action now:\n"
                "1. Review the thread and current task state.\n"
                "2. Record the ruling or blocker in task comments.\n"
                "3. Route the next concrete step if execution should continue."
            )
            await _send_lead_task_message_compat(
                dispatch=dispatch,
                session_key=agent.openclaw_session_id,
                config=config,
                message=notification,
                deliver=True,
            )
            continue
        header = "TASK MENTION" if mentioned else "NEW TASK COMMENT"
        action_line = (
            "You were mentioned in this comment."
            if mentioned
            else "A new comment was posted on your task."
        )
        notification = (
            f"{header}\n"
            f"Board: {board.name}\n"
            f"Task: {request.task.title}\n"
            f"Task ID: {request.task.id}\n"
            f"From: {actor_name}\n\n"
            f"{action_line}\n\n"
            f"Comment:\n{snippet}\n\n"
            "If you are mentioned but not assigned, reply in the task "
            "thread but do not change task status."
        )
        await _send_agent_task_message(
            dispatch=dispatch,
            session_key=agent.openclaw_session_id,
            config=config,
            agent_name=agent.name,
            message=notification,
            deliver=True,
        )


def _downstream_outcome_state(
    *, board: Board, task: Task, actor: ActorContext, message: str
) -> str | None:
    if actor.actor_type != "agent" or actor.agent is None or actor.agent.is_board_lead:
        return None
    if task.assigned_agent_id != actor.agent.id:
        return None
    if board.slug not in {"review", "security-review"}:
        return None

    normalized = " ".join(message.lower().split())
    cleared_patterns = (
        "final code-level review pass",
        "final review pass",
        "no further review findings",
        "no further findings",
        "no further code changes are requested",
        "review blocker as cleared",
        "review blocker is cleared",
        "review blocker as closed",
        "security blocker as closed",
        "security blocker is closed",
        "no residual issue",
        "issue from this review as resolved",
        "treat the review blocker as cleared",
    )
    changes_requested_patterns = (
        "concrete code-level issue",
        "concrete review blocker",
        "would not call this review clean",
        "requested changes",
        "changes requested",
        "remaining blocker",
        "still cannot make a code-level review call",
        "defect",
    )

    if any(pattern in normalized for pattern in cleared_patterns):
        return "cleared"
    if any(pattern in normalized for pattern in changes_requested_patterns):
        return "changes_requested"
    return None


def _extract_task_reference_ids(*values: str | None) -> list[UUID]:
    reference_ids: list[UUID] = []
    seen: set[UUID] = set()
    for value in values:
        if not value:
            continue
        for match in TASK_REFERENCE_RE.findall(value):
            try:
                task_id = UUID(match)
            except ValueError:
                continue
            if task_id in seen:
                continue
            seen.add(task_id)
            reference_ids.append(task_id)
    return reference_ids


async def _referenced_scope_tasks_for_task(
    session: AsyncSession,
    *,
    task: Task,
) -> tuple[list[Task], list[Task], dict[UUID, str]]:
    if task.board_id is None:
        return [], [], {}
    reference_ids = _extract_task_reference_ids(task.title, task.description)
    reference_ids = [task_id for task_id in reference_ids if task_id != task.id]
    if not reference_ids:
        return [], [], {}

    scope_board_ids = await board_scope_board_ids(session, board_id=task.board_id)
    if not scope_board_ids:
        return [], [], {}

    referenced = list(
        await session.exec(
            select(Task).where(
                col(Task.id).in_(reference_ids),
                col(Task.board_id).in_(scope_board_ids),
            ),
        ),
    )
    open_referenced = [item for item in referenced if item.status != "done"]

    dependent_ids: list[UUID] = []
    if open_referenced:
        dependent_ids = list(
            {
                *await session.exec(
                    select(col(TaskDependency.task_id)).where(
                        col(TaskDependency.depends_on_task_id).in_(
                            [item.id for item in open_referenced],
                        ),
                    ),
                ),
            },
        )

    dependents: list[Task] = []
    if dependent_ids:
        dependents = list(
            await session.exec(
                select(Task).where(
                    col(Task.id).in_(dependent_ids),
                    col(Task.board_id).in_(scope_board_ids),
                    col(Task.status) != "done",
                ),
            ),
        )

    board_ids = {
        *(item.board_id for item in open_referenced if item.board_id is not None),
        *(item.board_id for item in dependents if item.board_id is not None),
    }
    board_name_by_id: dict[UUID, str] = {}
    if board_ids:
        boards = await Board.objects.by_ids(list(board_ids)).all(session)
        board_name_by_id = {item.id: item.name for item in boards}
    return open_referenced, dependents, board_name_by_id


def _format_referenced_task_lines(
    tasks: list[Task],
    *,
    board_name_by_id: dict[UUID, str],
) -> list[str]:
    lines: list[str] = []
    for item in tasks:
        board_name = board_name_by_id.get(item.board_id) if item.board_id is not None else None
        board_prefix = f"[{board_name}] " if board_name else ""
        lines.append(f"- {board_prefix}{item.title} ({item.id}) status={item.status}")
    return lines


async def _notify_scope_lead_on_downstream_outcome(
    session: AsyncSession,
    *,
    task: Task,
    actor: ActorContext,
    message: str,
) -> None:
    if task.board_id is None:
        return
    board = await Board.objects.by_id(task.board_id).first(session)
    if board is None:
        return

    outcome = _downstream_outcome_state(
        board=board,
        task=task,
        actor=actor,
        message=message,
    )
    if outcome is None:
        return

    lead = await resolve_scope_lead(session, board_id=board.id)
    if lead is None or not lead.openclaw_session_id:
        return
    if actor.actor_type == "agent" and actor.agent and lead.id == actor.agent.id:
        return

    dispatch = GatewayDispatchService(session)
    config = await dispatch.optional_gateway_config_for_board(board)
    if config is None:
        return

    await _wake_agent_online_for_task(
        session=session,
        board=board,
        task=task,
        agent=lead,
        reason=f"{board.slug}_outcome",
    )

    outcome_label = "cleared" if outcome == "cleared" else "needs changes"
    header_prefix = "SECURITY" if board.slug == "security-review" else "REVIEW"
    snippet = _truncate_snippet(message)
    open_referenced, dependent_tasks, board_name_by_id = await _referenced_scope_tasks_for_task(
        session,
        task=task,
    )
    reconciliation_context = ""
    action = (
        "Take action now:\n"
        "1. Acknowledge the downstream clearance on the task thread.\n"
        "2. Close or advance the current slice according to board rules.\n"
        "3. If this accepted slice satisfies any referenced prerequisite task, record the ruling there, request/create any required approval, and close it instead of leaving it in inbox.\n"
        "4. If that unblocks a dependent task, route that newly unblocked task next.\n"
        "5. Only create a fresh Builder implementation slice if a residual implementation gap remains."
        if outcome == "cleared"
        else "Take action now:\n"
        "1. Read the blocker details on the downstream task thread.\n"
        "2. Route the exact requested changes back to the implementation worker.\n"
        "3. Keep the current slice visible until the blocker is cleared."
    )
    if outcome == "cleared" and open_referenced:
        reconciliation_lines = [
            "Open referenced prerequisite tasks:",
            *_format_referenced_task_lines(
                open_referenced,
                board_name_by_id=board_name_by_id,
            ),
        ]
        if dependent_tasks:
            reconciliation_lines.extend(
                [
                    "",
                    "Open dependent tasks still waiting on those prerequisites:",
                    *_format_referenced_task_lines(
                        dependent_tasks,
                        board_name_by_id=board_name_by_id,
                    ),
                ],
            )
        reconciliation_context = "\n\nCurrent scope reconciliation context:\n" + "\n".join(
            reconciliation_lines,
        )
    notification = (
        f"{header_prefix} OUTCOME: {outcome_label.upper()}\n"
        f"Board: {board.name}\n"
        f"Task: {task.title}\n"
        f"Task ID: {task.id}\n"
        f"From: {_comment_actor_name(actor)}\n\n"
        f"Latest downstream outcome comment:\n{snippet}\n\n"
        f"{reconciliation_context}"
        f"{'' if not reconciliation_context else chr(10) + chr(10)}"
        f"{action}"
    )
    error = await _send_lead_task_message_compat(
        dispatch=dispatch,
        session_key=lead.openclaw_session_id,
        config=config,
        message=notification,
        deliver=True,
    )
    if error is None:
        record_activity(
            session,
            event_type="task.downstream_outcome_notified",
            message=f"Lead notified about downstream {outcome_label}: {task.title}.",
            agent_id=lead.id,
            task_id=task.id,
            board_id=board.id,
        )
    else:
        record_activity(
            session,
            event_type="task.downstream_outcome_notify_failed",
            message=f"Downstream outcome notify failed: {error}",
            agent_id=lead.id,
            task_id=task.id,
            board_id=board.id,
        )
    await session.commit()


@dataclass(slots=True)
class _TaskUpdateInput:
    task: Task
    actor: ActorContext
    board_id: UUID
    previous_status: str
    previous_assigned: UUID | None
    status_requested: bool
    updates: dict[str, object]
    comment: str | None
    depends_on_task_ids: list[UUID] | None
    tag_ids: list[UUID] | None
    custom_field_values: TaskCustomFieldValues
    custom_field_values_set: bool
    previous_in_progress_at: datetime | None = None
    normalized_tag_ids: list[UUID] | None = None


def _required_status_value(value: object) -> str:
    if isinstance(value, str):
        return value
    raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT)


def _optional_assigned_agent_id(value: object) -> UUID | None:
    if value is None or isinstance(value, UUID):
        return value
    raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT)


async def _board_organization_id(
    session: AsyncSession,
    *,
    board_id: UUID,
) -> UUID:
    organization_id = (
        await session.exec(
            select(Board.organization_id).where(col(Board.id) == board_id),
        )
    ).first()
    if organization_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    return organization_id


async def _task_dep_ids(
    session: AsyncSession,
    *,
    board_id: UUID,
    task_id: UUID,
) -> list[UUID]:
    deps_map = await dependency_ids_by_task_id(
        session,
        board_id=board_id,
        task_ids=[task_id],
    )
    return deps_map.get(task_id, [])


async def _task_blocked_ids(
    session: AsyncSession,
    *,
    board_id: UUID,
    dep_ids: Sequence[UUID],
) -> list[UUID]:
    if not dep_ids:
        return []
    dep_status = await dependency_status_by_id(
        session,
        board_id=board_id,
        dependency_ids=list(dep_ids),
    )
    return blocked_by_dependency_ids(
        dependency_ids=list(dep_ids),
        status_by_id=dep_status,
    )


async def _task_read_response(
    session: AsyncSession,
    *,
    task: Task,
    board_id: UUID,
) -> TaskRead:
    dep_ids = await _task_dep_ids(session, board_id=board_id, task_id=task.id)
    tag_state = (await load_tag_state(session, task_ids=[task.id])).get(
        task.id,
        TagState(),
    )
    blocked_ids = await _task_blocked_ids(
        session,
        board_id=board_id,
        dep_ids=dep_ids,
    )
    custom_field_values_by_task_id = await _task_custom_field_values_by_task_id(
        session,
        board_id=board_id,
        task_ids=[task.id],
    )
    child_count_by_parent_id = await child_counts_by_parent_id(
        session,
        parent_ids=[task.id],
    )
    if task.status == "done":
        blocked_ids = []
    return TaskRead.model_validate(task, from_attributes=True).model_copy(
        update={
            "depends_on_task_ids": dep_ids,
            "child_count": child_count_by_parent_id.get(task.id, 0),
            "tag_ids": tag_state.tag_ids,
            "tags": tag_state.tags,
            "blocked_by_task_ids": blocked_ids,
            "is_blocked": bool(blocked_ids),
            "custom_field_values": custom_field_values_by_task_id.get(task.id, {}),
        },
    )


async def _require_task_user_write_access(
    session: AsyncSession,
    *,
    board_id: UUID,
    user: User | None,
) -> None:
    board = await Board.objects.by_id(board_id).first(session)
    if board is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    await require_board_access(session, user=user, board=board, write=True)


def _is_task_coordinator_agent(agent: Agent | None) -> bool:
    return bool(agent and (agent.is_board_lead or agent.board_id is None))


def _lead_requested_fields(update: _TaskUpdateInput) -> set[str]:
    requested_fields = set(update.updates)
    if update.comment is not None:
        requested_fields.add("comment")
    if update.depends_on_task_ids is not None:
        requested_fields.add("depends_on_task_ids")
    if update.tag_ids is not None:
        requested_fields.add("tag_ids")
    if update.custom_field_values_set:
        requested_fields.add("custom_field_values")
    return requested_fields


def _validate_lead_update_request(update: _TaskUpdateInput) -> None:
    allowed_fields = {
        "title",
        "description",
        "priority",
        "due_at",
        "parent_task_id",
        "assigned_agent_id",
        "status",
        "comment",
        "depends_on_task_ids",
        "tag_ids",
        "custom_field_values",
    }
    requested_fields = _lead_requested_fields(update)
    disallowed_fields = requested_fields - allowed_fields
    if disallowed_fields:
        disallowed = ", ".join(sorted(disallowed_fields))
        allowed = ", ".join(sorted(allowed_fields))
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Lead field gate failed: unsupported fields for board leads: "
                f"{disallowed}. Allowed fields: {allowed}."
            ),
        )


async def _lead_effective_dependencies(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> tuple[list[UUID], list[UUID]]:
    # Use newly normalized dependency updates when supplied; otherwise fall back
    # to the task's current dependencies for blocked-by evaluation.
    normalized_deps: list[UUID] | None = None
    if update.depends_on_task_ids is not None:
        if update.task.status == "done":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=("Cannot change task dependencies after a task is done."),
            )
        normalized_deps = await replace_task_dependencies(
            session,
            board_id=update.board_id,
            task_id=update.task.id,
            depends_on_task_ids=update.depends_on_task_ids,
        )
    effective_deps = (
        normalized_deps
        if normalized_deps is not None
        else await _task_dep_ids(
            session,
            board_id=update.board_id,
            task_id=update.task.id,
        )
    )
    blocked_by = await _task_blocked_ids(
        session,
        board_id=update.board_id,
        dep_ids=effective_deps,
    )
    return effective_deps, blocked_by


async def _apply_parent_task_update(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> None:
    if "parent_task_id" not in update.updates:
        return
    update.updates["parent_task_id"] = await validate_parent_task_update(
        session,
        board_id=update.board_id,
        task_id=update.task.id,
        parent_task_id=_optional_assigned_agent_id(update.updates["parent_task_id"]),
    )


async def _normalized_update_tag_ids(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> list[UUID] | None:
    if update.tag_ids is None:
        return None
    organization_id = await _board_organization_id(
        session,
        board_id=update.board_id,
    )
    return await validate_tag_ids(
        session,
        organization_id=organization_id,
        tag_ids=update.tag_ids,
    )


async def _lead_apply_assignment(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> None:
    if "assigned_agent_id" not in update.updates:
        return
    assigned_id = _optional_assigned_agent_id(update.updates["assigned_agent_id"])
    if not assigned_id:
        update.task.assigned_agent_id = None
        return
    agent = await _validate_assigned_agent_for_task(
        session,
        task_board_id=update.board_id,
        assigned_agent_id=assigned_id,
    )
    update.task.assigned_agent_id = agent.id if agent is not None else None


async def _last_worker_who_moved_task_to_review(
    session: AsyncSession,
    *,
    task_id: UUID,
    board_id: UUID,
    lead_agent_id: UUID,
) -> UUID | None:
    statement = (
        select(col(ActivityEvent.agent_id))
        .where(col(ActivityEvent.task_id) == task_id)
        .where(col(ActivityEvent.event_type) == "task.status_changed")
        .where(col(ActivityEvent.message).like("Task moved to review:%"))
        .where(col(ActivityEvent.agent_id).is_not(None))
        .order_by(desc(col(ActivityEvent.created_at)))
    )
    candidate_ids = list(await session.exec(statement))
    for candidate_id in candidate_ids:
        if candidate_id is None or candidate_id == lead_agent_id:
            continue
        candidate = await Agent.objects.by_id(candidate_id).first(session)
        if candidate is None:
            continue
        if (
            candidate.is_board_lead
            or candidate.board_id is None
            or not await board_ids_share_scope(
                session,
                anchor_board_id=board_id,
                candidate_board_id=candidate.board_id,
            )
        ):
            continue
        return candidate.id
    return None


async def _lead_apply_status(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> None:
    if update.actor.actor_type != "agent" or update.actor.agent is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)
    lead_agent = update.actor.agent
    if "status" not in update.updates:
        return
    target_status = _required_status_value(update.updates["status"])
    if target_status == "inbox":
        update.task.assigned_agent_id = await _last_worker_who_moved_task_to_review(
            session,
            task_id=update.task.id,
            board_id=update.board_id,
            lead_agent_id=lead_agent.id,
        )
        update.task.previous_in_progress_at = update.task.in_progress_at
        update.task.in_progress_at = None
    elif target_status == "review":
        update.task.previous_in_progress_at = update.task.in_progress_at
        update.task.assigned_agent_id = None
        update.task.in_progress_at = None
    elif target_status == "in_progress":
        effective_assignee_id = update.task.assigned_agent_id
        if "assigned_agent_id" in update.updates:
            effective_assignee_id = _optional_assigned_agent_id(
                update.updates["assigned_agent_id"],
            )
        if effective_assignee_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Lead status gate failed: `in_progress` requires an assigned agent.",
            )
        update.task.in_progress_at = utcnow()
    elif target_status == "done":
        update.task.previous_in_progress_at = update.task.in_progress_at
        update.task.in_progress_at = None
    update.task.status = target_status


def _task_event_details(task: Task, previous_status: str) -> tuple[str, str]:
    if task.status != previous_status:
        return "task.status_changed", f"Task moved to {task.status}: {task.title}."
    return "task.updated", f"Task updated: {task.title}."


async def _lead_notify_new_assignee(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> None:
    if (
        not update.task.assigned_agent_id
        or update.task.assigned_agent_id == update.previous_assigned
    ):
        return
    assigned_agent = await Agent.objects.by_id(update.task.assigned_agent_id).first(
        session,
    )
    if assigned_agent is None:
        return
    board = (
        await Board.objects.by_id(update.task.board_id).first(session)
        if update.task.board_id
        else None
    )
    if board:
        if (
            update.previous_status == "review"
            and update.task.status == "inbox"
            and update.actor.actor_type == "agent"
            and update.actor.agent
            and _is_task_coordinator_agent(update.actor.agent)
        ):
            await _notify_agent_on_task_rework(
                session=session,
                board=board,
                task=update.task,
                agent=assigned_agent,
                lead=update.actor.agent,
            )
            return
        await _notify_agent_on_task_assign(
            session=session,
            board=board,
            task=update.task,
            agent=assigned_agent,
        )


async def _apply_lead_task_update(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> TaskRead:
    if update.actor.actor_type != "agent" or update.actor.agent is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)
    _validate_lead_update_request(update)
    await _apply_parent_task_update(session, update=update)
    for key, value in update.updates.items():
        if key in {"assigned_agent_id", "status"}:
            continue
        setattr(update.task, key, value)
    _effective_deps, blocked_by = await _lead_effective_dependencies(
        session,
        update=update,
    )
    normalized_tag_ids = await _normalized_update_tag_ids(
        session,
        update=update,
    )

    # Blocked tasks should not be silently rewritten into a "blocked-safe" state.
    # Instead, reject assignment/status transitions with an explicit 409 payload.
    if blocked_by:
        attempted_fields: set[str] = set(update.updates.keys())
        attempted_transition = (
            "assigned_agent_id" in attempted_fields or "status" in attempted_fields
        )
        if attempted_transition:
            raise _blocked_task_error(blocked_by)

    await _lead_apply_assignment(session, update=update)
    await _lead_apply_status(session, update=update)
    await _require_no_pending_approval_for_status_change_when_enabled(
        session,
        board_id=update.board_id,
        task_id=update.task.id,
        previous_status=update.previous_status,
        target_status=update.task.status,
        status_requested=update.status_requested,
    )
    await _require_review_before_done_when_enabled(
        session,
        board_id=update.board_id,
        previous_status=update.previous_status,
        target_status=update.task.status,
    )
    await _require_approved_linked_approval_for_done(
        session,
        board_id=update.board_id,
        task_id=update.task.id,
        previous_status=update.previous_status,
        target_status=update.task.status,
    )

    if normalized_tag_ids is not None:
        await replace_tags(
            session,
            task_id=update.task.id,
            tag_ids=normalized_tag_ids,
        )
    if update.custom_field_values_set:
        await _set_task_custom_field_values_for_update(
            session,
            board_id=update.board_id,
            task_id=update.task.id,
            custom_field_values=update.custom_field_values,
        )

    update.task.updated_at = utcnow()
    session.add(update.task)
    event_type, message = _task_event_details(update.task, update.previous_status)
    record_activity(
        session,
        event_type=event_type,
        task_id=update.task.id,
        message=message,
        agent_id=update.actor.agent.id,
        board_id=update.board_id,
    )
    await _reconcile_dependents_for_dependency_toggle(
        session,
        board_id=update.board_id,
        dependency_task=update.task,
        previous_status=update.previous_status,
        actor_agent_id=update.actor.agent.id,
    )
    await session.commit()
    await session.refresh(update.task)
    await _record_task_comment_from_update(session, update=update)
    await _lead_notify_new_assignee(session, update=update)
    await _reconcile_presence_after_task_change(session, board_id=update.board_id)
    return await _task_read_response(
        session,
        task=update.task,
        board_id=update.board_id,
    )


async def _apply_non_lead_agent_task_rules(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> None:
    if update.actor.actor_type != "agent":
        return
    if (
        update.actor.agent
        and update.actor.agent.board_id
        and update.task.board_id
        and update.actor.agent.board_id != update.task.board_id
        and update.task.assigned_agent_id != update.actor.agent.id
    ):
        raise _task_update_forbidden_error(
            code="task_board_mismatch",
            message="Agent can only update tasks for their assigned board.",
        )
    # Allow agents to claim unassigned tasks by updating status (when permitted by board rules).
    if (
        update.actor.agent
        and update.task.assigned_agent_id is not None
        and update.task.assigned_agent_id != update.actor.agent.id
        and "status" in update.updates
    ):
        raise _task_update_forbidden_error(
            code="task_assignee_mismatch",
            message="Agents can only change status on tasks assigned to them.",
        )
    # Agents are limited to status/comment updates, and non-inbox status moves
    # must pass dependency checks before they can proceed.
    allowed_fields = {"status", "comment", "custom_field_values"}
    if (
        update.depends_on_task_ids is not None
        or update.tag_ids is not None
        or not set(update.updates).issubset(
            allowed_fields,
        )
    ):
        raise _task_update_forbidden_error(
            code="task_update_field_forbidden",
            message="Agents may only update status, comment, and custom field values.",
        )
    if "status" in update.updates:
        only_lead_can_change_status = (
            await session.exec(
                select(col(Board.only_lead_can_change_status)).where(
                    col(Board.id) == update.board_id,
                ),
            )
        ).first()
        if only_lead_can_change_status:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only board leads can change task status.",
            )
        status_value = _required_status_value(update.updates["status"])
        if status_value != "inbox":
            dep_ids = await _task_dep_ids(
                session,
                board_id=update.board_id,
                task_id=update.task.id,
            )
            blocked_ids = await _task_blocked_ids(
                session,
                board_id=update.board_id,
                dep_ids=dep_ids,
            )
            if blocked_ids:
                raise _blocked_task_error(blocked_ids)
        if status_value == "inbox":
            update.task.assigned_agent_id = None
            update.task.previous_in_progress_at = update.task.in_progress_at
            update.task.in_progress_at = None
        elif status_value == "review":
            update.task.previous_in_progress_at = update.task.in_progress_at
            update.task.assigned_agent_id = None
            update.task.in_progress_at = None
        else:
            update.task.assigned_agent_id = update.actor.agent.id if update.actor.agent else None
            if status_value == "in_progress":
                update.task.in_progress_at = utcnow()


async def _apply_admin_task_rules(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> None:
    admin_normalized_deps: list[UUID] | None = None
    await _apply_parent_task_update(session, update=update)
    update.normalized_tag_ids = await _normalized_update_tag_ids(
        session,
        update=update,
    )
    if update.depends_on_task_ids is not None:
        if update.task.status == "done":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=("Cannot change task dependencies after a task is done."),
            )
        admin_normalized_deps = await replace_task_dependencies(
            session,
            board_id=update.board_id,
            task_id=update.task.id,
            depends_on_task_ids=update.depends_on_task_ids,
        )

    effective_deps = (
        admin_normalized_deps
        if admin_normalized_deps is not None
        else await _task_dep_ids(
            session,
            board_id=update.board_id,
            task_id=update.task.id,
        )
    )
    blocked_ids = await _task_blocked_ids(
        session,
        board_id=update.board_id,
        dep_ids=effective_deps,
    )
    target_status = _required_status_value(
        update.updates.get("status", update.task.status),
    )
    # Reset blocked tasks to inbox unless the task is already done and remains
    # done, which is the explicit done-task exception.
    if blocked_ids and not (update.task.status == "done" and target_status == "done"):
        update.task.status = "inbox"
        update.task.assigned_agent_id = None
        update.task.in_progress_at = None
        update.updates["status"] = "inbox"
        update.updates["assigned_agent_id"] = None

    if "status" in update.updates:
        status_value = _required_status_value(update.updates["status"])
        if status_value == "inbox":
            update.task.previous_in_progress_at = update.task.in_progress_at
            update.task.assigned_agent_id = None
            update.task.in_progress_at = None
        elif status_value == "review":
            update.task.previous_in_progress_at = update.task.in_progress_at
            update.task.assigned_agent_id = None
            update.task.in_progress_at = None
        elif status_value == "in_progress":
            update.task.in_progress_at = utcnow()

    assigned_agent_id = _optional_assigned_agent_id(
        update.updates.get("assigned_agent_id"),
    )
    if assigned_agent_id:
        await _validate_assigned_agent_for_task(
            session,
            task_board_id=update.board_id,
            assigned_agent_id=assigned_agent_id,
        )


async def _record_task_comment_from_update(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> None:
    if update.comment is None or not update.comment.strip():
        return
    message = update.comment.strip()
    event = ActivityEvent(
        event_type="task.comment",
        message=message,
        task_id=update.task.id,
        board_id=update.task.board_id,
        agent_id=(
            update.actor.agent.id
            if update.actor.actor_type == "agent" and update.actor.agent
            else None
        ),
    )
    session.add(event)
    await session.commit()
    targets, mention_names = await _comment_targets(
        session,
        task=update.task,
        message=message,
        actor=update.actor,
    )
    await _notify_task_comment_targets(
        session,
        request=_TaskCommentNotifyRequest(
            task=update.task,
            actor=update.actor,
            message=message,
            targets=targets,
            mention_names=mention_names,
        ),
    )
    await _notify_scope_lead_on_downstream_outcome(
        session,
        task=update.task,
        actor=update.actor,
        message=message,
    )


async def _record_task_update_activity(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> None:
    event_type, message = _task_event_details(update.task, update.previous_status)
    actor_agent_id = (
        update.actor.agent.id if update.actor.actor_type == "agent" and update.actor.agent else None
    )
    # Record the task transition first, then reconcile dependents so any
    # cascaded dependency effects are logged after the source change.
    record_activity(
        session,
        event_type=event_type,
        task_id=update.task.id,
        message=message,
        agent_id=actor_agent_id,
        board_id=update.board_id,
    )
    await _reconcile_dependents_for_dependency_toggle(
        session,
        board_id=update.board_id,
        dependency_task=update.task,
        previous_status=update.previous_status,
        actor_agent_id=actor_agent_id,
    )
    await session.commit()


async def _assign_review_task_to_lead(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> None:
    if update.task.status != "review" or update.previous_status == "review":
        return
    lead = await resolve_scope_lead(session, board_id=update.board_id)
    if lead is None:
        return
    update.task.assigned_agent_id = lead.id


async def _notify_task_update_assignment_changes(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> None:
    board: Board | None = None

    async def _board() -> Board | None:
        nonlocal board
        if board is None and update.task.board_id:
            board = await Board.objects.by_id(update.task.board_id).first(session)
        return board

    if (
        update.task.status == "inbox"
        and update.task.assigned_agent_id is None
        and (update.previous_status != "inbox" or update.previous_assigned is not None)
    ):
        current_board = await _board()
        if current_board:
            await _notify_lead_on_task_unassigned(
                session=session,
                board=current_board,
                task=update.task,
            )

    if not update.task.assigned_agent_id:
        return

    assigned_agent = await Agent.objects.by_id(update.task.assigned_agent_id).first(
        session,
    )
    if assigned_agent is None:
        return

    assignment_changed = update.task.assigned_agent_id != update.previous_assigned
    entered_in_progress = (
        update.task.status == "in_progress" and update.previous_status != "in_progress"
    )

    if entered_in_progress and not assignment_changed:
        current_board = await _board()
        if current_board:
            await _wake_agent_online_for_task(
                session=session,
                board=current_board,
                task=update.task,
                agent=assigned_agent,
                reason="status_in_progress",
            )

    if not assignment_changed:
        return

    if (
        update.previous_status == "review"
        and update.task.status == "inbox"
        and update.actor.actor_type == "agent"
        and update.actor.agent
        and _is_task_coordinator_agent(update.actor.agent)
    ):
        current_board = await _board()
        if current_board:
            await _notify_agent_on_task_rework(
                session=session,
                board=current_board,
                task=update.task,
                agent=assigned_agent,
                lead=update.actor.agent,
            )
        return

    if (
        update.actor.actor_type == "agent"
        and update.actor.agent
        and update.task.assigned_agent_id == update.actor.agent.id
    ):
        return

    current_board = await _board()
    if current_board:
        await _notify_agent_on_task_assign(
            session=session,
            board=current_board,
            task=update.task,
            agent=assigned_agent,
            wake_assignee=True,
        )


async def _finalize_updated_task(
    session: AsyncSession,
    *,
    update: _TaskUpdateInput,
) -> TaskRead:
    for key, value in update.updates.items():
        setattr(update.task, key, value)
    await _require_no_pending_approval_for_status_change_when_enabled(
        session,
        board_id=update.board_id,
        task_id=update.task.id,
        previous_status=update.previous_status,
        target_status=update.task.status,
        status_requested=update.status_requested,
    )
    await _require_review_before_done_when_enabled(
        session,
        board_id=update.board_id,
        previous_status=update.previous_status,
        target_status=update.task.status,
    )
    await _require_approved_linked_approval_for_done(
        session,
        board_id=update.board_id,
        task_id=update.task.id,
        previous_status=update.previous_status,
        target_status=update.task.status,
    )
    update.task.updated_at = utcnow()

    status_raw = update.updates.get("status")
    # Entering review can require a new comment or valid recent context when
    # the board-level rule is enabled.
    if status_raw == "review" and await _require_comment_for_review_when_enabled(
        session,
        board_id=update.board_id,
    ):
        comment_text = (update.comment or "").strip()
        review_comment_author = update.task.assigned_agent_id or update.previous_assigned
        review_comment_since = (
            update.task.previous_in_progress_at
            if update.task.previous_in_progress_at is not None
            else update.previous_in_progress_at
        )
        if not comment_text and not await has_valid_recent_comment(
            session,
            update.task,
            review_comment_author,
            review_comment_since,
        ):
            raise _comment_validation_error()
    await _assign_review_task_to_lead(session, update=update)

    if update.tag_ids is not None:
        normalized = (
            update.normalized_tag_ids
            if update.normalized_tag_ids is not None
            else await _normalized_update_tag_ids(
                session,
                update=update,
            )
        )
        await replace_tags(
            session,
            task_id=update.task.id,
            tag_ids=normalized or [],
        )

    if update.custom_field_values_set:
        await _set_task_custom_field_values_for_update(
            session,
            board_id=update.board_id,
            task_id=update.task.id,
            custom_field_values=update.custom_field_values,
        )

    session.add(update.task)
    await session.commit()
    await session.refresh(update.task)
    await _record_task_comment_from_update(session, update=update)
    await _record_task_update_activity(session, update=update)
    await _notify_task_update_assignment_changes(session, update=update)
    await _reconcile_presence_after_task_change(session, board_id=update.board_id)

    return await _task_read_response(
        session,
        task=update.task,
        board_id=update.board_id,
    )


@router.post("/{task_id}/comments", response_model=TaskCommentRead)
async def create_task_comment(
    payload: TaskCommentCreate,
    task: Task = TASK_DEP,
    session: AsyncSession = SESSION_DEP,
    actor: ActorContext = ACTOR_DEP,
) -> ActivityEvent:
    """Create a task comment and notify relevant agents."""
    await _validate_task_comment_access(session, task=task, actor=actor)
    event = ActivityEvent(
        event_type="task.comment",
        message=payload.message,
        task_id=task.id,
        board_id=task.board_id,
        agent_id=_comment_actor_id(actor),
    )
    session.add(event)
    await session.commit()
    await session.refresh(event)
    targets, mention_names = await _comment_targets(
        session,
        task=task,
        message=payload.message,
        actor=actor,
    )
    await _notify_task_comment_targets(
        session,
        request=_TaskCommentNotifyRequest(
            task=task,
            actor=actor,
            message=payload.message,
            targets=targets,
            mention_names=mention_names,
        ),
    )
    await _notify_scope_lead_on_downstream_outcome(
        session,
        task=task,
        actor=actor,
        message=payload.message,
    )
    return event
