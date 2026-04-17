"""Gateway model storing organization-level gateway integration metadata."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import JSON, Column, Text
from sqlmodel import Field

from app.core.time import utcnow
from app.models.base import QueryModel

RUNTIME_ANNOTATION_TYPES = (datetime,)


class Gateway(QueryModel, table=True):
    """Configured external gateway endpoint and authentication settings."""

    __tablename__ = "gateways"  # pyright: ignore[reportAssignmentType]

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    organization_id: UUID = Field(foreign_key="organizations.id", index=True)
    name: str
    url: str
    node_class: str = Field(default="cloud", index=True)
    token: str | None = Field(default=None)
    disable_device_pairing: bool = Field(default=False)
    workspace_root: str
    allow_insecure_tls: bool = Field(default=False)
    default_model_profile: str = Field(default="general")
    model_profiles: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    runtime_sync_generation: int = Field(default=0)
    last_runtime_sync_at: datetime | None = Field(default=None)
    last_runtime_sync_error: str | None = Field(default=None, sa_column=Column(Text))
    last_telemetry_collected_at: datetime | None = Field(default=None)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
