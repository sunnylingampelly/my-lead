"""voice: platform phone number pool, AI calling agents, AI call results

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-19 14:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

import app.models.base

revision: str = '0018'
down_revision: str | None = '0017'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UTC = app.models.base.UTCDateTime
JSONText = app.models.base.JSONText


def upgrade() -> None:
    op.create_table(
        'phone_numbers',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('number', sa.String(length=20), nullable=False),
        sa.Column('country', sa.String(length=2), nullable=False),
        sa.Column('kind', sa.String(length=20), nullable=False),
        sa.Column('provider', sa.String(length=20), nullable=False),
        sa.Column('provider_ref', sa.String(length=128), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('organization_id', sa.String(length=36), nullable=True),
        sa.Column('application_id', sa.String(length=36), nullable=True),
        sa.Column('assigned_at', UTC(), nullable=True),
        sa.Column('next_renewal_at', UTC(), nullable=True),
        sa.Column('renewal_failed_at', UTC(), nullable=True),
        sa.Column('released_at', UTC(), nullable=True),
        sa.Column('available_after', UTC(), nullable=True),
        sa.Column('monthly_price', sa.Numeric(precision=12, scale=4), nullable=True),
        sa.Column('currency', sa.String(length=3), nullable=True),
        sa.Column('included', sa.Boolean(), nullable=False),
        sa.Column('created_at', UTC(), nullable=False),
        sa.Column('updated_at', UTC(), nullable=False),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'],
                                name=op.f('fk_phone_numbers_organization_id_organizations'), ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['application_id'], ['applications.id'],
                                name=op.f('fk_phone_numbers_application_id_applications'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_phone_numbers')),
        sa.UniqueConstraint('number', name=op.f('uq_phone_numbers_number')),
    )
    op.create_index('ix_phone_numbers_pool', 'phone_numbers', ['status', 'country', 'kind'])
    op.create_index('ix_phone_numbers_renewal', 'phone_numbers', ['status', 'next_renewal_at'])
    op.create_index(op.f('ix_phone_numbers_organization_id'), 'phone_numbers', ['organization_id'])
    op.create_index(op.f('ix_phone_numbers_application_id'), 'phone_numbers', ['application_id'])

    op.create_table(
        'voice_agents',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('organization_id', sa.String(length=36), nullable=False),
        sa.Column('application_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('template', sa.String(length=40), nullable=True),
        sa.Column('language', sa.String(length=10), nullable=False),
        sa.Column('voice', sa.String(length=10), nullable=False),
        sa.Column('goal', sa.String(length=300), nullable=True),
        sa.Column('greeting', sa.String(length=500), nullable=False),
        sa.Column('instructions', sa.Text(), nullable=False),
        sa.Column('knowledge', sa.Text().with_variant(mysql.LONGTEXT(), 'mysql'), nullable=True),
        sa.Column('outcome_fields', JSONText(), nullable=False),
        sa.Column('transfer_number', sa.String(length=20), nullable=True),
        sa.Column('max_call_minutes', sa.Integer(), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('created_by_id', sa.String(length=36), nullable=True),
        sa.Column('created_at', UTC(), nullable=False),
        sa.Column('updated_at', UTC(), nullable=False),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'],
                                name=op.f('fk_voice_agents_organization_id_organizations'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['application_id'], ['applications.id'],
                                name=op.f('fk_voice_agents_application_id_applications'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'],
                                name=op.f('fk_voice_agents_created_by_id_users'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_voice_agents')),
    )
    op.create_index('ix_voice_agents_app_status', 'voice_agents', ['application_id', 'status'])

    op.add_column('voice_caller_ids', sa.Column('phone_number_id', sa.String(length=36), nullable=True))
    op.create_index(op.f('ix_voice_caller_ids_phone_number_id'), 'voice_caller_ids', ['phone_number_id'])
    op.create_foreign_key(op.f('fk_voice_caller_ids_phone_number_id_phone_numbers'), 'voice_caller_ids',
                          'phone_numbers', ['phone_number_id'], ['id'], ondelete='SET NULL')

    op.add_column('voice_campaigns', sa.Column('message_type', sa.String(length=20), nullable=True))
    op.add_column('voice_campaigns', sa.Column('agent_id', sa.String(length=36), nullable=True))
    op.create_foreign_key(op.f('fk_voice_campaigns_agent_id_voice_agents'), 'voice_campaigns', 'voice_agents',
                          ['agent_id'], ['id'], ondelete='SET NULL')
    # Existing campaigns: the message type follows the chosen recording or script.
    op.execute("UPDATE voice_campaigns c JOIN voice_audio a ON a.id = c.audio_id "
               "SET c.message_type = CASE WHEN a.kind = 'tts' THEN 'tts' ELSE 'audio' END "
               "WHERE c.message_type IS NULL")

    op.add_column('voice_calls', sa.Column('agent_id', sa.String(length=36), nullable=True))
    op.add_column('voice_calls', sa.Column('transcript', JSONText(), nullable=True))
    op.add_column('voice_calls', sa.Column('ai_summary', sa.Text(), nullable=True))
    op.add_column('voice_calls', sa.Column('ai_sentiment', sa.String(length=20), nullable=True))
    op.add_column('voice_calls', sa.Column('ai_interest', sa.String(length=20), nullable=True))
    op.add_column('voice_calls', sa.Column('ai_outcomes', JSONText(), nullable=True))
    op.add_column('voice_calls', sa.Column('ai_next_step', sa.String(length=500), nullable=True))
    op.add_column('voice_calls', sa.Column('ai_processed_at', UTC(), nullable=True))
    op.create_foreign_key(op.f('fk_voice_calls_agent_id_voice_agents'), 'voice_calls', 'voice_agents',
                          ['agent_id'], ['id'], ondelete='SET NULL')


def downgrade() -> None:
    # MariaDB (error 1553): drop each foreign key before the index it relies on.
    op.drop_constraint(op.f('fk_voice_calls_agent_id_voice_agents'), 'voice_calls', type_='foreignkey')
    for col in ('ai_processed_at', 'ai_next_step', 'ai_outcomes', 'ai_interest', 'ai_sentiment', 'ai_summary',
                'transcript', 'agent_id'):
        op.drop_column('voice_calls', col)

    op.drop_constraint(op.f('fk_voice_campaigns_agent_id_voice_agents'), 'voice_campaigns', type_='foreignkey')
    op.drop_column('voice_campaigns', 'agent_id')
    op.drop_column('voice_campaigns', 'message_type')

    op.drop_constraint(op.f('fk_voice_caller_ids_phone_number_id_phone_numbers'), 'voice_caller_ids',
                       type_='foreignkey')
    op.drop_index(op.f('ix_voice_caller_ids_phone_number_id'), table_name='voice_caller_ids')
    op.drop_column('voice_caller_ids', 'phone_number_id')

    op.drop_table('voice_agents')
    op.drop_table('phone_numbers')
