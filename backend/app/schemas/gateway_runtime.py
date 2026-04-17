"""Schemas for gateway runtime control and managed node toolchain APIs."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import Field, field_validator, model_validator
from sqlmodel import SQLModel

from app.core.node_class import GatewayNodeClass

RUNTIME_TYPE_REFERENCES = (datetime, UUID)
PROFILE_NAMES = ("general", "coder", "budget")
TOOL_PROFILE_NAMES = ("restricted", "coding", "research", "browser-assisted")
ProfileName = Literal["general", "coder", "budget"]
FallbackPolicy = Literal["profile", "explicit-only", "none"]
CatalogEntryKind = Literal["model"]
CatalogVerificationState = Literal["runtime", "configured"]
ToolProfileName = Literal["restricted", "coding", "research", "browser-assisted"]


def _normalize_text(value: object) -> str | None | object:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    return value


def _normalize_model_ref(value: object) -> str | None | object:
    return _normalize_text(value)


def _normalize_model_list(value: object) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return None
    seen: set[str] = set()
    normalized: list[str] = []
    for raw in value:
        text = _normalize_model_ref(raw)
        if not isinstance(text, str):
            continue
        if text in seen:
            continue
        seen.add(text)
        normalized.append(text)
    return normalized or None


def _normalize_tool_profile(value: object) -> ToolProfileName | None | object:
    normalized = _normalize_text(value)
    if normalized is None or not isinstance(normalized, str):
        return normalized
    if normalized not in TOOL_PROFILE_NAMES:
        msg = f"tool_profile must be one of: {', '.join(TOOL_PROFILE_NAMES)}"
        raise ValueError(msg)
    return normalized


class ModelSelection(SQLModel):
    """Primary + fallback model selection."""

    primary_model: str | None = None
    fallback_models: list[str] = Field(default_factory=list)

    @field_validator("primary_model", mode="before")
    @classmethod
    def normalize_primary_model(cls, value: object) -> str | None | object:
        return _normalize_model_ref(value)

    @field_validator("fallback_models", mode="before")
    @classmethod
    def normalize_fallback_models(cls, value: object) -> list[str]:
        return _normalize_model_list(value) or []


class GatewayModelProfiles(SQLModel):
    """Gateway-level named model profiles."""

    general: ModelSelection | None = None
    coder: ModelSelection | None = None
    budget: ModelSelection | None = None

    def as_dict(self) -> dict[str, dict[str, object]]:
        data: dict[str, dict[str, object]] = {}
        for name in PROFILE_NAMES:
            value = getattr(self, name)
            if value is None:
                continue
            data[name] = value.model_dump(exclude_none=True)
        return data


class GatewayProviderSecretRef(SQLModel):
    """Secret-reference metadata for one provider auth purpose."""

    provider_id: str
    purpose: str
    ref: str

    @model_validator(mode="before")
    @classmethod
    def normalize_payload(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        provider_id = _normalize_text(
            normalized.get("provider_id") or normalized.get("provider"),
        )
        purpose = _normalize_text(normalized.get("purpose"))
        ref = _normalize_text(normalized.get("ref"))
        if provider_id is not None:
            normalized["provider_id"] = provider_id
        if purpose is not None:
            normalized["purpose"] = purpose
        if ref is not None:
            normalized["ref"] = ref
        return normalized

    @field_validator("provider_id", "purpose", "ref", mode="before")
    @classmethod
    def normalize_required_text(cls, value: object) -> str | None | object:
        return _normalize_text(value)


class GatewayProviderConfig(SQLModel):
    """Managed provider definition saved on a node."""

    id: str
    provider_type: str | None = None
    label: str | None = None
    base_url: str | None = None
    api_mode: str | None = None
    auth_header: bool | None = None

    @model_validator(mode="before")
    @classmethod
    def normalize_payload(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        provider_id = _normalize_text(
            normalized.get("id") or normalized.get("provider_id"),
        )
        provider_type = _normalize_text(
            normalized.get("provider_type") or normalized.get("type"),
        )
        label = _normalize_text(normalized.get("label") or normalized.get("name"))
        base_url = _normalize_text(
            normalized.get("base_url") or normalized.get("baseUrl"),
        )
        api_mode = _normalize_text(
            normalized.get("api_mode") or normalized.get("api"),
        )
        if provider_id is not None:
            normalized["id"] = provider_id
        if provider_type is not None:
            normalized["provider_type"] = provider_type
        if label is not None:
            normalized["label"] = label
        if base_url is not None:
            normalized["base_url"] = base_url
        if api_mode is not None:
            normalized["api_mode"] = api_mode
        return normalized

    @field_validator("id", "provider_type", "label", "base_url", "api_mode", mode="before")
    @classmethod
    def normalize_text_fields(cls, value: object) -> str | None | object:
        return _normalize_text(value)

    @model_validator(mode="after")
    def apply_defaults(self) -> "GatewayProviderConfig":
        if self.provider_type is None:
            self.provider_type = self.id
        return self


class GatewayModelCost(SQLModel):
    """Optional cost metadata for one configured model."""

    input: float | None = None
    output: float | None = None
    cache_read: float | None = None
    cache_write: float | None = None

    @model_validator(mode="before")
    @classmethod
    def normalize_payload(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        if "cache_read" not in normalized and "cacheRead" in normalized:
            normalized["cache_read"] = normalized.get("cacheRead")
        if "cache_write" not in normalized and "cacheWrite" in normalized:
            normalized["cache_write"] = normalized.get("cacheWrite")
        return normalized


class GatewayModelDefinition(SQLModel):
    """Managed model definition saved on a node."""

    provider_id: str
    model_id: str
    label: str | None = None
    api_mode: str | None = None
    reasoning: bool | None = None
    input_modalities: list[str] = Field(default_factory=list)
    context_window: int | None = None
    max_tokens: int | None = None
    cost: GatewayModelCost | None = None

    @model_validator(mode="before")
    @classmethod
    def normalize_payload(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        provider_id = _normalize_text(
            normalized.get("provider_id") or normalized.get("provider"),
        )
        model_id = _normalize_text(
            normalized.get("model_id") or normalized.get("id"),
        )
        label = _normalize_text(normalized.get("label") or normalized.get("name"))
        api_mode = _normalize_text(
            normalized.get("api_mode") or normalized.get("api"),
        )
        if provider_id is not None:
            normalized["provider_id"] = provider_id
        if model_id is not None:
            normalized["model_id"] = model_id
        if label is not None:
            normalized["label"] = label
        if api_mode is not None:
            normalized["api_mode"] = api_mode
        if "input_modalities" not in normalized and "input" in normalized:
            normalized["input_modalities"] = normalized.get("input")
        if "context_window" not in normalized and "contextWindow" in normalized:
            normalized["context_window"] = normalized.get("contextWindow")
        if "max_tokens" not in normalized and "maxTokens" in normalized:
            normalized["max_tokens"] = normalized.get("maxTokens")
        return normalized

    @field_validator("provider_id", "model_id", "label", "api_mode", mode="before")
    @classmethod
    def normalize_text_fields(cls, value: object) -> str | None | object:
        return _normalize_text(value)

    @field_validator("input_modalities", mode="before")
    @classmethod
    def normalize_input_modalities(cls, value: object) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            return []
        normalized: list[str] = []
        seen: set[str] = set()
        for raw in value:
            text = _normalize_text(raw)
            if not isinstance(text, str) or text in seen:
                continue
            seen.add(text)
            normalized.append(text)
        return normalized

    @property
    def ref(self) -> str:
        return f"{self.provider_id}/{self.model_id}"


class GatewayToolProfilePolicy(SQLModel):
    """Expanded, read-only runtime policy for one named tool profile."""

    profile: ToolProfileName = "coding"
    browser_enabled: bool = False
    workspace_only_fs: bool = True
    summary: str | None = None


class GatewayRuntimeCatalogEntry(SQLModel):
    """Structured runtime-selectable model catalog entry."""

    ref: str
    provider: str
    provider_label: str
    label: str
    kind: CatalogEntryKind = "model"
    verification_state: CatalogVerificationState = "runtime"
    selectable: bool = True
    is_default: bool = False


class GatewayRuntimeProviderSummary(SQLModel):
    """Observed/configured provider status for one node provider."""

    id: str
    provider_type: str
    label: str
    verification_state: CatalogVerificationState = "configured"
    configured_model_count: int = 0
    verified_model_count: int = 0
    secret_ref_count: int = 0
    unresolved_secret_refs: list[str] = Field(default_factory=list)


class GatewayRuntimeSummary(SQLModel):
    """Gateway runtime state returned by Mission Control."""

    gateway_id: UUID
    node_class: GatewayNodeClass = "cloud"
    runtime_sync_generation: int
    last_runtime_sync_at: datetime | None = None
    last_runtime_sync_error: str | None = None
    default_model_profile: ProfileName = "general"
    default_model_ref: str | None = None
    model_profiles: GatewayModelProfiles = Field(default_factory=GatewayModelProfiles)
    catalog: list[GatewayRuntimeCatalogEntry] = Field(default_factory=list)
    available_models: list[str] = Field(default_factory=list)
    enabled_model_refs: list[str] = Field(default_factory=list)
    configured_provider_configs: list[GatewayProviderConfig] = Field(default_factory=list)
    configured_model_definitions: list[GatewayModelDefinition] = Field(default_factory=list)
    configured_provider_secret_refs: list[GatewayProviderSecretRef] = Field(
        default_factory=list,
    )
    providers: list[GatewayRuntimeProviderSummary] = Field(default_factory=list)
    effective_tool_profile: ToolProfileName = "coding"
    effective_tool_policy: GatewayToolProfilePolicy = Field(
        default_factory=GatewayToolProfilePolicy,
    )
    drift_detected: bool = False


def _normalize_provider_configs(
    value: object,
) -> list[GatewayProviderConfig] | None:
    if value is None:
        return None
    if isinstance(value, dict):
        value = [
            {"id": key, **item}
            for key, item in value.items()
            if isinstance(key, str) and isinstance(item, dict)
        ]
    if not isinstance(value, list):
        return None
    deduped: dict[str, GatewayProviderConfig] = {}
    order: list[str] = []
    for raw in value:
        item = GatewayProviderConfig.model_validate(raw)
        if item.id not in order:
            order.append(item.id)
        deduped[item.id] = item
    return [deduped[key] for key in order] or None


def _normalize_model_definitions(
    value: object,
) -> list[GatewayModelDefinition] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        return None
    deduped: dict[tuple[str, str], GatewayModelDefinition] = {}
    order: list[tuple[str, str]] = []
    for raw in value:
        item = GatewayModelDefinition.model_validate(raw)
        key = (item.provider_id, item.model_id)
        if key not in order:
            order.append(key)
        deduped[key] = item
    return [deduped[key] for key in order] or None


def _normalize_provider_secret_refs(
    value: object,
) -> list[GatewayProviderSecretRef] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        return None
    deduped: dict[tuple[str, str], GatewayProviderSecretRef] = {}
    order: list[tuple[str, str]] = []
    for raw in value:
        item = GatewayProviderSecretRef.model_validate(raw)
        key = (item.provider_id, item.purpose)
        if key not in order:
            order.append(key)
        deduped[key] = item
    return [deduped[key] for key in order] or None


class GatewayRuntimeSyncRequest(SQLModel):
    """Control flags for runtime reconciliation."""

    repair_stuck_agents: bool = True
    sync_models: bool = True
    wake_agents: bool = True


class GatewayRuntimeSyncResponse(SQLModel):
    """Result returned after a runtime reconciliation pass."""

    gateway_id: UUID
    repaired_agents: list[UUID] = Field(default_factory=list)
    skipped_agents: list[UUID] = Field(default_factory=list)
    sync_generation: int
    synced_models: bool = False
    telemetry_samples_ingested: int = 0
    warnings: list[str] = Field(default_factory=list)


class RuntimeAuditRecordRead(SQLModel):
    """Gateway-focused audit record payload."""

    id: UUID
    event_type: str
    message: str | None = None
    actor_type: str | None = None
    actor_user_id: UUID | None = None
    actor_label: str | None = None
    entity_type: str | None = None
    entity_id: str | None = None
    previous_values: dict[str, object] | None = None
    new_values: dict[str, object] | None = None
    details: dict[str, object] | None = None
    created_at: datetime
