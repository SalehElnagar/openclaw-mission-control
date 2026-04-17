"""Schemas for gateway CRUD and template-sync API payloads."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import field_validator
from sqlmodel import Field, SQLModel

from app.core.node_class import GatewayNodeClass
from app.schemas.gateway_runtime import (
    GatewayModelDefinition,
    GatewayModelProfiles,
    GatewayProviderConfig,
    GatewayProviderSecretRef,
    ProfileName,
    ToolProfileName,
    _normalize_model_list,
    _normalize_model_definitions,
    _normalize_provider_configs,
    _normalize_provider_secret_refs,
    _normalize_tool_profile,
)

RUNTIME_ANNOTATION_TYPES = (datetime, UUID)


class GatewayBase(SQLModel):
    """Shared gateway fields used across create/read payloads."""

    name: str
    url: str
    node_class: GatewayNodeClass = "cloud"
    workspace_root: str
    allow_insecure_tls: bool = False
    disable_device_pairing: bool = False
    default_model_profile: ProfileName = "general"
    model_profiles: GatewayModelProfiles = Field(default_factory=GatewayModelProfiles)
    enabled_model_refs: list[str] | None = None
    tool_profile: ToolProfileName | None = None
    provider_configs: list[GatewayProviderConfig] | None = None
    model_definitions: list[GatewayModelDefinition] | None = None
    provider_secret_refs: list[GatewayProviderSecretRef] | None = None

    @field_validator("model_profiles", mode="before")
    @classmethod
    def normalize_model_profiles(
        cls,
        value: object,
    ) -> GatewayModelProfiles | object:
        """Treat null/blank gateway model profiles as an empty profile map."""
        if value is None:
            return GatewayModelProfiles()
        if isinstance(value, GatewayModelProfiles):
            return value
        if isinstance(value, dict):
            return GatewayModelProfiles.model_validate(value)
        return value

    @field_validator("node_class", mode="before")
    @classmethod
    def normalize_node_class(cls, value: object) -> GatewayNodeClass | object:
        """Normalize node class input to lowercase cloud/local values."""
        if value is None:
            return value
        if isinstance(value, str):
            normalized = value.strip().lower()
            return normalized or value
        return value

    @field_validator("enabled_model_refs", mode="before")
    @classmethod
    def normalize_enabled_model_refs(
        cls,
        value: object,
    ) -> list[str] | None:
        """Normalize enabled model refs into a stable, deduplicated list."""
        return _normalize_model_list(value)

    @field_validator("tool_profile", mode="before")
    @classmethod
    def normalize_tool_profile(
        cls,
        value: object,
    ) -> ToolProfileName | None | object:
        """Normalize node tool-profile selection."""
        return _normalize_tool_profile(value)

    @field_validator("provider_configs", mode="before")
    @classmethod
    def normalize_provider_configs(
        cls,
        value: object,
    ) -> list[GatewayProviderConfig] | None:
        """Normalize managed node provider definitions."""
        return _normalize_provider_configs(value)

    @field_validator("model_definitions", mode="before")
    @classmethod
    def normalize_model_definitions(
        cls,
        value: object,
    ) -> list[GatewayModelDefinition] | None:
        """Normalize managed node model definitions."""
        return _normalize_model_definitions(value)

    @field_validator("provider_secret_refs", mode="before")
    @classmethod
    def normalize_provider_secret_refs(
        cls,
        value: object,
    ) -> list[GatewayProviderSecretRef] | None:
        """Normalize managed provider secret references."""
        return _normalize_provider_secret_refs(value)


class GatewayCreate(GatewayBase):
    """Payload for creating a gateway configuration."""

    token: str | None = None

    @field_validator("token", mode="before")
    @classmethod
    def normalize_token(cls, value: object) -> str | None | object:
        """Normalize empty/whitespace tokens to `None`."""
        if value is None:
            return None
        if isinstance(value, str):
            value = value.strip()
            return value or None
        return value


class GatewayUpdate(SQLModel):
    """Payload for partial gateway updates."""

    name: str | None = None
    url: str | None = None
    node_class: GatewayNodeClass | None = None
    token: str | None = None
    workspace_root: str | None = None
    allow_insecure_tls: bool | None = None
    disable_device_pairing: bool | None = None
    default_model_profile: ProfileName | None = None
    model_profiles: GatewayModelProfiles | None = None
    enabled_model_refs: list[str] | None = None
    tool_profile: ToolProfileName | None = None
    provider_configs: list[GatewayProviderConfig] | None = None
    model_definitions: list[GatewayModelDefinition] | None = None
    provider_secret_refs: list[GatewayProviderSecretRef] | None = None

    @field_validator("token", mode="before")
    @classmethod
    def normalize_token(cls, value: object) -> str | None | object:
        """Normalize empty/whitespace tokens to `None`."""
        if value is None:
            return None
        if isinstance(value, str):
            value = value.strip()
            return value or None
        return value

    @field_validator("node_class", mode="before")
    @classmethod
    def normalize_update_node_class(
        cls,
        value: object,
    ) -> GatewayNodeClass | None | object:
        """Normalize node class patches to lowercase cloud/local values."""
        if value is None:
            return None
        if isinstance(value, str):
            normalized = value.strip().lower()
            return normalized or None
        return value

    @field_validator("model_profiles", mode="before")
    @classmethod
    def normalize_update_model_profiles(
        cls,
        value: object,
    ) -> GatewayModelProfiles | None | object:
        """Allow PATCH callers to clear or normalize runtime model profiles."""
        if value is None:
            return None
        if isinstance(value, GatewayModelProfiles):
            return value
        if isinstance(value, dict):
            return GatewayModelProfiles.model_validate(value)
        return value

    @field_validator("enabled_model_refs", mode="before")
    @classmethod
    def normalize_update_enabled_model_refs(
        cls,
        value: object,
    ) -> list[str] | None:
        """Normalize enabled model refs on PATCH payloads."""
        return _normalize_model_list(value)

    @field_validator("tool_profile", mode="before")
    @classmethod
    def normalize_update_tool_profile(
        cls,
        value: object,
    ) -> ToolProfileName | None | object:
        """Normalize patched tool-profile selections."""
        return _normalize_tool_profile(value)

    @field_validator("provider_configs", mode="before")
    @classmethod
    def normalize_update_provider_configs(
        cls,
        value: object,
    ) -> list[GatewayProviderConfig] | None:
        """Normalize patched managed provider definitions."""
        return _normalize_provider_configs(value)

    @field_validator("model_definitions", mode="before")
    @classmethod
    def normalize_update_model_definitions(
        cls,
        value: object,
    ) -> list[GatewayModelDefinition] | None:
        """Normalize patched managed model definitions."""
        return _normalize_model_definitions(value)

    @field_validator("provider_secret_refs", mode="before")
    @classmethod
    def normalize_update_provider_secret_refs(
        cls,
        value: object,
    ) -> list[GatewayProviderSecretRef] | None:
        """Normalize patched provider secret references."""
        return _normalize_provider_secret_refs(value)


class GatewayRead(GatewayBase):
    """Gateway payload returned from read endpoints."""

    id: UUID
    organization_id: UUID
    token: str | None = None
    runtime_sync_generation: int = 0
    last_runtime_sync_at: datetime | None = None
    last_runtime_sync_error: str | None = None
    last_telemetry_collected_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class GatewayTemplatesSyncError(SQLModel):
    """Per-agent error entry from a gateway template sync operation."""

    agent_id: UUID | None = None
    agent_name: str | None = None
    board_id: UUID | None = None
    message: str


class GatewayTemplatesSyncResult(SQLModel):
    """Summary payload returned by gateway template sync endpoints."""

    gateway_id: UUID
    include_main: bool
    reset_sessions: bool
    agents_updated: int
    agents_skipped: int
    main_updated: bool
    errors: list[GatewayTemplatesSyncError] = Field(default_factory=list)
