"""Telemetry ingestion and aggregation API."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status

from app.api.deps import require_org_member, require_user_or_agent
from app.db.session import get_session
from app.schemas.telemetry import UsageAggregateResponse, UsageSampleCreate, UsageSampleRead
from app.services.organizations import OrganizationContext
from app.services.telemetry import UsageAggregateFilters, UsageTelemetryService

if TYPE_CHECKING:
    from sqlmodel.ext.asyncio.session import AsyncSession

    from app.api.deps import ActorContext

router = APIRouter(prefix="/telemetry", tags=["telemetry"])
SESSION_DEP = Depends(get_session)
ACTOR_DEP = Depends(require_user_or_agent)
ORG_MEMBER_DEP = Depends(require_org_member)
GATEWAY_ID_QUERY = Query(default=None)
BOARD_ID_QUERY = Query(default=None)
AGENT_ID_QUERY = Query(default=None)
TASK_ID_QUERY = Query(default=None)
SINCE_QUERY = Query(default=None)
UNTIL_QUERY = Query(default=None)


@router.post(
    "/usage",
    response_model=UsageSampleRead,
    status_code=status.HTTP_201_CREATED,
)
async def ingest_usage_sample(
    payload: UsageSampleCreate,
    session: AsyncSession = SESSION_DEP,
    actor: ActorContext = ACTOR_DEP,
) -> UsageSampleRead:
    """Persist one usage/cost sample from a trusted runtime or operator path."""
    return await UsageTelemetryService(session).ingest_sample(payload=payload, actor=actor)


@router.get("/usage", response_model=UsageAggregateResponse)
async def aggregate_usage(
    gateway_id: UUID | None = GATEWAY_ID_QUERY,
    board_id: UUID | None = BOARD_ID_QUERY,
    agent_id: UUID | None = AGENT_ID_QUERY,
    task_id: UUID | None = TASK_ID_QUERY,
    since: datetime | None = SINCE_QUERY,
    until: datetime | None = UNTIL_QUERY,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_MEMBER_DEP,
) -> UsageAggregateResponse:
    """Aggregate usage/cost telemetry with gateway/board/agent/task filters."""
    return await UsageTelemetryService(session).aggregate_usage(
        filters=UsageAggregateFilters(
            organization_id=ctx.organization.id,
            gateway_id=gateway_id,
            board_id=board_id,
            agent_id=agent_id,
            task_id=task_id,
            since=since,
            until=until,
        ),
    )
