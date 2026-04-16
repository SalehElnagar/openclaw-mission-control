"""Product model that groups services and product-level planning."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import JSON, Column
from sqlmodel import Field

from app.core.time import utcnow
from app.models.tenancy import TenantScoped

RUNTIME_ANNOTATION_TYPES = (datetime,)


class Product(TenantScoped, table=True):
    """Top-level product folder for chat-first planning and execution."""

    __tablename__ = "products"  # pyright: ignore[reportAssignmentType]

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    organization_id: UUID = Field(foreign_key="organizations.id", index=True)
    default_gateway_id: UUID | None = Field(default=None, foreign_key="gateways.id", index=True)
    name: str
    slug: str = Field(index=True)
    description: str | None = None
    local_working_directory: str | None = None
    remote_repository_url: str | None = None
    status: str = Field(default="draft", index=True)
    optimize_for: str = Field(default="balanced")
    planner_mode: str = Field(default="auto")
    planner_model_override: str | None = None
    daily_budget_cap_usd: float | None = None
    total_budget_cap_usd: float | None = None
    execution_policy: dict[str, object] | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
