"""GST rules for wallet top-ups: Indian states, the CGST+SGST / IGST / export split, Indian financial years,
gap-free invoice numbers and amounts in words (lakh / crore).

Model: prices exclude GST. An INR top-up of X is charged X + GST and credits X to the wallet; the tax
invoice is issued when the payment is confirmed (GST on an advance received for services). Plan fees and
usage later debited from the wallet are not taxed again. USD and AED organizations (outside India) get an export
invoice: zero-rated, supply without payment of IGST under LUT. AED (UAE) invoices also carry the buyer's TRN
and the reverse-charge note: the recipient accounts for UAE VAT. Numbering is the same Indian series.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings

CENT = Decimal("0.01")

# GST state codes (first two digits of a GSTIN). 25 (Daman and Diu) merged into 26 in 2020; 28 is the
# pre-2014 Andhra Pradesh code. 97 is "Other Territory".
STATES: dict[str, str] = {
    "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
    "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
    "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura",
    "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh",
    "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra",
    "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
    "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
    "97": "Other Territory",
}
# Union territories without a legislature charge UTGST instead of SGST on intra-territory supplies.
UTGST_STATES = {"04", "26", "31", "35", "38", "97"}


def money(x) -> Decimal:
    return Decimal(str(x or 0)).quantize(CENT, rounding=ROUND_HALF_UP)


def state_label(code: str | None) -> str:
    return f"{code}-{STATES[code]}" if code in STATES else (code or "")


def rate() -> Decimal:
    return Decimal(str(settings.GST_RATE))


def seller() -> dict:
    code = settings.SELLER_STATE_CODE
    return {"legal_name": settings.SELLER_LEGAL_NAME, "gstin": settings.SELLER_GSTIN, "pan": settings.SELLER_PAN,
            "address": settings.SELLER_ADDRESS, "state_code": code, "state": STATES.get(code or "", ""),
            "lut_number": settings.SELLER_LUT_NUMBER}


def seller_ready() -> bool:
    return bool(settings.SELLER_GSTIN and settings.SELLER_STATE_CODE in STATES)


@dataclass(frozen=True)
class TaxSplit:
    treatment: str  # intra_state | inter_state | export_lut
    taxable: Decimal
    rate: Decimal
    cgst: Decimal
    sgst: Decimal  # SGST, or UTGST when the seller is in a union territory
    igst: Decimal
    place_of_supply: str
    sgst_label: str = "SGST"

    @property
    def tax(self) -> Decimal:
        return self.cgst + self.sgst + self.igst

    @property
    def total(self) -> Decimal:
        return self.taxable + self.tax

    def as_dict(self) -> dict:
        return {"treatment": self.treatment, "taxable": str(self.taxable), "rate": str(self.rate),
                "cgst": str(self.cgst), "sgst": str(self.sgst), "igst": str(self.igst), "tax": str(self.tax),
                "total": str(self.total), "place_of_supply": self.place_of_supply, "sgst_label": self.sgst_label}

    @classmethod
    def from_dict(cls, d: dict) -> "TaxSplit":
        return cls(treatment=d["treatment"], taxable=money(d["taxable"]), rate=Decimal(str(d["rate"])),
                   cgst=money(d["cgst"]), sgst=money(d["sgst"]), igst=money(d["igst"]),
                   place_of_supply=d["place_of_supply"], sgst_label=d.get("sgst_label", "SGST"))


def split(amount, currency: str, buyer_state: str | None, seller_state: str | None = None) -> TaxSplit:
    """GST on a top-up of `amount` (exclusive of tax).

    * USD or AED (customer outside India): export of services, zero-rated under LUT. AED buyers are UAE
      VAT-registered businesses that account for UAE VAT under the reverse charge (no UAE VAT is charged).
    * Buyer state == seller state: CGST + SGST (UTGST in a union territory), half the rate each.
    * Otherwise: IGST at the full rate. B2C buyers (no GSTIN) use their billing state as the place of supply.
    """
    taxable = money(amount)
    seller_state = seller_state if seller_state is not None else settings.SELLER_STATE_CODE
    if currency != "INR":
        return TaxSplit("export_lut", taxable, Decimal("0"), Decimal("0.00"), Decimal("0.00"), Decimal("0.00"),
                        "Outside India (export of services)")
    r = rate()
    pos = state_label(buyer_state)
    if buyer_state and buyer_state == seller_state:
        half = money(taxable * r / 2 / 100)
        return TaxSplit("intra_state", taxable, r, half, half, Decimal("0.00"), pos,
                        "UTGST" if seller_state in UTGST_STATES else "SGST")
    return TaxSplit("inter_state", taxable, r, Decimal("0.00"), Decimal("0.00"), money(taxable * r / 100), pos)


# ------------------------------------------------------------------ financial year and numbering

IST = timedelta(hours=5, minutes=30)


def financial_year(at: datetime) -> str:
    """Indian financial year (April–March) of a UTC instant, by its date in India: "2026-27"."""
    d = (at + IST).date()  # naive values are UTC, like every timestamp stored by the platform
    start = d.year if d.month >= 4 else d.year - 1
    return f"{start}-{(start + 1) % 100:02d}"


def format_number(series: str, fy: str, n: int) -> str:
    """SC/26-27/000123 (15 characters). GST rules allow invoice numbers of up to 16 characters."""
    prefix = (settings.INVOICE_NUMBER_PREFIX or "SC").strip().upper()
    if series == "credit_note":
        prefix = f"{prefix[:1]}CN"  # SCN/26-27/000001
    short = f"{fy[2:4]}-{fy[5:7]}"
    number = f"{prefix}/{short}/{n:06d}"
    if len(number) > 16:
        raise ValueError(f"Invoice number {number} is longer than 16 characters; shorten INVOICE_NUMBER_PREFIX")
    return number


def allocate_number(db: Session, series: str, at: datetime) -> tuple[str, str, int]:
    """Take the next number of `series` in the financial year of `at`.

    One atomic upsert increments the counter and leaves its row locked (InnoDB X lock) until the caller's
    transaction ends: a concurrent payment waits, and a rollback gives the number back, so the series has no
    gaps and no duplicates."""
    fy = financial_year(at)
    db.execute(text("INSERT INTO invoice_sequences (series, financial_year, last_number) VALUES (:s, :fy, 1) "
                    "ON DUPLICATE KEY UPDATE last_number = last_number + 1"), {"s": series, "fy": fy})
    n = db.execute(text("SELECT last_number FROM invoice_sequences WHERE series = :s AND financial_year = :fy "
                        "FOR UPDATE"), {"s": series, "fy": fy}).scalar_one()
    return format_number(series, fy, int(n)), fy, int(n)


# ------------------------------------------------------------------ amount in words

_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
         "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _below_100(n: int) -> str:
    return _ONES[n] if n < 20 else (_TENS[n // 10] + (f" {_ONES[n % 10]}" if n % 10 else ""))


def _below_1000(n: int) -> str:
    h, rest = divmod(n, 100)
    parts = [f"{_ONES[h]} Hundred"] if h else []
    if rest:
        parts.append(_below_100(rest))
    return " ".join(parts)


def indian_words(n: int) -> str:
    """Whole number in words with Indian grouping: 12345678 -> One Crore Twenty Three Lakh Forty Five Thousand
    Six Hundred Seventy Eight."""
    if n == 0:
        return "Zero"
    parts = []
    crore, n = divmod(n, 10_000_000)
    if crore:
        parts.append(f"{indian_words(crore)} Crore")
    lakh, n = divmod(n, 100_000)
    if lakh:
        parts.append(f"{_below_100(lakh)} Lakh")
    thousand, n = divmod(n, 1000)
    if thousand:
        parts.append(f"{_below_100(thousand)} Thousand")
    if n:
        parts.append(_below_1000(n))
    return " ".join(parts)


def amount_in_words(amount, currency: str = "INR") -> str:
    """1180 -> "Rupees One Thousand One Hundred Eighty Only"; 10.50 -> "Rupees Ten and Fifty Paise Only"."""
    a = money(amount)
    whole = int(a)
    frac = int((a - whole) * 100)
    unit, sub = {"INR": ("Rupees", "Paise"), "AED": ("UAE Dirhams", "Fils")}.get(currency, ("US Dollars", "Cents"))
    out = f"{unit} {indian_words(whole)}"
    if frac:
        out += f" and {_below_100(frac)} {sub}"
    return out + " Only"
