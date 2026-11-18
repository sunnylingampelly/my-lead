"""Audience endpoints. Every route is scoped to /apps/{app_id} and resolves an AppContext."""
from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, Request, UploadFile, status
from fastapi.responses import StreamingResponse

from app.api.deps import DB, AppCtx, ip_of
from app.core.errors import ValidationFailed
from app.core.permissions import Perm
from app.schemas.audience import (
    ActivityOut,
    AttributeCreate,
    AttributeOut,
    AttributeUpdate,
    BulkAction,
    ConsentChange,
    ConsentRecordOut,
    ContactCreate,
    ContactDetail,
    ContactFilters,
    ContactIds,
    ContactListItem,
    ContactUpdate,
    ImportMappingRequest,
    ImportOut,
    ImportStartRequest,
    ImportValidation,
    ListCreate,
    ListOut,
    ListUpdate,
    SegmentCreate,
    SegmentOut,
    SegmentPreview,
    SegmentPreviewRequest,
    SegmentUpdate,
    SuppressionCreate,
    SuppressionOut,
    TagCreate,
    TagOut,
    TagUpdate,
    TagWithCount,
)
from app.schemas.common import Page, PageParams
from app.services import audit_service
from app.services.audience import collections, contacts, imports, overview, segments
from app.services.audience.import_files import MAX_FILE_BYTES

router = APIRouter(prefix="/apps/{app_id}", tags=["Audience"])
Paging = Annotated[PageParams, Depends()]
Filters = Annotated[ContactFilters, Depends()]


# ------------------------------------------------------------------ overview & field catalog

@router.get("/audience/overview")
def audience_overview(ctx: AppCtx, db: DB):
    return overview.overview(db, ctx)


@router.get("/audience/fields")
def audience_fields(ctx: AppCtx, db: DB):
    """Fields, operators, tags and lists available to the segment builder."""
    return segments.field_catalog(db, ctx)


# ------------------------------------------------------------------ contacts

@router.get("/contacts", response_model=Page[ContactListItem])
def list_contacts(ctx: AppCtx, db: DB, paging: Paging, filters: Filters,
                  sort: str | None = Query(None, max_length=30)):
    return contacts.list_contacts(db, ctx, filters, paging, sort)


@router.post("/contacts", response_model=ContactDetail, status_code=status.HTTP_201_CREATED)
def create_contact(body: ContactCreate, request: Request, ctx: AppCtx, db: DB):
    c = contacts.create_contact(db, ctx, body, ip=ip_of(request))
    db.commit()
    return contacts.detail(db, ctx, c.id)


@router.get("/contacts/export")
def export_contacts(ctx: AppCtx, db: DB, filters: Filters, ids: str | None = Query(None, max_length=200_000)):
    """Stream matching contacts as CSV. Exports are audited."""
    ctx.require(Perm.AUDIENCE_EXPORT)
    id_list = [i for i in (ids or "").split(",") if i][:50_000] or None
    audit_service.record(db, "contacts.exported", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, summary="Exported contacts",
                         meta={"filters": filters.model_dump(exclude_none=True), "ids": len(id_list or [])})
    db.commit()
    return StreamingResponse(contacts.export_csv(ctx, filters, id_list), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": 'attachment; filename="contacts.csv"'})


@router.post("/contacts/bulk")
def bulk_contacts(body: BulkAction, ctx: AppCtx, db: DB):
    result = contacts.bulk(db, ctx, body)
    db.commit()
    return result


@router.get("/contacts/{contact_id}", response_model=ContactDetail)
def get_contact(contact_id: str, ctx: AppCtx, db: DB):
    return contacts.detail(db, ctx, contact_id)


@router.patch("/contacts/{contact_id}", response_model=ContactDetail)
def update_contact(contact_id: str, body: ContactUpdate, ctx: AppCtx, db: DB):
    contacts.update_contact(db, ctx, contact_id, body)
    db.commit()
    return contacts.detail(db, ctx, contact_id)


@router.delete("/contacts/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_contact(contact_id: str, ctx: AppCtx, db: DB):
    contacts.get_contact(db, ctx, contact_id)
    contacts.delete_contacts(db, ctx, [contact_id])
    db.commit()


@router.post("/contacts/{contact_id}/consent", response_model=ContactDetail)
def change_consent(contact_id: str, body: ConsentChange, request: Request, ctx: AppCtx, db: DB):
    contacts.change_consent(db, ctx, contact_id, body, ip_of(request))
    db.commit()
    return contacts.detail(db, ctx, contact_id)


@router.get("/contacts/{contact_id}/consents", response_model=list[ConsentRecordOut])
def consent_history(contact_id: str, ctx: AppCtx, db: DB):
    return contacts.consent_history(db, ctx, contact_id)


@router.get("/contacts/{contact_id}/activity", response_model=Page[ActivityOut])
def contact_activity(contact_id: str, ctx: AppCtx, db: DB, paging: Paging):
    return contacts.activity(db, ctx, contact_id, paging)


@router.post("/contacts/{contact_id}/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
def tag_contact(contact_id: str, tag_id: str, ctx: AppCtx, db: DB):
    contacts.bulk(db, ctx, BulkAction(action="add_tag", contact_ids=[contact_id], tag_id=tag_id))
    db.commit()


@router.delete("/contacts/{contact_id}/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
def untag_contact(contact_id: str, tag_id: str, ctx: AppCtx, db: DB):
    contacts.bulk(db, ctx, BulkAction(action="remove_tag", contact_ids=[contact_id], tag_id=tag_id))
    db.commit()


# ------------------------------------------------------------------ custom attributes

@router.get("/audience/attributes", response_model=list[AttributeOut])
def list_attributes(ctx: AppCtx, db: DB):
    return collections.list_attributes(db, ctx)


@router.post("/audience/attributes", response_model=AttributeOut, status_code=status.HTTP_201_CREATED)
def create_attribute(body: AttributeCreate, ctx: AppCtx, db: DB):
    d = collections.create_attribute(db, ctx, body)
    db.commit()
    return d


@router.patch("/audience/attributes/{attr_id}", response_model=AttributeOut)
def update_attribute(attr_id: str, body: AttributeUpdate, ctx: AppCtx, db: DB):
    d = collections.update_attribute(db, ctx, attr_id, body)
    db.commit()
    return d


@router.delete("/audience/attributes/{attr_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_attribute(attr_id: str, ctx: AppCtx, db: DB):
    collections.delete_attribute(db, ctx, attr_id)
    db.commit()


# ------------------------------------------------------------------ tags

@router.get("/tags", response_model=list[TagWithCount])
def list_tags(ctx: AppCtx, db: DB):
    return collections.list_tags(db, ctx)


@router.post("/tags", response_model=TagOut, status_code=status.HTTP_201_CREATED)
def create_tag(body: TagCreate, ctx: AppCtx, db: DB):
    t = collections.create_tag(db, ctx, body)
    db.commit()
    return t


@router.patch("/tags/{tag_id}", response_model=TagOut)
def update_tag(tag_id: str, body: TagUpdate, ctx: AppCtx, db: DB):
    t = collections.update_tag(db, ctx, tag_id, body)
    db.commit()
    return t


@router.delete("/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tag(tag_id: str, ctx: AppCtx, db: DB):
    collections.delete_tag(db, ctx, tag_id)
    db.commit()


# ------------------------------------------------------------------ lists

@router.get("/lists", response_model=list[ListOut])
def list_lists(ctx: AppCtx, db: DB):
    return collections.list_lists(db, ctx)


@router.post("/lists", response_model=ListOut, status_code=status.HTTP_201_CREATED)
def create_list(body: ListCreate, ctx: AppCtx, db: DB):
    out = collections.create_list(db, ctx, body)
    db.commit()
    return out


@router.get("/lists/{list_id}", response_model=ListOut)
def get_list(list_id: str, ctx: AppCtx, db: DB):
    return collections.get_list(db, ctx, list_id)


@router.patch("/lists/{list_id}", response_model=ListOut)
def update_list(list_id: str, body: ListUpdate, ctx: AppCtx, db: DB):
    out = collections.update_list(db, ctx, list_id, body)
    db.commit()
    return out


@router.delete("/lists/{list_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_list(list_id: str, ctx: AppCtx, db: DB):
    collections.delete_list(db, ctx, list_id)
    db.commit()


@router.post("/lists/{list_id}/contacts")
def add_list_members(list_id: str, body: ContactIds, ctx: AppCtx, db: DB):
    n = collections.add_list_members(db, ctx, list_id, body.contact_ids)
    db.commit()
    return {"added": n}


@router.delete("/lists/{list_id}/contacts")
def remove_list_members(list_id: str, body: ContactIds, ctx: AppCtx, db: DB):
    n = collections.remove_list_members(db, ctx, list_id, body.contact_ids)
    db.commit()
    return {"removed": n}


# ------------------------------------------------------------------ segments

@router.get("/segments", response_model=list[SegmentOut])
def list_segments(ctx: AppCtx, db: DB):
    out = segments.list_segments(db, ctx)
    db.commit()
    return out


@router.post("/segments/preview", response_model=SegmentPreview)
def preview_segment(body: SegmentPreviewRequest, ctx: AppCtx, db: DB):
    return segments.preview(db, ctx, body.rules)


@router.post("/segments", response_model=SegmentOut, status_code=status.HTTP_201_CREATED)
def create_segment(body: SegmentCreate, ctx: AppCtx, db: DB):
    s = segments.create_segment(db, ctx, body)
    db.commit()
    return s


@router.get("/segments/{segment_id}", response_model=SegmentOut)
def get_segment(segment_id: str, ctx: AppCtx, db: DB):
    s = segments.get_segment(db, ctx, segment_id)
    db.commit()
    return s


@router.patch("/segments/{segment_id}", response_model=SegmentOut)
def update_segment(segment_id: str, body: SegmentUpdate, ctx: AppCtx, db: DB):
    s = segments.update_segment(db, ctx, segment_id, body)
    db.commit()
    return s


@router.delete("/segments/{segment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_segment(segment_id: str, ctx: AppCtx, db: DB):
    segments.delete_segment(db, ctx, segment_id)
    db.commit()


# ------------------------------------------------------------------ suppression

@router.get("/suppressions", response_model=Page[SuppressionOut])
def list_suppressions(ctx: AppCtx, db: DB, paging: Paging,
                      channel: str | None = Query(None, pattern="^(email|sms|voice)$"),
                      search: str | None = Query(None, max_length=320)):
    return collections.list_suppressions(db, ctx, paging, channel, search)


@router.post("/suppressions", response_model=SuppressionOut, status_code=status.HTTP_201_CREATED)
def add_suppression(body: SuppressionCreate, ctx: AppCtx, db: DB):
    e = collections.add_suppression(db, ctx, body)
    db.commit()
    return e


@router.delete("/suppressions/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_suppression(entry_id: str, ctx: AppCtx, db: DB):
    collections.remove_suppression(db, ctx, entry_id)
    db.commit()


# ------------------------------------------------------------------ imports

@router.get("/imports", response_model=Page[ImportOut])
def list_imports(ctx: AppCtx, db: DB, paging: Paging):
    return imports.list_imports(db, ctx, paging)


@router.post("/contacts/import", response_model=ImportOut, status_code=status.HTTP_201_CREATED)
async def upload_import(ctx: AppCtx, db: DB, file: UploadFile = File(...)):
    """Step 1: upload a CSV or XLSX file (max 20 MB, 100,000 rows)."""
    data = await file.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise ValidationFailed("Files can be at most 20 MB", code="FILE_TOO_LARGE")
    out = imports.upload(db, ctx, file.filename or "upload.csv", data)
    db.commit()
    return out


@router.get("/imports/{import_id}", response_model=ImportOut)
def get_import(import_id: str, ctx: AppCtx, db: DB):
    return imports.get_import(db, ctx, import_id)


@router.post("/imports/{import_id}/validate", response_model=ImportValidation)
def validate_import(import_id: str, body: ImportMappingRequest, ctx: AppCtx, db: DB):
    """Step 3: dry-run validation of the whole file with the given column mapping."""
    out = imports.validate(db, ctx, import_id, body.mapping)
    db.commit()
    return out


@router.post("/imports/{import_id}/start", response_model=ImportOut)
def start_import(import_id: str, body: ImportStartRequest, ctx: AppCtx, db: DB):
    """Step 5: queue background processing."""
    return imports.start(db, ctx, import_id, body.mapping, body.options)


@router.post("/imports/{import_id}/cancel", response_model=ImportOut)
def cancel_import(import_id: str, ctx: AppCtx, db: DB):
    out = imports.cancel(db, ctx, import_id)
    db.commit()
    return out


@router.get("/imports/{import_id}/report")
def import_report(import_id: str, ctx: AppCtx, db: DB):
    """Step 6: CSV of rows that were skipped, duplicated, invalid or failed, with reasons."""
    gen = imports.report_csv(db, ctx, import_id)
    return StreamingResponse(gen, media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition":
                                      f'attachment; filename="import-{import_id[:8]}-report.csv"'})
