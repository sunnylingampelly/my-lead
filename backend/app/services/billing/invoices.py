"""Billing profiles, checkout quotes, GST tax invoices for confirmed top-ups, and monthly usage statements.

* A tax invoice is issued only for a real payment confirmed by a provider webhook (payments.mark_paid), in
  the same transaction that credits the wallet. Simulation-mode test credit never produces one.
* Invoices are immutable rows: seller and buyer are snapshots, amounts are stored, and the PDF is rebuilt
  from those values (byte-identical every time).
* Plan fees and usage debited from the wallet are not taxed again; the monthly statement lists them and says
  it is not a tax invoice.
* Credit notes: payments cannot be refunded to the card from this platform yet (admins can only credit the
  wallet). TODO(refunds): when provider refunds are added, call issue_credit_note() from the refund webhook in
  the same transaction that records the refund; the series, numbering and PDF already support it.
"""
import csv
import io
import re
import unicodedata
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import NotFound, ValidationFailed
from app.core.permissions import Perm
from app.models import Organization, User
from app.models.billing import WalletTransaction
from app.models.payment import BillingProfile, Invoice, Payment
from app.schemas.common import Page, PageParams
from app.services import audit_service, uae
from app.services.billing import gst
from app.services.billing import wallet as wl
from app.utils.time import utcnow

PIN_RE = re.compile(r"^[1-9][0-9]{5}$")
COUNTRY_NAMES = {"AE": "United Arab Emirates"}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ------------------------------------------------------------------ billing profile

def get_profile_row(db: Session, organization_id: str) -> BillingProfile | None:
    return db.scalar(select(BillingProfile).where(BillingProfile.organization_id == organization_id))


def profile_out(p: BillingProfile | None) -> dict | None:
    if p is None:
        return None
    return {"legal_name": p.legal_name, "gstin": p.gstin, "address": p.address, "city": p.city,
            "state_code": p.state_code, "state": gst.STATES.get(p.state_code or "") or p.emirate,
            "pin_code": p.pin_code, "country": p.country, "email": p.email, "trn": p.trn, "emirate": p.emirate,
            "updated_at": p.updated_at.isoformat()}


def get_profile(db: Session, ctx) -> dict:
    ctx.require(Perm.BILLING_READ)
    w = wl.get_wallet(db, ctx.organization_id)
    db.commit()
    return {"profile": profile_out(get_profile_row(db, ctx.organization_id)), "currency": w.currency,
            "required": w.currency in ("INR", "AED"), "can_manage": ctx.has(Perm.BILLING_MANAGE),
            "states": [{"code": c, "name": n} for c, n in gst.STATES.items()],
            # UAE: VAT-registered businesses only (TRN), reverse charge.
            "trn_required": w.currency == "AED", "emirates": list(uae.EMIRATES)}


def _clean_profile(data: dict, currency: str) -> dict:
    from app.services.crm.companies import normalize_gstin

    def s(k: str, limit: int) -> str | None:
        v = (data.get(k) or "").strip()
        return v[:limit] if v else None

    out = {"legal_name": s("legal_name", 200), "address": s("address", 500), "city": s("city", 100),
           "pin_code": (s("pin_code", 10) or "").replace(" ", "") or None, "email": (s("email", 320) or "").lower(),
           "state_code": s("state_code", 2), "country": (s("country", 2) or ("IN" if currency == "INR" else "")).upper()}
    if not out["legal_name"]:
        raise ValidationFailed("Enter the legal name to put on invoices", code="INVALID_BILLING_PROFILE",
                               details={"field": "legal_name"})
    if not out["address"]:
        raise ValidationFailed("Enter the billing address", code="INVALID_BILLING_PROFILE", details={"field": "address"})
    if not EMAIL_RE.match(out["email"]):
        raise ValidationFailed("Enter a valid email for invoices", code="INVALID_BILLING_PROFILE",
                               details={"field": "email"})
    out["trn"], out["emirate"] = None, None
    if currency == "AED" or out["country"] == "AE":
        # UAE: VAT-registered businesses only. TRN and emirate are required; no GSTIN, no PIN code.
        out["country"], out["gstin"], out["state_code"] = "AE", None, None
        trn = uae.normalize_trn(data.get("trn"))
        if not uae.valid_trn(trn):
            raise ValidationFailed("Enter your 15-digit UAE Tax Registration Number (TRN); it starts with 100",
                                   code="INVALID_TRN", details={"field": "trn"})
        emirate = next((e for e in uae.EMIRATES if e.lower() == (data.get("emirate") or "").strip().lower()), None)
        if emirate is None:
            raise ValidationFailed("Choose the emirate", code="INVALID_BILLING_PROFILE", details={"field": "emirate"})
        out["trn"], out["emirate"] = trn, emirate
        return out
    out["gstin"] = normalize_gstin(data.get("gstin"))  # format + checksum (raises INVALID_GSTIN)
    if currency == "INR" or out["country"] == "IN":
        out["country"] = "IN"
        if out["state_code"] not in gst.STATES:
            raise ValidationFailed("Choose the state for the place of supply", code="INVALID_BILLING_PROFILE",
                                   details={"field": "state_code"})
        if not out["pin_code"] or not PIN_RE.match(out["pin_code"]):
            raise ValidationFailed("Enter a 6-digit PIN code", code="INVALID_BILLING_PROFILE",
                                   details={"field": "pin_code"})
        if out["gstin"] and out["gstin"][:2] != out["state_code"]:
            raise ValidationFailed(f"This GSTIN is registered in {gst.state_label(out['gstin'][:2])}; choose that "
                                   "state or use the GSTIN for this state", code="GSTIN_STATE_MISMATCH",
                                   details={"field": "gstin"})
    else:
        out["gstin"] = None  # GSTIN applies to Indian registrations only
        out["state_code"] = None
        if not re.fullmatch(r"[A-Z]{2}", out["country"] or ""):
            raise ValidationFailed("Choose the country", code="INVALID_BILLING_PROFILE", details={"field": "country"})
    return out


def save_profile(db: Session, ctx, data: dict) -> dict:
    ctx.require(Perm.BILLING_MANAGE)
    w = wl.get_wallet(db, ctx.organization_id)
    clean = _clean_profile(data, w.currency)
    p = get_profile_row(db, ctx.organization_id)
    if p is None:
        p = BillingProfile(organization_id=ctx.organization_id, **clean)
        db.add(p)
    else:
        for k, v in clean.items():
            setattr(p, k, v)
    p.updated_by_id = ctx.user.id
    db.flush()
    audit_service.record(db, "billing.profile_updated", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         target_type="billing_profile", target_id=p.id,
                         meta={"gstin": bool(p.gstin), "state_code": p.state_code, "trn": bool(p.trn)})
    return profile_out(p)


def buyer_snapshot(db: Session, organization_id: str, fallback_email: str | None = None) -> dict | None:
    p = get_profile_row(db, organization_id)
    if p is None:
        org = db.get(Organization, organization_id)
        if org is None:
            return None
        return {"legal_name": org.name, "gstin": None, "address": "", "city": None, "state_code": None,
                "state": None, "pin_code": None, "country": org.country or "", "email": fallback_email or "",
                "trn": None, "emirate": None}
    return {k: v for k, v in profile_out(p).items() if k != "updated_at"}


# ------------------------------------------------------------------ quotes

def quote(db: Session, ctx, amount: Decimal) -> dict:
    """What a top-up of `amount` costs, before paying: ₹1,000 + ₹180 GST = ₹1,180."""
    ctx.require(Perm.BILLING_READ)
    w = wl.get_wallet(db, ctx.organization_id)
    p = get_profile_row(db, ctx.organization_id)
    t = gst.split(amount, w.currency, p.state_code if p else None)
    aed = w.currency == "AED"
    trn_ok = bool(p and uae.valid_trn(p.trn))
    return {"currency": w.currency, "credit": float(t.taxable), "tax": float(t.tax), "total": float(t.total),
            "treatment": t.treatment, "rate": float(t.rate), "cgst": float(t.cgst), "sgst": float(t.sgst),
            "igst": float(t.igst), "sgst_label": t.sgst_label, "place_of_supply": t.place_of_supply,
            "profile_ready": (trn_ok if aed else (p is not None or w.currency != "INR")),
            # UAE: no tax lines; the customer accounts for UAE VAT under the reverse charge.
            "reverse_charge": aed, "trn_required": aed and not trn_ok,
            "trn_message": uae.TRN_REQUIRED if aed and not trn_ok else None}


def checkout_tax(db: Session, organization_id: str, currency: str, amount: Decimal, email: str | None
                 ) -> tuple[gst.TaxSplit, dict]:
    """GST and buyer snapshot fixed at checkout. INR needs the platform's GST registration and a profile;
    AED needs a billing profile with a valid UAE TRN (VAT-registered businesses only)."""
    p = get_profile_row(db, organization_id)
    if currency == "AED" and not (p and uae.valid_trn(p.trn)):
        raise ValidationFailed(uae.TRN_REQUIRED, code="UAE_TRN_REQUIRED", details={"field": "trn"})
    if currency == "INR":
        if not gst.seller_ready():
            raise ValidationFailed("Online payment in INR is not available yet: the platform's GST details are not "
                                   "configured. Contact support to add credit.", code="TAX_NOT_CONFIGURED")
        if p is None:
            raise ValidationFailed("Add your billing details first: GST invoices are made out to them.",
                                   code="BILLING_PROFILE_REQUIRED")
    t = gst.split(amount, currency, p.state_code if p else None)
    return t, buyer_snapshot(db, organization_id, email) or {}


# ------------------------------------------------------------------ issuing

def _new_doc(db: Session, organization_id: str | None, doc_type: str, at: datetime, **kw) -> Invoice:
    number, fy, n = gst.allocate_number(db, doc_type, at)
    inv = Invoice(organization_id=organization_id, doc_type=doc_type, number=number, financial_year=fy, sequence=n,
                  issued_at=at.replace(microsecond=0), sac=settings.INVOICE_SAC_CODE, **kw)
    db.add(inv)
    db.flush()
    return inv


def issue_for_payment(db: Session, p: Payment) -> Invoice:
    """The tax invoice for a confirmed top-up. Idempotent per payment. Call inside the transaction that credits
    the wallet (the number is allocated under a row lock and returned on rollback)."""
    existing = db.scalar(select(Invoice).where(Invoice.payment_id == p.id, Invoice.doc_type == "invoice"))
    if existing is not None:
        return existing
    tax = (p.meta or {}).get("tax")
    t = gst.TaxSplit.from_dict(tax) if tax else gst.split(p.amount, p.currency, None)
    buyer = (p.meta or {}).get("buyer") or buyer_snapshot(db, p.organization_id) or {}
    ref = (p.meta or {}).get("provider_payment_id") or p.provider_ref
    return _new_doc(
        db, p.organization_id, "invoice", p.paid_at or utcnow(), payment_id=p.id, currency=p.currency,
        tax_treatment=t.treatment, place_of_supply=t.place_of_supply,
        description=f"Prepaid wallet credit for marketing and CRM services ({p.provider.capitalize()})",
        taxable_value=t.taxable, gst_rate=t.rate, cgst=t.cgst, sgst=t.sgst, igst=t.igst, total=t.total,
        seller={**gst.seller(), "sgst_label": t.sgst_label}, buyer=buyer,
        payment_reference=f"{p.provider}:{ref}"[:160] if ref else p.provider)


def issue_credit_note(db: Session, invoice: Invoice, amount: Decimal, reason: str) -> Invoice:
    """A credit note against `invoice` for a refunded `amount` (inclusive of tax, in invoice currency).

    Not called yet: see the module docstring (TODO(refunds))."""
    total = gst.money(invoice.total)
    if amount <= 0 or amount > total:
        raise ValidationFailed("The credit note amount must be between 0 and the invoice total")
    share = amount / total if total else Decimal(1)
    return _new_doc(
        db, invoice.organization_id, "credit_note", utcnow(), payment_id=invoice.payment_id,
        original_invoice_id=invoice.id, currency=invoice.currency, tax_treatment=invoice.tax_treatment,
        place_of_supply=invoice.place_of_supply, description=f"Credit note for {invoice.number}: {reason}"[:255],
        taxable_value=gst.money(Decimal(str(invoice.taxable_value)) * share), gst_rate=invoice.gst_rate,
        cgst=gst.money(Decimal(str(invoice.cgst)) * share), sgst=gst.money(Decimal(str(invoice.sgst)) * share),
        igst=gst.money(Decimal(str(invoice.igst)) * share), total=amount, seller=invoice.seller,
        buyer=invoice.buyer, payment_reference=invoice.payment_reference)


# ------------------------------------------------------------------ reading

def invoice_out(i: Invoice) -> dict:
    return {"id": i.id, "number": i.number, "doc_type": i.doc_type, "issued_at": i.issued_at.isoformat(),
            "currency": i.currency, "taxable_value": float(i.taxable_value), "tax": float(i.cgst + i.sgst + i.igst),
            "cgst": float(i.cgst), "sgst": float(i.sgst), "igst": float(i.igst), "total": float(i.total),
            "tax_treatment": i.tax_treatment, "place_of_supply": i.place_of_supply, "payment_id": i.payment_id,
            "buyer_name": (i.buyer or {}).get("legal_name"), "buyer_gstin": (i.buyer or {}).get("gstin"),
            "emailed_at": i.emailed_at.isoformat() if i.emailed_at else None}


def list_invoices(db: Session, ctx, params: PageParams) -> Page:
    ctx.require(Perm.BILLING_READ)
    q = select(Invoice).where(Invoice.organization_id == ctx.organization_id)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(q.order_by(Invoice.issued_at.desc(), Invoice.sequence.desc())
                      .offset(params.offset).limit(params.page_size))
    return Page(items=[invoice_out(i) for i in rows], total=total, page=params.page, page_size=params.page_size)


def get_invoice(db: Session, ctx, invoice_id: str) -> Invoice:
    ctx.require(Perm.BILLING_READ)
    i = db.scalar(select(Invoice).where(Invoice.id == invoice_id, Invoice.organization_id == ctx.organization_id))
    if i is None:
        raise NotFound("Invoice not found")
    return i


def pdf_filename(i: Invoice) -> str:
    return f"{'credit-note' if i.doc_type == 'credit_note' else 'invoice'}-{i.number.replace('/', '-')}.pdf"


# ------------------------------------------------------------------ PDF

def _latin(s) -> str:
    """The PDF uses the built-in Helvetica font (Latin-1). Other characters are transliterated or dropped."""
    s = str(s or "").replace("₹", "Rs.").replace("—", "-").replace("–", "-").replace("’", "'")
    try:
        s.encode("latin-1")
        return s
    except UnicodeEncodeError:
        ascii_ = unicodedata.normalize("NFKD", s).encode("latin-1", "ignore").decode("latin-1")
        return ascii_ or "?"


def fmt_amount(x, currency: str) -> str:
    """1234567.5 -> INR 12,34,567.50 (Indian grouping) / USD 1,234,567.50."""
    a = gst.money(x)
    sign = "-" if a < 0 else ""
    whole, frac = f"{abs(a):.2f}".split(".")
    if currency == "INR" and len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    elif currency != "INR":
        whole = f"{int(whole):,}"
    return f"{currency} {sign}{whole}.{frac}"


def _pdf():
    from fpdf import FPDF

    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_margins(15, 15, 15)
    pdf.add_page()
    return pdf


def _finish(pdf, at: datetime, title: str) -> bytes:
    pdf.set_title(_latin(title))
    pdf.set_creator("Signalcraft")
    pdf.set_producer("Signalcraft")
    pdf.set_creation_date(at if at.tzinfo else at.replace(tzinfo=UTC))
    return bytes(pdf.output())


def render_pdf(i: Invoice) -> bytes:
    """Deterministic: the same stored invoice always gives the same bytes."""
    s, b, cur = i.seller or {}, i.buyer or {}, i.currency
    credit = i.doc_type == "credit_note"
    title = "CREDIT NOTE" if credit else ("TAX INVOICE" if i.tax_treatment != "export_lut" else
                                          "TAX INVOICE (EXPORT OF SERVICES)")
    pdf = _pdf()
    w = pdf.epw
    pdf.set_font("Helvetica", "B", 15)
    pdf.cell(w, 9, title, align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    issued = (i.issued_at + gst.IST).strftime("%d %b %Y") if cur == "INR" else i.issued_at.strftime("%d %b %Y")
    pdf.cell(w, 5, _latin(f"{'Credit note' if credit else 'Invoice'} no. {i.number}    Date: {issued}"), align="C",
             new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    def party(label: str, d: dict, extra: list[str]) -> list[str]:
        lines = [label, d.get("legal_name") or ""]
        # Addresses from .env may carry a literal "\n" for line breaks.
        lines += [ln for ln in (d.get("address") or "").replace("\\n", "\n").splitlines() if ln.strip()]
        place = ", ".join(x for x in (d.get("city"), d.get("state"), d.get("pin_code")) if x)
        if place:
            lines.append(place)
        if d.get("country") and d.get("country") != "IN":
            lines.append(f"Country: {COUNTRY_NAMES.get(d['country'], d['country'])}")
        return lines + extra

    uae_buyer = cur == "AED" or b.get("country") == "AE"
    seller_lines = party("Seller (supplier)", s, [f"GSTIN: {s.get('gstin') or '-'}"]
                         + ([f"PAN: {s['pan']}"] if s.get("pan") else [])
                         + ([f"State code: {s['state_code']}"] if s.get("state_code") else []))
    buyer_tax_id = (f"TRN: {b.get('trn') or '-'}" if uae_buyer else
                    f"GSTIN: {b['gstin']}" if b.get("gstin") else ("GSTIN: Unregistered" if cur == "INR" else ""))
    buyer_lines = party("Bill to (recipient)", b, [buyer_tax_id]
                        + ([f"Email: {b['email']}"] if b.get("email") else []))
    top = pdf.get_y()
    col = (w - 6) / 2
    for idx, lines in enumerate((seller_lines, buyer_lines)):
        pdf.set_xy(pdf.l_margin + idx * (col + 6), top)
        for n, ln in enumerate(x for x in lines if x):
            pdf.set_font("Helvetica", "B" if n < 2 else "", 8 if n == 0 else 9)
            pdf.set_x(pdf.l_margin + idx * (col + 6))
            pdf.multi_cell(col, 4.6, _latin(ln), new_x="LMARGIN", new_y="NEXT")
        if idx == 0:
            left_bottom = pdf.get_y()
    pdf.set_y(max(left_bottom, pdf.get_y()) + 3)
    pdf.set_font("Helvetica", "", 9)
    pdf.cell(w, 5, _latin(f"Place of supply: {i.place_of_supply}"), new_x="LMARGIN", new_y="NEXT")
    if credit and i.original_invoice_id:
        pdf.cell(w, 5, _latin(i.description), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    # Line item
    widths = (w * 0.5, w * 0.15, w * 0.35)
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_fill_color(240, 240, 240)
    for txt, cw, al in (("Description", widths[0], "L"), ("SAC", widths[1], "C"), ("Taxable value", widths[2], "R")):
        pdf.cell(cw, 7, txt, border=1, align=al, fill=True)
    pdf.ln()
    pdf.set_font("Helvetica", "", 9)
    desc = "Prepaid wallet credit for marketing and CRM services" if not credit else "Reversal of wallet credit"
    pdf.cell(widths[0], 7, _latin(desc), border=1)
    pdf.cell(widths[1], 7, _latin(i.sac), border=1, align="C")
    pdf.cell(widths[2], 7, fmt_amount(i.taxable_value, cur), border=1, align="R", new_x="LMARGIN", new_y="NEXT")

    rate = Decimal(str(i.gst_rate))
    half, full = f"{(rate / 2).normalize():f}", f"{rate.normalize():f}"
    rows: list[tuple[str, object]] = [("Taxable value", i.taxable_value)]
    if i.tax_treatment == "intra_state":
        label = s.get("sgst_label") or "SGST"
        rows += [(f"CGST @ {half}%", i.cgst), (f"{label} @ {half}%", i.sgst)]
    elif i.tax_treatment == "inter_state":
        rows += [(f"IGST @ {full}%", i.igst)]
    else:
        rows += [("IGST @ 0% (zero-rated)", Decimal("0"))]
    rows += [("Total", i.total)]
    for n, (label, val) in enumerate(rows):
        last = n == len(rows) - 1
        pdf.set_font("Helvetica", "B" if last else "", 9)
        pdf.cell(widths[0] + widths[1], 6.5, label, border=1, align="R")
        pdf.cell(widths[2], 6.5, fmt_amount(val, cur), border=1, align="R", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)
    pdf.set_font("Helvetica", "", 9)
    pdf.multi_cell(w, 5, _latin(f"Amount in words: {gst.amount_in_words(i.total, cur)}"), new_x="LMARGIN",
                   new_y="NEXT")
    if i.tax_treatment == "export_lut" and uae_buyer:
        lut = s.get("lut_number")
        for line in ("Export of services - zero-rated supply. No GST is charged.",
                     "Supply meant for export under LUT without payment of IGST" + (f" (LUT ARN {lut})." if lut else "."),
                     f"Recipient's UAE TRN: {b.get('trn') or '-'}",
                     "Reverse charge - the recipient accounts for UAE VAT. No UAE VAT is charged on this invoice.",
                     "Indian GST payable on reverse charge: No"):
            pdf.multi_cell(w, 5, _latin(line), new_x="LMARGIN", new_y="NEXT")
    else:
        if i.tax_treatment == "export_lut":
            lut = s.get("lut_number")
            pdf.multi_cell(w, 5, _latin("Export of services - zero-rated supply. Supply meant for export under Letter "
                                        "of Undertaking without payment of IGST" + (f" (LUT ARN {lut})." if lut
                                                                                     else ".")),
                           new_x="LMARGIN", new_y="NEXT")
        pdf.multi_cell(w, 5, "Whether tax is payable on reverse charge: No", new_x="LMARGIN", new_y="NEXT")
    if i.payment_reference:
        pdf.multi_cell(w, 5, _latin(f"Payment reference: {i.payment_reference}"), new_x="LMARGIN", new_y="NEXT")
    if uae_buyer and not credit:
        pdf.multi_cell(w, 5, "Later debits from the wallet (plan fees and usage) are not invoiced again.",
                       new_x="LMARGIN", new_y="NEXT")
    elif not credit:
        pdf.multi_cell(w, 5, "GST is charged on the advance received for services. Later debits from the wallet "
                             "(plan fees and usage) are not taxed again.", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    pdf.set_font("Helvetica", "I", 8)
    pdf.cell(w, 5, "This is a computer-generated invoice and does not require a signature.", align="C")
    return _finish(pdf, i.issued_at, f"{title} {i.number}")


# ------------------------------------------------------------------ email

def invoice_email(db: Session, i: Invoice):
    from app.services.mail_templates import RenderedEmail, _layout

    url = f"{settings.FRONTEND_URL}/orgs/{i.organization_id}/billing?tab=invoices"
    total = fmt_amount(i.total, i.currency)
    return RenderedEmail(
        subject=f"Tax invoice {i.number} for your {settings.APP_NAME} wallet top-up",
        html=_layout(f"Invoice {i.number}",
                     f"<p>Thank you for your payment of <strong>{total}</strong>. "
                     f"{fmt_amount(i.taxable_value, i.currency)} was added to your wallet.</p>"
                     "<p>Your tax invoice is attached as a PDF. You can also download it from Billing → Invoices.</p>",
                     "Open billing", url, "This email was sent to the billing email of your organization."),
        text=f"Thank you for your payment of {total}. Your tax invoice {i.number} is attached. "
             f"Download it any time from Billing → Invoices: {url}")


def send_invoice(db: Session, invoice_id: str) -> bool:
    """Email the invoice PDF to the billing email. Called by a task after the payment transaction commits."""
    from app.providers.email.base import OutboundEmail
    from app.providers.email.factory import get_system_email_provider

    i = db.get(Invoice, invoice_id)
    if i is None or i.emailed_at is not None:
        return False
    to = (i.buyer or {}).get("email")
    if not to and i.payment_id:
        p = db.get(Payment, i.payment_id)
        u = db.get(User, p.created_by_id) if p and p.created_by_id else None
        to = u.email if u else None
    if not to:
        return False
    mail = invoice_email(db, i)
    result = get_system_email_provider().send(OutboundEmail(
        to_email=to, to_name=(i.buyer or {}).get("legal_name"), subject=mail.subject, html=mail.html, text=mail.text,
        from_email=settings.SYSTEM_EMAIL_FROM_ADDRESS, from_name=settings.SYSTEM_EMAIL_FROM_NAME,
        tags=("system:invoice",), idempotency_key=f"invoice:{i.id}",
        attachments=((pdf_filename(i), "application/pdf", render_pdf(i)),)))
    if result.accepted:
        i.emailed_at = utcnow()
    return result.accepted


# ------------------------------------------------------------------ monthly statement (not a tax invoice)

STATEMENT_GROUPS = {"subscription": "Plan fees", "recurring": "Recurring fees"}
CHANNEL_GROUPS = {"email": "Email usage", "sms": "SMS usage", "voice": "Voice and AI calling usage",
                  "chat": "Chatbot AI replies", "forms": "Lead forms"}


def _month_bounds(month: str, currency: str) -> tuple[datetime, datetime]:
    m = re.fullmatch(r"(\d{4})-(\d{2})", month or "")
    if not m or not 1 <= int(m.group(2)) <= 12:
        raise ValidationFailed("Choose a month like 2026-11", code="INVALID_MONTH")
    y, mo = int(m.group(1)), int(m.group(2))
    shift = gst.IST if currency == "INR" else timedelta(0)  # INR statements follow Indian dates
    start = datetime(y, mo, 1, tzinfo=UTC) - shift
    end = datetime(y + (mo == 12), mo % 12 + 1, 1, tzinfo=UTC) - shift
    return start, end


def _category(t: WalletTransaction) -> str:
    if t.type in STATEMENT_GROUPS:
        return STATEMENT_GROUPS[t.type]
    if t.type == "usage":
        return CHANNEL_GROUPS.get(t.channel or "", f"{(t.channel or 'Other').capitalize()} usage")
    return "Adjustments"


def statement(db: Session, ctx, month: str) -> dict:
    ctx.require(Perm.BILLING_READ)
    w = wl.get_wallet(db, ctx.organization_id)
    start, end = _month_bounds(month, w.currency)
    rows = list(db.scalars(select(WalletTransaction).where(
        WalletTransaction.wallet_id == w.id, WalletTransaction.amount < 0, WalletTransaction.created_at >= start,
        WalletTransaction.created_at < end).order_by(WalletTransaction.created_at, WalletTransaction.id)))
    groups: dict[str, Decimal] = {}
    lines = []
    for t in rows:
        cat = _category(t)
        amt = -wl.dec(t.amount)
        groups[cat] = groups.get(cat, Decimal(0)) + amt
        lines.append({"date": t.created_at.isoformat(timespec="seconds"), "category": cat,
                      "description": t.description, "units": (t.meta or {}).get("units"), "amount": float(amt)})
    org = db.get(Organization, ctx.organization_id)
    return {"month": month, "currency": w.currency, "organization": org.name if org else "",
            "summary": [{"category": k, "amount": float(gst.money(v))} for k, v in sorted(groups.items())],
            "total": float(gst.money(sum(groups.values(), Decimal(0)))), "lines": lines}


def statement_csv(db: Session, ctx, month: str) -> str:
    from app.services.audience.contacts import _safe_cell

    st = statement(db, ctx, month)
    out = io.StringIO()
    wr = csv.writer(out)
    wr.writerow(["date_utc", "category", "description", "units", f"amount_{st['currency']}"])
    for ln in st["lines"]:
        wr.writerow([ln["date"], ln["category"], _safe_cell(ln["description"]), ln["units"] or "",
                     f"{ln['amount']:.4f}"])
    wr.writerow([])
    for g in st["summary"]:
        wr.writerow(["", "subtotal", g["category"], "", f"{g['amount']:.2f}"])
    wr.writerow(["", "total", "", "", f"{st['total']:.2f}"])
    wr.writerow(["", "note", "Statement of wallet usage. Not a tax invoice: GST was invoiced on the top-ups.", "", ""])
    return out.getvalue()


def statement_pdf(db: Session, ctx, month: str) -> bytes:
    st = statement(db, ctx, month)
    cur = st["currency"]
    pdf = _pdf()
    w = pdf.epw
    pdf.set_font("Helvetica", "B", 14)
    pdf.cell(w, 8, "Monthly usage statement", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    pdf.cell(w, 5, _latin(f"{st['organization']} - {month} - {cur} wallet"), new_x="LMARGIN", new_y="NEXT")
    pdf.multi_cell(w, 5, "This is a statement of debits from your prepaid wallet, not a tax invoice. GST was "
                         "charged and invoiced when the wallet was topped up.", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(w, 6, "Summary", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    for g in st["summary"] or [{"category": "No debits this month", "amount": 0}]:
        pdf.cell(w * 0.65, 6, _latin(g["category"]), border="B")
        pdf.cell(w * 0.35, 6, fmt_amount(g["amount"], cur), border="B", align="R", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "B", 9)
    pdf.cell(w * 0.65, 7, "Total")
    pdf.cell(w * 0.35, 7, fmt_amount(st["total"], cur), align="R", new_x="LMARGIN", new_y="NEXT")
    if st["lines"]:
        pdf.ln(3)
        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(w, 6, "Debits", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 8)
        for ln in st["lines"]:
            pdf.cell(w * 0.17, 5, ln["date"][:10])
            pdf.cell(w * 0.58, 5, _latin(ln["description"])[:80])
            pdf.cell(w * 0.25, 5, fmt_amount(ln["amount"], cur), align="R", new_x="LMARGIN", new_y="NEXT")
    start, _ = _month_bounds(month, cur)
    return _finish(pdf, start, f"Usage statement {month}")
