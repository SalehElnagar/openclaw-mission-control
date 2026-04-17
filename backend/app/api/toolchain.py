"""Preset catalog endpoints for Mission Control's node toolchain editor."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import require_org_admin
from app.schemas.gateway_runtime import ToolchainCatalogResponse
from app.services.organizations import OrganizationContext
from app.services.toolchain_catalog import toolchain_catalog

router = APIRouter(prefix="/toolchain", tags=["toolchain"])
ORG_ADMIN_DEP = Depends(require_org_admin)


@router.get("/catalog", response_model=ToolchainCatalogResponse)
async def get_toolchain_catalog(
    _ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> ToolchainCatalogResponse:
    """Return the curated provider/model preset catalog for node toolchain editing."""

    return toolchain_catalog()
