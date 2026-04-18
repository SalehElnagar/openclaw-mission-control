"""Thin API wrappers for gateway CRUD and template synchronization."""

from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query
from sqlmodel import col

from app.api.deps import require_org_admin
from app.core.auth import AuthContext, get_auth_context
from app.db import crud
from app.db.pagination import paginate
from app.db.session import get_session
from app.models.activity_events import ActivityEvent
from app.models.agents import Agent
from app.models.gateways import Gateway
from app.models.skills import GatewayInstalledSkill
from app.schemas.common import OkResponse
from app.schemas.gateway_runtime import (
    GatewayProviderAuthActionResponse,
    GatewayProviderAuthChallengeInputRequest,
    GatewayRuntimeSummary,
    GatewayRuntimeSyncRequest,
    GatewayRuntimeSyncResponse,
    RuntimeAuditRecordRead,
)
from app.schemas.gateways import (
    GatewayCreate,
    GatewayRead,
    GatewayTemplatesSyncResult,
    GatewayUpdate,
)
from app.schemas.pagination import DefaultLimitOffsetPage
from app.schemas.telemetry import GatewayUsagePullResponse
from app.services.activity_log import actor_fields_from_auth, record_activity, redact_change_values
from app.services.gateway_secret_store import GatewaySecretStoreService
from app.services.openclaw.admin_service import GatewayAdminLifecycleService
from app.services.openclaw.runtime_control import GatewayRuntimeControlService
from app.services.openclaw.session_service import GatewayTemplateSyncQuery

if TYPE_CHECKING:
    from fastapi_pagination.limit_offset import LimitOffsetPage
    from sqlmodel.ext.asyncio.session import AsyncSession

    from app.services.organizations import OrganizationContext


router = APIRouter(prefix="/gateways", tags=["gateways"])
SESSION_DEP = Depends(get_session)
AUTH_DEP = Depends(get_auth_context)
ORG_ADMIN_DEP = Depends(require_org_admin)
INCLUDE_MAIN_QUERY = Query(default=True)
RESET_SESSIONS_QUERY = Query(default=False)
ROTATE_TOKENS_QUERY = Query(default=False)
FORCE_BOOTSTRAP_QUERY = Query(default=False)
OVERWRITE_QUERY = Query(default=False)
LEAD_ONLY_QUERY = Query(default=False)
BOARD_ID_QUERY = Query(default=None)
_RUNTIME_TYPE_REFERENCES = (UUID,)
_GATEWAY_AUDIT_FIELDS = {
    "name",
    "url",
    "node_class",
    "workspace_root",
    "allow_insecure_tls",
    "disable_device_pairing",
    "default_model_profile",
    "model_profiles",
    "enabled_model_refs",
    "tool_profile",
    "provider_configs",
    "model_definitions",
    "provider_auth_configs",
    "provider_secret_refs",
    "token",
}


async def _apply_provider_secret_inputs(
    *,
    gateway: Gateway,
    secret_inputs: list[object] | None,
    session: AsyncSession,
) -> None:
    if not secret_inputs:
        return
    service = GatewaySecretStoreService(session)
    existing_refs = (
        gateway.provider_secret_refs if isinstance(gateway.provider_secret_refs, list) else []
    )
    refs_by_scope: dict[tuple[str, str], dict[str, object]] = {}
    order: list[tuple[str, str]] = []
    for raw in existing_refs:
        if not isinstance(raw, dict):
            continue
        provider_id = raw.get("provider_id")
        purpose = raw.get("purpose")
        if not isinstance(provider_id, str) or not isinstance(purpose, str):
            continue
        key = (provider_id, purpose)
        if key not in order:
            order.append(key)
        refs_by_scope[key] = dict(raw)
    for raw in secret_inputs:
        if not isinstance(raw, dict):
            continue
        provider_id = raw.get("provider_id")
        purpose = raw.get("purpose")
        value = raw.get("value")
        alias = raw.get("alias")
        if (
            not isinstance(provider_id, str)
            or not isinstance(purpose, str)
            or not isinstance(value, str)
        ):
            continue
        stored_ref = await service.upsert_secret(
            gateway=gateway,
            provider_id=provider_id,
            purpose=purpose,
            value=value,
            alias=alias if isinstance(alias, str) else None,
        )
        key = (provider_id, purpose)
        if key not in order:
            order.append(key)
        refs_by_scope[key] = stored_ref.model_dump(exclude_none=True)
    gateway.provider_secret_refs = [refs_by_scope[key] for key in order] or None
    session.add(gateway)


def _gateway_audit_payload(values: dict[str, object]) -> dict[str, object]:
    payload = {key: values.get(key) for key in _GATEWAY_AUDIT_FIELDS if key in values}
    return redact_change_values(payload) or {}


def _template_sync_query(
    *,
    include_main: bool = INCLUDE_MAIN_QUERY,
    lead_only: bool = LEAD_ONLY_QUERY,
    reset_sessions: bool = RESET_SESSIONS_QUERY,
    rotate_tokens: bool = ROTATE_TOKENS_QUERY,
    force_bootstrap: bool = FORCE_BOOTSTRAP_QUERY,
    overwrite: bool = OVERWRITE_QUERY,
    board_id: UUID | None = BOARD_ID_QUERY,
) -> GatewayTemplateSyncQuery:
    return GatewayTemplateSyncQuery(
        include_main=include_main,
        lead_only=lead_only,
        reset_sessions=reset_sessions,
        rotate_tokens=rotate_tokens,
        force_bootstrap=force_bootstrap,
        overwrite=overwrite,
        board_id=board_id,
    )


SYNC_QUERY_DEP = Depends(_template_sync_query)


@router.get("", response_model=DefaultLimitOffsetPage[GatewayRead])
async def list_gateways(
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> LimitOffsetPage[GatewayRead]:
    """List gateways for the caller's organization."""
    statement = (
        Gateway.objects.filter_by(organization_id=ctx.organization.id)
        .order_by(col(Gateway.created_at).desc())
        .statement
    )

    return await paginate(session, statement)


@router.post("", response_model=GatewayRead)
async def create_gateway(
    payload: GatewayCreate,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> Gateway:
    """Create a gateway and provision or refresh its main agent."""
    service = GatewayAdminLifecycleService(session)
    runtime_service = GatewayRuntimeControlService(session)
    await service.assert_gateway_runtime_compatible(
        url=payload.url,
        token=payload.token,
        allow_insecure_tls=payload.allow_insecure_tls,
        disable_device_pairing=payload.disable_device_pairing,
    )
    payload_data = payload.model_dump()
    secret_inputs = payload_data.pop("provider_secret_inputs", None)
    data = payload_data
    gateway_id = uuid4()
    data["id"] = gateway_id
    data["organization_id"] = ctx.organization.id
    candidate = Gateway.model_validate(data)
    await runtime_service.assert_model_policies_supported(gateway=candidate, agents=[])
    gateway = await crud.create(session, Gateway, **data)
    await _apply_provider_secret_inputs(
        gateway=gateway,
        secret_inputs=secret_inputs,
        session=session,
    )
    record_activity(
        session,
        event_type="gateway.config.created",
        message=f"Created gateway {gateway.name}.",
        entity_type="gateway",
        entity_id=str(gateway.id),
        new_values=_gateway_audit_payload(data),
        **actor_fields_from_auth(auth),
    )
    await session.commit()
    await runtime_service.reconcile_gateway_runtime(
        gateway=gateway,
        auth=auth,
        request=GatewayRuntimeSyncRequest(),
    )
    return gateway


@router.get("/{gateway_id}", response_model=GatewayRead)
async def get_gateway(
    gateway_id: UUID,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> Gateway:
    """Return one gateway by id for the caller's organization."""
    service = GatewayAdminLifecycleService(session)
    gateway = await service.require_gateway(
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    return gateway


@router.patch("/{gateway_id}", response_model=GatewayRead)
async def update_gateway(
    gateway_id: UUID,
    payload: GatewayUpdate,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> Gateway:
    """Patch a gateway and refresh the main-agent provisioning state."""
    service = GatewayAdminLifecycleService(session)
    runtime_service = GatewayRuntimeControlService(session)
    gateway = await service.require_gateway(
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    payload_updates = payload.model_dump(exclude_unset=True)
    secret_inputs = payload_updates.pop("provider_secret_inputs", None)
    updates = payload_updates
    before = _gateway_audit_payload(gateway.model_dump())
    if (
        "url" in updates
        or "token" in updates
        or "allow_insecure_tls" in updates
        or "disable_device_pairing" in updates
    ):
        raw_next_url = updates.get("url", gateway.url)
        next_url = raw_next_url.strip() if isinstance(raw_next_url, str) else ""
        next_token = updates.get("token", gateway.token)
        next_allow_insecure_tls = bool(
            updates.get("allow_insecure_tls", gateway.allow_insecure_tls),
        )
        next_disable_device_pairing = bool(
            updates.get("disable_device_pairing", gateway.disable_device_pairing),
        )
        if next_url:
            await service.assert_gateway_runtime_compatible(
                url=next_url,
                token=next_token,
                allow_insecure_tls=next_allow_insecure_tls,
                disable_device_pairing=next_disable_device_pairing,
            )
    if updates:
        candidate_data = gateway.model_dump()
        candidate_data.update(updates)
        candidate = Gateway.model_validate(candidate_data)
        existing_agents = await Agent.objects.filter_by(gateway_id=gateway.id).all(session)
        await runtime_service.assert_model_policies_supported(
            gateway=candidate,
            agents=existing_agents,
        )
    await crud.patch(session, gateway, updates)
    await _apply_provider_secret_inputs(
        gateway=gateway,
        secret_inputs=secret_inputs,
        session=session,
    )
    if updates or secret_inputs:
        record_activity(
            session,
            event_type="gateway.config.updated",
            message=f"Updated gateway {gateway.name}.",
            entity_type="gateway",
            entity_id=str(gateway.id),
            previous_values=before,
            new_values=_gateway_audit_payload(gateway.model_dump()),
            details={
                "updated_fields": sorted(updates.keys()),
                "secret_inputs_updated": bool(secret_inputs),
            },
            **actor_fields_from_auth(auth),
        )
        await session.commit()
        await runtime_service.reconcile_gateway_runtime(
            gateway=gateway,
            auth=auth,
            request=GatewayRuntimeSyncRequest(),
        )
    return gateway


@router.post("/{gateway_id}/templates/sync", response_model=GatewayTemplatesSyncResult)
async def sync_gateway_templates(
    gateway_id: UUID,
    sync_query: GatewayTemplateSyncQuery = SYNC_QUERY_DEP,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> GatewayTemplatesSyncResult:
    """Sync templates for a gateway and optionally rotate runtime settings."""
    service = GatewayAdminLifecycleService(session)
    gateway = await service.require_gateway(
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    return await service.sync_templates(gateway, query=sync_query, auth=auth)


@router.get("/{gateway_id}/runtime", response_model=GatewayRuntimeSummary)
async def get_gateway_runtime(
    gateway_id: UUID,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> GatewayRuntimeSummary:
    """Return runtime connectivity and model policy state for one gateway."""
    service = GatewayAdminLifecycleService(session)
    gateway = await service.require_gateway(
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    return await GatewayRuntimeControlService(session).runtime_summary(gateway=gateway)


@router.post("/{gateway_id}/runtime/reconcile", response_model=GatewayRuntimeSyncResponse)
async def reconcile_gateway_runtime(
    gateway_id: UUID,
    payload: GatewayRuntimeSyncRequest,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> GatewayRuntimeSyncResponse:
    """Idempotently repair runtime provisioning and sync model policy."""
    service = GatewayAdminLifecycleService(session)
    gateway = await service.require_gateway(
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    return await GatewayRuntimeControlService(session).reconcile_gateway_runtime(
        gateway=gateway,
        auth=auth,
        request=payload,
    )


@router.post(
    "/{gateway_id}/providers/{provider_id}/connect",
    response_model=GatewayProviderAuthActionResponse,
)
async def connect_gateway_provider_auth(
    gateway_id: UUID,
    provider_id: str,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> GatewayProviderAuthActionResponse:
    service = GatewayAdminLifecycleService(session)
    gateway = await service.require_gateway(
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    return await GatewayRuntimeControlService(session).connect_provider_auth(
        gateway=gateway,
        provider_id=provider_id,
        auth=auth,
    )


@router.post(
    "/{gateway_id}/providers/{provider_id}/refresh",
    response_model=GatewayProviderAuthActionResponse,
)
async def refresh_gateway_provider_auth(
    gateway_id: UUID,
    provider_id: str,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> GatewayProviderAuthActionResponse:
    service = GatewayAdminLifecycleService(session)
    gateway = await service.require_gateway(
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    return await GatewayRuntimeControlService(session).refresh_provider_auth(
        gateway=gateway,
        provider_id=provider_id,
        auth=auth,
    )


@router.post(
    "/{gateway_id}/providers/{provider_id}/disconnect",
    response_model=GatewayProviderAuthActionResponse,
)
async def disconnect_gateway_provider_auth(
    gateway_id: UUID,
    provider_id: str,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> GatewayProviderAuthActionResponse:
    service = GatewayAdminLifecycleService(session)
    gateway = await service.require_gateway(
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    return await GatewayRuntimeControlService(session).disconnect_provider_auth(
        gateway=gateway,
        provider_id=provider_id,
        auth=auth,
    )


@router.post(
    "/{gateway_id}/providers/{provider_id}/challenge-input",
    response_model=GatewayProviderAuthActionResponse,
)
async def submit_gateway_provider_challenge_input(
    gateway_id: UUID,
    provider_id: str,
    payload: GatewayProviderAuthChallengeInputRequest,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> GatewayProviderAuthActionResponse:
    """Submit follow-up input for an active interactive provider auth session."""
    service = GatewayAdminLifecycleService(session)
    gateway = await service.require_gateway(
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    return await GatewayRuntimeControlService(session).submit_provider_auth_challenge_input(
        gateway=gateway,
        provider_id=provider_id,
        session_id=payload.session_id,
        input_text=payload.input_text,
        auth=auth,
    )


@router.post("/{gateway_id}/telemetry/pull", response_model=GatewayUsagePullResponse)
async def pull_gateway_telemetry(
    gateway_id: UUID,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> GatewayUsagePullResponse:
    """Pull usage/cost telemetry directly from the gateway RPC surface."""
    service = GatewayAdminLifecycleService(session)
    gateway = await service.require_gateway(
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    ingested = await GatewayRuntimeControlService(session).pull_gateway_usage(
        gateway=gateway,
        auth=auth,
    )
    return GatewayUsagePullResponse(gateway_id=gateway.id, ingested_samples=ingested)


@router.get("/{gateway_id}/audit", response_model=DefaultLimitOffsetPage[RuntimeAuditRecordRead])
async def list_gateway_audit(
    gateway_id: UUID,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> LimitOffsetPage[RuntimeAuditRecordRead]:
    """List gateway-scoped audit records."""
    service = GatewayAdminLifecycleService(session)
    await service.require_gateway(
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    statement = (
        ActivityEvent.objects.filter_by(entity_type="gateway", entity_id=str(gateway_id))
        .order_by(col(ActivityEvent.created_at).desc())
        .statement
    )

    def _transform(items: list[object]) -> list[RuntimeAuditRecordRead]:
        rows: list[RuntimeAuditRecordRead] = []
        for item in items:
            if not isinstance(item, ActivityEvent):
                msg = "Expected ActivityEvent items from gateway audit query"
                raise TypeError(msg)
            rows.append(RuntimeAuditRecordRead.model_validate(item, from_attributes=True))
        return rows

    return await paginate(session, statement, transformer=_transform)


@router.delete("/{gateway_id}", response_model=OkResponse)
async def delete_gateway(
    gateway_id: UUID,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> OkResponse:
    """Delete a gateway in the caller's organization."""
    service = GatewayAdminLifecycleService(session)
    gateway = await service.require_gateway(
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    main_agent = await service.find_main_agent(gateway)
    if main_agent is not None:
        await service.clear_agent_foreign_keys(agent_id=main_agent.id)
        await session.delete(main_agent)

    duplicate_main_agents = await Agent.objects.filter_by(
        gateway_id=gateway.id,
        board_id=None,
    ).all(session)
    for agent in duplicate_main_agents:
        if main_agent is not None and agent.id == main_agent.id:
            continue
        await service.clear_agent_foreign_keys(agent_id=agent.id)
        await session.delete(agent)

    # NOTE: The migration declares `ondelete="CASCADE"` for gateway_installed_skills.gateway_id,
    # but some backends/test environments (e.g. SQLite without FK pragma) may not
    # enforce cascades. Delete rows explicitly to guarantee cleanup semantics.
    installed_skills = await GatewayInstalledSkill.objects.filter_by(
        gateway_id=gateway.id,
    ).all(session)
    for installed_skill in installed_skills:
        await session.delete(installed_skill)

    await session.delete(gateway)
    await session.commit()
    return OkResponse()
