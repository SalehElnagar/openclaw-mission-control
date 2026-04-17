"""Schemas for gateway runtime control and model policy APIs."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import field_validator
from sqlmodel import Field, SQLModel

from app.core.node_class import GatewayNodeClass

RUNTIME_TYPE_REFERENCES = (datetime, UUID)
PROFILE_NAMES = ("general", "coder", "budget")
ProfileName = Literal["general", "coder", "budget"]
FallbackPolicy = Literal["profile", "explicit-only", "none"]
CatalogEntryKind = Literal["model"]
CatalogVerificationState = Literal["runtime", "configured"]


def _normalize_model_ref(value: object) -> str | None | object:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    return value


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
