"""Add managed node toolchain fields to gateways.

Revision ID: f7b3d1c9a6e4
Revises: ce4a9d12b7f1
Create Date: 2026-04-17 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "f7b3d1c9a6e4"
down_revision = "ce4a9d12b7f1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Persist managed toolchain state on gateways."""
    op.add_column("gateways", sa.Column("tool_profile", sa.String(), nullable=True))
    op.add_column("gateways", sa.Column("provider_configs", sa.JSON(), nullable=True))
    op.add_column("gateways", sa.Column("model_definitions", sa.JSON(), nullable=True))
    op.add_column("gateways", sa.Column("provider_secret_refs", sa.JSON(), nullable=True))


def downgrade() -> None:
    """Remove managed toolchain fields from gateways."""
    op.drop_column("gateways", "provider_secret_refs")
    op.drop_column("gateways", "model_definitions")
    op.drop_column("gateways", "provider_configs")
    op.drop_column("gateways", "tool_profile")
