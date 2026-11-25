"""Lead forms: forms built in the app and embedded on customers' websites, their published versions,
submissions and daily view/start/submission counts.

The builder edits `draft`. Publishing snapshots the draft into a LeadFormVersion and copies it to
`published` so the public embed always serves the published definition, never a half-edited one.
Every table is tenant-scoped.
"""
from datetime import date, datetime

from sqlalchemy import JSON, Date, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.audience import TenantMixin
from app.models.base import Base, JSONText, TimestampMixin, UTCDateTime, uuid_pk
from app.utils.time import utcnow


class LeadForm(TenantMixin, TimestampMixin, Base):
    __tablename__ = "lead_forms"
    __table_args__ = (
        UniqueConstraint("public_id", name="uq_lead_forms_public_id"),
        Index("ix_lead_forms_app_updated", "application_id", "updated_at"),
    )

    id: Mapped[str] = uuid_pk()
    # Short random id used in embed codes and hosted links (never the primary key).
    public_id: Mapped[str] = mapped_column(String(24), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    template: Mapped[str | None] = mapped_column(String(40), nullable=True)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="draft")  # draft|published|paused
    draft: Mapped[dict] = mapped_column(JSONText(), nullable=False)
    published: Mapped[dict | None] = mapped_column(JSONText(), nullable=True)
    published_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_submission_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class LeadFormVersion(Base):
    """An immutable snapshot of a published definition."""

    __tablename__ = "lead_form_versions"
    __table_args__ = (UniqueConstraint("form_id", "version", name="uq_lead_form_versions_form_version"),)

    id: Mapped[str] = uuid_pk()
    form_id: Mapped[str] = mapped_column(ForeignKey("lead_forms.id", ondelete="CASCADE"), nullable=False)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    definition: Mapped[dict] = mapped_column(JSONText(), nullable=False)
    published_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class LeadFormSubmission(TenantMixin, Base):
    __tablename__ = "lead_form_submissions"
    __table_args__ = (
        # Idempotency: a retried submission (same client id) is recognised, not stored twice.
        UniqueConstraint("form_id", "client_id", name="uq_lead_form_submissions_form_client"),
        Index("ix_lead_form_submissions_form_created", "form_id", "created_at"),
        Index("ix_lead_form_submissions_app_created", "application_id", "created_at"),
        Index("ix_lead_form_submissions_contact", "contact_id"),
    )

    id: Mapped[str] = uuid_pk()
    form_id: Mapped[str] = mapped_column(ForeignKey("lead_forms.id", ondelete="CASCADE"), nullable=False)
    form_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    client_id: Mapped[str] = mapped_column(String(64), nullable=False)
    contact_id: Mapped[str | None] = mapped_column(ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    deal_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # new | spam | pending_confirmation | confirmed
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="new")
    spam_reason: Mapped[str | None] = mapped_column(String(40), nullable=True)
    values: Mapped[dict] = mapped_column(JSONText(), nullable=False)
    page_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    referrer: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    utm: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    ip_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(400), nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class LeadFormDailyStat(Base):
    """Views, starts (first interaction) and submissions per form per UTC day. Cheap upserts."""

    __tablename__ = "lead_form_daily_stats"
    __table_args__ = (Index("ix_lead_form_daily_stats_app_day", "application_id", "day"),)

    form_id: Mapped[str] = mapped_column(ForeignKey("lead_forms.id", ondelete="CASCADE"), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), nullable=False)
    views: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    starts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    submissions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
