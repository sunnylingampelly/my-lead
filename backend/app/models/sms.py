"""SMS: regulatory registration, sender IDs, templates, campaigns, messages, events, inbound."""
from datetime import datetime

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.audience import TenantMixin
from app.models.base import Base, TimestampMixin, UTCDateTime, uuid_pk
from app.utils.time import utcnow


class SmsDltConfiguration(TenantMixin, TimestampMixin, Base):
    """Regulatory registration for an application.

    India: TRAI DLT Principal Entity (PE) registration.
    US: A2P 10DLC brand and campaign registration (via The Campaign Registry / the provider).
    Entering these values does not mean they are approved; the attestation records who confirmed
    the registration and when, and providers reject traffic that does not match.
    """

    __tablename__ = "sms_dlt_configurations"
    __table_args__ = (UniqueConstraint("application_id", name="uq_sms_dlt_app"),)

    id: Mapped[str] = uuid_pk()
    principal_entity_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    entity_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    dlt_platform: Mapped[str | None] = mapped_column(String(40), nullable=True)  # Jio, Airtel, Vodafone Idea, BSNL...
    us_brand_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    us_campaign_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    us_messaging_service_sid: Mapped[str | None] = mapped_column(String(64), nullable=True)
    attested_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    attested_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class SmsSender(TenantMixin, TimestampMixin, Base):
    """A sender ID: an Indian DLT header (6 characters) or a US number / short code."""

    __tablename__ = "sms_sender_settings"
    __table_args__ = (UniqueConstraint("application_id", "sender_id", name="uq_sms_senders_app_sender"),)

    id: Mapped[str] = uuid_pk()
    sender_id: Mapped[str] = mapped_column(String(20), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    # IN: promotional (numeric) | service (alpha) | transactional (alpha). US: long_code | toll_free | short_code
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    provider: Mapped[str] = mapped_column(String(20), nullable=False, default="simulation")
    dlt_header_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # pending until a team member attests the header/number is registered with the regulator/provider
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    attested_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    attested_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class SmsTemplate(TenantMixin, TimestampMixin, Base):
    __tablename__ = "sms_templates"

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    category: Mapped[str] = mapped_column(String(20), nullable=False, default="promotional")  # promotional|transactional|service
    body: Mapped[str] = mapped_column(Text, nullable=False)
    sender_ref: Mapped[str | None] = mapped_column(ForeignKey("sms_sender_settings.id", ondelete="SET NULL"),
                                                   nullable=True)
    dlt_template_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # The exact text registered on the DLT portal, with {#var#} placeholders.
    dlt_template_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class SmsCampaign(TenantMixin, TimestampMixin, Base):
    __tablename__ = "sms_campaigns"
    __table_args__ = (Index("ix_sms_campaigns_app_status", "application_id", "status"),
                      Index("ix_sms_campaigns_due", "status", "scheduled_at"))

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    category: Mapped[str] = mapped_column(String(20), nullable=False, default="promotional")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    sender_ref: Mapped[str | None] = mapped_column(ForeignKey("sms_sender_settings.id", ondelete="SET NULL"),
                                                   nullable=True)
    template_id: Mapped[str | None] = mapped_column(ForeignKey("sms_templates.id", ondelete="SET NULL"), nullable=True)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    append_opt_out: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    audience: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    scheduled_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    schedule_timezone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    provider: Mapped[str | None] = mapped_column(String(20), nullable=True)
    sender_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    recipient_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    excluded: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    estimated_cost: Mapped[float | None] = mapped_column(Numeric(14, 4), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    launched_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class SmsMessage(TenantMixin, Base):
    __tablename__ = "sms_messages"
    __table_args__ = (
        UniqueConstraint("campaign_id", "contact_id", name="uq_sms_messages_campaign_contact"),
        Index("ix_sms_messages_campaign_status", "campaign_id", "status"),
        Index("ix_sms_messages_provider_id", "provider", "provider_message_id"),
        Index("ix_sms_messages_contact", "contact_id", "created_at"),
    )

    id: Mapped[str] = uuid_pk()
    campaign_id: Mapped[str] = mapped_column(ForeignKey("sms_campaigns.id", ondelete="CASCADE"), nullable=False)
    contact_id: Mapped[str | None] = mapped_column(ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    to_phone: Mapped[str] = mapped_column(String(20), nullable=False)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    # queued|deferred|sending|accepted|delivered|undelivered|failed|skipped
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued")
    provider: Mapped[str | None] = mapped_column(String(20), nullable=True)
    provider_message_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)  # final text sent, for audit
    encoding: Mapped[str | None] = mapped_column(String(8), nullable=True)
    segments: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost: Mapped[float | None] = mapped_column(Numeric(12, 4), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    deferred_reason: Mapped[str | None] = mapped_column(String(80), nullable=True)
    accepted_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    delivered_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    failed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)


class SmsEvent(TenantMixin, Base):
    __tablename__ = "sms_events"
    __table_args__ = (
        Index("ix_sms_events_campaign_type_time", "campaign_id", "type", "occurred_at"),
        UniqueConstraint("provider", "provider_event_id", name="uq_sms_events_provider_event"),
    )

    id: Mapped[str] = uuid_pk()
    campaign_id: Mapped[str] = mapped_column(ForeignKey("sms_campaigns.id", ondelete="CASCADE"), nullable=False)
    message_id: Mapped[str] = mapped_column(ForeignKey("sms_messages.id", ondelete="CASCADE"), nullable=False)
    contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    type: Mapped[str] = mapped_column(String(20), nullable=False)  # accepted|delivered|undelivered|failed|deferred
    provider: Mapped[str | None] = mapped_column(String(20), nullable=True)
    provider_event_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    meta: Mapped[dict] = mapped_column("metadata", JSON, nullable=False, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class SmsInbound(TenantMixin, Base):
    """Replies received (used for STOP/HELP keywords). Body is kept short-lived for opt-out audit."""

    __tablename__ = "sms_inbound"
    __table_args__ = (Index("ix_sms_inbound_app_time", "application_id", "received_at"),)

    id: Mapped[str] = uuid_pk()
    from_phone: Mapped[str] = mapped_column(String(20), nullable=False)
    to_sender: Mapped[str | None] = mapped_column(String(20), nullable=True)
    body: Mapped[str] = mapped_column(String(320), nullable=False)
    keyword: Mapped[str | None] = mapped_column(String(20), nullable=True)  # stop|start|help
    contacts_updated: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    provider: Mapped[str | None] = mapped_column(String(20), nullable=True)
    provider_event_id: Mapped[str | None] = mapped_column(String(128), nullable=True, unique=True)
    received_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
