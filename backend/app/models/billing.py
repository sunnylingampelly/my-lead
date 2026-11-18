"""Billing: one wallet per organization, an append-only ledger, holds for running campaigns and
usage settlement records."""
from datetime import datetime

from sqlalchemy import JSON, ForeignKey, Index, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UTCDateTime, uuid_pk
from app.utils.time import utcnow


class Wallet(TimestampMixin, Base):
    __tablename__ = "wallets"

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False,
                                                 unique=True)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)  # INR | USD
    # Cached sum of the ledger, updated in the same transaction as every ledger entry.
    balance: Mapped[float] = mapped_column(Numeric(14, 4), nullable=False, default=0)
    low_balance_threshold: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    low_balance_notified_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class WalletTransaction(Base):
    """Append-only. Credits are positive, debits negative. Never updated or deleted."""

    __tablename__ = "wallet_transactions"
    __table_args__ = (
        UniqueConstraint("wallet_id", "idempotency_key", name="uq_wallet_tx_idempotency"),
        Index("ix_wallet_tx_wallet_time", "wallet_id", "created_at"),
        Index("ix_wallet_tx_app_time", "application_id", "created_at"),
    )

    id: Mapped[str] = uuid_pk()
    wallet_id: Mapped[str] = mapped_column(ForeignKey("wallets.id", ondelete="CASCADE"), nullable=False)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    application_id: Mapped[str | None] = mapped_column(ForeignKey("applications.id", ondelete="SET NULL"), nullable=True)
    # trial_credit | test_credit | credit | usage | adjustment | refund
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    channel: Mapped[str | None] = mapped_column(String(10), nullable=True)  # email|sms|voice for usage
    amount: Mapped[float] = mapped_column(Numeric(14, 4), nullable=False)
    balance_after: Mapped[float] = mapped_column(Numeric(14, 4), nullable=False)
    reference_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    reference_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    description: Mapped[str] = mapped_column(String(255), nullable=False)
    meta: Mapped[dict] = mapped_column("metadata", JSON, nullable=False, default=dict)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class WalletHold(Base):
    """Funds set aside for a running campaign so concurrent launches cannot overspend."""

    __tablename__ = "wallet_holds"
    __table_args__ = (UniqueConstraint("reference_type", "reference_id", name="uq_wallet_hold_ref"),
                      Index("ix_wallet_holds_wallet_status", "wallet_id", "status"))

    id: Mapped[str] = uuid_pk()
    wallet_id: Mapped[str] = mapped_column(ForeignKey("wallets.id", ondelete="CASCADE"), nullable=False)
    application_id: Mapped[str | None] = mapped_column(ForeignKey("applications.id", ondelete="SET NULL"), nullable=True)
    reference_type: Mapped[str] = mapped_column(String(30), nullable=False)  # email_campaign|sms_campaign|voice_campaign
    reference_id: Mapped[str] = mapped_column(String(36), nullable=False)
    description: Mapped[str] = mapped_column(String(255), nullable=False)
    amount: Mapped[float] = mapped_column(Numeric(14, 4), nullable=False)  # in wallet currency
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="open")  # open|released
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    released_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class UsageSettlement(Base):
    """How much of a campaign's usage has been charged so far (in wallet currency)."""

    __tablename__ = "usage_settlements"
    __table_args__ = (UniqueConstraint("channel", "campaign_id", name="uq_usage_settlement_campaign"),)

    id: Mapped[str] = uuid_pk()
    wallet_id: Mapped[str] = mapped_column(ForeignKey("wallets.id", ondelete="CASCADE"), nullable=False)
    channel: Mapped[str] = mapped_column(String(10), nullable=False)
    campaign_id: Mapped[str] = mapped_column(String(36), nullable=False)
    charged: Mapped[float] = mapped_column(Numeric(14, 4), nullable=False, default=0)
    final: Mapped[bool] = mapped_column(nullable=False, default=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)
