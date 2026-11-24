"""chat: website chatbots, training sources and FULLTEXT chunks, visitors, conversations, messages, live-chat
agents and canned responses; chat.read / chat.write / chat.reply permissions

Revision ID: 0021
Revises: 0020
Create Date: 2026-11-24 12:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

import app.models.base

revision: str = '0021'
down_revision: str | None = '0020'
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
        'chat_bots', _id(), *_tenant(),
        sa.Column('public_key', sa.String(length=32), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('template', sa.String(length=40), nullable=True),
        sa.Column('avatar_url', sa.String(length=500), nullable=True),
        sa.Column('instructions', sa.Text(), nullable=False),
        sa.Column('welcome_message', sa.String(length=1000), nullable=False),
        sa.Column('quick_replies', sa.JSON(), nullable=False),
        sa.Column('language', sa.String(length=10), nullable=False),
        sa.Column('fallback', sa.String(length=20), nullable=False),
        sa.Column('lead_capture', sa.JSON(), nullable=False),
        sa.Column('business_hours', sa.JSON(), nullable=False),
        sa.Column('allowed_domains', sa.JSON(), nullable=False),
        sa.Column('appearance', sa.JSON(), nullable=False),
        sa.Column('proactive', sa.JSON(), nullable=False),
        sa.Column('routing', sa.String(length=20), nullable=False),
        sa.Column('routing_cursor', sa.Integer(), nullable=False),
        sa.Column('knowledge_chars', sa.Integer(), nullable=False),
        sa.Column('wallet_paused_notified_at', UTC(), nullable=True),
        sa.Column('created_by_id', sa.String(length=36), nullable=True),
        *_stamps(),
        *_tenant_fks('chat_bots'),
        _fk('chat_bots', 'created_by_id', 'users', 'SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_bots')),
        sa.UniqueConstraint('public_key', name=op.f('uq_chat_bots_public_key')),
    )
    op.create_index('ix_chat_bots_app_status', 'chat_bots', ['application_id', 'status'])

    op.create_table(
        'chat_knowledge_sources', _id(), *_tenant(),
        sa.Column('bot_id', sa.String(length=36), nullable=False),
        sa.Column('kind', sa.String(length=20), nullable=False),
        sa.Column('title', sa.String(length=300), nullable=False),
        sa.Column('url', sa.String(length=2000), nullable=True),
        sa.Column('question', sa.Text(), nullable=True),
        sa.Column('content', LONGTEXT, nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('error', sa.String(length=500), nullable=True),
        sa.Column('char_count', sa.Integer(), nullable=False),
        sa.Column('last_synced_at', UTC(), nullable=True),
        sa.Column('meta', JSONText(), nullable=False),
        sa.Column('created_by_id', sa.String(length=36), nullable=True),
        *_stamps(),
        *_tenant_fks('chat_knowledge_sources'),
        _fk('chat_knowledge_sources', 'bot_id', 'chat_bots', 'CASCADE'),
        _fk('chat_knowledge_sources', 'created_by_id', 'users', 'SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_knowledge_sources')),
    )
    op.create_index('ix_chat_knowledge_sources_bot', 'chat_knowledge_sources', ['bot_id', 'kind'])

    op.create_table(
        'chat_knowledge_chunks', _id(),
        sa.Column('bot_id', sa.String(length=36), nullable=False),
        sa.Column('source_id', sa.String(length=36), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(length=300), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        _fk('chat_knowledge_chunks', 'bot_id', 'chat_bots', 'CASCADE'),
        _fk('chat_knowledge_chunks', 'source_id', 'chat_knowledge_sources', 'CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_knowledge_chunks')),
    )
    op.create_index('ix_chat_knowledge_chunks_bot', 'chat_knowledge_chunks', ['bot_id', 'source_id', 'position'])
    op.create_index('ix_chat_knowledge_chunks_content_ft', 'chat_knowledge_chunks', ['content'],
                    mysql_prefix='FULLTEXT')

    op.create_table(
        'chat_visitors', _id(), *_tenant(),
        sa.Column('bot_id', sa.String(length=36), nullable=False),
        sa.Column('contact_id', sa.String(length=36), nullable=True),
        sa.Column('name', sa.String(length=200), nullable=True),
        sa.Column('email', sa.String(length=320), nullable=True),
        sa.Column('phone', sa.String(length=40), nullable=True),
        sa.Column('attributes', sa.JSON(), nullable=False),
        sa.Column('pages', JSONText(), nullable=False),
        sa.Column('referrer', sa.String(length=1000), nullable=True),
        sa.Column('utm', sa.JSON(), nullable=False),
        sa.Column('ip_address', sa.String(length=64), nullable=True),
        sa.Column('country', sa.String(length=2), nullable=True),
        sa.Column('user_agent', sa.String(length=400), nullable=True),
        sa.Column('first_seen_at', UTC(), nullable=False),
        sa.Column('last_seen_at', UTC(), nullable=False),
        *_tenant_fks('chat_visitors'),
        _fk('chat_visitors', 'bot_id', 'chat_bots', 'CASCADE'),
        _fk('chat_visitors', 'contact_id', 'contacts', 'SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_visitors')),
    )
    op.create_index('ix_chat_visitors_bot_seen', 'chat_visitors', ['bot_id', 'last_seen_at'])
    op.create_index(op.f('ix_chat_visitors_contact_id'), 'chat_visitors', ['contact_id'])

    op.create_table(
        'chat_conversations', _id(), *_tenant(),
        sa.Column('bot_id', sa.String(length=36), nullable=False),
        sa.Column('visitor_id', sa.String(length=36), nullable=False),
        sa.Column('contact_id', sa.String(length=36), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('assignee_id', sa.String(length=36), nullable=True),
        sa.Column('offline', sa.Boolean(), nullable=False),
        sa.Column('page_url', sa.String(length=2000), nullable=True),
        sa.Column('page_title', sa.String(length=300), nullable=True),
        sa.Column('tags', sa.JSON(), nullable=False),
        sa.Column('message_count', sa.Integer(), nullable=False),
        sa.Column('visitor_messages', sa.Integer(), nullable=False),
        sa.Column('ai_replies', sa.Integer(), nullable=False),
        sa.Column('unread_agent', sa.Integer(), nullable=False),
        sa.Column('last_message_at', UTC(), nullable=True),
        sa.Column('last_message_preview', sa.String(length=200), nullable=True),
        sa.Column('handoff_requested_at', UTC(), nullable=True),
        sa.Column('agent_joined_at', UTC(), nullable=True),
        sa.Column('first_human_response_at', UTC(), nullable=True),
        sa.Column('lead_captured_at', UTC(), nullable=True),
        sa.Column('closed_at', UTC(), nullable=True),
        sa.Column('closed_by', sa.String(length=20), nullable=True),
        sa.Column('rating', sa.String(length=10), nullable=True),
        sa.Column('rating_comment', sa.String(length=1000), nullable=True),
        sa.Column('rated_at', UTC(), nullable=True),
        sa.Column('ai_summary', sa.Text(), nullable=True),
        sa.Column('ai_intent', sa.String(length=200), nullable=True),
        sa.Column('ai_sentiment', sa.String(length=20), nullable=True),
        sa.Column('ai_lead_quality', sa.String(length=20), nullable=True),
        sa.Column('ai_follow_up', sa.String(length=500), nullable=True),
        sa.Column('ai_processed_at', UTC(), nullable=True),
        *_stamps(),
        *_tenant_fks('chat_conversations'),
        _fk('chat_conversations', 'bot_id', 'chat_bots', 'CASCADE'),
        _fk('chat_conversations', 'visitor_id', 'chat_visitors', 'CASCADE'),
        _fk('chat_conversations', 'contact_id', 'contacts', 'SET NULL'),
        _fk('chat_conversations', 'assignee_id', 'users', 'SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_conversations')),
    )
    op.create_index('ix_chat_conversations_app_status', 'chat_conversations',
                    ['application_id', 'status', 'last_message_at'])
    op.create_index('ix_chat_conversations_app_updated', 'chat_conversations', ['application_id', 'updated_at'])
    op.create_index('ix_chat_conversations_bot_created', 'chat_conversations', ['bot_id', 'created_at'])
    op.create_index('ix_chat_conversations_visitor', 'chat_conversations', ['visitor_id', 'created_at'])
    op.create_index(op.f('ix_chat_conversations_contact_id'), 'chat_conversations', ['contact_id'])
    op.create_index(op.f('ix_chat_conversations_assignee_id'), 'chat_conversations', ['assignee_id'])

    op.create_table(
        'chat_messages', _id(), *_tenant(),
        sa.Column('conversation_id', sa.String(length=36), nullable=False),
        sa.Column('role', sa.String(length=10), nullable=False),
        sa.Column('author_id', sa.String(length=36), nullable=True),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('question', sa.Text(), nullable=True),
        sa.Column('flag', sa.String(length=20), nullable=True),
        sa.Column('meta', sa.JSON(), nullable=False),
        sa.Column('created_at', UTC(), nullable=False),
        *_tenant_fks('chat_messages'),
        _fk('chat_messages', 'conversation_id', 'chat_conversations', 'CASCADE'),
        _fk('chat_messages', 'author_id', 'users', 'SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_messages')),
    )
    op.create_index('ix_chat_messages_conversation', 'chat_messages', ['conversation_id', 'created_at'])
    op.create_index('ix_chat_messages_app_flag', 'chat_messages', ['application_id', 'flag', 'created_at'])

    op.create_table(
        'chat_agents', _id(), *_tenant(),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('status', sa.String(length=10), nullable=False),
        sa.Column('last_seen_at', UTC(), nullable=True),
        sa.Column('created_at', UTC(), nullable=False),
        *_tenant_fks('chat_agents'),
        _fk('chat_agents', 'user_id', 'users', 'CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_agents')),
        sa.UniqueConstraint('application_id', 'user_id', name='uq_chat_agents_app_user'),
    )
    op.create_index(op.f('ix_chat_agents_user_id'), 'chat_agents', ['user_id'])

    op.create_table(
        'chat_canned_responses', _id(), *_tenant(),
        sa.Column('shortcut', sa.String(length=40), nullable=False),
        sa.Column('title', sa.String(length=120), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        *_stamps(),
        *_tenant_fks('chat_canned_responses'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_canned_responses')),
        sa.UniqueConstraint('application_id', 'shortcut', name='uq_chat_canned_app_shortcut'),
    )

    if not op.get_context().as_sql:  # offline SQL: run `python -m app.cli sync-rbac` afterwards
        from app.core.rbac_sync import sync_rbac

        sync_rbac(op.get_bind())


def downgrade() -> None:
    # Dropping a table drops its own foreign keys and indexes; tables go child-first so nothing points at a
    # dropped table (MariaDB error 1553 only arises when an index is dropped before its foreign key).
    op.drop_table('chat_canned_responses')
    op.drop_table('chat_agents')
    op.drop_table('chat_messages')
    op.drop_table('chat_conversations')
    op.drop_table('chat_visitors')
    op.drop_table('chat_knowledge_chunks')
    op.drop_table('chat_knowledge_sources')
    op.drop_table('chat_bots')
    op.execute("DELETE FROM role_permissions WHERE permission_key IN ('chat.read', 'chat.write', 'chat.reply')")
    op.execute("DELETE FROM permissions WHERE `key` IN ('chat.read', 'chat.write', 'chat.reply')")
