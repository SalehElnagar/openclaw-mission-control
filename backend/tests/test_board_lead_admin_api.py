# ruff: noqa: INP001
"""API tests for ensuring canonical board leads."""

from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.boards import router as boards_router
from app.api.deps import require_org_admin
from app.core.auth import AuthContext, get_auth_context
from app.db.session import get_session
from app.models.agents import Agent
from app.models.boards import Board
from app.models.gateways import Gateway
from app.models.organization_members import OrganizationMember
from app.models.organizations import Organization
from app.models.users import User
from app.services.openclaw.gateway_dispatch import GatewayDispatchService
from app.services.openclaw.gateway_rpc import GatewayConfig
from app.services.openclaw.lifecycle_orchestrator import AgentLifecycleOrchestrator
from app.services.openclaw.runtime_control import GatewayRuntimeControlService
from app.services.organizations import OrganizationContext


async def _make_engine() -> AsyncEngine:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    return engine


def _build_app(session_maker: async_sessionmaker[AsyncSession]) -> FastAPI:
    app = FastAPI()
    api_v1 = APIRouter(prefix="/api/v1")
    api_v1.include_router(boards_router)
    app.include_router(api_v1)

    async def _override_get_session() -> AsyncSession:
        async with session_maker() as session:
            yield session

    app.dependency_overrides[get_session] = _override_get_session
    return app


@pytest.mark.asyncio
async def test_ensure_board_lead_is_idempotent_and_normalizes_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    lifecycle_calls: list[str] = []
    sync_calls: list[str] = []

    try:
        async with session_maker() as seed_session:
            user = User(
                id=uuid4(),
                clerk_user_id="local-auth-user",
                email="admin@home.local",
                name="Saleh Elnagar",
            )
            org = Organization(id=uuid4(), name="Personal Engineering")
            member = OrganizationMember(
                id=uuid4(),
                organization_id=org.id,
                user_id=user.id,
                role="owner",
                all_boards_read=True,
                all_boards_write=True,
            )
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="Local Gateway",
                url="ws://127.0.0.1:18789",
                workspace_root="/tmp/openclaw-workspaces",
                default_model_profile="general",
                model_profiles={
                    "general": {"primary_model": "openai/gpt-5.4", "fallback_models": []}
                },
            )
            board = Board(
                id=uuid4(),
                organization_id=org.id,
                gateway_id=gateway.id,
                name="Requirements",
                slug="requirements",
            )
            seed_session.add(user)
            seed_session.add(org)
            seed_session.add(member)
            seed_session.add(gateway)
            seed_session.add(board)
            await seed_session.commit()

        app = _build_app(session_maker)

        async def _override_require_org_admin() -> OrganizationContext:
            return OrganizationContext(organization=org, member=member)

        async def _override_get_auth_context() -> AuthContext:
            return AuthContext(actor_type="user", user=user)

        async def _fake_require_gateway_config_for_board(
            self,
            board: Board,
        ) -> tuple[Gateway, GatewayConfig]:
            return (
                gateway,
                GatewayConfig(
                    url=gateway.url,
                    token=gateway.token,
                    allow_insecure_tls=gateway.allow_insecure_tls,
                    disable_device_pairing=gateway.disable_device_pairing,
                ),
            )

        async def _fake_run_lifecycle(self, **kwargs: object) -> Agent:
            lifecycle_calls.append(str(kwargs["action"]))
            async with session_maker() as session:
                agent = await Agent.objects.by_id(kwargs["agent_id"]).first(session)
                assert agent is not None
                agent.status = "online"
                session.add(agent)
                await session.commit()
                await session.refresh(agent)
                return agent

        async def _fake_sync_model_policies(self, **kwargs: object) -> bool:
            sync_calls.append(str(kwargs["gateway"].id))
            return True

        app.dependency_overrides[require_org_admin] = _override_require_org_admin
        app.dependency_overrides[get_auth_context] = _override_get_auth_context
        monkeypatch.setattr(
            GatewayDispatchService,
            "require_gateway_config_for_board",
            _fake_require_gateway_config_for_board,
        )
        monkeypatch.setattr(
            AgentLifecycleOrchestrator,
            "run_lifecycle",
            _fake_run_lifecycle,
        )
        monkeypatch.setattr(
            GatewayRuntimeControlService,
            "sync_model_policies",
            _fake_sync_model_policies,
        )

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            first = await client.post(f"/api/v1/boards/{board.id}/lead/ensure")
            second = await client.post(f"/api/v1/boards/{board.id}/lead/ensure")

        assert first.status_code == 200
        assert second.status_code == 200
        assert first.json()["id"] == second.json()["id"]
        assert first.json()["name"] == "Lead"
        assert first.json()["board_id"] == str(board.id)
        assert first.json()["is_board_lead"] is True
        assert first.json()["model_profile"] == "general"
        assert first.json()["model_primary"] is None
        assert first.json()["model_fallback_policy"] == "profile"
        assert first.json()["model_fallbacks"] is None
        assert first.json()["openclaw_session_id"] == f"agent:lead-{board.id}:main"
        assert lifecycle_calls == ["provision"]
        assert len(sync_calls) == 2

        async with session_maker() as verify_session:
            leads = (
                await verify_session.exec(
                    select(Agent)
                    .where(Agent.board_id == board.id)
                    .where(Agent.is_board_lead.is_(True))
                )
            ).all()

        assert len(leads) == 1
        assert leads[0].name == "Lead"
        assert leads[0].model_profile == "general"
    finally:
        await engine.dispose()
