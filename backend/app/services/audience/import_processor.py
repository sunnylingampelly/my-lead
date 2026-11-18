"""Background processing of a contact import.

Restart safety: every source row produces exactly one import_rows record, unique on
(import_id, row_number). A retried or resumed job skips rows already recorded, and contacts are
matched by their identity keys, so a retry never creates duplicate contacts.
"""
import time
from dataclasses import dataclass

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
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
from app.services.notification_service import notify
from app.utils.contact_normalize import InvalidValue
from app.utils.time import utcnow

log = get_logger(__name__)
CHUNK = 500
# SQLite (development only) has a single database-wide write lock. Smaller chunks plus a short
# pause between them keep the API responsive while an import runs.
SQLITE_CHUNK = 200
SQLITE_PAUSE_SECONDS = 0.05


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
        if len(chunk) >= (SQLITE_CHUNK if settings.is_sqlite else CHUNK):
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

    for line, row in chunk:
        raw = row_to_raw(row, imp.mapping)
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

    consent_opts = opts.get("consent") or {}
    channels = [ch for ch in ("email", "sms", "voice") if consent_opts.get(ch)] if consent_opts.get("confirmed") else []
    tag_ids, list_id = opts.get("tag_ids") or [], opts.get("list_id")
    update_existing = opts.get("duplicate_handling") == "update"
    touched: list[str] = []

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

    add_tags(db, ctx, touched, tag_ids)
    if list_id:
        add_to_lists(db, ctx, touched, [list_id])
    db.add_all(results)
    db.flush()
    _counts(db, imp)
    db.commit()
    if settings.is_sqlite and settings.ENVIRONMENT != "test":
        time.sleep(SQLITE_PAUSE_SECONDS)
    return True


def _remember(seen: dict, ek, pk, line) -> None:
    for k in (ek, pk):
        if k:
            seen.setdefault(k, line)
