"""Add products, product chat/plans, and board-group product linkage.

Revision ID: d2f1c4b6a9e8
Revises: c7d4e2a1b8f9
Create Date: 2026-04-15 15:45:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "d2f1c4b6a9e8"
down_revision = "c7d4e2a1b8f9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Persist products, product plans, product messages, and service linkage."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if "products" not in existing_tables:
        op.create_table(
            "products",
            sa.Column("id", sa.UUID(), nullable=False),
            sa.Column("organization_id", sa.UUID(), nullable=False),
            sa.Column("default_gateway_id", sa.UUID(), nullable=True),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("slug", sa.String(), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("status", sa.String(), nullable=False, server_default="draft"),
            sa.Column("optimize_for", sa.String(), nullable=False, server_default="balanced"),
            sa.Column("daily_budget_cap_usd", sa.Float(), nullable=True),
            sa.Column("total_budget_cap_usd", sa.Float(), nullable=True),
            sa.Column("execution_policy", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
            sa.ForeignKeyConstraint(["default_gateway_id"], ["gateways.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_products_organization_id", "products", ["organization_id"])
        op.create_index("ix_products_default_gateway_id", "products", ["default_gateway_id"])
        op.create_index("ix_products_slug", "products", ["slug"])
        op.create_index("ix_products_status", "products", ["status"])
        op.alter_column("products", "status", server_default=None)
        op.alter_column("products", "optimize_for", server_default=None)

    if "product_messages" not in existing_tables:
        op.create_table(
            "product_messages",
            sa.Column("id", sa.UUID(), nullable=False),
            sa.Column("product_id", sa.UUID(), nullable=False),
            sa.Column("role", sa.String(), nullable=False, server_default="user"),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("meta", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_product_messages_product_id", "product_messages", ["product_id"])
        op.create_index("ix_product_messages_role", "product_messages", ["role"])
        op.alter_column("product_messages", "role", server_default=None)

    if "product_plans" not in existing_tables:
        op.create_table(
            "product_plans",
            sa.Column("id", sa.UUID(), nullable=False),
            sa.Column("product_id", sa.UUID(), nullable=False),
            sa.Column("approved_by_user_id", sa.UUID(), nullable=True),
            sa.Column("status", sa.String(), nullable=False, server_default="draft"),
            sa.Column("intake_summary", sa.Text(), nullable=True),
            sa.Column("objective", sa.Text(), nullable=True),
            sa.Column("target_audience", sa.Text(), nullable=True),
            sa.Column("scope", sa.Text(), nullable=True),
            sa.Column("exclusions", sa.Text(), nullable=True),
            sa.Column("missing_questions", sa.JSON(), nullable=True),
            sa.Column("proposed_services", sa.JSON(), nullable=True),
            sa.Column("initial_epics", sa.JSON(), nullable=True),
            sa.Column("role_assignments", sa.JSON(), nullable=True),
            sa.Column("model_recommendations", sa.JSON(), nullable=True),
            sa.Column("estimated_daily_budget_usd", sa.Float(), nullable=True),
            sa.Column("estimated_total_budget_usd", sa.Float(), nullable=True),
            sa.Column("budget_posture", sa.String(), nullable=True),
            sa.Column("budget_warnings", sa.JSON(), nullable=True),
            sa.Column("last_message_at", sa.DateTime(), nullable=True),
            sa.Column("approved_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
            sa.ForeignKeyConstraint(["approved_by_user_id"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("product_id"),
        )
        op.create_index("ix_product_plans_product_id", "product_plans", ["product_id"])
        op.create_index("ix_product_plans_status", "product_plans", ["status"])
        op.alter_column("product_plans", "status", server_default=None)

    board_group_columns = {column["name"] for column in inspector.get_columns("board_groups")}
    board_group_foreign_keys = {
        foreign_key["name"] for foreign_key in inspector.get_foreign_keys("board_groups")
    }
    board_group_indexes = {index["name"] for index in inspector.get_indexes("board_groups")}
    if "product_id" not in board_group_columns:
        op.add_column("board_groups", sa.Column("product_id", sa.UUID(), nullable=True))
    if "fk_board_groups_product_id_products" not in board_group_foreign_keys:
        op.create_foreign_key(
            "fk_board_groups_product_id_products",
            "board_groups",
            "products",
            ["product_id"],
            ["id"],
        )
    if "ix_board_groups_product_id" not in board_group_indexes:
        op.create_index("ix_board_groups_product_id", "board_groups", ["product_id"])


def downgrade() -> None:
    """Remove product planning storage and service linkage."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if "board_groups" in existing_tables:
        board_group_columns = {column["name"] for column in inspector.get_columns("board_groups")}
        board_group_foreign_keys = {
            foreign_key["name"] for foreign_key in inspector.get_foreign_keys("board_groups")
        }
        board_group_indexes = {index["name"] for index in inspector.get_indexes("board_groups")}
        if "ix_board_groups_product_id" in board_group_indexes:
            op.drop_index("ix_board_groups_product_id", table_name="board_groups")
        if "fk_board_groups_product_id_products" in board_group_foreign_keys:
            op.drop_constraint(
                "fk_board_groups_product_id_products",
                "board_groups",
                type_="foreignkey",
            )
        if "product_id" in board_group_columns:
            op.drop_column("board_groups", "product_id")

    if "product_plans" in existing_tables:
        op.drop_index("ix_product_plans_status", table_name="product_plans")
        op.drop_index("ix_product_plans_product_id", table_name="product_plans")
        op.drop_table("product_plans")
    if "product_messages" in existing_tables:
        op.drop_index("ix_product_messages_role", table_name="product_messages")
        op.drop_index("ix_product_messages_product_id", table_name="product_messages")
        op.drop_table("product_messages")
    if "products" in existing_tables:
        op.drop_index("ix_products_status", table_name="products")
        op.drop_index("ix_products_slug", table_name="products")
        op.drop_index("ix_products_default_gateway_id", table_name="products")
        op.drop_index("ix_products_organization_id", table_name="products")
        op.drop_table("products")
