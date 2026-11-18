"""Applications (isolated workspaces) within an organization."""
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.core.permissions import ORG_WIDE_ROLES, ROLE_RANK, Perm, Role, permissions_for
from app.models import Application, ApplicationMember, ApplicationSettings, OrganizationMember, User
from app.schemas.application import (
    ApplicationCreate,
    ApplicationSettingsUpdate,
    ApplicationUpdate,
    AppMemberAdd,
    AppMemberOut,
    MyApplicationOut,
)
from app.services import audit_service
from app.services.notification_service import notify
from app.services.regions import profile_for
from app.services.tenancy import AppContext, OrgContext, effective_app_role
from app.utils.text import slugify, unique_suffix
from app.utils.time import utcnow


def _unique_slug(db: Session, organization_id: str, name: str, exclude_id: str | None = None) -> str:
    base = slugify(name, 60)
    slug = base
    while True:
        q = select(Application.id).where(Application.organization_id == organization_id, Application.slug == slug)
        if exclude_id:
            q = q.where(Application.id != exclude_id)
        if not db.scalar(q):
            return slug
        slug = f"{base}-{unique_suffix()}"


def create_application(db: Session, ctx: OrgContext, data: ApplicationCreate) -> Application:
    ctx.require(Perm.APPS_CREATE)
    app = Application(
        organization_id=ctx.organization_id, name=data.name, slug=_unique_slug(db, ctx.organization_id, data.name),
        description=data.description, color=data.color, timezone=data.timezone,
        default_country=data.default_country.upper() if data.default_country else None, created_by_id=ctx.user.id,
    )
    db.add(app)
    db.flush()
    # Regional defaults: promotional SMS/calls only inside the market's permitted window.
    region = profile_for(app.default_country or ctx.organization.country)
    db.add(ApplicationSettings(organization_id=ctx.organization_id, application_id=app.id,
                               quiet_hours_start=region.marketing_window_end,
                               quiet_hours_end=region.marketing_window_start,
                               business_name=ctx.organization.name))
    if not ctx.is_org_wide:
        db.add(ApplicationMember(organization_id=ctx.organization_id, application_id=app.id, user_id=ctx.user.id))
    ctx.user.last_organization_id = ctx.organization_id
    ctx.user.last_application_id = app.id
    audit_service.record(db, "application.created", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=app.id, target_type="application", target_id=app.id,
                         summary=f"Created application {app.name}")
    return app


def to_my_app(app: Application, role: Role) -> MyApplicationOut:
    return MyApplicationOut.model_validate(
        {**{c: getattr(app, c) for c in MyApplicationOut.model_fields if hasattr(app, c)},
         "role": role.value, "permissions": sorted(p.value for p in permissions_for(role))}
    )


def list_applications(db: Session, ctx: OrgContext) -> list[MyApplicationOut]:
    q = select(Application).where(Application.organization_id == ctx.organization_id,
                                  Application.deleted_at.is_(None)).order_by(Application.name)
    apps = list(db.scalars(q))
    if ctx.is_org_wide:
        return [to_my_app(a, ctx.role) for a in apps]
    memberships = {m.application_id: m for m in db.scalars(select(ApplicationMember).where(
        ApplicationMember.organization_id == ctx.organization_id, ApplicationMember.user_id == ctx.user.id))}
    out = []
    for a in apps:
        role = effective_app_role(ctx.role, memberships.get(a.id))
        if role is not None:
            out.append(to_my_app(a, role))
    return out


def update_application(db: Session, ctx: AppContext, data: ApplicationUpdate) -> Application:
    ctx.require(Perm.APP_UPDATE)
    app = ctx.application
    changes = data.model_dump(exclude_unset=True)
    for field, value in changes.items():
        if value is None and field in {"name", "color", "timezone"}:
            continue
        if field == "name":
            value = value.strip()
            if len(value) < 2:
                raise ValidationFailed("Name must be at least 2 characters")
        if field == "default_country" and value:
            value = value.upper()
        setattr(app, field, value)
    audit_service.record(db, "application.updated", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=app.id, target_type="application", target_id=app.id,
                         meta={"fields": sorted(changes)})
    return app


def delete_application(db: Session, ctx: AppContext, confirm_name: str) -> None:
    ctx.require(Perm.APP_DELETE)
    app = ctx.application
    if confirm_name.strip() != app.name:
        raise ValidationFailed("Type the application name exactly to confirm deletion", code="CONFIRMATION_MISMATCH")
    # Soft delete: data is retained for the retention window, then purged by a maintenance job.
    app.deleted_at = utcnow()
    app.status = "deleted"
    app.slug = f"{app.slug[:60]}-deleted-{unique_suffix(4)}"  # free the slug for reuse
    db.execute(delete(ApplicationMember).where(ApplicationMember.application_id == app.id))
    for u in db.scalars(select(User).where(User.last_application_id == app.id)):
        u.last_application_id = None
    audit_service.record(db, "application.deleted", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=app.id, target_type="application", target_id=app.id,
                         summary=f"Deleted application {app.name}")


def get_settings(db: Session, ctx: AppContext) -> ApplicationSettings:
    ctx.require(Perm.SETTINGS_READ)
    s = db.scalar(select(ApplicationSettings).where(ApplicationSettings.application_id == ctx.application_id))
    if s is None:  # defensive: created with the app, but never fail reads
        s = ApplicationSettings(organization_id=ctx.organization_id, application_id=ctx.application_id)
        db.add(s)
        db.flush()
    return s


def update_settings(db: Session, ctx: AppContext, data: ApplicationSettingsUpdate) -> ApplicationSettings:
    ctx.require(Perm.SETTINGS_WRITE)
    s = get_settings(db, ctx)
    changes = data.model_dump(exclude_unset=True, exclude_none=True)
    if "contact_identity_rule" in changes and changes["contact_identity_rule"] != s.contact_identity_rule:
        from app.models import Contact

        if db.scalar(select(Contact.id).where(Contact.application_id == ctx.application_id).limit(1)):
            raise Conflict("The duplicate-contact rule can only be changed before any contacts exist",
                           code="IDENTITY_RULE_LOCKED")
    for k, v in changes.items():
        setattr(s, k, v.strip() if isinstance(v, str) and k.startswith("business_") else v)
    audit_service.record(db, "application.settings_updated", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="application", target_id=ctx.application_id, meta={"fields": sorted(changes)})
    return s


# ---------------------------------------------------------------- application access

def list_app_members(db: Session, ctx: AppContext) -> list[AppMemberOut]:
    ctx.require(Perm.APP_READ)
    rows = db.execute(
        select(OrganizationMember, User).join(User, User.id == OrganizationMember.user_id)
        .where(OrganizationMember.organization_id == ctx.organization_id).order_by(User.full_name)
    ).all()
    app_members = {m.user_id: m for m in db.scalars(select(ApplicationMember).where(
        ApplicationMember.application_id == ctx.application_id))}
    out = []
    for om, u in rows:
        org_role = Role(om.role_key)
        am = app_members.get(u.id)
        eff = effective_app_role(org_role, am)
        if eff is None:
            continue
        out.append(AppMemberOut(user_id=u.id, full_name=u.full_name, email=u.email, org_role=org_role.value,
                                app_role=am.role_key if am else None, effective_role=eff.value,
                                access="org_wide" if org_role in ORG_WIDE_ROLES else "explicit"))
    return out


def add_app_member(db: Session, ctx: AppContext, data: AppMemberAdd) -> None:
    ctx.require(Perm.APP_MEMBERS_MANAGE)
    om = db.scalar(select(OrganizationMember).where(
        OrganizationMember.organization_id == ctx.organization_id, OrganizationMember.user_id == data.user_id))
    if om is None:
        raise NotFound("That user is not a member of this organization")
    if Role(om.role_key) in ORG_WIDE_ROLES:
        raise Conflict("Owners and admins already have access to every application")
    role_key = None
    if data.role:
        try:
            role = Role(data.role)
        except ValueError as exc:
            raise ValidationFailed("Unknown role") from exc
        if ROLE_RANK[role] > ROLE_RANK[Role(om.role_key)] or role in ORG_WIDE_ROLES:
            raise ValidationFailed("Application role cannot exceed the member's organization role")
        if ROLE_RANK[role] > ROLE_RANK[ctx.role]:
            raise Forbidden("You cannot grant a role above your own", code="ROLE_HIERARCHY")
        role_key = role.value
    am = db.scalar(select(ApplicationMember).where(
        ApplicationMember.application_id == ctx.application_id, ApplicationMember.user_id == data.user_id))
    if am is None:
        db.add(ApplicationMember(organization_id=ctx.organization_id, application_id=ctx.application_id,
                                 user_id=data.user_id, role_key=role_key))
        notify(db, data.user_id, type_="app_access_granted", level="success",
               title=f"You now have access to {ctx.application.name}",
               body=f"Granted by {ctx.user.full_name} in {ctx.organization.name}.",
               link=f"/apps/{ctx.application_id}", organization_id=ctx.organization_id,
               application_id=ctx.application_id)
    else:
        am.role_key = role_key
    audit_service.record(db, "application.member_added", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="user", target_id=data.user_id, meta={"role": role_key})


def remove_app_member(db: Session, ctx: AppContext, user_id: str) -> None:
    ctx.require(Perm.APP_MEMBERS_MANAGE)
    am = db.scalar(select(ApplicationMember).where(
        ApplicationMember.application_id == ctx.application_id, ApplicationMember.user_id == user_id))
    if am is None:
        raise NotFound("That user does not have explicit access to this application")
    db.delete(am)
    audit_service.record(db, "application.member_removed", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="user", target_id=user_id)


def compliance(db: Session, ctx: AppContext) -> dict:
    """Regional rules that apply to this application and whether its setup satisfies them."""
    ctx.require(Perm.APP_READ)
    s = get_settings(db, ctx) if ctx.has(Perm.SETTINGS_READ) else None
    region = profile_for(ctx.application.default_country or ctx.organization.country)
    checks = []
    if s is not None:
        checks.append({"key": "business_address", "label": "Physical postal address for email footers",
                       "required": region.email_requires_postal_address, "done": bool(s.business_address)})
        checks.append({"key": "quiet_hours", "label": f"Quiet hours cover {region.marketing_window_end} to "
                       f"{region.marketing_window_start}", "required": True,
                       "done": s.quiet_hours_start <= region.marketing_window_end
                       and s.quiet_hours_end >= region.marketing_window_start})
    checks.append({"key": "dlt", "label": "DLT entity, headers and templates (SMS module)",
                   "required": region.sms_requires_dlt, "done": False, "pending_module": "sms"})
    checks.append({"key": "10dlc", "label": "A2P 10DLC brand and campaign registration (SMS module)",
                   "required": region.sms_requires_10dlc, "done": False, "pending_module": "sms"})
    return {
        "region": region.code, "region_name": region.name, "currency": region.currency,
        "dial_code": region.dial_code, "marketing_window": [region.marketing_window_start, region.marketing_window_end],
        "sms_voice_requires_written_consent": region.sms_voice_requires_written_consent,
        "email_requires_postal_address": region.email_requires_postal_address,
        "regulations": list(region.regulations),
        "checks": [c for c in checks if c["required"]],
        "disclaimer": "Product guidance, not legal advice. Confirm requirements with your counsel.",
    }
