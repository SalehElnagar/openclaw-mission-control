# ruff: noqa: INP001
"""API tests for gateway runtime control endpoints."""

from __future__ import annotations

import pytest
from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.gateways import _gateway_audit_payload
from app.api.gateways import router as gateways_router
from app.core import auth as auth_module
from app.core.auth_mode import AuthMode
from app.core.config import settings
from app.db.session import get_session
from app.schemas.gateways import GatewayRead, GatewayUpdate


async def _make_engine() -> AsyncEngine:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    return engine


def _build_app(session_maker: async_sessionmaker[AsyncSession]) -> FastAPI:
    app = FastAPI()
    api_v1 = APIRouter(prefix="/api/v1")
    api_v1.include_router(gateways_router)
    app.include_router(api_v1)

    async def _override_get_session() -> AsyncSession:
        async with session_maker() as session:
            yield session

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[auth_module.get_session] = _override_get_session
    return app


def test_gateway_audit_payload_redacts_sensitive_token() -> None:
    payload = _gateway_audit_payload(
        {
            "name": "gateway",
            "token": "super-secret-token",
            "url": "ws://127.0.0.1:18789",
        },
    )

    assert payload["token"]["redacted"] is True
    assert payload["token"]["present"] is True
    assert payload["url"] == "ws://127.0.0.1:18789"


def test_gateway_read_normalizes_null_model_profiles() -> None:
    gateway = GatewayRead.model_validate(
        {
            "id": "00000000-0000-0000-0000-000000000001",
            "organization_id": "00000000-0000-0000-0000-000000000002",
            "name": "gateway",
            "url": "ws://127.0.0.1:18789",
            "node_class": "cloud",
            "workspace_root": "/tmp/workspaces",
            "allow_insecure_tls": False,
            "disable_device_pairing": False,
            "default_model_profile": "general",
            "model_profiles": None,
            "enabled_model_refs": None,
            "created_at": "2026-04-13T00:00:00Z",
            "updated_at": "2026-04-13T00:00:00Z",
        },
    )

    assert gateway.model_profiles.general is None
    assert gateway.model_profiles.coder is None
    assert gateway.model_profiles.budget is None
    assert gateway.enabled_model_refs is None
    assert gateway.node_class == "cloud"


def test_gateway_read_normalizes_node_class_case() -> None:
    gateway = GatewayRead.model_validate(
        {
            "id": "00000000-0000-0000-0000-000000000001",
            "organization_id": "00000000-0000-0000-0000-000000000002",
            "name": "gateway",
            "url": "ws://127.0.0.1:18789",
            "node_class": "LOCAL",
            "workspace_root": "/tmp/workspaces",
            "allow_insecure_tls": False,
            "disable_device_pairing": False,
            "default_model_profile": "general",
            "model_profiles": None,
            "enabled_model_refs": [
                " microsoft-foundry/gpt-5.4-mini ",
                "microsoft-foundry/gpt-5.4-mini",
            ],
            "created_at": "2026-04-13T00:00:00Z",
            "updated_at": "2026-04-13T00:00:00Z",
        },
    )

    assert gateway.node_class == "local"
    assert gateway.enabled_model_refs == ["microsoft-foundry/gpt-5.4-mini"]


def test_gateway_update_accepts_runtime_model_profile_patch() -> None:
    payload = GatewayUpdate.model_validate(
        {
            "default_model_profile": "general",
            "node_class": "local",
            "model_profiles": {
                "general": {
                    "primary_model": "microsoft-foundry/model-router",
                    "fallback_models": [],
                }
            },
            "enabled_model_refs": ["microsoft-foundry/model-router"],
        },
    )

    assert payload.default_model_profile == "general"
    assert payload.node_class == "local"
    assert payload.model_profiles is not None
    assert payload.model_profiles.general is not None
    assert payload.model_profiles.general.primary_model == "microsoft-foundry/model-router"
    assert payload.enabled_model_refs == ["microsoft-foundry/model-router"]


@pytest.mark.asyncio
async def test_gateway_runtime_reconcile_requires_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "auth_mode", AuthMode.LOCAL)
    monkeypatch.setattr(settings, "local_auth_token", "integration-token")

    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    app = _build_app(session_maker)
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            response = await client.post(
                "/api/v1/gateways/00000000-0000-0000-0000-000000000001/runtime/reconcile",
                json={"repair_stuck_agents": True, "sync_models": True, "wake_agents": True},
            )
        assert response.status_code == 401
    finally:
        await engine.dispose()
