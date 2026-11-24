"""Companies: create, edit, list, duplicate checks (domain, GSTIN, phone, name) and linking contacts."""
import re
from decimal import Decimal

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.core.errors import Conflict, ValidationFailed
from app.core.permissions import Perm
from app.models import Company, Contact, Deal
from app.schemas.common import Page, PageParams
from app.schemas.crm import CompanyCreate, CompanyUpdate
from app.services.crm.common import audit, check_owner, currency_for, get_in_app, reach, user_ref, users_by_id
from app.utils.contact_normalize import parse_phone

GSTIN_RE = re.compile(r"^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_checksum_ok(gstin: str) -> bool:
    """GSTIN check character: weighted mod-36 over the first 14 characters."""
    total = 0
    for i, ch in enumerate(gstin[:14]):
        product = GSTIN_CHARS.index(ch) * (2 if i % 2 else 1)
        total += product // 36 + product % 36
    return GSTIN_CHARS[(36 - total % 36) % 36] == gstin[14]


def normalize_domain(value: str | None) -> str | None:
    if not value:
        return None
    v = value.strip().lower()
    v = re.sub(r"^[a-z]+://", "", v).split("/")[0].split("?")[0].removeprefix("www.")
    if not re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", v):
        raise ValidationFailed("Enter a domain like acme.com", code="INVALID_DOMAIN", details={"field": "domain"})
    return v


def normalize_gstin(value: str | None) -> str | None:
    if not value:
        return None
    v = value.strip().upper().replace(" ", "")
    if not GSTIN_RE.match(v) or not gstin_checksum_ok(v):
        raise ValidationFailed("GSTIN must be 15 characters, like 27AAPFU0939F1ZV", code="INVALID_GSTIN",
                               details={"field": "gstin"})
    return v


def _clean(db: Session, ctx, data: dict) -> dict:
    if "domain" in data:
        data["domain"] = normalize_domain(data["domain"])
    if "website" in data and data["website"] and "domain" not in data:
        try:
            data["domain"] = normalize_domain(data["website"])
        except ValidationFailed:
            pass
    if "gstin" in data:
        data["gstin"] = normalize_gstin(data["gstin"])
        if data["gstin"] and not data.get("pan"):
            data["pan"] = data["gstin"][2:12]
    if data.get("pan"):
        data["pan"] = data["pan"].strip().upper()
        if not PAN_RE.match(data["pan"]):
            raise ValidationFailed("PAN must look like AAPFU0939F", code="INVALID_PAN", details={"field": "pan"})
    if data.get("phone"):
        parsed = parse_phone(data["phone"], (data.get("country") or ctx.application.default_country or "IN"))
        if parsed is None:
            raise ValidationFailed("Enter a valid phone number", code="INVALID_PHONE", details={"field": "phone"})
        data["phone"] = parsed.e164
    if data.get("country"):
        data["country"] = data["country"].upper()
    if "owner_id" in data:
        check_owner(db, ctx, data["owner_id"])
    return data


def find_duplicates(db: Session, ctx, *, name: str | None = None, domain: str | None = None,
                    gstin: str | None = None, phone: str | None = None, exclude_id: str | None = None) -> list[dict]:
    ctx.require(Perm.CRM_READ)
    conds = []
    if domain:
        conds.append(("domain", Company.domain == domain))
    if gstin:
        conds.append(("gstin", Company.gstin == gstin))
    if phone:
        conds.append(("phone", Company.phone == phone))
    if name:
        conds.append(("name", func.lower(Company.name) == name.strip().lower()))
    out, seen = [], set()
    for label, cond in conds:
        q = select(Company).where(Company.application_id == ctx.application_id, cond)
        if exclude_id:
            q = q.where(Company.id != exclude_id)
        for c in db.scalars(q.limit(5)):
            if c.id not in seen:
                seen.add(c.id)
                out.append({"id": c.id, "name": c.name, "matched_on": label})
    return out


def _stats(db: Session, ids: list[str]) -> tuple[dict, dict]:
    if not ids:
        return {}, {}
    contacts = dict(db.execute(select(Contact.company_id, func.count()).where(
        Contact.company_id.in_(ids)).group_by(Contact.company_id)).all())
    deals = {r[0]: (r[1], r[2]) for r in db.execute(select(Deal.company_id, func.count(), func.coalesce(
        func.sum(Deal.amount), 0)).where(Deal.company_id.in_(ids), Deal.status == "open").group_by(Deal.company_id))}
    return contacts, deals


def out(db: Session, companies: list[Company]) -> list[dict]:
    contacts, deals = _stats(db, [c.id for c in companies])
    users = users_by_id(db, [c.owner_id for c in companies])
    rows = []
    for c in companies:
        n, value = deals.get(c.id, (0, 0))
        rows.append({**{k: getattr(c, k) for k in (
            "id", "name", "domain", "industry", "size", "annual_revenue", "currency", "phone", "website", "gstin",
            "pan", "gst_treatment", "country", "state", "city", "address", "postal_code", "description",
            "attributes", "created_at", "updated_at")},
            "owner": user_ref(users.get(c.owner_id)), "contact_count": contacts.get(c.id, 0),
            "open_deal_count": n, "open_deal_value": Decimal(str(value))})
    return rows


def list_companies(db: Session, ctx, params: PageParams, search: str | None, owner_id: str | None,
                   industry: str | None, sort: str = "name") -> Page:
    ctx.require(Perm.CRM_READ)
    q = select(Company).where(Company.application_id == ctx.application_id)
    if search:
        like = f"%{search.strip()}%"
        q = q.where(or_(Company.name.ilike(like), Company.domain.ilike(like), Company.gstin.ilike(like),
                        Company.city.ilike(like)))
    if owner_id:
        q = q.where(Company.owner_id == (ctx.user.id if owner_id == "me" else owner_id))
    if industry:
        q = q.where(Company.industry == industry)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    order = {"name": Company.name, "-created_at": Company.created_at.desc(), "created_at": Company.created_at,
             "-annual_revenue": Company.annual_revenue.desc(), "-name": Company.name.desc(),
             "-updated_at": Company.updated_at.desc(), "updated_at": Company.updated_at}.get(sort, Company.name)
    items = list(db.scalars(q.order_by(order).offset(params.offset).limit(params.page_size)))
    return Page(items=out(db, items), total=total, page=params.page, page_size=params.page_size)


def get_company(db: Session, ctx, company_id: str) -> dict:
    ctx.require(Perm.CRM_READ)
    return out(db, [get_in_app(db, ctx, Company, company_id, "Company")])[0]


def create_company(db: Session, ctx, data: CompanyCreate) -> Company:
    ctx.require(Perm.CRM_WRITE)
    values = _clean(db, ctx, data.model_dump(exclude={"allow_duplicate"}, exclude_none=True))
    if not data.allow_duplicate:
        dupes = find_duplicates(db, ctx, name=values.get("name"), domain=values.get("domain"),
                                gstin=values.get("gstin"), phone=values.get("phone"))
        if dupes:
            raise Conflict("A company like this already exists", code="POSSIBLE_DUPLICATE",
                           details={"duplicates": dupes})
    c = Company(organization_id=ctx.organization_id, application_id=ctx.application_id,
                currency=values.pop("currency", None) or currency_for(ctx), attributes=values.pop("attributes", None) or {},
                owner_id=values.pop("owner_id", None) or ctx.user.id, created_by_id=ctx.user.id, **values)
    db.add(c)
    db.flush()
    audit(db, ctx, "crm_company.created", "crm_company", c.id, f"Created company {c.name}")
    return c


def update_company(db: Session, ctx, company_id: str, data: CompanyUpdate) -> Company:
    ctx.require(Perm.CRM_WRITE)
    c = get_in_app(db, ctx, Company, company_id, "Company")
    values = _clean(db, ctx, data.model_dump(exclude_unset=True))
    if "name" in values and not values["name"]:
        raise ValidationFailed("Name is required", code="NAME_REQUIRED")
    for k in ("domain", "gstin"):
        if values.get(k) and values[k] != getattr(c, k):
            dupes = [d for d in find_duplicates(db, ctx, **{k: values[k]}, exclude_id=c.id)]
            if dupes:
                raise Conflict(f"Another company has this {k.upper() if k == 'gstin' else k}",
                               code="POSSIBLE_DUPLICATE", details={"duplicates": dupes})
    if "attributes" in values:
        values["attributes"] = values["attributes"] or {}
    renamed = "name" in values and values["name"] != c.name
    for k, v in values.items():
        setattr(c, k, v)
    if renamed:  # linked contacts show the company's current name
        db.execute(update(Contact).where(Contact.application_id == ctx.application_id, Contact.company_id == c.id)
                   .values(company=c.name))
    audit(db, ctx, "crm_company.updated", "crm_company", c.id, f"Updated company {c.name}",
          {"fields": sorted(values)})
    return c


def delete_company(db: Session, ctx, company_id: str) -> None:
    ctx.require(Perm.CRM_WRITE)
    c = get_in_app(db, ctx, Company, company_id, "Company")
    audit(db, ctx, "crm_company.deleted", "crm_company", c.id, f"Deleted company {c.name}")
    db.delete(c)


def link_contacts(db: Session, ctx, company_id: str, contact_ids: list[str]) -> int:
    ctx.require(Perm.CRM_WRITE)
    c = get_in_app(db, ctx, Company, company_id, "Company")
    n = db.execute(update(Contact).where(Contact.application_id == ctx.application_id, Contact.id.in_(contact_ids))
                   .values(company_id=c.id, company=c.name)).rowcount
    audit(db, ctx, "crm_company.contacts_linked", "crm_company", c.id, f"Linked {n} contacts to {c.name}")
    return n


def unlink_contacts(db: Session, ctx, company_id: str, contact_ids: list[str]) -> int:
    """Detach contacts from a company. Their free-text company is cleared too, so it doesn't re-link."""
    ctx.require(Perm.CRM_WRITE)
    c = get_in_app(db, ctx, Company, company_id, "Company")
    n = db.execute(update(Contact).where(Contact.application_id == ctx.application_id, Contact.company_id == c.id,
                                         Contact.id.in_(contact_ids)).values(company_id=None, company=None)).rowcount
    audit(db, ctx, "crm_company.contacts_unlinked", "crm_company", c.id, f"Unlinked {n} contacts from {c.name}")
    return n


# ------------------------------------------------------------------ free-text company <-> Company records

FREE_MAIL_DOMAINS = frozenset({
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "ymail.com", "outlook.com",
    "outlook.in", "hotmail.com", "hotmail.co.in", "live.com", "msn.com", "rediffmail.com", "icloud.com", "me.com",
    "mac.com", "aol.com", "protonmail.com", "proton.me", "zoho.com", "zohomail.in", "gmx.com", "mail.com",
})


def email_domain(email: str | None) -> str | None:
    """The company domain of an email address, or None for free-mail providers."""
    if not email or "@" not in email:
        return None
    d = email.rsplit("@", 1)[1].strip().lower()
    return None if not d or d in FREE_MAIL_DOMAINS else d


def match_company(db: Session, application_id: str, name: str | None, email: str | None) -> Company | None:
    """An existing company whose name matches the text (case-insensitive) or whose domain matches the email's."""
    if name and name.strip():
        co = db.scalar(select(Company).where(Company.application_id == application_id,
                                             func.lower(Company.name) == name.strip().lower()).limit(1))
        if co is not None:
            return co
    dom = email_domain(email)
    if dom:
        return db.scalar(select(Company).where(Company.application_id == application_id,
                                               Company.domain == dom).limit(1))
    return None


def relink_contact(db: Session, contact: Contact, *, company_changed: bool, email_changed: bool) -> None:
    """Keep contact.company_id in step with the free-text company and email.

    Editing the company text re-links (or unlinks when it matches nothing); a new email links by domain
    only when the contact has no company yet. A domain match fills in an empty company text."""
    if company_changed:
        text = (contact.company or "").strip()
        current = db.get(Company, contact.company_id) if contact.company_id else None
        if current is not None and text and current.name.strip().lower() == text.lower():
            return
        co = match_company(db, contact.application_id, text, None if text else contact.email)
        contact.company_id = co.id if co else None
        if co is not None and not text:
            contact.company = co.name
        return
    if email_changed and contact.company_id is None:
        co = match_company(db, contact.application_id, contact.company, contact.email)
        if co is not None:
            contact.company_id = co.id
            contact.company = contact.company or co.name


def from_contacts_preview(db: Session, ctx) -> dict:
    """How many companies could be created from contacts' free-text company names."""
    ctx.require(Perm.CRM_READ)
    names = _unlinked_names(db, ctx)
    existing = _existing_names(db, ctx)
    new = [n for n in names if n not in existing]
    return {"companies": len(new), "contacts": sum(names[n][1] for n in names)}


def _unlinked_names(db: Session, ctx) -> dict[str, tuple[str, int]]:
    """lower(name) -> (display name, unlinked contacts using it)."""
    rows = db.execute(select(Contact.company, func.count()).where(
        Contact.application_id == ctx.application_id, Contact.company_id.is_(None), Contact.company.is_not(None),
        Contact.company != "").group_by(Contact.company)).all()
    out: dict[str, tuple[str, int]] = {}
    for name, n in rows:
        key = name.strip().lower()
        if not key:
            continue
        disp, total = out.get(key, (name.strip(), 0))
        out[key] = (disp, total + n)
    return out


def _existing_names(db: Session, ctx) -> dict[str, str]:
    return {n.strip().lower(): i for i, n in db.execute(select(Company.id, Company.name).where(
        Company.application_id == ctx.application_id)).all()}


def create_from_contacts(db: Session, ctx, limit: int = 2000) -> dict:
    """Create a company for every distinct free-text company name on unlinked contacts, and link them."""
    ctx.require(Perm.CRM_WRITE)
    names = _unlinked_names(db, ctx)
    existing = _existing_names(db, ctx)
    created = 0
    for key, (disp, _) in list(names.items())[:limit]:
        if key not in existing:
            co = Company(organization_id=ctx.organization_id, application_id=ctx.application_id, name=disp[:200],
                         currency=currency_for(ctx), attributes={}, owner_id=ctx.user.id if ctx.user else None,
                         created_by_id=ctx.user.id if ctx.user else None)
            db.add(co)
            db.flush()
            existing[key] = co.id
            created += 1
    linked = 0
    for key in names:
        if key in existing:
            linked += db.execute(update(Contact).where(
                Contact.application_id == ctx.application_id, Contact.company_id.is_(None),
                func.lower(func.trim(Contact.company)) == key).values(company_id=existing[key])).rowcount
    audit(db, ctx, "crm_company.created_from_contacts", "crm_company", ctx.application_id,
          f"Created {created} companies from contact company names", {"created": created, "linked": linked})
    return {"created": created, "linked": linked}


def suggested_contacts(db: Session, ctx, company_id: str, limit: int = 50) -> list[dict]:
    """Contacts not linked to this company whose company text or email domain matches it."""
    ctx.require(Perm.CRM_READ)
    c = get_in_app(db, ctx, Company, company_id, "Company")
    conds = [func.lower(func.trim(Contact.company)) == c.name.strip().lower()]
    if c.domain:
        conds.append(func.lower(Contact.email).like(f"%@{c.domain}"))
    rows = db.scalars(select(Contact).where(
        Contact.application_id == ctx.application_id, or_(Contact.company_id.is_(None), Contact.company_id != c.id),
        or_(*conds)).order_by(Contact.created_at.desc()).limit(limit))
    out = []
    for x in rows:
        reason = "domain" if c.domain and (x.email or "").lower().endswith("@" + c.domain) else "name"
        out.append({"id": x.id, "name": x.full_name or x.email or x.phone or "Unnamed", "email": x.email,
                    "phone": x.phone, "company": x.company, "matched_on": reason})
    return out


def company_contacts(db: Session, ctx, company_id: str) -> list[dict]:
    ctx.require(Perm.CRM_READ)
    c = get_in_app(db, ctx, Company, company_id, "Company")
    rows = db.scalars(select(Contact).where(Contact.company_id == c.id).order_by(Contact.first_name).limit(500))
    return [{"id": x.id, "name": x.full_name or x.email or x.phone or "Unnamed", "email": x.email, "phone": x.phone,
             "lifecycle_stage": x.lifecycle_stage, "lead_score": x.lead_score, "reach": reach(x)} for x in rows]
