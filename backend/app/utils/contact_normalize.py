"""Normalisation and validation of contact identifiers (email, phone) and derived fields."""
import hashlib
from dataclasses import dataclass

import phonenumbers
from email_validator import EmailNotValidError, validate_email
from phonenumbers import PhoneNumberFormat, PhoneNumberType
from phonenumbers import timezone as pn_timezone

from app.services.regions import US_STATE_TIMEZONES, profile_for, us_state_code


class InvalidValue(ValueError):
    pass


def normalize_email(raw: str | None) -> str | None:
    if raw is None:
        return None
    raw = str(raw).strip()
    if not raw:
        return None
    try:
        result = validate_email(raw, check_deliverability=False)
    except EmailNotValidError as exc:
        raise InvalidValue(f"Invalid email '{raw[:80]}'") from exc
    return result.normalized.lower()


@dataclass(frozen=True)
class ParsedPhone:
    e164: str
    country: str | None
    number_type: str
    timezone: str | None


_TYPE_NAMES = {
    PhoneNumberType.MOBILE: "mobile",
    PhoneNumberType.FIXED_LINE: "landline",
    PhoneNumberType.FIXED_LINE_OR_MOBILE: "mobile_or_landline",
    PhoneNumberType.TOLL_FREE: "toll_free",
    PhoneNumberType.VOIP: "voip",
}


# The phone metadata still uses some legacy IANA names.
_TZ_ALIASES = {"Asia/Calcutta": "Asia/Kolkata", "Asia/Katmandu": "Asia/Kathmandu", "Asia/Saigon": "Asia/Ho_Chi_Minh"}


def parse_phone(raw: str | None, default_country: str | None) -> ParsedPhone | None:
    """Parse to E.164. Numbers without a leading + use the default country (e.g. IN, US)."""
    if raw is None:
        return None
    text = str(raw).strip()
    if text.endswith(".0") and text[:-2].isdigit():  # spreadsheet numeric cells
        text = text[:-2]
    if not text:
        return None
    if text.startswith("00"):
        text = "+" + text[2:]
    digits = "".join(c for c in text if c.isdigit())
    candidates: list[tuple[str, str | None]] = []
    if text.startswith("+"):
        candidates.append((text, None))
    else:
        if default_country:
            candidates.append((text, default_country))
        # A full international number typed without '+', e.g. 919876543210 or 14155552671.
        if len(digits) >= 10:
            candidates.append(("+" + digits, None))
    num = None
    for candidate, region_hint in candidates:
        try:
            parsed = phonenumbers.parse(candidate, region_hint)
        except phonenumbers.NumberParseException:
            continue
        if phonenumbers.is_valid_number(parsed):
            num = parsed
            break
    if num is None:
        if not text.startswith("+") and not default_country:
            raise InvalidValue(f"Phone '{text[:40]}' needs a country code (for example +91 or +1)")
        raise InvalidValue(f"Invalid phone '{text[:40]}'")
    region = phonenumbers.region_code_for_number(num)
    zones = [_TZ_ALIASES.get(z, z) for z in pn_timezone.time_zones_for_number(num) if z != "Etc/Unknown"]
    return ParsedPhone(
        e164=phonenumbers.format_number(num, PhoneNumberFormat.E164),
        country=region,
        number_type=_TYPE_NAMES.get(phonenumbers.number_type(num), "other"),
        timezone=zones[0] if len(zones) == 1 else None,
    )


# Markets where people write domestic numbers in national format. Indian numbers are shown as
# +91 98765 43210 (the national form adds a 0 trunk prefix that most businesses do not use).
_NATIONAL_DISPLAY = {"US", "CA", "GB", "AU"}


def format_phone(e164: str | None, viewer_country: str | None = None) -> str | None:
    """National format for the viewer's own country where that is customary, international otherwise."""
    if not e164:
        return None
    try:
        num = phonenumbers.parse(e164, None)
    except phonenumbers.NumberParseException:
        return e164
    region = phonenumbers.region_code_for_number(num)
    national = viewer_country and region == viewer_country and region in _NATIONAL_DISPLAY
    fmt = PhoneNumberFormat.NATIONAL if national else PhoneNumberFormat.INTERNATIONAL
    return phonenumbers.format_number(num, fmt)


def identifier_hash(value: str) -> str:
    """Stable hash used to match suppression entries without storing the raw value twice."""
    return hashlib.sha256(value.strip().lower().encode()).hexdigest()


def mask_email(email: str) -> str:
    local, _, domain = email.partition("@")
    return f"{local[:2]}{'*' * max(1, len(local) - 2)}@{domain}"


def mask_phone(e164: str) -> str:
    return f"{e164[:3]}{'*' * max(1, len(e164) - 6)}{e164[-3:]}"


def derive_timezone(phone: ParsedPhone | None, country: str | None, state: str | None) -> str | None:
    """Best-effort recipient timezone for quiet-hour enforcement."""
    if country == "US" or (phone and phone.country == "US"):
        code = us_state_code(state)
        if code:
            return US_STATE_TIMEZONES[code]
    if phone and phone.timezone:
        return phone.timezone
    c = country or (phone.country if phone else None)
    if c == "IN":
        return "Asia/Kolkata"
    prof = profile_for(c)
    return prof.default_timezone if prof.code != "XX" else None
