"""Turn raw contact input (API body or import row) into validated, normalised values.

One code path serves the contact form, the API and the CSV/XLSX importer, so every entry point
applies exactly the same rules.
"""
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any
from zoneinfo import available_timezones

from app.models import ContactAttributeDefinition
from app.services.regions import normalize_country, us_state_code
from app.utils.contact_normalize import InvalidValue, ParsedPhone, derive_timezone, normalize_email, parse_phone

CORE_TEXT_FIELDS = ("first_name", "last_name", "company", "state", "city", "postal_code", "source")
MAX_TEXT = {"first_name": 100, "last_name": 100, "company": 200, "state": 100, "city": 100, "postal_code": 20,
            "source": 60}
_TZ: set[str] | None = None


@dataclass
class NormalizedContact:
    first_name: str | None = None
    last_name: str | None = None
    email: str | None = None
    phone: ParsedPhone | None = None
    company: str | None = None
    country: str | None = None
    state: str | None = None
    city: str | None = None
    postal_code: str | None = None
    source: str | None = None
    timezone: str | None = None
    attributes: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    provided: set[str] = field(default_factory=set)  # fields present in the input (for partial updates)

    def is_empty(self) -> bool:
        return not (self.email or self.phone or self.first_name or self.last_name or self.company)


def _clean(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    if s.startswith("'") and len(s) > 1:  # spreadsheet text-escape or CSV-injection guard
        s = s[1:]
    return s or None


def parse_date(value: str, default_country: str | None) -> date:
    """Accept ISO dates and the local slash format: DD/MM/YYYY in India, MM/DD/YYYY in the US."""
    v = value.strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%d %b %Y", "%d %B %Y",
                "%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            pass
    m = re.fullmatch(r"(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})", v)
    if m:
        a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000
        month_first = (default_country or "").upper() == "US"
        if a > 12:
            month_first = False
        elif b > 12:
            month_first = True
        month, day = (a, b) if month_first else (b, a)
        try:
            return date(y, month, day)
        except ValueError:
            pass
    raise InvalidValue(f"Invalid date '{v[:30]}'")


_TRUE = {"true", "yes", "y", "1", "t", "on", "subscribed", "opted in", "opt-in"}
_FALSE = {"false", "no", "n", "0", "f", "off", "unsubscribed", "opted out", "opt-out"}


def coerce_attribute(defn: ContactAttributeDefinition, value: Any, default_country: str | None) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    t = defn.data_type
    if t == "text":
        return str(value).strip()[:500]
    if t == "number":
        if isinstance(value, bool):
            raise InvalidValue(f"{defn.label}: expected a number")
        if isinstance(value, (int, float)):
            return value
        s = re.sub(r"[,\s₹$]|Rs\.?|INR|USD", "", str(value), flags=re.IGNORECASE)
        try:
            n = float(s)
        except ValueError as exc:
            raise InvalidValue(f"{defn.label}: '{str(value)[:30]}' is not a number") from exc
        return int(n) if n.is_integer() else n
    if t == "date":
        if isinstance(value, datetime):
            return value.date().isoformat()
        if isinstance(value, date):
            return value.isoformat()
        return parse_date(str(value), default_country).isoformat()
    if t == "boolean":
        if isinstance(value, bool):
            return value
        s = str(value).strip().lower()
        if s in _TRUE:
            return True
        if s in _FALSE:
            return False
        raise InvalidValue(f"{defn.label}: expected yes or no")
    if t == "select":
        s = str(value).strip()
        for opt in defn.options or []:
            if opt.lower() == s.lower():
                return opt
        raise InvalidValue(f"{defn.label}: '{s[:30]}' is not one of the allowed options")
    raise InvalidValue(f"{defn.label}: unsupported type")


def valid_timezone(tz: str) -> bool:
    global _TZ
    if _TZ is None:
        _TZ = available_timezones() | {"UTC"}
    return tz in _TZ


def normalize_contact(
    raw: dict[str, Any],
    *,
    default_country: str | None,
    attr_defs: dict[str, ContactAttributeDefinition],
    phone_country_hint: str | None = None,
    strict_attributes: bool = True,
) -> NormalizedContact:
    """raw keys: core field names, 'full_name', 'tags', 'attributes' (dict) or 'attr:<key>'."""
    out = NormalizedContact()
    for f in CORE_TEXT_FIELDS:
        if f in raw:
            out.provided.add(f)
            v = _clean(raw.get(f))
            setattr(out, f, v[: MAX_TEXT[f]] if v else None)

    full = _clean(raw.get("full_name"))
    if full and not (out.first_name or out.last_name):
        parts = full.split(None, 1)
        out.first_name = parts[0][:100]
        out.last_name = parts[1][:100] if len(parts) > 1 else None
        out.provided.update({"first_name", "last_name"})

    if "country" in raw:
        out.provided.add("country")
        c = _clean(raw.get("country"))
        if c:
            code = normalize_country(c)
            if not code:
                raise InvalidValue(f"Unknown country '{c[:40]}'; use a name like India or a code like IN")
            out.country = code

    if "email" in raw:
        out.provided.add("email")
        out.email = normalize_email(_clean(raw.get("email")))

    if "phone" in raw:
        out.provided.add("phone")
        region = (phone_country_hint or out.country or default_country or "").upper() or None
        out.phone = parse_phone(_clean(raw.get("phone")), region)

    if out.country is None and out.phone and out.phone.country and "country" not in raw:
        out.country = out.phone.country

    if out.state and (out.country == "US" or (out.phone and out.phone.country == "US")):
        code = us_state_code(out.state)
        if code:
            out.state = code

    tz = _clean(raw.get("timezone"))
    if tz:
        if not valid_timezone(tz):
            raise InvalidValue(f"Unknown timezone '{tz[:40]}'")
        out.timezone = tz
        out.provided.add("timezone")
    elif out.phone or out.country:
        out.timezone = derive_timezone(out.phone, out.country, out.state)

    attrs: dict[str, Any] = dict(raw.get("attributes") or {})
    for k, v in raw.items():
        if k.startswith("attr:"):
            attrs[k[5:]] = v
    for key, value in attrs.items():
        defn = attr_defs.get(key)
        if defn is None:
            if strict_attributes:
                raise InvalidValue(f"Unknown custom field '{key[:40]}'")
            continue
        out.attributes[key] = coerce_attribute(defn, value, default_country)

    tags = raw.get("tags")
    if tags:
        names = tags if isinstance(tags, list) else re.split(r"[;,|]", str(tags))
        out.tags = [t.strip()[:60] for t in names if t and str(t).strip()][:20]
    return out


def identity_keys(rule: str, email: str | None, phone: str | None) -> tuple[str | None, str | None]:
    email_key = email if rule in ("email", "email_or_phone") else None
    phone_key = phone if rule in ("phone", "email_or_phone") else None
    return email_key, phone_key


def check_identity(rule: str, email: str | None, phone: str | None) -> None:
    if rule == "email" and not email:
        raise InvalidValue("Email is required")
    if rule == "phone" and not phone:
        raise InvalidValue("Phone is required")
    if rule == "email_or_phone" and not (email or phone):
        raise InvalidValue("Email or phone is required")
