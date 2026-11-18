from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import NotFound
from app.core.permissions import Perm
from app.models.email import EmailTemplate
from app.schemas.email import TemplateBody, TemplateUpdate
from app.services import audit_service
from app.services.tenancy import AppContext


def _get(db: Session, ctx: AppContext, template_id: str) -> EmailTemplate:
    t = db.scalar(select(EmailTemplate).where(EmailTemplate.id == template_id,
                                              EmailTemplate.application_id == ctx.application_id))
    if t is None:
        raise NotFound("Template not found")
    return t


def list_templates(db: Session, ctx: AppContext) -> list[EmailTemplate]:
    ctx.require(Perm.CAMPAIGNS_READ)
    return list(db.scalars(select(EmailTemplate).where(EmailTemplate.application_id == ctx.application_id)
                           .order_by(EmailTemplate.updated_at.desc())))


def get_template(db: Session, ctx: AppContext, template_id: str) -> EmailTemplate:
    ctx.require(Perm.CAMPAIGNS_READ)
    return _get(db, ctx, template_id)


def create_template(db: Session, ctx: AppContext, data: TemplateBody) -> EmailTemplate:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    t = EmailTemplate(organization_id=ctx.organization_id, application_id=ctx.application_id,
                      created_by_id=ctx.user.id, **data.model_dump())
    db.add(t)
    db.flush()
    audit_service.record(db, "email_template.created", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="email_template", target_id=t.id, summary=t.name)
    return t


def update_template(db: Session, ctx: AppContext, template_id: str, data: TemplateUpdate) -> EmailTemplate:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    t = _get(db, ctx, template_id)
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(t, k, v)
    return t


def duplicate_template(db: Session, ctx: AppContext, template_id: str) -> EmailTemplate:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    t = _get(db, ctx, template_id)
    copy = EmailTemplate(organization_id=ctx.organization_id, application_id=ctx.application_id,
                         created_by_id=ctx.user.id, name=f"{t.name} (copy)"[:120], subject=t.subject,
                         preheader=t.preheader, editor=t.editor, design=t.design, html=t.html, text=t.text)
    db.add(copy)
    db.flush()
    return copy


def delete_template(db: Session, ctx: AppContext, template_id: str) -> None:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    t = _get(db, ctx, template_id)
    db.delete(t)
    audit_service.record(db, "email_template.deleted", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="email_template", target_id=template_id, summary=t.name)
