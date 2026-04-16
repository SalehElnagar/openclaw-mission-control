"""Activity event model persisted for audit and feed use-cases."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import JSON, Column, Text
from sqlmodel import Field

from app.core.time import utcnow
from app.models.base import QueryModel

RUNTIME_ANNOTATION_TYPES = (datetime,)


class ActivityEvent(QueryModel, table=True):
    """Discrete activity event tied to board/task/agent context."""

    __tablename__ = "activity_events"  # pyright: ignore[reportAssignmentType]

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    event_type: str = Field(index=True)
    message: str | None = None
    agent_id: UUID | None = Field(default=None, foreign_key="agents.id", index=True)
    task_id: UUID | None = Field(default=None, foreign_key="tasks.id", index=True)
    board_id: UUID | None = Field(default=None, foreign_key="boards.id", index=True)
    actor_type: str | None = Field(default=None, index=True)
    actor_user_id: UUID | None = Field(default=None, foreign_key="users.id", index=True)
    actor_label: str | None = Field(default=None, sa_column=Column(Text))
    entity_type: str | None = Field(default=None, index=True)
    entity_id: str | None = Field(default=None, sa_column=Column(Text, nullable=True, index=True))
    previous_values: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    new_values: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    details: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)
