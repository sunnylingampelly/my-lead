"""Background processing of a contact import.

Restart safety: every source row produces exactly one import_rows record, unique on
(import_id, row_number). A retried or resumed job skips rows already recorded, and contacts are
matched by their identity keys, so a retry never creates duplicate contacts.
"""
from dataclasses import dataclass

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.core.errors import ValidationFailed
from app.core.logging import get_logger
from app.integrations.storage import get_storage
from app.models import Application, Contact, ContactAttributeDefinition, Import, ImportRow, User
from app.models.base import new_uuid
from app.services.audience import consent as consent_svc
from app.services.audience import import_files
from app.services.audience.contacts import add_tags, add_to_lists, apply_normalized
from app.services.audience.imports import row_to_raw
from app.services.audience.normalize import check_identity, identity_keys, normalize_contact
from app.services.billing import plans
from app.services.notification_service import notify
from app.utils.contact_normalize import InvalidValue
from app.utils.time import utcnow

log = get_logger(__name__)
CHUNK = 500


@dataclass
class TaskContext:
    """The subset of AppContext the audience helpers need, for use outside a request."""

    organization_id: str
    application_id: str
    application: Application
    user: User | None


def _counts(db: Session, imp: Import) -> None:
    counts = dict(db.execute(select(ImportRow.status, func.count()).where(ImportRow.import_id == imp.id)
                             .group_by(ImportRow.status)).all())
    imp.created_count = counts.get("created", 0)
    imp.updated_count = counts.get("updated", 0)
    imp.duplicate_count = counts.get("duplicate", 0)
    imp.skipped_count = counts.get("skipped", 0)
    imp.invalid_count = counts.get("invalid", 0)
    imp.failed_count = counts.get("failed", 0)
    imp.processed_rows = sum(counts.values())
    imp.heartbeat_at = utcnow()


def run_import(import_id: str) -> str:
    db = SessionLocal()
    try:
        imp = db.scalar(select(Import).where(Import.id == import_id).with_for_update())
        if imp is None or imp.status not in ("queued", "processing"):
            return imp.status if imp else "missing"
        imp.status = "processing"
        imp.attempts += 1
        imp.started_at = imp.started_at or utcnow()
        imp.heartbeat_at = utcnow()
        db.commit()
        _process(db, imp)
        return imp.status
    except Exception as exc:
        db.rollback()
        imp = db.get(Import, import_id)
        log.exception("import_failed", import_id=import_id)
        if imp is not None and imp.attempts >= 3:
            imp.status = "failed"
            imp.error = "Processing failed repeatedly. Download the report for completed rows and contact support."
            imp.completed_at = utcnow()
            notify(db, imp.created_by_id, type_="import_failed", level="error",
                   title=f"Import failed: {imp.file_name}", body=imp.error,
                   link=f"/apps/{imp.application_id}/audience/import/{imp.id}",
                   organization_id=imp.organization_id, application_id=imp.application_id)
            db.commit()
            return "failed"
        raise exc
    finally:
        db.close()


def _process(db: Session, imp: Import) -> None:
    app = db.get(Application, imp.application_id)
    user = db.get(User, imp.created_by_id) if imp.created_by_id else None
    ctx = TaskContext(imp.organization_id, imp.application_id, app, user)
    defs = {d.key: d for d in db.scalars(select(ContactAttributeDefinition).where(
        ContactAttributeDefinition.application_id == app.id))}
    opts = imp.options or {}
    rule = opts.get("identity_rule", "email_or_phone")
    done = set(db.scalars(select(ImportRow.row_number).where(ImportRow.import_id == imp.id)))
    seen: dict[str, int] = {}
    _, rows = import_files.iter_rows(get_storage().get(imp.file_key), imp.file_type)

    chunk: list[tuple[int, dict]] = []
    for line, row in rows:
        if not any(row.values()) or line in done:
            continue
        chunk.append((line, row))
        if len(chunk) >= CHUNK:
            if not _chunk(db, ctx, imp, chunk, defs, rule, opts, seen):
                return
            chunk = []
    if chunk and not _chunk(db, ctx, imp, chunk, defs, rule, opts, seen):
        return
    _counts(db, imp)
    imp.status = "completed"
    imp.completed_at = utcnow()
    skipped = imp.duplicate_count + imp.skipped_count + imp.invalid_count + imp.failed_count
    notify(db, imp.created_by_id, type_="import_completed", level="warning" if skipped else "success",
           title=f"Import finished: {imp.file_name}",
           body=f"{imp.created_count:,} created, {imp.updated_count:,} updated"
                + (f", {skipped:,} not imported (see report)" if skipped else ""),
           link=f"/apps/{imp.application_id}/audience/import/{imp.id}",
           organization_id=imp.organization_id, application_id=imp.application_id)
    db.commit()
    log.info("import_completed", import_id=imp.id, processed=imp.processed_rows, created=imp.created_count,
             updated=imp.updated_count)


def _chunk(db: Session, ctx: TaskContext, imp: Import, chunk, defs, rule, opts, seen) -> bool:
    db.refresh(imp)
    if imp.status == "cancelled":
        _counts(db, imp)
        imp.completed_at = utcnow()
        db.commit()
        return False

    country = ctx.application.default_country
    parsed = []
    results: list[ImportRow] = []

    def outcome(line, status, reason=None, contact_id=None, raw=None):
        results.append(ImportRow(id=new_uuid(), import_id=imp.id, row_number=line, status=status, reason=reason,
                                 contact_id=contact_id, raw=raw if status not in ("created", "updated") else None))

    raw_by_line: dict[int, dict] = {}
    for line, row in chunk:
        raw = row_to_raw(row, imp.mapping)
        raw_by_line[line] = raw
        try:
            n = normalize_contact(raw, default_country=country, attr_defs=defs)
            if n.is_empty():
                outcome(line, "skipped", "No contact details in this row", raw=row)
                continue
            phone = n.phone.e164 if n.phone else None
            check_identity(rule, n.email, phone)
        except InvalidValue as exc:
            outcome(line, "invalid", str(exc), raw=row)
            continue
        ek, pk = identity_keys(rule, n.email, phone)
        parsed.append((line, row, n, ek, pk))

    ek_list = [p[3] for p in parsed if p[3]]
    pk_list = [p[4] for p in parsed if p[4]]
    by_email, by_phone = {}, {}
    if ek_list or pk_list:
        conds = []
        if ek_list:
            conds.append(Contact.email_key.in_(ek_list))
        if pk_list:
            conds.append(Contact.phone_key.in_(pk_list))
        for c in db.scalars(select(Contact).where(Contact.application_id == ctx.application_id, or_(*conds))):
            if c.email_key:
                by_email[c.email_key] = c
            if c.phone_key:
                by_phone[c.phone_key] = c

    crm = _CrmLinker(db, ctx, imp, opts)
    consent_opts = opts.get("consent") or {}
    channels = [ch for ch in ("email", "sms", "voice") if consent_opts.get(ch)] if consent_opts.get("confirmed") else []
    tag_ids, list_id = opts.get("tag_ids") or [], opts.get("list_id")
    update_existing = opts.get("duplicate_handling") == "update"
    touched: list[str] = []
    # The plan's contact limit: new contacts beyond it are skipped with a clear reason (updates still apply).
    cap = plans.limit(db, ctx.organization_id, "contacts")
    room = None if cap is None else cap - plans.count_usage(db, ctx.organization_id, "contacts")
    limit_reason = (f"Contact limit reached: your plan allows {cap:,} contacts. Upgrade to Pro for unlimited contacts."
                    if cap is not None else "")

    for line, row, n, ek, pk in parsed:
        prior = (ek and seen.get(ek)) or (pk and seen.get(pk))
        if prior:
            outcome(line, "duplicate", f"Same email or phone as row {prior}", raw=row)
            continue
        c_email, c_phone = by_email.get(ek) if ek else None, by_phone.get(pk) if pk else None
        if c_email and c_phone and c_email.id != c_phone.id:
            outcome(line, "invalid", "Email and phone belong to two different existing contacts", raw=row)
            continue
        existing = c_email or c_phone
        if existing is None and room is not None and room <= 0:
            outcome(line, "skipped", limit_reason, raw=row)
            continue
        sp = db.begin_nested()
        try:
            if existing is not None:
                if existing.created_via_import_id == imp.id:
                    sp.rollback()
                    outcome(line, "duplicate", "Duplicate of an earlier row in this file", existing.id, raw=row)
                    _remember(seen, ek, pk, line)
                    continue
                if not update_existing:
                    sp.rollback()
                    outcome(line, "duplicate", "Matches an existing contact (skipped)", existing.id, raw=row)
                    _remember(seen, ek, pk, line)
                    continue
                apply_normalized(existing, n, rule, only_provided=True, keep_existing=True)
                contact, status = existing, "updated"
                consent_svc.record_activity(db, ctx, contact.id, "imported", f"Updated by import {imp.file_name}",
                                            {"import_id": imp.id}, imp.created_by_id)
            else:
                contact = Contact(id=new_uuid(), organization_id=ctx.organization_id,
                                  application_id=ctx.application_id, attributes={}, created_via_import_id=imp.id,
                                  created_by_id=imp.created_by_id)
                apply_normalized(contact, n, rule, only_provided=False)
                contact.source = n.source or opts.get("source") or "import"
                db.add(contact)
                status = "created"
                consent_svc.record_activity(db, ctx, contact.id, "imported", f"Imported from {imp.file_name}",
                                            {"import_id": imp.id}, imp.created_by_id)
            crm.apply(contact, raw_by_line.get(line) or {}, status == "created")
            db.flush()
            for ch in channels:
                try:
                    consent_svc.grant(db, ctx, contact, ch, method="import", source=consent_opts.get("source"),
                                      evidence=consent_opts.get("evidence"),
                                      consent_reference=consent_opts.get("consent_reference"),
                                      actor_id=imp.created_by_id, import_id=imp.id)
                except ValidationFailed:
                    pass  # e.g. no phone on this row for SMS; consent simply isn't recorded
            sp.commit()
        except Exception as exc:  # one bad row must not sink the chunk
            sp.rollback()
            crm.forget_row()
            log.warning("import_row_failed", import_id=imp.id, row=line, error=type(exc).__name__)
            outcome(line, "failed", "Could not save this row", raw=row)
            continue
        if n.tags:
            from app.services.audience.collections import get_or_create_tags

            add_tags(db, ctx, [contact.id], get_or_create_tags(db, ctx, n.tags))
        _remember(seen, ek, pk, line)
        for k, store in ((contact.email_key, by_email), (contact.phone_key, by_phone)):
            if k:
                store[k] = contact
        touched.append(contact.id)
        outcome(line, status, contact_id=contact.id)
        if status == "created" and room is not None:
            room -= 1

    add_tags(db, ctx, touched, tag_ids)
    if list_id:
        add_to_lists(db, ctx, touched, [list_id])
    db.add_all(results)
    db.flush()
    _counts(db, imp)
    db.commit()
    return True


class _CrmLinker:
    """CRM fields from an import row: owner (by team member email), lifecycle stage and the company link.

    Unknown owners and stages are ignored rather than failing the row; company names link to an existing
    company (by name, or by email domain), and missing companies are created when the import asks for it."""

    def __init__(self, db: Session, ctx: TaskContext, imp: Import, opts: dict):
        from app.services.crm.common import team

        self.db, self.ctx, self.imp = db, ctx, imp
        self.create_companies = bool(opts.get("create_companies"))
        targets = set((imp.mapping or {}).values())
        self.owners: dict[str, str] = {}
        if "owner_email" in targets:
            self.owners = {(u.email or "").lower(): u.id
                           for u in team(db, ctx.organization_id, ctx.application_id).values() if u.email}
        # Every company in the application, by lower-case name and by domain: matching needs no query per row.
        from app.models import Company

        self.just_created: str | None = None
        self.by_name: dict[str, tuple[str, str]] = {}
        self.by_domain: dict[str, tuple[str, str]] = {}
        for cid, cname, dom in db.execute(select(Company.id, Company.name, Company.domain).where(
                Company.application_id == ctx.application_id)).all():
            self.by_name.setdefault(cname.strip().lower(), (cid, cname))
            if dom:
                self.by_domain.setdefault(dom, (cid, cname))

    def forget_row(self) -> None:
        """The row's savepoint was rolled back, taking any company it created with it."""
        if self.just_created:
            self.by_name.pop(self.just_created, None)
        self.just_created = None

    def apply(self, c: Contact, raw: dict, is_new: bool) -> None:
        self.just_created = None
        from app.models import Company
        from app.models.crm import LIFECYCLE_STAGES
        from app.services.crm.common import currency_for
        from app.services.crm.companies import email_domain

        owner = self.owners.get(str(raw.get("owner_email") or "").strip().lower())
        if owner and c.owner_id != owner:
            c.owner_id = owner
        stage = str(raw.get("lifecycle_stage") or "").strip().lower().replace(" ", "")
        stage = {"marketingqualifiedlead": "mql", "salesqualifiedlead": "sql"}.get(stage, stage)
        if stage in LIFECYCLE_STAGES:
            c.lifecycle_stage = stage
        if c.company_id and not raw.get("company"):
            return
        name = (c.company or "").strip()
        key = name.lower()
        hit = self.by_name.get(key) if name else None
        if hit is None and not name:
            hit = self.by_domain.get(email_domain(c.email) or "")
        if hit is None and name and self.create_companies:
            co = Company(organization_id=self.ctx.organization_id, application_id=self.ctx.application_id,
                         name=name[:200], currency=currency_for(self.ctx), attributes={},
                         owner_id=self.imp.created_by_id, created_by_id=self.imp.created_by_id)
            self.db.add(co)
            self.db.flush()
            hit = self.by_name[key] = (co.id, co.name)
            self.just_created = key
        if hit is not None:
            c.company_id = hit[0]
            c.company = c.company or hit[1]
        elif "company" in raw and not is_new and name:
            c.company_id = None  # the company text changed to something that matches no company


def _remember(seen: dict, ek, pk, line) -> None:
    for k in (ek, pk):
        if k:
            seen.setdefault(k, line)
