from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from app.api import metrics as metrics_api
from app.models.boards import Board
from app.models.gateways import Gateway
from app.models.organizations import Organization
from app.services.openclaw.node_class import (
    filter_board_ids_by_gateway_node_class,
    filter_board_ids_by_gateway_scope,
)


async def _make_engine() -> AsyncEngine:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    return engine


@pytest.mark.asyncio
async def test_filter_board_ids_by_gateway_node_class_keeps_matching_gateway_boards() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Org")
            cloud_gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="Cloud",
                url="ws://cloud.example/ws",
                workspace_root="/tmp/workspaces",
                node_class="cloud",
            )
            local_gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="Local",
                url="ws://local.example/ws",
                workspace_root="/tmp/workspaces",
                node_class="local",
            )
            cloud_board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=cloud_gateway.id,
                name="Cloud Board",
                slug="cloud-board",
            )
            local_board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=local_gateway.id,
                name="Local Board",
                slug="local-board",
            )
            session.add_all([org, cloud_gateway, local_gateway, cloud_board, local_board])
            await session.commit()

            resolved = await filter_board_ids_by_gateway_node_class(
                session,
                [cloud_board.id, local_board.id],
                "local",
            )

            assert resolved == [local_board.id]
            assert (
                await filter_board_ids_by_gateway_node_class(
                    session,
                    [cloud_board.id, local_board.id],
                    None,
                )
            ) == [cloud_board.id, local_board.id]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_resolve_dashboard_board_ids_applies_node_class_filter() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Org")
            cloud_gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="Cloud",
                url="ws://cloud.example/ws",
                workspace_root="/tmp/workspaces",
                node_class="cloud",
            )
            local_gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="Local",
                url="ws://local.example/ws",
                workspace_root="/tmp/workspaces",
                node_class="local",
            )
            cloud_board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=cloud_gateway.id,
                name="Cloud Board",
                slug="cloud-board",
            )
            local_board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=local_gateway.id,
                name="Local Board",
                slug="local-board",
            )
            session.add_all([org, cloud_gateway, local_gateway, cloud_board, local_board])
            await session.commit()

            ctx = SimpleNamespace(
                member=SimpleNamespace(
                    organization_id=org.id,
                    all_boards_read=True,
                    all_boards_write=False,
                ),
            )

            resolved = await metrics_api._resolve_dashboard_board_ids(
                session,
                ctx=ctx,
                board_id=None,
                group_id=None,
                gateway_id=None,
                node_class="local",
            )

            assert resolved == [local_board.id]
            assert cloud_board.id not in resolved
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_filter_board_ids_by_gateway_scope_keeps_exact_gateway() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Org")
            cloud_gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="Cloud",
                url="ws://cloud.example/ws",
                workspace_root="/tmp/workspaces",
                node_class="cloud",
            )
            local_gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="Local",
                url="ws://local.example/ws",
                workspace_root="/tmp/workspaces",
                node_class="local",
            )
            cloud_board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=cloud_gateway.id,
                name="Cloud Board",
                slug="cloud-board",
            )
            local_board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=local_gateway.id,
                name="Local Board",
                slug="local-board",
            )
            session.add_all([org, cloud_gateway, local_gateway, cloud_board, local_board])
            await session.commit()

            resolved = await filter_board_ids_by_gateway_scope(
                session,
                [cloud_board.id, local_board.id],
                gateway_id=cloud_gateway.id,
            )

            assert resolved == [cloud_board.id]
    finally:
        await engine.dispose()
