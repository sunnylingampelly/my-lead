"""lead forms: forms, published versions, submissions and daily stats; forms.read / forms.write permissions

Revision ID: 0020
Revises: 0019
Create Date: 2026-11-24 10:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.models.base

revision: str = '0020'
down_revision: str | None = '0019'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _ts(name: str, nullable: bool = False) -> sa.Column:
    return sa.Column(name, app.models.base.UTCDateTime(), nullable=nullable)


def upgrade() -> None:
    op.create_table(
        'lead_forms',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('public_id', sa.String(length=24), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('template', sa.String(length=40), nullable=True),
        sa.Column('status', sa.String(length=12), nullable=False),
        sa.Column('draft', app.models.base.JSONText(), nullable=False),
        sa.Column('published', app.models.base.JSONText(), nullable=True),
        sa.Column('published_version', sa.Integer(), nullable=True),
        _ts('published_at', True),
        _ts('last_submission_at', True),
        sa.Column('created_by_id', sa.String(length=36), nullable=True),
        sa.Column('organization_id', sa.String(length=36), nullable=False),
        sa.Column('application_id', sa.String(length=36), nullable=False),
        _ts('created_at'),
        _ts('updated_at'),
        sa.ForeignKeyConstraint(['application_id'], ['applications.id'],
                                name=op.f('fk_lead_forms_application_id_applications'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'],
                                name=op.f('fk_lead_forms_created_by_id_users'), ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'],
                                name=op.f('fk_lead_forms_organization_id_organizations'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_lead_forms')),
        sa.UniqueConstraint('public_id', name='uq_lead_forms_public_id'),
    )
    op.create_index('ix_lead_forms_app_updated', 'lead_forms', ['application_id', 'updated_at'], unique=False)

    op.create_table(
        'lead_form_versions',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('form_id', sa.String(length=36), nullable=False),
        sa.Column('application_id', sa.String(length=36), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('definition', app.models.base.JSONText(), nullable=False),
        sa.Column('published_by_id', sa.String(length=36), nullable=True),
        _ts('created_at'),
        sa.ForeignKeyConstraint(['application_id'], ['applications.id'],
                                name=op.f('fk_lead_form_versions_application_id_applications'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['form_id'], ['lead_forms.id'],
                                name=op.f('fk_lead_form_versions_form_id_lead_forms'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['published_by_id'], ['users.id'],
                                name=op.f('fk_lead_form_versions_published_by_id_users'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_lead_form_versions')),
        sa.UniqueConstraint('form_id', 'version', name='uq_lead_form_versions_form_version'),
    )

    op.create_table(
        'lead_form_submissions',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('form_id', sa.String(length=36), nullable=False),
        sa.Column('form_version', sa.Integer(), nullable=False),
        sa.Column('client_id', sa.String(length=64), nullable=False),
        sa.Column('contact_id', sa.String(length=36), nullable=True),
        sa.Column('deal_id', sa.String(length=36), nullable=True),
        sa.Column('status', sa.String(length=24), nullable=False),
        sa.Column('spam_reason', sa.String(length=40), nullable=True),
        sa.Column('values', app.models.base.JSONText(), nullable=False),
        sa.Column('page_url', sa.String(length=1000), nullable=True),
        sa.Column('referrer', sa.String(length=1000), nullable=True),
        sa.Column('utm', sa.JSON(), nullable=False),
        sa.Column('ip_hash', sa.String(length=64), nullable=True),
        sa.Column('country', sa.String(length=2), nullable=True),
        sa.Column('user_agent', sa.String(length=400), nullable=True),
        _ts('confirmed_at', True),
        _ts('created_at'),
        sa.Column('organization_id', sa.String(length=36), nullable=False),
        sa.Column('application_id', sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(['application_id'], ['applications.id'],
                                name=op.f('fk_lead_form_submissions_application_id_applications'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['contact_id'], ['contacts.id'],
                                name=op.f('fk_lead_form_submissions_contact_id_contacts'), ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['form_id'], ['lead_forms.id'],
                                name=op.f('fk_lead_form_submissions_form_id_lead_forms'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'],
                                name=op.f('fk_lead_form_submissions_organization_id_organizations'),
                                ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_lead_form_submissions')),
        sa.UniqueConstraint('form_id', 'client_id', name='uq_lead_form_submissions_form_client'),
    )
    op.create_index('ix_lead_form_submissions_form_created', 'lead_form_submissions', ['form_id', 'created_at'],
                    unique=False)
    op.create_index('ix_lead_form_submissions_app_created', 'lead_form_submissions',
                    ['application_id', 'created_at'], unique=False)
    op.create_index('ix_lead_form_submissions_contact', 'lead_form_submissions', ['contact_id'], unique=False)

    op.create_table(
        'lead_form_daily_stats',
        sa.Column('form_id', sa.String(length=36), nullable=False),
        sa.Column('day', sa.Date(), nullable=False),
        sa.Column('application_id', sa.String(length=36), nullable=False),
        sa.Column('views', sa.Integer(), nullable=False),
        sa.Column('starts', sa.Integer(), nullable=False),
        sa.Column('submissions', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['application_id'], ['applications.id'],
                                name=op.f('fk_lead_form_daily_stats_application_id_applications'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['form_id'], ['lead_forms.id'],
                                name=op.f('fk_lead_form_daily_stats_form_id_lead_forms'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('form_id', 'day', name=op.f('pk_lead_form_daily_stats')),
    )
    op.create_index('ix_lead_form_daily_stats_app_day', 'lead_form_daily_stats', ['application_id', 'day'],
                    unique=False)

    if not op.get_context().as_sql:  # offline SQL: run `python -m app.cli sync-rbac` afterwards
        from app.core.rbac_sync import sync_rbac

        sync_rbac(op.get_bind())


def downgrade() -> None:
    # Whole tables are dropped, which removes their foreign keys and indexes with them (no MariaDB 1553).
    op.drop_table('lead_form_daily_stats')
    op.drop_table('lead_form_submissions')
    op.drop_table('lead_form_versions')
    op.drop_table('lead_forms')
    op.execute("DELETE FROM role_permissions WHERE permission_key IN ('forms.read', 'forms.write')")
    op.execute("DELETE FROM permissions WHERE `key` IN ('forms.read', 'forms.write')")
