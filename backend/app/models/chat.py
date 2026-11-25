"""Website chatbots and live chat: bots and their training (knowledge sources and search chunks), visitors,
conversations and messages, live-chat agents (seats and presence) and canned responses."""
from datetime import datetime

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.orm import Mapped, mapped_column

from app.models.audience import TenantMixin
from app.models.base import Base, JSONText, TimestampMixin, UTCDateTime, uuid_pk
from app.utils.time import utcnow


class ChatBot(TenantMixin, TimestampMixin, Base):
    """A website chatbot: persona, lead capture, hours, allowed websites and widget look. `public_key` is the
    only identifier that appears on customers' websites."""

    __tablename__ = "chat_bots"
    __table_args__ = (Index("ix_chat_bots_app_status", "application_id", "status"),)

    id: Mapped[str] = uuid_pk()
    public_key: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")  # draft|live
    template: Mapped[str | None] = mapped_column(String(40), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    instructions: Mapped[str] = mapped_column(Text, nullable=False, default="")
    welcome_message: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    quick_replies: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    language: Mapped[str] = mapped_column(String(10), nullable=False, default="auto")
    fallback: Mapped[str] = mapped_column(String(20), nullable=False, default="human")  # human|collect
    lead_capture: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    business_hours: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    allowed_domains: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    appearance: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    proactive: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    routing: Mapped[str] = mapped_column(String(20), nullable=False, default="broadcast")  # broadcast|round_robin
    routing_cursor: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    knowledge_chars: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # When owners were last told that AI replies are paused because the wallet is empty (once a day).
    wallet_paused_notified_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class ChatKnowledgeSource(TenantMixin, TimestampMixin, Base):
    """What a bot is trained on: free text, a FAQ pair, a web page (or a crawl of a site) or an uploaded file."""

    __tablename__ = "chat_knowledge_sources"
    __table_args__ = (Index("ix_chat_knowledge_sources_bot", "bot_id", "kind"),)

    id: Mapped[str] = uuid_pk()
    bot_id: Mapped[str] = mapped_column(ForeignKey("chat_bots.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # text|faq|url|file
    title: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    url: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    question: Mapped[str | None] = mapped_column(Text, nullable=True)  # FAQ question
    content: Mapped[str | None] = mapped_column(Text().with_variant(LONGTEXT(), "mysql"), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ready")  # processing|ready|failed
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    char_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_synced_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    meta: Mapped[dict] = mapped_column(JSONText(), nullable=False, default=dict)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class ChatKnowledgeChunk(Base):
    """~1,500-character overlapping pieces of a bot's knowledge, searched with MariaDB FULLTEXT when the
    knowledge is too large to put whole into the prompt."""

    __tablename__ = "chat_knowledge_chunks"
    __table_args__ = (Index("ix_chat_knowledge_chunks_bot", "bot_id", "source_id", "position"),
                      Index("ix_chat_knowledge_chunks_content_ft", "content", mysql_prefix="FULLTEXT"))

    id: Mapped[str] = uuid_pk()
    bot_id: Mapped[str] = mapped_column(ForeignKey("chat_bots.id", ondelete="CASCADE"), nullable=False)
    source_id: Mapped[str] = mapped_column(ForeignKey("chat_knowledge_sources.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    title: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    content: Mapped[str] = mapped_column(Text, nullable=False)


class ChatVisitor(TenantMixin, Base):
    """An anonymous website visitor of one bot, identified by a signed token kept in the widget's storage."""

    __tablename__ = "chat_visitors"
    __table_args__ = (Index("ix_chat_visitors_bot_seen", "bot_id", "last_seen_at"),)

    id: Mapped[str] = uuid_pk()
    bot_id: Mapped[str] = mapped_column(ForeignKey("chat_bots.id", ondelete="CASCADE"), nullable=False)
    contact_id: Mapped[str | None] = mapped_column(ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True,
                                                   index=True)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(40), nullable=True)
    attributes: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    pages: Mapped[list] = mapped_column(JSONText(), nullable=False, default=list)  # last pages viewed
    referrer: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    utm: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(400), nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class ChatConversation(TenantMixin, TimestampMixin, Base):
    """bot (the AI answers) → waiting (a human was requested) → open (an agent joined) → closed."""

    __tablename__ = "chat_conversations"
    __table_args__ = (Index("ix_chat_conversations_app_status", "application_id", "status", "last_message_at"),
                      Index("ix_chat_conversations_app_updated", "application_id", "updated_at"),
                      Index("ix_chat_conversations_bot_created", "bot_id", "created_at"),
                      Index("ix_chat_conversations_visitor", "visitor_id", "created_at"))

    id: Mapped[str] = uuid_pk()
    bot_id: Mapped[str] = mapped_column(ForeignKey("chat_bots.id", ondelete="CASCADE"), nullable=False)
    visitor_id: Mapped[str] = mapped_column(ForeignKey("chat_visitors.id", ondelete="CASCADE"), nullable=False)
    contact_id: Mapped[str | None] = mapped_column(ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True,
                                                   index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="bot")  # bot|waiting|open|closed
    assignee_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
                                                    index=True)
    offline: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)  # left as an offline message
    page_url: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    page_title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    tags: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    visitor_messages: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ai_replies: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unread_agent: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # visitor messages not yet read
    last_message_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_message_preview: Mapped[str | None] = mapped_column(String(200), nullable=True)
    handoff_requested_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    agent_joined_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    first_human_response_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    lead_captured_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    closed_by: Mapped[str | None] = mapped_column(String(20), nullable=True)  # visitor|agent|system
    rating: Mapped[str | None] = mapped_column(String(10), nullable=True)  # up|down
    rating_comment: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    rated_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_intent: Mapped[str | None] = mapped_column(String(200), nullable=True)
    ai_sentiment: Mapped[str | None] = mapped_column(String(20), nullable=True)
    ai_lead_quality: Mapped[str | None] = mapped_column(String(20), nullable=True)  # hot|warm|cold
    ai_follow_up: Mapped[str | None] = mapped_column(String(500), nullable=True)
    ai_processed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class ChatMessage(TenantMixin, Base):
    """role: visitor | bot | agent | system | note (internal, never shown to the visitor).
    flag on bot replies: unanswered (the bot didn't know) → resolved (someone taught it the answer)."""

    __tablename__ = "chat_messages"
    __table_args__ = (Index("ix_chat_messages_conversation", "conversation_id", "created_at"),
                      Index("ix_chat_messages_app_flag", "application_id", "flag", "created_at"))

    id: Mapped[str] = uuid_pk()
    conversation_id: Mapped[str] = mapped_column(ForeignKey("chat_conversations.id", ondelete="CASCADE"),
                                                 nullable=False)
    role: Mapped[str] = mapped_column(String(10), nullable=False)
    author_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    question: Mapped[str | None] = mapped_column(Text, nullable=True)  # bot replies: what the visitor asked
    flag: Mapped[str | None] = mapped_column(String(20), nullable=True)
    meta: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class ChatAgent(TenantMixin, Base):
    """A team member who answers live chats in an application. Each distinct agent in the organization takes
    one live-chat seat (plan limit `chat_seats`). Presence comes from the inbox heartbeat."""

    __tablename__ = "chat_agents"
    __table_args__ = (UniqueConstraint("application_id", "user_id", name="uq_chat_agents_app_user"),)

    id: Mapped[str] = uuid_pk()
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="offline")  # online|away|offline
    last_seen_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class ChatCannedResponse(TenantMixin, TimestampMixin, Base):
    """A saved reply agents insert with its shortcut (for example /hello)."""

    __tablename__ = "chat_canned_responses"
    __table_args__ = (UniqueConstraint("application_id", "shortcut", name="uq_chat_canned_app_shortcut"),)

    id: Mapped[str] = uuid_pk()
    shortcut: Mapped[str] = mapped_column(String(40), nullable=False)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
