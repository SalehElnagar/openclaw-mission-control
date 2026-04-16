"""Pydantic/SQLModel schemas for agent API payloads."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import Field, field_validator
from sqlmodel import SQLModel
from sqlmodel._compat import SQLModelConfig

from app.schemas.common import NonEmptyStr
from app.schemas.gateway_runtime import _normalize_model_list, _normalize_model_ref

_RUNTIME_TYPE_REFERENCES = (datetime, UUID, NonEmptyStr)
MODEL_PROFILE_NAMES = {"general", "coder", "budget"}
FallbackPolicy = Literal["profile", "explicit-only", "none"]


def _normalize_identity_profile(
    profile: object,
) -> dict[str, str] | None:
    if not isinstance(profile, Mapping):
        return None
    normalized: dict[str, str] = {}
    for raw_key, raw in profile.items():
        if raw is None:
            continue
        key = str(raw_key).strip()
        if not key:
            continue
        if isinstance(raw, list):
            parts = [str(item).strip() for item in raw if str(item).strip()]
            if not parts:
                continue
            normalized[key] = ", ".join(parts)
            continue
        value = str(raw).strip()
        if value:
            normalized[key] = value
    return normalized or None


class AgentBase(SQLModel):
    """Common fields shared by agent create/read/update payloads."""

    model_config = SQLModelConfig(
        json_schema_extra={
            "x-llm-intent": "agent_profile",
            "x-when-to-use": [
                "Create or update canonical agent metadata",
                "Inspect agent attributes for governance or delegation",
            ],
            "x-when-not-to-use": [
                "Task lifecycle operations (use task endpoints)",
                "User-facing conversation content (not modeled here)",
            ],
            "x-required-actor": "lead_or_worker_agent",
            "x-prerequisites": [
                "board_id if required by your board policy",
                "identity templates should be valid JSON or text with expected markers",
            ],
            "x-response-shape": "AgentRead",
            "x-side-effects": [
                "Reads or writes core agent profile fields",
                "May impact routing or assignment decisions when persisted",
            ],
        },
    )

    board_id: UUID | None = Field(
        default=None,
        description="Board id that scopes this agent. Omit only when policy allows global agents.",
        examples=["11111111-1111-1111-1111-111111111111"],
    )
    product_id: UUID | None = Field(
        default=None,
        description="Optional product id for hidden planner or product-scoped agents.",
    )
    name: NonEmptyStr = Field(
        description="Human-readable agent display name.",
        examples=["Ops triage lead"],
    )
    purpose: str = Field(
        default="execution",
        description="Agent purpose, such as execution or product-planner.",
        examples=["execution", "product-planner"],
    )
    hidden: bool = Field(
        default=False,
        description="Whether the agent is hidden from the normal operator directory by default.",
    )
    status: str = Field(
        default="provisioning",
        description="Current lifecycle state used by coordinator logic.",
        examples=["provisioning", "online", "standby", "offline"],
    )
    heartbeat_config: dict[str, Any] | None = Field(
        default=None,
        description="Runtime heartbeat behavior overrides for this agent.",
        examples=[{"interval_seconds": 30, "missing_tolerance": 120}],
    )
    identity_profile: dict[str, Any] | None = Field(
        default=None,
        description="Optional profile hints used by routing and policy checks.",
        examples=[{"role": "incident_lead", "skill": "triage"}],
    )
    model_profile: str | None = Field(
        default=None,
        description="Optional named gateway model profile.",
        examples=["coder", "budget"],
    )
    model_primary: str | None = Field(
        default=None,
        description="Optional explicit primary model override.",
        examples=["openai/gpt-5.4", "codex/gpt-5.4"],
    )
    model_fallback_policy: FallbackPolicy = Field(
        default="profile",
        description="How explicit fallback models interact with the selected profile.",
    )
    model_fallbacks: list[str] | None = Field(
        default=None,
        description="Optional ordered fallback model list.",
        examples=[["openai/gpt-5.4-mini", "openai/gpt-5.4-nano"]],
    )
    identity_template: str | None = Field(
        default=None,
        description="Template that helps define initial intent and behavior.",
        examples=["You are a senior incident response lead."],
    )
    soul_template: str | None = Field(
        default=None,
        description="Template representing deeper agent instructions.",
        examples=["When critical blockers appear, escalate in plain language."],
    )

    @field_validator("identity_template", "soul_template", mode="before")
    @classmethod
    def normalize_templates(cls, value: object) -> object | None:
        """Normalize blank template text to null."""
        if value is None:
            return None
        if isinstance(value, str):
            value = value.strip()
            return value or None
        return value

    @field_validator("identity_profile", mode="before")
    @classmethod
    def normalize_identity_profile(
        cls,
        value: object,
    ) -> dict[str, str] | None:
        """Normalize identity-profile values into trimmed string mappings."""
        return _normalize_identity_profile(value)

    @field_validator("model_profile", mode="before")
    @classmethod
    def normalize_model_profile(cls, value: object) -> str | None | object:
        normalized = _normalize_model_ref(value)
        if normalized is None:
            return None
        if not isinstance(normalized, str):
            return normalized
        if normalized not in MODEL_PROFILE_NAMES:
            msg = "model_profile must be one of: general, coder, budget"
            raise ValueError(msg)
        return normalized

    @field_validator("model_primary", mode="before")
    @classmethod
    def normalize_model_primary(cls, value: object) -> str | None | object:
        return _normalize_model_ref(value)

    @field_validator("model_fallbacks", mode="before")
    @classmethod
    def normalize_model_fallbacks(cls, value: object) -> list[str] | None:
        return _normalize_model_list(value)


class AgentCreate(AgentBase):
    """Payload for creating a new agent."""


class AgentUpdate(SQLModel):
    """Payload for patching an existing agent."""

    model_config = SQLModelConfig(
        json_schema_extra={
            "x-llm-intent": "agent_profile_update",
            "x-when-to-use": [
                "Patch mutable agent metadata without replacing the full payload",
                "Update status, templates, or heartbeat policy",
            ],
            "x-when-not-to-use": [
                "Creating an agent (use AgentCreate)",
                "Hard deletes or archive actions (use lifecycle endpoints)",
            ],
            "x-required-actor": "board_lead",
            "x-prerequisites": [
                "Target agent id must exist and be visible to actor context",
            ],
            "x-side-effects": [
                "Mutates agent profile state",
            ],
        },
    )

    board_id: UUID | None = Field(
        default=None,
        description="Optional new board assignment.",
        examples=["22222222-2222-2222-2222-222222222222"],
    )
    product_id: UUID | None = Field(
        default=None,
        description="Optional product assignment for planner/system agents.",
    )
    is_gateway_main: bool | None = Field(
        default=None,
        description="Whether this agent is treated as the board gateway main.",
    )
    name: NonEmptyStr | None = Field(
        default=None,
        description="Optional replacement display name.",
        examples=["Ops triage lead"],
    )
    purpose: str | None = Field(
        default=None,
        description="Optional replacement purpose, such as product-planner.",
    )
    hidden: bool | None = Field(
        default=None,
        description="Optional visibility override for system agents.",
    )
    status: str | None = Field(
        default=None,
        description="Optional replacement lifecycle status.",
        examples=["active", "paused"],
    )
    heartbeat_config: dict[str, Any] | None = Field(
        default=None,
        description="Optional heartbeat policy override.",
        examples=[{"interval_seconds": 45}],
    )
    model_profile: str | None = Field(
        default=None,
        description="Optional named gateway profile override.",
        examples=["coder", "budget"],
    )
    model_primary: str | None = Field(
        default=None,
        description="Optional explicit primary model override.",
        examples=["codex/gpt-5.4"],
    )
    model_fallback_policy: FallbackPolicy | None = Field(
        default=None,
        description="Optional fallback policy override.",
    )
    model_fallbacks: list[str] | None = Field(
        default=None,
        description="Optional explicit fallback models.",
        examples=[["openai/gpt-5.4-mini"]],
    )
    identity_profile: dict[str, Any] | None = Field(
        default=None,
        description="Optional identity profile update values.",
        examples=[{"role": "coordinator"}],
    )
    identity_template: str | None = Field(
        default=None,
        description="Optional replacement identity template.",
        examples=["Focus on root cause analysis first."],
    )
    soul_template: str | None = Field(
        default=None,
        description="Optional replacement soul template.",
        examples=["Escalate only after checking all known mitigations."],
    )

    @field_validator("identity_template", "soul_template", mode="before")
    @classmethod
    def normalize_templates(cls, value: object) -> object | None:
        """Normalize blank template text to null."""
        if value is None:
            return None
        if isinstance(value, str):
            value = value.strip()
            return value or None
        return value

    @field_validator("identity_profile", mode="before")
    @classmethod
    def normalize_identity_profile(
        cls,
        value: object,
    ) -> dict[str, str] | None:
        """Normalize identity-profile values into trimmed string mappings."""
        return _normalize_identity_profile(value)

    @field_validator("model_profile", mode="before")
    @classmethod
    def normalize_model_profile(cls, value: object) -> str | None | object:
        return AgentBase.normalize_model_profile(value)

    @field_validator("model_primary", mode="before")
    @classmethod
    def normalize_model_primary(cls, value: object) -> str | None | object:
        return _normalize_model_ref(value)

    @field_validator("model_fallbacks", mode="before")
    @classmethod
    def normalize_model_fallbacks(cls, value: object) -> list[str] | None:
        return _normalize_model_list(value)


class AgentRead(AgentBase):
    """Public agent representation returned by the API."""

    model_config = SQLModelConfig(
        json_schema_extra={
            "x-llm-intent": "agent_profile_lookup",
            "x-when-to-use": [
                "Inspect live agent state for routing and ownership decisions",
            ],
            "x-required-actor": "board_lead_or_worker",
            "x-interpretation": "This is a read model; changes here should use update/lifecycle endpoints.",
        },
    )

    id: UUID = Field(description="Agent UUID.")
    gateway_id: UUID = Field(description="Gateway UUID that manages this agent.")
    product_id: UUID | None = Field(
        default=None,
        description="Optional product that owns this agent.",
    )
    purpose: str = Field(
        default="execution",
        description="Stored agent purpose, such as execution or product-planner.",
    )
    hidden: bool = Field(
        default=False,
        description="Whether the agent is hidden from the default agent list.",
    )
    is_board_lead: bool = Field(
        default=False,
        description="Whether this agent is the board lead.",
    )
    is_gateway_main: bool = Field(
        default=False,
        description="Whether this agent is the primary gateway agent.",
    )
    openclaw_session_id: str | None = Field(
        default=None,
        description="Optional openclaw session token.",
        examples=["sess_01J..."],
    )
    last_seen_at: datetime | None = Field(
        default=None,
        description="Last heartbeat timestamp.",
    )
    last_runtime_sync_at: datetime | None = Field(
        default=None,
        description="Last time Mission Control synced runtime policy to the gateway.",
    )
    status_reason: str | None = Field(
        default=None,
        description="Human-readable explanation for the computed status.",
    )
    created_at: datetime = Field(description="Creation timestamp.")
    updated_at: datetime = Field(description="Last update timestamp.")


class AgentHeartbeat(SQLModel):
    """Heartbeat status payload sent by agents."""

    model_config = SQLModelConfig(
        json_schema_extra={
            "x-llm-intent": "agent_health_signal",
            "x-when-to-use": [
                "Send periodic heartbeat to indicate liveness",
            ],
            "x-required-actor": "any_agent",
            "x-response-shape": "AgentRead",
        },
    )

    status: str | None = Field(
        default=None,
        description="Agent health status string.",
        examples=["healthy", "offline", "degraded"],
    )


class AgentHeartbeatCreate(AgentHeartbeat):
    """Heartbeat payload used to create an agent lazily."""

    model_config = SQLModelConfig(
        json_schema_extra={
            "x-llm-intent": "agent_bootstrap",
            "x-when-to-use": [
                "First heartbeat from a non-provisioned worker should bootstrap identity.",
            ],
            "x-required-actor": "agent",
            "x-prerequisites": ["Agent auth token already validated"],
            "x-response-shape": "AgentRead",
        },
    )

    name: NonEmptyStr = Field(
        description="Display name assigned during first heartbeat bootstrap.",
        examples=["Ops triage lead"],
    )
    board_id: UUID | None = Field(
        default=None,
        description="Optional board context for bootstrap.",
        examples=["33333333-3333-3333-3333-333333333333"],
    )


class AgentNudge(SQLModel):
    """Nudge message payload for pinging an agent."""

    model_config = SQLModelConfig(
        json_schema_extra={
            "x-llm-intent": "agent_nudge",
            "x-when-to-use": [
                "Prompt a specific agent to revisit or reprioritize work.",
            ],
            "x-required-actor": "board_lead",
            "x-response-shape": "AgentRead",
        },
    )

    message: NonEmptyStr = Field(
        description="Short message to direct an agent toward immediate attention.",
        examples=["Please update the incident triage status for task T-001."],
    )
