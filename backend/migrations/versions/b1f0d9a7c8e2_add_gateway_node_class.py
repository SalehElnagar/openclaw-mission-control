"""Add gateway node classification.

Revision ID: b1f0d9a7c8e2
Revises: a4d9c2e1f7b6
Create Date: 2026-04-17 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "b1f0d9a7c8e2"
down_revision = "a4d9c2e1f7b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Persist gateway node class for cloud/local gateway routing."""
    op.add_column(
        "gateways",
        sa.Column("node_class", sa.String(), nullable=False, server_default="cloud"),
    )
    op.create_index("ix_gateways_node_class", "gateways", ["node_class"])
    op.alter_column("gateways", "node_class", server_default=None)


def downgrade() -> None:
    """Remove gateway node class."""
    op.drop_index("ix_gateways_node_class", table_name="gateways")
    op.drop_column("gateways", "node_class")
