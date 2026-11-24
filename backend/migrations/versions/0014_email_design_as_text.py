"""email design as text: the visual editor's design JSON can nest deeper than MariaDB's JSON check
allows (32 levels), so store it as LONGTEXT and (de)serialise in the application

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-18 21:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision: str = '0014'
down_revision: str | None = '0013'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = ("email_templates", "email_campaigns")


def upgrade() -> None:
    # MODIFY replaces the column definition, which drops MariaDB's json_valid CHECK on it.
    for table in TABLES:
        op.alter_column(table, "design", existing_type=sa.JSON(), type_=mysql.LONGTEXT(), existing_nullable=True)


def downgrade() -> None:
    for table in TABLES:
        op.alter_column(table, "design", existing_type=mysql.LONGTEXT(), type_=sa.JSON(), existing_nullable=True)
