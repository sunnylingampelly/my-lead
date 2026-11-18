"""Wallet top-ups through a payment provider's hosted page."""
from datetime import datetime

from sqlalchemy import JSON, ForeignKey, Index, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UTCDateTime, uuid_pk


class Payment(TimestampMixin, Base):
    __tablename__ = "payments"
    __table_args__ = (UniqueConstraint("provider", "provider_ref", name="uq_payments_provider_ref"),
                      Index("ix_payments_org_time", "organization_id", "created_at"))

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)  # stripe | razorpay
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")  # pending|paid|failed|expired
    provider_ref: Mapped[str | None] = mapped_column(String(128), nullable=True)
    checkout_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    meta: Mapped[dict] = mapped_column("metadata", JSON, nullable=False, default=dict)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
