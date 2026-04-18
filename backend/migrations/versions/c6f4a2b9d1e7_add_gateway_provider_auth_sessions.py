"""Add persisted gateway provider auth session metadata.

Revision ID: c6f4a2b9d1e7
Revises: c4d8e1f7a2b3
Create Date: 2026-04-18 02:45:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "c6f4a2b9d1e7"
down_revision = "c4d8e1f7a2b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Persist active cloud provider auth-helper sessions per gateway."""
    op.add_column("gateways", sa.Column("provider_auth_sessions", sa.JSON(), nullable=True))


def downgrade() -> None:
    """Remove persisted cloud provider auth-helper session metadata."""
    op.drop_column("gateways", "provider_auth_sessions")
