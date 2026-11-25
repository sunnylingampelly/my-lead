"""Voice: platform phone numbers, caller IDs, audio library, AI calling agents, campaigns, calls and events."""
from datetime import datetime

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.orm import Mapped, mapped_column

from app.models.audience import TenantMixin
from app.models.base import Base, JSONText, TimestampMixin, UTCDateTime, uuid_pk
from app.utils.time import utcnow


class PhoneNumber(TimestampMixin, Base):
    """A number the platform owns (bought from Twilio/Exotel/Telnyx). Platform inventory, never shown to
    customers: calls pick their caller number from the pool automatically (services/voice/numbers.py).
    available | retired. The organization/assignment/renewal columns are left from an earlier rental
    model and are no longer used."""

    __tablename__ = "phone_numbers"
    __table_args__ = (Index("ix_phone_numbers_pool", "status", "country", "kind"),
                      Index("ix_phone_numbers_renewal", "status", "next_renewal_at"))

    id: Mapped[str] = uuid_pk()
    number: Mapped[str] = mapped_column(String(20), nullable=False, unique=True)  # E.164
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # series_140|series_160|local|toll_free
    provider: Mapped[str] = mapped_column(String(20), nullable=False, default="simulation")
    provider_ref: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="available")
    organization_id: Mapped[str | None] = mapped_column(ForeignKey("organizations.id", ondelete="SET NULL"),
                                                        nullable=True, index=True)
    application_id: Mapped[str | None] = mapped_column(ForeignKey("applications.id", ondelete="SET NULL"),
                                                       nullable=True, index=True)
    assigned_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    next_renewal_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    # When the last renewal could not be charged (grace period runs from here).
    renewal_failed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    released_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    available_after: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    monthly_price: Mapped[float | None] = mapped_column(Numeric(12, 4), nullable=True)  # last charged, wallet currency
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    included: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)  # free under the plan


class VoiceCallerId(TenantMixin, TimestampMixin, Base):
    """A number calls come from. India: 140-series (promotional) or 160-series (service and
    transactional) numbers. US: a local or toll-free number the business owns (STIR/SHAKEN)."""

    __tablename__ = "voice_caller_ids"
    __table_args__ = (UniqueConstraint("application_id", "number", name="uq_voice_caller_app_number"),)

    id: Mapped[str] = uuid_pk()
    number: Mapped[str] = mapped_column(String(20), nullable=False)  # E.164
    label: Mapped[str | None] = mapped_column(String(80), nullable=True)
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # series_140|series_160|local|toll_free
    provider: Mapped[str] = mapped_column(String(20), nullable=False, default="simulation")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")  # pending|active
    attested_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    attested_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Numbers rented from the platform pool. Older rows (numbers users added themselves) have none.
    phone_number_id: Mapped[str | None] = mapped_column(ForeignKey("phone_numbers.id", ondelete="SET NULL"),
                                                        nullable=True, index=True)


class VoiceAudio(TenantMixin, TimestampMixin, Base):
    """A recorded message (uploaded MP3/WAV) or a text-to-speech script spoken by the provider."""

    __tablename__ = "voice_audio"

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[str] = mapped_column(String(10), nullable=False)  # upload|tts
    storage_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    content_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Numeric(8, 2), nullable=True)
    tts_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    tts_language: Mapped[str | None] = mapped_column(String(10), nullable=True)  # en-IN, hi-IN, en-US...
    tts_voice: Mapped[str | None] = mapped_column(String(20), nullable=True)  # female|male
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class VoiceAgent(TenantMixin, TimestampMixin, Base):
    """An AI calling agent a user teaches: what it says first, how it behaves, what it knows and what
    it should capture from each conversation."""

    __tablename__ = "voice_agents"
    __table_args__ = (Index("ix_voice_agents_app_status", "application_id", "status"),)

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")  # draft|active
    template: Mapped[str | None] = mapped_column(String(40), nullable=True)
    language: Mapped[str] = mapped_column(String(10), nullable=False, default="en-IN")
    voice: Mapped[str] = mapped_column(String(10), nullable=False, default="female")
    goal: Mapped[str | None] = mapped_column(String(300), nullable=True)
    greeting: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    instructions: Mapped[str] = mapped_column(Text, nullable=False, default="")
    knowledge: Mapped[str | None] = mapped_column(Text().with_variant(LONGTEXT(), "mysql"), nullable=True)  # ~60k chars
    outcome_fields: Mapped[list] = mapped_column(JSONText(), nullable=False, default=list)
    transfer_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    max_call_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class VoiceCampaign(TenantMixin, TimestampMixin, Base):
    __tablename__ = "voice_campaigns"
    __table_args__ = (Index("ix_voice_campaigns_app_status", "application_id", "status"),
                      Index("ix_voice_campaigns_due", "status", "scheduled_at"))

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    category: Mapped[str] = mapped_column(String(20), nullable=False, default="promotional")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    caller_ref: Mapped[str | None] = mapped_column(ForeignKey("voice_caller_ids.id", ondelete="SET NULL"), nullable=True)
    audio_id: Mapped[str | None] = mapped_column(ForeignKey("voice_audio.id", ondelete="SET NULL"), nullable=True)
    # audio|tts|ai_agent. Older rows are derived from their audio (see campaigns.message_type_of).
    message_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    agent_id: Mapped[str | None] = mapped_column(ForeignKey("voice_agents.id", ondelete="SET NULL"), nullable=True)
    # Spoken before the message: who is calling (TCPA requires identifying the business up front).
    intro_text: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # "Press 9 to stop these calls." Required for US prerecorded marketing calls.
    opt_out_keypress: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    retry_delay_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    audience: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    scheduled_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    schedule_timezone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    provider: Mapped[str | None] = mapped_column(String(20), nullable=True)
    snapshot: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)  # caller + message frozen at launch
    recipient_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    excluded: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    estimated_cost: Mapped[float | None] = mapped_column(Numeric(14, 4), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    launched_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class VoiceCall(TenantMixin, Base):
    __tablename__ = "voice_calls"
    __table_args__ = (
        UniqueConstraint("campaign_id", "contact_id", name="uq_voice_calls_campaign_contact"),
        Index("ix_voice_calls_campaign_status", "campaign_id", "status"),
        Index("ix_voice_calls_provider_id", "provider", "provider_call_id"),
    )

    id: Mapped[str] = uuid_pk()
    campaign_id: Mapped[str] = mapped_column(ForeignKey("voice_campaigns.id", ondelete="CASCADE"), nullable=False)
    contact_id: Mapped[str | None] = mapped_column(ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    to_phone: Mapped[str] = mapped_column(String(20), nullable=False)
    # The Signalcraft pool number this call was placed from (picked at dial time).
    from_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    # queued|deferred|dialing|ringing|in_progress|completed|no_answer|busy|voicemail|failed|skipped
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued")
    provider: Mapped[str | None] = mapped_column(String(20), nullable=True)
    provider_call_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    deferred_reason: Mapped[str | None] = mapped_column(String(80), nullable=True)
    answered_by: Mapped[str | None] = mapped_column(String(20), nullable=True)  # human|machine
    answered_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    duration_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    billable_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost: Mapped[float | None] = mapped_column(Numeric(12, 4), nullable=True)
    digits: Mapped[str | None] = mapped_column(String(10), nullable=True)
    opted_out: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # AI-agent calls: the conversation and what was captured from it.
    agent_id: Mapped[str | None] = mapped_column(ForeignKey("voice_agents.id", ondelete="SET NULL"), nullable=True)
    transcript: Mapped[list | None] = mapped_column(JSONText(), nullable=True)  # [{role, text, at}]
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_sentiment: Mapped[str | None] = mapped_column(String(20), nullable=True)
    ai_interest: Mapped[str | None] = mapped_column(String(20), nullable=True)
    ai_outcomes: Mapped[dict | None] = mapped_column(JSONText(), nullable=True)
    ai_next_step: Mapped[str | None] = mapped_column(String(500), nullable=True)
    ai_processed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)


class VoiceEvent(TenantMixin, Base):
    __tablename__ = "voice_events"
    __table_args__ = (
        Index("ix_voice_events_campaign_type_time", "campaign_id", "type", "occurred_at"),
        UniqueConstraint("provider", "provider_event_id", name="uq_voice_events_provider_event"),
    )

    id: Mapped[str] = uuid_pk()
    campaign_id: Mapped[str] = mapped_column(ForeignKey("voice_campaigns.id", ondelete="CASCADE"), nullable=False)
    call_id: Mapped[str] = mapped_column(ForeignKey("voice_calls.id", ondelete="CASCADE"), nullable=False)
    contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    provider: Mapped[str | None] = mapped_column(String(20), nullable=True)
    provider_event_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    meta: Mapped[dict] = mapped_column("metadata", JSON, nullable=False, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
