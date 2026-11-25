"""ai_team: AI Assistant conversations, messages and pending (proposed) actions; AI agents, their runs and run
steps; the organization's Slack connection and per-agent Slack destinations; daily AI usage counters; the
ai.use / ai.manage permissions

Revision ID: 0025
Revises: 0024
Create Date: 2026-11-25 18:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

import app.models.base

revision: str = '0025'
down_revision: str | None = '0024'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UTC = app.models.base.UTCDateTime
JSONText = app.models.base.JSONText
LONGTEXT = sa.Text().with_variant(mysql.LONGTEXT(), 'mysql')


def _id() -> sa.Column:
    return sa.Column('id', sa.String(length=36), nullable=False)


def _tenant() -> list[sa.Column]:
    return [sa.Column('organization_id', sa.String(length=36), nullable=False),
            sa.Column('application_id', sa.String(length=36), nullable=False)]


def _tenant_fks(table: str) -> list:
    return [sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'],
                                    name=op.f(f'fk_{table}_organization_id_organizations'), ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['application_id'], ['applications.id'],
                                    name=op.f(f'fk_{table}_application_id_applications'), ondelete='CASCADE')]


def _fk(table: str, col: str, ref: str, ondelete: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint([col], [f'{ref}.id'], name=op.f(f'fk_{table}_{col}_{ref}'), ondelete=ondelete)


def _stamps() -> list[sa.Column]:
    return [sa.Column('created_at', UTC(), nullable=False), sa.Column('updated_at', UTC(), nullable=False)]


def upgrade() -> None:
    op.create_table(
        'ai_conversations', _id(), *_tenant(),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('message_count', sa.Integer(), nullable=False),
        *_stamps(),
        *_tenant_fks('ai_conversations'),
        _fk('ai_conversations', 'user_id', 'users', 'CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_ai_conversations')),
    )
    op.create_index('ix_ai_conversations_user_app', 'ai_conversations', ['user_id', 'application_id', 'updated_at'])

    op.create_table(
        'ai_messages', _id(), *_tenant(),
        sa.Column('conversation_id', sa.String(length=36), nullable=False),
        sa.Column('role', sa.String(length=12), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('tool_calls', JSONText(), nullable=True),
        sa.Column('links', JSONText(), nullable=True),
        sa.Column('context', JSONText(), nullable=True),
        sa.Column('simulated', sa.Boolean(), nullable=False),
        sa.Column('input_tokens', sa.Integer(), nullable=False),
        sa.Column('output_tokens', sa.Integer(), nullable=False),
        sa.Column('created_at', UTC(), nullable=False),
        *_tenant_fks('ai_messages'),
        _fk('ai_messages', 'conversation_id', 'ai_conversations', 'CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_ai_messages')),
    )
    op.create_index('ix_ai_messages_conversation', 'ai_messages', ['conversation_id', 'created_at'])

    op.create_table(
        'ai_agents', _id(), *_tenant(),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('description', sa.String(length=500), nullable=False),
        sa.Column('template', sa.String(length=40), nullable=True),
        sa.Column('instructions', sa.Text(), nullable=False),
        sa.Column('trigger', JSONText(), nullable=False),
        sa.Column('allowed_tools', JSONText(), nullable=False),
        sa.Column('mode', sa.String(length=10), nullable=False),
        sa.Column('destinations', JSONText(), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False),
        sa.Column('owner_id', sa.String(length=36), nullable=True),
        sa.Column('next_run_at', UTC(), nullable=True),
        sa.Column('event_cursor', UTC(), nullable=True),
        sa.Column('last_run_at', UTC(), nullable=True),
        sa.Column('last_status', sa.String(length=12), nullable=True),
        *_stamps(),
        *_tenant_fks('ai_agents'),
        _fk('ai_agents', 'owner_id', 'users', 'SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_ai_agents')),
    )
    op.create_index('ix_ai_agents_app_enabled', 'ai_agents', ['application_id', 'enabled'])
    op.create_index('ix_ai_agents_due', 'ai_agents', ['enabled', 'next_run_at'])

    op.create_table(
        'ai_agent_runs', _id(), *_tenant(),
        sa.Column('agent_id', sa.String(length=36), nullable=False),
        sa.Column('trigger_key', sa.String(length=160), nullable=False),
        sa.Column('trigger_data', JSONText(), nullable=False),
        sa.Column('status', sa.String(length=12), nullable=False),
        sa.Column('dry_run', sa.Boolean(), nullable=False),
        sa.Column('simulated', sa.Boolean(), nullable=False),
        sa.Column('attempts', sa.Integer(), nullable=False),
        sa.Column('next_attempt_at', UTC(), nullable=True),
        sa.Column('summary', sa.Text(), nullable=True),
        sa.Column('error', sa.String(length=500), nullable=True),
        sa.Column('input_tokens', sa.Integer(), nullable=False),
        sa.Column('output_tokens', sa.Integer(), nullable=False),
        sa.Column('started_by_id', sa.String(length=36), nullable=True),
        sa.Column('started_at', UTC(), nullable=True),
        sa.Column('finished_at', UTC(), nullable=True),
        *_stamps(),
        *_tenant_fks('ai_agent_runs'),
        _fk('ai_agent_runs', 'agent_id', 'ai_agents', 'CASCADE'),
        _fk('ai_agent_runs', 'started_by_id', 'users', 'SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_ai_agent_runs')),
        sa.UniqueConstraint('agent_id', 'trigger_key', name='uq_ai_agent_runs_agent_key'),
    )
    op.create_index('ix_ai_agent_runs_agent_time', 'ai_agent_runs', ['agent_id', 'created_at'])
    op.create_index('ix_ai_agent_runs_due', 'ai_agent_runs', ['status', 'next_attempt_at'])

    op.create_table(
        'ai_agent_run_steps', _id(), *_tenant(),
        sa.Column('run_id', sa.String(length=36), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('kind', sa.String(length=12), nullable=False),
        sa.Column('tool', sa.String(length=60), nullable=True),
        sa.Column('args', JSONText(), nullable=True),
        sa.Column('result_summary', sa.Text(), nullable=True),
        sa.Column('status', sa.String(length=12), nullable=False),
        sa.Column('action_id', sa.String(length=36), nullable=True),
        sa.Column('input_tokens', sa.Integer(), nullable=False),
        sa.Column('output_tokens', sa.Integer(), nullable=False),
        sa.Column('created_at', UTC(), nullable=False),
        *_tenant_fks('ai_agent_run_steps'),
        _fk('ai_agent_run_steps', 'run_id', 'ai_agent_runs', 'CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_ai_agent_run_steps')),
    )
    op.create_index('ix_ai_agent_run_steps_run', 'ai_agent_run_steps', ['run_id', 'position'])

    op.create_table(
        'ai_pending_actions', _id(), *_tenant(),
        sa.Column('source', sa.String(length=12), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=True),
        sa.Column('conversation_id', sa.String(length=36), nullable=True),
        sa.Column('agent_id', sa.String(length=36), nullable=True),
        sa.Column('run_id', sa.String(length=36), nullable=True),
        sa.Column('tool', sa.String(length=60), nullable=False),
        sa.Column('args', JSONText(), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('fields', JSONText(), nullable=False),
        sa.Column('status', sa.String(length=12), nullable=False),
        sa.Column('result', JSONText(), nullable=True),
        sa.Column('error', sa.String(length=500), nullable=True),
        sa.Column('decided_by_id', sa.String(length=36), nullable=True),
        sa.Column('decided_via', sa.String(length=12), nullable=True),
        sa.Column('decided_at', UTC(), nullable=True),
        sa.Column('slack_channel', sa.String(length=40), nullable=True),
        sa.Column('slack_ts', sa.String(length=40), nullable=True),
        sa.Column('expires_at', UTC(), nullable=True),
        *_stamps(),
        *_tenant_fks('ai_pending_actions'),
        _fk('ai_pending_actions', 'user_id', 'users', 'SET NULL'),
        _fk('ai_pending_actions', 'conversation_id', 'ai_conversations', 'CASCADE'),
        _fk('ai_pending_actions', 'agent_id', 'ai_agents', 'CASCADE'),
        _fk('ai_pending_actions', 'run_id', 'ai_agent_runs', 'CASCADE'),
        _fk('ai_pending_actions', 'decided_by_id', 'users', 'SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_ai_pending_actions')),
    )
    op.create_index('ix_ai_actions_app_status', 'ai_pending_actions', ['application_id', 'status', 'created_at'])
    op.create_index('ix_ai_actions_conversation', 'ai_pending_actions', ['conversation_id'])
    op.create_index('ix_ai_actions_run', 'ai_pending_actions', ['run_id'])

    op.create_table(
        'slack_connections', _id(),
        sa.Column('organization_id', sa.String(length=36), nullable=False),
        sa.Column('team_id', sa.String(length=40), nullable=False),
        sa.Column('team_name', sa.String(length=200), nullable=False),
        sa.Column('bot_user_id', sa.String(length=40), nullable=True),
        sa.Column('app_id', sa.String(length=40), nullable=True),
        sa.Column('scopes', sa.String(length=500), nullable=False),
        sa.Column('token_encrypted', sa.Text(), nullable=True),
        sa.Column('simulated', sa.Boolean(), nullable=False),
        sa.Column('connected_by_id', sa.String(length=36), nullable=True),
        *_stamps(),
        _fk('slack_connections', 'organization_id', 'organizations', 'CASCADE'),
        _fk('slack_connections', 'connected_by_id', 'users', 'SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_slack_connections')),
        sa.UniqueConstraint('organization_id', name=op.f('uq_slack_connections_organization_id')),
    )
    op.create_index('ix_slack_connections_team', 'slack_connections', ['team_id'])

    op.create_table(
        'ai_agent_slack_destinations', _id(), *_tenant(),
        sa.Column('agent_id', sa.String(length=36), nullable=False),
        sa.Column('channel_id', sa.String(length=40), nullable=False),
        sa.Column('channel_name', sa.String(length=120), nullable=False),
        sa.Column('created_at', UTC(), nullable=False),
        *_tenant_fks('ai_agent_slack_destinations'),
        _fk('ai_agent_slack_destinations', 'agent_id', 'ai_agents', 'CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_ai_agent_slack_destinations')),
        sa.UniqueConstraint('agent_id', 'channel_id', name='uq_ai_agent_slack_agent_channel'),
    )

    op.create_table(
        'ai_usage_counters', _id(),
        sa.Column('organization_id', sa.String(length=36), nullable=False),
        sa.Column('day', sa.Date(), nullable=False),
        sa.Column('kind', sa.String(length=30), nullable=False),
        sa.Column('count', sa.Integer(), nullable=False),
        _fk('ai_usage_counters', 'organization_id', 'organizations', 'CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_ai_usage_counters')),
        sa.UniqueConstraint('organization_id', 'day', 'kind', name='uq_ai_usage_org_day_kind'),
    )

    if not op.get_context().as_sql:  # offline SQL: run `python -m app.cli sync-rbac` afterwards
        from app.core.rbac_sync import sync_rbac

        sync_rbac(op.get_bind())


def downgrade() -> None:
    # Dropping a table drops its own foreign keys and indexes; tables go child-first so nothing points at a
    # dropped table (MariaDB error 1553 only arises when an index is dropped before its foreign key).
    op.drop_table('ai_usage_counters')
    op.drop_table('ai_agent_slack_destinations')
    op.drop_table('slack_connections')
    op.drop_table('ai_pending_actions')
    op.drop_table('ai_agent_run_steps')
    op.drop_table('ai_agent_runs')
    op.drop_table('ai_agents')
    op.drop_table('ai_messages')
    op.drop_table('ai_conversations')
    op.execute("DELETE FROM role_permissions WHERE permission_key IN ('ai.use', 'ai.manage')")
    op.execute("DELETE FROM permissions WHERE `key` IN ('ai.use', 'ai.manage')")
