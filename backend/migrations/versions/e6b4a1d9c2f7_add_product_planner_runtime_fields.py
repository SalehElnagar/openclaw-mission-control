"""Add hidden planner agent fields and product-plan runtime metadata.

Revision ID: e6b4a1d9c2f7
Revises: d2f1c4b6a9e8
Create Date: 2026-04-15 22:15:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "e6b4a1d9c2f7"
down_revision = "d2f1c4b6a9e8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    agent_columns = {column["name"] for column in inspector.get_columns("agents")}
    agent_indexes = {index["name"] for index in inspector.get_indexes("agents")}
    agent_foreign_keys = {foreign_key["name"] for foreign_key in inspector.get_foreign_keys("agents")}

    if "product_id" not in agent_columns:
        op.add_column("agents", sa.Column("product_id", sa.UUID(), nullable=True))
    if "purpose" not in agent_columns:
        op.add_column("agents", sa.Column("purpose", sa.String(), nullable=False, server_default="execution"))
        op.alter_column("agents", "purpose", server_default=None)
    if "hidden" not in agent_columns:
        op.add_column("agents", sa.Column("hidden", sa.Boolean(), nullable=False, server_default=sa.false()))
        op.alter_column("agents", "hidden", server_default=None)
    if "fk_agents_product_id_products" not in agent_foreign_keys:
        op.create_foreign_key(
            "fk_agents_product_id_products",
            "agents",
            "products",
            ["product_id"],
            ["id"],
        )
    if "ix_agents_product_id" not in agent_indexes:
        op.create_index("ix_agents_product_id", "agents", ["product_id"])
    if "ix_agents_purpose" not in agent_indexes:
        op.create_index("ix_agents_purpose", "agents", ["purpose"])
    if "ix_agents_hidden" not in agent_indexes:
        op.create_index("ix_agents_hidden", "agents", ["hidden"])

    plan_columns = {column["name"] for column in inspector.get_columns("product_plans")}
    plan_indexes = {index["name"] for index in inspector.get_indexes("product_plans")}
    plan_foreign_keys = {foreign_key["name"] for foreign_key in inspector.get_foreign_keys("product_plans")}

    if "planner_agent_id" not in plan_columns:
        op.add_column("product_plans", sa.Column("planner_agent_id", sa.UUID(), nullable=True))
    if "planner_session_key" not in plan_columns:
        op.add_column("product_plans", sa.Column("planner_session_key", sa.Text(), nullable=True))
    if "planner_model_ref" not in plan_columns:
        op.add_column("product_plans", sa.Column("planner_model_ref", sa.Text(), nullable=True))
    if "planner_status" not in plan_columns:
        op.add_column("product_plans", sa.Column("planner_status", sa.String(), nullable=True))
    if "planner_status_reason" not in plan_columns:
        op.add_column("product_plans", sa.Column("planner_status_reason", sa.Text(), nullable=True))
    if "planner_last_escalation_reason" not in plan_columns:
        op.add_column("product_plans", sa.Column("planner_last_escalation_reason", sa.Text(), nullable=True))
    if "unresolved_question_keys" not in plan_columns:
        op.add_column("product_plans", sa.Column("unresolved_question_keys", sa.JSON(), nullable=True))
    if "completeness" not in plan_columns:
        op.add_column("product_plans", sa.Column("completeness", sa.JSON(), nullable=True))
    if "fk_product_plans_planner_agent_id_agents" not in plan_foreign_keys:
        op.create_foreign_key(
            "fk_product_plans_planner_agent_id_agents",
            "product_plans",
            "agents",
            ["planner_agent_id"],
            ["id"],
        )
    if "ix_product_plans_planner_agent_id" not in plan_indexes:
        op.create_index("ix_product_plans_planner_agent_id", "product_plans", ["planner_agent_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    plan_columns = {column["name"] for column in inspector.get_columns("product_plans")}
    plan_indexes = {index["name"] for index in inspector.get_indexes("product_plans")}
    plan_foreign_keys = {foreign_key["name"] for foreign_key in inspector.get_foreign_keys("product_plans")}

    if "ix_product_plans_planner_agent_id" in plan_indexes:
        op.drop_index("ix_product_plans_planner_agent_id", table_name="product_plans")
    if "fk_product_plans_planner_agent_id_agents" in plan_foreign_keys:
        op.drop_constraint(
            "fk_product_plans_planner_agent_id_agents",
            "product_plans",
            type_="foreignkey",
        )
    for column_name in (
        "completeness",
        "unresolved_question_keys",
        "planner_last_escalation_reason",
        "planner_status_reason",
        "planner_status",
        "planner_model_ref",
        "planner_session_key",
        "planner_agent_id",
    ):
        if column_name in plan_columns:
            op.drop_column("product_plans", column_name)

    agent_columns = {column["name"] for column in inspector.get_columns("agents")}
    agent_indexes = {index["name"] for index in inspector.get_indexes("agents")}
    agent_foreign_keys = {foreign_key["name"] for foreign_key in inspector.get_foreign_keys("agents")}

    if "ix_agents_hidden" in agent_indexes:
        op.drop_index("ix_agents_hidden", table_name="agents")
    if "ix_agents_purpose" in agent_indexes:
        op.drop_index("ix_agents_purpose", table_name="agents")
    if "ix_agents_product_id" in agent_indexes:
        op.drop_index("ix_agents_product_id", table_name="agents")
    if "fk_agents_product_id_products" in agent_foreign_keys:
        op.drop_constraint("fk_agents_product_id_products", "agents", type_="foreignkey")
    for column_name in ("hidden", "purpose", "product_id"):
        if column_name in agent_columns:
            op.drop_column("agents", column_name)
