"""Product CRUD, chat-first planning, and approval-backed execution."""

from __future__ import annotations

import re
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import require_org_member, require_user_auth
from app.core.time import utcnow
from app.db import crud
from app.db.session import get_session
from app.models.agents import Agent
from app.models.board_groups import BoardGroup
from app.models.gateways import Gateway
from app.models.products import Product
from app.schemas.board_groups import BoardGroupRead
from app.schemas.products import (
    ProductCreate,
    ProductLeadRuntimeDefaults,
    ProductMessageCreate,
    ProductMessageRead,
    ProductPlanApproveRequest,
    ProductPlanRead,
    ProductRead,
    ProductSummaryRead,
    ProductUpdate,
)
from app.services.openclaw.runtime_control import GatewayRuntimeControlService
from app.services.organizations import OrganizationContext
from app.services.product_planning import (
    ProductPlanningService,
    message_to_read,
    plan_to_read,
    product_to_read,
)

router = APIRouter(prefix="/products", tags=["products"])
SESSION_DEP = Depends(get_session)
ORG_MEMBER_DEP = Depends(require_org_member)
USER_AUTH_DEP = Depends(require_user_auth)


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "product"


async def _require_gateway(
    session: AsyncSession,
    *,
    organization_id: UUID,
    gateway_id: UUID | None,
) -> Gateway | None:
    if gateway_id is None:
        return None
    gateway = await crud.get_by_id(session, Gateway, gateway_id)
    if gateway is None or gateway.organization_id != organization_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="default_gateway_id is invalid",
        )
    return gateway


def _lead_runtime_validation_agent(
    *,
    gateway_id: UUID,
    defaults: ProductLeadRuntimeDefaults,
) -> Agent:
    return Agent(
        name="Product Lead Runtime Validation",
        gateway_id=gateway_id,
        model_profile=defaults.model_profile,
        model_primary=defaults.model_primary,
        model_fallback_policy=defaults.model_fallback_policy,
        model_fallbacks=defaults.model_fallbacks,
    )


async def _validate_lead_runtime_defaults(
    session: AsyncSession,
    *,
    gateway: Gateway | None,
    defaults: ProductLeadRuntimeDefaults | None,
) -> None:
    if defaults is None:
        return
    if gateway is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="lead_runtime_defaults require a default gateway.",
        )
    await GatewayRuntimeControlService(session).assert_model_policies_supported(
        gateway=gateway,
        agents=[_lead_runtime_validation_agent(gateway_id=gateway.id, defaults=defaults)],
    )


async def _require_product(
    session: AsyncSession,
    *,
    product_id: UUID,
    organization_id: UUID,
) -> Product:
    product = await Product.objects.by_id(product_id).first(session)
    if product is None or product.organization_id != organization_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    return product


async def _unique_slug(
    session: AsyncSession,
    *,
    organization_id: UUID,
    base_slug: str,
    exclude_product_id: UUID | None = None,
) -> str:
    suffix = 1
    slug = base_slug
    while True:
        statement = select(Product.id).where(
            col(Product.organization_id) == organization_id,
            col(Product.slug) == slug,
        )
        if exclude_product_id is not None:
            statement = statement.where(col(Product.id) != exclude_product_id)
        existing = (await session.exec(statement.limit(1))).first()
        if existing is None:
            return slug
        suffix += 1
        slug = f"{base_slug}-{suffix}"


@router.get("", response_model=list[ProductSummaryRead])
async def list_products(
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_MEMBER_DEP,
) -> list[ProductSummaryRead]:
    statement = (
        select(Product)
        .where(col(Product.organization_id) == ctx.organization.id)
        .order_by(col(Product.updated_at).desc(), col(Product.created_at).desc())
    )
    products = list(await session.exec(statement))
    planner = ProductPlanningService(session)
    return [await planner.product_summary(product=product) for product in products]


@router.post("", response_model=ProductRead)
async def create_product(
    payload: ProductCreate,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_MEMBER_DEP,
) -> ProductRead:
    gateway = await _require_gateway(
        session,
        organization_id=ctx.organization.id,
        gateway_id=payload.default_gateway_id,
    )
    await _validate_lead_runtime_defaults(
        session,
        gateway=gateway,
        defaults=payload.lead_runtime_defaults,
    )
    slug = await _unique_slug(
        session,
        organization_id=ctx.organization.id,
        base_slug=_slugify(payload.slug or payload.name),
    )
    product = await crud.create(
        session,
        Product,
        organization_id=ctx.organization.id,
        default_gateway_id=payload.default_gateway_id,
        name=payload.name,
        slug=slug,
        description=payload.description,
        local_working_directory=payload.local_working_directory,
        remote_repository_url=payload.remote_repository_url,
        status=payload.status,
        optimize_for=payload.budget_policy.optimize_for,
        planner_mode=payload.planner_policy.mode,
        planner_model_override=payload.planner_policy.model_override,
        lead_runtime_defaults=(
            payload.lead_runtime_defaults.model_dump(exclude_none=True)
            if payload.lead_runtime_defaults is not None
            else None
        ),
        daily_budget_cap_usd=payload.budget_policy.daily_budget_cap_usd,
        total_budget_cap_usd=payload.budget_policy.total_budget_cap_usd,
        execution_policy=payload.execution_policy.model_dump(exclude_none=True),
    )
    return product_to_read(product)


@router.get("/{product_id}", response_model=ProductRead)
async def get_product(
    product_id: UUID,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_MEMBER_DEP,
    ) -> ProductRead:
    product = await _require_product(
        session,
        product_id=product_id,
        organization_id=ctx.organization.id,
    )
    return product_to_read(product)


@router.patch("/{product_id}", response_model=ProductRead)
async def update_product(
    product_id: UUID,
    payload: ProductUpdate,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_MEMBER_DEP,
) -> ProductRead:
    product = await _require_product(
        session,
        product_id=product_id,
        organization_id=ctx.organization.id,
    )
    updates = payload.model_dump(exclude_unset=True)
    gateway_id = updates.get("default_gateway_id", product.default_gateway_id)
    gateway = await _require_gateway(
        session,
        organization_id=ctx.organization.id,
        gateway_id=gateway_id,
    )
    effective_lead_runtime_defaults = updates.get(
        "lead_runtime_defaults",
        product.lead_runtime_defaults,
    )
    await _validate_lead_runtime_defaults(
        session,
        gateway=gateway,
        defaults=(
            ProductLeadRuntimeDefaults.model_validate(effective_lead_runtime_defaults)
            if effective_lead_runtime_defaults is not None
            else None
        ),
    )
    if "name" in updates and updates["name"]:
        product.name = str(updates["name"])
    if "slug" in updates or ("name" in updates and "slug" not in updates):
        requested_slug = updates.get("slug") or product.name
        product.slug = await _unique_slug(
            session,
            organization_id=ctx.organization.id,
            base_slug=_slugify(str(requested_slug)),
            exclude_product_id=product.id,
        )
    if "description" in updates:
        product.description = updates["description"]
    if "local_working_directory" in updates:
        product.local_working_directory = updates["local_working_directory"]
    if "remote_repository_url" in updates:
        product.remote_repository_url = updates["remote_repository_url"]
    if "status" in updates and updates["status"] is not None:
        product.status = updates["status"]
    if "default_gateway_id" in updates:
        product.default_gateway_id = updates["default_gateway_id"]
    if "execution_policy" in updates and updates["execution_policy"] is not None:
        product.execution_policy = updates["execution_policy"].model_dump(exclude_none=True)
    if "budget_policy" in updates and updates["budget_policy"] is not None:
        product.optimize_for = updates["budget_policy"].optimize_for
        product.daily_budget_cap_usd = updates["budget_policy"].daily_budget_cap_usd
        product.total_budget_cap_usd = updates["budget_policy"].total_budget_cap_usd
    if "planner_policy" in updates and updates["planner_policy"] is not None:
        product.planner_mode = updates["planner_policy"].mode
        product.planner_model_override = updates["planner_policy"].model_override
    if "lead_runtime_defaults" in updates:
        lead_runtime_defaults = updates["lead_runtime_defaults"]
        product.lead_runtime_defaults = (
            lead_runtime_defaults.model_dump(exclude_none=True)
            if lead_runtime_defaults is not None
            else None
        )
    if not (product.local_working_directory or product.remote_repository_url):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Provide at least a local working directory or a remote repository URL.",
        )
    product.updated_at = utcnow()
    updated = await crud.save(session, product)
    return product_to_read(updated)


@router.get("/{product_id}/chat", response_model=list[ProductMessageRead])
async def list_product_chat(
    product_id: UUID,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_MEMBER_DEP,
) -> list[ProductMessageRead]:
    product = await _require_product(
        session,
        product_id=product_id,
        organization_id=ctx.organization.id,
    )
    planner = ProductPlanningService(session)
    return [message_to_read(item) for item in await planner.list_messages(product_id=product.id)]


@router.post("/{product_id}/chat", response_model=ProductMessageRead)
async def post_product_chat(
    product_id: UUID,
    payload: ProductMessageCreate,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_MEMBER_DEP,
) -> ProductMessageRead:
    product = await _require_product(
        session,
        product_id=product_id,
        organization_id=ctx.organization.id,
    )
    if product.status == "archived":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Archived products do not accept new planning messages.",
        )
    planner = ProductPlanningService(session)
    assistant_message, _plan = await planner.record_chat_turn(
        product=product,
        content=payload.content,
        planner_mode_override=payload.planner_mode_override,
        planner_model_override=payload.planner_model_override,
    )
    return message_to_read(assistant_message)


@router.get("/{product_id}/plan", response_model=ProductPlanRead)
async def get_product_plan(
    product_id: UUID,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_MEMBER_DEP,
) -> ProductPlanRead:
    product = await _require_product(
        session,
        product_id=product_id,
        organization_id=ctx.organization.id,
    )
    planner = ProductPlanningService(session)
    plan = await planner.current_plan(product_id=product.id)
    if plan is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Plan not found")
    return plan_to_read(plan)


@router.post("/{product_id}/plan/approve", response_model=ProductPlanRead)
async def approve_product_plan(
    product_id: UUID,
    payload: ProductPlanApproveRequest,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_MEMBER_DEP,
    auth=USER_AUTH_DEP,
) -> ProductPlanRead:
    del payload  # approval is v1 boolean-only; presence of this call is approval.
    product = await _require_product(
        session,
        product_id=product_id,
        organization_id=ctx.organization.id,
    )
    if product.status == "archived":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Archived products cannot start new execution.",
        )
    planner = ProductPlanningService(session)
    plan, _services = await planner.approve_plan(
        product=product,
        approved_by_user_id=auth.user.id,
    )
    return plan_to_read(plan)


@router.get("/{product_id}/services", response_model=list[BoardGroupRead])
async def list_product_services(
    product_id: UUID,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_MEMBER_DEP,
) -> list[BoardGroupRead]:
    await _require_product(
        session,
        product_id=product_id,
        organization_id=ctx.organization.id,
    )
    statement = (
        select(BoardGroup)
        .where(
            col(BoardGroup.organization_id) == ctx.organization.id,
            col(BoardGroup.product_id) == product_id,
        )
        .order_by(col(BoardGroup.updated_at).desc(), col(BoardGroup.created_at).desc())
    )
    groups = list(await session.exec(statement))
    return [BoardGroupRead.model_validate(group.model_dump()) for group in groups]
