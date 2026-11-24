"""Audience: contacts, custom attributes, tags, lists, segments, imports, consent, suppression.

Every table is tenant-scoped by (organization_id, application_id).
"""
from datetime import datetime

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UTCDateTime, uuid_pk
from app.utils.time import utcnow


class TenantMixin:
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), nullable=False)


class ContactAttributeDefinition(TenantMixin, TimestampMixin, Base):
    """Per-application custom field definitions. Values live in contacts.attributes."""

    __tablename__ = "contact_custom_attributes"
    __table_args__ = (UniqueConstraint("application_id", "key", name="uq_contact_attr_app_key"),)

    id: Mapped[str] = uuid_pk()
    key: Mapped[str] = mapped_column(String(60), nullable=False)
    label: Mapped[str] = mapped_column(String(100), nullable=False)
    data_type: Mapped[str] = mapped_column(String(20), nullable=False)  # text|number|date|boolean|select
    options: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)


class Contact(TenantMixin, TimestampMixin, Base):
    __tablename__ = "contacts"
    __table_args__ = (
        # Identity keys are only populated for the identifiers the application's rule uses, so
        # NULLs (missing email/phone) never collide.
        UniqueConstraint("application_id", "email_key", name="uq_contacts_app_email_key"),
        UniqueConstraint("application_id", "phone_key", name="uq_contacts_app_phone_key"),
        Index("ix_contacts_app_created", "application_id", "created_at"),
        Index("ix_contacts_app_status", "application_id", "status"),
        Index("ix_contacts_app_email", "application_id", "email"),
        Index("ix_contacts_app_phone", "application_id", "phone"),
        Index("ix_contacts_app_city", "application_id", "city"),
        Index("ix_contacts_app_country_state", "application_id", "country", "state"),
        Index("ix_contacts_app_last_activity", "application_id", "last_activity_at"),
        Index("ix_contacts_email_hash", "application_id", "email_hash"),
        Index("ix_contacts_phone_hash", "application_id", "phone_hash"),
        Index("ix_contacts_app_owner", "application_id", "owner_id"),
        Index("ix_contacts_app_lead_score", "application_id", "lead_score"),
        Index("ix_contacts_company", "company_id"),
        Index("ix_contacts_app_sla_due", "application_id", "sla_due_at"),
    )

    id: Mapped[str] = uuid_pk()
    first_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    email_key: Mapped[str | None] = mapped_column(String(320), nullable=True)
    email_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True)  # E.164
    phone_key: Mapped[str | None] = mapped_column(String(20), nullable=True)
    phone_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    phone_country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    phone_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    company: Mapped[str | None] = mapped_column(String(200), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    state: Mapped[str | None] = mapped_column(String(100), nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    postal_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    timezone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source: Mapped[str | None] = mapped_column(String(60), nullable=True)
    # active | unsubscribed | bounced | blocked
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    email_consent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sms_consent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    voice_consent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    email_unsubscribed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    sms_unsubscribed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    voice_unsubscribed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    attributes: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    last_activity_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_via_import_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # CRM
    company_id: Mapped[str | None] = mapped_column(ForeignKey("crm_companies.id", ondelete="SET NULL"), nullable=True)
    owner_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    lifecycle_stage: Mapped[str] = mapped_column(String(20), nullable=False, default="lead")
    fit_score: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    engagement_score: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lead_score: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sla_due_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    first_response_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    sla_breached_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    tags: Mapped[list["Tag"]] = relationship(secondary="contact_tags", lazy="selectin", viewonly=True)

    @property
    def full_name(self) -> str:
        return " ".join(p for p in (self.first_name, self.last_name) if p) or ""


class Tag(TenantMixin, TimestampMixin, Base):
    __tablename__ = "tags"
    __table_args__ = (UniqueConstraint("application_id", "name", name="uq_tags_app_name"),)

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    color: Mapped[str] = mapped_column(String(16), nullable=False, default="slate")


class ContactTag(Base):
    __tablename__ = "contact_tags"
    __table_args__ = (Index("ix_contact_tags_tag", "tag_id"),)

    contact_id: Mapped[str] = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), primary_key=True)
    tag_id: Mapped[str] = mapped_column(ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class ContactList(TenantMixin, TimestampMixin, Base):
    """A static list. (Table name 'lists'; membership in 'contact_lists'.)"""

    __tablename__ = "lists"
    __table_args__ = (UniqueConstraint("application_id", "name", name="uq_lists_app_name"),)

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class ContactListMember(Base):
    __tablename__ = "contact_lists"
    __table_args__ = (Index("ix_contact_lists_list", "list_id"),)

    contact_id: Mapped[str] = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), primary_key=True)
    list_id: Mapped[str] = mapped_column(ForeignKey("lists.id", ondelete="CASCADE"), primary_key=True)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class Segment(TenantMixin, TimestampMixin, Base):
    """A dynamic audience defined by validated JSON rules; membership is computed at query time."""

    __tablename__ = "segments"
    __table_args__ = (UniqueConstraint("application_id", "name", name="uq_segments_app_name"),)

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    rules: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    last_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_counted_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Import(TenantMixin, TimestampMixin, Base):
    __tablename__ = "imports"
    __table_args__ = (Index("ix_imports_app_created", "application_id", "created_at"),)

    id: Mapped[str] = uuid_pk()
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)  # display only, never a path
    file_key: Mapped[str] = mapped_column(String(255), nullable=False)
    file_type: Mapped[str] = mapped_column(String(10), nullable=False)  # csv|xlsx
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    columns: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    preview: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    mapping: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    options: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # uploaded -> queued -> processing -> completed | failed | cancelled
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="uploaded")
    total_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    processed_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    duplicate_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    invalid_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class ImportRow(Base):
    """One outcome per source row. The unique (import_id, row_number) makes processing restart-safe."""

    __tablename__ = "import_rows"
    __table_args__ = (
        UniqueConstraint("import_id", "row_number", name="uq_import_rows_import_row"),
        Index("ix_import_rows_import_status", "import_id", "status"),
    )

    id: Mapped[str] = uuid_pk()
    import_id: Mapped[str] = mapped_column(ForeignKey("imports.id", ondelete="CASCADE"), nullable=False)
    row_number: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # created|updated|duplicate|skipped|invalid|failed
    contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Raw values are kept only for rows that were not imported, so they can be fixed and re-uploaded.
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class ConsentRecord(TenantMixin, Base):
    """Append-only consent history: who agreed to what, when, how, and the evidence."""

    __tablename__ = "consent_records"
    __table_args__ = (Index("ix_consent_records_contact", "contact_id", "created_at"),)

    id: Mapped[str] = uuid_pk()
    contact_id: Mapped[str] = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), nullable=False)
    channel: Mapped[str] = mapped_column(String(10), nullable=False)  # email|sms|voice
    status: Mapped[str] = mapped_column(String(10), nullable=False)  # granted|revoked
    method: Mapped[str] = mapped_column(String(30), nullable=False)  # import|manual|api|form|unsubscribe_link|keyword
    source: Mapped[str | None] = mapped_column(String(255), nullable=True)
    evidence: Mapped[str | None] = mapped_column(Text, nullable=True)
    consent_reference: Mapped[str | None] = mapped_column(String(120), nullable=True)  # e.g. DLT consent template id
    jurisdiction: Mapped[str | None] = mapped_column(String(2), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    recorded_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    import_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class SuppressionEntry(TenantMixin, Base):
    """Addresses that must never be messaged on a channel. Matched by hash so entries survive
    contact deletion (erasure) without keeping the raw identifier."""

    __tablename__ = "suppression_entries"
    __table_args__ = (
        UniqueConstraint("application_id", "channel", "value_hash", name="uq_suppression_app_channel_hash"),
        Index("ix_suppression_app_created", "application_id", "created_at"),
    )

    id: Mapped[str] = uuid_pk()
    channel: Mapped[str] = mapped_column(String(10), nullable=False)  # email|sms|voice
    value_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    value_masked: Mapped[str] = mapped_column(String(120), nullable=False)
    reason: Mapped[str] = mapped_column(String(20), nullable=False)  # unsubscribed|bounced|complaint|manual|dnd|invalid
    source: Mapped[str | None] = mapped_column(String(120), nullable=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class ContactActivity(TenantMixin, Base):
    __tablename__ = "contact_activities"
    __table_args__ = (
        Index("ix_contact_activities_contact", "contact_id", "created_at"),
        Index("ix_contact_activities_app", "application_id", "created_at"),
    )

    id: Mapped[str] = uuid_pk()
    contact_id: Mapped[str] = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), nullable=False)
    type: Mapped[str] = mapped_column(String(40), nullable=False)
    description: Mapped[str] = mapped_column(String(255), nullable=False)
    meta: Mapped[dict] = mapped_column("metadata", JSON, nullable=False, default=dict)
    actor_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
