"""plans: one subscription per organization (Starter when there is no row)

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-19 12:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.models.base

revision: str = '0017'
down_revision: str | None = '0016'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'subscriptions',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('organization_id', sa.String(length=36), nullable=False),
        sa.Column('plan', sa.String(length=20), nullable=False, server_default='starter'),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='active'),
        sa.Column('current_period_start', app.models.base.UTCDateTime(), nullable=True),
        sa.Column('current_period_end', app.models.base.UTCDateTime(), nullable=True),
        sa.Column('scheduled_plan', sa.String(length=20), nullable=True),
        sa.Column('cancel_at_period_end', sa.Boolean(), nullable=False, server_default='0'),
        sa.Column('past_due_since', app.models.base.UTCDateTime(), nullable=True),
        sa.Column('created_at', app.models.base.UTCDateTime(), nullable=False),
        sa.Column('updated_at', app.models.base.UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'],
                                name=op.f('fk_subscriptions_organization_id_organizations'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_subscriptions')),
        sa.UniqueConstraint('organization_id', name=op.f('uq_subscriptions_organization_id')),
    )
    op.create_index('ix_subscriptions_status_period_end', 'subscriptions', ['status', 'current_period_end'])


def downgrade() -> None:
    # MySQL: drop the foreign key before the unique index it relies on (error 1553), then the table.
    op.drop_constraint(op.f('fk_subscriptions_organization_id_organizations'), 'subscriptions', type_='foreignkey')
    op.drop_index('ix_subscriptions_status_period_end', table_name='subscriptions')
    op.drop_table('subscriptions')
