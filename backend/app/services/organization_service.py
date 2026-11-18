"""Organizations, members and roles."""
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.core.permissions import (
    ORG_WIDE_ROLES,
    ROLE_DESCRIPTIONS,
    ROLE_LABELS,
    ROLE_RANK,
    Perm,
    Role,
    can_assign,
    permissions_for,
)
from app.models import Application, ApplicationMember, AuditLog, Organization, OrganizationMember, User
from app.schemas.common import Page, PageParams
from app.schemas.organization import (
    AuditLogOut,
    MemberOut,
    MemberUpdate,
    MemberUser,
    MyOrganizationOut,
    OrganizationCreate,
    OrganizationUpdate,
    RoleOut,
)
from app.services import audit_service
from app.services.notification_service import notify
from app.services.tenancy import OrgContext
from app.utils.text import slugify, unique_suffix


def _unique_org_slug(db: Session, name: str) -> str:
    base = slugify(name, 60)
    slug = base
    while db.scalar(select(Organization.id).where(Organization.slug == slug)):
        slug = f"{base}-{unique_suffix()}"
    return slug


def create_organization(db: Session, user: User, data: OrganizationCreate, ip: str | None = None) -> Organization:
    if not user.email_verified:
        raise Forbidden("Verify your email address before creating an organization", code="EMAIL_NOT_VERIFIED")
    org = Organization(
        name=data.name,
        slug=_unique_org_slug(db, data.name),
        industry=data.industry,
        website=str(data.website) if data.website else None,
        country=data.country,
        created_by_id=user.id,
    )
    db.add(org)
    db.flush()
    db.add(OrganizationMember(organization_id=org.id, user_id=user.id, role_key=Role.OWNER.value))
    user.last_organization_id = org.id
    audit_service.record(db, "organization.created", actor_user_id=user.id, organization_id=org.id,
                         target_type="organization", target_id=org.id, summary=f"Created organization {org.name}",
                         ip_address=ip)
    return org


def list_my_organizations(db: Session, user: User) -> list[MyOrganizationOut]:
    app_counts = dict(
        db.execute(
            select(Application.organization_id, func.count(Application.id))
            .where(Application.deleted_at.is_(None))
            .group_by(Application.organization_id)
        ).all()
    )
    rows = db.execute(
        select(Organization, OrganizationMember.role_key)
        .join(OrganizationMember, OrganizationMember.organization_id == Organization.id)
        .where(OrganizationMember.user_id == user.id, Organization.deleted_at.is_(None))
        .order_by(Organization.name)
    ).all()
    out = [_my_org(org, role, app_counts.get(org.id, 0)) for org, role in rows]
    if user.platform_role in ("super_admin", "support"):
        from app.models.support import SupportGrant
        from app.utils.time import utcnow

        member_of = {o.id for o in out}
        for g, org in db.execute(select(SupportGrant, Organization).join(
                Organization, Organization.id == SupportGrant.organization_id).where(
                SupportGrant.user_id == user.id, SupportGrant.ended_at.is_(None), SupportGrant.expires_at > utcnow(),
                Organization.deleted_at.is_(None)).order_by(SupportGrant.expires_at.desc())):
            if org.id in member_of:
                continue
            member_of.add(org.id)
            item = _my_org(org, Role.PLATFORM_SUPPORT.value, app_counts.get(org.id, 0))
            item.support_access_expires_at = g.expires_at
            out.append(item)
    return out


def _my_org(org: Organization, role_key: str, app_count: int = 0) -> MyOrganizationOut:
    role = Role(role_key)
    return MyOrganizationOut(
        id=org.id, name=org.name, slug=org.slug, status=org.status, industry=org.industry, website=org.website,
        country=org.country, created_at=org.created_at, role=role.value, role_label=ROLE_LABELS[role],
        permissions=sorted(p.value for p in permissions_for(role)), application_count=app_count,
    )


def describe_for_member(db: Session, ctx: OrgContext) -> MyOrganizationOut:
    count = db.scalar(
        select(func.count(Application.id)).where(
            Application.organization_id == ctx.organization_id, Application.deleted_at.is_(None)
        )
    )
    out = _my_org(ctx.organization, ctx.role.value, count or 0)
    if ctx.support:
        from app.services.tenancy import active_support_grant

        g = active_support_grant(db, ctx.user, ctx.organization_id)
        out.support_access_expires_at = g.expires_at if g else None
    return out


def update_organization(db: Session, ctx: OrgContext, data: OrganizationUpdate) -> Organization:
    ctx.require(Perm.ORG_UPDATE)
    org = ctx.organization
    changes = data.model_dump(exclude_unset=True)
    for field, value in changes.items():
        if field == "website" and value is not None:
            value = str(value)
        if field == "country" and value:
            value = value.upper()
        if field == "name" and (value is None or len(value.strip()) < 2):
            raise ValidationFailed("Name must be at least 2 characters")
        setattr(org, field, value.strip() if isinstance(value, str) else value)
    audit_service.record(db, "organization.updated", actor_user_id=ctx.user.id, organization_id=org.id,
                         target_type="organization", target_id=org.id, meta={"fields": sorted(changes)})
    return org


# ---------------------------------------------------------------- members

def _app_ids_by_user(db: Session, organization_id: str) -> dict[str, list[str]]:
    rows = db.execute(
        select(ApplicationMember.user_id, ApplicationMember.application_id)
        .join(Application, Application.id == ApplicationMember.application_id)
        .where(ApplicationMember.organization_id == organization_id, Application.deleted_at.is_(None))
    ).all()
    out: dict[str, list[str]] = {}
    for uid, aid in rows:
        out.setdefault(uid, []).append(aid)
    return out


def _member_out(m: OrganizationMember, u: User, app_ids: list[str]) -> MemberOut:
    role = Role(m.role_key)
    return MemberOut(id=m.id, user=MemberUser.model_validate(u), role=role.value, role_label=ROLE_LABELS[role],
                     application_ids=app_ids, created_at=m.created_at)


def list_members(db: Session, ctx: OrgContext, params: PageParams, search: str | None = None) -> Page[MemberOut]:
    ctx.require(Perm.MEMBERS_READ)
    base = (
        select(OrganizationMember, User)
        .join(User, User.id == OrganizationMember.user_id)
        .where(OrganizationMember.organization_id == ctx.organization_id)
    )
    if search:
        like = f"%{search.strip()}%"
        base = base.where((User.full_name.ilike(like)) | (User.email.ilike(like)))
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.execute(base.order_by(User.full_name).offset(params.offset).limit(params.page_size)).all()
    app_ids = _app_ids_by_user(db, ctx.organization_id)
    return Page(items=[_member_out(m, u, app_ids.get(u.id, [])) for m, u in rows], total=total, page=params.page,
                page_size=params.page_size)


def _get_member(db: Session, ctx: OrgContext, member_id: str) -> OrganizationMember:
    m = db.scalar(select(OrganizationMember).where(
        OrganizationMember.id == member_id, OrganizationMember.organization_id == ctx.organization_id))
    if m is None:
        raise NotFound("Member not found")
    return m


def _owner_count(db: Session, organization_id: str) -> int:
    return db.scalar(select(func.count(OrganizationMember.id)).where(
        OrganizationMember.organization_id == organization_id, OrganizationMember.role_key == Role.OWNER.value)) or 0


def _guard_manage(ctx: OrgContext, target: OrganizationMember) -> None:
    """Non-owners can only manage members ranked strictly below themselves."""
    if ctx.role == Role.OWNER:
        return
    if ROLE_RANK[Role(target.role_key)] >= ROLE_RANK[ctx.role]:
        raise Forbidden("You cannot manage a member with an equal or higher role", code="ROLE_HIERARCHY")


def validate_application_ids(db: Session, organization_id: str, application_ids: list[str]) -> list[str]:
    ids = list(dict.fromkeys(application_ids))
    if not ids:
        return []
    found = set(db.scalars(select(Application.id).where(
        Application.id.in_(ids), Application.organization_id == organization_id, Application.deleted_at.is_(None))))
    missing = [i for i in ids if i not in found]
    if missing:
        raise ValidationFailed("One or more applications do not exist in this organization",
                               code="INVALID_APPLICATIONS", details={"application_ids": missing})
    return ids


def set_member_applications(db: Session, organization_id: str, user_id: str, application_ids: list[str]) -> None:
    current = set(db.scalars(select(ApplicationMember.application_id).where(
        ApplicationMember.organization_id == organization_id, ApplicationMember.user_id == user_id)))
    wanted = set(application_ids)
    if current - wanted:
        db.execute(delete(ApplicationMember).where(
            ApplicationMember.organization_id == organization_id, ApplicationMember.user_id == user_id,
            ApplicationMember.application_id.in_(current - wanted)))
    for app_id in wanted - current:
        db.add(ApplicationMember(organization_id=organization_id, application_id=app_id, user_id=user_id))


def update_member(db: Session, ctx: OrgContext, member_id: str, data: MemberUpdate) -> MemberOut:
    ctx.require(Perm.MEMBERS_UPDATE)
    member = _get_member(db, ctx, member_id)
    if member.user_id == ctx.user.id and data.role is not None and data.role != Role(member.role_key):
        raise Forbidden("You cannot change your own role", code="SELF_ROLE_CHANGE")
    _guard_manage(ctx, member)
    meta: dict = {}
    if data.role is not None and data.role.value != member.role_key:
        if not can_assign(ctx.role, data.role):
            raise Forbidden("You cannot assign a role higher than your own", code="ROLE_HIERARCHY")
        if member.role_key == Role.OWNER.value and _owner_count(db, ctx.organization_id) <= 1:
            raise Conflict("An organization must keep at least one owner", code="LAST_OWNER")
        meta["role"] = {"from": member.role_key, "to": data.role.value}
        member.role_key = data.role.value
        notify(db, member.user_id, type_="role_changed", title=f"Your role in {ctx.organization.name} changed",
               body=f"You are now {ROLE_LABELS[data.role]}.", link=f"/orgs/{ctx.organization_id}/applications",
               organization_id=ctx.organization_id)
    if data.application_ids is not None:
        ids = validate_application_ids(db, ctx.organization_id, data.application_ids)
        set_member_applications(db, ctx.organization_id, member.user_id, ids)
        meta["application_ids"] = ids
    db.flush()
    audit_service.record(db, "member.updated", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         target_type="member", target_id=member.id, meta=meta)
    user = db.get(User, member.user_id)
    return _member_out(member, user, _app_ids_by_user(db, ctx.organization_id).get(member.user_id, []))


def remove_member(db: Session, ctx: OrgContext, member_id: str) -> None:
    member = _get_member(db, ctx, member_id)
    leaving_self = member.user_id == ctx.user.id
    if not leaving_self:
        ctx.require(Perm.MEMBERS_REMOVE)
        _guard_manage(ctx, member)
    if member.role_key == Role.OWNER.value and _owner_count(db, ctx.organization_id) <= 1:
        raise Conflict("Transfer ownership before removing the last owner", code="LAST_OWNER")
    db.execute(delete(ApplicationMember).where(
        ApplicationMember.organization_id == ctx.organization_id, ApplicationMember.user_id == member.user_id))
    user = db.get(User, member.user_id)
    if user and user.last_organization_id == ctx.organization_id:
        user.last_organization_id = None
        user.last_application_id = None
    db.delete(member)
    if not leaving_self:
        notify(db, member.user_id, type_="member_removed", level="warning",
               title=f"You were removed from {ctx.organization.name}",
               body="You no longer have access to its applications.")
    audit_service.record(db, "member.left" if leaving_self else "member.removed", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, target_type="user", target_id=member.user_id)


def list_roles(ctx: OrgContext) -> list[RoleOut]:
    return [
        RoleOut(key=r.value, name=ROLE_LABELS[r], description=ROLE_DESCRIPTIONS[r], rank=ROLE_RANK[r],
                is_org_wide=r in ORG_WIDE_ROLES, permissions=sorted(p.value for p in permissions_for(r)),
                assignable=can_assign(ctx.role, r) and ctx.has(Perm.MEMBERS_INVITE))
        for r in sorted(Role, key=lambda x: -ROLE_RANK[x]) if r != Role.PLATFORM_SUPPORT
    ]


def list_audit_logs(db: Session, ctx: OrgContext, params: PageParams, application_id: str | None = None
                    ) -> Page[AuditLogOut]:
    ctx.require(Perm.AUDIT_READ)
    base = select(AuditLog, User.full_name).outerjoin(User, User.id == AuditLog.actor_user_id).where(
        AuditLog.organization_id == ctx.organization_id)
    if application_id:
        base = base.where(AuditLog.application_id == application_id)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.execute(base.order_by(AuditLog.created_at.desc()).offset(params.offset).limit(params.page_size)).all()
    items = []
    for log, actor in rows:
        out = AuditLogOut.model_validate(log)
        out.actor_name = actor
        items.append(out)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)
