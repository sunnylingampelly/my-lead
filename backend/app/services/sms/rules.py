"""Regulatory and delivery rules for SMS in India and the United States."""
import re
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.core.config import settings
from app.services.email.render import VAR_RE

DLT_VAR_RE = re.compile(r"\{#\s*var\s*#\}", re.I)
DLT_VAR_MAX = 30  # characters per {#var#} value accepted by Indian operators
OPT_OUT_TEXT = "Reply STOP to opt out"
STOP_WORDS = {"STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "OPT-OUT", "REVOKE"}
START_WORDS = {"START", "UNSTOP", "YES", "SUBSCRIBE"}
HELP_WORDS = {"HELP", "INFO"}


def validate_sender(country: str, kind: str, sender_id: str) -> str | None:
    """Return an error message, or None if the sender id is well formed for its type."""
    if country == "IN":
        if kind == "promotional" and not re.fullmatch(r"\d{6}", sender_id):
            return "Indian promotional headers are exactly 6 digits (for example 561234)."
        if kind in ("service", "transactional") and not re.fullmatch(r"[A-Z]{6}", sender_id):
            return "Indian service and transactional headers are exactly 6 capital letters (for example ACMEIN)."
        if kind not in ("promotional", "service", "transactional"):
            return "Choose promotional, service or transactional."
    elif country == "US":
        if kind == "short_code" and not re.fullmatch(r"\d{5,6}", sender_id):
            return "US short codes have 5 or 6 digits."
        if kind in ("long_code", "toll_free") and not re.fullmatch(r"\+1\d{10}", sender_id):
            return "Enter the number in E.164 format, for example +14155550123."
        if kind not in ("long_code", "toll_free", "short_code"):
            return "Choose 10DLC long code, toll-free or short code."
    else:
        return "SMS is supported for India and the United States."
    return None


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def to_dlt_pattern(body: str) -> str:
    """Our {{field}} placeholders become DLT {#var#} placeholders."""
    return _norm(VAR_RE.sub("{#var#}", body or ""))


def matches_dlt(body: str, registered: str) -> bool:
    return to_dlt_pattern(body) == _norm(DLT_VAR_RE.sub("{#var#}", registered or ""))


def final_body(body: str, *, country: str, category: str, append_opt_out: bool) -> str:
    text = (body or "").strip()
    if country == "US" and category == "promotional" and append_opt_out and "stop" not in text.lower():
        text = f"{text} {OPT_OUT_TEXT}"
    return text


def price(country: str | None, category: str) -> tuple[float, str]:
    table = settings.SMS_PRICING.get(country or "", settings.SMS_PRICING["default"])
    return float(table.get(category, table.get("promotional", 0))), table["currency"]


def _hm(v: str) -> time:
    h, m = v.split(":")
    return time(int(h), int(m))


def quiet_until(now_utc: datetime, tz_name: str | None, quiet_start: str, quiet_end: str) -> datetime | None:
    """If `now` is inside the quiet window in the recipient's timezone, return the UTC time the
    window ends; otherwise None. The window may cross midnight (e.g. 21:00 → 09:00)."""
    try:
        tz = ZoneInfo(tz_name or "UTC")
    except Exception:  # noqa: BLE001
        tz = ZoneInfo("UTC")
    local = now_utc.astimezone(tz)
    start, end = _hm(quiet_start), _hm(quiet_end)
    t = local.time()
    crosses = start > end
    inside = (t >= start or t < end) if crosses else (start <= t < end)
    if not inside:
        return None
    end_day = local.date() + timedelta(days=1) if crosses and t >= start else local.date()
    resume = datetime.combine(end_day, end, tzinfo=tz)
    return resume.astimezone(now_utc.tzinfo)
