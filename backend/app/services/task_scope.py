"""Helpers for board-group-aware task scope and orchestration checks."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import case, func
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.agents import Agent
from app.models.boards import Board


async def board_scope_board_ids(
    session: AsyncSession,
    *,
    board_id: UUID,
) -> list[UUID]:
    """Return board ids in the same orchestration scope as the anchor board."""
    board_row = (
        await session.exec(
            select(
                col(Board.organization_id),
                col(Board.board_group_id),
            ).where(col(Board.id) == board_id),
        )
    ).first()
    if board_row is None:
        return []
    organization_id, board_group_id = board_row
    if board_group_id is None:
        return [board_id]
    return list(
        await session.exec(
            select(col(Board.id))
            .where(col(Board.organization_id) == organization_id)
            .where(col(Board.board_group_id) == board_group_id)
            .order_by(func.lower(col(Board.name)).asc()),
        ),
    )


async def board_ids_share_scope(
    session: AsyncSession,
    *,
    anchor_board_id: UUID,
    candidate_board_id: UUID,
) -> bool:
    """Return whether two boards belong to the same task-orchestration scope."""
    if anchor_board_id == candidate_board_id:
        return True
    return candidate_board_id in await board_scope_board_ids(
        session,
        board_id=anchor_board_id,
    )


async def resolve_scope_lead(
    session: AsyncSession,
    *,
    board_id: UUID,
) -> Agent | None:
    """Return the best lead candidate for a board scope.

    Preference order:
    1. A lead on the board itself
    2. A lead on a board named `Requirements` in the same board group
    3. The earliest-created lead in the same scope
    """
    scope_ids = await board_scope_board_ids(session, board_id=board_id)
    if not scope_ids:
        return None
    query = (
        select(Agent)
        .join(Board, col(Agent.board_id) == col(Board.id))
        .where(col(Agent.is_board_lead).is_(True))
        .where(col(Agent.board_id).in_(scope_ids))
        .order_by(
            case((col(Agent.board_id) == board_id, 0), else_=1).asc(),
            case((col(Board.name) == "Requirements", 0), else_=1).asc(),
            col(Agent.created_at).asc(),
        )
    )
    return (await session.exec(query)).first()
