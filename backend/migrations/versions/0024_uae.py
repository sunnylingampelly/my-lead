"""uae: UAE market. Billing profile TRN and emirate (reverse-charge invoices), the contact-level UAE Do Not
Call Registry flag, and the app-level attestation that the business is UAE-licensed and uploaded its consents
to TDRA's Consent Management System (promotional UAE SMS)

Revision ID: 0024
Revises: 0023
Create Date: 2026-11-25 12:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.models.base

revision: str = '0024'
down_revision: str | None = '0023'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UTC = app.models.base.UTCDateTime


def upgrade() -> None:
    op.add_column('billing_profiles', sa.Column('trn', sa.String(length=15), nullable=True))
    op.add_column('billing_profiles', sa.Column('emirate', sa.String(length=40), nullable=True))
    op.add_column('contacts', sa.Column('dncr_registered', sa.Boolean(), nullable=False, server_default='0'))
    op.add_column('sms_dlt_configurations', sa.Column('uae_attested_by_id', sa.String(length=36), nullable=True))
    op.add_column('sms_dlt_configurations', sa.Column('uae_attested_at', UTC(), nullable=True))
    op.create_foreign_key('fk_sms_dlt_uae_attested_by', 'sms_dlt_configurations', 'users',
                          ['uae_attested_by_id'], ['id'], ondelete='SET NULL')


def downgrade() -> None:
    # MariaDB 1553: drop the foreign key before the column (and the index MariaDB created to back it).
    op.drop_constraint('fk_sms_dlt_uae_attested_by', 'sms_dlt_configurations', type_='foreignkey')
    op.drop_column('sms_dlt_configurations', 'uae_attested_at')
    op.drop_column('sms_dlt_configurations', 'uae_attested_by_id')
    op.drop_column('contacts', 'dncr_registered')
    op.drop_column('billing_profiles', 'emirate')
    op.drop_column('billing_profiles', 'trn')
