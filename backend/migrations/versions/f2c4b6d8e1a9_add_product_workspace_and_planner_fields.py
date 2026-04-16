"""Add product workspace and planner preference fields.

Revision ID: f2c4b6d8e1a9
Revises: e6b4a1d9c2f7
Create Date: 2026-04-15 23:55:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "f2c4b6d8e1a9"
down_revision = "e6b4a1d9c2f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    product_columns = {column["name"] for column in inspector.get_columns("products")}

    if "local_working_directory" not in product_columns:
        op.add_column("products", sa.Column("local_working_directory", sa.Text(), nullable=True))
    if "remote_repository_url" not in product_columns:
        op.add_column("products", sa.Column("remote_repository_url", sa.Text(), nullable=True))
    if "planner_mode" not in product_columns:
        op.add_column(
            "products",
            sa.Column("planner_mode", sa.String(), nullable=False, server_default="auto"),
        )
        op.alter_column("products", "planner_mode", server_default=None)
    if "planner_model_override" not in product_columns:
        op.add_column("products", sa.Column("planner_model_override", sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    product_columns = {column["name"] for column in inspector.get_columns("products")}

    if "planner_model_override" in product_columns:
        op.drop_column("products", "planner_model_override")
    if "planner_mode" in product_columns:
        op.drop_column("products", "planner_mode")
    if "remote_repository_url" in product_columns:
        op.drop_column("products", "remote_repository_url")
    if "local_working_directory" in product_columns:
        op.drop_column("products", "local_working_directory")
