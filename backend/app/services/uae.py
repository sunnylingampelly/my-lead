"""United Arab Emirates (AE): rules shared by billing, SMS and voice.

Launch scope (docs/UAE_COMPLIANCE.md): email, lead forms, chatbot, CRM, automation and an AED wallet are on.
Signalcraft sells only to UAE VAT-registered businesses (a TRN is required; invoices are reverse charge, with
no UAE VAT). SMS and calls to the UAE are built but switched off behind SMS_UAE_ENABLED / VOICE_UAE_ENABLED.

Product defaults, not legal advice.
"""
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from app.core.config import settings

COUNTRY = "AE"
TIMEZONE = "Asia/Dubai"
TZ = ZoneInfo(TIMEZONE)
DIAL_CODE = "+971"

SMS_COMING_SOON = "SMS to the UAE is coming soon: carriers are updating sender-ID registration."
VOICE_COMING_SOON = ("Calls to the UAE are coming soon: UAE rules require calling from your own licensed "
                     "UAE number.")
TRN_REQUIRED = ("Signalcraft currently sells to VAT-registered UAE businesses. Add your 15-digit Tax Registration "
                "Number (TRN) in the billing details to top up.")

# ------------------------------------------------------------------ VAT / billing

TRN_RE = re.compile(r"^100\d{12}$")
EMIRATES = ("Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah")


def normalize_trn(value: str | None) -> str | None:
    """Digits only (people paste it with spaces or dashes). None when empty."""
    digits = re.sub(r"[\s-]", "", value or "")
    return digits or None


def valid_trn(value: str | None) -> bool:
    """A UAE Tax Registration Number: 15 digits starting with 100."""
    return bool(value and TRN_RE.match(value))


# ------------------------------------------------------------------ kill switches


def is_uae(country: str | None) -> bool:
    return (country or "").upper() == COUNTRY


def is_uae_number(phone: str | None) -> bool:
    return bool(phone) and phone.startswith(DIAL_CODE)


SMS_GLOBAL_COMING_SOON = "SMS is coming soon."


def sms_globally_blocked() -> str | None:
    """The 'coming soon' reason while SMS is switched off for every market (settings.SMS_ENABLED)."""
    return None if settings.SMS_ENABLED else SMS_GLOBAL_COMING_SOON


def sms_blocked(country: str | None = None, phone: str | None = None) -> str | None:
    """The 'coming soon' reason when SMS to/from the UAE is switched off, else None."""
    if settings.SMS_UAE_ENABLED:
        return None
    return SMS_COMING_SOON if is_uae(country) or is_uae_number(phone) else None


def voice_blocked(country: str | None = None, phone: str | None = None) -> str | None:
    """The 'coming soon' reason when calls to the UAE are switched off, else None."""
    if settings.VOICE_UAE_ENABLED:
        return None
    return VOICE_COMING_SOON if is_uae(country) or is_uae_number(phone) else None


# ------------------------------------------------------------------ SMS rules

PROMO_PREFIX = "AD-"
SENDER_MAX = 11  # characters, including the AD- prefix
# Promotional SMS is not delivered 21:00-07:00 UAE time.
SMS_PROMO_QUIET = ("21:00", "07:00")
ARABIC_RE = re.compile(r"[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]")
URL_RE = re.compile(r"(https?://|www\.|wa\.me/|\b[a-z0-9-]+\.(com|ae|net|org|io|co|me|ly)\b)", re.I)
ATTESTATION_TEXT = ("We are licensed in the UAE and have uploaded our recipients' consents to TDRA's Consent "
                    "Management System (CMS).")


def is_arabic(text: str | None) -> bool:
    """True when the text is mainly Arabic (more Arabic letters than Latin ones)."""
    t = text or ""
    arabic = len(ARABIC_RE.findall(t))
    latin = len(re.findall(r"[A-Za-z]", t))
    return arabic > 0 and arabic >= latin


def opt_out_text(body: str | None) -> str:
    return settings.SMS_UAE_OPT_OUT_AR if is_arabic(body) else settings.SMS_UAE_OPT_OUT_EN


def has_opt_out(body: str | None) -> bool:
    t = (body or "").lower()
    return "stop" in t or settings.SMS_UAE_OPT_OUT_AR in (body or "")


def has_url(body: str | None) -> bool:
    return bool(URL_RE.search(body or ""))


def validate_sender(kind: str, sender_id: str) -> str | None:
    s = sender_id or ""
    if kind == "promotional":
        if not s.startswith(PROMO_PREFIX):
            return "UAE promotional sender IDs start with \"AD-\" (for example AD-ACME)."
        if len(s) > SENDER_MAX:
            return "UAE sender IDs have at most 11 characters, including the \"AD-\" prefix."
        if not re.fullmatch(r"AD-[A-Z0-9][A-Z0-9 .&-]*", s):
            return "After \"AD-\", use letters and digits (for example AD-ACME)."
    elif kind in ("transactional", "service"):
        if s.startswith(PROMO_PREFIX):
            return "\"AD-\" sender IDs are for promotional messages only."
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9 .&-]{2,10}", s) or s.isdigit():
            return "UAE sender IDs have 3 to 11 letters or digits, with at least one letter (for example ACME)."
    else:
        return "Choose promotional, service or transactional."
    return None


# ------------------------------------------------------------------ voice rules (Resolution 56/2024)

CALL_WINDOW = ("09:00", "18:00")
CALL_DAYS = (0, 1, 2, 3, 4)  # Monday to Friday; weekend calling is unverified, so blocked
MAX_ATTEMPTS_PER_DAY = 1  # a retry never falls on the same UAE day as an earlier attempt
MAX_ATTEMPTS_PER_WEEK = 3  # the first call plus at most 2 retries in any rolling 7 days
REFUSAL_INTERESTS = ("not_interested",)


def _hm(v: str) -> tuple[int, int]:
    h, m = v.split(":")
    return int(h), int(m)


def next_call_time(now_utc: datetime) -> datetime | None:
    """None if a UAE call may be placed now; otherwise the next UTC instant inside Mon-Fri 09:00-18:00 Dubai."""
    local = now_utc.astimezone(TZ)
    (sh, sm), (eh, em) = _hm(CALL_WINDOW[0]), _hm(CALL_WINDOW[1])
    start_t, end_t = local.replace(hour=sh, minute=sm, second=0, microsecond=0), \
        local.replace(hour=eh, minute=em, second=0, microsecond=0)
    if local.weekday() in CALL_DAYS and start_t <= local < end_t:
        return None
    d: date = local.date() if local < start_t else local.date() + timedelta(days=1)
    while d.weekday() not in CALL_DAYS:
        d += timedelta(days=1)
    nxt = datetime(d.year, d.month, d.day, sh, sm, tzinfo=TZ)
    return nxt.astimezone(now_utc.tzinfo)


def recording_notice(business: str | None) -> str:
    """Spoken first on every UAE call: the recording notice and the AI disclosure."""
    return f"This call is recorded. You're speaking with an AI assistant for {business or 'this business'}."


def recording_notice_plain(business: str | None) -> str:
    """For recorded (non-AI) messages: the recording notice and who is calling."""
    return f"This call is recorded. This is an automated call from {business or 'this business'}."
