"""voice: Signalcraft picks the caller number for every call; numbers are no longer rented

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-19 18:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0019'
down_revision: str | None = '0018'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('voice_calls', sa.Column('from_number', sa.String(length=20), nullable=True))
    # Rented numbers go back to the platform pool; caller IDs created for them stop being used.
    op.execute("UPDATE phone_numbers SET status = 'available', organization_id = NULL, application_id = NULL, "
               "assigned_at = NULL, next_renewal_at = NULL, renewal_failed_at = NULL, released_at = NULL, "
               "available_after = NULL, included = 0 WHERE status IN ('assigned', 'quarantined')")


def downgrade() -> None:
    # Numbers released to the pool stay available (there is no record of who rented them).
    op.drop_column('voice_calls', 'from_number')
