"""Lead forms: builder, publishing, submissions, export and analytics. Scoped to /apps/{app_id}/forms."""
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from fastapi.responses import StreamingResponse

from app.api.deps import DB, AppCtx
from app.core.errors import ValidationFailed
from app.core.permissions import Perm
from app.schemas.common import Page, PageParams
from app.schemas.forms import (
    AnalyticsOut,
    DeveloperEmail,
    FormCreate,
    FormListItem,
    FormOut,
    FormUpdate,
    SpamUpdate,
    SubmissionOut,
    TemplateOut,
    VersionOut,
)
from app.services.forms import reports, service, templates

router = APIRouter(prefix="/apps/{app_id}/forms", tags=["Lead forms"])
Paging = Annotated[PageParams, Depends()]


@router.get("", response_model=list[FormListItem])
def list_forms(ctx: AppCtx, db: DB):
    return service.list_forms(db, ctx)


@router.get("/templates", response_model=list[TemplateOut])
def list_templates(ctx: AppCtx):
    ctx.require(Perm.FORMS_READ)
    return templates.listing()


@router.get("/meta")
def builder_meta(ctx: AppCtx, db: DB):
    """Everything the builder needs in one call: fields, lists, tags, team, pipelines, senders, plan usage."""
    return service.meta(db, ctx)


@router.post("", response_model=FormOut, status_code=status.HTTP_201_CREATED)
def create_form(body: FormCreate, ctx: AppCtx, db: DB):
    f = service.create_form(db, ctx, body.name, body.template)
    db.commit()
    return service.to_out(db, f)


@router.get("/{form_id}", response_model=FormOut)
def get_form(form_id: str, ctx: AppCtx, db: DB):
    ctx.require(Perm.FORMS_READ)
    return service.to_out(db, service.get_form(db, ctx, form_id))


@router.patch("/{form_id}", response_model=FormOut)
def update_form(form_id: str, body: FormUpdate, ctx: AppCtx, db: DB):
    f = service.update_form(db, ctx, form_id, body.name, body.draft)
    db.commit()
    return service.to_out(db, f)


@router.post("/{form_id}/publish", response_model=FormOut)
def publish_form(form_id: str, ctx: AppCtx, db: DB):
    f = service.publish(db, ctx, form_id)
    db.commit()
    return service.to_out(db, f)


@router.post("/{form_id}/pause", response_model=FormOut)
def pause_form(form_id: str, ctx: AppCtx, db: DB):
    f = service.pause(db, ctx, form_id)
    db.commit()
    return service.to_out(db, f)


@router.post("/{form_id}/discard", response_model=FormOut)
def discard_changes(form_id: str, ctx: AppCtx, db: DB):
    f = service.discard(db, ctx, form_id)
    db.commit()
    return service.to_out(db, f)


@router.get("/{form_id}/versions", response_model=list[VersionOut])
def form_versions(form_id: str, ctx: AppCtx, db: DB):
    return service.versions(db, ctx, form_id)


@router.post("/{form_id}/duplicate", response_model=FormOut, status_code=status.HTTP_201_CREATED)
def duplicate_form(form_id: str, ctx: AppCtx, db: DB):
    f = service.duplicate(db, ctx, form_id)
    db.commit()
    return service.to_out(db, f)


@router.delete("/{form_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_form(form_id: str, ctx: AppCtx, db: DB):
    service.delete_form(db, ctx, form_id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{form_id}/submissions", response_model=Page[SubmissionOut])
def list_submissions(form_id: str, ctx: AppCtx, db: DB, paging: Paging,
                     search: str | None = Query(None, max_length=200), status_: str | None = Query(None, alias="status"),
                     date_from: date | None = None, date_to: date | None = None):
    return reports.list_submissions(db, ctx, form_id, paging, search, status_, date_from, date_to)


@router.get("/{form_id}/submissions/export")
def export_submissions(form_id: str, ctx: AppCtx, db: DB, search: str | None = Query(None, max_length=200),
                       status_: str | None = Query(None, alias="status"), date_from: date | None = None,
                       date_to: date | None = None):
    ctx.require(Perm.FORMS_READ)
    f = service.get_form(db, ctx, form_id)
    service._audit(db, ctx, "lead_form.submissions_exported", f, f"Exported submissions of {f.name}")
    db.commit()
    return StreamingResponse(reports.export_csv(ctx, form_id, search, status_, date_from, date_to),
                             media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="form-{f.public_id}-submissions.csv"'})


@router.post("/{form_id}/submissions/{submission_id}/spam", response_model=SubmissionOut)
def mark_spam(form_id: str, submission_id: str, body: SpamUpdate, ctx: AppCtx, db: DB):
    out = reports.set_spam(db, ctx, form_id, submission_id, body.spam)
    db.commit()
    return out


@router.delete("/{form_id}/submissions/{submission_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_submission(form_id: str, submission_id: str, ctx: AppCtx, db: DB):
    reports.delete_submission(db, ctx, form_id, submission_id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{form_id}/analytics", response_model=AnalyticsOut)
def form_analytics(form_id: str, ctx: AppCtx, db: DB, days: int = Query(30, ge=1, le=365)):
    return reports.analytics(db, ctx, form_id, days)


@router.post("/{form_id}/send-to-developer")
def send_to_developer(form_id: str, body: DeveloperEmail, ctx: AppCtx, db: DB):
    """Email the embed instructions to whoever maintains the website."""
    from app.services.notifications import enqueue_system_email
    from app.utils.contact_normalize import InvalidValue, normalize_email

    ctx.require(Perm.FORMS_WRITE)
    f = service.get_form(db, ctx, form_id)
    try:
        to = normalize_email(body.email)
    except InvalidValue as exc:
        raise ValidationFailed("Enter a valid email address", code="INVALID_EMAIL") from exc
    service._audit(db, ctx, "lead_form.sent_to_developer", f, f"Sent embed code of {f.name} to a developer")
    db.commit()
    enqueue_system_email("form_embed_code", to, None,
                         service.developer_email(f, ctx.user.full_name or ctx.user.email, body.note))
    return {"sent": True}
