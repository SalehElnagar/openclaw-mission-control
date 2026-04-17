"""Helpers for filtering accessible boards by gateway scope."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.node_class import GatewayNodeClass
from app.models.boards import Board
from app.models.gateways import Gateway


async def filter_board_ids_by_gateway_id(
    session: AsyncSession,
    board_ids: list[UUID],
    gateway_id: UUID | None,
) -> list[UUID]:
    """Return board ids owned by the requested gateway."""
    if gateway_id is None or not board_ids:
        return board_ids

    rows = await session.exec(
        select(Board.id)
        .where(Board.id.in_(board_ids))
        .where(Board.gateway_id == gateway_id),
    )
    matched = set(rows.scalars().all())
    return [board_id for board_id in board_ids if board_id in matched]


async def filter_board_ids_by_gateway_node_class(
    session: AsyncSession,
    board_ids: list[UUID],
    node_class: GatewayNodeClass | None,
) -> list[UUID]:
    """Return board ids whose owning gateway matches the requested node class."""
    if node_class is None or not board_ids:
        return board_ids

    rows = await session.exec(
        select(Board.id)
        .join(Gateway, Board.gateway_id == Gateway.id)
        .where(Board.id.in_(board_ids))
        .where(Gateway.node_class == node_class),
    )
    matched = set(rows.scalars().all())
    return [board_id for board_id in board_ids if board_id in matched]


async def filter_board_ids_by_gateway_scope(
    session: AsyncSession,
    board_ids: list[UUID],
    *,
    gateway_id: UUID | None = None,
    node_class: GatewayNodeClass | None = None,
) -> list[UUID]:
    """Return board ids filtered by exact gateway and/or aggregate node class."""
    scoped_ids = await filter_board_ids_by_gateway_id(session, board_ids, gateway_id)
    return await filter_board_ids_by_gateway_node_class(
        session,
        scoped_ids,
        node_class,
    )
