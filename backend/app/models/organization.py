from datetime import datetime

from sqlalchemy import JSON, Boolean, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, SoftDeleteMixin, TimestampMixin, UTCDateTime, uuid_pk


class Role(Base):
    """System roles. Seeded by migration; mirrors app.core.permissions."""

    __tablename__ = "roles"

    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    rank: Mapped[int] = mapped_column(nullable=False)
    is_org_wide: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Permission(Base):
    __tablename__ = "permissions"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    description: Mapped[str] = mapped_column(String(255), nullable=False)


class RolePermission(Base):
    __tablename__ = "role_permissions"

    role_key: Mapped[str] = mapped_column(ForeignKey("roles.key", ondelete="CASCADE"), primary_key=True)
    permission_key: Mapped[str] = mapped_column(ForeignKey("permissions.key", ondelete="CASCADE"), primary_key=True)


class Organization(TimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "organizations"

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    slug: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")  # active | suspended
    industry: Mapped[str | None] = mapped_column(String(80), nullable=True)
    website: Mapped[str | None] = mapped_column(String(255), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    members: Mapped[list["OrganizationMember"]] = relationship(back_populates="organization")


class OrganizationMember(TimestampMixin, Base):
    __tablename__ = "organization_members"
    __table_args__ = (
        UniqueConstraint("organization_id", "user_id", name="uq_org_members_org_user"),
        Index("ix_org_members_user", "user_id"),
    )

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role_key: Mapped[str] = mapped_column(ForeignKey("roles.key"), nullable=False)
    invited_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    organization: Mapped[Organization] = relationship(back_populates="members")
    user = relationship("User", foreign_keys=[user_id])


class Invitation(TimestampMixin, Base):
    __tablename__ = "invitations"
    __table_args__ = (Index("ix_invitations_org_email", "organization_id", "email"),)

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    role_key: Mapped[str] = mapped_column(ForeignKey("roles.key"), nullable=False)
    # Application ids the invitee gets access to (ignored for org-wide roles).
    application_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")  # pending|accepted|revoked
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    accepted_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    invited_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    organization: Mapped[Organization] = relationship()
