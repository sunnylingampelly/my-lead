"""Time-limited, read-only access for platform staff to a customer's organization."""
from datetime import datetime

from sqlalchemy import ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UTCDateTime, uuid_pk
from app.utils.time import utcnow


class SupportGrant(Base):
    __tablename__ = "support_grants"
    __table_args__ = (Index("ix_support_grants_user_org", "user_id", "organization_id", "expires_at"),)

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    reason: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
