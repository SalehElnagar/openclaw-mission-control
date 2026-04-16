# ruff: noqa: INP001
"""Integration tests for telemetry ingest and aggregation endpoints."""

from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.telemetry import router as telemetry_router
from app.core import auth as auth_module
from app.core.auth_mode import AuthMode
from app.core.config import settings
from app.db.session import get_session
from app.models.agents import Agent
from app.models.boards import Board
from app.models.gateways import Gateway
from app.models.organization_members import OrganizationMember
from app.models.organizations import Organization
from app.models.tasks import Task
from app.models.users import User


async def _make_engine() -> AsyncEngine:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    return engine


def _build_app(session_maker: async_sessionmaker[AsyncSession]) -> FastAPI:
    app = FastAPI()
    api_v1 = APIRouter(prefix="/api/v1")
    api_v1.include_router(telemetry_router)
    app.include_router(api_v1)

    async def _override_get_session() -> AsyncSession:
        async with session_maker() as session:
            yield session

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[auth_module.get_session] = _override_get_session
    return app


async def _seed_graph(session: AsyncSession) -> tuple[Gateway, Board, Agent, Task]:
    org = Organization(id=uuid4(), name="Personal Engineering")
    user = User(
        id=uuid4(),
        clerk_user_id=auth_module.LOCAL_AUTH_USER_ID,
        email=auth_module.LOCAL_AUTH_EMAIL,
        name=auth_module.LOCAL_AUTH_NAME,
        active_organization_id=org.id,
    )
    member = OrganizationMember(
        organization_id=org.id,
        user_id=user.id,
        role="owner",
        all_boards_read=True,
        all_boards_write=True,
    )
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
        name="Board",
        slug="board",
    )
    agent = Agent(
        id=uuid4(),
        board_id=board.id,
        gateway_id=gateway.id,
        name="builder",
        status="online",
    )
    task = Task(
        id=uuid4(),
        board_id=board.id,
        title="Implement policy sync",
    )
    session.add(org)
    session.add(user)
    session.add(member)
    session.add(gateway)
    session.add(board)
    session.add(agent)
    session.add(task)
    await session.commit()
    return gateway, board, agent, task


@pytest.mark.asyncio
async def test_telemetry_ingest_and_aggregate_filters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "auth_mode", AuthMode.LOCAL)
    monkeypatch.setattr(settings, "local_auth_token", "integration-token")

    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    app = _build_app(session_maker)
    async with session_maker() as session:
        gateway, board, agent, task = await _seed_graph(session)

    headers = {"Authorization": "Bearer integration-token"}
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            ingest = await client.post(
                "/api/v1/telemetry/usage",
                headers=headers,
                json={
                    "gateway_id": str(gateway.id),
                    "board_id": str(board.id),
                    "agent_id": str(agent.id),
                    "task_id": str(task.id),
                    "source": "runtime-report",
                    "model": "codex/gpt-5.4",
                    "prompt_tokens": 100,
                    "completion_tokens": 50,
                    "cost_usd": 0.42,
                },
            )
            assert ingest.status_code == 201

            aggregate = await client.get(
                "/api/v1/telemetry/usage",
                headers=headers,
                params={"gateway_id": str(gateway.id), "board_id": str(board.id)},
            )
            assert aggregate.status_code == 200
            payload = aggregate.json()
            assert payload["total_cost_usd"] == 0.42
            assert payload["total_tokens"] == 150
            assert payload["models"]["codex/gpt-5.4"] == 0.42

            filtered = await client.get(
                "/api/v1/telemetry/usage",
                headers=headers,
                params={"task_id": str(task.id)},
            )
            assert filtered.status_code == 200
            assert filtered.json()["total_tokens"] == 150
    finally:
        await engine.dispose()
