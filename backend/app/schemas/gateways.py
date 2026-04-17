"""Schemas for gateway CRUD and template-sync API payloads."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import field_validator
from sqlmodel import Field, SQLModel

from app.core.node_class import GatewayNodeClass
from app.schemas.gateway_runtime import GatewayModelProfiles, ProfileName

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
