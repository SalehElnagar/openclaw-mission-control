"""Tests for the Toronto weather API."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import httpx
import pytest
from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api import weather as weather_module
from app.api.weather import router as weather_router
from app.core import auth as auth_module
from app.core.auth_mode import AuthMode
from app.core.config import settings
from app.db.session import get_session


async def _make_engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    return engine


def _build_app(session_maker: async_sessionmaker[AsyncSession]) -> FastAPI:
    app = FastAPI()
    api_v1 = APIRouter(prefix="/api/v1")
    api_v1.include_router(weather_router)
    app.include_router(api_v1)

    async def _override_get_session() -> AsyncSession:
        async with session_maker() as session:
            yield session

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[auth_module.get_session] = _override_get_session
    return app


@pytest.mark.asyncio
async def test_toronto_weather_requires_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "auth_mode", AuthMode.LOCAL)
    monkeypatch.setattr(settings, "local_auth_token", "integration-token")
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    app = _build_app(session_maker)
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            response = await client.get("/api/v1/weather/toronto")
        assert response.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_toronto_weather_live_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(weather_module, "_weather_cache", None)
    unique_suffix = uuid4().hex
    monkeypatch.setattr(settings, "auth_mode", AuthMode.LOCAL)
    monkeypatch.setattr(settings, "local_auth_token", "integration-token")
    monkeypatch.setattr(auth_module, "LOCAL_AUTH_USER_ID", f"local-{unique_suffix}")
    monkeypatch.setattr(auth_module, "LOCAL_AUTH_EMAIL", f"local-{unique_suffix}@localhost")
    monkeypatch.setattr(auth_module, "LOCAL_AUTH_NAME", "Local Integration User")

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {
                "current": {
                    "temperature_2m": 21.4,
                    "windspeed_10m": 12.0,
                    "weather_code": 1,
                    "time": "2026-04-15T00:00:00Z",
                }
            }

    class FakeClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self.kwargs = kwargs

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
            return None

        async def get(self, *args: Any, **kwargs: Any) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    app = _build_app(session_maker)
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
            headers={"Authorization": "Bearer integration-token"},
        ) as client:
            response = await client.get("/api/v1/weather/toronto")
        assert response.status_code == 200
        payload = response.json()
        assert payload["ok"] is True
        assert payload["data"]["source"] == "open-meteo"
        assert payload["data"]["location"] == "Toronto"
        assert payload["data"]["temperature_c"] == 21.4
        assert payload["data"]["description"] == "Mainly clear"
        assert payload["warning"] is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_toronto_weather_fallback_on_upstream_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(weather_module, "_weather_cache", None)
    unique_suffix = uuid4().hex
    monkeypatch.setattr(settings, "auth_mode", AuthMode.LOCAL)
    monkeypatch.setattr(settings, "local_auth_token", "integration-token")
    monkeypatch.setattr(auth_module, "LOCAL_AUTH_USER_ID", f"local-{unique_suffix}")
    monkeypatch.setattr(auth_module, "LOCAL_AUTH_EMAIL", f"local-{unique_suffix}@localhost")
    monkeypatch.setattr(auth_module, "LOCAL_AUTH_NAME", "Local Integration User")

    class FakeClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
            return None

        async def get(self, *args: Any, **kwargs: Any) -> Any:
            raise httpx.ConnectError("boom")

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    app = _build_app(session_maker)
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
            headers={"Authorization": "Bearer integration-token"},
        ) as client:
            response = await client.get("/api/v1/weather/toronto")
        assert response.status_code == 200
        payload = response.json()
        assert payload["data"]["source"] == "mock-fallback"
        assert payload["data"]["fallback_used"] is True
        assert payload["warning"] is not None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_toronto_weather_explicit_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(weather_module, "_weather_cache", None)
    unique_suffix = uuid4().hex
    monkeypatch.setattr(settings, "auth_mode", AuthMode.LOCAL)
    monkeypatch.setattr(settings, "local_auth_token", "integration-token")
    monkeypatch.setattr(auth_module, "LOCAL_AUTH_USER_ID", f"local-{unique_suffix}")
    monkeypatch.setattr(auth_module, "LOCAL_AUTH_EMAIL", f"local-{unique_suffix}@localhost")
    monkeypatch.setattr(auth_module, "LOCAL_AUTH_NAME", "Local Integration User")

    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    app = _build_app(session_maker)
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
            headers={"Authorization": "Bearer integration-token"},
        ) as client:
            response = await client.get("/api/v1/weather/toronto", params={"use_fallback": "true"})
        assert response.status_code == 200
        payload = response.json()
        assert payload["data"]["source"] == "mock-fallback"
        assert payload["warning"] == "Fallback requested explicitly via use_fallback=true."
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_toronto_weather_cache_reuses_live_result(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(weather_module, "_weather_cache", None)
    unique_suffix = uuid4().hex
    monkeypatch.setattr(settings, "auth_mode", AuthMode.LOCAL)
    monkeypatch.setattr(settings, "local_auth_token", "integration-token")
    monkeypatch.setattr(auth_module, "LOCAL_AUTH_USER_ID", f"local-{unique_suffix}")
    monkeypatch.setattr(auth_module, "LOCAL_AUTH_EMAIL", f"local-{unique_suffix}@localhost")
    monkeypatch.setattr(auth_module, "LOCAL_AUTH_NAME", "Local Integration User")
    calls = {"count": 0}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {
                "current": {
                    "temperature_2m": 19.0,
                    "windspeed_10m": 8.0,
                    "weather_code": 0,
                    "time": "2026-04-15T00:00:00Z",
                }
            }

    class FakeClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self.kwargs = kwargs

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
            return None

        async def get(self, *args: Any, **kwargs: Any) -> FakeResponse:
            calls["count"] += 1
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    app = _build_app(session_maker)
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
            headers={"Authorization": "Bearer integration-token"},
        ) as client:
            first = await client.get("/api/v1/weather/toronto")
            second = await client.get("/api/v1/weather/toronto")
        assert first.status_code == 200
        assert second.status_code == 200
        assert calls["count"] == 1
    finally:
        await engine.dispose()
