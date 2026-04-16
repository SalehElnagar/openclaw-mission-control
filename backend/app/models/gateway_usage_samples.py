"""Persisted cost and token telemetry samples for gateway/runtime usage."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import JSON, Column, Float, Text
from sqlmodel import Field

from app.core.time import utcnow
from app.models.base import QueryModel

RUNTIME_ANNOTATION_TYPES = (datetime,)


class GatewayUsageSample(QueryModel, table=True):
    """Normalized usage/cost telemetry sample stored for reporting."""

    __tablename__ = "gateway_usage_samples"  # pyright: ignore[reportAssignmentType]

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    organization_id: UUID = Field(foreign_key="organizations.id", index=True)
    gateway_id: UUID = Field(foreign_key="gateways.id", index=True)
    board_id: UUID | None = Field(default=None, foreign_key="boards.id", index=True)
    agent_id: UUID | None = Field(default=None, foreign_key="agents.id", index=True)
    task_id: UUID | None = Field(default=None, foreign_key="tasks.id", index=True)
    source: str = Field(default="runtime-report", index=True)
    model: str | None = Field(default=None, index=True)
    prompt_tokens: int = Field(default=0)
    completion_tokens: int = Field(default=0)
    total_tokens: int = Field(default=0)
    cost_usd: float = Field(
        default=0.0,
        sa_column=Column(Float, nullable=False, default=0.0),
    )
    currency: str = Field(default="USD")
    window_started_at: datetime | None = Field(default=None)
    window_ended_at: datetime | None = Field(default=None)
    raw_payload: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    metadata_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    ingestion_note: str | None = Field(default=None, sa_column=Column(Text))
    recorded_at: datetime = Field(default_factory=utcnow, index=True)
