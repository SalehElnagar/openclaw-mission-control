# ruff: noqa: INP001
"""Tests for gateway runtime recovery and model policy validation."""

from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.auth import AuthContext
from app.models.agents import Agent
from app.models.boards import Board
from app.models.gateways import Gateway
from app.models.organizations import Organization
from app.schemas.gateway_runtime import GatewayRuntimeSyncRequest
from app.services.openclaw import runtime_control
from app.services.openclaw.gateway_agent_pack import MAIN_AGENT_SPEC, STARTER_PACK_PRIMARY_MODEL_REF
from app.services.openclaw.runtime_control import (
    DEFAULT_PRIMARY_MODEL_REF,
    GatewayRuntimeControlService,
    _config_declared_model_refs,
    resolve_agent_model_selection,
    resolve_default_model_selection,
)


async def _make_engine() -> AsyncEngine:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    return engine


def test_gateway_main_agent_uses_foundry_mini_by_default() -> None:
    assert MAIN_AGENT_SPEC.model_profile == "general"
    assert MAIN_AGENT_SPEC.model_primary == STARTER_PACK_PRIMARY_MODEL_REF


def test_resolve_agent_model_selection_merges_profile_and_explicit_fallbacks() -> None:
    gateway = Gateway(
        organization_id=uuid4(),
        name="gateway",
        url="ws://gateway.example/ws",
        workspace_root="/tmp/workspaces",
        default_model_profile="coder",
        model_profiles={
            "coder": {
                "primary_model": "codex/gpt-5.4",
                "fallback_models": ["openai/gpt-5.4-mini"],
            }
        },
    )
    agent = Agent(
        gateway_id=gateway.id,
        name="builder",
        model_profile="coder",
        model_fallback_policy="profile",
        model_fallbacks=["openai/gpt-5.4-nano"],
    )

    selection = resolve_agent_model_selection(gateway=gateway, agent=agent)

    assert selection is not None
    assert selection.primary_model == "codex/gpt-5.4"
    assert selection.fallback_models == ["openai/gpt-5.4-nano", "openai/gpt-5.4-mini"]


def test_resolve_default_model_selection_falls_back_to_codex() -> None:
    gateway = Gateway(
        organization_id=uuid4(),
        name="gateway",
        url="ws://gateway.example/ws",
        workspace_root="/tmp/workspaces",
        model_profiles={},
    )

    selection = resolve_default_model_selection(gateway)

    assert selection is not None
    assert selection.primary_model == DEFAULT_PRIMARY_MODEL_REF
    assert selection.fallback_models == []


def test_resolve_agent_model_selection_falls_back_to_codex_default() -> None:
    gateway = Gateway(
        organization_id=uuid4(),
        name="gateway",
        url="ws://gateway.example/ws",
        workspace_root="/tmp/workspaces",
        model_profiles={},
    )
    agent = Agent(gateway_id=gateway.id, name="lead")

    selection = resolve_agent_model_selection(gateway=gateway, agent=agent)

    assert selection is not None
    assert selection.primary_model == DEFAULT_PRIMARY_MODEL_REF


def test_config_declared_model_refs_include_provider_catalog_default_and_agent_entries() -> None:
    refs = _config_declared_model_refs(
        {
            "models": {
                "providers": {
                    "microsoft-foundry": {
                        "models": [
                            {"id": "model-router"},
                        ],
                    },
                },
            },
            "agents": {
                "defaults": {
                    "model": "microsoft-foundry/model-router",
                    "models": {
                        "openai-codex/gpt-5.4": {},
                    },
                },
                "list": [
                    {
                        "id": "reviewer",
                        "model": {
                            "provider": "openai-codex",
                            "model": "gpt-5.4",
                        },
                    }
                ],
            },
        },
    )

    assert "microsoft-foundry/model-router" in refs
    assert "openai-codex/gpt-5.4" in refs


@pytest.mark.asyncio
async def test_assert_model_policies_supported_rejects_unknown_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = Gateway(
        organization_id=uuid4(),
        name="gateway",
        url="ws://gateway.example/ws",
        workspace_root="/tmp/workspaces",
        default_model_profile="general",
        model_profiles={
            "general": {
                "primary_model": "openai/gpt-5.4",
                "fallback_models": ["openai/gpt-5.4-mini"],
            }
        },
    )
    service = GatewayRuntimeControlService(session=object())  # type: ignore[arg-type]

    async def _fake_available_models(_gateway: Gateway) -> list[str]:
        return ["openai/gpt-5.4-mini"]

    monkeypatch.setattr(service, "available_models", _fake_available_models)

    with pytest.raises(runtime_control.HTTPException) as excinfo:
        await service.assert_model_policies_supported(gateway=gateway, agents=[])

    assert excinfo.value.status_code == 422
    assert "openai/gpt-5.4" in str(excinfo.value.detail)


@pytest.mark.asyncio
async def test_available_models_only_returns_runtime_verified_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = Gateway(
        organization_id=uuid4(),
        name="gateway",
        url="ws://gateway.example/ws",
        workspace_root="/tmp/workspaces",
    )
    service = GatewayRuntimeControlService(session=object())  # type: ignore[arg-type]

    async def _fake_gateway_models_payload(_gateway: Gateway) -> object:
        return {"models": [{"provider": "openai-codex", "id": "gpt-5.4"}]}

    async def _fake_load_gateway_config(_gateway: Gateway) -> tuple[str | None, dict[str, object]]:
        return (
            "hash",
            {
                "models": {
                    "providers": {
                        "microsoft-foundry": {
                            "models": [{"id": "model-router"}],
                        },
                    },
                },
            },
        )

    monkeypatch.setattr(service, "_gateway_models_payload", _fake_gateway_models_payload)
    monkeypatch.setattr(service, "_load_gateway_config", _fake_load_gateway_config)

    refs = await service.available_models(gateway)

    assert "openai-codex/gpt-5.4" in refs
    assert "microsoft-foundry/model-router" not in refs


@pytest.mark.asyncio
async def test_runtime_catalog_filters_to_supported_selectable_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = Gateway(
        organization_id=uuid4(),
        name="gateway",
        url="ws://gateway.example/ws",
        workspace_root="/tmp/workspaces",
    )
    service = GatewayRuntimeControlService(session=object())  # type: ignore[arg-type]

    async def _fake_gateway_models_payload(_gateway: Gateway) -> object:
        return {
            "models": [
                {"provider": "openai-codex", "id": "gpt-5.4"},
                {"provider": "github-copilot", "id": "gpt-5.4"},
                {"provider": "grok", "id": "grok-3"},
            ],
        }

    async def _fake_load_gateway_config(_gateway: Gateway) -> tuple[str | None, dict[str, object]]:
        return (
            "hash",
            {
                "models": {
                    "providers": {
                        "anthropic": {"models": [{"id": "claude-sonnet-4-6"}]},
                        "google-antigravity": {"models": [{"id": "claude-opus-4-6-thinking"}]},
                    },
                    "extra": "ignored",
                },
                "agents": {
                    "defaults": {
                        "models": {
                            "github-copilot/gpt-5.4": {},
                            "openai-codex/gpt-5.4": {},
                        }
                    }
                },
            },
        )

    monkeypatch.setattr(service, "_gateway_models_payload", _fake_gateway_models_payload)
    monkeypatch.setattr(service, "_load_gateway_config", _fake_load_gateway_config)

    catalog = await service.runtime_catalog(gateway)

    assert [entry.ref for entry in catalog] == [
        "anthropic/claude-sonnet-4-6",
        "github-copilot/gpt-5.4",
        "google-antigravity/claude-opus-4-6-thinking",
        "grok/grok-3",
        "openai-codex/gpt-5.4",
    ]
    assert catalog[0].verification_state == "configured"
    assert catalog[0].selectable is False
    assert catalog[0].provider_label == "Claude"
    assert catalog[1].verification_state == "runtime"
    assert catalog[1].selectable is True
    assert catalog[1].provider_label == "GitHub Copilot"
    assert catalog[2].verification_state == "configured"
    assert catalog[2].selectable is False
    assert catalog[2].provider_label == "Antigravity"
    assert catalog[3].verification_state == "runtime"
    assert catalog[3].selectable is True
    assert catalog[4].verification_state == "runtime"
    assert catalog[4].selectable is True
    assert catalog[4].is_default is True
    assert catalog[4].provider_label == "Codex"


@pytest.mark.asyncio
async def test_runtime_summary_exposes_profile_default_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = Gateway(
        organization_id=uuid4(),
        name="gateway",
        url="ws://gateway.example/ws",
        workspace_root="/tmp/workspaces",
        default_model_profile="general",
        model_profiles={
            "general": {
                "primary_model": "microsoft-foundry/model-router",
                "fallback_models": [],
            }
        },
    )
    service = GatewayRuntimeControlService(session=object())  # type: ignore[arg-type]

    async def _fake_runtime_catalog(_gateway: Gateway) -> list[object]:
        return []

    monkeypatch.setattr(service, "runtime_catalog", _fake_runtime_catalog)

    summary = await service.runtime_summary(gateway=gateway)

    assert summary.default_model_ref == "microsoft-foundry/model-router"


@pytest.mark.asyncio
async def test_runtime_summary_exposes_codex_fallback_default_when_profiles_are_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = Gateway(
        organization_id=uuid4(),
        name="gateway",
        url="ws://gateway.example/ws",
        workspace_root="/tmp/workspaces",
        model_profiles={},
    )
    service = GatewayRuntimeControlService(session=object())  # type: ignore[arg-type]

    async def _fake_runtime_catalog(_gateway: Gateway) -> list[object]:
        return []

    monkeypatch.setattr(service, "runtime_catalog", _fake_runtime_catalog)

    summary = await service.runtime_summary(gateway=gateway)

    assert summary.default_model_ref == DEFAULT_PRIMARY_MODEL_REF


@pytest.mark.asyncio
async def test_reconcile_gateway_runtime_repairs_stuck_agents(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
                model_profiles={
                    "general": {"primary_model": "openai/gpt-5.4", "fallback_models": []}
                },
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
                status="provisioning",
            )
            session.add(org)
            session.add(gateway)
            session.add(board)
            session.add(agent)
            await session.commit()
            await session.refresh(gateway)

            service = GatewayRuntimeControlService(session)
            auth = AuthContext(actor_type="user", user=SimpleNamespace(id=uuid4()))
            repaired_calls: list[str] = []

            async def _fake_get_existing_token(**_kwargs: object) -> str | None:
                return "agent-runtime-token"

            async def _fake_run_lifecycle(self, **kwargs: object) -> Agent:
                repaired_calls.append(str(kwargs["agent_id"]))
                target = await Agent.objects.by_id(kwargs["agent_id"]).first(session)
                assert target is not None
                target.status = "online"
                target.last_provision_error = None
                session.add(target)
                await session.commit()
                await session.refresh(target)
                return target

            async def _fake_sync_model_policies(self, **_kwargs: object) -> bool:
                return True

            async def _fake_available_models(_gateway: Gateway) -> list[str]:
                return [STARTER_PACK_PRIMARY_MODEL_REF]

            monkeypatch.setattr(service, "_get_existing_agent_token", _fake_get_existing_token)
            monkeypatch.setattr(
                runtime_control.AgentLifecycleOrchestrator,
                "run_lifecycle",
                _fake_run_lifecycle,
            )
            monkeypatch.setattr(
                GatewayRuntimeControlService,
                "sync_model_policies",
                _fake_sync_model_policies,
            )
            monkeypatch.setattr(service, "available_models", _fake_available_models)

            result = await service.reconcile_gateway_runtime(
                gateway=gateway,
                auth=auth,
                request=GatewayRuntimeSyncRequest(),
            )

            assert str(agent.id) in repaired_calls
            assert agent.id in result.repaired_agents
            assert result.synced_models is True
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_reconcile_gateway_runtime_backfills_gateway_starter_pack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            org = Organization(id=uuid4(), name="Personal Engineering")
            gateway = Gateway(
                id=uuid4(),
                organization_id=org.id,
                name="VM Gateway",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            session.add(org)
            session.add(gateway)
            await session.commit()
            await session.refresh(gateway)

            service = GatewayRuntimeControlService(session)
            auth = AuthContext(actor_type="user", user=SimpleNamespace(id=uuid4()))

            async def _fake_sync_model_policies(self, **_kwargs: object) -> bool:
                return True

            async def _fake_available_models(_gateway: Gateway) -> list[str]:
                return [STARTER_PACK_PRIMARY_MODEL_REF]

            monkeypatch.setattr(
                GatewayRuntimeControlService,
                "sync_model_policies",
                _fake_sync_model_policies,
            )
            monkeypatch.setattr(service, "available_models", _fake_available_models)

            result = await service.reconcile_gateway_runtime(
                gateway=gateway,
                auth=auth,
                request=GatewayRuntimeSyncRequest(repair_stuck_agents=False, sync_models=True),
            )

            agents = list(await Agent.objects.filter_by(gateway_id=gateway.id).all(session))
            assert result.synced_models is True
            assert len(agents) == 5
            by_name = {agent.name: agent for agent in agents}
            assert f"{gateway.name} Gateway Agent" in by_name
            assert f"{gateway.name} Lead" in by_name
            assert f"{gateway.name} Builder" in by_name
            assert f"{gateway.name} Reviewer" in by_name
            assert f"{gateway.name} Security" in by_name
            assert by_name[f"{gateway.name} Lead"].model_profile == "general"
            assert by_name[f"{gateway.name} Builder"].model_profile == "coder"
            assert by_name[f"{gateway.name} Security"].model_profile == "budget"
            assert by_name[f"{gateway.name} Builder"].model_primary == STARTER_PACK_PRIMARY_MODEL_REF
            assert gateway.model_profiles is not None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_repair_gateway_execution_agent_stays_standby_without_wake(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _SessionStub:
        def add(self, _value: object) -> None:
            return None

        async def commit(self) -> None:
            return None

        async def refresh(self, _value: object) -> None:
            return None

    gateway = Gateway(
        organization_id=uuid4(),
        name="Gateway",
        url="ws://gateway.example/ws",
        workspace_root="/tmp/workspaces",
    )
    agent = Agent(
        gateway_id=gateway.id,
        name="Gateway Builder",
        purpose="execution",
        board_id=None,
        model_profile="coder",
        model_primary=STARTER_PACK_PRIMARY_MODEL_REF,
        status="updating",
    )
    service = GatewayRuntimeControlService(session=_SessionStub())  # type: ignore[arg-type]
    auth = AuthContext(actor_type="user", user=SimpleNamespace(id=uuid4()))
    captured: dict[str, object] = {}

    async def _fake_get_existing_token(**_kwargs: object) -> str | None:
        return None

    async def _fake_run_lifecycle(self, **kwargs: object) -> Agent:
        captured.update(kwargs)
        agent.status = "online"
        return agent

    monkeypatch.setattr(service, "_get_existing_agent_token", _fake_get_existing_token)
    monkeypatch.setattr(
        runtime_control.AgentLifecycleOrchestrator,
        "run_lifecycle",
        _fake_run_lifecycle,
    )

    repaired = await service._repair_agent_runtime(
        gateway=gateway,
        agent=agent,
        auth=auth,
        wake_agents=True,
    )

    assert repaired is True
    assert captured["wake"] is False
    assert captured["deliver_wakeup"] is False
    assert captured["wakeup_verb"] is None
