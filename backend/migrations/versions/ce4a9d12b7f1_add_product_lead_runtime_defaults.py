"""Add product lead runtime defaults.

Revision ID: ce4a9d12b7f1
Revises: b1f0d9a7c8e2
Create Date: 2026-04-17 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "ce4a9d12b7f1"
down_revision = "c1a7d4e9b2f3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Persist product-level lead runtime defaults."""
    op.add_column("products", sa.Column("lead_runtime_defaults", sa.JSON(), nullable=True))


def downgrade() -> None:
    """Remove product-level lead runtime defaults."""
    op.drop_column("products", "lead_runtime_defaults")
