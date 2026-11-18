"""Normalise legacy timezone names (Asia/Calcutta -> Asia/Kolkata).

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-17
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LEGACY = {"Asia/Calcutta": "Asia/Kolkata", "Asia/Katmandu": "Asia/Kathmandu", "Asia/Saigon": "Asia/Ho_Chi_Minh"}


def upgrade() -> None:
    for table in ("applications", "users", "contacts"):
        t = sa.table(table, sa.column("timezone", sa.String(64)))
        for old, new in LEGACY.items():
            op.execute(sa.update(t).where(t.c.timezone == old).values(timezone=new))


def downgrade() -> None:
    pass  # data normalisation is not reversed
