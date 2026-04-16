"""Validation and query helpers for parent/child task hierarchies."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from uuid import UUID

from fastapi import HTTPException, status
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.tasks import Task
from app.services.task_scope import board_ids_share_scope


async def child_counts_by_parent_id(
    session: AsyncSession,
    *,
    parent_ids: Sequence[UUID],
) -> dict[UUID, int]:
    """Return direct child counts keyed by parent task id."""
    if not parent_ids:
        return {}
    rows = list(
        await session.exec(
            select(col(Task.parent_task_id), col(Task.id))
            .where(col(Task.parent_task_id).in_(parent_ids)),
        ),
    )
    counts: dict[UUID, int] = defaultdict(int)
    for parent_task_id, _task_id in rows:
        if parent_task_id is None:
            continue
        counts[parent_task_id] += 1
    return dict(counts)


async def validate_parent_task_update(
    session: AsyncSession,
    *,
    board_id: UUID,
    task_id: UUID,
    parent_task_id: UUID | None,
) -> UUID | None:
    """Validate a parent-task update and return the normalized parent id."""
    if parent_task_id is None:
        return None
    if parent_task_id == task_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Task cannot be its own parent.",
        )

    parent_row = (
        await session.exec(
            select(col(Task.id), col(Task.board_id), col(Task.parent_task_id)).where(
                col(Task.id) == parent_task_id,
            ),
        )
    ).first()
    if parent_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Parent task was not found.",
        )
    _parent_id, parent_board_id, current_parent_id = parent_row
    if parent_board_id is None or not await board_ids_share_scope(
        session,
        anchor_board_id=board_id,
        candidate_board_id=parent_board_id,
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Parent task is not in the same board scope.",
        )

    visited = {task_id}
    next_parent_id = parent_task_id
    while next_parent_id is not None:
        if next_parent_id in visited:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Task hierarchy cycle detected. Remove the cycle before saving.",
            )
        visited.add(next_parent_id)
        if next_parent_id == parent_task_id:
            next_parent_id = current_parent_id
            continue
        next_parent_id = (
            await session.exec(
                select(col(Task.parent_task_id)).where(col(Task.id) == next_parent_id),
            )
        ).first()

    return parent_task_id

