"""Add gateway provider secrets table."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "c4d8e1f7a2b3"
down_revision = "aa4e6b8c1d2f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "gateway_provider_secrets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("gateway_id", sa.Uuid(), nullable=False),
        sa.Column("provider_id", sa.String(), nullable=False),
        sa.Column("purpose", sa.String(), nullable=False),
        sa.Column("alias", sa.String(), nullable=False),
        sa.Column("storage_backend", sa.String(), nullable=False),
        sa.Column("external_key", sa.String(), nullable=True),
        sa.Column("encrypted_value", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["gateway_id"], ["gateways.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "gateway_id",
            "provider_id",
            "purpose",
            name="uq_gateway_provider_secret_scope",
        ),
    )
    op.create_index(
        "ix_gateway_provider_secrets_gateway_id",
        "gateway_provider_secrets",
        ["gateway_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_gateway_provider_secrets_gateway_id", table_name="gateway_provider_secrets")
    op.drop_table("gateway_provider_secrets")
