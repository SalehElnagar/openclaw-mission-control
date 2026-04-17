"""Add gateway enabled model refs.

Revision ID: c1a7d4e9b2f3
Revises: b1f0d9a7c8e2
Create Date: 2026-04-17 00:30:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "c1a7d4e9b2f3"
down_revision = "b1f0d9a7c8e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Persist node-enabled model refs for per-node agent selection policy."""
    op.add_column("gateways", sa.Column("enabled_model_refs", sa.JSON(), nullable=True))


def downgrade() -> None:
    """Remove node-enabled model ref policy."""
    op.drop_column("gateways", "enabled_model_refs")
