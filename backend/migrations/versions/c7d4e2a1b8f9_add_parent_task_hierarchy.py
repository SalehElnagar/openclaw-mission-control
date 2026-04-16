"""Add parent task hierarchy column and index.

Revision ID: c7d4e2a1b8f9
Revises: f9a7c6e5d4b3
Create Date: 2026-04-13 05:15:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "c7d4e2a1b8f9"
down_revision = "f9a7c6e5d4b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Persist optional parent/child task relationships."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    task_columns = {column["name"] for column in inspector.get_columns("tasks")}
    foreign_keys = {foreign_key["name"] for foreign_key in inspector.get_foreign_keys("tasks")}
    indexes = {index["name"] for index in inspector.get_indexes("tasks")}

    if "parent_task_id" not in task_columns:
        op.add_column("tasks", sa.Column("parent_task_id", sa.UUID(), nullable=True))
    if "fk_tasks_parent_task_id_tasks" not in foreign_keys:
        op.create_foreign_key(
            "fk_tasks_parent_task_id_tasks",
            "tasks",
            "tasks",
            ["parent_task_id"],
            ["id"],
        )
    if "ix_tasks_parent_task_id" not in indexes:
        op.create_index("ix_tasks_parent_task_id", "tasks", ["parent_task_id"])


def downgrade() -> None:
    """Remove persisted parent/child task relationships."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    task_columns = {column["name"] for column in inspector.get_columns("tasks")}
    foreign_keys = {foreign_key["name"] for foreign_key in inspector.get_foreign_keys("tasks")}
    indexes = {index["name"] for index in inspector.get_indexes("tasks")}

    if "ix_tasks_parent_task_id" in indexes:
        op.drop_index("ix_tasks_parent_task_id", table_name="tasks")
    if "fk_tasks_parent_task_id_tasks" in foreign_keys:
        op.drop_constraint("fk_tasks_parent_task_id_tasks", "tasks", type_="foreignkey")
    if "parent_task_id" in task_columns:
        op.drop_column("tasks", "parent_task_id")
