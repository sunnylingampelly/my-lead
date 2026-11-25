"""Calling rules for India and the United States.

* India (TRAI TCCCPR 2018 and the 2024–25 number series directions): promotional calls come from
  140-series numbers, service and transactional calls from 160-series numbers. Promotional calls
  only between 09:00 and 21:00.
* United States (TCPA, 47 CFR 64.1200): marketing calls only 08:00–21:00 at the called party's
  location. Prerecorded marketing calls must identify the business at the start and offer an
  automated, interactive opt-out (press a key) within the message.
* UAE (Cabinet Resolution 56/2024): every call 09:00–18:00 UAE time, Monday to Friday only (weekend and
  holiday calling is unverified, so blocked). A refusal means never again; unanswered calls are retried at most
  once a day and twice a week; DNCR numbers are never called; calls are recorded with a notice at the start
  (plus an AI disclosure). Calls must come from the customer's own licensed UAE number, which isn't supported
  yet, so UAE calling stays off behind settings.VOICE_UAE_ENABLED (app/services/uae.py).
The application's own quiet hours apply on top and can only make the window narrower.
"""
import math
import re
from datetime import datetime, timedelta

from app.core.config import settings
from app.services import uae
from app.services.sms.rules import quiet_until

LEGAL_WINDOW = {"IN": ("09:00", "21:00"), "US": ("08:00", "21:00"), "AE": uae.CALL_WINDOW}
# Other markets: the stricter of the two (same end time everywhere, so setup, settings and review agree).
DEFAULT_WINDOW = ("09:00", "21:00")


def window_for(country: str | None) -> tuple[str, str]:
    return LEGAL_WINDOW.get(country or "", DEFAULT_WINDOW)
OPT_OUT_DIGIT = "9"
TOLL_FREE_US = ("800", "833", "844", "855", "866", "877", "888")
LANGUAGES = {
    "en-IN": "English (India)",
    "hi-IN": "Hindi",
    "ta-IN": "Tamil",
    "te-IN": "Telugu",
    "en-US": "English (US)",
    "es-US": "Spanish (US)",
    "ar-AE": "Arabic (UAE)",
}
OPT_OUT_PROMPT = {
    "hi-IN": "इन कॉल्स को रोकने के लिए 9 दबाएं।",
    "es-US": "Para dejar de recibir estas llamadas, presione 9.",
    "ar-AE": "لإيقاف هذه المكالمات، اضغط 9.",
}
DEFAULT_OPT_OUT_PROMPT = "To stop receiving these calls, press 9."


def validate_caller(country: str, kind: str, number: str) -> str | None:
    if country == "IN":
        if kind == "series_140" and not re.fullmatch(r"\+91140\d{5,7}", number):
            return "Indian promotional calls must come from a 140-series number (for example +911401234567)."
        if kind == "series_160" and not re.fullmatch(r"\+91160\d{5,7}", number):
            return "Indian service and transactional calls must come from a 160-series number (for example +911601234567)."
        if kind not in ("series_140", "series_160"):
            return "Choose a 140-series or 160-series number."
    elif country == "US":
        if not re.fullmatch(r"\+1\d{10}", number):
            return "Enter the number in E.164 format, for example +14155550100."
        if kind == "toll_free" and number[2:5] not in TOLL_FREE_US:
            return "US toll-free numbers start with 800, 833, 844, 855, 866, 877 or 888."
        if kind not in ("local", "toll_free"):
            return "Choose a local or toll-free number."
    elif country == "AE":
        return ("UAE calls must come from your own licensed UAE number, which isn't supported yet. "
                + uae.VOICE_COMING_SOON)
    else:
        return "Voice is supported for India and the United States."
    return None


def caller_fits_category(country: str, kind: str, category: str) -> bool:
    if country != "IN":
        return True
    return (kind == "series_140") == (category == "promotional")


def next_allowed(now_utc: datetime, tz_name: str | None, country: str | None, category: str,
                 quiet: tuple[str, str]) -> datetime | None:
    """None if a call may be placed now; otherwise the earliest UTC time it may be placed.
    Marketing calls must fall inside the legal window; every call respects the app's quiet hours.
    UAE: every call, whatever its category, falls inside 09:00-18:00 UAE time on a weekday."""
    at = now_utc
    for _ in range(6):
        blocks = [quiet_until(at, tz_name, *quiet)]
        if country == "AE":
            blocks.append(uae.next_call_time(at))
        elif category == "promotional":
            start, end = window_for(country)
            blocks.append(quiet_until(at, tz_name, end, start))  # outside the window = "quiet"
        later = [b for b in blocks if b is not None]
        if not later:
            return None if at == now_utc else at
        at = max(later)
    return at


def spoken_seconds(text: str) -> float:
    """About 150 words per minute for synthetic speech."""
    words = len((text or "").split())
    return round(words / 2.5 + (1 if words else 0), 1)


def opt_out_prompt(language: str | None) -> str:
    return OPT_OUT_PROMPT.get(language or "", DEFAULT_OPT_OUT_PROMPT)


def price_per_minute(country: str | None, ai: bool = False) -> tuple[float, str]:
    """Per started minute of an answered call. AI-agent calls have their own (higher) rate."""
    table = settings.VOICE_AI_PRICING if ai else settings.VOICE_PRICING
    t = table.get(country or "", table["default"])
    return float(t["per_minute"]), t["currency"]


def billable_minutes(duration_seconds: int) -> int:
    return math.ceil(duration_seconds / 60) if duration_seconds > 0 else 0


# ------------------------------------------------------------------ UAE per-contact limits

def refused_before(db, contact_id: str | None) -> bool:
    """UAE: the contact refused on an earlier call (pressed 9, asked not to be called, or said not interested).
    Read from the call history, so it holds even if consent is later recorded again."""
    from sqlalchemy import or_, select

    from app.models.voice import VoiceCall

    if not contact_id:
        return False
    return db.scalar(select(VoiceCall.id).where(
        VoiceCall.contact_id == contact_id,
        or_(VoiceCall.opted_out.is_(True), VoiceCall.ai_interest.in_(uae.REFUSAL_INTERESTS))).limit(1)) is not None


def uae_contact_block(db, contact, now_utc: datetime) -> tuple[str | None, datetime | None]:
    """UAE per-contact rules, across every campaign and workflow (the 'placed' events of all calls):

    * on the Do Not Call Registry (DNCR) or refused before: never call (reason, None);
    * already called today (UAE date): wait for the next day (reason, when);
    * called 3 times in the last 7 days (the first call plus 2 retries): wait until the oldest leaves the
      window (reason, when). Otherwise (None, None)."""
    from sqlalchemy import select

    from app.models.voice import VoiceEvent

    if getattr(contact, "dncr_registered", False):
        return "Number is on the UAE Do Not Call Registry (DNCR)", None
    if refused_before(db, contact.id):
        return "Refused marketing calls on an earlier call (UAE: never call again)", None
    since = now_utc - timedelta(days=7)
    placed = sorted(db.scalars(select(VoiceEvent.occurred_at).where(
        VoiceEvent.contact_id == contact.id, VoiceEvent.type == "placed", VoiceEvent.occurred_at >= since)))
    if not placed:
        return None, None
    today = now_utc.astimezone(uae.TZ).date()

    def local(d: datetime):
        return (d if d.tzinfo else d.replace(tzinfo=now_utc.tzinfo)).astimezone(uae.TZ)

    if any(local(p).date() == today for p in placed):
        tomorrow = datetime(today.year, today.month, today.day, tzinfo=uae.TZ) + timedelta(days=1)
        return "Already called today (UAE: at most one retry a day)", tomorrow.astimezone(now_utc.tzinfo)
    if len(placed) >= uae.MAX_ATTEMPTS_PER_WEEK:
        oldest = placed[-uae.MAX_ATTEMPTS_PER_WEEK]
        oldest = oldest if oldest.tzinfo else oldest.replace(tzinfo=now_utc.tzinfo)
        return "Called 3 times in 7 days (UAE: at most two retries a week)", oldest + timedelta(days=7)
    return None, None
