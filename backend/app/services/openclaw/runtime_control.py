"""Gateway runtime control, model policy sync, and restart recovery helpers."""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException, status
from sqlmodel import col

from app.core.auth import AuthContext
from app.core.time import utcnow
from app.models.agents import Agent
from app.models.boards import Board
from app.models.gateways import Gateway
from app.schemas.gateway_runtime import (
    GatewayModelProfiles,
    GatewayRuntimeCatalogEntry,
    GatewayRuntimeSummary,
    GatewayRuntimeSyncRequest,
    GatewayRuntimeSyncResponse,
    ModelSelection,
)
from app.schemas.telemetry import UsageSampleCreate
from app.services.activity_log import actor_fields_from_auth, record_activity
from app.services.openclaw.constants import DEFAULT_HEARTBEAT_CONFIG
from app.services.openclaw.db_service import OpenClawDBService
from app.services.openclaw.gateway_agent_pack import (
    MAIN_AGENT_SPEC,
    MANAGED_GATEWAY_AGENT_SPECS,
    STARTER_PACK_PRIMARY_MODEL_REF,
    GatewayManagedAgentSpec,
    apply_gateway_managed_agent_spec,
    is_gateway_execution_agent,
    runtime_agent_identifier,
)
from app.services.openclaw.gateway_rpc import GatewayConfig as GatewayClientConfig
from app.services.openclaw.gateway_rpc import OpenClawGatewayError, openclaw_call
from app.services.openclaw.internal.agent_key import agent_key as runtime_agent_id
from app.services.openclaw.internal.retry import GatewayBackoff
from app.services.openclaw.lifecycle_orchestrator import AgentLifecycleOrchestrator
from app.services.openclaw.provisioning import OpenClawGatewayControlPlane
from app.services.openclaw.shared import GatewayAgentIdentity
from app.services.telemetry import UsageTelemetryService

PROFILE_NAMES = ("general", "coder", "budget")
DEFAULT_PRIMARY_MODEL_REF = "openai-codex/gpt-5.4"
KNOWN_PROVIDER_LABELS: dict[str, str] = {
    "microsoft-foundry": "Azure Foundry",
    "openai-codex": "Codex",
    "github-copilot": "GitHub Copilot",
    "anthropic": "Claude",
    "claude": "Claude",
    "google-antigravity": "Antigravity",
    "antigravity": "Antigravity",
}
KNOWN_MODEL_LABELS: dict[str, str] = {
    "microsoft-foundry/model-router": "Azure Foundry Model Router",
    "microsoft-foundry/gpt-5.4-mini": "Azure Foundry GPT-5.4 Mini",
    "openai-codex/gpt-5.4": "Codex GPT-5.4",
    "github-copilot/gpt-5": "GitHub Copilot GPT-5",
    "github-copilot/gpt-5.4": "GitHub Copilot GPT-5.4",
    "anthropic/claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude/claude-sonnet-4": "Claude Sonnet 4",
    "google-antigravity/claude-opus-4-6-thinking": "Antigravity Claude Opus 4.6 Thinking",
    "antigravity/operator": "Antigravity Operator",
}


def _gateway_client_config(gateway: Gateway) -> GatewayClientConfig:
    return GatewayClientConfig(
        url=gateway.url,
        token=gateway.token,
        allow_insecure_tls=gateway.allow_insecure_tls,
        disable_device_pairing=gateway.disable_device_pairing,
    )


def _default_main_identity_profile() -> dict[str, str]:
    return {
        "role": "Gateway Agent",
        "communication_style": "direct, concise, practical",
        "emoji": ":compass:",
    }


def _parse_tools_content(tools_md: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in tools_md.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if key:
            values[key] = value
    return values


def _load_model_profiles(gateway: Gateway) -> GatewayModelProfiles:
    raw = gateway.model_profiles or {}
    if isinstance(raw, GatewayModelProfiles):
        return raw
    if not isinstance(raw, dict):
        return GatewayModelProfiles()
    return GatewayModelProfiles.model_validate(raw)


def _profile_selection(
    profiles: GatewayModelProfiles,
    profile_name: str,
) -> ModelSelection | None:
    value = getattr(profiles, profile_name, None)
    return value if isinstance(value, ModelSelection) else None


def _dedupe_models(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for value in values:
        normalized = value.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped


def _humanize_model_id(model_id: str) -> str:
    return " ".join(
        part.upper() if part.isalpha() and len(part) <= 4 else part.capitalize()
        for part in model_id.replace(".", " ").replace("-", " ").replace("_", " ").split()
    )


def _catalog_provider_label(provider: str) -> str:
    return KNOWN_PROVIDER_LABELS.get(provider, provider.replace("-", " ").title())


def _catalog_label(ref: str) -> str:
    if ref in KNOWN_MODEL_LABELS:
        return KNOWN_MODEL_LABELS[ref]
    provider, _, model_id = ref.partition("/")
    if not model_id:
        return ref
    provider_label = _catalog_provider_label(provider)
    model_label = _humanize_model_id(model_id)
    if model_label.lower().startswith(provider_label.lower()):
        return model_label
    return f"{provider_label} {model_label}"


def resolve_agent_model_selection(
    *,
    gateway: Gateway,
    agent: Agent,
) -> ModelSelection | None:
    """Resolve the effective model policy for one agent."""
    profiles = _load_model_profiles(gateway)
    profile_name = agent.model_profile or gateway.default_model_profile or "general"
    profile_selection = _profile_selection(profiles, profile_name)
    primary = agent.model_primary or (
        profile_selection.primary_model if profile_selection else None
    )
    if primary is None:
        default_selection = resolve_default_model_selection(gateway)
        primary = default_selection.primary_model if default_selection else None
    if primary is None:
        return None
    explicit_fallbacks = list(agent.model_fallbacks or [])
    profile_fallbacks = list(profile_selection.fallback_models) if profile_selection else []
    if agent.model_fallback_policy == "none":
        fallbacks: list[str] = []
    elif agent.model_fallback_policy == "explicit-only":
        fallbacks = explicit_fallbacks
    else:
        fallbacks = _dedupe_models([*explicit_fallbacks, *profile_fallbacks])
    fallbacks = [value for value in fallbacks if value != primary]
    return ModelSelection(primary_model=primary, fallback_models=fallbacks)


def resolve_default_model_selection(gateway: Gateway) -> ModelSelection | None:
    profiles = _load_model_profiles(gateway)
    selection = _profile_selection(profiles, gateway.default_model_profile or "general")
    if selection is not None and selection.primary_model is not None:
        return selection
    return ModelSelection(primary_model=DEFAULT_PRIMARY_MODEL_REF, fallback_models=[])


def _model_payload(selection: ModelSelection | None) -> object | None:
    if selection is None or selection.primary_model is None:
        return None
    if not selection.fallback_models:
        return selection.primary_model
    return {
        "primary": selection.primary_model,
        "fallbacks": list(selection.fallback_models),
    }


def _model_refs_from_payload(payload: object) -> set[str]:
    refs: set[str] = set()
    if payload is None:
        return refs
    if isinstance(payload, str):
        normalized = payload.strip()
        if normalized:
            refs.add(normalized)
        return refs
    if isinstance(payload, list):
        for item in payload:
            refs |= _model_refs_from_payload(item)
        return refs
    if not isinstance(payload, dict):
        return refs
    direct_ref = payload.get("ref")
    if isinstance(direct_ref, str) and direct_ref.strip():
        refs.add(direct_ref.strip())
    provider = payload.get("provider")
    model = payload.get("model")
    if isinstance(provider, str) and isinstance(model, str) and provider.strip() and model.strip():
        refs.add(f"{provider.strip()}/{model.strip()}")
    if isinstance(provider, str) and isinstance(payload.get("id"), str):
        provider_value = provider.strip()
        model_id = payload["id"].strip()
        if provider_value and model_id:
            refs.add(f"{provider_value}/{model_id}")
    if not isinstance(provider, str) or not provider.strip():
        direct = payload.get("id") or payload.get("model")
        if isinstance(direct, str) and direct.strip():
            refs.add(direct.strip())
    for key in ("primary", "fallbacks"):
        refs |= _model_refs_from_payload(payload.get(key))
    for key in ("models", "items", "entries", "usage", "rows", "costs"):
        refs |= _model_refs_from_payload(payload.get(key))
    return refs


def _available_model_refs(payload: object) -> list[str]:
    refs = sorted(_model_refs_from_payload(payload))
    return refs


def _is_transient_runtime_patch_error(exc: OpenClawGatewayError) -> bool:
    message = str(exc).lower()
    if not message:
        return False
    return any(
        marker in message
        for marker in (
            "did not receive a valid http response",
            "connection refused",
            "connection reset",
            "invalidmessage",
            "invalid message",
            "connection closed",
            "received 1012",
            "service restart",
            "temporar",
            "timeout",
            "timed out",
        )
    )


def _config_declared_model_refs(config_data: dict[str, Any]) -> list[str]:
    refs: set[str] = set()
    models_section = config_data.get("models")
    if isinstance(models_section, dict):
        providers = models_section.get("providers")
        if isinstance(providers, dict):
            for provider_id, provider_config in providers.items():
                if not isinstance(provider_id, str) or not isinstance(provider_config, dict):
                    continue
                provider_models = provider_config.get("models")
                if not isinstance(provider_models, list):
                    continue
                for item in provider_models:
                    if not isinstance(item, dict):
                        continue
                    model_id = item.get("id")
                    if isinstance(model_id, str) and model_id.strip():
                        refs.add(f"{provider_id}/{model_id.strip()}")
    agents_section = config_data.get("agents")
    if isinstance(agents_section, dict):
        defaults = agents_section.get("defaults")
        if isinstance(defaults, dict):
            refs |= _model_refs_from_payload(defaults.get("model"))
            catalog = defaults.get("models")
            if isinstance(catalog, dict):
                refs.update(key.strip() for key in catalog if isinstance(key, str) and key.strip())
        for item in agents_section.get("list") or []:
            if not isinstance(item, dict):
                continue
            refs |= _model_refs_from_payload(item.get("model"))
    return sorted(refs)


def _runtime_catalog_entries(
    *,
    runtime_refs: set[str],
    configured_refs: set[str],
    default_ref: str | None,
) -> list[GatewayRuntimeCatalogEntry]:
    entries: list[GatewayRuntimeCatalogEntry] = []
    all_refs = runtime_refs | configured_refs
    if default_ref:
        all_refs.add(default_ref)
    for ref in sorted(all_refs):
        provider, _, _model_id = ref.partition("/")
        provider = provider.strip() or "unknown"
        is_runtime_verified = ref in runtime_refs
        entries.append(
            GatewayRuntimeCatalogEntry(
                ref=ref,
                provider=provider,
                provider_label=_catalog_provider_label(provider),
                label=_catalog_label(ref),
                verification_state=("runtime" if is_runtime_verified else "configured"),
                selectable=is_runtime_verified,
                is_default=ref == default_ref,
            ),
        )
    return entries


def _extract_numeric(payload: dict[str, Any], *keys: str) -> int | float | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, str):
            try:
                return float(value) if "." in value else int(value)
            except ValueError:
                continue
    return None


def _extract_usage_entries(payload: object) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    entries: list[dict[str, Any]] = []
    for key in ("items", "entries", "rows", "usage", "models", "costs"):
        raw = payload.get(key)
        if isinstance(raw, list):
            entries.extend(item for item in raw if isinstance(item, dict))
        elif isinstance(raw, dict):
            for sub_key, sub_value in raw.items():
                if not isinstance(sub_value, dict):
                    continue
                entry = dict(sub_value)
                entry.setdefault("model", sub_key)
                entries.append(entry)
    if entries:
        return entries
    return [payload]


def _build_usage_samples_from_payload(
    *,
    gateway: Gateway,
    source: str,
    payload: object,
) -> list[UsageSampleCreate]:
    entries = _extract_usage_entries(payload)
    samples: list[UsageSampleCreate] = []
    for entry in entries:
        model = entry.get("model") or entry.get("id") or entry.get("name")
        if isinstance(model, dict):
            model = None
        prompt_tokens = _extract_numeric(entry, "promptTokens", "inputTokens", "prompt_tokens")
        completion_tokens = _extract_numeric(
            entry,
            "completionTokens",
            "outputTokens",
            "completion_tokens",
        )
        total_tokens = _extract_numeric(entry, "totalTokens", "tokens", "total_tokens")
        cost_usd = _extract_numeric(entry, "costUsd", "usd", "estimatedCostUsd", "cost")
        sample = UsageSampleCreate(
            gateway_id=gateway.id,
            source=source,
            model=model if isinstance(model, str) else None,
            prompt_tokens=int(prompt_tokens or 0),
            completion_tokens=int(completion_tokens or 0),
            total_tokens=int(total_tokens) if isinstance(total_tokens, (int, float)) else None,
            cost_usd=float(cost_usd or 0.0),
            raw_payload=entry,
            ingestion_note="Imported from gateway RPC usage snapshot.",
        )
        samples.append(sample)
    return samples


class GatewayRuntimeControlService(OpenClawDBService):
    """Manage safe Mission Control -> OpenClaw runtime synchronization."""

    async def _find_main_agent(self, gateway: Gateway) -> Agent | None:
        return await self._find_gateway_agent_by_session_key(
            gateway=gateway,
            session_key=MAIN_AGENT_SPEC.session_key(gateway),
        )

    async def _find_gateway_agent_by_session_key(
        self,
        *,
        gateway: Gateway,
        session_key: str,
    ) -> Agent | None:
        return (
            await Agent.objects.filter_by(gateway_id=gateway.id)
            .filter(col(Agent.board_id).is_(None))
            .filter(col(Agent.openclaw_session_id) == session_key)
            .first(self.session)
        )

    async def _upsert_main_agent_record(self, gateway: Gateway) -> tuple[Agent, bool]:
        return await self._upsert_gateway_agent_record(gateway=gateway, spec=MAIN_AGENT_SPEC)

    async def _upsert_gateway_agent_record(
        self,
        *,
        gateway: Gateway,
        spec: GatewayManagedAgentSpec,
    ) -> tuple[Agent, bool]:
        existing = await self._find_gateway_agent_by_session_key(
            gateway=gateway,
            session_key=spec.session_key(gateway),
        )
        agent, changed = apply_gateway_managed_agent_spec(
            gateway=gateway,
            spec=spec,
            agent=existing,
        )
        if changed:
            self.session.add(agent)
        return agent, changed

    async def _ensure_gateway_managed_agents(self, gateway: Gateway) -> list[Agent]:
        changed = False
        for spec in MANAGED_GATEWAY_AGENT_SPECS:
            _agent, spec_changed = await self._upsert_gateway_agent_record(
                gateway=gateway,
                spec=spec,
            )
            changed = changed or spec_changed
        if changed:
            await self.session.commit()
        return list(await Agent.objects.filter_by(gateway_id=gateway.id).all(self.session))

    async def _ensure_gateway_default_model_profiles(
        self,
        *,
        gateway: Gateway,
        available_models: Iterable[str],
    ) -> bool:
        available = set(available_models)
        if STARTER_PACK_PRIMARY_MODEL_REF not in available:
            return False
        profiles = _load_model_profiles(gateway)
        changed = False
        for profile_name in PROFILE_NAMES:
            selection = _profile_selection(profiles, profile_name)
            if selection is not None and selection.primary_model:
                continue
            setattr(
                profiles,
                profile_name,
                ModelSelection(
                    primary_model=STARTER_PACK_PRIMARY_MODEL_REF,
                    fallback_models=[],
                ),
            )
            changed = True
        if changed:
            gateway.default_model_profile = "general"
            gateway.model_profiles = profiles.model_dump(mode="json", exclude_none=True)
            self.session.add(gateway)
            await self.session.commit()
        return changed

    async def _gateway_models_payload(self, gateway: Gateway) -> object:
        return await openclaw_call("models.list", config=_gateway_client_config(gateway))

    async def runtime_catalog(self, gateway: Gateway) -> list[GatewayRuntimeCatalogEntry]:
        runtime_refs = set(_available_model_refs(await self._gateway_models_payload(gateway)))
        configured_refs: set[str] = set()
        try:
            _base_hash, config_data = await self._load_gateway_config(gateway)
        except OpenClawGatewayError:
            config_data = {}
        configured_refs.update(_config_declared_model_refs(config_data))
        default_selection = resolve_default_model_selection(gateway)
        return _runtime_catalog_entries(
            runtime_refs=runtime_refs,
            configured_refs=configured_refs,
            default_ref=(default_selection.primary_model if default_selection else None),
        )

    async def available_models(self, gateway: Gateway) -> list[str]:
        return [entry.ref for entry in await self.runtime_catalog(gateway) if entry.selectable]

    async def _load_gateway_config(self, gateway: Gateway) -> tuple[str | None, dict[str, Any]]:
        payload = await openclaw_call("config.get", config=_gateway_client_config(gateway))
        if not isinstance(payload, dict):
            raise OpenClawGatewayError("config.get returned invalid payload")
        config_data = payload.get("config") or payload.get("parsed") or {}
        if not isinstance(config_data, dict):
            raise OpenClawGatewayError("config.get returned invalid config")
        return payload.get("hash"), config_data

    async def _load_gateway_config_with_retry(
        self,
        gateway: Gateway,
        *,
        context: str,
    ) -> tuple[str | None, dict[str, Any]]:
        backoff = GatewayBackoff(
            timeout_s=45.0,
            base_delay_s=0.5,
            max_delay_s=5.0,
            jitter=0.15,
            timeout_context=context,
        )
        return await backoff.run(lambda: self._load_gateway_config(gateway))

    async def assert_model_policies_supported(
        self,
        *,
        gateway: Gateway,
        agents: Iterable[Agent] | None = None,
    ) -> list[str]:
        """Validate configured gateway/agent models against runtime support."""
        desired_refs: set[str] = set()
        default_selection = resolve_default_model_selection(gateway)
        if default_selection is not None:
            desired_refs.add(default_selection.primary_model or "")
            desired_refs.update(default_selection.fallback_models)
        profiles = _load_model_profiles(gateway)
        for name in PROFILE_NAMES:
            selection = _profile_selection(profiles, name)
            if selection is None or selection.primary_model is None:
                continue
            desired_refs.add(selection.primary_model)
            desired_refs.update(selection.fallback_models)
        for agent in agents or []:
            selection = resolve_agent_model_selection(gateway=gateway, agent=agent)
            if selection is None or selection.primary_model is None:
                continue
            desired_refs.add(selection.primary_model)
            desired_refs.update(selection.fallback_models)

        desired_refs = {value for value in desired_refs if value}
        if not desired_refs:
            return []

        available = set(await self.available_models(gateway))
        if not available:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Gateway did not return any runtime models for validation.",
            )
        if (
            gateway.model_profiles in ({}, None)
            and DEFAULT_PRIMARY_MODEL_REF in desired_refs
            and DEFAULT_PRIMARY_MODEL_REF not in available
            and STARTER_PACK_PRIMARY_MODEL_REF in available
        ):
            desired_refs.discard(DEFAULT_PRIMARY_MODEL_REF)
        unsupported = sorted(desired_refs - available)
        if unsupported:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"Unsupported runtime models: {', '.join(unsupported)}",
            )
        return sorted(available)

    async def runtime_summary(self, *, gateway: Gateway) -> GatewayRuntimeSummary:
        catalog: list[GatewayRuntimeCatalogEntry] = []
        available_models: list[str] = []
        default_selection = resolve_default_model_selection(gateway)
        try:
            catalog = await self.runtime_catalog(gateway)
            available_models = [entry.ref for entry in catalog if entry.selectable]
        except OpenClawGatewayError:
            catalog = []
            available_models = []
        return GatewayRuntimeSummary(
            gateway_id=gateway.id,
            runtime_sync_generation=gateway.runtime_sync_generation,
            last_runtime_sync_at=gateway.last_runtime_sync_at,
            last_runtime_sync_error=gateway.last_runtime_sync_error,
            default_model_profile=gateway.default_model_profile,
            default_model_ref=(default_selection.primary_model if default_selection else None),
            model_profiles=_load_model_profiles(gateway),
            catalog=catalog,
            available_models=available_models,
        )

    async def _get_existing_agent_token(
        self,
        *,
        gateway: Gateway,
        agent: Agent,
    ) -> str | None:
        control_plane = OpenClawGatewayControlPlane(_gateway_client_config(gateway))
        gateway_agent_id = runtime_agent_identifier(gateway, agent)
        try:
            payload = await control_plane.get_agent_file_payload(
                agent_id=gateway_agent_id, name="TOOLS.md"
            )
        except OpenClawGatewayError:
            return None
        content: str | None = None
        if isinstance(payload, str):
            content = payload
        elif isinstance(payload, dict):
            raw = payload.get("content")
            if isinstance(raw, str):
                content = raw
            elif isinstance(payload.get("file"), dict):
                nested = payload["file"].get("content")
                if isinstance(nested, str):
                    content = nested
        if not content:
            return None
        values = _parse_tools_content(content)
        token = (values.get("AUTH_TOKEN") or "").strip()
        return token or None

    async def _repair_agent_runtime(
        self,
        *,
        gateway: Gateway,
        agent: Agent,
        auth: AuthContext,
        wake_agents: bool,
    ) -> bool:
        board = None
        if agent.board_id is not None:
            board = await Board.objects.by_id(agent.board_id).first(self.session)
        wake_after_repair = wake_agents and not is_gateway_execution_agent(agent)
        existing_token = await self._get_existing_agent_token(gateway=gateway, agent=agent)
        try:
            await AgentLifecycleOrchestrator(self.session).run_lifecycle(
                gateway=gateway,
                agent_id=agent.id,
                board=board,
                user=auth.user,
                action="update",
                auth_token=existing_token,
                force_bootstrap=False,
                reset_session=True,
                wake=wake_after_repair,
                deliver_wakeup=wake_after_repair,
                wakeup_verb=("updated" if wake_after_repair else None),
                clear_confirm_token=True,
                raise_gateway_errors=True,
            )
        except HTTPException:
            return False
        agent.last_runtime_sync_at = utcnow()
        self.session.add(agent)
        await self.session.commit()
        await self.session.refresh(agent)
        return True

    async def sync_model_policies(
        self,
        *,
        gateway: Gateway,
        agents: Iterable[Agent] | None = None,
        auth: AuthContext | None = None,
    ) -> bool:
        """Patch gateway runtime config for Mission Control model policy state."""
        managed_agents = (
            list(agents)
            if agents is not None
            else list(await Agent.objects.filter_by(gateway_id=gateway.id).all(self.session))
        )
        _, config_data = await self._load_gateway_config_with_retry(
            gateway,
            context="gateway runtime sync bootstrap",
        )
        agents_section = config_data.get("agents")
        if not isinstance(agents_section, dict):
            agents_section = {}
        defaults = agents_section.get("defaults")
        if not isinstance(defaults, dict):
            defaults = {}
        existing_catalog = defaults.get("models")
        catalog: dict[str, Any] = (
            dict(existing_catalog) if isinstance(existing_catalog, dict) else {}
        )
        existing_list = agents_section.get("list")
        raw_agent_list = list(existing_list) if isinstance(existing_list, list) else []
        selection_by_id: dict[str, object | None] = {}

        default_selection = resolve_default_model_selection(gateway)
        desired_default_payload = _model_payload(default_selection)
        desired_refs: set[str] = set()
        if default_selection is not None and default_selection.primary_model:
            desired_refs.add(default_selection.primary_model)
            desired_refs.update(default_selection.fallback_models)
        for agent in managed_agents:
            resolved = resolve_agent_model_selection(gateway=gateway, agent=agent)
            payload = _model_payload(resolved)
            agent_key = runtime_agent_identifier(gateway, agent)
            selection_by_id[agent_key] = payload
            if resolved is not None and resolved.primary_model:
                desired_refs.add(resolved.primary_model)
                desired_refs.update(resolved.fallback_models)

        available = set(await self.available_models(gateway))
        unsupported = sorted(ref for ref in desired_refs if ref not in available)
        if unsupported:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"Unsupported runtime models: {', '.join(unsupported)}",
            )

        catalog_changed = False
        for ref in sorted(desired_refs):
            if ref not in catalog:
                catalog[ref] = {}
                catalog_changed = True

        list_changed = False
        updated_list: list[object] = []
        for item in raw_agent_list:
            if not isinstance(item, dict):
                updated_list.append(item)
                continue
            agent_id = item.get("id")
            if not isinstance(agent_id, str) or agent_id not in selection_by_id:
                updated_list.append(item)
                continue
            desired_payload = selection_by_id[agent_id]
            updated_entry = dict(item)
            if desired_payload is None:
                if "model" in updated_entry:
                    updated_entry.pop("model", None)
                    list_changed = True
            elif updated_entry.get("model") != desired_payload:
                updated_entry["model"] = desired_payload
                list_changed = True
            updated_list.append(updated_entry)

        default_changed = (
            desired_default_payload is not None and defaults.get("model") != desired_default_payload
        )
        if not catalog_changed and not list_changed and not default_changed:
            return False

        patch: dict[str, Any] = {"agents": {"list": updated_list, "defaults": {"models": catalog}}}
        if desired_default_payload is not None:
            patch["agents"]["defaults"]["model"] = desired_default_payload

        base_hash, _ = await self._load_gateway_config_with_retry(
            gateway,
            context="gateway runtime sync base hash",
        )
        params: dict[str, Any] = {"raw": json.dumps(patch)}
        if base_hash:
            params["baseHash"] = base_hash
        try:
            await openclaw_call("config.patch", params, config=_gateway_client_config(gateway))
        except OpenClawGatewayError as exc:
            if not _is_transient_runtime_patch_error(exc):
                raise
            recovered_hash, recovered_config = await self._load_gateway_config_with_retry(
                gateway,
                context="gateway runtime sync recovery",
            )
            recovered_agents = recovered_config.get("agents")
            recovered_defaults = (
                recovered_agents.get("defaults") if isinstance(recovered_agents, dict) else {}
            )
            recovered_list = (
                recovered_agents.get("list") if isinstance(recovered_agents, dict) else []
            )
            if (
                recovered_list == updated_list
                and isinstance(recovered_defaults, dict)
                and recovered_defaults.get("models") == catalog
                and (
                    desired_default_payload is None
                    or recovered_defaults.get("model") == desired_default_payload
                )
            ):
                base_hash = recovered_hash
            else:
                retry_params: dict[str, Any] = {"raw": json.dumps(patch)}
                if recovered_hash:
                    retry_params["baseHash"] = recovered_hash
                backoff = GatewayBackoff(
                    timeout_s=45.0,
                    base_delay_s=0.5,
                    max_delay_s=5.0,
                    jitter=0.15,
                    timeout_context="gateway runtime sync patch retry",
                )
                await backoff.run(
                    lambda: openclaw_call(
                        "config.patch",
                        retry_params,
                        config=_gateway_client_config(gateway),
                    )
                )

        now = utcnow()
        gateway.runtime_sync_generation += 1
        gateway.last_runtime_sync_at = now
        gateway.last_runtime_sync_error = None
        self.session.add(gateway)
        for agent in managed_agents:
            agent.last_runtime_sync_at = now
            self.session.add(agent)
        await self.session.commit()

        if auth is not None:
            record_activity(
                self.session,
                event_type="gateway.runtime.sync",
                message=f"Synced runtime model policy for gateway {gateway.name}.",
                entity_type="gateway",
                entity_id=str(gateway.id),
                previous_values=None,
                new_values={"default_model_profile": gateway.default_model_profile},
                details={"synced_agents": [str(agent.id) for agent in managed_agents]},
                **actor_fields_from_auth(auth),
            )
            await self.session.commit()
        return True

    async def pull_gateway_usage(
        self,
        *,
        gateway: Gateway,
        auth: AuthContext,
    ) -> int:
        """Fetch gateway usage RPC snapshots and persist them as telemetry samples."""
        warnings: list[str] = []
        payloads: list[tuple[str, object]] = []
        for method in ("usage.cost", "usage.status"):
            try:
                payloads.append(
                    (method, await openclaw_call(method, config=_gateway_client_config(gateway)))
                )
            except OpenClawGatewayError as exc:
                warnings.append(f"{method}: {exc}")
        service = UsageTelemetryService(self.session)
        samples: list[UsageSampleCreate] = []
        for method, payload in payloads:
            samples.extend(
                _build_usage_samples_from_payload(
                    gateway=gateway,
                    source=method,
                    payload=payload,
                ),
            )
        if not samples:
            return 0
        await service.store_gateway_pull_samples(gateway=gateway, samples=samples)
        gateway.last_telemetry_collected_at = utcnow()
        self.session.add(gateway)
        await self.session.commit()
        record_activity(
            self.session,
            event_type="gateway.telemetry.pull",
            message=f"Pulled {len(samples)} usage samples from gateway {gateway.name}.",
            entity_type="gateway",
            entity_id=str(gateway.id),
            details={"warnings": warnings, "sample_count": len(samples)},
            **actor_fields_from_auth(auth),
        )
        await self.session.commit()
        return len(samples)

    async def reconcile_gateway_runtime(
        self,
        *,
        gateway: Gateway,
        auth: AuthContext,
        request: GatewayRuntimeSyncRequest,
    ) -> GatewayRuntimeSyncResponse:
        """Idempotently repair stuck provisioning and sync model/runtime state."""
        warnings: list[str] = []
        all_agents = await self._ensure_gateway_managed_agents(gateway)
        available_models = []
        try:
            available_models = await self.available_models(gateway)
        except OpenClawGatewayError:
            available_models = []
        if available_models:
            await self._ensure_gateway_default_model_profiles(
                gateway=gateway,
                available_models=available_models,
            )
            all_agents = list(await Agent.objects.filter_by(gateway_id=gateway.id).all(self.session))
        repaired_agents: list[Any] = []
        skipped_agents: list[Any] = []
        if request.repair_stuck_agents:
            for agent in all_agents:
                if (
                    agent.status not in {"provisioning", "updating"}
                    and not agent.last_provision_error
                ):
                    continue
                repaired = await self._repair_agent_runtime(
                    gateway=gateway,
                    agent=agent,
                    auth=auth,
                    wake_agents=request.wake_agents,
                )
                if repaired:
                    repaired_agents.append(agent.id)
                else:
                    skipped_agents.append(agent.id)
                    warnings.append(f"Unable to repair agent {agent.id}")

        synced_models = False
        if request.sync_models:
            try:
                synced_models = await self.sync_model_policies(
                    gateway=gateway,
                    agents=all_agents,
                    auth=auth,
                )
            except HTTPException as exc:
                gateway.last_runtime_sync_error = str(exc.detail)
                self.session.add(gateway)
                await self.session.commit()
                raise
            except OpenClawGatewayError as exc:
                gateway.last_runtime_sync_error = str(exc)
                self.session.add(gateway)
                await self.session.commit()
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"Runtime sync failed: {exc}",
                ) from exc

        return GatewayRuntimeSyncResponse(
            gateway_id=gateway.id,
            repaired_agents=repaired_agents,
            skipped_agents=skipped_agents,
            sync_generation=gateway.runtime_sync_generation,
            synced_models=synced_models,
            warnings=warnings,
        )
