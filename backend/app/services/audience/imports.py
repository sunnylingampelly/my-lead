"""Contact import wizard: upload, map, validate, configure, start, monitor, report."""
import csv
import io
from collections import Counter
from collections.abc import Iterator

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.permissions import Perm
from app.integrations.storage import build_key, get_storage
from app.models import Contact, ContactList, Import, ImportRow
from app.schemas.audience import ImportOptions, ImportOut, ImportValidation, ListCreate
from app.schemas.common import Page, PageParams
from app.services import audit_service
from app.services.audience import import_files
from app.services.audience.collections import create_list, get_or_create_tags
from app.services.audience.contacts import attr_defs, identity_rule
from app.services.audience.normalize import CORE_TEXT_FIELDS, check_identity, identity_keys, normalize_contact
from app.services.tenancy import AppContext
from app.utils.contact_normalize import InvalidValue

CORE_TARGETS = set(CORE_TEXT_FIELDS) | {"full_name", "email", "phone", "country", "timezone", "tags"}
ACTIVE = ("queued", "processing")


def to_out(imp: Import, suggested: dict | None = None) -> ImportOut:
    out = ImportOut.model_validate(imp)
    out.progress = round(100 * imp.processed_rows / imp.total_rows, 1) if imp.total_rows else 0
    if suggested:
        out.suggested_mapping = suggested
    return out


def _get(db: Session, ctx: AppContext, import_id: str) -> Import:
    imp = db.scalar(select(Import).where(Import.id == import_id, Import.application_id == ctx.application_id))
    if imp is None:
        raise NotFound("Import not found")
    return imp


def _suggest(db: Session, ctx: AppContext, columns: list[str]) -> dict[str, str]:
    defs = attr_defs(db, ctx)
    keys = {d.key: d.key for d in defs.values()} | {d.label.strip().lower(): d.key for d in defs.values()}
    return import_files.suggest_mapping(columns, keys)


def upload(db: Session, ctx: AppContext, filename: str, data: bytes) -> ImportOut:
    ctx.require(Perm.AUDIENCE_WRITE)
    if not data:
        raise ValidationFailed("The file is empty", code="EMPTY_FILE")
    if len(data) > import_files.MAX_FILE_BYTES:
        raise ValidationFailed("Files can be at most 20 MB", code="FILE_TOO_LARGE")
    ftype = import_files.detect_type(filename, data[:8])
    columns, preview, total = import_files.inspect(data, ftype)
    key = build_key(ctx.organization_id, ctx.application_id, "imports", ftype)
    get_storage().put(key, data, "text/csv" if ftype == "csv" else
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    safe_name = "".join(ch for ch in filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1] if ch.isprintable())[:255]
    imp = Import(organization_id=ctx.organization_id, application_id=ctx.application_id, created_by_id=ctx.user.id,
                 file_name=safe_name or f"upload.{ftype}", file_key=key, file_type=ftype, file_size=len(data),
                 columns=columns, preview=preview, total_rows=total, status="uploaded")
    db.add(imp)
    db.flush()
    audit_service.record(db, "import.uploaded", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="import", target_id=imp.id,
                         summary=f"{imp.file_name} ({total} rows)")
    return to_out(imp, _suggest(db, ctx, columns))


def get_import(db: Session, ctx: AppContext, import_id: str) -> ImportOut:
    ctx.require(Perm.AUDIENCE_READ)
    imp = _get(db, ctx, import_id)
    return to_out(imp, _suggest(db, ctx, imp.columns) if imp.status == "uploaded" else None)


def list_imports(db: Session, ctx: AppContext, params: PageParams) -> Page[ImportOut]:
    ctx.require(Perm.AUDIENCE_READ)
    q = select(Import).where(Import.application_id == ctx.application_id)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(q.order_by(Import.created_at.desc()).offset(params.offset).limit(params.page_size))
    return Page(items=[to_out(i) for i in rows], total=total, page=params.page, page_size=params.page_size)


def check_mapping(db: Session, ctx: AppContext, imp: Import, mapping: dict[str, str]) -> dict[str, str]:
    unknown_cols = [c for c in mapping if c not in imp.columns]
    if unknown_cols:
        raise ValidationFailed("Mapping refers to columns that are not in the file", code="INVALID_MAPPING",
                               details={"columns": unknown_cols})
    defs = attr_defs(db, ctx)
    clean, used = {}, Counter()
    for col, target in mapping.items():
        target = (target or "").strip()
        if not target:
            continue
        if target.startswith("attr:"):
            if target[5:] not in defs:
                raise ValidationFailed(f"Unknown custom field '{target[5:]}'", code="INVALID_MAPPING")
        elif target not in CORE_TARGETS:
            raise ValidationFailed(f"Unknown field '{target}'", code="INVALID_MAPPING")
        used[target] += 1
        clean[col] = target
    dupes = [t for t, n in used.items() if n > 1]
    if dupes:
        raise ValidationFailed("Each field can be mapped from only one column", code="INVALID_MAPPING",
                               details={"fields": dupes})
    rule = identity_rule(db, ctx)
    targets = set(clean.values())
    if rule == "email" and "email" not in targets:
        raise ValidationFailed("Map a column to Email; this application identifies contacts by email",
                               code="IDENTIFIER_NOT_MAPPED")
    if rule == "phone" and "phone" not in targets:
        raise ValidationFailed("Map a column to Phone; this application identifies contacts by phone",
                               code="IDENTIFIER_NOT_MAPPED")
    if rule == "email_or_phone" and not targets & {"email", "phone"}:
        raise ValidationFailed("Map at least one column to Email or Phone", code="IDENTIFIER_NOT_MAPPED")
    return clean


def row_to_raw(row: dict[str, str], mapping: dict[str, str]) -> dict:
    return {target: row.get(col, "") for col, target in mapping.items()}


def validate(db: Session, ctx: AppContext, import_id: str, mapping: dict[str, str]) -> ImportValidation:
    """Dry run over the whole file: nothing is written except the saved mapping."""
    ctx.require(Perm.AUDIENCE_WRITE)
    imp = _get(db, ctx, import_id)
    if imp.status != "uploaded":
        raise Conflict("This import has already started", code="IMPORT_STARTED")
    mapping = check_mapping(db, ctx, imp, mapping)
    imp.mapping = mapping
    defs, rule = attr_defs(db, ctx), identity_rule(db, ctx)
    data = get_storage().get(imp.file_key)
    _, rows = import_files.iter_rows(data, imp.file_type)
    seen: set[str] = set()
    errors, countries = [], Counter()
    total = valid = invalid = empty = dup = 0
    email_keys, phone_keys = [], []
    for line, row in rows:
        if not any(row.values()):
            continue
        total += 1
        raw = row_to_raw(row, mapping)
        try:
            n = normalize_contact(raw, default_country=ctx.application.default_country, attr_defs=defs)
            if n.is_empty():
                empty += 1
                continue
            phone = n.phone.e164 if n.phone else None
            check_identity(rule, n.email, phone)
        except InvalidValue as exc:
            invalid += 1
            if len(errors) < 50:
                errors.append({"row": line, "reason": str(exc)})
            continue
        ek, pk = identity_keys(rule, n.email, phone)
        if (ek and ek in seen) or (pk and pk in seen):
            dup += 1
            continue
        seen.update(k for k in (ek, pk) if k)
        valid += 1
        countries[(n.phone.country if n.phone else None) or n.country or "Unknown"] += 1
        if ek:
            email_keys.append(ek)
        if pk:
            phone_keys.append(pk)
    existing = _count_existing(db, ctx, email_keys, phone_keys)
    return ImportValidation(total_rows=total, valid_rows=valid, new_contacts=max(valid - existing, 0),
                            existing_matches=existing, duplicates_in_file=dup, invalid_rows=invalid, empty_rows=empty,
                            errors=errors, countries=dict(countries.most_common(10)),
                            us_numbers=countries.get("US", 0), india_numbers=countries.get("IN", 0))


def _count_existing(db: Session, ctx: AppContext, email_keys: list[str], phone_keys: list[str]) -> int:
    ids: set[str] = set()
    for col, keys in ((Contact.email_key, email_keys), (Contact.phone_key, phone_keys)):
        for i in range(0, len(keys), 500):
            ids.update(db.scalars(select(Contact.id).where(Contact.application_id == ctx.application_id,
                                                           col.in_(keys[i:i + 500]))))
    return len(ids)


def start(db: Session, ctx: AppContext, import_id: str, mapping: dict[str, str], options: ImportOptions) -> ImportOut:
    ctx.require(Perm.AUDIENCE_WRITE)
    imp = _get(db, ctx, import_id)
    if imp.status != "uploaded":
        raise Conflict("This import has already started", code="IMPORT_STARTED")
    mapping = check_mapping(db, ctx, imp, mapping)
    c = options.consent
    channels = [ch for ch in ("email", "sms", "voice") if getattr(c, ch)]
    if channels:
        if not c.confirmed:
            raise ValidationFailed("Confirm that every contact in this file gave the selected consent",
                                   code="CONSENT_NOT_CONFIRMED")
        if not (c.source or "").strip():
            raise ValidationFailed("Describe where this consent was collected", code="CONSENT_SOURCE_REQUIRED")
        if ({"sms", "voice"} & set(channels)) and not (c.evidence or "").strip():
            raise ValidationFailed("Marketing SMS and calls need documented consent (required by TCPA for US numbers "
                                   "and expected under India's DLT rules). Describe the evidence you hold.",
                                   code="WRITTEN_CONSENT_REQUIRED")
    list_id = options.list_id
    if list_id:
        if not db.scalar(select(ContactList.id).where(ContactList.id == list_id,
                                                      ContactList.application_id == ctx.application_id)):
            raise ValidationFailed("Choose an existing list", code="INVALID_REFERENCE")
    elif options.new_list_name and options.new_list_name.strip():
        list_id = create_list(db, ctx, ListCreate(name=options.new_list_name.strip())).id
    tag_ids = get_or_create_tags(db, ctx, options.tag_names)
    imp.mapping = mapping
    imp.options = {**options.model_dump(mode="json"), "list_id": list_id, "tag_ids": tag_ids,
                   "identity_rule": identity_rule(db, ctx)}
    imp.status = "queued"
    audit_service.record(db, "import.started", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="import", target_id=imp.id,
                         summary=imp.file_name, meta={"consent_channels": channels,
                                                      "duplicate_handling": options.duplicate_handling})
    db.commit()
    from app.tasks.imports import process_import
    from app.workers.dispatch import dispatch

    dispatch(process_import, imp.id)
    db.refresh(imp)
    return to_out(imp)


def cancel(db: Session, ctx: AppContext, import_id: str) -> ImportOut:
    ctx.require(Perm.AUDIENCE_WRITE)
    imp = _get(db, ctx, import_id)
    if imp.status not in ("uploaded", *ACTIVE):
        raise Conflict("Only pending or running imports can be cancelled")
    imp.status = "cancelled"
    audit_service.record(db, "import.cancelled", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="import", target_id=imp.id)
    return to_out(imp)


def report_csv(db: Session, ctx: AppContext, import_id: str) -> Iterator[str]:
    """Rows that were not imported, with the reason, in their original column layout."""
    ctx.require(Perm.AUDIENCE_WRITE)
    imp = _get(db, ctx, import_id)
    rows = db.scalars(select(ImportRow).where(ImportRow.import_id == imp.id,
                                              ImportRow.status.not_in(("created", "updated")))
                      .order_by(ImportRow.row_number)).all()

    def gen():
        from app.services.audience.contacts import _safe_cell

        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["row_number", "outcome", "reason", *imp.columns])
        yield "﻿" + buf.getvalue()
        for r in rows:
            buf = io.StringIO()
            csv.writer(buf).writerow([r.row_number, r.status, r.reason or "",
                                      *[_safe_cell((r.raw or {}).get(c, "")) for c in imp.columns]])
            yield buf.getvalue()

    return gen()
