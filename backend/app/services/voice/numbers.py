"""The platform's phone number pool and automatic caller selection.

* Signalcraft owns the numbers (bought from Twilio, Exotel or Telnyx) and loads them into the pool
  (platform admin). Customers never see, choose, rent or pay for numbers.
* Every call gets its caller number at dial time from pick_caller(): a number for the destination
  country and the kind the call category needs (India: 140-series for promotional calls, 160-series
  for service and transactional; US: local or toll-free). The choice is stable per contact, so the
  same person always sees the same number on retries and later campaigns.
* In simulation mode a missing number is created on the fly (provider "simulation").
"""
import hashlib
import random
import re

from sqlalchemy import false, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import NotFound
from app.models.voice import PhoneNumber
from app.schemas.common import Page, PageParams
from app.services import audit_service
from app.services.voice import rules

KINDS = {"IN": ("series_140", "series_160"), "US": ("local", "toll_free")}
KIND_LABELS = {"series_140": "140-series (promotional)", "series_160": "160-series (service & transactional)",
               "local": "Local", "toll_free": "Toll-free"}
COUNTRY_NAME = {"IN": "India", "US": "the United States"}
# Statuses a number may be called from. "assigned"/"quarantined" only exist on rows from the old rental flow.
USABLE = ("available",)


def kinds_for(country: str | None, category: str) -> tuple[str, ...]:
    """Number kinds that may place this category of call to this country, in order of preference."""
    if country == "IN":
        return ("series_140",) if category == "promotional" else ("series_160",)
    return ("local", "toll_free")


def _usable(provider: str) -> bool:
    if settings.COMMUNICATION_MODE != "live":
        return True
    from app.providers.voice.factory import live_credentials_missing

    return provider != "simulation" and live_credentials_missing(provider) is None


def _candidates(db: Session, country: str, kinds: tuple[str, ...], twilio_only: bool) -> list[PhoneNumber]:
    q = select(PhoneNumber).where(PhoneNumber.status.in_(USABLE), PhoneNumber.country == country,
                                  PhoneNumber.kind.in_(kinds))
    if twilio_only and settings.COMMUNICATION_MODE == "live":
        q = q.where(PhoneNumber.provider == "twilio")
    rows = [p for p in db.scalars(q.order_by(PhoneNumber.id)) if _usable(p.provider)]
    # Preferred kind first (US: local before toll-free); order by id inside a kind keeps the hash stable.
    return sorted(rows, key=lambda p: (kinds.index(p.kind), p.id))


def pick_caller(db: Session, *, country: str | None, kind: str | tuple[str, ...], contact_id: str | None,
                twilio_only: bool = False) -> PhoneNumber | None:
    """The pool number to call this contact from. Stable per contact: a hash of the contact id picks
    among the matching numbers (of the preferred kind) ordered by id."""
    if country not in KINDS:
        return None
    kinds = (kind,) if isinstance(kind, str) else tuple(kind)
    rows = _candidates(db, country, kinds, twilio_only)
    if not rows and settings.COMMUNICATION_MODE != "live":
        _fill_simulated(db, country, kinds[0], n=1)
        rows = _candidates(db, country, kinds, twilio_only)
    if not rows:
        return None
    best = [p for p in rows if p.kind == rows[0].kind]
    h = int(hashlib.sha256((contact_id or "").encode()).hexdigest(), 16)
    return best[h % len(best)]


def availability(db: Session, country: str | None, category: str, ai: bool = False) -> str | None:
    """None when Signalcraft can place this category of call to this country; otherwise why not."""
    if country not in KINDS:
        return "Calling is available to India and the United States."
    if settings.COMMUNICATION_MODE != "live":
        return None
    if not _candidates(db, country, kinds_for(country, category), twilio_only=ai):
        return f"Calling to {COUNTRY_NAME[country]} isn't available yet. Contact support."
    return None


def _simulated_number(country: str, kind: str) -> str:
    r = random.Random()  # noqa: S311 - simulated numbers only
    if country == "IN":
        return f"+91{'140' if kind == 'series_140' else '160'}{r.randint(1000000, 9999999)}"
    area = r.choice(("800", "833", "844", "855", "866", "877", "888")) if kind == "toll_free" else \
        r.choice(("212", "312", "415", "512", "617", "646", "702", "786"))
    return f"+1{area}{r.randint(200, 999)}{r.randint(1000, 9999)}"


def _fill_simulated(db: Session, country: str, kind: str, n: int = 1) -> None:
    for _ in range(n * 3):
        if n <= 0:
            break
        number = _simulated_number(country, kind)
        if db.scalar(select(PhoneNumber.id).where(PhoneNumber.number == number)):
            continue
        sp = db.begin_nested()
        try:
            db.add(PhoneNumber(number=number, country=country, kind=kind, provider="simulation",
                               status="available", included=False))
            sp.commit()
            n -= 1
        except IntegrityError:
            sp.rollback()
    db.flush()


# ------------------------------------------------------------------ platform admin


def admin_list(db: Session, params: PageParams, *, status: str | None = None, country: str | None = None,
               kind: str | None = None, search: str | None = None) -> dict:
    q = select(PhoneNumber)
    if status:
        q = q.where(PhoneNumber.status == status)
    if country:
        q = q.where(PhoneNumber.country == country)
    if kind:
        q = q.where(PhoneNumber.kind == kind)
    if search:
        digits = re.sub(r"\D", "", search)
        q = q.where(or_(PhoneNumber.number.like(f"%{digits}%") if digits else false(),
                        PhoneNumber.provider_ref.like(f"%{search.strip()}%")))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = list(db.scalars(q.order_by(PhoneNumber.created_at.desc(), PhoneNumber.number)
                           .offset(params.offset).limit(params.page_size)))
    items = [{"id": r.id, "number": r.number, "country": r.country, "kind": r.kind,
              "kind_label": KIND_LABELS.get(r.kind, r.kind), "provider": r.provider, "provider_ref": r.provider_ref,
              "status": r.status, "created_at": r.created_at} for r in rows]
    counts = dict(db.execute(select(PhoneNumber.status, func.count()).group_by(PhoneNumber.status)).all())
    page = Page(items=items, total=total, page=params.page, page_size=params.page_size)
    return {**page.model_dump(), "counts": counts}


def parse_bulk(text: str, default_country: str, default_kind: str, default_provider: str) -> list[dict]:
    """One number per line: "+911401234567" or "+911401234567, series_140, exotel, ref"."""
    out = []
    for line in (text or "").splitlines():
        parts = [p.strip() for p in re.split(r"[,\t;]", line) if p.strip()]
        if not parts:
            continue
        out.append({"number": parts[0], "kind": parts[1] if len(parts) > 1 else default_kind,
                    "provider": parts[2] if len(parts) > 2 else default_provider,
                    "provider_ref": parts[3] if len(parts) > 3 else None, "country": default_country})
    return out


def _clean(number: str) -> str:
    n = "".join(ch for ch in number if ch.isdigit() or ch == "+")
    return n if n.startswith("+") else f"+{n}"


def admin_add(db: Session, actor_id: str, items: list[dict]) -> dict:
    added, skipped = [], []
    for it in items[:1000]:
        number = _clean(str(it.get("number") or ""))
        country, kind = str(it.get("country") or "").upper(), str(it.get("kind") or "")
        provider = str(it.get("provider") or "simulation").lower()
        if provider not in ("twilio", "exotel", "telnyx", "simulation"):
            skipped.append({"number": number, "reason": "Unknown provider"})
            continue
        err = rules.validate_caller(country, kind, number)
        if err:
            skipped.append({"number": number, "reason": err})
            continue
        if db.scalar(select(PhoneNumber.id).where(PhoneNumber.number == number)):
            skipped.append({"number": number, "reason": "Already in the pool"})
            continue
        pn = PhoneNumber(number=number, country=country, kind=kind, provider=provider, status="available",
                         provider_ref=(str(it.get("provider_ref") or "").strip() or None), included=False)
        db.add(pn)
        db.flush()
        added.append(number)
    if added:
        audit_service.record(db, "admin.phone_numbers_added", actor_user_id=actor_id, target_type="phone_number",
                             summary=f"{len(added)} numbers", meta={"numbers": added[:50]})
    return {"added": len(added), "numbers": added, "skipped": skipped}


def admin_retire(db: Session, actor_id: str, phone_number_id: str) -> dict:
    pn = db.get(PhoneNumber, phone_number_id)
    if pn is None:
        raise NotFound("Number not found")
    pn.status = "retired"
    audit_service.record(db, "admin.phone_number_retired", actor_user_id=actor_id, target_type="phone_number",
                         target_id=pn.id, summary=pn.number)
    return {"id": pn.id, "status": pn.status}
