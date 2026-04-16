"""Product planning, budget heuristics, and service seeding helpers."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Iterable
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.time import utcnow
from app.db import crud
from app.models.agents import Agent
from app.models.board_groups import BoardGroup
from app.models.boards import Board
from app.models.gateways import Gateway
from app.models.product_messages import ProductMessage
from app.models.product_plans import ProductPlan
from app.models.products import Product
from app.models.tasks import Task
from app.schemas.products import (
    ProductBudgetPolicy,
    ProductEpicProposal,
    ProductExecutionPolicy,
    ProductMessageRead,
    ProductModelRecommendation,
    ProductPlannerMode,
    ProductPlannerPolicy,
    ProductPlanRead,
    ProductRead,
    ProductServiceProposal,
    ProductSummaryRead,
)
from app.services.openclaw.gateway_dispatch import GatewayDispatchService
from app.services.openclaw.gateway_resolver import gateway_client_config
from app.services.openclaw.gateway_rpc import (
    OpenClawGatewayError,
    create_session,
    ensure_session,
    get_chat_history,
    send_message,
    wait_for_agent_run,
)
from app.services.openclaw.provisioning_db import (
    LeadAgentOptions,
    LeadAgentRequest,
    OpenClawProvisioningService,
)
from app.services.openclaw.runtime_control import GatewayRuntimeControlService

DEFAULT_BUDGET_TOKEN_ESTIMATES = {
    "intake": (45_000, 15_000),
    "implementation": (320_000, 110_000),
    "review": (90_000, 25_000),
    "security": (100_000, 30_000),
}
MODEL_COST_FALLBACKS: dict[str, tuple[float, float]] = {
    "microsoft-foundry/gpt-5.4-mini": (0.15, 0.60),
    "github-copilot/gpt-5.4": (1.25, 5.00),
    "openai-codex/gpt-5.4": (1.25, 5.00),
    "claude-cli/claude-opus-4-6": (15.0, 75.0),
    "claude-cli/claude-sonnet-4-6": (3.0, 15.0),
    "google-gemini-cli/gemini-3.1-pro-preview": (2.5, 10.0),
}
WORKFLOW_BOARD_TEMPLATES = (
    {
        "name": "Requirements",
        "slug": "requirements",
        "description": "Backlog intake and product requirement shaping.",
        "require_approval_for_done": False,
        "require_review_before_done": False,
        "comment_required_for_review": False,
        "only_lead_can_change_status": True,
    },
    {
        "name": "Ready",
        "slug": "ready",
        "description": "Planning-ready slices with clear scope and dependencies.",
        "require_approval_for_done": False,
        "require_review_before_done": False,
        "comment_required_for_review": False,
        "only_lead_can_change_status": True,
    },
    {
        "name": "In Progress",
        "slug": "in-progress",
        "description": "Implementation work currently assigned to builders.",
        "require_approval_for_done": False,
        "require_review_before_done": False,
        "comment_required_for_review": False,
        "only_lead_can_change_status": False,
    },
    {
        "name": "Review",
        "slug": "review",
        "description": "Code and delivery review for the current slice.",
        "require_approval_for_done": False,
        "require_review_before_done": False,
        "comment_required_for_review": True,
        "only_lead_can_change_status": True,
    },
    {
        "name": "Security Review",
        "slug": "security-review",
        "description": "Security checks and sign-off before QA.",
        "require_approval_for_done": False,
        "require_review_before_done": False,
        "comment_required_for_review": True,
        "only_lead_can_change_status": True,
    },
    {
        "name": "QA",
        "slug": "qa",
        "description": "Final validation before completion.",
        "require_approval_for_done": False,
        "require_review_before_done": False,
        "comment_required_for_review": True,
        "only_lead_can_change_status": True,
    },
    {
        "name": "Done",
        "slug": "done",
        "description": "Completed and validated work.",
        "require_approval_for_done": False,
        "require_review_before_done": False,
        "comment_required_for_review": False,
        "only_lead_can_change_status": True,
    },
)

PLANNER_BASE_MODEL = "microsoft-foundry/gpt-5.4-mini"
PLANNER_ESCALATION_MODEL = "openai-codex/gpt-5.4"
PLANNER_SECURITY_MODEL = "claude-cli/claude-opus-4-6"
PLANNER_MESSAGE_LIMIT = 12
PLANNER_CHAT_HISTORY_LIMIT = 20
PLANNER_SYNC_MESSAGE_LIMIT = 20

PLANNER_MODE_LABELS: dict[str, str] = {
    "auto": "Auto",
    "fast-thinking": "Fast",
    "deep-thinking": "Thinking",
    "security-planning": "Security",
    "custom": "Custom",
}
PLANNER_MODEL_LABELS: dict[str, str] = {
    "microsoft-foundry/gpt-5.4-mini": "GPT-5.4 Mini",
    "openai-codex/gpt-5.4": "GPT-5.4 Thinking",
    "claude-cli/claude-opus-4-6": "Claude Opus 4.6",
}


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "product"


def _json_dict(value: object | None) -> dict[str, object]:
    return dict(value) if isinstance(value, dict) else {}


def _json_list(value: object | None) -> list[object]:
    return list(value) if isinstance(value, list) else []


def _planner_mode_label(mode: str | None) -> str:
    return PLANNER_MODE_LABELS.get(str(mode or "auto"), "Auto")


def _planner_model_label(model_ref: str | None) -> str | None:
    if not model_ref:
        return None
    return PLANNER_MODEL_LABELS.get(model_ref, model_ref)


def _planner_sync_session_seed(product: Product) -> str:
    return f"product:{product.id}:planner-sync"


def product_budget_policy(product: Product) -> ProductBudgetPolicy:
    data = _json_dict(
        {
            "daily_budget_cap_usd": product.daily_budget_cap_usd,
            "total_budget_cap_usd": product.total_budget_cap_usd,
            "optimize_for": product.optimize_for,
        }
    )
    return ProductBudgetPolicy.model_validate(data)


def product_execution_policy(product: Product) -> ProductExecutionPolicy:
    return ProductExecutionPolicy.model_validate(product.execution_policy or {})


def product_planner_policy(product: Product) -> ProductPlannerPolicy:
    return ProductPlannerPolicy.model_validate(
        {
            "mode": product.planner_mode,
            "model_override": product.planner_model_override,
        }
    )


def product_to_read(product: Product) -> ProductRead:
    return ProductRead(
        id=product.id,
        organization_id=product.organization_id,
        name=product.name,
        slug=product.slug,
        description=product.description,
        local_working_directory=product.local_working_directory,
        remote_repository_url=product.remote_repository_url,
        status=product.status,
        default_gateway_id=product.default_gateway_id,
        execution_policy=product_execution_policy(product),
        budget_policy=product_budget_policy(product),
        planner_policy=product_planner_policy(product),
        created_at=product.created_at,
        updated_at=product.updated_at,
    )


def message_to_read(message: ProductMessage) -> ProductMessageRead:
    return ProductMessageRead(
        id=message.id,
        product_id=message.product_id,
        role=message.role,
        content=message.content,
        meta=message.meta,
        created_at=message.created_at,
    )


def plan_to_read(plan: ProductPlan) -> ProductPlanRead:
    return ProductPlanRead(
        id=plan.id,
        product_id=plan.product_id,
        status=plan.status,
        planner_agent_id=plan.planner_agent_id,
        planner_session_key=plan.planner_session_key,
        planner_model_ref=plan.planner_model_ref,
        planner_status=plan.planner_status,
        planner_status_reason=plan.planner_status_reason,
        planner_last_escalation_reason=plan.planner_last_escalation_reason,
        plan_sync_status=plan.plan_sync_status,
        plan_sync_error=plan.plan_sync_error,
        intake_summary=plan.intake_summary,
        objective=plan.objective,
        target_audience=plan.target_audience,
        scope=plan.scope,
        exclusions=plan.exclusions,
        missing_questions=[
            str(item) for item in _json_list(plan.missing_questions) if isinstance(item, str)
        ],
        unresolved_question_keys=[
            str(item) for item in _json_list(plan.unresolved_question_keys) if isinstance(item, str)
        ],
        completeness=_json_dict(plan.completeness),
        proposed_services=[
            ProductServiceProposal.model_validate(item)
            for item in _json_list(plan.proposed_services)
            if isinstance(item, dict)
        ],
        initial_epics=[
            ProductEpicProposal.model_validate(item)
            for item in _json_list(plan.initial_epics)
            if isinstance(item, dict)
        ],
        role_assignments=_json_dict(plan.role_assignments),
        model_recommendations=[
            ProductModelRecommendation.model_validate(item)
            for item in _json_list(plan.model_recommendations)
            if isinstance(item, dict)
        ],
        estimated_daily_budget_usd=plan.estimated_daily_budget_usd,
        estimated_total_budget_usd=plan.estimated_total_budget_usd,
        budget_posture=plan.budget_posture,
        budget_warnings=[
            str(item) for item in _json_list(plan.budget_warnings) if isinstance(item, str)
        ],
        last_message_at=plan.last_message_at,
        approved_at=plan.approved_at,
        created_at=plan.created_at,
        updated_at=plan.updated_at,
    )


def _extract_phrase(patterns: Iterable[str], text: str) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if not match:
            continue
        value = " ".join(part.strip() for part in match.groups() if part and part.strip())
        if value:
            return value.rstrip(". ")
    return None


def _strip_markers(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _planner_session_seed(product: Product) -> str:
    return f"product:{product.id}:planner"


def _normalize_float(value: object) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _normalize_string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    normalized: list[str] = []
    for item in value:
        if isinstance(item, str):
            stripped = item.strip()
            if stripped:
                normalized.append(stripped)
    return normalized


def _normalize_missing_question_entries(value: object) -> tuple[list[str], list[str]]:
    if not isinstance(value, list):
        return [], []
    questions: list[str] = []
    keys: list[str] = []
    for item in value:
        if isinstance(item, str):
            stripped = item.strip()
            if stripped:
                questions.append(stripped)
            continue
        if not isinstance(item, dict):
            continue
        question = str(item.get("question") or "").strip()
        key = str(item.get("key") or "").strip()
        if question:
            questions.append(question)
        if key:
            keys.append(key)
    return questions, keys


def _extract_text_blocks(content: object) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
    return "\n".join(parts).strip()


def _extract_json_object(raw: str) -> dict[str, object]:
    text = raw.strip()
    if not text:
        raise ValueError("Planner returned an empty response.")
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL)
    candidate = fenced.group(1).strip() if fenced else text
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start < 0 or end <= start:
            raise
        parsed = json.loads(candidate[start : end + 1])
    if not isinstance(parsed, dict):
        msg = "Planner response must decode to a JSON object."
        raise ValueError(msg)
    return parsed


class ProductPlanningService:
    """Encapsulate product chat planning and approval flows."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_messages(self, *, product_id: UUID) -> list[ProductMessage]:
        statement = (
            select(ProductMessage)
            .where(col(ProductMessage.product_id) == product_id)
            .order_by(col(ProductMessage.created_at).asc())
        )
        return list(await self.session.exec(statement))

    async def list_services(self, *, product_id: UUID) -> list[BoardGroup]:
        statement = (
            select(BoardGroup)
            .where(col(BoardGroup.product_id) == product_id)
            .order_by(col(BoardGroup.updated_at).desc(), col(BoardGroup.created_at).desc())
        )
        return list(await self.session.exec(statement))

    async def current_plan(self, *, product_id: UUID) -> ProductPlan | None:
        return await ProductPlan.objects.filter_by(product_id=product_id).first(self.session)

    async def resolve_gateway(self, *, product: Product) -> Gateway:
        gateway_id = product.default_gateway_id
        if gateway_id is not None:
            gateway = await Gateway.objects.by_id(gateway_id).first(self.session)
            if gateway is not None and gateway.organization_id == product.organization_id:
                return gateway
        gateway = (
            await Gateway.objects.filter_by(organization_id=product.organization_id)
            .order_by(col(Gateway.created_at).asc())
            .first(self.session)
        )
        if gateway is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Create a gateway before approving product execution.",
            )
        if product.default_gateway_id != gateway.id:
            product.default_gateway_id = gateway.id
            product.updated_at = utcnow()
            await crud.save(self.session, product)
        return gateway

    async def product_summary(self, *, product: Product) -> ProductSummaryRead:
        services_count = (
            await self.session.exec(
                select(func.count())
                .select_from(BoardGroup)
                .where(col(BoardGroup.product_id) == product.id)
            )
        ).one()
        active_services_count = (
            await self.session.exec(
                select(func.count(func.distinct(BoardGroup.id)))
                .select_from(BoardGroup)
                .join(Board, col(Board.board_group_id) == col(BoardGroup.id))
                .join(Task, col(Task.board_id) == col(Board.id))
                .where(
                    col(BoardGroup.product_id) == product.id,
                    col(Task.status) != "done",
                )
            )
        ).one()
        plan = await self.current_plan(product_id=product.id)
        latest_message = (
            await self.session.exec(
                select(func.max(ProductMessage.created_at)).where(
                    col(ProductMessage.product_id) == product.id,
                )
            )
        ).one()
        return ProductSummaryRead(
            **product_to_read(product).model_dump(),
            services_count=int(services_count or 0),
            active_services_count=int(active_services_count or 0),
            latest_activity_at=latest_message or (plan.last_message_at if plan else None),
            latest_plan_status=(plan.status if plan else None),
            estimated_total_budget_usd=(plan.estimated_total_budget_usd if plan else None),
        )

    async def record_chat_turn(
        self,
        *,
        product: Product,
        content: str,
        planner_mode_override: ProductPlannerMode | None = None,
        planner_model_override: str | None = None,
    ) -> tuple[ProductMessage, ProductPlan]:
        normalized_content = content.strip()
        existing = await self.current_plan(product_id=product.id)
        gateway = await self.resolve_gateway(product=product)
        runtime_models, model_costs = await self._runtime_models_for_product(product=product)
        planner_agent = await self._ensure_planner_agent(product=product, gateway=gateway)
        effective_mode, effective_model_override, override_applied = self._resolve_planner_preferences(
            product=product,
            planner_mode_override=planner_mode_override,
            planner_model_override=planner_model_override,
        )
        planner_model_ref, planner_reason = self._choose_planner_runtime(
            product=product,
            content=normalized_content,
            existing=existing,
            runtime_models=runtime_models,
            planner_mode=effective_mode,
            planner_model_override=effective_model_override,
        )
        try:
            assistant_reply, session_key, active_model_ref = await self._run_assistant_turn(
                product=product,
                gateway=gateway,
                existing=existing,
                content=normalized_content,
                runtime_models=runtime_models,
                model_costs=model_costs,
                planner_model_ref=planner_model_ref,
            )
        except (OpenClawGatewayError, ValueError, KeyError, TypeError, HTTPException) as exc:
            if existing is not None:
                existing.planner_status = "unavailable"
                existing.planner_status_reason = str(exc)
                existing.updated_at = utcnow()
                await crud.save(self.session, existing)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Planner runtime unavailable: {exc}",
            ) from exc

        user_message = await crud.create(
            self.session,
            ProductMessage,
            product_id=product.id,
            role="user",
            content=normalized_content,
            meta={
                "planner_mode": effective_mode,
                "planner_mode_label": _planner_mode_label(effective_mode),
                "planner_model_override": effective_model_override,
                "planner_override_applied": override_applied,
            },
        )
        assistant_message = await crud.create(
            self.session,
            ProductMessage,
            product_id=product.id,
            role="assistant",
            content=assistant_reply,
            meta={
                "planner_model_ref": active_model_ref,
                "planner_model_label": _planner_model_label(active_model_ref),
                "planner_mode": effective_mode,
                "planner_mode_label": _planner_mode_label(effective_mode),
                "planner_override_applied": override_applied,
            },
        )
        try:
            planner_payload = await self._run_plan_synthesis_turn(
                product=product,
                gateway=gateway,
                existing=existing,
                runtime_models=runtime_models,
                model_costs=model_costs,
                planner_model_ref=active_model_ref or planner_model_ref,
            )
            plan = await self._upsert_plan_from_planner(
                product=product,
                existing=existing,
                planner_agent=planner_agent,
                planner_payload=planner_payload,
                planner_model_ref=active_model_ref or planner_model_ref,
                planner_reason=planner_reason,
                planner_session_key=session_key,
                runtime_models=runtime_models,
                model_costs=model_costs,
            )
        except (OpenClawGatewayError, ValueError, KeyError, TypeError, HTTPException) as exc:
            plan = await self._mark_plan_sync_failure(
                product=product,
                existing=existing,
                planner_agent=planner_agent,
                planner_model_ref=active_model_ref or planner_model_ref,
                planner_reason=planner_reason,
                planner_session_key=session_key,
                assistant_message_at=assistant_message.created_at,
                error=str(exc),
            )
        assistant_meta = dict(assistant_message.meta or {})
        assistant_meta.update(
            {
                "planner_status": plan.planner_status,
                "planner_status_reason": plan.planner_status_reason,
                "missing_questions": plan.missing_questions or [],
                "plan_sync_status": plan.plan_sync_status,
                "plan_sync_error": plan.plan_sync_error,
            }
        )
        assistant_message.meta = assistant_meta
        assistant_message = await crud.save(self.session, assistant_message)
        plan.last_message_at = assistant_message.created_at
        plan.updated_at = utcnow()
        plan = await crud.save(self.session, plan)
        return assistant_message, plan

    def _resolve_planner_preferences(
        self,
        *,
        product: Product,
        planner_mode_override: ProductPlannerMode | None,
        planner_model_override: str | None,
    ) -> tuple[str, str | None, bool]:
        if planner_mode_override is not None:
            mode = planner_mode_override
            model_override = planner_model_override if planner_mode_override == "custom" else None
            return mode, model_override, True
        return product.planner_mode, product.planner_model_override, False

    async def _mark_plan_sync_failure(
        self,
        *,
        product: Product,
        existing: ProductPlan | None,
        planner_agent: Agent,
        planner_model_ref: str,
        planner_reason: str,
        planner_session_key: str,
        assistant_message_at,
        error: str,
    ) -> ProductPlan:
        now = utcnow()
        payload = {
            "planner_agent_id": planner_agent.id,
            "planner_session_key": planner_session_key,
            "planner_model_ref": planner_model_ref,
            "planner_status": existing.planner_status if existing and existing.planner_status else "awaiting-input",
            "planner_status_reason": existing.planner_status_reason
            if existing and existing.planner_status_reason
            else "Planner reply is available, but the structured plan needs another sync pass.",
            "planner_last_escalation_reason": planner_reason,
            "plan_sync_status": "stale",
            "plan_sync_error": error,
            "last_message_at": assistant_message_at,
        }
        if existing is None:
            return await crud.create(
                self.session,
                ProductPlan,
                product_id=product.id,
                status="draft",
                created_at=now,
                updated_at=now,
                **payload,
            )
        for key, value in payload.items():
            setattr(existing, key, value)
        existing.updated_at = now
        return await crud.save(self.session, existing)

    async def _ensure_planner_agent(
        self,
        *,
        product: Product,
        gateway: Gateway,
    ) -> Agent:
        existing = (
            await Agent.objects.filter_by(
                product_id=product.id,
                gateway_id=gateway.id,
                purpose="product-planner",
            )
            .order_by(col(Agent.created_at).asc())
            .first(self.session)
        )
        if existing is not None:
            if not existing.hidden:
                existing.hidden = True
                existing.updated_at = utcnow()
                existing = await crud.save(self.session, existing)
            return existing
        return await crud.create(
            self.session,
            Agent,
            board_id=None,
            product_id=product.id,
            gateway_id=gateway.id,
            name=f"{product.name} Planner",
            purpose="product-planner",
            hidden=True,
            status="standby",
            heartbeat_config={"every": "0m", "target": "none"},
            identity_profile={
                "role": "Product Planner",
                "communication_style": "conversational, strategic, decisive",
            },
            model_profile="budget",
            model_fallback_policy="profile",
        )

    def _choose_planner_runtime(
        self,
        *,
        product: Product,
        content: str,
        existing: ProductPlan | None,
        runtime_models: list[str],
        planner_mode: str,
        planner_model_override: str | None,
    ) -> tuple[str, str]:
        if planner_model_override and planner_model_override in runtime_models:
            return (
                planner_model_override,
                "Planner is pinned to the explicit product-level model override.",
            )
        if planner_mode == "custom" and planner_model_override:
            if runtime_models:
                return (
                    runtime_models[0],
                    "Custom planner model override is unavailable, so Mission Control used the first verified runtime model.",
                )
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="The selected planner model override is not available on the product gateway.",
            )
        if planner_mode == "fast-thinking" and PLANNER_BASE_MODEL in runtime_models:
            return (
                PLANNER_BASE_MODEL,
                "Planner is using the fast-thinking product chat mode.",
            )
        if planner_mode == "deep-thinking" and PLANNER_ESCALATION_MODEL in runtime_models:
            return (
                PLANNER_ESCALATION_MODEL,
                "Planner is using the deep-thinking product chat mode.",
            )
        if planner_mode == "security-planning" and PLANNER_SECURITY_MODEL in runtime_models:
            return (
                PLANNER_SECURITY_MODEL,
                "Planner is using the security-planning mode for risk-sensitive product reasoning.",
            )
        lowered = _strip_markers(
            " ".join(
                value
                for value in [
                    product.description or "",
                    existing.objective if existing else "",
                    existing.scope if existing else "",
                    content,
                ]
                if value
            )
        ).lower()
        security_markers = ("security", "privacy", "compliance", "soc 2", "gdpr", "hipaa")
        complexity_markers = (
            "platform",
            "multi-service",
            "microservice",
            "architecture",
            "billing",
            "multi-tenant",
            "integration",
            "orchestration",
            "workflow",
            "marketplace",
        )
        if any(marker in lowered for marker in security_markers) and PLANNER_SECURITY_MODEL in runtime_models:
            return PLANNER_SECURITY_MODEL, "Escalated to security planner because the intake is security or compliance heavy."
        if (
            PLANNER_ESCALATION_MODEL in runtime_models
            and (
                len(content) > 900
                or sum(marker in lowered for marker in complexity_markers) >= 3
                or "architecture" in lowered
            )
        ):
            return PLANNER_ESCALATION_MODEL, "Escalated to the stronger architecture planner for multi-slice product reasoning."
        if PLANNER_BASE_MODEL in runtime_models:
            return PLANNER_BASE_MODEL, "Using the budget-aware planner model for normal intake and clarification."
        if runtime_models:
            return runtime_models[0], "Using the first verified runtime model because the preferred planner model is unavailable."
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="No verified runtime models are available for product planning.",
        )

    async def _run_assistant_turn(
        self,
        *,
        product: Product,
        gateway: Gateway,
        existing: ProductPlan | None,
        content: str,
        runtime_models: list[str],
        model_costs: dict[str, tuple[float, float]],
        planner_model_ref: str,
    ) -> tuple[str, str, str]:
        session_key = (
            existing.planner_session_key
            if existing and existing.planner_session_key
            else _planner_session_seed(product)
        )
        config = gateway_client_config(gateway)
        prompt = await self._assistant_prompt(
            product=product,
            existing=existing,
            latest_user_message=content,
            runtime_models=runtime_models,
            model_costs=model_costs,
        )
        label = f"{product.name} Planner"
        baseline_assistant_key = None
        if existing and existing.planner_session_key:
            history = _json_dict(
                await get_chat_history(
                    session_key,
                    config=config,
                    limit=PLANNER_MESSAGE_LIMIT,
                )
            )
            baseline_assistant_key = self._latest_assistant_key(_json_list(history.get("messages")))
            payload = _json_dict(
                await ensure_session(
                    session_key,
                    config=config,
                    label=label,
                    model=planner_model_ref,
                )
            )
            payload = _json_dict(
                await send_message(
                    prompt,
                    session_key=str(payload.get("key") or session_key),
                    config=config,
                )
            )
        else:
            payload = _json_dict(
                await create_session(
                    session_key,
                    config=config,
                    label=label,
                    model=planner_model_ref,
                    message=prompt,
                )
            )
        resolved_session_key = str(payload.get("key") or session_key)
        assistant_text, active_model_ref = await self._wait_for_new_assistant_reply(
            session_key=resolved_session_key,
            config=config,
            baseline_assistant_key=baseline_assistant_key,
            timeout_attempts=45,
        )
        return assistant_text, resolved_session_key, active_model_ref or planner_model_ref

    async def _run_plan_synthesis_turn(
        self,
        *,
        product: Product,
        gateway: Gateway,
        existing: ProductPlan | None,
        runtime_models: list[str],
        model_costs: dict[str, tuple[float, float]],
        planner_model_ref: str,
    ) -> dict[str, object]:
        session_key = f"{_planner_sync_session_seed(product)}:{uuid4()}"
        config = gateway_client_config(gateway)
        prompt = await self._plan_synthesis_prompt(
            product=product,
            existing=existing,
            runtime_models=runtime_models,
            model_costs=model_costs,
        )
        payload = _json_dict(
            await create_session(
                session_key,
                config=config,
                label=f"{product.name} Planner Sync",
                model=planner_model_ref,
                message=prompt,
            )
        )
        resolved_session_key = str(payload.get("key") or session_key)
        assistant_text, _active_model_ref = await self._wait_for_new_assistant_reply(
            session_key=resolved_session_key,
            config=config,
            baseline_assistant_key=None,
            timeout_attempts=45,
        )
        return _extract_json_object(assistant_text)

    async def _wait_for_new_assistant_reply(
        self,
        *,
        session_key: str,
        config,
        baseline_assistant_key: str | None,
        timeout_attempts: int,
    ) -> tuple[str, str]:
        for _ in range(timeout_attempts):
            history = _json_dict(
                await get_chat_history(
                    session_key,
                    config=config,
                    limit=PLANNER_MESSAGE_LIMIT,
                )
            )
            messages = _json_list(history.get("messages"))
            assistant_messages = [
                item
                for item in messages
                if isinstance(item, dict) and str(item.get("role") or "") == "assistant"
            ]
            if assistant_messages:
                latest = assistant_messages[-1]
                latest_key = self._assistant_message_key(latest)
                if baseline_assistant_key is None or latest_key != baseline_assistant_key:
                    assistant_text = _extract_text_blocks(latest.get("content"))
                    if assistant_text:
                        provider = latest.get("provider")
                        model = latest.get("model")
                        provider_text = provider.strip() if isinstance(provider, str) else ""
                        model_text = model.strip() if isinstance(model, str) else ""
                        active_model_ref = "/".join(part for part in [provider_text, model_text] if part)
                        return assistant_text, active_model_ref
            await asyncio.sleep(2)
        msg = "Planner did not finish with a usable assistant reply before the timeout."
        raise ValueError(msg)

    def _latest_assistant_key(self, messages: list[object]) -> str | None:
        assistant_messages = [
            item
            for item in messages
            if isinstance(item, dict) and str(item.get("role") or "") == "assistant"
        ]
        if not assistant_messages:
            return None
        return self._assistant_message_key(assistant_messages[-1])

    def _assistant_message_key(self, message: dict[str, object]) -> str:
        for field in ("id", "createdAt", "created_at", "timestamp"):
            value = message.get(field)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return json.dumps(message, sort_keys=True, default=str)

    async def _assistant_prompt(
        self,
        *,
        product: Product,
        existing: ProductPlan | None,
        latest_user_message: str,
        runtime_models: list[str],
        model_costs: dict[str, tuple[float, float]],
    ) -> str:
        recent_messages = [
            {"role": message.role, "content": message.content}
            for message in (await self.list_messages(product_id=product.id))[-6:]
        ]
        budget_policy = product_budget_policy(product)
        current_state = {
            "objective": existing.objective if existing else None,
            "target_audience": existing.target_audience if existing else None,
            "scope": existing.scope if existing else None,
            "exclusions": existing.exclusions if existing else None,
            "missing_questions": _json_list(existing.missing_questions) if existing else [],
            "unresolved_question_keys": _json_list(existing.unresolved_question_keys) if existing else [],
            "proposed_services": _json_list(existing.proposed_services) if existing else [],
            "initial_epics": _json_list(existing.initial_epics) if existing else [],
            "budget_posture": existing.budget_posture if existing else None,
        }
        runtime_catalog = [
            {
                "model_ref": model_ref,
                "input_per_million": model_costs.get(model_ref, (0.0, 0.0))[0],
                "output_per_million": model_costs.get(model_ref, (0.0, 0.0))[1],
            }
            for model_ref in runtime_models
        ]
        return (
            "You are Mission Control's product planner. Think carefully, but do not reveal chain-of-thought. "
            "Execution must stay paused until approval.\n\n"
            "Conversation rules:\n"
            "- Reply as a normal assistant, not as a form or a checklist.\n"
            "- Ask at most 2 unresolved questions per turn.\n"
            "- Do not repeat the full checklist or the full plan unless it materially changed.\n"
            "- If the operator answers in a numbered list, map the answers onto the unresolved questions in order before asking anything else.\n"
            "- Acknowledge what you now understand, then ask only for what is still missing.\n"
            "- Keep replies concise, human, and useful.\n"
            "- Do not emit JSON.\n\n"
            f"Product: {json.dumps({'name': product.name, 'slug': product.slug, 'description': product.description, 'status': product.status, 'local_working_directory': product.local_working_directory, 'remote_repository_url': product.remote_repository_url})}\n"
            f"Budget policy: {json.dumps(budget_policy.model_dump())}\n"
            f"Current structured plan: {json.dumps(current_state)}\n"
            f"Recent visible chat: {json.dumps(recent_messages)}\n"
            f"Verified runtime catalog: {json.dumps(runtime_catalog)}\n"
            f"Latest operator message: {json.dumps(latest_user_message.strip())}\n"
        )

    async def _plan_synthesis_prompt(
        self,
        *,
        product: Product,
        existing: ProductPlan | None,
        runtime_models: list[str],
        model_costs: dict[str, tuple[float, float]],
    ) -> str:
        budget_policy = product_budget_policy(product)
        transcript = [
            {"role": message.role, "content": message.content}
            for message in (await self.list_messages(product_id=product.id))[-PLANNER_SYNC_MESSAGE_LIMIT:]
        ]
        current_state = {
            "objective": existing.objective if existing else None,
            "target_audience": existing.target_audience if existing else None,
            "scope": existing.scope if existing else None,
            "exclusions": existing.exclusions if existing else None,
            "missing_questions": _json_list(existing.missing_questions) if existing else [],
            "unresolved_question_keys": _json_list(existing.unresolved_question_keys) if existing else [],
            "proposed_services": _json_list(existing.proposed_services) if existing else [],
            "initial_epics": _json_list(existing.initial_epics) if existing else [],
            "budget_posture": existing.budget_posture if existing else None,
        }
        runtime_catalog = [
            {
                "model_ref": model_ref,
                "input_per_million": model_costs.get(model_ref, (0.0, 0.0))[0],
                "output_per_million": model_costs.get(model_ref, (0.0, 0.0))[1],
            }
            for model_ref in runtime_models
        ]
        contract = {
            "objective": "string|null",
            "target_audience": "string|null",
            "scope": "string|null",
            "exclusions": "string|null",
            "proposed_services": [
                {
                    "name": "string",
                    "slug": "string",
                    "description": "string|null",
                    "objective": "string|null",
                    "epics": ["string"],
                }
            ],
            "initial_epics": [
                {
                    "title": "string",
                    "description": "string|null",
                    "priority": "low|medium|high",
                    "service_slug": "string|null",
                }
            ],
            "role_assignments": {"Lead": "string", "Builder": "string", "Reviewer": "string", "Security": "string"},
            "model_recommendations": [
                {
                    "slice": "intake-orchestration|implementation|review|security-review",
                    "model_ref": "verified runtime model only",
                    "rationale": "string",
                    "estimated_cost_usd": "number|null",
                }
            ],
            "estimated_daily_budget_usd": "number|null",
            "estimated_total_budget_usd": "number|null",
            "budget_posture": "within-budget|over-daily-budget|over-total-budget|no-budget-cap",
            "budget_warnings": ["string"],
            "missing_questions": [{"key": "string", "question": "string"}],
            "ready_for_approval": "boolean",
        }
        return (
            "You are Mission Control's hidden plan synthesizer. Think carefully, but do not reveal chain-of-thought. "
            "Summarize the product conversation into structured plan state. Return JSON only.\n\n"
            "- Use the full conversation transcript, not just the last message.\n"
            "- Preserve existing valid plan details unless the transcript materially changes them.\n"
            "- Keep execution paused until approval.\n"
            "- Use only verified runtime models from the provided runtime catalog.\n\n"
            f"Product: {json.dumps({'name': product.name, 'slug': product.slug, 'description': product.description, 'status': product.status, 'local_working_directory': product.local_working_directory, 'remote_repository_url': product.remote_repository_url})}\n"
            f"Budget policy: {json.dumps(budget_policy.model_dump())}\n"
            f"Current structured plan: {json.dumps(current_state)}\n"
            f"Visible chat transcript: {json.dumps(transcript)}\n"
            f"Verified runtime catalog: {json.dumps(runtime_catalog)}\n\n"
            f"Return exactly this JSON shape: {json.dumps(contract)}"
        )

    async def _upsert_plan_from_planner(
        self,
        *,
        product: Product,
        existing: ProductPlan | None,
        planner_agent: Agent,
        planner_payload: dict[str, object],
        planner_model_ref: str,
        planner_reason: str,
        planner_session_key: str,
        runtime_models: list[str],
        model_costs: dict[str, tuple[float, float]],
    ) -> ProductPlan:
        budget_policy = product_budget_policy(product)
        objective = _strip_markers(
            str(planner_payload.get("objective") or (existing.objective if existing else "") or product.description or product.name)
        )
        target_audience = _strip_markers(
            str(planner_payload.get("target_audience") or (existing.target_audience if existing else "") or "")
        ) or None
        scope = _strip_markers(
            str(planner_payload.get("scope") or (existing.scope if existing else "") or "")
        ) or None
        exclusions = _strip_markers(
            str(planner_payload.get("exclusions") or (existing.exclusions if existing else "") or "")
        ) or None

        missing_questions, unresolved_keys = _normalize_missing_question_entries(planner_payload.get("missing_questions"))
        if not missing_questions:
            if not target_audience:
                missing_questions.append("Who is the primary user or buyer for this product?")
                unresolved_keys.append("target_audience")
            if not scope:
                missing_questions.append("What is the smallest useful v1 outcome Mission Control should deliver first?")
                unresolved_keys.append("scope")
            if not exclusions:
                missing_questions.append("What is explicitly out of scope for the first release?")
                unresolved_keys.append("exclusions")

        proposed_services = self._normalize_service_proposals(
            product=product,
            objective=objective,
            scope=scope,
            raw=planner_payload.get("proposed_services"),
        )
        initial_epics = self._normalize_epic_proposals(
            product=product,
            services=proposed_services,
            raw=planner_payload.get("initial_epics"),
        )
        role_assignments = self._normalize_role_assignments(planner_payload.get("role_assignments"))
        model_recommendations = self._normalize_model_recommendations(
            raw=planner_payload.get("model_recommendations"),
            runtime_models=runtime_models,
            fallback_optimize_for=budget_policy.optimize_for,
            model_costs=model_costs,
        )
        estimated_daily_budget_usd = _normalize_float(planner_payload.get("estimated_daily_budget_usd"))
        estimated_total_budget_usd = _normalize_float(planner_payload.get("estimated_total_budget_usd"))
        if estimated_daily_budget_usd is None or estimated_total_budget_usd is None:
            estimated_daily_budget_usd, estimated_total_budget_usd = self._estimate_budget(
                service_count=len(proposed_services),
                epic_count=len(initial_epics),
                recommendations=model_recommendations,
                model_costs=model_costs,
            )

        budget_posture = str(planner_payload.get("budget_posture") or "").strip() or "within-budget"
        budget_warnings = _normalize_string_list(planner_payload.get("budget_warnings"))
        if budget_policy.daily_budget_cap_usd is None and budget_policy.total_budget_cap_usd is None:
            budget_posture = "no-budget-cap"
        if (
            budget_policy.daily_budget_cap_usd is not None
            and estimated_daily_budget_usd > budget_policy.daily_budget_cap_usd
            and "Projected daily burn exceeds the configured daily budget cap." not in budget_warnings
        ):
            budget_posture = "over-daily-budget"
            budget_warnings.append("Projected daily burn exceeds the configured daily budget cap.")
        if (
            budget_policy.total_budget_cap_usd is not None
            and estimated_total_budget_usd > budget_policy.total_budget_cap_usd
            and "Projected total spend exceeds the configured initiative budget cap." not in budget_warnings
        ):
            budget_posture = "over-total-budget"
            budget_warnings.append("Projected total spend exceeds the configured initiative budget cap.")

        ready_for_approval = bool(planner_payload.get("ready_for_approval")) and not missing_questions
        planner_status = "ready-for-approval" if ready_for_approval else "awaiting-input"
        planner_status_reason = (
            "Draft is complete and waiting for operator approval."
            if ready_for_approval
            else f"Waiting for {len(missing_questions)} more clarified answer(s)."
        )
        intake_summary = (
            f"{product.name}: {objective}"
            if objective
            else f"{product.name}: product intake pending more detail."
        )
        completeness = {
            "objective": bool(objective),
            "target_audience": bool(target_audience),
            "scope": bool(scope),
            "exclusions": bool(exclusions),
            "services_count": len(proposed_services),
            "epics_count": len(initial_epics),
            "ready_for_approval": ready_for_approval,
        }
        plan_payload = {
            "status": existing.status if existing and existing.status == "approved" else "draft",
            "planner_agent_id": planner_agent.id,
            "planner_session_key": planner_session_key,
            "planner_model_ref": planner_model_ref,
            "planner_status": planner_status,
            "planner_status_reason": planner_status_reason,
            "planner_last_escalation_reason": planner_reason,
            "plan_sync_status": "synced",
            "plan_sync_error": None,
            "intake_summary": intake_summary,
            "objective": objective,
            "target_audience": target_audience,
            "scope": scope,
            "exclusions": exclusions,
            "missing_questions": missing_questions,
            "unresolved_question_keys": unresolved_keys,
            "completeness": completeness,
            "proposed_services": [item.model_dump() for item in proposed_services],
            "initial_epics": [item.model_dump() for item in initial_epics],
            "role_assignments": role_assignments,
            "model_recommendations": [item.model_dump() for item in model_recommendations],
            "estimated_daily_budget_usd": estimated_daily_budget_usd,
            "estimated_total_budget_usd": estimated_total_budget_usd,
            "budget_posture": budget_posture,
            "budget_warnings": budget_warnings,
        }
        now = utcnow()
        if existing is None:
            return await crud.create(
                self.session,
                ProductPlan,
                product_id=product.id,
                created_at=now,
                updated_at=now,
                **plan_payload,
            )
        for key, value in plan_payload.items():
            setattr(existing, key, value)
        existing.updated_at = now
        return await crud.save(self.session, existing)

    def _normalize_service_proposals(
        self,
        *,
        product: Product,
        objective: str | None,
        scope: str | None,
        raw: object,
    ) -> list[ProductServiceProposal]:
        proposals: list[ProductServiceProposal] = []
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                try:
                    proposals.append(ProductServiceProposal.model_validate(item))
                except Exception:
                    continue
        if proposals:
            return proposals
        return self._proposed_services(product=product, objective=objective, scope=scope)

    def _normalize_epic_proposals(
        self,
        *,
        product: Product,
        services: list[ProductServiceProposal],
        raw: object,
    ) -> list[ProductEpicProposal]:
        epics: list[ProductEpicProposal] = []
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                try:
                    epics.append(ProductEpicProposal.model_validate(item))
                except Exception:
                    continue
        if epics:
            return epics
        return self._initial_epics(product=product, services=services)

    def _normalize_role_assignments(self, raw: object) -> dict[str, object]:
        if isinstance(raw, dict) and raw:
            return raw
        return {
            "Lead": "Own discovery, decomposition, and routing across services.",
            "Builder": "Implement approved slices and attach evidence on execution tasks.",
            "Reviewer": "Validate correctness and release readiness before QA.",
            "Security": "Review risk-sensitive slices and security controls before completion.",
        }

    def _normalize_model_recommendations(
        self,
        *,
        raw: object,
        runtime_models: list[str],
        fallback_optimize_for: str,
        model_costs: dict[str, tuple[float, float]],
    ) -> list[ProductModelRecommendation]:
        recommendations: list[ProductModelRecommendation] = []
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                model_ref = str(item.get("model_ref") or "").strip()
                if model_ref not in runtime_models:
                    continue
                recommendation = {
                    "slice": str(item.get("slice") or "").strip() or "implementation",
                    "model_ref": model_ref,
                    "rationale": str(item.get("rationale") or "").strip() or "Recommended by the planner.",
                    "estimated_cost_usd": _normalize_float(item.get("estimated_cost_usd")),
                }
                try:
                    recommendations.append(ProductModelRecommendation.model_validate(recommendation))
                except Exception:
                    continue
        fallback = self._model_recommendations(
            optimize_for=fallback_optimize_for,
            runtime_models=runtime_models,
            model_costs=model_costs,
        )
        if not recommendations:
            return fallback
        seen_slices = {item.slice for item in recommendations}
        for item in fallback:
            if item.slice not in seen_slices:
                recommendations.append(item)
        return recommendations

    async def _runtime_models_for_product(
        self,
        *,
        product: Product,
    ) -> tuple[list[str], dict[str, tuple[float, float]]]:
        gateway = await self.resolve_gateway(product=product)
        runtime_control = GatewayRuntimeControlService(self.session)
        summary = await runtime_control.runtime_summary(gateway=gateway)
        runtime_models = [entry.ref for entry in summary.catalog if entry.selectable]
        model_costs = await self._model_cost_map(gateway=gateway)
        return runtime_models, model_costs

    async def _model_cost_map(self, *, gateway: Gateway) -> dict[str, tuple[float, float]]:
        runtime_control = GatewayRuntimeControlService(self.session)
        try:
            _base_hash, config = await runtime_control._load_gateway_config(gateway)  # noqa: SLF001
        except Exception:
            return dict(MODEL_COST_FALLBACKS)

        costs = dict(MODEL_COST_FALLBACKS)
        providers = _json_dict(_json_dict(config.get("models")).get("providers"))
        for provider_id, provider_config in providers.items():
            if not isinstance(provider_id, str) or not isinstance(provider_config, dict):
                continue
            models = provider_config.get("models")
            if not isinstance(models, list):
                continue
            for item in models:
                if not isinstance(item, dict):
                    continue
                model_id = item.get("id")
                if not isinstance(model_id, str) or not model_id.strip():
                    continue
                pricing = _json_dict(item.get("pricing"))
                input_cost = pricing.get("input_per_million") or pricing.get("inputPerMillion")
                output_cost = pricing.get("output_per_million") or pricing.get("outputPerMillion")
                if not isinstance(input_cost, (int, float)) or not isinstance(output_cost, (int, float)):
                    continue
                costs[f"{provider_id}/{model_id.strip()}"] = (float(input_cost), float(output_cost))
        return costs

    def _choose_model(
        self,
        *,
        runtime_models: list[str],
        preferred: list[str],
    ) -> str:
        available = [item for item in preferred if item in runtime_models]
        if available:
            return available[0]
        if runtime_models:
            return runtime_models[0]
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="No verified runtime models are available for product planning.",
        )

    def _model_recommendations(
        self,
        *,
        optimize_for: str,
        runtime_models: list[str],
        model_costs: dict[str, tuple[float, float]],
    ) -> list[ProductModelRecommendation]:
        cheapest_first = sorted(
            runtime_models,
            key=lambda ref: model_costs.get(ref, (999.0, 999.0))[0] + model_costs.get(ref, (999.0, 999.0))[1],
        )
        orchestration_choices = [
            "microsoft-foundry/gpt-5.4-mini",
            *cheapest_first,
        ]
        coding_choices = (
            cheapest_first
            if optimize_for == "cheapest-acceptable"
            else [
                "github-copilot/gpt-5.4",
                "openai-codex/gpt-5.4",
                "microsoft-foundry/gpt-5.4-mini",
                *cheapest_first,
            ]
        )
        security_choices = [
            "claude-cli/claude-opus-4-6",
            "google-gemini-cli/gemini-3.1-pro-preview",
            "microsoft-foundry/gpt-5.4-mini",
            *cheapest_first,
        ]
        chosen = {
            "intake-orchestration": self._choose_model(
                runtime_models=runtime_models,
                preferred=orchestration_choices,
            ),
            "implementation": self._choose_model(
                runtime_models=runtime_models,
                preferred=coding_choices,
            ),
            "review": self._choose_model(
                runtime_models=runtime_models,
                preferred=coding_choices,
            ),
            "security-review": self._choose_model(
                runtime_models=runtime_models,
                preferred=security_choices,
            ),
        }
        return [
            ProductModelRecommendation(
                slice="intake-orchestration",
                model_ref=chosen["intake-orchestration"],
                rationale="Use the best price/value model for intake, clarification, and routing.",
            ),
            ProductModelRecommendation(
                slice="implementation",
                model_ref=chosen["implementation"],
                rationale="Prefer the strongest verified coding model unless the budget posture demands a cheaper option.",
            ),
            ProductModelRecommendation(
                slice="review",
                model_ref=chosen["review"],
                rationale="Keep technical review on a strong verified model so acceptance decisions stay precise.",
            ),
            ProductModelRecommendation(
                slice="security-review",
                model_ref=chosen["security-review"],
                rationale="Prefer the current security-focused runtime path before falling back to cheaper general models.",
            ),
        ]

    def _estimate_budget(
        self,
        *,
        service_count: int,
        epic_count: int,
        recommendations: list[ProductModelRecommendation],
        model_costs: dict[str, tuple[float, float]],
    ) -> tuple[float, float]:
        effective_service_count = max(service_count, 1)
        effective_epic_count = max(epic_count, 1)
        totals = 0.0
        for recommendation in recommendations:
            input_tokens, output_tokens = DEFAULT_BUDGET_TOKEN_ESTIMATES.get(
                recommendation.slice.split("-")[0],
                DEFAULT_BUDGET_TOKEN_ESTIMATES["implementation"],
            )
            input_cost, output_cost = model_costs.get(recommendation.model_ref, (0.0, 0.0))
            slice_multiplier = effective_epic_count if recommendation.slice == "implementation" else effective_service_count
            totals += ((input_tokens / 1_000_000) * input_cost + (output_tokens / 1_000_000) * output_cost) * slice_multiplier
        total_budget = round(totals, 4)
        daily_budget = round(max(total_budget / max(effective_service_count * 3, 1), total_budget / 5), 4)
        return daily_budget, total_budget

    def _proposed_services(
        self,
        *,
        product: Product,
        objective: str | None,
        scope: str | None,
    ) -> list[ProductServiceProposal]:
        slug = _slugify(product.slug or product.name)
        description = scope or objective or product.description or product.name
        return [
            ProductServiceProposal(
                name=f"{product.name} Core Service",
                slug=slug,
                description=description,
                objective=objective,
                epics=[
                    f"Define {product.name} delivery scope",
                    f"Build {product.name} core execution slice",
                    f"Validate and ship {product.name}",
                ],
            )
        ]

    def _initial_epics(
        self,
        *,
        product: Product,
        services: list[ProductServiceProposal],
    ) -> list[ProductEpicProposal]:
        epics: list[ProductEpicProposal] = []
        for service in services:
            epics.extend(
                [
                    ProductEpicProposal(
                        title=f"Define {product.name} v1 scope and product rails",
                        description=f"Clarify scope, lifecycle, and delivery risks for {service.name}.",
                        priority="high",
                        service_slug=service.slug,
                    ),
                    ProductEpicProposal(
                        title=f"Build {service.name} core workflow and data model",
                        description=f"Implement the primary user flow and service internals for {service.name}.",
                        priority="high",
                        service_slug=service.slug,
                    ),
                    ProductEpicProposal(
                        title=f"Ship {service.name} operator cockpit and validation",
                        description=f"Add the final operational UX, QA, and launch criteria for {service.name}.",
                        priority="medium",
                        service_slug=service.slug,
                    ),
                ]
            )
        return epics

    def _assistant_plan_reply(self, plan: ProductPlan) -> str:
        read = plan_to_read(plan)
        services = ", ".join(service.name for service in read.proposed_services) or "No services yet"
        models = "\n".join(
            f"- {item.slice}: `{item.model_ref}` — {item.rationale}"
            for item in read.model_recommendations
        )
        warnings = "\n".join(f"- {warning}" for warning in read.budget_warnings)
        if read.missing_questions:
            questions = "\n".join(
                f"{index + 1}. {question}" for index, question in enumerate(read.missing_questions)
            )
            return (
                "I drafted the initial product plan and kept execution paused.\n\n"
                f"Current read:\n- Objective: {read.objective or 'TBD'}\n"
                f"- Proposed service(s): {services}\n"
                f"- Estimated budget: ${read.estimated_total_budget_usd or 0:.2f} total / ${read.estimated_daily_budget_usd or 0:.2f} daily\n\n"
                "I still need these answers before approval:\n"
                f"{questions}\n\n"
                "No work will start until you approve the plan."
            )
        return (
            "Draft product plan is ready and execution is still paused pending approval.\n\n"
            f"Objective: {read.objective or 'TBD'}\n"
            f"Target audience: {read.target_audience or 'TBD'}\n"
            f"Scope: {read.scope or 'TBD'}\n"
            f"Out of scope: {read.exclusions or 'TBD'}\n"
            f"Proposed service(s): {services}\n"
            f"Budget posture: {read.budget_posture or 'within-budget'}\n"
            f"Estimated spend: ${read.estimated_total_budget_usd or 0:.2f} total / ${read.estimated_daily_budget_usd or 0:.2f} daily\n\n"
            "Recommended model mix:\n"
            f"{models}\n\n"
            + (f"Warnings:\n{warnings}\n\n" if warnings else "")
            + "Approve the plan to create services, seed the workflow boards, and start the first epic."
        )

    async def approve_plan(
        self,
        *,
        product: Product,
        approved_by_user_id: UUID,
    ) -> tuple[ProductPlan, list[BoardGroup]]:
        plan = await self.current_plan(product_id=product.id)
        if plan is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No draft plan exists for this product yet.",
            )
        if plan.status == "approved":
            return plan, await self.list_services(product_id=product.id)
        if _json_list(plan.missing_questions):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Answer the remaining product intake questions before approval.",
            )
        if not (product.local_working_directory or product.remote_repository_url):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Set at least a local working directory or remote repository URL before approval.",
            )
        if (plan.plan_sync_status or "").strip().lower() == "stale":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Wait for the structured plan to sync cleanly before approval.",
            )

        services = await self._seed_services(product=product, plan=plan)
        now = utcnow()
        plan.status = "approved"
        plan.approved_at = now
        plan.approved_by_user_id = approved_by_user_id
        plan.updated_at = now
        product.status = "active"
        product.updated_at = now
        await crud.save(self.session, product, commit=False, refresh=False)
        await crud.save(self.session, plan, commit=False, refresh=False)
        await self.session.commit()
        await crud.create(
            self.session,
            ProductMessage,
            product_id=product.id,
            role="system",
            content=(
                "Plan approved. Mission Control created the execution service areas and seeded the first epic backlog."
            ),
            meta={"services": [str(service.id) for service in services]},
        )
        return plan, services

    async def _seed_services(
        self,
        *,
        product: Product,
        plan: ProductPlan,
    ) -> list[BoardGroup]:
        gateway = await self.resolve_gateway(product=product)
        service_proposals = [
            ProductServiceProposal.model_validate(item)
            for item in _json_list(plan.proposed_services)
            if isinstance(item, dict)
        ]
        if not service_proposals:
            service_proposals = self._proposed_services(
                product=product,
                objective=plan.objective,
                scope=plan.scope,
            )
        epic_proposals = [
            ProductEpicProposal.model_validate(item)
            for item in _json_list(plan.initial_epics)
            if isinstance(item, dict)
        ]

        created_groups: list[BoardGroup] = []
        created_leads: list[Agent] = []
        requirements_by_service_slug: dict[str, Board] = {}
        for service in service_proposals:
            existing_group = (
                await BoardGroup.objects.filter_by(
                    organization_id=product.organization_id,
                    product_id=product.id,
                    slug=f"{product.slug}-{service.slug}",
                ).first(self.session)
            )
            if existing_group is not None:
                group = existing_group
            else:
                group = await crud.create(
                    self.session,
                    BoardGroup,
                    organization_id=product.organization_id,
                    product_id=product.id,
                    name=service.name,
                    slug=f"{product.slug}-{service.slug}",
                    description=service.description,
                )
            created_groups.append(group)
            group_boards = await Board.objects.filter_by(board_group_id=group.id).all(self.session)
            if not group_boards:
                for template in WORKFLOW_BOARD_TEMPLATES:
                    board = await crud.create(
                        self.session,
                        Board,
                        organization_id=product.organization_id,
                        gateway_id=gateway.id,
                        board_group_id=group.id,
                        name=template["name"],
                        slug=template["slug"],
                        description=template["description"],
                        require_approval_for_done=template["require_approval_for_done"],
                        require_review_before_done=template["require_review_before_done"],
                        comment_required_for_review=template["comment_required_for_review"],
                        only_lead_can_change_status=template["only_lead_can_change_status"],
                    )
                    group_boards.append(board)
            for board in group_boards:
                if board.name == "Requirements":
                    requirements_by_service_slug[service.slug] = board
                existing_lead = (
                    await Agent.objects.filter_by(board_id=board.id)
                    .filter(col(Agent.is_board_lead).is_(True))
                    .first(self.session)
                )
                if existing_lead is None:
                    _gateway, config = await GatewayDispatchService(self.session).require_gateway_config_for_board(board)
                    lead = await OpenClawProvisioningService(self.session).ensure_board_lead_defaults(
                        request=LeadAgentRequest(
                            board=board,
                            gateway=gateway,
                            config=config,
                            user=None,
                            options=LeadAgentOptions(
                                agent_name="Lead",
                                identity_profile={
                                    "role": "Board Lead",
                                    "communication_style": "direct, concise, practical",
                                    "emoji": ":gear:",
                                },
                                model_profile="general",
                                model_fallback_policy="profile",
                            ),
                        )
                    )
                    created_leads.append(lead)
        if created_leads:
            await GatewayRuntimeControlService(self.session).sync_model_policies(
                gateway=gateway,
                agents=created_leads,
                auth=None,
            )

        from app.api import tasks as tasks_api

        for epic in epic_proposals:
            requirements_board = requirements_by_service_slug.get(
                epic.service_slug or service_proposals[0].slug
            )
            if requirements_board is None:
                continue
            task = await crud.create(
                self.session,
                Task,
                organization_id=product.organization_id,
                board_id=requirements_board.id,
                title=epic.title,
                description=epic.description,
                priority=epic.priority,
                status="inbox",
            )
            await tasks_api._notify_lead_on_task_create(
                session=self.session,
                board=requirements_board,
                task=task,
            )
        return created_groups
