"""Email: senders, templates, campaigns, per-recipient messages, events and raw webhook records."""
from datetime import datetime

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.audience import TenantMixin
from app.models.base import Base, JSONText, TimestampMixin, UTCDateTime, uuid_pk
from app.utils.time import utcnow


class EmailSender(TenantMixin, TimestampMixin, Base):
    """A From identity. It must be verified (the owner clicks a link sent to it) before use."""

    __tablename__ = "email_senders"
    __table_args__ = (UniqueConstraint("application_id", "from_email", name="uq_email_senders_app_email"),)

    id: Mapped[str] = uuid_pk()
    from_name: Mapped[str] = mapped_column(String(120), nullable=False)
    from_email: Mapped[str] = mapped_column(String(320), nullable=False)
    reply_to: Mapped[str | None] = mapped_column(String(320), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")  # pending|verified
    verification_token_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    verification_sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class EmailTemplate(TenantMixin, TimestampMixin, Base):
    __tablename__ = "email_templates"
    __table_args__ = (Index("ix_email_templates_app_updated", "application_id", "updated_at"),)

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    subject: Mapped[str | None] = mapped_column(String(255), nullable=True)
    preheader: Mapped[str | None] = mapped_column(String(255), nullable=True)
    editor: Mapped[str] = mapped_column(String(10), nullable=False, default="visual")  # visual|html|text
    design: Mapped[dict | None] = mapped_column(JSONText, nullable=True)  # visual editor project data
    html: Mapped[str | None] = mapped_column(Text, nullable=True)
    text: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class EmailCampaign(TenantMixin, TimestampMixin, Base):
    __tablename__ = "email_campaigns"
    __table_args__ = (
        Index("ix_email_campaigns_app_status", "application_id", "status"),
        Index("ix_email_campaigns_due", "status", "scheduled_at"),
    )

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    campaign_type: Mapped[str] = mapped_column(String(20), nullable=False, default="regular")  # regular|transactional
    # draft|scheduled|queued|sending|paused|completed|cancelled|failed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    sender_id: Mapped[str | None] = mapped_column(ForeignKey("email_senders.id", ondelete="SET NULL"), nullable=True)
    from_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    from_email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    reply_to: Mapped[str | None] = mapped_column(String(320), nullable=True)
    subject: Mapped[str | None] = mapped_column(String(255), nullable=True)
    preheader: Mapped[str | None] = mapped_column(String(255), nullable=True)
    editor: Mapped[str] = mapped_column(String(10), nullable=False, default="visual")
    design: Mapped[dict | None] = mapped_column(JSONText, nullable=True)
    html: Mapped[str | None] = mapped_column(Text, nullable=True)
    text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # {"all": bool, "list_ids": [...], "segment_ids": [...]}
    audience: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    track_opens: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    track_clicks: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    scheduled_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    schedule_timezone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Frozen at launch so later edits to templates or links cannot change what was sent.
    links: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    provider: Mapped[str | None] = mapped_column(String(30), nullable=True)
    recipient_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    excluded: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    launched_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class EmailMessage(TenantMixin, Base):
    """One recipient of one campaign. The unique (campaign, contact) pair makes sending idempotent."""

    __tablename__ = "email_messages"
    __table_args__ = (
        UniqueConstraint("campaign_id", "contact_id", name="uq_email_messages_campaign_contact"),
        Index("ix_email_messages_campaign_status", "campaign_id", "status"),
        Index("ix_email_messages_provider_id", "provider_message_id"),
        Index("ix_email_messages_contact", "contact_id", "created_at"),
    )

    id: Mapped[str] = uuid_pk()
    campaign_id: Mapped[str] = mapped_column(ForeignKey("email_campaigns.id", ondelete="CASCADE"), nullable=False)
    contact_id: Mapped[str | None] = mapped_column(ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    to_email: Mapped[str] = mapped_column(String(320), nullable=False)
    # queued|sending|accepted|delivered|bounced|complained|failed|skipped
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued")
    provider: Mapped[str | None] = mapped_column(String(30), nullable=True)
    provider_message_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    accepted_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    delivered_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    bounced_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    bounce_type: Mapped[str | None] = mapped_column(String(20), nullable=True)  # hard|soft
    complained_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    first_opened_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    first_clicked_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    open_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    click_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unsubscribed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)


class EmailEvent(TenantMixin, Base):
    """Normalised, append-only event history for a message."""

    __tablename__ = "email_events"
    __table_args__ = (
        Index("ix_email_events_campaign_type_time", "campaign_id", "type", "occurred_at"),
        Index("ix_email_events_message", "message_id", "occurred_at"),
        UniqueConstraint("provider", "provider_event_id", name="uq_email_events_provider_event"),
    )

    id: Mapped[str] = uuid_pk()
    campaign_id: Mapped[str] = mapped_column(ForeignKey("email_campaigns.id", ondelete="CASCADE"), nullable=False)
    message_id: Mapped[str] = mapped_column(ForeignKey("email_messages.id", ondelete="CASCADE"), nullable=False)
    contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # accepted|delivered|bounced|complained|opened|clicked|unsubscribed|failed
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    provider: Mapped[str | None] = mapped_column(String(30), nullable=True)
    provider_event_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    meta: Mapped[dict] = mapped_column("metadata", JSON, nullable=False, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class WebhookEvent(Base):
    """Raw provider callbacks, stored before processing. Unique per provider event for dedupe."""

    __tablename__ = "webhook_events"
    __table_args__ = (
        UniqueConstraint("provider", "event_id", name="uq_webhook_events_provider_event"),
        Index("ix_webhook_events_status", "status", "received_at"),
    )

    id: Mapped[str] = uuid_pk()
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    channel: Mapped[str] = mapped_column(String(10), nullable=False, default="email")
    event_id: Mapped[str] = mapped_column(String(255), nullable=False)
    event_type: Mapped[str | None] = mapped_column(String(60), nullable=True)
    signature_valid: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="received")  # received|processed|ignored|failed
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    received_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    processed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class EmailDomainCheck(Base):
    """Latest DNS authentication check (SPF, DKIM, DMARC, MX) for a sender domain. DNS is public, so one row
    per domain serves every application that sends from it."""

    __tablename__ = "email_domain_checks"

    domain: Mapped[str] = mapped_column(String(253), primary_key=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # authenticated|partial|unauthenticated|error
    results: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    checked_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
