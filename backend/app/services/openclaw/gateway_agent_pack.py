"""Shared definitions for gateway-scoped managed agents."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from app.models.agents import Agent
from app.models.gateways import Gateway
from app.services.openclaw.constants import DEFAULT_HEARTBEAT_CONFIG
from app.services.openclaw.internal.agent_key import agent_key as runtime_agent_id
from app.services.openclaw.internal.session_keys import gateway_execution_session_key
from app.services.openclaw.shared import GatewayAgentIdentity

MAIN_AGENT_PURPOSE = "gateway-main"
STARTER_PACK_PRIMARY_MODEL_REF = "microsoft-foundry/gpt-5.4-mini"


@dataclass(frozen=True, slots=True)
class GatewayManagedAgentSpec:
    """Desired state for one managed gateway-scoped agent."""

    key: str
    role: str
    purpose: str
    communication_style: str = "direct, concise, practical"
    emoji: str = ":gear:"
    model_profile: str | None = None
    model_primary: str | None = None
    hidden: bool = False
    is_board_lead: bool = False

    def display_name(self, gateway: Gateway) -> str:
        if self.purpose == MAIN_AGENT_PURPOSE:
            return f"{gateway.name} Gateway Agent"
        return f"{gateway.name} {self.role}"

    def session_key(self, gateway: Gateway | UUID) -> str:
        gateway_id = gateway if isinstance(gateway, UUID) else gateway.id
        if self.purpose == MAIN_AGENT_PURPOSE:
            return GatewayAgentIdentity.session_key_for_id(gateway_id)
        return gateway_execution_session_key(gateway_id, self.key)

    def identity_profile(self) -> dict[str, str]:
        return {
            "role": self.role,
            "communication_style": self.communication_style,
            "emoji": self.emoji,
        }


MAIN_AGENT_SPEC = GatewayManagedAgentSpec(
    key="gateway-main",
    role="Gateway Agent",
    purpose=MAIN_AGENT_PURPOSE,
    emoji=":compass:",
    model_profile="general",
    model_primary=STARTER_PACK_PRIMARY_MODEL_REF,
)

STARTER_PACK_SPECS: tuple[GatewayManagedAgentSpec, ...] = (
    GatewayManagedAgentSpec(
        key="lead",
        role="Lead",
        purpose="execution",
        emoji=":compass:",
        model_profile="general",
        model_primary=STARTER_PACK_PRIMARY_MODEL_REF,
    ),
    GatewayManagedAgentSpec(
        key="builder",
        role="Builder",
        purpose="execution",
        emoji=":hammer_and_wrench:",
        model_profile="coder",
        model_primary=STARTER_PACK_PRIMARY_MODEL_REF,
    ),
    GatewayManagedAgentSpec(
        key="reviewer",
        role="Reviewer",
        purpose="execution",
        emoji=":mag:",
        model_profile="general",
        model_primary=STARTER_PACK_PRIMARY_MODEL_REF,
    ),
    GatewayManagedAgentSpec(
        key="security",
        role="Security",
        purpose="execution",
        emoji=":shield:",
        model_profile="budget",
        model_primary=STARTER_PACK_PRIMARY_MODEL_REF,
    ),
)

MANAGED_GATEWAY_AGENT_SPECS: tuple[GatewayManagedAgentSpec, ...] = (
    MAIN_AGENT_SPEC,
    *STARTER_PACK_SPECS,
)


def is_gateway_main_agent(agent: Agent) -> bool:
    """Return whether an agent is the gateway-main record."""

    board_id = getattr(agent, "board_id", None)
    if board_id is not None:
        return False
    purpose = getattr(agent, "purpose", None)
    if purpose == MAIN_AGENT_PURPOSE:
        return True
    gateway_id = getattr(agent, "gateway_id", None)
    session_id = getattr(agent, "openclaw_session_id", None)
    if gateway_id is None or not session_id:
        return False
    return session_id == GatewayAgentIdentity.session_key_for_id(gateway_id)


def is_gateway_execution_agent(agent: Agent) -> bool:
    """Return whether an agent is a boardless reusable gateway execution role."""

    return (
        getattr(agent, "board_id", None) is None
        and getattr(agent, "purpose", None) == "execution"
        and not is_gateway_main_agent(agent)
    )


def runtime_agent_identifier(gateway: Gateway, agent: Agent) -> str:
    """Return the OpenClaw agent id for a gateway-managed or board agent."""

    if is_gateway_main_agent(agent):
        return GatewayAgentIdentity.openclaw_agent_id(gateway)
    return runtime_agent_id(agent)


def apply_gateway_managed_agent_spec(
    *,
    gateway: Gateway,
    spec: GatewayManagedAgentSpec,
    agent: Agent | None = None,
) -> tuple[Agent, bool]:
    """Create or normalize one managed gateway agent row."""

    changed = False
    session_key = spec.session_key(gateway)
    desired_name = spec.display_name(gateway)
    desired_identity_profile = spec.identity_profile()
    if agent is None:
        agent = Agent(
            name=desired_name,
            purpose=spec.purpose,
            hidden=spec.hidden,
            status="provisioning",
            board_id=None,
            gateway_id=gateway.id,
            is_board_lead=spec.is_board_lead,
            openclaw_session_id=session_key,
            heartbeat_config=DEFAULT_HEARTBEAT_CONFIG.copy(),
            identity_profile=desired_identity_profile,
            model_profile=spec.model_profile,
            model_primary=spec.model_primary,
        )
        return agent, True

    if agent.name != desired_name:
        agent.name = desired_name
        changed = True
    if agent.purpose != spec.purpose:
        agent.purpose = spec.purpose
        changed = True
    if agent.hidden != spec.hidden:
        agent.hidden = spec.hidden
        changed = True
    if agent.gateway_id != gateway.id:
        agent.gateway_id = gateway.id
        changed = True
    if agent.board_id is not None:
        agent.board_id = None
        changed = True
    if agent.is_board_lead != spec.is_board_lead:
        agent.is_board_lead = spec.is_board_lead
        changed = True
    if agent.openclaw_session_id != session_key:
        agent.openclaw_session_id = session_key
        changed = True
    if agent.heartbeat_config is None:
        agent.heartbeat_config = DEFAULT_HEARTBEAT_CONFIG.copy()
        changed = True
    if agent.identity_profile != desired_identity_profile:
        agent.identity_profile = desired_identity_profile
        changed = True
    if spec.model_profile is not None and agent.model_profile != spec.model_profile:
        agent.model_profile = spec.model_profile
        changed = True
    if spec.model_primary is not None and agent.model_primary != spec.model_primary:
        agent.model_primary = spec.model_primary
        changed = True
    if not agent.status:
        agent.status = "provisioning"
        changed = True
    return agent, changed
