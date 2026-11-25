from datetime import datetime

from sqlalchemy import JSON, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UTCDateTime, uuid_pk
from app.utils.time import utcnow


class AuditLog(Base):
    """Append-only record of security-relevant and administrative actions.
    Metadata must never contain secrets or full contact records."""

    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_org_created", "organization_id", "created_at"),
        Index("ix_audit_logs_app_created", "application_id", "created_at"),
        Index("ix_audit_logs_actor_created", "actor_user_id", "created_at"),
    )

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True
    )
    application_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    actor_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    target_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    target_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    summary: Mapped[str | None] = mapped_column(String(255), nullable=True)
    meta: Mapped[dict] = mapped_column("metadata", JSON, nullable=False, default=dict)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class DataRequest(Base):
    """Data-subject requests handled for a contact (DPDP Act 2023 / GDPR): exports and erasures.

    Holds no personal data: the contact is referenced by id only (which points nowhere once erased), and
    `subject_label` is a masked identifier that is itself blanked when the contact is erased."""

    __tablename__ = "data_requests"
    __table_args__ = (
        Index("ix_data_requests_org_created", "organization_id", "created_at"),
        Index("ix_data_requests_app_contact", "application_id", "contact_id"),
    )

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), nullable=False)
    contact_id: Mapped[str] = mapped_column(String(36), nullable=False)
    kind: Mapped[str] = mapped_column(String(10), nullable=False)  # export | erasure
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="completed")
    subject_label: Mapped[str | None] = mapped_column(String(120), nullable=True)
    requested_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # Counts only (rows exported / erased / anonymised per area). Never values.
    details: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
