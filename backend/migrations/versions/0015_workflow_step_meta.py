"""workflow step meta: links to what a step created (CRM task / deal ids) for the run history

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-18 23:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0015'
down_revision: str | None = '0014'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("workflow_steps", sa.Column("meta", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("workflow_steps", "meta")
