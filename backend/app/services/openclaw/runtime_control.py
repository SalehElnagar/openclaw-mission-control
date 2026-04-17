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
    GatewayModelCost,
    GatewayModelDefinition,
    GatewayModelProfiles,
    GatewayProviderAuthChallenge,
    GatewayProviderAuthConfig,
    GatewayProviderConfig,
    GatewayProviderSecretRef,
    GatewayProviderAuthActionResponse,
    GatewayRuntimeCatalogEntry,
    GatewayRuntimeProviderSummary,
    GatewayRuntimeSummary,
    GatewayRuntimeSyncRequest,
    GatewayRuntimeSyncResponse,
    GatewayToolProfilePolicy,
    ModelSelection,
    ProviderAuthMode,
    ToolProfileName,
    _normalize_provider_auth_configs,
    _normalize_provider_auth_mode,
    _normalize_model_definitions,
    _normalize_model_list,
    _normalize_model_ref,
    _normalize_provider_configs,
    _normalize_provider_secret_refs,
    _normalize_tool_profile,
)
from app.schemas.telemetry import UsageSampleCreate
from app.services.activity_log import actor_fields_from_auth, record_activity
from app.services.gateway_secret_store import GatewaySecretStoreService
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
TOOL_PROFILE_SUMMARIES: dict[str, str] = {
    "restricted": "Tight execution posture with workspace-only filesystem access and browser disabled.",
    "coding": "Balanced coding posture with workspace-only filesystem access and browser disabled.",
    "research": "Research-oriented posture with workspace-only filesystem access and browser disabled.",
    "browser-assisted": "Coding posture plus browser access for nodes that explicitly support browser-assisted workflows.",
}
DEFAULT_PRIMARY_MODEL_REF = "openai-codex/gpt-5.4"
KNOWN_PROVIDER_LABELS: dict[str, str] = {
    "microsoft-foundry": "Azure Foundry",
    "openai-codex": "Codex",
    "github-copilot": "GitHub Copilot",
    "github-models": "GitHub Models",
    "anthropic": "Claude",
    "claude": "Claude",
    "claude-cli": "Claude Code",
    "google-gemini": "Google Gemini",
    "google-gemini-cli": "Google Gemini CLI",
    "google-antigravity": "Antigravity",
    "antigravity": "Antigravity",
}
KNOWN_MODEL_LABELS: dict[str, str] = {
    "microsoft-foundry/model-router": "Azure Foundry Model Router",
    "microsoft-foundry/gpt-5.4-mini": "Azure Foundry GPT-5.4 Mini",
    "openai-codex/gpt-5.4": "Codex GPT-5.4",
    "github-copilot/gpt-5": "GitHub Copilot GPT-5",
    "github-copilot/gpt-5.4": "GitHub Copilot GPT-5.4",
    "github-models/openai/gpt-4.1": "GitHub Models OpenAI GPT-4.1",
    "github-models/openai/gpt-4o": "GitHub Models OpenAI GPT-4o",
    "anthropic/claude-sonnet-4-6": "Claude Sonnet 4.6",
    "anthropic/claude-opus-4-6": "Claude Opus 4.6",
    "claude/claude-sonnet-4": "Claude Sonnet 4",
    "claude-cli/claude-sonnet-4-6": "Claude Code Sonnet 4.6",
    "claude-cli/claude-opus-4-6": "Claude Code Opus 4.6",
    "google-gemini/gemini-2.5-flash": "Google Gemini 2.5 Flash",
    "google-gemini/gemini-2.5-pro": "Google Gemini 2.5 Pro",
    "google-gemini-cli/gemini-3.1-pro-preview": "Google Gemini CLI 3.1 Pro Preview",
    "google-antigravity/claude-opus-4-6-thinking": "Antigravity Claude Opus 4.6 Thinking",
    "antigravity/operator": "Antigravity Operator",
}

PROVIDER_AUTH_CHALLENGE_TITLE_KEYS = (
    "title",
    "label",
    "displayName",
    "display_label",
    "providerLabel",
    "provider_label",
)
PROVIDER_AUTH_CHALLENGE_MESSAGE_KEYS = (
    "message",
    "detail",
    "description",
    "instruction",
)
PROVIDER_AUTH_CHALLENGE_INSTRUCTION_KEYS = (
    "instructions",
    "steps",
    "prompts",
)
PROVIDER_AUTH_CHALLENGE_ACTION_LABEL_KEYS = (
    "actionLabel",
    "action_label",
    "buttonLabel",
    "button_label",
    "ctaLabel",
    "cta_label",
    "openLabel",
    "open_label",
)
PROVIDER_AUTH_CHALLENGE_ACTION_URL_KEYS = (
    "actionUrl",
    "action_url",
    "authUrl",
    "auth_url",
    "browserUrl",
    "browser_url",
    "loginUrl",
    "login_url",
    "verificationUrl",
    "verification_url",
    "verificationUri",
    "verification_uri",
    "url",
)
PROVIDER_AUTH_CHALLENGE_CODE_KEYS = (
    "code",
    "userCode",
    "user_code",
    "deviceCode",
    "device_code",
    "oneTimeCode",
    "one_time_code",
    "pin",
)


def _normalize_text_value(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _extract_text_from_candidates(
    candidates: list[dict[str, Any]],
    keys: tuple[str, ...],
) -> str | None:
    for candidate in candidates:
        for key in keys:
            normalized = _normalize_text_value(candidate.get(key))
            if normalized:
                return normalized
    return None


def _extract_instruction_list(value: object) -> list[str]:
    if isinstance(value, str):
        normalized = value.strip()
        return [normalized] if normalized else []
    if not isinstance(value, list):
        return []
    instructions: list[str] = []
    for item in value:
        normalized = _normalize_text_value(item)
        if normalized:
            instructions.append(normalized)
    return instructions


def _extract_instructions_from_candidates(
    candidates: list[dict[str, Any]],
) -> list[str]:
    instructions: list[str] = []
    for candidate in candidates:
        for key in PROVIDER_AUTH_CHALLENGE_INSTRUCTION_KEYS:
            instructions.extend(_extract_instruction_list(candidate.get(key)))
        for key in PROVIDER_AUTH_CHALLENGE_MESSAGE_KEYS:
            value = candidate.get(key)
            if isinstance(value, list):
                instructions.extend(_extract_instruction_list(value))
    deduped: list[str] = []
    for instruction in instructions:
        if instruction not in deduped:
            deduped.append(instruction)
    return deduped


def _provider_auth_challenge_candidates(payload: object) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    candidates = [payload]
    for key in ("challenge", "browser", "verification", "device", "oauth", "login"):
        nested = payload.get(key)
        if isinstance(nested, dict):
            candidates.append(nested)
    return candidates


def _normalize_provider_auth_challenge(
    payload: object,
) -> GatewayProviderAuthChallenge | None:
    if isinstance(payload, str):
        normalized = _normalize_text_value(payload)
        return GatewayProviderAuthChallenge(message=normalized) if normalized else None

    candidates = _provider_auth_challenge_candidates(payload)
    if not candidates:
        return None

    instructions = _extract_instructions_from_candidates(candidates)
    challenge = GatewayProviderAuthChallenge(
        title=_extract_text_from_candidates(
            candidates,
            PROVIDER_AUTH_CHALLENGE_TITLE_KEYS,
        ),
        message=_extract_text_from_candidates(
            candidates,
            PROVIDER_AUTH_CHALLENGE_MESSAGE_KEYS,
        ),
        instructions=instructions,
        action_label=_extract_text_from_candidates(
            candidates,
            PROVIDER_AUTH_CHALLENGE_ACTION_LABEL_KEYS,
        ),
        action_url=_extract_text_from_candidates(
            candidates,
            PROVIDER_AUTH_CHALLENGE_ACTION_URL_KEYS,
        ),
        code=_extract_text_from_candidates(
            candidates,
            PROVIDER_AUTH_CHALLENGE_CODE_KEYS,
        ),
    )
    if not any(
        [
            challenge.title,
            challenge.message,
            challenge.instructions,
            challenge.action_label,
            challenge.action_url,
            challenge.code,
        ],
    ):
        return None
    return challenge


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


def _load_provider_configs(gateway: Gateway) -> list[GatewayProviderConfig] | None:
    return _normalize_provider_configs(gateway.provider_configs)


def _load_model_definitions(gateway: Gateway) -> list[GatewayModelDefinition] | None:
    return _normalize_model_definitions(gateway.model_definitions)


def _load_provider_auth_configs(gateway: Gateway) -> list[GatewayProviderAuthConfig] | None:
    return _normalize_provider_auth_configs(gateway.provider_auth_configs)


def _load_provider_secret_refs(gateway: Gateway) -> list[GatewayProviderSecretRef] | None:
    return _normalize_provider_secret_refs(gateway.provider_secret_refs)


def _load_tool_profile(gateway: Gateway) -> ToolProfileName | None:
    return _normalize_tool_profile(gateway.tool_profile)


def _load_model_profiles(gateway: Gateway) -> GatewayModelProfiles:
    raw = gateway.model_profiles or {}
    if isinstance(raw, GatewayModelProfiles):
        return raw
    if not isinstance(raw, dict):
        return GatewayModelProfiles()
    return GatewayModelProfiles.model_validate(raw)


def _configured_enabled_model_refs(gateway: Gateway) -> list[str] | None:
    raw = gateway.enabled_model_refs
    if not isinstance(raw, list):
        return None
    return _dedupe_models(value for value in raw if isinstance(value, str)) or None


def _config_provider_configs(config_data: dict[str, Any]) -> list[GatewayProviderConfig]:
    models_section = config_data.get("models")
    if not isinstance(models_section, dict):
        return []
    providers = models_section.get("providers")
    if not isinstance(providers, dict):
        return []
    parsed: list[GatewayProviderConfig] = []
    for provider_id, provider_config in providers.items():
        if not isinstance(provider_id, str) or not isinstance(provider_config, dict):
            continue
        parsed.append(
            GatewayProviderConfig(
                id=provider_id,
                provider_type=str(provider_config.get("type") or provider_id),
                label=_catalog_provider_label(provider_id),
                base_url=(
                    provider_config.get("baseUrl")
                    if isinstance(provider_config.get("baseUrl"), str)
                    else None
                ),
                api_mode=(
                    provider_config.get("api")
                    if isinstance(provider_config.get("api"), str)
                    else None
                ),
                auth_header=(
                    provider_config.get("authHeader")
                    if isinstance(provider_config.get("authHeader"), bool)
                    else None
                ),
                headers=(
                    {
                        str(header_name).strip(): str(header_value).strip()
                        for header_name, header_value in provider_config.get("headers", {}).items()
                        if isinstance(header_name, str)
                        and header_name.strip()
                        and isinstance(header_value, str)
                        and header_value.strip()
                    }
                    if isinstance(provider_config.get("headers"), dict)
                    else None
                ),
            ),
        )
    return sorted(parsed, key=lambda item: item.id)


def _config_model_definitions(config_data: dict[str, Any]) -> list[GatewayModelDefinition]:
    models_section = config_data.get("models")
    if not isinstance(models_section, dict):
        return []
    providers = models_section.get("providers")
    if not isinstance(providers, dict):
        return []
    parsed: list[GatewayModelDefinition] = []
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
            if not isinstance(model_id, str) or not model_id.strip():
                continue
            parsed.append(
                GatewayModelDefinition(
                    provider_id=provider_id,
                    model_id=model_id.strip(),
                    label=item.get("name") if isinstance(item.get("name"), str) else None,
                    api_mode=item.get("api") if isinstance(item.get("api"), str) else None,
                    reasoning=(
                        item.get("reasoning") if isinstance(item.get("reasoning"), bool) else None
                    ),
                    input_modalities=(
                        [
                            str(value).strip()
                            for value in item.get("input", [])
                            if str(value).strip()
                        ]
                        if isinstance(item.get("input"), list)
                        else []
                    ),
                    context_window=(
                        item.get("contextWindow")
                        if isinstance(item.get("contextWindow"), int)
                        else None
                    ),
                    max_tokens=(
                        item.get("maxTokens") if isinstance(item.get("maxTokens"), int) else None
                    ),
                    cost=(
                        GatewayModelCost.model_validate(item["cost"])
                        if isinstance(item.get("cost"), dict)
                        else None
                    ),
                ),
            )
    return sorted(parsed, key=lambda item: (item.provider_id, item.model_id))


def _secret_ref_label_from_runtime_value(
    value: object,
    *,
    config_data: dict[str, Any],
) -> str | None:
    if not isinstance(value, dict):
        return None
    provider_name = value.get("provider")
    secret_id = value.get("id")
    source = value.get("source")
    if not isinstance(provider_name, str) or not isinstance(secret_id, str):
        return None
    default_env_provider = _default_env_secret_provider(config_data)
    if source == "env" and provider_name == default_env_provider:
        return f"env:{secret_id}"
    return f"{provider_name}:{secret_id}"


def _config_provider_auth_configs(
    config_data: dict[str, Any],
) -> list[GatewayProviderAuthConfig]:
    auth_section = config_data.get("auth")
    if not isinstance(auth_section, dict):
        return []
    profiles = auth_section.get("profiles")
    orders = auth_section.get("order")
    if not isinstance(profiles, dict):
        profiles = {}
    if not isinstance(orders, dict):
        orders = {}

    deduped: dict[str, GatewayProviderAuthConfig] = {}
    order: list[str] = []

    def _append(provider_id: str, profile_id: str, profile_data: dict[str, Any]) -> None:
        normalized_mode = _normalize_provider_auth_mode(profile_data.get("mode"))
        if normalized_mode == "api-key":
            mode: ProviderAuthMode = "api-key"
        elif normalized_mode == "token":
            mode = "token"
        elif normalized_mode == "login":
            mode = "login"
        else:
            mode = "oauth"
        secret_refs: list[GatewayProviderSecretRef] = []
        if mode == "api-key":
            key_ref = _secret_ref_label_from_runtime_value(
                profile_data.get("keyRef"),
                config_data=config_data,
            )
            if key_ref:
                secret_refs.append(
                    GatewayProviderSecretRef(
                        provider_id=provider_id,
                        purpose="apiKey",
                        ref=key_ref,
                    ),
                )
        elif mode == "token":
            token_ref = _secret_ref_label_from_runtime_value(
                profile_data.get("tokenRef"),
                config_data=config_data,
            )
            if token_ref:
                secret_refs.append(
                    GatewayProviderSecretRef(
                        provider_id=provider_id,
                        purpose="token",
                        ref=token_ref,
                    ),
                )
        config = GatewayProviderAuthConfig(
            provider_id=provider_id,
            auth_mode=mode,
            profile_id=profile_id if mode in {"oauth", "login"} else None,
            display_label=(
                profile_data.get("displayName")
                if isinstance(profile_data.get("displayName"), str)
                else None
            ),
            secret_refs=secret_refs,
        )
        if provider_id not in order:
            order.append(provider_id)
        deduped[provider_id] = config

    for provider_id, raw_profile_ids in orders.items():
        if not isinstance(provider_id, str):
            continue
        profile_ids = raw_profile_ids if isinstance(raw_profile_ids, list) else []
        for raw_profile_id in profile_ids:
            if not isinstance(raw_profile_id, str):
                continue
            profile_data = profiles.get(raw_profile_id)
            if isinstance(profile_data, dict):
                _append(provider_id, raw_profile_id, profile_data)
                break

    for profile_id, raw_profile in profiles.items():
        if not isinstance(profile_id, str) or not isinstance(raw_profile, dict):
            continue
        provider_id = raw_profile.get("provider")
        if not isinstance(provider_id, str) or provider_id in deduped:
            continue
        _append(provider_id, profile_id, raw_profile)

    return [deduped[key] for key in order]


def _config_provider_secret_refs(config_data: dict[str, Any]) -> list[GatewayProviderSecretRef]:
    models_section = config_data.get("models")
    if not isinstance(models_section, dict):
        return []
    providers = models_section.get("providers")
    if not isinstance(providers, dict):
        return []
    parsed: list[GatewayProviderSecretRef] = []
    for provider_id, provider_config in providers.items():
        if not isinstance(provider_id, str) or not isinstance(provider_config, dict):
            continue
        api_key_ref = _secret_ref_label_from_runtime_value(
            provider_config.get("apiKey"),
            config_data=config_data,
        )
        if api_key_ref:
            parsed.append(
                GatewayProviderSecretRef(
                    provider_id=provider_id,
                    purpose="apiKey",
                    ref=api_key_ref,
                ),
            )
        headers = provider_config.get("headers")
        if not isinstance(headers, dict):
            continue
        for header_name, header_value in headers.items():
            if not isinstance(header_name, str):
                continue
            header_ref = _secret_ref_label_from_runtime_value(
                header_value,
                config_data=config_data,
            )
            if not header_ref:
                continue
            parsed.append(
                GatewayProviderSecretRef(
                    provider_id=provider_id,
                    purpose=f"header:{header_name}",
                    ref=header_ref,
                ),
            )
    normalized = _normalize_provider_secret_refs(
        [item.model_dump(exclude_none=True) for item in parsed],
    )
    return normalized or []


def _default_env_secret_provider(config_data: dict[str, Any]) -> str | None:
    secrets_section = config_data.get("secrets")
    if not isinstance(secrets_section, dict):
        return None
    defaults = secrets_section.get("defaults")
    if isinstance(defaults, dict):
        env_provider = defaults.get("env")
        if isinstance(env_provider, str) and env_provider.strip():
            return env_provider.strip()
    providers = secrets_section.get("providers")
    if not isinstance(providers, dict):
        return None
    for provider_name, provider_config in providers.items():
        if not isinstance(provider_name, str) or not isinstance(provider_config, dict):
            continue
        if provider_config.get("source") == "env":
            return provider_name
    return None


def _secret_provider_source(
    config_data: dict[str, Any],
    provider_name: str,
) -> str | None:
    secrets_section = config_data.get("secrets")
    if not isinstance(secrets_section, dict):
        return None
    providers = secrets_section.get("providers")
    if not isinstance(providers, dict):
        return None
    provider_config = providers.get(provider_name)
    if not isinstance(provider_config, dict):
        return None
    source = provider_config.get("source")
    return source.strip() if isinstance(source, str) and source.strip() else None


async def _resolve_secret_ref_value(
    ref: str,
    *,
    gateway: Gateway,
    config_data: dict[str, Any],
    secret_store: GatewaySecretStoreService | None = None,
) -> tuple[dict[str, str] | str | None, str | None]:
    prefix, separator, secret_id = ref.partition(":")
    if not separator or not secret_id.strip():
        return None, "Secret refs must use env:NAME, provider:secret-id, or managed:uuid syntax."
    if prefix == "managed":
        if secret_store is None:
            return None, "Managed secret refs require Mission Control secret storage."
        return await secret_store.resolve_managed_ref(gateway=gateway, ref=ref)
    if prefix == "env":
        provider_name = _default_env_secret_provider(config_data)
        if provider_name is None:
            return None, "Node runtime does not advertise an env secret provider."
        source = _secret_provider_source(config_data, provider_name) or "env"
        return (
            {"source": source, "provider": provider_name, "id": secret_id.strip()},
            None,
        )
    source = _secret_provider_source(config_data, prefix)
    if source is None:
        return None, f"Node runtime does not advertise a secret provider named {prefix}."
    return (
        {"source": source, "provider": prefix, "id": secret_id.strip()},
        None,
    )


def _tool_policy_from_profile(profile: ToolProfileName) -> GatewayToolProfilePolicy:
    return GatewayToolProfilePolicy(
        profile=profile,
        browser_enabled=profile == "browser-assisted",
        workspace_only_fs=True,
        summary=TOOL_PROFILE_SUMMARIES.get(profile),
    )


def _effective_tool_policy(
    *,
    gateway: Gateway,
    config_data: dict[str, Any] | None,
) -> GatewayToolProfilePolicy:
    tools = config_data.get("tools") if isinstance(config_data, dict) else {}
    browser = config_data.get("browser") if isinstance(config_data, dict) else {}
    profile = None
    if isinstance(tools, dict):
        profile = _normalize_tool_profile(tools.get("profile"))
    if profile is None:
        profile = _load_tool_profile(gateway) or "coding"
    policy = _tool_policy_from_profile(profile)
    if isinstance(tools, dict):
        fs = tools.get("fs")
        if isinstance(fs, dict) and isinstance(fs.get("workspaceOnly"), bool):
            policy.workspace_only_fs = fs["workspaceOnly"]
    if isinstance(browser, dict) and isinstance(browser.get("enabled"), bool):
        policy.browser_enabled = browser["enabled"]
    return policy


def _effective_provider_configs(
    *,
    gateway: Gateway,
    config_data: dict[str, Any] | None,
) -> list[GatewayProviderConfig]:
    stored = _load_provider_configs(gateway)
    if stored is not None:
        return stored
    if not isinstance(config_data, dict):
        return []
    return _config_provider_configs(config_data)


def _effective_model_definitions(
    *,
    gateway: Gateway,
    config_data: dict[str, Any] | None,
) -> list[GatewayModelDefinition]:
    stored = _load_model_definitions(gateway)
    if stored is not None:
        return stored
    if not isinstance(config_data, dict):
        return []
    return _config_model_definitions(config_data)


def _effective_provider_secret_refs(
    *,
    gateway: Gateway,
    config_data: dict[str, Any] | None,
) -> list[GatewayProviderSecretRef]:
    stored = _load_provider_secret_refs(gateway)
    if stored is not None:
        return stored
    if not isinstance(config_data, dict):
        return []
    return _config_provider_secret_refs(config_data)


def _effective_provider_auth_configs(
    *,
    gateway: Gateway,
    config_data: dict[str, Any] | None,
) -> list[GatewayProviderAuthConfig]:
    stored = _load_provider_auth_configs(gateway)
    if stored is not None:
        return stored
    if not isinstance(config_data, dict):
        return []
    return _config_provider_auth_configs(config_data)


def _managed_declared_model_refs(gateway: Gateway) -> list[str]:
    definitions = _load_model_definitions(gateway)
    if not definitions:
        return []
    return sorted({item.ref for item in definitions})


def _effective_enabled_model_refs(
    *,
    gateway: Gateway,
    runtime_available_models: Iterable[str],
) -> list[str]:
    runtime_available = _dedupe_models(runtime_available_models)
    configured = _configured_enabled_model_refs(gateway)
    if not configured:
        if gateway.node_class == "cloud":
            runtime_available_set = set(runtime_available)
            preferred_refs: list[str] = []
            profiles = _load_model_profiles(gateway)
            for profile_name in PROFILE_NAMES:
                selection = _profile_selection(profiles, profile_name)
                if selection is None or selection.primary_model is None:
                    continue
                preferred_refs.append(selection.primary_model)
                preferred_refs.extend(selection.fallback_models)
            preferred_enabled = [
                ref for ref in _dedupe_models(preferred_refs) if ref in runtime_available_set
            ]
            if preferred_enabled:
                return preferred_enabled
            default_selection = resolve_default_model_selection(gateway)
            fallback_refs: list[str] = [STARTER_PACK_PRIMARY_MODEL_REF]
            if default_selection is not None and default_selection.primary_model:
                fallback_refs.append(default_selection.primary_model)
                fallback_refs.extend(default_selection.fallback_models)
            fallback_refs.append(DEFAULT_PRIMARY_MODEL_REF)
            for fallback_ref in _dedupe_models(fallback_refs):
                if fallback_ref in runtime_available_set:
                    return [fallback_ref]
        return runtime_available
    runtime_available_set = set(runtime_available)
    return [ref for ref in configured if ref in runtime_available_set]


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


def _toolchain_drift_detected(
    *,
    gateway: Gateway,
    config_data: dict[str, Any] | None,
    effective_tool_policy: GatewayToolProfilePolicy,
) -> bool:
    if gateway.provider_configs is not None:
        if _effective_provider_configs(gateway=gateway, config_data=config_data) != (
            _config_provider_configs(config_data or {})
        ):
            return True
    if gateway.model_definitions is not None:
        if _effective_model_definitions(gateway=gateway, config_data=config_data) != (
            _config_model_definitions(config_data or {})
        ):
            return True
    if gateway.provider_secret_refs is not None:
        expected_secret_refs = [
            item
            for item in _effective_provider_secret_refs(gateway=gateway, config_data=config_data)
            if not item.ref.startswith("managed:")
        ]
        if expected_secret_refs != _config_provider_secret_refs(config_data or {}):
            return True
    if gateway.provider_auth_configs is not None:
        if _effective_provider_auth_configs(gateway=gateway, config_data=config_data) != (
            _config_provider_auth_configs(config_data or {})
        ):
            return True
    managed_tool_profile = _load_tool_profile(gateway)
    return (
        managed_tool_profile is not None and managed_tool_profile != effective_tool_policy.profile
    )


def _merged_provider_secret_refs(
    *,
    gateway: Gateway,
    config_data: dict[str, Any] | None,
    auth_configs: list[GatewayProviderAuthConfig] | None = None,
) -> list[GatewayProviderSecretRef]:
    merged: dict[tuple[str, str], GatewayProviderSecretRef] = {}
    order: list[tuple[str, str]] = []
    for secret_ref in _effective_provider_secret_refs(gateway=gateway, config_data=config_data):
        key = (secret_ref.provider_id, secret_ref.purpose)
        if key not in order:
            order.append(key)
        merged[key] = secret_ref
    for auth_config in auth_configs or _effective_provider_auth_configs(
        gateway=gateway,
        config_data=config_data,
    ):
        for secret_ref in auth_config.secret_refs:
            key = (secret_ref.provider_id, secret_ref.purpose)
            if key not in order:
                order.append(key)
            merged[key] = secret_ref
    return [merged[key] for key in order]


def _infer_provider_auth_mode(
    *,
    auth_config: GatewayProviderAuthConfig | None,
    secret_refs: list[GatewayProviderSecretRef],
) -> ProviderAuthMode | None:
    if auth_config is not None:
        return auth_config.auth_mode
    purposes = {item.purpose for item in secret_refs}
    if "token" in purposes:
        return "token"
    if "apiKey" in purposes:
        return "api-key"
    return None


async def _provider_runtime_summaries(
    *,
    gateway: Gateway,
    config_data: dict[str, Any] | None,
    catalog: Iterable[GatewayRuntimeCatalogEntry],
    secret_store: GatewaySecretStoreService | None = None,
) -> list[GatewayRuntimeProviderSummary]:
    effective_configs = _effective_provider_configs(gateway=gateway, config_data=config_data)
    effective_models = _effective_model_definitions(gateway=gateway, config_data=config_data)
    effective_auth_configs = _effective_provider_auth_configs(
        gateway=gateway,
        config_data=config_data,
    )
    effective_secret_refs = _merged_provider_secret_refs(
        gateway=gateway,
        config_data=config_data,
        auth_configs=effective_auth_configs,
    )
    runtime_auth_lookup = {
        item.provider_id: item for item in _config_provider_auth_configs(config_data or {})
    }
    runtime_verified_models: dict[str, int] = {}
    for entry in catalog:
        if entry.selectable:
            runtime_verified_models[entry.provider] = (
                runtime_verified_models.get(entry.provider, 0) + 1
            )
    model_counts: dict[str, int] = {}
    for definition in effective_models:
        model_counts[definition.provider_id] = model_counts.get(definition.provider_id, 0) + 1
    secret_refs_by_provider: dict[str, list[GatewayProviderSecretRef]] = {}
    for secret_ref in effective_secret_refs:
        secret_refs_by_provider.setdefault(secret_ref.provider_id, []).append(secret_ref)
    auth_lookup = {item.provider_id: item for item in effective_auth_configs}
    ids = {
        *runtime_verified_models.keys(),
        *model_counts.keys(),
        *(provider.id for provider in effective_configs),
        *auth_lookup.keys(),
        *runtime_auth_lookup.keys(),
    }
    provider_lookup = {provider.id: provider for provider in effective_configs}
    summaries: list[GatewayRuntimeProviderSummary] = []
    for provider_id in sorted(ids):
        provider_config = provider_lookup.get(provider_id)
        provider_auth = auth_lookup.get(provider_id) or runtime_auth_lookup.get(provider_id)
        provider_secret_refs = secret_refs_by_provider.get(provider_id, [])
        unresolved_secret_refs: list[str] = []
        for secret_ref in provider_secret_refs:
            _value, error = await _resolve_secret_ref_value(
                secret_ref.ref,
                gateway=gateway,
                config_data=config_data or {},
                secret_store=secret_store,
            )
            if error:
                unresolved_secret_refs.append(f"{secret_ref.purpose} ({secret_ref.ref})")
        auth_mode = _infer_provider_auth_mode(
            auth_config=provider_auth,
            secret_refs=provider_secret_refs,
        )
        verified_model_count = runtime_verified_models.get(provider_id, 0)
        connected_profile = (
            provider_auth.profile_id
            if provider_auth is not None and provider_auth.auth_mode in {"oauth", "login"}
            else None
        )
        requires_login = False
        auth_state = "configured"
        if auth_mode in {"oauth", "login"}:
            if connected_profile is None:
                requires_login = True
                auth_state = "requires-login"
            elif verified_model_count > 0:
                auth_state = "verified"
        elif auth_mode in {"api-key", "token"}:
            if verified_model_count > 0 and not unresolved_secret_refs:
                auth_state = "verified"
        summaries.append(
            GatewayRuntimeProviderSummary(
                id=provider_id,
                provider_type=(provider_config.provider_type if provider_config else provider_id),
                label=(
                    provider_config.label
                    if provider_config and provider_config.label
                    else _catalog_provider_label(provider_id)
                ),
                auth_mode=auth_mode,
                auth_state=auth_state,
                requires_login=requires_login,
                connected_profile=connected_profile,
                verification_state=("runtime" if verified_model_count > 0 else "configured"),
                configured_model_count=model_counts.get(provider_id, 0),
                verified_model_count=verified_model_count,
                secret_ref_count=len(provider_secret_refs),
                unresolved_secret_refs=unresolved_secret_refs,
            ),
        )
    return summaries


def _render_runtime_model_definition(
    definition: GatewayModelDefinition,
    *,
    provider_config: GatewayProviderConfig | None,
) -> dict[str, Any]:
    model_payload: dict[str, Any] = {"id": definition.model_id}
    if definition.label:
        model_payload["name"] = definition.label
    if definition.api_mode:
        model_payload["api"] = definition.api_mode
    elif provider_config and provider_config.api_mode:
        model_payload["api"] = provider_config.api_mode
    if definition.reasoning is not None:
        model_payload["reasoning"] = definition.reasoning
    if definition.input_modalities:
        model_payload["input"] = list(definition.input_modalities)
    if definition.context_window is not None:
        model_payload["contextWindow"] = definition.context_window
    if definition.max_tokens is not None:
        model_payload["maxTokens"] = definition.max_tokens
    if definition.cost is not None:
        model_payload["cost"] = definition.cost.model_dump(exclude_none=True, by_alias=True)
    return model_payload


async def _render_managed_provider_patch(
    *,
    gateway: Gateway,
    config_data: dict[str, Any],
    secret_store: GatewaySecretStoreService | None = None,
) -> tuple[dict[str, Any], list[str]]:
    provider_configs = _load_provider_configs(gateway)
    model_definitions = _load_model_definitions(gateway)
    secret_refs = _load_provider_secret_refs(gateway)
    auth_configs = _load_provider_auth_configs(gateway)
    if (
        provider_configs is None
        and model_definitions is None
        and secret_refs is None
        and auth_configs is None
    ):
        return {}, []
    provider_configs = provider_configs or []
    model_definitions = model_definitions or []
    auth_configs = auth_configs or []
    secret_refs = _merged_provider_secret_refs(
        gateway=gateway,
        config_data=config_data,
        auth_configs=auth_configs,
    )
    provider_lookup = {provider.id: provider for provider in provider_configs}
    auth_lookup = {item.provider_id: item for item in auth_configs}
    model_defs_by_provider: dict[str, list[GatewayModelDefinition]] = {}
    for definition in model_definitions:
        model_defs_by_provider.setdefault(definition.provider_id, []).append(definition)
    secret_refs_by_provider: dict[str, list[GatewayProviderSecretRef]] = {}
    for secret_ref in secret_refs:
        secret_refs_by_provider.setdefault(secret_ref.provider_id, []).append(secret_ref)
    models_section = config_data.get("models")
    current_providers = (
        models_section.get("providers")
        if isinstance(models_section, dict) and isinstance(models_section.get("providers"), dict)
        else {}
    )
    current_provider_ids = {key for key in current_providers.keys() if isinstance(key, str)}
    desired_provider_ids = {
        *provider_lookup.keys(),
        *model_defs_by_provider.keys(),
        *secret_refs_by_provider.keys(),
        *auth_lookup.keys(),
    }
    warnings: list[str] = []
    providers_patch: dict[str, Any] = {}
    for provider_id in sorted(desired_provider_ids):
        provider_config = provider_lookup.get(provider_id)
        provider_auth = auth_lookup.get(provider_id)
        provider_patch: dict[str, Any] = {
            "models": [
                _render_runtime_model_definition(definition, provider_config=provider_config)
                for definition in sorted(
                    model_defs_by_provider.get(provider_id, []),
                    key=lambda item: item.model_id,
                )
            ],
        }
        if provider_config and provider_config.base_url:
            provider_patch["baseUrl"] = provider_config.base_url
        if provider_config and provider_config.api_mode:
            provider_patch["api"] = provider_config.api_mode
        if provider_config and provider_config.auth_header is not None:
            provider_patch["authHeader"] = provider_config.auth_header
        header_refs: dict[str, dict[str, str] | str] = (
            dict(provider_config.headers or {}) if provider_config else {}
        )
        static_token_ref: dict[str, str] | str | None = None
        for secret_ref in secret_refs_by_provider.get(provider_id, []):
            resolved, error = await _resolve_secret_ref_value(
                secret_ref.ref,
                gateway=gateway,
                config_data=config_data,
                secret_store=secret_store,
            )
            if error:
                warnings.append(f"{provider_id} {secret_ref.purpose}: {error}")
                continue
            if secret_ref.purpose == "apiKey" and (
                provider_auth is None or provider_auth.auth_mode == "api-key"
            ):
                provider_patch["apiKey"] = resolved
                continue
            if (
                secret_ref.purpose == "token"
                and provider_auth
                and provider_auth.auth_mode == "token"
            ):
                static_token_ref = resolved
                continue
            if secret_ref.purpose.startswith("header:"):
                header_name = secret_ref.purpose.partition(":")[2].strip()
                if header_name:
                    header_refs[header_name] = resolved
        if static_token_ref is not None:
            header_name = (provider_auth.token_header_name or "Authorization").strip()
            header_prefix = (provider_auth.token_header_prefix or "Bearer").strip()
            if header_name.lower() == "authorization" and header_prefix.lower() == "bearer":
                provider_patch["authHeader"] = True
                provider_patch["apiKey"] = static_token_ref
            elif header_prefix and isinstance(static_token_ref, dict):
                warnings.append(
                    f"{provider_id} token auth custom header prefix is not runtime-renderable; "
                    "using Authorization bearer header.",
                )
                provider_patch["authHeader"] = True
                provider_patch["apiKey"] = static_token_ref
            else:
                header_refs[header_name] = (
                    f"{header_prefix} {static_token_ref}".strip()
                    if header_prefix and isinstance(static_token_ref, str)
                    else static_token_ref
                )
        if header_refs:
            provider_patch["headers"] = header_refs
        providers_patch[provider_id] = provider_patch
    for provider_id in sorted(current_provider_ids - desired_provider_ids):
        providers_patch[provider_id] = None
    return providers_patch, warnings


def _render_managed_auth_patch(
    *,
    gateway: Gateway,
    config_data: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    auth_configs = _load_provider_auth_configs(gateway)
    if auth_configs is None:
        return {}, []

    auth_section = config_data.get("auth")
    current_profiles = (
        dict(auth_section.get("profiles"))
        if isinstance(auth_section, dict) and isinstance(auth_section.get("profiles"), dict)
        else {}
    )
    current_order = (
        dict(auth_section.get("order"))
        if isinstance(auth_section, dict) and isinstance(auth_section.get("order"), dict)
        else {}
    )
    current_managed_profiles_by_provider: dict[str, list[str]] = {}
    for profile_id, raw_profile in current_profiles.items():
        if not isinstance(profile_id, str) or not isinstance(raw_profile, dict):
            continue
        if raw_profile.get("managedBy") != "mission-control":
            continue
        provider_id = raw_profile.get("provider")
        if not isinstance(provider_id, str) or not provider_id.strip():
            continue
        current_managed_profiles_by_provider.setdefault(provider_id.strip(), []).append(profile_id)

    desired_lookup = {item.provider_id: item for item in auth_configs}
    profiles_patch: dict[str, Any] = {}
    order_patch: dict[str, Any] = {}
    warnings: list[str] = []
    changed = False

    def _set_profile(profile_id: str, value: dict[str, Any]) -> None:
        nonlocal changed
        if current_profiles.get(profile_id) != value:
            profiles_patch[profile_id] = value
            changed = True

    def _remove_profile(profile_id: str) -> None:
        nonlocal changed
        if profile_id in current_profiles:
            profiles_patch[profile_id] = None
            changed = True

    def _set_order(provider_id: str, value: list[str] | None) -> None:
        nonlocal changed
        if current_order.get(provider_id) != value:
            order_patch[provider_id] = value
            changed = True

    for provider_id, auth_config in desired_lookup.items():
        existing_managed_profile_ids = current_managed_profiles_by_provider.get(provider_id, [])
        if auth_config.auth_mode in {"oauth", "login"}:
            profile_id = auth_config.profile_id or f"{provider_id}:managed"
            profile_payload: dict[str, Any] = {
                "provider": provider_id,
                "mode": auth_config.auth_mode,
                "managedBy": "mission-control",
            }
            if auth_config.display_label:
                profile_payload["displayName"] = auth_config.display_label
            _set_profile(profile_id, profile_payload)
            _set_order(provider_id, [profile_id])
            for existing_profile_id in existing_managed_profile_ids:
                if existing_profile_id != profile_id:
                    _remove_profile(existing_profile_id)
        else:
            if any(
                isinstance(raw_profile_id, str) and raw_profile_id in existing_managed_profile_ids
                for raw_profile_id in current_order.get(provider_id, [])
                if isinstance(current_order.get(provider_id), list)
            ):
                _set_order(provider_id, None)
            for existing_profile_id in existing_managed_profile_ids:
                _remove_profile(existing_profile_id)

    for provider_id, profile_ids in current_managed_profiles_by_provider.items():
        if provider_id in desired_lookup:
            continue
        for profile_id in profile_ids:
            _remove_profile(profile_id)
        if any(
            isinstance(raw_profile_id, str) and raw_profile_id in profile_ids
            for raw_profile_id in current_order.get(provider_id, [])
            if isinstance(current_order.get(provider_id), list)
        ):
            _set_order(provider_id, None)

    if not changed:
        return {}, warnings
    return {"profiles": profiles_patch, "order": order_patch}, warnings


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
        configured_refs.update(_managed_declared_model_refs(gateway))
        default_selection = resolve_default_model_selection(gateway)
        return _runtime_catalog_entries(
            runtime_refs=runtime_refs,
            configured_refs=configured_refs,
            default_ref=(default_selection.primary_model if default_selection else None),
        )

    async def runtime_available_models(self, gateway: Gateway) -> list[str]:
        return [entry.ref for entry in await self.runtime_catalog(gateway) if entry.selectable]

    async def available_models(self, gateway: Gateway) -> list[str]:
        runtime_available_models = await self.runtime_available_models(gateway)
        return _effective_enabled_model_refs(
            gateway=gateway,
            runtime_available_models=runtime_available_models,
        )

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

        runtime_available = set(await self.runtime_available_models(gateway))
        if not runtime_available:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Gateway did not return any runtime models for validation.",
            )
        configured_enabled = _configured_enabled_model_refs(gateway)
        if configured_enabled:
            unavailable_enabled = sorted(set(configured_enabled) - runtime_available)
            if unavailable_enabled:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail=(
                        "Node-enabled models unavailable on runtime: "
                        f"{', '.join(unavailable_enabled)}"
                    ),
                )
        available = set(configured_enabled) if configured_enabled else runtime_available
        if (
            gateway.model_profiles in ({}, None)
            and DEFAULT_PRIMARY_MODEL_REF in desired_refs
            and DEFAULT_PRIMARY_MODEL_REF not in available
            and STARTER_PACK_PRIMARY_MODEL_REF in available
        ):
            desired_refs.discard(DEFAULT_PRIMARY_MODEL_REF)
        unsupported = sorted(desired_refs - available)
        if unsupported:
            detail = (
                f"Node-enabled models do not include: {', '.join(unsupported)}"
                if configured_enabled
                else f"Unsupported runtime models: {', '.join(unsupported)}"
            )
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=detail,
            )
        return sorted(available)

    async def runtime_summary(self, *, gateway: Gateway) -> GatewayRuntimeSummary:
        catalog: list[GatewayRuntimeCatalogEntry] = []
        runtime_available_models: list[str] = []
        enabled_model_refs: list[str] = []
        config_data: dict[str, Any] | None = None
        default_selection = resolve_default_model_selection(gateway)
        try:
            _base_hash, config_data = await self._load_gateway_config(gateway)
        except OpenClawGatewayError:
            config_data = None
        try:
            catalog = await self.runtime_catalog(gateway)
            runtime_available_models = [entry.ref for entry in catalog if entry.selectable]
            enabled_model_refs = _effective_enabled_model_refs(
                gateway=gateway,
                runtime_available_models=runtime_available_models,
            )
        except OpenClawGatewayError:
            catalog = []
            runtime_available_models = []
            enabled_model_refs = []
        tool_policy = _effective_tool_policy(gateway=gateway, config_data=config_data)
        secret_store = GatewaySecretStoreService(self.session)
        return GatewayRuntimeSummary(
            gateway_id=gateway.id,
            node_class=gateway.node_class,
            runtime_sync_generation=gateway.runtime_sync_generation,
            last_runtime_sync_at=gateway.last_runtime_sync_at,
            last_runtime_sync_error=gateway.last_runtime_sync_error,
            default_model_profile=gateway.default_model_profile,
            default_model_ref=(default_selection.primary_model if default_selection else None),
            model_profiles=_load_model_profiles(gateway),
            catalog=catalog,
            available_models=enabled_model_refs,
            enabled_model_refs=enabled_model_refs,
            configured_provider_configs=_effective_provider_configs(
                gateway=gateway,
                config_data=config_data,
            ),
            configured_model_definitions=_effective_model_definitions(
                gateway=gateway,
                config_data=config_data,
            ),
            configured_provider_auth_configs=_effective_provider_auth_configs(
                gateway=gateway,
                config_data=config_data,
            ),
            configured_provider_secret_refs=_effective_provider_secret_refs(
                gateway=gateway,
                config_data=config_data,
            ),
            providers=await _provider_runtime_summaries(
                gateway=gateway,
                config_data=config_data,
                catalog=catalog,
                secret_store=secret_store,
            ),
            effective_tool_profile=tool_policy.profile,
            effective_tool_policy=tool_policy,
            drift_detected=_toolchain_drift_detected(
                gateway=gateway,
                config_data=config_data,
                effective_tool_policy=tool_policy,
            ),
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
        """Patch gateway runtime config for Mission Control model/toolchain state."""
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
        existing_catalog_map: dict[str, Any] = (
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

        catalog: dict[str, Any] = {}
        for ref in sorted(available):
            raw_entry = existing_catalog_map.get(ref)
            catalog[ref] = dict(raw_entry) if isinstance(raw_entry, dict) else {}
        catalog_changed = catalog != existing_catalog_map

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
        actual_tool_policy = _effective_tool_policy(gateway=gateway, config_data=config_data)
        desired_tool_profile = _load_tool_profile(gateway)
        desired_tool_policy = (
            _tool_policy_from_profile(desired_tool_profile)
            if desired_tool_profile is not None
            else None
        )
        tool_profile_changed = desired_tool_policy is not None and (
            actual_tool_policy.profile != desired_tool_policy.profile
            or actual_tool_policy.browser_enabled != desired_tool_policy.browser_enabled
            or actual_tool_policy.workspace_only_fs != desired_tool_policy.workspace_only_fs
        )
        managed_provider_patch, toolchain_warnings = await _render_managed_provider_patch(
            gateway=gateway,
            config_data=config_data,
            secret_store=GatewaySecretStoreService(self.session),
        )
        managed_auth_patch, auth_warnings = _render_managed_auth_patch(
            gateway=gateway,
            config_data=config_data,
        )
        toolchain_warnings.extend(auth_warnings)
        providers_changed = _toolchain_drift_detected(
            gateway=gateway,
            config_data=config_data,
            effective_tool_policy=actual_tool_policy,
        )
        if desired_tool_profile is not None:
            providers_changed = providers_changed or tool_profile_changed
        warning_text = "; ".join(toolchain_warnings) if toolchain_warnings else None
        if not any(
            (
                catalog_changed,
                list_changed,
                default_changed,
                providers_changed,
                tool_profile_changed,
            ),
        ):
            if gateway.last_runtime_sync_error != warning_text:
                gateway.last_runtime_sync_error = warning_text
                self.session.add(gateway)
                await self.session.commit()
            return False

        patch: dict[str, Any] = {}
        if catalog_changed or list_changed or default_changed:
            patch["agents"] = {"list": updated_list, "defaults": {"models": catalog}}
            if desired_default_payload is not None:
                patch["agents"]["defaults"]["model"] = desired_default_payload
        if managed_provider_patch:
            patch.setdefault("models", {})["providers"] = managed_provider_patch
        if managed_auth_patch:
            patch["auth"] = managed_auth_patch
        if desired_tool_policy is not None:
            patch["tools"] = {
                "profile": desired_tool_policy.profile,
                "fs": {"workspaceOnly": desired_tool_policy.workspace_only_fs},
            }
            patch["browser"] = {"enabled": desired_tool_policy.browser_enabled}

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
        gateway.last_runtime_sync_error = warning_text
        self.session.add(gateway)
        for agent in managed_agents:
            agent.last_runtime_sync_at = now
            self.session.add(agent)
        await self.session.commit()

        if auth is not None:
            record_activity(
                self.session,
                event_type="gateway.runtime.sync",
                message=f"Synced runtime toolchain and model policy for gateway {gateway.name}.",
                entity_type="gateway",
                entity_id=str(gateway.id),
                previous_values=None,
                new_values={
                    "default_model_profile": gateway.default_model_profile,
                    "tool_profile": gateway.tool_profile,
                },
                details={
                    "synced_agents": [str(agent.id) for agent in managed_agents],
                    "warnings": toolchain_warnings,
                },
                **actor_fields_from_auth(auth),
            )
            await self.session.commit()
        return True

    async def _resolve_provider_auth_config(
        self,
        *,
        gateway: Gateway,
        provider_id: str,
    ) -> GatewayProviderAuthConfig:
        _base_hash, config_data = await self._load_gateway_config_with_retry(
            gateway,
            context=f"provider auth resolve {provider_id}",
        )
        auth_configs = _effective_provider_auth_configs(
            gateway=gateway,
            config_data=config_data,
        )
        for auth_config in auth_configs:
            if auth_config.provider_id == provider_id:
                return auth_config
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Node does not define a provider auth config for {provider_id}.",
        )

    async def _provider_auth_action(
        self,
        *,
        gateway: Gateway,
        provider_id: str,
        action: str,
        auth: AuthContext,
    ) -> GatewayProviderAuthActionResponse:
        auth_config = await self._resolve_provider_auth_config(
            gateway=gateway,
            provider_id=provider_id,
        )
        warnings: list[str] = []
        if auth_config.auth_mode not in {"oauth", "login"}:
            return GatewayProviderAuthActionResponse(
                gateway_id=gateway.id,
                provider_id=provider_id,
                auth_mode=auth_config.auth_mode,
                auth_state="configured",
                connected_profile=None,
                requires_login=False,
                message="Interactive provider actions are only supported for oauth/login modes.",
                challenge=None,
                warnings=["Interactive provider actions are only supported for oauth/login modes."],
            )
        params: dict[str, Any] = {"providerId": provider_id}
        if auth_config.profile_id:
            params["profileId"] = auth_config.profile_id
        if auth_config.display_label:
            params["displayName"] = auth_config.display_label

        status_value: str = "pending-login"
        challenge: GatewayProviderAuthChallenge | None = None
        try:
            action_payload = await openclaw_call(
                f"providers.{action}",
                params,
                config=_gateway_client_config(gateway),
            )
            if action == "connect":
                challenge = _normalize_provider_auth_challenge(action_payload)
        except OpenClawGatewayError as exc:
            warnings.append(str(exc))
            status_value = "blocked"

        runtime = await self.runtime_summary(gateway=gateway)
        provider_runtime = next(
            (item for item in runtime.providers if item.id == provider_id), None
        )
        if action == "disconnect":
            status_value = "ok" if status_value != "blocked" else "blocked"
        elif provider_runtime and provider_runtime.auth_state == "verified":
            status_value = "ok"
        elif provider_runtime and provider_runtime.requires_login:
            status_value = "pending-login"
        elif status_value != "blocked":
            status_value = "ok"

        record_activity(
            self.session,
            event_type=f"gateway.provider.{action}",
            message=f"{action.title()} provider auth for {provider_id} on gateway {gateway.name}.",
            entity_type="gateway",
            entity_id=str(gateway.id),
            details={"provider_id": provider_id, "status": status_value, "warnings": warnings},
            **actor_fields_from_auth(auth),
        )
        await self.session.commit()
        return GatewayProviderAuthActionResponse(
            gateway_id=gateway.id,
            provider_id=provider_id,
            auth_mode=(provider_runtime.auth_mode if provider_runtime else auth_config.auth_mode),
            auth_state=(
                provider_runtime.auth_state
                if provider_runtime is not None
                else ("requires-login" if status_value == "pending-login" else "configured")
            ),
            connected_profile=(provider_runtime.connected_profile if provider_runtime else None),
            requires_login=(provider_runtime.requires_login if provider_runtime else False),
            message=f"Provider {provider_id} {status_value}.",
            challenge=challenge,
            warnings=warnings,
        )

    async def connect_provider_auth(
        self,
        *,
        gateway: Gateway,
        provider_id: str,
        auth: AuthContext,
    ) -> GatewayProviderAuthActionResponse:
        return await self._provider_auth_action(
            gateway=gateway,
            provider_id=provider_id,
            action="connect",
            auth=auth,
        )

    async def refresh_provider_auth(
        self,
        *,
        gateway: Gateway,
        provider_id: str,
        auth: AuthContext,
    ) -> GatewayProviderAuthActionResponse:
        return await self._provider_auth_action(
            gateway=gateway,
            provider_id=provider_id,
            action="refresh",
            auth=auth,
        )

    async def disconnect_provider_auth(
        self,
        *,
        gateway: Gateway,
        provider_id: str,
        auth: AuthContext,
    ) -> GatewayProviderAuthActionResponse:
        return await self._provider_auth_action(
            gateway=gateway,
            provider_id=provider_id,
            action="disconnect",
            auth=auth,
        )

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
            all_agents = list(
                await Agent.objects.filter_by(gateway_id=gateway.id).all(self.session)
            )
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
            if gateway.last_runtime_sync_error:
                warnings.append(gateway.last_runtime_sync_error)

        return GatewayRuntimeSyncResponse(
            gateway_id=gateway.id,
            repaired_agents=repaired_agents,
            skipped_agents=skipped_agents,
            sync_generation=gateway.runtime_sync_generation,
            synced_models=synced_models,
            warnings=warnings,
        )
