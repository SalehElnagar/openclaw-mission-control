"""Telemetry ingestion and aggregation services."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Protocol
from uuid import UUID

from fastapi import HTTPException, status
from sqlmodel import col, select

from app.models.agents import Agent
from app.models.boards import Board
from app.models.gateway_usage_samples import GatewayUsageSample
from app.models.gateways import Gateway
from app.models.tasks import Task
from app.schemas.telemetry import (
    UsageAggregateBucket,
    UsageAggregateResponse,
    UsageSampleCreate,
    UsageSampleRead,
)
from app.services.openclaw.db_service import OpenClawDBService
from app.services.organizations import get_active_membership, has_board_access, is_org_admin

if TYPE_CHECKING:
    from app.models.users import User


class ActorContextLike(Protocol):
    """Minimal actor context needed for telemetry ingress."""

    actor_type: str
    user: User | None
    agent: Agent | None


def _normalize_bucket(value: datetime) -> datetime:
    return value.replace(minute=0, second=0, microsecond=0)


@dataclass(frozen=True)
class UsageAggregateFilters:
    """Query filters for telemetry aggregation."""

    organization_id: UUID
    gateway_id: UUID | None = None
    board_id: UUID | None = None
    agent_id: UUID | None = None
    task_id: UUID | None = None
    since: datetime | None = None
    until: datetime | None = None


class UsageTelemetryService(OpenClawDBService):
    """Persist and aggregate Mission Control usage telemetry."""

    async def _require_gateway(self, gateway_id: UUID) -> Gateway:
        gateway = await Gateway.objects.by_id(gateway_id).first(self.session)
        if gateway is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Gateway not found")
        return gateway

    async def _require_board(self, board_id: UUID) -> Board:
        board = await Board.objects.by_id(board_id).first(self.session)
        if board is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Board not found")
        return board

    async def _require_agent(self, agent_id: UUID) -> Agent:
        agent = await Agent.objects.by_id(agent_id).first(self.session)
        if agent is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
        return agent

    async def _require_task(self, task_id: UUID) -> Task:
        task = await Task.objects.by_id(task_id).first(self.session)
        if task is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
        return task

    async def ingest_sample(
        self,
        *,
        payload: UsageSampleCreate,
        actor: ActorContextLike,
    ) -> UsageSampleRead:
        """Persist one telemetry sample from a trusted user or agent caller."""
        gateway = await self._require_gateway(payload.gateway_id)
        board_id = payload.board_id
        agent_id = payload.agent_id
        task_id = payload.task_id

        if actor.actor_type == "agent":
            if actor.agent is None:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
            if actor.agent.gateway_id != gateway.id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)
            agent_id = actor.agent.id
            if board_id is None:
                board_id = actor.agent.board_id
            elif actor.agent.board_id is not None and board_id != actor.agent.board_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)
        else:
            if actor.user is None:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
            member = await get_active_membership(self.session, actor.user)
            if member is None or member.organization_id != gateway.organization_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)
            if not is_org_admin(member) and board_id is None:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Board-scoped telemetry requires board access for non-admin users.",
                )
            if board_id is not None:
                board = await self._require_board(board_id)
                allowed = await has_board_access(
                    self.session, member=member, board=board, write=True
                )
                if not allowed:
                    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)

        if board_id is not None:
            board = await self._require_board(board_id)
            if board.organization_id != gateway.organization_id:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT)
        if agent_id is not None:
            agent = await self._require_agent(agent_id)
            if agent.gateway_id != gateway.id:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT)
            if board_id is not None and agent.board_id is not None and agent.board_id != board_id:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT)
        if task_id is not None:
            task = await self._require_task(task_id)
            if board_id is not None and task.board_id != board_id:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT)

        total_tokens = payload.total_tokens
        if total_tokens is None:
            total_tokens = max(0, payload.prompt_tokens) + max(0, payload.completion_tokens)

        sample = GatewayUsageSample(
            organization_id=gateway.organization_id,
            gateway_id=gateway.id,
            board_id=board_id,
            agent_id=agent_id,
            task_id=task_id,
            source=payload.source,
            model=payload.model,
            prompt_tokens=max(0, payload.prompt_tokens),
            completion_tokens=max(0, payload.completion_tokens),
            total_tokens=max(0, total_tokens),
            cost_usd=max(0.0, payload.cost_usd),
            currency=(payload.currency or "USD").strip() or "USD",
            window_started_at=payload.window_started_at,
            window_ended_at=payload.window_ended_at,
            raw_payload=payload.raw_payload,
            metadata_json=payload.metadata_json,
            ingestion_note=payload.ingestion_note,
        )
        await self.add_commit_refresh(sample)
        return UsageSampleRead.model_validate(sample, from_attributes=True)

    async def store_gateway_pull_samples(
        self,
        *,
        gateway: Gateway,
        samples: Iterable[UsageSampleCreate],
    ) -> list[GatewayUsageSample]:
        """Persist internally-generated gateway telemetry samples."""
        persisted: list[GatewayUsageSample] = []
        for payload in samples:
            total_tokens = payload.total_tokens
            if total_tokens is None:
                total_tokens = max(0, payload.prompt_tokens) + max(0, payload.completion_tokens)
            sample = GatewayUsageSample(
                organization_id=gateway.organization_id,
                gateway_id=gateway.id,
                board_id=payload.board_id,
                agent_id=payload.agent_id,
                task_id=payload.task_id,
                source=payload.source,
                model=payload.model,
                prompt_tokens=max(0, payload.prompt_tokens),
                completion_tokens=max(0, payload.completion_tokens),
                total_tokens=max(0, total_tokens),
                cost_usd=max(0.0, payload.cost_usd),
                currency=(payload.currency or "USD").strip() or "USD",
                window_started_at=payload.window_started_at,
                window_ended_at=payload.window_ended_at,
                raw_payload=payload.raw_payload,
                metadata_json=payload.metadata_json,
                ingestion_note=payload.ingestion_note,
            )
            self.session.add(sample)
            persisted.append(sample)
        await self.session.commit()
        for sample in persisted:
            await self.session.refresh(sample)
        return persisted

    async def aggregate_usage(self, *, filters: UsageAggregateFilters) -> UsageAggregateResponse:
        """Aggregate usage totals in Python for SQLite/Postgres portability."""
        statement = select(GatewayUsageSample).where(
            col(GatewayUsageSample.organization_id) == filters.organization_id,
        )
        if filters.gateway_id is not None:
            statement = statement.where(col(GatewayUsageSample.gateway_id) == filters.gateway_id)
        if filters.board_id is not None:
            statement = statement.where(col(GatewayUsageSample.board_id) == filters.board_id)
        if filters.agent_id is not None:
            statement = statement.where(col(GatewayUsageSample.agent_id) == filters.agent_id)
        if filters.task_id is not None:
            statement = statement.where(col(GatewayUsageSample.task_id) == filters.task_id)
        if filters.since is not None:
            statement = statement.where(col(GatewayUsageSample.recorded_at) >= filters.since)
        if filters.until is not None:
            statement = statement.where(col(GatewayUsageSample.recorded_at) <= filters.until)

        rows = list(
            await self.session.exec(statement.order_by(col(GatewayUsageSample.recorded_at)))
        )
        total_cost = 0.0
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0
        model_costs: dict[str, float] = defaultdict(float)
        bucket_totals: dict[datetime, dict[str, float | int]] = defaultdict(
            lambda: {"total_cost_usd": 0.0, "total_tokens": 0},
        )

        for row in rows:
            total_cost += float(row.cost_usd or 0.0)
            prompt_tokens += int(row.prompt_tokens or 0)
            completion_tokens += int(row.completion_tokens or 0)
            total_tokens += int(row.total_tokens or 0)
            if row.model:
                model_costs[row.model] += float(row.cost_usd or 0.0)
            bucket_key = _normalize_bucket(row.recorded_at.astimezone(UTC).replace(tzinfo=None))
            bucket_totals[bucket_key]["total_cost_usd"] += float(row.cost_usd or 0.0)
            bucket_totals[bucket_key]["total_tokens"] += int(row.total_tokens or 0)

        buckets = [
            UsageAggregateBucket(
                period=period,
                total_cost_usd=float(values["total_cost_usd"]),
                total_tokens=int(values["total_tokens"]),
            )
            for period, values in sorted(bucket_totals.items())
        ]
        return UsageAggregateResponse(
            total_cost_usd=round(total_cost, 8),
            total_prompt_tokens=prompt_tokens,
            total_completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            models={key: round(value, 8) for key, value in sorted(model_costs.items())},
            buckets=buckets,
        )
