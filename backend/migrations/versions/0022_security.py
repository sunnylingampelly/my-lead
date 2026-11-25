"""security: two-factor authentication (TOTP + hashed recovery codes), org "require 2FA for owners and admins",
the data-subject request log (exports / erasures) and the privacy.manage permission

Revision ID: 0022
Revises: 0021
Create Date: 2026-11-24 19:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.models.base
from app.core.rbac_sync import sync_rbac

revision: str = '0022'
down_revision: str | None = '0021'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UTC = app.models.base.UTCDateTime

_USER_COLUMNS = ('mfa_secret', 'mfa_enabled_at', 'mfa_pending_secret', 'mfa_pending_at', 'mfa_last_step',
                 'mfa_failed_count', 'mfa_locked_until')


def upgrade() -> None:
    op.add_column('users', sa.Column('mfa_secret', sa.String(length=255), nullable=True))
    op.add_column('users', sa.Column('mfa_enabled_at', UTC(), nullable=True))
    op.add_column('users', sa.Column('mfa_pending_secret', sa.String(length=255), nullable=True))
    op.add_column('users', sa.Column('mfa_pending_at', UTC(), nullable=True))
    op.add_column('users', sa.Column('mfa_last_step', sa.BigInteger(), nullable=True))
    op.add_column('users', sa.Column('mfa_failed_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('users', sa.Column('mfa_locked_until', UTC(), nullable=True))
    op.add_column('organizations', sa.Column('require_mfa_admins', sa.Boolean(), nullable=False,
                                             server_default=sa.false()))

    op.create_table(
        'user_recovery_codes',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('code_hash', sa.String(length=64), nullable=False),
        sa.Column('created_at', UTC(), nullable=False),
        sa.Column('used_at', UTC(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_user_recovery_codes_user_id_users'),
                                ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_user_recovery_codes')),
    )
    op.create_index(op.f('ix_user_recovery_codes_user_id'), 'user_recovery_codes', ['user_id'], unique=False)

    op.create_table(
        'data_requests',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('organization_id', sa.String(length=36), nullable=False),
        sa.Column('application_id', sa.String(length=36), nullable=False),
        sa.Column('contact_id', sa.String(length=36), nullable=False),
        sa.Column('kind', sa.String(length=10), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('subject_label', sa.String(length=120), nullable=True),
        sa.Column('requested_by_id', sa.String(length=36), nullable=True),
        sa.Column('details', sa.JSON(), nullable=False),
        sa.Column('created_at', UTC(), nullable=False),
        sa.Column('completed_at', UTC(), nullable=True),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'],
                                name=op.f('fk_data_requests_organization_id_organizations'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['application_id'], ['applications.id'],
                                name=op.f('fk_data_requests_application_id_applications'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['requested_by_id'], ['users.id'],
                                name=op.f('fk_data_requests_requested_by_id_users'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_data_requests')),
    )
    op.create_index('ix_data_requests_org_created', 'data_requests', ['organization_id', 'created_at'], unique=False)
    op.create_index('ix_data_requests_app_contact', 'data_requests', ['application_id', 'contact_id'], unique=False)

    if not op.get_context().as_sql:  # offline SQL generation: run `python -m app.cli sync-rbac` afterwards
        sync_rbac(op.get_bind())


def downgrade() -> None:
    # Dropping a whole table drops its own foreign keys and indexes together (no MariaDB error 1553). The
    # explicit FK-before-index order below is for the reader: never drop an index a foreign key still uses.
    op.drop_constraint(op.f('fk_data_requests_requested_by_id_users'), 'data_requests', type_='foreignkey')
    op.drop_constraint(op.f('fk_data_requests_application_id_applications'), 'data_requests', type_='foreignkey')
    op.drop_constraint(op.f('fk_data_requests_organization_id_organizations'), 'data_requests', type_='foreignkey')
    op.drop_index('ix_data_requests_app_contact', table_name='data_requests')
    op.drop_index('ix_data_requests_org_created', table_name='data_requests')
    op.drop_table('data_requests')
    op.drop_constraint(op.f('fk_user_recovery_codes_user_id_users'), 'user_recovery_codes', type_='foreignkey')
    op.drop_index(op.f('ix_user_recovery_codes_user_id'), table_name='user_recovery_codes')
    op.drop_table('user_recovery_codes')
    op.drop_column('organizations', 'require_mfa_admins')
    for col in reversed(_USER_COLUMNS):
        op.drop_column('users', col)
    op.execute("DELETE FROM role_permissions WHERE permission_key = 'privacy.manage'")
    op.execute("DELETE FROM permissions WHERE `key` = 'privacy.manage'")
