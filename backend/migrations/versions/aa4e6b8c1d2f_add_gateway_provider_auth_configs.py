"""Add gateway provider auth configs."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "aa4e6b8c1d2f"
down_revision = "f7b3d1c9a6e4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gateways", sa.Column("provider_auth_configs", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("gateways", "provider_auth_configs")
