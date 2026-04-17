"""Write-only provider secret metadata and encrypted/backing-store references."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import Column, Text, UniqueConstraint
from sqlmodel import Field

from app.core.time import utcnow
from app.models.base import QueryModel


class GatewayProviderSecret(QueryModel, table=True):
    """Secret metadata plus backing-store location for one gateway provider purpose."""

    __tablename__ = "gateway_provider_secrets"  # pyright: ignore[reportAssignmentType]
    __table_args__ = (
        UniqueConstraint(
            "gateway_id",
            "provider_id",
            "purpose",
            name="uq_gateway_provider_secret_scope",
        ),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    gateway_id: UUID = Field(foreign_key="gateways.id", index=True)
    provider_id: str = Field(index=True)
    purpose: str = Field(index=True)
    alias: str
    storage_backend: str
    external_key: str | None = Field(default=None)
    encrypted_value: str | None = Field(default=None, sa_column=Column(Text))
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
