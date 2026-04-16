"""Utilities for recording normalized activity events."""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping
    from uuid import UUID

    from sqlmodel.ext.asyncio.session import AsyncSession

    from app.core.auth import AuthContext
    from app.models.users import User

from app.models.activity_events import ActivityEvent

SENSITIVE_CHANGE_KEYS = {"token", "gateway_token", "local_auth_token", "api_key", "secret"}


def _actor_label_for_user(user: User | None) -> str | None:
    if user is None:
        return None
    for value in (user.preferred_name, user.name, user.email):
        text = (value or "").strip()
        if text:
            return text
    return None


def actor_fields_from_auth(auth: AuthContext | None) -> dict[str, object]:
    """Convert an auth context into activity-event actor fields."""
    user = auth.user if auth is not None else None
    return {
        "actor_type": auth.actor_type if auth is not None else None,
        "actor_user_id": user.id if user is not None else None,
        "actor_label": _actor_label_for_user(user),
    }


def redact_change_values(values: Mapping[str, object] | None) -> dict[str, object] | None:
    """Redact sensitive before/after values while keeping diffs auditable."""
    if values is None:
        return None
    redacted: dict[str, object] = {}
    for key, raw in values.items():
        lowered = key.lower()
        if lowered in SENSITIVE_CHANGE_KEYS:
            text = str(raw).strip() if raw is not None else ""
            fingerprint = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12] if text else None
            redacted[key] = {
                "redacted": True,
                "present": bool(text),
                "fingerprint": fingerprint,
            }
            continue
        redacted[key] = raw
    return redacted


def record_activity(
    session: AsyncSession,
    *,
    event_type: str,
    message: str,
    agent_id: UUID | None = None,
    task_id: UUID | None = None,
    board_id: UUID | None = None,
    actor_type: str | None = None,
    actor_user_id: UUID | None = None,
    actor_label: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    previous_values: dict[str, object] | None = None,
    new_values: dict[str, object] | None = None,
    details: dict[str, object] | None = None,
) -> ActivityEvent:
    """Create and attach an activity event row to the current DB session."""
    event = ActivityEvent(
        event_type=event_type,
        message=message,
        agent_id=agent_id,
        task_id=task_id,
        board_id=board_id,
        actor_type=actor_type,
        actor_user_id=actor_user_id,
        actor_label=actor_label,
        entity_type=entity_type,
        entity_id=entity_id,
        previous_values=previous_values,
        new_values=new_values,
        details=details,
    )
    session.add(event)
    return event
