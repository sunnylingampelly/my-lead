"""Wallet top-ups through a payment provider's hosted page, the organization's billing (tax) profile and the
GST tax invoices issued for confirmed payments."""
from datetime import datetime

from sqlalchemy import JSON, ForeignKey, Index, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UTCDateTime, uuid_pk
from app.utils.time import utcnow


class Payment(TimestampMixin, Base):
    __tablename__ = "payments"
    __table_args__ = (UniqueConstraint("provider", "provider_ref", name="uq_payments_provider_ref"),
                      Index("ix_payments_org_time", "organization_id", "created_at"))

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)  # stripe | razorpay
    # The wallet credit (taxable value). The customer pays gross_amount = amount + tax_amount.
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    tax_amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0, server_default="0")
    gross_amount: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)  # None on older rows: = amount
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")  # pending|paid|failed|expired
    provider_ref: Mapped[str | None] = mapped_column(String(128), nullable=True)
    checkout_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # meta["tax"]: the GST breakdown and buyer snapshot fixed at checkout, used for the invoice.
    meta: Mapped[dict] = mapped_column("metadata", JSON, nullable=False, default=dict)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class BillingProfile(TimestampMixin, Base):
    """Who invoices are made out to. Required before an organization's first INR top-up."""

    __tablename__ = "billing_profiles"

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False,
                                                 unique=True)
    legal_name: Mapped[str] = mapped_column(String(200), nullable=False)
    gstin: Mapped[str | None] = mapped_column(String(15), nullable=True)  # None: unregistered (B2C)
    address: Mapped[str] = mapped_column(String(500), nullable=False)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    state_code: Mapped[str | None] = mapped_column(String(2), nullable=True)  # GST state code (India)
    pin_code: Mapped[str | None] = mapped_column(String(10), nullable=True)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default="IN")
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    # UAE buyers: Tax Registration Number (15 digits, starts with 100) and emirate. Invoices are reverse charge.
    trn: Mapped[str | None] = mapped_column(String(15), nullable=True)
    emirate: Mapped[str | None] = mapped_column(String(40), nullable=True)
    updated_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class InvoiceSequence(Base):
    """The last number used per series and Indian financial year. Incremented under a row lock in the same
    transaction that confirms the payment, so numbers are gap-free and unique."""

    __tablename__ = "invoice_sequences"

    series: Mapped[str] = mapped_column(String(12), primary_key=True)  # invoice | credit_note
    financial_year: Mapped[str] = mapped_column(String(7), primary_key=True)  # 2026-27
    last_number: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class Invoice(Base):
    """An issued tax invoice (or credit note). Immutable: every value printed on the PDF is stored here, and the
    PDF is regenerated from these values. Kept if the organization is deleted (tax records)."""

    __tablename__ = "invoices"
    __table_args__ = (UniqueConstraint("number", name="uq_invoices_number"),
                      UniqueConstraint("payment_id", "doc_type", name="uq_invoices_payment_doc"),
                      Index("ix_invoices_org_issued", "organization_id", "issued_at"))

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str | None] = mapped_column(ForeignKey("organizations.id", ondelete="SET NULL"),
                                                        nullable=True)
    payment_id: Mapped[str | None] = mapped_column(ForeignKey("payments.id", ondelete="SET NULL"), nullable=True)
    doc_type: Mapped[str] = mapped_column(String(12), nullable=False, default="invoice")  # invoice | credit_note
    original_invoice_id: Mapped[str | None] = mapped_column(ForeignKey("invoices.id", ondelete="SET NULL"),
                                                            nullable=True)  # credit notes
    number: Mapped[str] = mapped_column(String(20), nullable=False)
    financial_year: Mapped[str] = mapped_column(String(7), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    issued_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    # intra_state (CGST+SGST/UTGST) | inter_state (IGST) | export_lut (zero-rated)
    tax_treatment: Mapped[str] = mapped_column(String(12), nullable=False)
    place_of_supply: Mapped[str] = mapped_column(String(80), nullable=False)
    sac: Mapped[str] = mapped_column(String(10), nullable=False)
    description: Mapped[str] = mapped_column(String(255), nullable=False)
    taxable_value: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    gst_rate: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    cgst: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    sgst: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)  # SGST or UTGST
    igst: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    total: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    seller: Mapped[dict] = mapped_column(JSON, nullable=False)  # snapshot: legal_name, gstin, address, state, pan, lut
    buyer: Mapped[dict] = mapped_column(JSON, nullable=False)  # snapshot of the billing profile
    payment_reference: Mapped[str | None] = mapped_column(String(160), nullable=True)
    emailed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
