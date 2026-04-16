"""Durable product plan drafts and approvals."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import JSON, Column
from sqlmodel import Field

from app.core.time import utcnow
from app.models.base import QueryModel

RUNTIME_ANNOTATION_TYPES = (datetime,)


class ProductPlan(QueryModel, table=True):
    """Current execution plan for a product."""

    __tablename__ = "product_plans"  # pyright: ignore[reportAssignmentType]

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    product_id: UUID = Field(foreign_key="products.id", index=True, unique=True)
    approved_by_user_id: UUID | None = Field(default=None, foreign_key="users.id")
    planner_agent_id: UUID | None = Field(default=None, foreign_key="agents.id", index=True)
    status: str = Field(default="draft", index=True)
    planner_session_key: str | None = None
    planner_model_ref: str | None = None
    planner_status: str | None = None
    planner_status_reason: str | None = None
    planner_last_escalation_reason: str | None = None
    plan_sync_status: str | None = None
    plan_sync_error: str | None = None
    intake_summary: str | None = None
    objective: str | None = None
    target_audience: str | None = None
    scope: str | None = None
    exclusions: str | None = None
    missing_questions: list[str] | None = Field(default=None, sa_column=Column(JSON))
    unresolved_question_keys: list[str] | None = Field(default=None, sa_column=Column(JSON))
    completeness: dict[str, object] | None = Field(default=None, sa_column=Column(JSON))
    proposed_services: list[dict[str, object]] | None = Field(default=None, sa_column=Column(JSON))
    initial_epics: list[dict[str, object]] | None = Field(default=None, sa_column=Column(JSON))
    role_assignments: dict[str, object] | None = Field(default=None, sa_column=Column(JSON))
    model_recommendations: list[dict[str, object]] | None = Field(
        default=None, sa_column=Column(JSON)
    )
    estimated_daily_budget_usd: float | None = None
    estimated_total_budget_usd: float | None = None
    budget_posture: str | None = None
    budget_warnings: list[str] | None = Field(default=None, sa_column=Column(JSON))
    last_message_at: datetime | None = None
    approved_at: datetime | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
