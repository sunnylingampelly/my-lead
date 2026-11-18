from sqlalchemy import JSON, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, SoftDeleteMixin, TimestampMixin, uuid_pk


class Application(TimestampMixin, SoftDeleteMixin, Base):
    """A tenant workspace inside an organization. Every audience and campaign record is scoped
    by (organization_id, application_id)."""

    __tablename__ = "applications"
    __table_args__ = (
        UniqueConstraint("organization_id", "slug", name="uq_applications_org_slug"),
        Index("ix_applications_org_deleted", "organization_id", "deleted_at"),
    )

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    slug: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    color: Mapped[str] = mapped_column(String(16), nullable=False, default="indigo")
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="UTC")
    default_country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    settings: Mapped["ApplicationSettings"] = relationship(
        back_populates="application", uselist=False, cascade="all, delete-orphan"
    )


class ApplicationSettings(TimestampMixin, Base):
    __tablename__ = "application_settings"

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    application_id: Mapped[str] = mapped_column(
        ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    # How duplicate contacts are detected: "email", "phone" or "email_or_phone".
    contact_identity_rule: Mapped[str] = mapped_column(String(20), nullable=False, default="email_or_phone")
    default_email_provider: Mapped[str] = mapped_column(String(30), nullable=False, default="simulation")
    default_sms_provider: Mapped[str] = mapped_column(String(30), nullable=False, default="simulation")
    default_voice_provider: Mapped[str] = mapped_column(String(30), nullable=False, default="simulation")
    quiet_hours_start: Mapped[str] = mapped_column(String(5), nullable=False, default="21:00")
    quiet_hours_end: Mapped[str] = mapped_column(String(5), nullable=False, default="09:00")
    # Legal sender identity. A physical postal address is mandatory in US commercial email (CAN-SPAM).
    business_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    business_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    extra: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

    application: Mapped[Application] = relationship(back_populates="settings")


class ApplicationMember(TimestampMixin, Base):
    """Grants a non-org-wide member access to an application. role_key optionally overrides
    the member's organization role for this application (it may never exceed it)."""

    __tablename__ = "application_members"
    __table_args__ = (
        UniqueConstraint("application_id", "user_id", name="uq_app_members_app_user"),
        Index("ix_app_members_user", "user_id"),
    )

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role_key: Mapped[str | None] = mapped_column(ForeignKey("roles.key"), nullable=True)
