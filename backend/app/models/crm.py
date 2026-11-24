"""CRM: companies, pipelines and stages, deals, tasks, notes, logged activities, assignment and
scoring rules, per-application CRM settings, and the CRM event log that drives automation triggers.

Contacts gain CRM columns (company, owner, lifecycle stage, scores, first-response SLA) on the
contacts table itself (see models/audience.py). Every table here is tenant-scoped.
"""
from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.audience import TenantMixin
from app.models.base import Base, TimestampMixin, UTCDateTime, uuid_pk
from app.utils.time import utcnow

LIFECYCLE_STAGES = ("subscriber", "lead", "mql", "sql", "opportunity", "customer", "other")


class Company(TenantMixin, TimestampMixin, Base):
    __tablename__ = "crm_companies"
    __table_args__ = (
        Index("ix_crm_companies_app_name", "application_id", "name"),
        Index("ix_crm_companies_app_domain", "application_id", "domain"),
        Index("ix_crm_companies_app_gstin", "application_id", "gstin"),
        Index("ix_crm_companies_app_owner", "application_id", "owner_id"),
    )

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    domain: Mapped[str | None] = mapped_column(String(253), nullable=True)  # lower-case, no scheme or www
    industry: Mapped[str | None] = mapped_column(String(100), nullable=True)
    size: Mapped[str | None] = mapped_column(String(20), nullable=True)  # 1-10|11-50|51-200|201-1000|1000+
    annual_revenue: Mapped[float | None] = mapped_column(Numeric(16, 2), nullable=True)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True)  # E.164
    website: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # India: GSTIN (15 chars, state code + PAN + entity + Z + checksum), PAN and GST treatment.
    gstin: Mapped[str | None] = mapped_column(String(15), nullable=True)
    pan: Mapped[str | None] = mapped_column(String(10), nullable=True)
    gst_treatment: Mapped[str | None] = mapped_column(String(30), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    state: Mapped[str | None] = mapped_column(String(100), nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    address: Mapped[str | None] = mapped_column(String(500), nullable=True)
    postal_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    owner_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    attributes: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class Pipeline(TenantMixin, TimestampMixin, Base):
    __tablename__ = "crm_pipelines"
    __table_args__ = (UniqueConstraint("application_id", "name", name="uq_crm_pipelines_app_name"),)

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class PipelineStage(TimestampMixin, Base):
    __tablename__ = "crm_pipeline_stages"
    __table_args__ = (Index("ix_crm_stages_pipeline", "pipeline_id", "position"),)

    id: Mapped[str] = uuid_pk()
    pipeline_id: Mapped[str] = mapped_column(ForeignKey("crm_pipelines.id", ondelete="CASCADE"), nullable=False)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    probability: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # 0-100
    kind: Mapped[str] = mapped_column(String(10), nullable=False, default="open")  # open|won|lost
    rotting_days: Mapped[int | None] = mapped_column(Integer, nullable=True)  # None = never rots


class LostReason(TenantMixin, TimestampMixin, Base):
    __tablename__ = "crm_lost_reasons"
    __table_args__ = (UniqueConstraint("application_id", "name", name="uq_crm_lost_reasons_app_name"),)

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Deal(TenantMixin, TimestampMixin, Base):
    __tablename__ = "crm_deals"
    __table_args__ = (
        Index("ix_crm_deals_app_pipeline_stage", "application_id", "pipeline_id", "stage_id"),
        Index("ix_crm_deals_app_status_close", "application_id", "status", "expected_close_date"),
        Index("ix_crm_deals_app_owner", "application_id", "owner_id"),
        Index("ix_crm_deals_contact", "contact_id"),
        Index("ix_crm_deals_company", "company_id"),
    )

    id: Mapped[str] = uuid_pk()
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    pipeline_id: Mapped[str] = mapped_column(ForeignKey("crm_pipelines.id", ondelete="CASCADE"), nullable=False)
    stage_id: Mapped[str] = mapped_column(ForeignKey("crm_pipeline_stages.id", ondelete="RESTRICT"), nullable=False)
    amount: Mapped[float] = mapped_column(Numeric(16, 2), nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    probability: Mapped[int | None] = mapped_column(Integer, nullable=True)  # overrides the stage's
    expected_close_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="open")  # open|won|lost
    lost_reason_id: Mapped[str | None] = mapped_column(ForeignKey("crm_lost_reasons.id", ondelete="SET NULL"),
                                                       nullable=True)
    lost_note: Mapped[str | None] = mapped_column(String(500), nullable=True)
    source: Mapped[str | None] = mapped_column(String(60), nullable=True)
    owner_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    contact_id: Mapped[str | None] = mapped_column(ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    company_id: Mapped[str | None] = mapped_column(ForeignKey("crm_companies.id", ondelete="SET NULL"), nullable=True)
    stage_entered_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    last_activity_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    rotting_since: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # order within a stage
    attributes: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class DealContact(Base):
    """Additional people on a deal, with their role (decision maker, champion, ...)."""

    __tablename__ = "crm_deal_contacts"

    deal_id: Mapped[str] = mapped_column(ForeignKey("crm_deals.id", ondelete="CASCADE"), primary_key=True)
    contact_id: Mapped[str] = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), primary_key=True)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[str | None] = mapped_column(String(60), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class DealStageHistory(Base):
    __tablename__ = "crm_deal_stage_history"
    __table_args__ = (Index("ix_crm_stage_history_deal", "deal_id", "changed_at"),
                      Index("ix_crm_stage_history_app_time", "application_id", "changed_at"))

    id: Mapped[str] = uuid_pk()
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), nullable=False)
    deal_id: Mapped[str] = mapped_column(ForeignKey("crm_deals.id", ondelete="CASCADE"), nullable=False)
    from_stage_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    to_stage_id: Mapped[str] = mapped_column(String(36), nullable=False)
    changed_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    seconds_in_previous: Mapped[int | None] = mapped_column(Integer, nullable=True)
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class CrmTask(TenantMixin, TimestampMixin, Base):
    __tablename__ = "crm_tasks"
    __table_args__ = (
        Index("ix_crm_tasks_app_assignee_status_due", "application_id", "assignee_id", "status", "due_at"),
        Index("ix_crm_tasks_contact", "contact_id"),
        Index("ix_crm_tasks_deal", "deal_id"),
    )

    id: Mapped[str] = uuid_pk()
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    type: Mapped[str] = mapped_column(String(20), nullable=False, default="todo")  # call|email|meeting|follow_up|todo
    priority: Mapped[str] = mapped_column(String(10), nullable=False, default="normal")  # low|normal|high
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="open")  # open|done
    due_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    assignee_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    contact_id: Mapped[str | None] = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), nullable=True)
    deal_id: Mapped[str | None] = mapped_column(ForeignKey("crm_deals.id", ondelete="CASCADE"), nullable=True)
    company_id: Mapped[str | None] = mapped_column(ForeignKey("crm_companies.id", ondelete="CASCADE"), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    reminded_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class CrmNote(TenantMixin, TimestampMixin, Base):
    __tablename__ = "crm_notes"
    __table_args__ = (Index("ix_crm_notes_contact", "contact_id", "created_at"),
                      Index("ix_crm_notes_deal", "deal_id", "created_at"),
                      Index("ix_crm_notes_company", "company_id", "created_at"))

    id: Mapped[str] = uuid_pk()
    body: Mapped[str] = mapped_column(Text, nullable=False)
    pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    mentions: Mapped[list] = mapped_column(JSON, nullable=False, default=list)  # user ids
    author_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    contact_id: Mapped[str | None] = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), nullable=True)
    deal_id: Mapped[str | None] = mapped_column(ForeignKey("crm_deals.id", ondelete="CASCADE"), nullable=True)
    company_id: Mapped[str | None] = mapped_column(ForeignKey("crm_companies.id", ondelete="CASCADE"), nullable=True)


class CrmActivity(TenantMixin, Base):
    """Logged sales activity (call, meeting, email, WhatsApp...) and system events (stage moved,
    owner changed, deal won). Campaign email/SMS/voice events are read from their own tables."""

    __tablename__ = "crm_activities"
    __table_args__ = (Index("ix_crm_activities_contact", "contact_id", "occurred_at"),
                      Index("ix_crm_activities_deal", "deal_id", "occurred_at"),
                      Index("ix_crm_activities_company", "company_id", "occurred_at"),
                      Index("ix_crm_activities_app_actor_time", "application_id", "actor_user_id", "occurred_at"))

    id: Mapped[str] = uuid_pk()
    type: Mapped[str] = mapped_column(String(30), nullable=False)  # call|meeting|email|whatsapp|sms|other|system
    subject: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    outcome: Mapped[str | None] = mapped_column(String(40), nullable=True)
    duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    actor_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    contact_id: Mapped[str | None] = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), nullable=True)
    deal_id: Mapped[str | None] = mapped_column(ForeignKey("crm_deals.id", ondelete="CASCADE"), nullable=True)
    company_id: Mapped[str | None] = mapped_column(ForeignKey("crm_companies.id", ondelete="CASCADE"), nullable=True)
    meta: Mapped[dict] = mapped_column("metadata", JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class AssignmentRule(TenantMixin, TimestampMixin, Base):
    """Round-robin owner assignment for new contacts that match the conditions. Rules are tried in
    `position` order; the first match assigns."""

    __tablename__ = "crm_assignment_rules"

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # {"source": "indiamart", "country": "IN", "state": "...", "segment_id": "..."}; empty = every new contact
    conditions: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    user_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    max_open_per_user: Mapped[int | None] = mapped_column(Integer, nullable=True)
    next_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    assigned_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class ScoringRule(TenantMixin, TimestampMixin, Base):
    """kind=fit: points when a contact field matches. kind=engagement: points per event in the window."""

    __tablename__ = "crm_scoring_rules"

    id: Mapped[str] = uuid_pk()
    kind: Mapped[str] = mapped_column(String(12), nullable=False)  # fit|engagement
    field: Mapped[str | None] = mapped_column(String(60), nullable=True)
    operator: Mapped[str | None] = mapped_column(String(12), nullable=True)  # eq|neq|contains|set|not_set
    value: Mapped[str | None] = mapped_column(String(200), nullable=True)
    event: Mapped[str | None] = mapped_column(String(30), nullable=True)
    points: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_points: Mapped[int | None] = mapped_column(Integer, nullable=True)  # cap for repeated events
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class CrmSettings(Base):
    __tablename__ = "crm_settings"

    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), primary_key=True)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    engagement_window_days: Mapped[int] = mapped_column(Integer, nullable=False, default=30)
    hot_score_threshold: Mapped[int] = mapped_column(Integer, nullable=False, default=50)
    sla_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sla_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    assignment_cursor: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    scored_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)


class CrmEvent(TenantMixin, Base):
    """Things that happened in the CRM, kept for automation triggers and reports. Append-only."""

    __tablename__ = "crm_events"
    __table_args__ = (Index("ix_crm_events_app_kind_time", "application_id", "kind", "created_at"),)

    id: Mapped[str] = uuid_pk()
    # deal_created|deal_stage_changed|deal_won|deal_lost|deal_rotting|score_reached|sla_breached|owner_assigned
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    deal_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
