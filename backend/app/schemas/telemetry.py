"""Schemas for telemetry ingestion and usage aggregation APIs."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlmodel import Field, SQLModel

from pydantic import field_validator

from app.schemas.gateway_runtime import _normalize_model_ref

RUNTIME_TYPE_REFERENCES = (datetime, UUID)


class UsageSampleCreate(SQLModel):
    """Inbound telemetry payload from a runtime or operator sync."""

    gateway_id: UUID
    board_id: UUID | None = None
    agent_id: UUID | None = None
    task_id: UUID | None = None
    source: str = "runtime-report"
    model: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int | None = None
    cost_usd: float = 0.0
    currency: str = "USD"
    window_started_at: datetime | None = None
    window_ended_at: datetime | None = None
    metadata_json: dict[str, object] | None = None
    raw_payload: dict[str, object] | None = None
    ingestion_note: str | None = None

    @field_validator("model", mode="before")
    @classmethod
    def normalize_model(cls, value: object) -> str | None | object:
        return _normalize_model_ref(value)


class UsageSampleRead(SQLModel):
    """Stored telemetry sample."""

    id: UUID
    organization_id: UUID
    gateway_id: UUID
    board_id: UUID | None = None
    agent_id: UUID | None = None
    task_id: UUID | None = None
    source: str
    model: str | None = None
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: float
    currency: str
    window_started_at: datetime | None = None
    window_ended_at: datetime | None = None
    metadata_json: dict[str, object] | None = None
    raw_payload: dict[str, object] | None = None
    ingestion_note: str | None = None
    recorded_at: datetime


class UsageAggregateBucket(SQLModel):
    """Bucketed usage totals for charting/reporting."""

    period: datetime
    total_cost_usd: float
    total_tokens: int


class UsageAggregateResponse(SQLModel):
    """Aggregated usage totals with optional model breakdown."""

    total_cost_usd: float
    total_prompt_tokens: int
    total_completion_tokens: int
    total_tokens: int
    models: dict[str, float] = Field(default_factory=dict)
    buckets: list[UsageAggregateBucket] = Field(default_factory=list)


class GatewayUsagePullResponse(SQLModel):
    """Result of pulling usage telemetry from a gateway runtime."""

    gateway_id: UUID
    ingested_samples: int
    warnings: list[str] = Field(default_factory=list)
