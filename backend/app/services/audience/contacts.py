"""Contact CRUD, bulk actions, consent changes, activity and export."""
import csv
import io
from collections.abc import Iterator

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.permissions import Perm
from app.models import (
    ConsentRecord,
    Contact,
    ContactActivity,
    ContactAttributeDefinition,
    ContactList,
    ContactListMember,
    ContactTag,
    Tag,
    User,
)
from app.schemas.audience import (
    ActivityOut,
    BulkAction,
    ConsentChange,
    ConsentRecordOut,
    ContactCreate,
    ContactDetail,
    ContactFilters,
    ContactListItem,
    ContactUpdate,
    TagOut,
)
from app.schemas.common import Page, PageParams
from app.services import audit_service
from app.services.audience import consent as consent_svc
from app.services.audience.normalize import NormalizedContact, check_identity, identity_keys, normalize_contact
from app.services.audience.query import apply_filters, apply_sort, base_query, count
from app.services.billing import plans
from app.services.regions import profile_for
from app.services.tenancy import AppContext
from app.utils.contact_normalize import InvalidValue, format_phone, identifier_hash

MAX_BULK = 50_000


def identity_rule(db: Session, ctx: AppContext) -> str:
    from app.models import ApplicationSettings

    s = db.scalar(select(ApplicationSettings.contact_identity_rule).where(
        ApplicationSettings.application_id == ctx.application_id))
    return s or "email_or_phone"


def attr_defs(db: Session, ctx: AppContext) -> dict[str, ContactAttributeDefinition]:
    return {d.key: d for d in db.scalars(select(ContactAttributeDefinition).where(
        ContactAttributeDefinition.application_id == ctx.application_id))}


def to_list_item(c: Contact, ctx: AppContext, owners: dict | None = None) -> ContactListItem:
    return ContactListItem(
        id=c.id, first_name=c.first_name, last_name=c.last_name, full_name=c.full_name, email=c.email, phone=c.phone,
        phone_display=format_phone(c.phone, ctx.application.default_country), phone_country=c.phone_country,
        company=c.company, city=c.city,
        state=c.state, country=c.country, status=c.status, email_consent=c.email_consent, sms_consent=c.sms_consent,
        voice_consent=c.voice_consent, email_unsubscribed=c.email_unsubscribed_at is not None,
        sms_unsubscribed=c.sms_unsubscribed_at is not None, voice_unsubscribed=c.voice_unsubscribed_at is not None,
        tags=[TagOut.model_validate(t) for t in sorted(c.tags, key=lambda t: t.name.lower())],
        created_at=c.created_at, last_activity_at=c.last_activity_at,
        company_id=c.company_id, owner_id=c.owner_id, lifecycle_stage=c.lifecycle_stage, lead_score=c.lead_score or 0,
        owner_name=_owner_name(owners, c.owner_id),
    )


def _owner_name(owners: dict | None, owner_id: str | None) -> str | None:
    u = (owners or {}).get(owner_id) if owner_id else None
    return (u.full_name or u.email) if u else None


def _owners(db: Session, ids) -> dict:
    ids = {i for i in ids if i}
    return {u.id: u for u in db.scalars(select(User).where(User.id.in_(ids)))} if ids else {}


def get_contact(db: Session, ctx: AppContext, contact_id: str) -> Contact:
    c = db.scalar(select(Contact).where(Contact.id == contact_id, Contact.application_id == ctx.application_id))
    if c is None:
        raise NotFound("Contact not found")
    return c


def detail(db: Session, ctx: AppContext, contact_id: str) -> ContactDetail:
    ctx.require(Perm.AUDIENCE_READ)
    c = get_contact(db, ctx, contact_id)
    lists = db.execute(select(ContactList.id, ContactList.name).join(
        ContactListMember, ContactListMember.list_id == ContactList.id).where(
        ContactListMember.contact_id == c.id).order_by(ContactList.name)).all()
    jur = c.phone_country or c.country
    base = to_list_item(c, ctx, _owners(db, [c.owner_id])).model_dump()
    return ContactDetail(
        **base, phone_type=c.phone_type, postal_code=c.postal_code,
        timezone=c.timezone, source=c.source, attributes=c.attributes or {},
        lists=[{"id": i, "name": n} for i, n in lists], email_unsubscribed_at=c.email_unsubscribed_at,
        sms_unsubscribed_at=c.sms_unsubscribed_at, voice_unsubscribed_at=c.voice_unsubscribed_at,
        jurisdiction=jur, jurisdiction_name=profile_for(jur).name if jur in ("IN", "US") else (jur or "Unknown"),
        eligibility=consent_svc.eligibility(db, ctx, c), updated_at=c.updated_at,
    )


def list_contacts(db: Session, ctx: AppContext, filters: ContactFilters, params: PageParams,
                  sort: str | None) -> Page[ContactListItem]:
    ctx.require(Perm.AUDIENCE_READ)
    stmt = apply_filters(db, ctx, base_query(ctx), filters)
    total = count(db, stmt)
    rows = db.scalars(apply_sort(stmt, sort).offset(params.offset).limit(params.page_size)).all()
    owners = _owners(db, [c.owner_id for c in rows])
    return Page(items=[to_list_item(c, ctx, owners) for c in rows], total=total, page=params.page,
                page_size=params.page_size)


# ------------------------------------------------------------------ write helpers

def _normalize(db: Session, ctx: AppContext, data, defs) -> NormalizedContact:
    raw = data.model_dump(exclude_unset=True, exclude={"tag_ids", "list_ids", "consent", "status", "phone_country",
                                                       "company_id", "owner_id", "lifecycle_stage", "clear_owner"})
    try:
        return normalize_contact(raw, default_country=ctx.application.default_country, attr_defs=defs,
                                 phone_country_hint=data.phone_country)
    except InvalidValue as exc:
        raise ValidationFailed(str(exc), code="INVALID_CONTACT") from exc


def _find_conflict(db: Session, ctx: AppContext, email_key: str | None, phone_key: str | None,
                   exclude_id: str | None = None) -> Contact | None:
    for col, val in ((Contact.email_key, email_key), (Contact.phone_key, phone_key)):
        if val:
            q = select(Contact).where(Contact.application_id == ctx.application_id, col == val)
            if exclude_id:
                q = q.where(Contact.id != exclude_id)
            found = db.scalar(q)
            if found:
                return found
    return None


def apply_normalized(c: Contact, n: NormalizedContact, rule: str, *, only_provided: bool,
                     keep_existing: bool = False) -> None:
    """Copy normalised values onto a contact. keep_existing: only fill or overwrite with non-empty values."""
    def setv(attr, value, key=None):
        key = key or attr
        if only_provided and key not in n.provided:
            return
        if keep_existing and (value is None or value == ""):
            return
        setattr(c, attr, value)

    for f in ("first_name", "last_name", "company", "state", "city", "postal_code", "source", "country"):
        setv(f, getattr(n, f))
    if not only_provided or "email" in n.provided:
        if not (keep_existing and not n.email):
            c.email = n.email
            c.email_hash = identifier_hash(n.email) if n.email else None
    if not only_provided or "phone" in n.provided:
        if not (keep_existing and not n.phone):
            c.phone = n.phone.e164 if n.phone else None
            c.phone_hash = identifier_hash(c.phone) if c.phone else None
            c.phone_country = n.phone.country if n.phone else None
            c.phone_type = n.phone.number_type if n.phone else None
    if n.timezone and (not keep_existing or not c.timezone or "timezone" in n.provided):
        c.timezone = n.timezone
    c.email_key, c.phone_key = identity_keys(rule, c.email, c.phone)
    if n.attributes:
        merged = dict(c.attributes or {})
        for k, v in n.attributes.items():
            if v is None and keep_existing:
                continue
            if v is None:
                merged.pop(k, None)
            else:
                merged[k] = v
        c.attributes = merged


def _validate_ids(db: Session, ctx: AppContext, model, ids: list[str], label: str) -> list[str]:
    ids = list(dict.fromkeys(ids))
    if not ids:
        return []
    found = set(db.scalars(select(model.id).where(model.id.in_(ids), model.application_id == ctx.application_id)))
    if len(found) != len(ids):
        raise ValidationFailed(f"One or more {label} do not exist in this application", code="INVALID_REFERENCE")
    return ids


def add_tags(db: Session, ctx: AppContext, contact_ids: list[str], tag_ids: list[str]) -> int:
    if not contact_ids or not tag_ids:
        return 0
    existing = set(db.execute(select(ContactTag.contact_id, ContactTag.tag_id).where(
        ContactTag.contact_id.in_(contact_ids), ContactTag.tag_id.in_(tag_ids))).all())
    rows = [ContactTag(contact_id=c, tag_id=t, application_id=ctx.application_id)
            for c in contact_ids for t in tag_ids if (c, t) not in existing]
    db.add_all(rows)
    return len(rows)


def add_to_lists(db: Session, ctx: AppContext, contact_ids: list[str], list_ids: list[str]) -> int:
    if not contact_ids or not list_ids:
        return 0
    existing = set(db.execute(select(ContactListMember.contact_id, ContactListMember.list_id).where(
        ContactListMember.contact_id.in_(contact_ids), ContactListMember.list_id.in_(list_ids))).all())
    rows = [ContactListMember(contact_id=c, list_id=li, application_id=ctx.application_id)
            for c in contact_ids for li in list_ids if (c, li) not in existing]
    db.add_all(rows)
    return len(rows)


# ------------------------------------------------------------------ CRUD

def create_contact(db: Session, ctx: AppContext, data: ContactCreate, ip: str | None = None) -> Contact:
    ctx.require(Perm.AUDIENCE_WRITE)
    plans.check_limit(db, ctx.organization_id, "contacts", plans.count_usage(db, ctx.organization_id, "contacts"))
    defs = attr_defs(db, ctx)
    n = _normalize(db, ctx, data, defs)
    rule = identity_rule(db, ctx)
    try:
        check_identity(rule, n.email, n.phone.e164 if n.phone else None)
    except InvalidValue as exc:
        raise ValidationFailed(str(exc), code="IDENTIFIER_REQUIRED") from exc
    email_key, phone_key = identity_keys(rule, n.email, n.phone.e164 if n.phone else None)
    dup = _find_conflict(db, ctx, email_key, phone_key)
    if dup:
        raise Conflict("A contact with this email or phone already exists", code="DUPLICATE_CONTACT",
                       details={"contact_id": dup.id})
    tag_ids = _validate_ids(db, ctx, Tag, data.tag_ids, "tags")
    list_ids = _validate_ids(db, ctx, ContactList, data.list_ids, "lists")
    owner_id = _crm_owner(db, ctx, data.owner_id)
    c = Contact(organization_id=ctx.organization_id, application_id=ctx.application_id, created_by_id=ctx.user.id,
                source=n.source or "manual", attributes={})
    apply_normalized(c, n, rule, only_provided=False)
    c.source = c.source or "manual"
    _apply_company(db, ctx, c, data, company_changed=True, email_changed=bool(c.email))
    if owner_id:
        c.owner_id = owner_id
    if data.lifecycle_stage:
        _require_crm(ctx)
        c.lifecycle_stage = data.lifecycle_stage
    db.add(c)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise Conflict("A contact with this email or phone already exists", code="DUPLICATE_CONTACT") from exc
    for ch in consent_svc.CHANNELS:
        if getattr(data.consent, ch):
            consent_svc.grant(db, ctx, c, ch, method="manual", source=data.consent.source,
                              evidence=data.consent.evidence, consent_reference=data.consent.consent_reference,
                              actor_id=ctx.user.id, ip=ip)
    add_tags(db, ctx, [c.id], tag_ids)
    add_to_lists(db, ctx, [c.id], list_ids)
    consent_svc.record_activity(db, ctx, c.id, "created", "Contact created", {"source": c.source}, ctx.user.id)
    from app.services.crm import leads as crm_leads

    if owner_id:
        crm_leads._assigned(db, c, by_user=ctx.user.id)
    crm_leads.assign_contact_now(db, c)  # assignment rules + first-response SLA, right away
    return c


def _require_crm(ctx: AppContext) -> None:
    ctx.require(Perm.CRM_WRITE)


def _crm_owner(db: Session, ctx: AppContext, owner_id: str | None) -> str | None:
    if not owner_id:
        return None
    _require_crm(ctx)
    from app.services.crm.common import check_owner

    return check_owner(db, ctx, owner_id)


def _apply_company(db: Session, ctx: AppContext, c: Contact, data, *, company_changed: bool,
                   email_changed: bool) -> None:
    """Link the contact to a CRM company: the one chosen, else by name or email domain."""
    from app.models import Company
    from app.services.crm.companies import relink_contact

    if data.company_id:
        co = db.scalar(select(Company).where(Company.id == data.company_id,
                                             Company.application_id == ctx.application_id))
        if co is None:
            raise ValidationFailed("That company doesn't exist in this application", code="INVALID_REFERENCE")
        c.company_id, c.company = co.id, co.name
        return
    if company_changed or email_changed:
        relink_contact(db, c, company_changed=company_changed, email_changed=email_changed)


def update_contact(db: Session, ctx: AppContext, contact_id: str, data: ContactUpdate) -> Contact:
    ctx.require(Perm.AUDIENCE_WRITE)
    c = get_contact(db, ctx, contact_id)
    defs = attr_defs(db, ctx)
    n = _normalize(db, ctx, data, defs)
    rule = identity_rule(db, ctx)
    email = n.email if "email" in n.provided else c.email
    phone = (n.phone.e164 if n.phone else None) if "phone" in n.provided else c.phone
    try:
        check_identity(rule, email, phone)
    except InvalidValue as exc:
        raise ValidationFailed(str(exc), code="IDENTIFIER_REQUIRED") from exc
    ek, pk = identity_keys(rule, email, phone)
    dup = _find_conflict(db, ctx, ek, pk, exclude_id=c.id)
    if dup:
        raise Conflict("Another contact already uses this email or phone", code="DUPLICATE_CONTACT",
                       details={"contact_id": dup.id})
    old_email, old_phone, old_company = c.email, c.phone, c.company
    owner_id = _crm_owner(db, ctx, data.owner_id) if data.owner_id and data.owner_id != c.owner_id else None
    apply_normalized(c, n, rule, only_provided=True)
    _apply_company(db, ctx, c, data, company_changed="company" in n.provided and c.company != old_company,
                   email_changed=c.email != old_email)
    if owner_id or (data.clear_owner and c.owner_id) or (data.lifecycle_stage
                                                         and data.lifecycle_stage != c.lifecycle_stage):
        from app.services.crm import leads as crm_leads

        if owner_id or data.clear_owner:
            crm_leads.bulk_assign_owner(db, ctx, [c], owner_id)
        if data.lifecycle_stage:
            crm_leads.bulk_set_lifecycle(db, ctx, [c], data.lifecycle_stage)
    # A changed identifier is a different address; consent for the old one does not carry over.
    if c.email != old_email and c.email_consent:
        c.email_consent = False
    if c.phone != old_phone:
        c.sms_consent = c.voice_consent = False
    if data.status is not None and data.status != c.status:
        consent_svc.record_activity(db, ctx, c.id, "status_changed", f"Status changed to {data.status}",
                                    {"from": c.status, "to": data.status}, ctx.user.id)
        c.status = data.status
    consent_svc.record_activity(db, ctx, c.id, "updated", "Contact details updated",
                                {"fields": sorted(n.provided)}, ctx.user.id)
    return c


def delete_contacts(db: Session, ctx: AppContext, ids: list[str]) -> int:
    """Hard delete (erasure). Suppression entries are hash-based and remain in force."""
    ctx.require(Perm.AUDIENCE_WRITE)
    if not ids:
        return 0
    n = db.execute(delete(Contact).where(Contact.application_id == ctx.application_id, Contact.id.in_(ids))).rowcount
    audit_service.record(db, "contacts.deleted", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="contact",
                         target_id=ids[0] if len(ids) == 1 else None, summary=f"Deleted {n} contact(s)",
                         meta={"count": n})
    return n


def change_consent(db: Session, ctx: AppContext, contact_id: str, body: ConsentChange, ip: str | None) -> Contact:
    ctx.require(Perm.AUDIENCE_WRITE)
    c = get_contact(db, ctx, contact_id)
    if body.status == "granted":
        if not consent_svc.grant(db, ctx, c, body.channel, method="manual", source=body.source,
                                 evidence=body.evidence, consent_reference=body.consent_reference,
                                 actor_id=ctx.user.id, ip=ip):
            raise ValidationFailed("This contact has no address for that channel", code="NO_IDENTIFIER")
    else:
        consent_svc.revoke(db, ctx, c, body.channel, method="manual", source=body.source or "Updated by team member",
                           actor_id=ctx.user.id, ip=ip)
    return c


def _target_ids(db: Session, ctx: AppContext, body: BulkAction) -> list[str]:
    if body.contact_ids:
        return list(db.scalars(select(Contact.id).where(Contact.application_id == ctx.application_id,
                                                        Contact.id.in_(body.contact_ids))))
    if body.filters is not None:
        stmt = apply_filters(db, ctx, base_query(ctx), body.filters).with_only_columns(Contact.id).limit(MAX_BULK + 1)
        ids = list(db.scalars(stmt))
        if len(ids) > MAX_BULK:
            raise ValidationFailed(f"Bulk actions are limited to {MAX_BULK:,} contacts at a time")
        return ids
    raise ValidationFailed("Provide contact_ids or filters")


def bulk(db: Session, ctx: AppContext, body: BulkAction) -> dict:
    ctx.require(Perm.AUDIENCE_WRITE)
    ids = _target_ids(db, ctx, body)
    affected = 0
    if body.action == "delete":
        affected = delete_contacts(db, ctx, ids)
    elif body.action in ("assign_owner", "set_lifecycle"):
        from app.services.crm import leads as crm_leads

        if body.action == "set_lifecycle" and not body.lifecycle_stage:
            raise ValidationFailed("Choose a lifecycle stage", code="LIFECYCLE_REQUIRED")
        for i in range(0, len(ids), 1000):
            batch = list(db.scalars(select(Contact).where(Contact.application_id == ctx.application_id,
                                                          Contact.id.in_(ids[i:i + 1000]))))
            if body.action == "assign_owner":
                affected += crm_leads.bulk_assign_owner(db, ctx, batch, body.owner_id)
            else:
                affected += crm_leads.bulk_set_lifecycle(db, ctx, batch, body.lifecycle_stage)
    elif body.action in ("add_tag", "remove_tag"):
        tag = db.scalar(select(Tag).where(Tag.id == body.tag_id, Tag.application_id == ctx.application_id))
        if tag is None:
            raise ValidationFailed("Choose a tag", code="INVALID_REFERENCE")
        if body.action == "add_tag":
            for i in range(0, len(ids), 1000):
                affected += add_tags(db, ctx, ids[i:i + 1000], [tag.id])
        else:
            for i in range(0, len(ids), 1000):
                affected += db.execute(delete(ContactTag).where(ContactTag.tag_id == tag.id,
                                                                ContactTag.contact_id.in_(ids[i:i + 1000]))).rowcount
    else:
        lst = db.scalar(select(ContactList).where(ContactList.id == body.list_id,
                                                  ContactList.application_id == ctx.application_id))
        if lst is None:
            raise ValidationFailed("Choose a list", code="INVALID_REFERENCE")
        if body.action == "add_to_list":
            for i in range(0, len(ids), 1000):
                affected += add_to_lists(db, ctx, ids[i:i + 1000], [lst.id])
        else:
            for i in range(0, len(ids), 1000):
                affected += db.execute(delete(ContactListMember).where(
                    ContactListMember.list_id == lst.id, ContactListMember.contact_id.in_(ids[i:i + 1000]))).rowcount
    if body.action != "delete":
        audit_service.record(db, f"contacts.bulk_{body.action}", actor_user_id=ctx.user.id,
                             organization_id=ctx.organization_id, application_id=ctx.application_id,
                             summary=f"{body.action.replace('_', ' ')} on {len(ids)} contact(s)",
                             meta={"matched": len(ids), "affected": affected})
    return {"matched": len(ids), "affected": affected}


def activity(db: Session, ctx: AppContext, contact_id: str, params: PageParams) -> Page[ActivityOut]:
    ctx.require(Perm.AUDIENCE_READ)
    get_contact(db, ctx, contact_id)
    base = select(ContactActivity, User.full_name).outerjoin(User, User.id == ContactActivity.actor_user_id).where(
        ContactActivity.contact_id == contact_id, ContactActivity.application_id == ctx.application_id)
    total = count_rows(db, base)
    rows = db.execute(base.order_by(ContactActivity.created_at.desc()).offset(params.offset)
                      .limit(params.page_size)).all()
    items = []
    for a, name in rows:
        o = ActivityOut.model_validate(a)
        o.actor_name = name
        items.append(o)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def consent_history(db: Session, ctx: AppContext, contact_id: str) -> list[ConsentRecordOut]:
    ctx.require(Perm.AUDIENCE_READ)
    get_contact(db, ctx, contact_id)
    rows = db.execute(select(ConsentRecord, User.full_name).outerjoin(User, User.id == ConsentRecord.recorded_by_id)
                      .where(ConsentRecord.contact_id == contact_id,
                             ConsentRecord.application_id == ctx.application_id)
                      .order_by(ConsentRecord.created_at.desc())).all()
    out = []
    for r, name in rows:
        o = ConsentRecordOut.model_validate(r)
        o.recorded_by_name = name
        out.append(o)
    return out


def count_rows(db: Session, stmt) -> int:
    from sqlalchemy import func

    return db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0


# ------------------------------------------------------------------ export

EXPORT_COLUMNS = ["id", "first_name", "last_name", "email", "phone", "company", "city", "state", "country",
                  "postal_code", "timezone", "source", "status", "email_consent", "sms_consent", "voice_consent",
                  "email_unsubscribed_at", "sms_unsubscribed_at", "voice_unsubscribed_at", "tags", "created_at"]


def _safe_cell(v) -> str:
    """Neutralise spreadsheet formula injection, leaving E.164 phone numbers readable."""
    if v is None:
        return ""
    s = v.isoformat() if hasattr(v, "isoformat") else str(v)
    if s and s[0] in "=+-@\t\r" and not (s[0] == "+" and s[1:].isdigit()):
        return "'" + s
    return s


def export_csv(ctx: AppContext, filters: ContactFilters, ids: list[str] | None) -> Iterator[str]:
    """Stream a CSV using its own session (the request session closes before streaming ends)."""
    with SessionLocal() as db:
        defs = sorted(attr_defs(db, ctx).values(), key=lambda d: d.key)
        stmt = apply_filters(db, ctx, base_query(ctx), filters)
        if ids:
            stmt = stmt.where(Contact.id.in_(ids))
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(EXPORT_COLUMNS + [d.key for d in defs])
        yield "﻿" + buf.getvalue()  # BOM so Excel opens UTF-8 (Hindi names, ₹) correctly
        offset = 0
        while True:
            batch = db.scalars(stmt.order_by(Contact.created_at, Contact.id).offset(offset).limit(1000)).all()
            if not batch:
                break
            buf = io.StringIO()
            w = csv.writer(buf)
            for c in batch:
                row = [getattr(c, col) if col != "tags" else ";".join(t.name for t in c.tags) for col in EXPORT_COLUMNS]
                row += [(c.attributes or {}).get(d.key) for d in defs]
                w.writerow([_safe_cell(v) for v in row])
            yield buf.getvalue()
            offset += len(batch)
