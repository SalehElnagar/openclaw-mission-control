"""Add product plan sync status fields.

Revision ID: a4d9c2e1f7b6
Revises: f2c4b6d8e1a9
Create Date: 2026-04-16 00:40:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "a4d9c2e1f7b6"
down_revision = "f2c4b6d8e1a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    plan_columns = {column["name"] for column in inspector.get_columns("product_plans")}

    if "plan_sync_status" not in plan_columns:
        op.add_column("product_plans", sa.Column("plan_sync_status", sa.String(), nullable=True))
    if "plan_sync_error" not in plan_columns:
        op.add_column("product_plans", sa.Column("plan_sync_error", sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    plan_columns = {column["name"] for column in inspector.get_columns("product_plans")}

    if "plan_sync_error" in plan_columns:
        op.drop_column("product_plans", "plan_sync_error")
    if "plan_sync_status" in plan_columns:
        op.drop_column("product_plans", "plan_sync_status")
