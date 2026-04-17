# ruff: noqa: INP001
"""Integration tests for product planning and approval APIs."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import require_org_member, require_user_auth
from app.api.products import router as products_router
from app.core.auth import AuthContext
from app.db.session import get_session
from app.models.agents import Agent
from app.models.board_groups import BoardGroup
from app.models.boards import Board
from app.models.gateways import Gateway
from app.models.organization_members import OrganizationMember
from app.models.organizations import Organization
from app.models.product_plans import ProductPlan
from app.models.products import Product
from app.models.tasks import Task
from app.models.users import User
from app.services.organizations import OrganizationContext


async def _make_engine() -> AsyncEngine:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    return engine


def _build_app(
    session_maker: async_sessionmaker[AsyncSession],
    *,
    organization: Organization,
    user: User,
) -> FastAPI:
    app = FastAPI()
    api_v1 = APIRouter(prefix="/api/v1")
    api_v1.include_router(products_router)
    app.include_router(api_v1)

    async def _override_get_session() -> AsyncSession:
        async with session_maker() as session:
            yield session

    async def _override_require_org_member() -> OrganizationContext:
        return OrganizationContext(
            organization=organization,
            member=OrganizationMember(
                organization_id=organization.id,
                user_id=user.id,
                role="owner",
                all_boards_read=True,
                all_boards_write=True,
            ),
        )

    async def _override_require_user_auth() -> AuthContext:
        return AuthContext(actor_type="user", user=user)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[require_org_member] = _override_require_org_member
    app.dependency_overrides[require_user_auth] = _override_require_user_auth
    return app


@pytest.mark.asyncio
async def test_product_chat_and_approval_seed_services(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            organization = Organization(id=uuid4(), name="Personal")
            user = User(
                id=uuid4(),
                clerk_user_id="product-test-user",
                email="operator@example.com",
                name="Operator",
            )
            gateway = Gateway(
                id=uuid4(),
                organization_id=organization.id,
                name="Gateway One",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            session.add(organization)
            session.add(user)
            session.add(gateway)
            await session.commit()

        app = _build_app(session_maker, organization=organization, user=user)

        planner_calls: list[dict[str, object]] = []
        lead_requests: list[object] = []

        async def _fake_runtime_models_for_product(self, *, product: Product):
            del product
            return (
                [
                    "microsoft-foundry/gpt-5.4-mini",
                    "openai-codex/gpt-5.4",
                    "github-copilot/gpt-5.4",
                    "claude-cli/claude-opus-4-6",
                ],
                {
                    "microsoft-foundry/gpt-5.4-mini": (0.15, 0.60),
                    "openai-codex/gpt-5.4": (1.25, 5.00),
                    "github-copilot/gpt-5.4": (1.25, 5.00),
                    "claude-cli/claude-opus-4-6": (15.0, 75.0),
                },
            )

        async def _fake_run_assistant_turn(
            self,
            *,
            product: Product,
            gateway: Gateway,
            existing: ProductPlan | None,
            content: str,
            runtime_models: list[str],
            model_costs: dict[str, tuple[float, float]],
            planner_model_ref: str,
        ):
            del gateway, existing, runtime_models, model_costs
            planner_calls.append({"planner_model_ref": planner_model_ref, "content": content})
            return (
                (
                    f"{product.name} looks promising for dispatch operators. "
                    "I captured the first execution shape and kept delivery paused until you approve it."
                ),
                f"product:{product.id}:planner",
                planner_model_ref,
            )

        async def _fake_run_plan_synthesis_turn(
            self,
            *,
            product: Product,
            gateway: Gateway,
            existing: ProductPlan | None,
            runtime_models: list[str],
            model_costs: dict[str, tuple[float, float]],
            planner_model_ref: str,
        ):
            del gateway, existing, runtime_models, model_costs, planner_model_ref
            return {
                "objective": f"{product.name} dispatch platform",
                "target_audience": "dispatch operators",
                "scope": "Launch a web platform for routing and fleet triage.",
                "exclusions": "Native mobile apps.",
                "proposed_services": [
                    {
                        "name": "FleetOps Core Service",
                        "slug": "fleetops-core-service",
                        "description": "Core fleet triage and routing orchestration service.",
                        "objective": "Route fleet work faster with AI-assisted triage.",
                        "epics": [
                            "Define FleetOps v1 scope and product rails",
                            "Build FleetOps core workflow and data model",
                        ],
                    }
                ],
                "initial_epics": [
                    {
                        "title": "Define FleetOps v1 scope and product rails",
                        "description": "Clarify operator workflow and launch constraints.",
                        "priority": "high",
                        "service_slug": "fleetops-core-service",
                    }
                ],
                "role_assignments": {
                    "Lead": "Own discovery, decomposition, and routing across services.",
                    "Builder": "Implement approved slices and attach evidence on execution tasks.",
                    "Reviewer": "Validate correctness and release readiness before QA.",
                    "Security": "Review risk-sensitive slices and security controls before completion.",
                },
                "model_recommendations": [
                    {
                        "slice": "intake-orchestration",
                        "model_ref": "microsoft-foundry/gpt-5.4-mini",
                        "rationale": "Cheapest strong planner for normal intake.",
                        "estimated_cost_usd": 0.1,
                    }
                ],
                "estimated_daily_budget_usd": 2.4,
                "estimated_total_budget_usd": 7.2,
                "budget_posture": "within-budget",
                "budget_warnings": [],
                "missing_questions": [],
                "ready_for_approval": True,
            }

        async def _fake_require_gateway_config_for_board(self, board: Board):
            del board
            return gateway, object()

        async def _fake_ensure_board_lead_defaults(self, *, request):
            lead_requests.append(request.options)
            existing = (
                await Agent.objects.filter_by(board_id=request.board.id)
                .filter(col(Agent.is_board_lead).is_(True))
                .first(self.session)
            )
            if existing is not None:
                return existing
            lead = Agent(
                id=uuid4(),
                board_id=request.board.id,
                gateway_id=request.gateway.id,
                name="Lead",
                status="standby",
                is_board_lead=True,
                openclaw_session_id=f"agent:lead-{request.board.id}:main",
                heartbeat_config={"every": "0m", "target": "none"},
            )
            self.session.add(lead)
            await self.session.commit()
            await self.session.refresh(lead)
            return lead

        async def _fake_sync_model_policies(self, *, gateway, agents=None, auth=None):
            del gateway, agents, auth
            return False

        async def _fake_assert_model_policies_supported(self, *, gateway, agents):
            del gateway, agents
            return None

        async def _fake_notify_lead_on_task_create(*, session, board, task):
            del session, board, task
            return None

        monkeypatch.setattr(
            "app.services.product_planning.ProductPlanningService._runtime_models_for_product",
            _fake_runtime_models_for_product,
        )
        monkeypatch.setattr(
            "app.services.product_planning.ProductPlanningService._run_assistant_turn",
            _fake_run_assistant_turn,
        )
        monkeypatch.setattr(
            "app.services.product_planning.ProductPlanningService._run_plan_synthesis_turn",
            _fake_run_plan_synthesis_turn,
        )
        monkeypatch.setattr(
            "app.services.product_planning.GatewayDispatchService.require_gateway_config_for_board",
            _fake_require_gateway_config_for_board,
        )
        monkeypatch.setattr(
            "app.services.product_planning.OpenClawProvisioningService.ensure_board_lead_defaults",
            _fake_ensure_board_lead_defaults,
        )
        monkeypatch.setattr(
            "app.services.product_planning.GatewayRuntimeControlService.sync_model_policies",
            _fake_sync_model_policies,
        )
        monkeypatch.setattr(
            "app.api.products.GatewayRuntimeControlService.assert_model_policies_supported",
            _fake_assert_model_policies_supported,
        )
        monkeypatch.setattr(
            "app.api.tasks._notify_lead_on_task_create",
            _fake_notify_lead_on_task_create,
        )

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            create_response = await client.post(
                "/api/v1/products",
                json={
                    "name": "FleetOps",
                    "description": "Product brief: AI ops platform for dispatch operators.",
                    "local_working_directory": "/tmp/fleetops",
                    "default_gateway_id": str(gateway.id),
                    "budget_policy": {
                        "daily_budget_cap_usd": 50,
                        "total_budget_cap_usd": 300,
                        "optimize_for": "balanced",
                    },
                    "execution_policy": {
                        "requires_plan_approval": True,
                        "auto_start_on_approval": True,
                        "service_template": "standard",
                    },
                    "planner_policy": {
                        "mode": "fast-thinking",
                        "model_override": None,
                    },
                    "lead_runtime_defaults": {
                        "model_profile": "coder",
                        "model_primary": "microsoft-foundry/gpt-5.4-mini",
                        "model_fallback_policy": "explicit-only",
                        "model_fallbacks": ["microsoft-foundry/gpt-5.4-mini"],
                    },
                },
            )
            assert create_response.status_code == 200
            product_id = create_response.json()["id"]
            assert create_response.json()["lead_runtime_defaults"]["model_profile"] == "coder"

            chat_response = await client.post(
                f"/api/v1/products/{product_id}/chat",
                json={
                    "content": (
                        "Target audience: dispatch operators. "
                        "Scope: launch a web platform for routing and fleet triage. "
                        "Exclude: native mobile apps."
                    ),
                    "planner_mode_override": "deep-thinking",
                },
            )
            assert chat_response.status_code == 200
            assert chat_response.json()["role"] == "assistant"
            assert chat_response.json()["meta"]["planner_mode"] == "deep-thinking"
            assert chat_response.json()["meta"]["planner_override_applied"] is True
            assert planner_calls[0]["planner_model_ref"] == "openai-codex/gpt-5.4"

            plan_response = await client.get(f"/api/v1/products/{product_id}/plan")
            assert plan_response.status_code == 200
            plan_payload = plan_response.json()
            assert plan_payload["status"] == "draft"
            assert plan_payload["missing_questions"] == []
            assert plan_payload["planner_model_ref"] == "openai-codex/gpt-5.4"
            assert plan_payload["planner_status"] == "ready-for-approval"
            assert plan_payload["plan_sync_status"] == "synced"
            assert any(
                item["model_ref"] == "microsoft-foundry/gpt-5.4-mini"
                for item in plan_payload["model_recommendations"]
            )

            approve_response = await client.post(
                f"/api/v1/products/{product_id}/plan/approve", json={}
            )
            assert approve_response.status_code == 200
            approved_plan = approve_response.json()
            assert approved_plan["status"] == "approved"

            services_response = await client.get(f"/api/v1/products/{product_id}/services")
            assert services_response.status_code == 200
            services_payload = services_response.json()
            assert len(services_payload) == 1

        async with session_maker() as session:
            product = await session.get(Product, UUID(product_id))
            assert product is not None
            assert product.status == "active"
            assert product.local_working_directory == "/tmp/fleetops"
            assert product.planner_mode == "fast-thinking"
            assert product.lead_runtime_defaults is not None
            assert product.lead_runtime_defaults["model_profile"] == "coder"

            plan = await ProductPlan.objects.filter_by(product_id=product.id).first(session)
            assert plan is not None
            assert plan.status == "approved"

            service_group = (
                await session.exec(
                    select(BoardGroup).where(col(BoardGroup.product_id) == product.id),
                )
            ).first()
            assert service_group is not None

            boards = (
                await session.exec(
                    select(Board).where(col(Board.board_group_id) == service_group.id),
                )
            ).all()
            assert {board.name for board in boards} == {
                "Requirements",
                "Ready",
                "In Progress",
                "Review",
                "Security Review",
                "QA",
                "Done",
            }

            requirements_board = next(board for board in boards if board.name == "Requirements")
            tasks = (
                await session.exec(
                    select(Task).where(col(Task.board_id) == requirements_board.id),
                )
            ).all()
            assert len(tasks) >= 1
            assert lead_requests
            assert all(request.model_profile == "coder" for request in lead_requests)
            assert all(
                request.model_primary == "microsoft-foundry/gpt-5.4-mini"
                for request in lead_requests
            )
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_create_product_requires_workspace_or_repo() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            organization = Organization(id=uuid4(), name="Personal")
            user = User(
                id=uuid4(),
                clerk_user_id="product-test-user-2",
                email="operator2@example.com",
                name="Operator",
            )
            session.add(organization)
            session.add(user)
            await session.commit()

        app = _build_app(session_maker, organization=organization, user=user)
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            create_response = await client.post(
                "/api/v1/products",
                json={
                    "name": "NoWorkspaceProduct",
                },
            )
            assert create_response.status_code == 422
            assert "local working directory" in create_response.text.lower()
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_create_product_rejects_explicit_lead_defaults_without_gateway() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            organization = Organization(id=uuid4(), name="Personal")
            user = User(
                id=uuid4(),
                clerk_user_id="product-test-user-2b",
                email="operator2b@example.com",
                name="Operator",
            )
            session.add(organization)
            session.add(user)
            await session.commit()

        app = _build_app(session_maker, organization=organization, user=user)
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            create_response = await client.post(
                "/api/v1/products",
                json={
                    "name": "LeadDefaultsWithoutGateway",
                    "local_working_directory": "/tmp/lead-defaults-without-gateway",
                    "lead_runtime_defaults": {
                        "model_profile": "general",
                    },
                },
            )
            assert create_response.status_code == 422
            assert "default gateway" in create_response.text.lower()
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_product_chat_keeps_assistant_reply_when_plan_sync_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            organization = Organization(id=uuid4(), name="Personal")
            user = User(
                id=uuid4(),
                clerk_user_id="product-test-user-3",
                email="operator3@example.com",
                name="Operator",
            )
            gateway = Gateway(
                id=uuid4(),
                organization_id=organization.id,
                name="Gateway One",
                url="ws://gateway.example/ws",
                workspace_root="/tmp/workspaces",
            )
            session.add(organization)
            session.add(user)
            session.add(gateway)
            await session.commit()

        app = _build_app(session_maker, organization=organization, user=user)

        async def _fake_runtime_models_for_product(self, *, product: Product):
            del product
            return (
                ["microsoft-foundry/gpt-5.4-mini"],
                {"microsoft-foundry/gpt-5.4-mini": (0.15, 0.60)},
            )

        async def _fake_run_assistant_turn(
            self,
            *,
            product: Product,
            gateway: Gateway,
            existing: ProductPlan | None,
            content: str,
            runtime_models: list[str],
            model_costs: dict[str, tuple[float, float]],
            planner_model_ref: str,
        ):
            del gateway, existing, content, runtime_models, model_costs
            return (
                f"I understand {product.name} as an internal platform product. I still need one tighter scope decision before approval.",
                f"product:{product.id}:planner",
                planner_model_ref,
            )

        async def _fake_run_plan_synthesis_turn(
            self,
            *,
            product: Product,
            gateway: Gateway,
            existing: ProductPlan | None,
            runtime_models: list[str],
            model_costs: dict[str, tuple[float, float]],
            planner_model_ref: str,
        ):
            del product, gateway, existing, runtime_models, model_costs, planner_model_ref
            raise ValueError("sync pass could not parse the transcript")

        monkeypatch.setattr(
            "app.services.product_planning.ProductPlanningService._runtime_models_for_product",
            _fake_runtime_models_for_product,
        )
        monkeypatch.setattr(
            "app.services.product_planning.ProductPlanningService._run_assistant_turn",
            _fake_run_assistant_turn,
        )
        monkeypatch.setattr(
            "app.services.product_planning.ProductPlanningService._run_plan_synthesis_turn",
            _fake_run_plan_synthesis_turn,
        )

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            create_response = await client.post(
                "/api/v1/products",
                json={
                    "name": "PlannerSyncFailure",
                    "local_working_directory": "/tmp/planner-sync-failure",
                    "default_gateway_id": str(gateway.id),
                },
            )
            assert create_response.status_code == 200
            product_id = create_response.json()["id"]

            chat_response = await client.post(
                f"/api/v1/products/{product_id}/chat",
                json={"content": "Build an internal platform for release automation."},
            )
            assert chat_response.status_code == 200
            assert "internal platform product" in chat_response.json()["content"]
            assert chat_response.json()["meta"]["plan_sync_status"] == "stale"

            plan_response = await client.get(f"/api/v1/products/{product_id}/plan")
            assert plan_response.status_code == 200
            plan_payload = plan_response.json()
            assert plan_payload["plan_sync_status"] == "stale"
            assert "sync pass could not parse" in plan_payload["plan_sync_error"]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_product_approval_requires_location_anchor() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            organization = Organization(id=uuid4(), name="Personal")
            user = User(
                id=uuid4(),
                clerk_user_id="product-test-user-4",
                email="operator4@example.com",
                name="Operator",
            )
            product = Product(
                id=uuid4(),
                organization_id=organization.id,
                name="Legacy Product",
                slug="legacy-product",
                status="draft",
            )
            plan = ProductPlan(
                product_id=product.id,
                status="draft",
                objective="Legacy product objective",
                missing_questions=[],
                plan_sync_status="synced",
            )
            session.add(organization)
            session.add(user)
            session.add(product)
            session.add(plan)
            await session.commit()

        app = _build_app(session_maker, organization=organization, user=user)
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            approve_response = await client.post(
                f"/api/v1/products/{product.id}/plan/approve", json={}
            )
            assert approve_response.status_code == 422
            assert "local working directory" in approve_response.text.lower()
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_product_approval_requires_clean_plan_sync() -> None:
    engine = await _make_engine()
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            organization = Organization(id=uuid4(), name="Personal")
            user = User(
                id=uuid4(),
                clerk_user_id="product-test-user-5",
                email="operator5@example.com",
                name="Operator",
            )
            product = Product(
                id=uuid4(),
                organization_id=organization.id,
                name="Stale Sync Product",
                slug="stale-sync-product",
                status="draft",
                local_working_directory="/tmp/stale-sync",
            )
            plan = ProductPlan(
                product_id=product.id,
                status="draft",
                objective="Stale sync objective",
                missing_questions=[],
                plan_sync_status="stale",
                plan_sync_error="sync pass could not parse the transcript",
            )
            session.add(organization)
            session.add(user)
            session.add(product)
            session.add(plan)
            await session.commit()

        app = _build_app(session_maker, organization=organization, user=user)
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            approve_response = await client.post(
                f"/api/v1/products/{product.id}/plan/approve", json={}
            )
            assert approve_response.status_code == 422
            assert "sync cleanly" in approve_response.text.lower()
    finally:
        await engine.dispose()
