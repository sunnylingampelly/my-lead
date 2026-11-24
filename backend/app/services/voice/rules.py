"""Calling rules for India and the United States.

* India (TRAI TCCCPR 2018 and the 2024–25 number series directions): promotional calls come from
  140-series numbers, service and transactional calls from 160-series numbers. Promotional calls
  only between 09:00 and 21:00.
* United States (TCPA, 47 CFR 64.1200): marketing calls only 08:00–21:00 at the called party's
  location. Prerecorded marketing calls must identify the business at the start and offer an
  automated, interactive opt-out (press a key) within the message.
The application's own quiet hours apply on top and can only make the window narrower.
"""
import math
import re
from datetime import datetime

from app.core.config import settings
from app.services.sms.rules import quiet_until

LEGAL_WINDOW = {"IN": ("09:00", "21:00"), "US": ("08:00", "21:00")}
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
}
OPT_OUT_PROMPT = {
    "hi-IN": "इन कॉल्स को रोकने के लिए 9 दबाएं।",
    "es-US": "Para dejar de recibir estas llamadas, presione 9.",
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
    Marketing calls must fall inside the legal window; every call respects the app's quiet hours."""
    at = now_utc
    for _ in range(4):
        blocks = [quiet_until(at, tz_name, *quiet)]
        if category == "promotional":
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
