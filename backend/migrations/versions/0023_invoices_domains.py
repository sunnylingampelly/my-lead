"""invoices and domains: GST tax on wallet top-ups (payments.tax_amount / gross_amount), organization billing
profiles, gap-free invoice sequences per financial year, immutable tax invoices / credit notes, and cached
sender-domain DNS authentication checks

Revision ID: 0023
Revises: 0022
Create Date: 2026-11-24 21:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.models.base

revision: str = '0023'
down_revision: str | None = '0022'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UTC = app.models.base.UTCDateTime


def upgrade() -> None:
    op.add_column('payments', sa.Column('tax_amount', sa.Numeric(precision=12, scale=2), nullable=False,
                                        server_default='0'))
    op.add_column('payments', sa.Column('gross_amount', sa.Numeric(precision=12, scale=2), nullable=True))

    op.create_table(
        'billing_profiles',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('organization_id', sa.String(length=36), nullable=False),
        sa.Column('legal_name', sa.String(length=200), nullable=False),
        sa.Column('gstin', sa.String(length=15), nullable=True),
        sa.Column('address', sa.String(length=500), nullable=False),
        sa.Column('city', sa.String(length=100), nullable=True),
        sa.Column('state_code', sa.String(length=2), nullable=True),
        sa.Column('pin_code', sa.String(length=10), nullable=True),
        sa.Column('country', sa.String(length=2), nullable=False),
        sa.Column('email', sa.String(length=320), nullable=False),
        sa.Column('updated_by_id', sa.String(length=36), nullable=True),
        sa.Column('created_at', UTC(), nullable=False),
        sa.Column('updated_at', UTC(), nullable=False),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'],
                                name=op.f('fk_billing_profiles_organization_id_organizations'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['updated_by_id'], ['users.id'],
                                name=op.f('fk_billing_profiles_updated_by_id_users'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_billing_profiles')),
        sa.UniqueConstraint('organization_id', name=op.f('uq_billing_profiles_organization_id')),
    )

    op.create_table(
        'invoice_sequences',
        sa.Column('series', sa.String(length=12), nullable=False),
        sa.Column('financial_year', sa.String(length=7), nullable=False),
        sa.Column('last_number', sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint('series', 'financial_year', name=op.f('pk_invoice_sequences')),
    )

    op.create_table(
        'invoices',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('organization_id', sa.String(length=36), nullable=True),
        sa.Column('payment_id', sa.String(length=36), nullable=True),
        sa.Column('doc_type', sa.String(length=12), nullable=False),
        sa.Column('original_invoice_id', sa.String(length=36), nullable=True),
        sa.Column('number', sa.String(length=20), nullable=False),
        sa.Column('financial_year', sa.String(length=7), nullable=False),
        sa.Column('sequence', sa.Integer(), nullable=False),
        sa.Column('issued_at', UTC(), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('tax_treatment', sa.String(length=12), nullable=False),
        sa.Column('place_of_supply', sa.String(length=80), nullable=False),
        sa.Column('sac', sa.String(length=10), nullable=False),
        sa.Column('description', sa.String(length=255), nullable=False),
        sa.Column('taxable_value', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column('gst_rate', sa.Numeric(precision=5, scale=2), nullable=False),
        sa.Column('cgst', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column('sgst', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column('igst', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column('total', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column('seller', sa.JSON(), nullable=False),
        sa.Column('buyer', sa.JSON(), nullable=False),
        sa.Column('payment_reference', sa.String(length=160), nullable=True),
        sa.Column('emailed_at', UTC(), nullable=True),
        sa.Column('created_at', UTC(), nullable=False),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'],
                                name=op.f('fk_invoices_organization_id_organizations'), ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['payment_id'], ['payments.id'],
                                name=op.f('fk_invoices_payment_id_payments'), ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['original_invoice_id'], ['invoices.id'],
                                name=op.f('fk_invoices_original_invoice_id_invoices'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_invoices')),
        sa.UniqueConstraint('number', name='uq_invoices_number'),
        sa.UniqueConstraint('payment_id', 'doc_type', name='uq_invoices_payment_doc'),
    )
    op.create_index('ix_invoices_org_issued', 'invoices', ['organization_id', 'issued_at'], unique=False)

    op.create_table(
        'email_domain_checks',
        sa.Column('domain', sa.String(length=253), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('results', sa.JSON(), nullable=False),
        sa.Column('checked_at', UTC(), nullable=False),
        sa.PrimaryKeyConstraint('domain', name=op.f('pk_email_domain_checks')),
    )


def downgrade() -> None:
    # Dropping a table drops its own foreign keys and indexes (MariaDB error 1553 only arises when an index
    # backing a foreign key is dropped on its own), so whole tables go, child-first.
    op.drop_table('email_domain_checks')
    op.drop_table('invoices')
    op.drop_table('invoice_sequences')
    op.drop_table('billing_profiles')
    op.drop_column('payments', 'gross_amount')
    op.drop_column('payments', 'tax_amount')
