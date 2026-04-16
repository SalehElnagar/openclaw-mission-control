"""Add gateway runtime policy, audit detail, and usage telemetry storage.

Revision ID: f9a7c6e5d4b3
Revises: a1e6b0d62f0c, a9b1c2d3e4f7, b6f4c7d9e1a2, f4d2b649e93a
Create Date: 2026-04-13 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "f9a7c6e5d4b3"
down_revision = ("a1e6b0d62f0c", "a9b1c2d3e4f7", "b6f4c7d9e1a2", "f4d2b649e93a")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Persist runtime model policy, audit metadata, and usage samples."""
    op.add_column(
        "gateways",
        sa.Column("default_model_profile", sa.String(), nullable=False, server_default="general"),
    )
    op.add_column("gateways", sa.Column("model_profiles", sa.JSON(), nullable=True))
    op.add_column(
        "gateways",
        sa.Column("runtime_sync_generation", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("gateways", sa.Column("last_runtime_sync_at", sa.DateTime(), nullable=True))
    op.add_column("gateways", sa.Column("last_runtime_sync_error", sa.Text(), nullable=True))
    op.add_column(
        "gateways", sa.Column("last_telemetry_collected_at", sa.DateTime(), nullable=True)
    )
    op.alter_column("gateways", "default_model_profile", server_default=None)
    op.alter_column("gateways", "runtime_sync_generation", server_default=None)

    op.add_column("agents", sa.Column("model_profile", sa.String(), nullable=True))
    op.add_column("agents", sa.Column("model_primary", sa.String(), nullable=True))
    op.add_column(
        "agents",
        sa.Column("model_fallback_policy", sa.String(), nullable=False, server_default="profile"),
    )
    op.add_column("agents", sa.Column("model_fallbacks", sa.JSON(), nullable=True))
    op.add_column("agents", sa.Column("last_runtime_sync_at", sa.DateTime(), nullable=True))
    op.create_index("ix_agents_model_profile", "agents", ["model_profile"])
    op.create_index("ix_agents_model_primary", "agents", ["model_primary"])
    op.create_index("ix_agents_model_fallback_policy", "agents", ["model_fallback_policy"])
    op.alter_column("agents", "model_fallback_policy", server_default=None)

    op.add_column("activity_events", sa.Column("actor_type", sa.String(), nullable=True))
    op.add_column("activity_events", sa.Column("actor_user_id", sa.UUID(), nullable=True))
    op.add_column("activity_events", sa.Column("actor_label", sa.Text(), nullable=True))
    op.add_column("activity_events", sa.Column("entity_type", sa.String(), nullable=True))
    op.add_column("activity_events", sa.Column("entity_id", sa.Text(), nullable=True))
    op.add_column("activity_events", sa.Column("previous_values", sa.JSON(), nullable=True))
    op.add_column("activity_events", sa.Column("new_values", sa.JSON(), nullable=True))
    op.add_column("activity_events", sa.Column("details", sa.JSON(), nullable=True))
    op.create_index("ix_activity_events_actor_type", "activity_events", ["actor_type"])
    op.create_index("ix_activity_events_actor_user_id", "activity_events", ["actor_user_id"])
    op.create_index("ix_activity_events_entity_type", "activity_events", ["entity_type"])
    op.create_index("ix_activity_events_entity_id", "activity_events", ["entity_id"])
    op.create_foreign_key(
        "fk_activity_events_actor_user_id_users",
        "activity_events",
        "users",
        ["actor_user_id"],
        ["id"],
    )

    op.create_table(
        "gateway_usage_samples",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("gateway_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.UUID(), nullable=True),
        sa.Column("agent_id", sa.UUID(), nullable=True),
        sa.Column("task_id", sa.UUID(), nullable=True),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("model", sa.String(), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Float(), nullable=False, server_default="0"),
        sa.Column("currency", sa.String(), nullable=False, server_default="USD"),
        sa.Column("window_started_at", sa.DateTime(), nullable=True),
        sa.Column("window_ended_at", sa.DateTime(), nullable=True),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("ingestion_note", sa.Text(), nullable=True),
        sa.Column("recorded_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["gateway_id"], ["gateways.id"]),
        sa.ForeignKeyConstraint(["board_id"], ["boards.id"]),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"]),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_gateway_usage_samples_organization_id", "gateway_usage_samples", ["organization_id"]
    )
    op.create_index("ix_gateway_usage_samples_gateway_id", "gateway_usage_samples", ["gateway_id"])
    op.create_index("ix_gateway_usage_samples_board_id", "gateway_usage_samples", ["board_id"])
    op.create_index("ix_gateway_usage_samples_agent_id", "gateway_usage_samples", ["agent_id"])
    op.create_index("ix_gateway_usage_samples_task_id", "gateway_usage_samples", ["task_id"])
    op.create_index("ix_gateway_usage_samples_source", "gateway_usage_samples", ["source"])
    op.create_index("ix_gateway_usage_samples_model", "gateway_usage_samples", ["model"])
    op.create_index(
        "ix_gateway_usage_samples_recorded_at", "gateway_usage_samples", ["recorded_at"]
    )
    op.alter_column("gateway_usage_samples", "prompt_tokens", server_default=None)
    op.alter_column("gateway_usage_samples", "completion_tokens", server_default=None)
    op.alter_column("gateway_usage_samples", "total_tokens", server_default=None)
    op.alter_column("gateway_usage_samples", "cost_usd", server_default=None)
    op.alter_column("gateway_usage_samples", "currency", server_default=None)


def downgrade() -> None:
    """Remove runtime policy, audit metadata, and usage storage."""
    op.drop_index("ix_gateway_usage_samples_recorded_at", table_name="gateway_usage_samples")
    op.drop_index("ix_gateway_usage_samples_model", table_name="gateway_usage_samples")
    op.drop_index("ix_gateway_usage_samples_source", table_name="gateway_usage_samples")
    op.drop_index("ix_gateway_usage_samples_task_id", table_name="gateway_usage_samples")
    op.drop_index("ix_gateway_usage_samples_agent_id", table_name="gateway_usage_samples")
    op.drop_index("ix_gateway_usage_samples_board_id", table_name="gateway_usage_samples")
    op.drop_index("ix_gateway_usage_samples_gateway_id", table_name="gateway_usage_samples")
    op.drop_index("ix_gateway_usage_samples_organization_id", table_name="gateway_usage_samples")
    op.drop_table("gateway_usage_samples")

    op.drop_constraint(
        "fk_activity_events_actor_user_id_users", "activity_events", type_="foreignkey"
    )
    op.drop_index("ix_activity_events_entity_id", table_name="activity_events")
    op.drop_index("ix_activity_events_entity_type", table_name="activity_events")
    op.drop_index("ix_activity_events_actor_user_id", table_name="activity_events")
    op.drop_index("ix_activity_events_actor_type", table_name="activity_events")
    op.drop_column("activity_events", "details")
    op.drop_column("activity_events", "new_values")
    op.drop_column("activity_events", "previous_values")
    op.drop_column("activity_events", "entity_id")
    op.drop_column("activity_events", "entity_type")
    op.drop_column("activity_events", "actor_label")
    op.drop_column("activity_events", "actor_user_id")
    op.drop_column("activity_events", "actor_type")

    op.drop_index("ix_agents_model_fallback_policy", table_name="agents")
    op.drop_index("ix_agents_model_primary", table_name="agents")
    op.drop_index("ix_agents_model_profile", table_name="agents")
    op.drop_column("agents", "last_runtime_sync_at")
    op.drop_column("agents", "model_fallbacks")
    op.drop_column("agents", "model_fallback_policy")
    op.drop_column("agents", "model_primary")
    op.drop_column("agents", "model_profile")

    op.drop_column("gateways", "last_telemetry_collected_at")
    op.drop_column("gateways", "last_runtime_sync_error")
    op.drop_column("gateways", "last_runtime_sync_at")
    op.drop_column("gateways", "runtime_sync_generation")
    op.drop_column("gateways", "model_profiles")
    op.drop_column("gateways", "default_model_profile")
