"""Lead form management: CRUD, draft/publish/versions, plan limits, submissions, CSV export and analytics."""
import secrets
from datetime import timedelta
from functools import lru_cache

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import NotFound, ValidationFailed
from app.core.permissions import ORG_WIDE_ROLES, Perm, Role, permissions_for
from app.models import (
    ApplicationMember,
    ContactAttributeDefinition,
    ContactList,
    OrganizationMember,
    Pipeline,
    PipelineStage,
    Tag,
    User,
)
from app.models.email import EmailSender
from app.models.forms import LeadForm, LeadFormDailyStat, LeadFormVersion
from app.schemas.forms import (
    FONTS,
    STANDARD_FIELDS,
    EmbedInfo,
    FormDefinition,
    FormListItem,
    FormOut,
    VersionOut,
)
from app.services import audit_service
from app.services.billing import plans
from app.services.forms import templates
from app.services.forms.security import sanitize_html, turnstile_available
from app.services.tenancy import effective_app_role
from app.utils.time import utcnow

STANDARD_LABELS = {"first_name": "First name", "last_name": "Last name", "email": "Email", "phone": "Phone",
                   "company": "Company", "city": "City", "state": "State / region", "country": "Country",
                   "postal_code": "Postal code"}


# ------------------------------------------------------------------ helpers

def _count_forms(db: Session, organization_id: str) -> int:
    return db.scalar(select(func.count(LeadForm.id)).where(LeadForm.organization_id == organization_id)) or 0


plans.register_usage_counter("lead_forms", _count_forms)


def backend_url() -> str:
    return settings.BACKEND_PUBLIC_URL.rstrip("/")


def embed_info(public_id: str) -> EmbedInfo:
    b = backend_url()
    script = f"{b}/embed/forms.js"
    tag = f'<script src="{script}" async></script>'

    def popup(mode: str) -> str:
        return f'<script src="{script}" data-signalcraft-popup="{public_id}" data-mode="{mode}" async></script>'

    return EmbedInfo(
        script_url=script, iframe_url=f"{b}/embed/form/{public_id}", hosted_url=f"{b}/embed/f/{public_id}",
        inline=f'{tag}\n<div data-signalcraft-inline="{public_id}"></div>',
        popup=popup("popup"), slide_in=popup("slide_in"), floating=popup("floating"),
        button=f'<button type="button" data-signalcraft-form="{public_id}">Contact us</button>\n{tag}')


def clean_definition(raw) -> dict:
    """Validate (schema bounds) and sanitise rich text. The stored draft is always this output."""
    d = (raw if isinstance(raw, FormDefinition) else FormDefinition.model_validate(raw)).model_dump()
    d["success"]["message_html"] = sanitize_html(d["success"]["message_html"])
    return d


def branding(db: Session, organization_id: str) -> bool:
    return bool(plans.current_plan(db, organization_id).get("form_branding"))


def changed(f: LeadForm) -> bool:
    return f.published is None or f.draft != f.published


def get_form(db: Session, ctx, form_id: str) -> LeadForm:
    f = db.get(LeadForm, form_id) if form_id else None
    if f is None or f.application_id != ctx.application_id:
        raise NotFound("Form not found")
    return f


def to_out(db: Session, f: LeadForm) -> FormOut:
    return FormOut(id=f.id, public_id=f.public_id, name=f.name, status=f.status, template=f.template,
                   draft=FormDefinition.model_validate(f.draft), published_version=f.published_version,
                   published_at=f.published_at, has_unpublished_changes=changed(f),
                   branding=branding(db, f.organization_id), embed=embed_info(f.public_id),
                   created_at=f.created_at, updated_at=f.updated_at)


def _audit(db: Session, ctx, action: str, f: LeadForm, summary: str, meta: dict | None = None) -> None:
    audit_service.record(db, action, actor_user_id=ctx.user.id if ctx.user else None,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="lead_form", target_id=f.id, summary=summary[:255], meta=meta or {})


def _new_public_id(db: Session) -> str:
    while True:
        pid = secrets.token_urlsafe(9).replace("-", "x").replace("_", "z")
        if db.scalar(select(LeadForm.id).where(LeadForm.public_id == pid)) is None:
            return pid


# ------------------------------------------------------------------ list / create / update

def list_forms(db: Session, ctx) -> list[FormListItem]:
    ctx.require(Perm.FORMS_READ)
    forms = list(db.scalars(select(LeadForm).where(LeadForm.application_id == ctx.application_id)
                            .order_by(LeadForm.updated_at.desc())))
    since = utcnow().date() - timedelta(days=29)
    stats = {fid: (v or 0, s or 0) for fid, v, s in db.execute(
        select(LeadFormDailyStat.form_id, func.sum(LeadFormDailyStat.views), func.sum(LeadFormDailyStat.submissions))
        .where(LeadFormDailyStat.application_id == ctx.application_id, LeadFormDailyStat.day >= since)
        .group_by(LeadFormDailyStat.form_id))}
    out = []
    for f in forms:
        views, subs = stats.get(f.id, (0, 0))
        out.append(FormListItem(
            id=f.id, public_id=f.public_id, name=f.name, status=f.status, template=f.template,
            published_version=f.published_version, has_unpublished_changes=changed(f), views_30d=int(views),
            submissions_30d=int(subs), conversion_30d=_pct(subs, views), last_submission_at=f.last_submission_at,
            created_at=f.created_at, updated_at=f.updated_at))
    return out


def _pct(n, d) -> float:
    return round(100 * float(n) / float(d), 1) if d else 0.0


def _check_limit(db: Session, ctx) -> None:
    plans.check_limit(db, ctx.organization_id, "lead_forms", plans.count_usage(db, ctx.organization_id, "lead_forms"))


def create_form(db: Session, ctx, name: str, template: str | None) -> LeadForm:
    ctx.require(Perm.FORMS_WRITE)
    _check_limit(db, ctx)
    if template and template not in templates.TEMPLATES:
        raise ValidationFailed("Unknown template", code="INVALID_TEMPLATE")
    d = clean_definition(templates.definition(template))
    d["settings"]["source"] = d["settings"]["source"] or name.strip()[:60]
    f = LeadForm(organization_id=ctx.organization_id, application_id=ctx.application_id, public_id=_new_public_id(db),
                 name=name.strip(), template=template, status="draft", draft=d, created_by_id=ctx.user.id)
    db.add(f)
    db.flush()
    _audit(db, ctx, "lead_form.created", f, f"Created lead form {f.name}", {"template": template})
    return f


def update_form(db: Session, ctx, form_id: str, name: str | None, draft) -> LeadForm:
    ctx.require(Perm.FORMS_WRITE)
    f = get_form(db, ctx, form_id)
    if name is not None:
        f.name = name.strip()
    if draft is not None:
        f.draft = clean_definition(draft)
    f.updated_at = utcnow()
    return f


def check_references(db: Session, ctx, d: dict) -> None:
    """Everything the definition points at must exist in this application (checked on publish)."""
    s, app_id = d["settings"], ctx.application_id

    def owned(model, ids, what):
        ids = [i for i in ids if i]
        if ids and len(set(db.scalars(select(model.id).where(model.id.in_(ids), model.application_id == app_id)))) \
                != len(set(ids)):
            raise ValidationFailed(f"One of the chosen {what} no longer exists. Check the form settings.",
                                   code="INVALID_REFERENCE")

    owned(ContactList, s["list_ids"], "lists")
    owned(Tag, s["tag_ids"], "tags")
    keys = set(db.scalars(select(ContactAttributeDefinition.key).where(
        ContactAttributeDefinition.application_id == app_id)))
    fields = d["fields"]
    if not any(f["type"] != "hidden" for f in fields):
        raise ValidationFailed("Add at least one field the visitor can fill in", code="NO_FIELDS")
    if not any(f["type"] == "email" or (f["type"] == "phone") or f["map_to"]["key"] in ("email", "phone")
               for f in fields):
        raise ValidationFailed("Add an email or phone field so submissions can become contacts",
                               code="IDENTIFIER_FIELD_REQUIRED")
    for f in fields:
        m = f["map_to"]
        if m["kind"] == "custom" and m["key"] not in keys:
            raise ValidationFailed(f"“{f['label'] or f['id']}” maps to a custom field that doesn't exist",
                                   code="INVALID_REFERENCE")
        if m["kind"] == "standard" and m["key"] not in STANDARD_FIELDS:
            raise ValidationFailed(f"“{f['label'] or f['id']}” maps to an unknown contact field",
                                   code="INVALID_REFERENCE")
        if f["type"] in ("select", "radio", "checkboxes") and not f["options"]:
            raise ValidationFailed(f"“{f['label'] or f['id']}” needs at least one option", code="OPTIONS_REQUIRED")
    if d["success"]["mode"] in ("redirect", "both") and not d["success"]["redirect_url"]:
        raise ValidationFailed("Add the URL to redirect to after submit", code="REDIRECT_REQUIRED")
    members = set(members_with(db, ctx.organization_id, app_id, Perm.FORMS_READ))
    if any(u not in members for u in s["notify_user_ids"]):
        raise ValidationFailed("Someone chosen for notifications no longer has access", code="INVALID_REFERENCE")
    if s["create_deal"] and s["deal_pipeline_id"]:
        p = db.get(Pipeline, s["deal_pipeline_id"])
        if p is None or p.application_id != app_id:
            raise ValidationFailed("Choose a pipeline for new deals", code="INVALID_REFERENCE")
        if s["deal_stage_id"]:
            st = db.get(PipelineStage, s["deal_stage_id"])
            if st is None or st.pipeline_id != p.id:
                raise ValidationFailed("Choose a stage in that pipeline", code="INVALID_REFERENCE")
    if s["double_opt_in"] and confirm_sender(db, app_id, s.get("confirm_sender_id")) is None:
        raise ValidationFailed("Double opt-in needs a verified email sender. Verify one under Email → Senders.",
                               code="SENDER_NOT_VERIFIED")
    if s["turnstile"] and not turnstile_available():
        raise ValidationFailed("Cloudflare Turnstile is not configured on this platform", code="TURNSTILE_UNAVAILABLE")


def confirm_sender(db: Session, application_id: str, sender_id: str | None) -> EmailSender | None:
    q = select(EmailSender).where(EmailSender.application_id == application_id, EmailSender.status == "verified")
    if sender_id:
        s = db.scalar(q.where(EmailSender.id == sender_id))
        if s is not None:
            return s
    return db.scalar(q.order_by(EmailSender.is_default.desc(), EmailSender.created_at))


def publish(db: Session, ctx, form_id: str) -> LeadForm:
    ctx.require(Perm.FORMS_WRITE)
    f = get_form(db, ctx, form_id)
    d = clean_definition(f.draft)
    check_references(db, ctx, d)
    if f.published != d or f.published_version is None:
        n = (db.scalar(select(func.max(LeadFormVersion.version)).where(LeadFormVersion.form_id == f.id)) or 0) + 1
        db.add(LeadFormVersion(form_id=f.id, application_id=f.application_id, version=n, definition=d,
                               published_by_id=ctx.user.id))
        f.published, f.published_version, f.published_at = d, n, utcnow()
    f.draft = d
    f.status = "published"
    f.updated_at = utcnow()
    _audit(db, ctx, "lead_form.published", f, f"Published lead form {f.name} (v{f.published_version})")
    return f


def pause(db: Session, ctx, form_id: str) -> LeadForm:
    ctx.require(Perm.FORMS_WRITE)
    f = get_form(db, ctx, form_id)
    if f.status == "published":
        f.status = "paused"
        _audit(db, ctx, "lead_form.paused", f, f"Paused lead form {f.name}")
    return f


def discard(db: Session, ctx, form_id: str) -> LeadForm:
    ctx.require(Perm.FORMS_WRITE)
    f = get_form(db, ctx, form_id)
    if f.published is None:
        raise ValidationFailed("This form has never been published", code="NOT_PUBLISHED")
    f.draft = f.published
    f.updated_at = utcnow()
    return f


def versions(db: Session, ctx, form_id: str) -> list[VersionOut]:
    ctx.require(Perm.FORMS_READ)
    f = get_form(db, ctx, form_id)
    rows = db.execute(select(LeadFormVersion.version, LeadFormVersion.created_at, User.full_name)
                      .outerjoin(User, User.id == LeadFormVersion.published_by_id)
                      .where(LeadFormVersion.form_id == f.id).order_by(LeadFormVersion.version.desc())).all()
    return [VersionOut(version=v, created_at=c, published_by_name=n) for v, c, n in rows]


def duplicate(db: Session, ctx, form_id: str) -> LeadForm:
    ctx.require(Perm.FORMS_WRITE)
    src = get_form(db, ctx, form_id)
    _check_limit(db, ctx)
    f = LeadForm(organization_id=ctx.organization_id, application_id=ctx.application_id, public_id=_new_public_id(db),
                 name=f"{src.name} (copy)"[:120], template=src.template, status="draft", draft=src.draft,
                 created_by_id=ctx.user.id)
    db.add(f)
    db.flush()
    _audit(db, ctx, "lead_form.created", f, f"Duplicated lead form {src.name}", {"from": src.id})
    return f


def delete_form(db: Session, ctx, form_id: str) -> None:
    ctx.require(Perm.FORMS_WRITE)
    f = get_form(db, ctx, form_id)
    _audit(db, ctx, "lead_form.deleted", f, f"Deleted lead form {f.name}")
    db.delete(f)


# ------------------------------------------------------------------ builder metadata

def members_with(db: Session, organization_id: str, application_id: str, perm: Perm) -> dict[str, User]:
    rows = db.execute(select(OrganizationMember, User).join(User, User.id == OrganizationMember.user_id).where(
        OrganizationMember.organization_id == organization_id)).all()
    app_members = {m.user_id: m for m in db.scalars(select(ApplicationMember).where(
        ApplicationMember.application_id == application_id))}
    out = {}
    for om, u in rows:
        role = Role(om.role_key)
        eff = role if role in ORG_WIDE_ROLES else effective_app_role(role, app_members.get(u.id))
        if eff is not None and perm in permissions_for(eff) and getattr(u, "deleted_at", None) is None:
            out[u.id] = u
    return out


@lru_cache(maxsize=1)
def countries() -> list[dict]:
    import phonenumbers
    from phonenumbers import geocoder

    out = []
    for code in phonenumbers.SUPPORTED_REGIONS:
        name = geocoder._region_display_name(code, "en") or code
        out.append({"code": code, "name": name, "dial": f"+{phonenumbers.country_code_for_region(code)}"})
    return sorted(out, key=lambda c: c["name"])


def meta(db: Session, ctx) -> dict:
    ctx.require(Perm.FORMS_READ)
    app_id = ctx.application_id
    pipelines = list(db.scalars(select(Pipeline).where(Pipeline.application_id == app_id,
                                                       Pipeline.archived.is_(False)).order_by(Pipeline.position)))
    stages: dict[str, list] = {}
    for st in db.scalars(select(PipelineStage).where(PipelineStage.application_id == app_id,
                                                     PipelineStage.kind == "open").order_by(PipelineStage.position)):
        stages.setdefault(st.pipeline_id, []).append({"id": st.id, "name": st.name})
    cap = plans.limit(db, ctx.organization_id, "lead_forms")
    return {
        "standard_fields": [{"key": k, "label": STANDARD_LABELS[k]} for k in STANDARD_FIELDS],
        "custom_fields": [{"key": d.key, "label": d.label, "data_type": d.data_type, "options": d.options or []}
                          for d in db.scalars(select(ContactAttributeDefinition).where(
                              ContactAttributeDefinition.application_id == app_id)
                              .order_by(ContactAttributeDefinition.label))],
        "lists": [{"id": i, "name": n} for i, n in db.execute(select(ContactList.id, ContactList.name).where(
            ContactList.application_id == app_id).order_by(ContactList.name))],
        "tags": [{"id": i, "name": n} for i, n in db.execute(select(Tag.id, Tag.name).where(
            Tag.application_id == app_id).order_by(Tag.name))],
        "team": [{"id": u.id, "full_name": u.full_name, "email": u.email}
                 for u in sorted(members_with(db, ctx.organization_id, app_id, Perm.FORMS_READ).values(),
                                 key=lambda u: (u.full_name or u.email).lower())],
        "pipelines": [{"id": p.id, "name": p.name, "stages": stages.get(p.id, [])} for p in pipelines],
        "senders": [{"id": s.id, "from_name": s.from_name, "from_email": s.from_email}
                    for s in db.scalars(select(EmailSender).where(EmailSender.application_id == app_id,
                                                                  EmailSender.status == "verified"))],
        "fonts": list(FONTS),
        "turnstile_available": turnstile_available(),
        "branding": branding(db, ctx.organization_id),
        "usage": {"used": _count_forms(db, ctx.organization_id), "limit": cap},
        "countries": countries(),
        "default_country": ctx.application.default_country,
    }


def developer_email(f: LeadForm, sender_name: str, note: str):
    """The embed codes and platform notes, for whoever maintains the website."""
    from html import escape

    from app.services.mail_templates import RenderedEmail, _layout

    em = embed_info(f.public_id)
    snippets = [("Inline (shows the form where you paste it)", em.inline),
                ("Popup", em.popup), ("Slide-in", em.slide_in), ("Floating button", em.floating),
                ("Open on click of your own button", em.button)]
    pre = "font-family:monospace;font-size:12px;background:#f1f5f9;padding:10px;border-radius:6px;white-space:pre-wrap"
    blocks = "".join(f"<p style='margin:16px 0 4px;font-weight:600'>{escape(t)}</p><pre style='{pre}'>{escape(s)}</pre>"
                     for t, s in snippets)
    note_html = f"<p><em>{escape(note)}</em></p>" if note.strip() else ""
    platforms = ("<p style='font-size:13px;color:#475569'>WordPress: add a Custom HTML block. Shopify: a Custom Liquid "
                 "section or theme.liquid. Wix: Embed code → Embed HTML. Webflow: an Embed element. Squarespace: a "
                 "Code block.</p>")
    text = "\n\n".join(f"{t}:\n{s}" for t, s in snippets)
    return RenderedEmail(
        subject=f"{sender_name} sent you the embed code for “{f.name}”"[:200],
        html=_layout(f"Add “{f.name}” to the website",
                     f"<p>{escape(sender_name)} asked you to add this form to the website. Paste one of these "
                     f"snippets into the page's HTML.</p>{note_html}{blocks}{platforms}",
                     "Preview the form", em.hosted_url, f"Sent from {settings.APP_NAME}."),
        text=f"{sender_name} asked you to add the form “{f.name}” to the website.\n\n{note}\n\n{text}\n\n"
             f"Preview: {em.hosted_url}")
