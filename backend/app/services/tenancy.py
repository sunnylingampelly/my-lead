"""Tenant context resolution.

Every organization- or application-scoped request resolves a context here from the
authenticated user and the id in the URL. Ids from the client are never trusted on their own:
membership is always verified against the database, and records the user cannot access are
reported as 404 so their existence is not leaked.
"""
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Forbidden, NotFound
from app.core.permissions import ORG_WIDE_ROLES, ROLE_RANK, Perm, Role, permissions_for
from app.models import Application, ApplicationMember, Organization, OrganizationMember, User


@dataclass(frozen=True)
class OrgContext:
    user: User
    organization: Organization
    membership: OrganizationMember | None
    role: Role
    permissions: frozenset[Perm]
    # True when platform staff are viewing through a read-only support session.
    support: bool = False

    @property
    def organization_id(self) -> str:
        return self.organization.id

    @property
    def is_org_wide(self) -> bool:
        return self.role in ORG_WIDE_ROLES

    def has(self, perm: Perm) -> bool:
        return perm in self.permissions

    def require(self, perm: Perm) -> None:
        if perm not in self.permissions:
            raise Forbidden("You do not have permission to perform this action", code="PERMISSION_DENIED",
                            details={"required": perm.value})


@dataclass(frozen=True)
class AppContext(OrgContext):
    application: Application = None  # type: ignore[assignment]

    @property
    def application_id(self) -> str:
        return self.application.id


def _check_org_active(org: Organization) -> None:
    if org.status == "suspended":
        raise Forbidden("This organization is suspended. Contact support.", code="ORG_SUSPENDED")


def resolve_org_context(db: Session, user: User, organization_id: str) -> OrgContext:
    row = db.execute(
        select(Organization, OrganizationMember)
        .join(OrganizationMember, OrganizationMember.organization_id == Organization.id)
        .where(
            Organization.id == organization_id,
            Organization.deleted_at.is_(None),
            OrganizationMember.user_id == user.id,
        )
    ).first()
    if row is None:
        support = _support_context(db, user, organization_id)
        if support is not None:
            return support
        raise NotFound("Organization not found")
    org, membership = row
    _check_org_active(org)
    role = Role(membership.role_key)
    return OrgContext(user=user, organization=org, membership=membership, role=role,
                      permissions=permissions_for(role))


def effective_app_role(org_role: Role, app_member: ApplicationMember | None) -> Role | None:
    """Org-wide roles always apply. Others need an app membership; an app-level role may only
    narrow, never widen, the organization role."""
    if org_role in ORG_WIDE_ROLES:
        return org_role
    if app_member is None:
        return None
    if app_member.role_key:
        app_role = Role(app_member.role_key)
        return app_role if ROLE_RANK[app_role] <= ROLE_RANK[org_role] else org_role
    return org_role


def resolve_app_context(db: Session, user: User, application_id: str) -> AppContext:
    row = db.execute(
        select(Application, Organization, OrganizationMember)
        .join(Organization, Organization.id == Application.organization_id)
        .join(OrganizationMember, OrganizationMember.organization_id == Organization.id)
        .where(
            Application.id == application_id,
            Application.deleted_at.is_(None),
            Organization.deleted_at.is_(None),
            OrganizationMember.user_id == user.id,
        )
    ).first()
    if row is None:
        app = db.scalar(select(Application).where(Application.id == application_id, Application.deleted_at.is_(None)))
        support = _support_context(db, user, app.organization_id) if app is not None else None
        if support is not None:
            return AppContext(user=support.user, organization=support.organization, membership=None, role=support.role,
                              permissions=support.permissions, support=True, application=app)
        raise NotFound("Application not found")
    app, org, membership = row
    _check_org_active(org)
    org_role = Role(membership.role_key)
    app_member = None
    if org_role not in ORG_WIDE_ROLES:
        app_member = db.scalar(
            select(ApplicationMember).where(
                ApplicationMember.application_id == app.id, ApplicationMember.user_id == user.id
            )
        )
    role = effective_app_role(org_role, app_member)
    if role is None:
        raise NotFound("Application not found")
    return AppContext(user=user, organization=org, membership=membership, role=role,
                      permissions=permissions_for(role), application=app)


def active_support_grant(db: Session, user: User, organization_id: str):
    from app.models.support import SupportGrant
    from app.utils.time import utcnow

    if user.platform_role not in ("super_admin", "support"):
        return None
    return db.scalar(select(SupportGrant).where(
        SupportGrant.user_id == user.id, SupportGrant.organization_id == organization_id,
        SupportGrant.ended_at.is_(None), SupportGrant.expires_at > utcnow()).order_by(SupportGrant.expires_at.desc()))


def _support_context(db: Session, user: User, organization_id: str) -> OrgContext | None:
    """Platform staff with an open support session get read-only access; everyone else gets 404."""
    if active_support_grant(db, user, organization_id) is None:
        return None
    org = db.scalar(select(Organization).where(Organization.id == organization_id, Organization.deleted_at.is_(None)))
    if org is None:
        return None
    return OrgContext(user=user, organization=org, membership=None, role=Role.PLATFORM_SUPPORT,
                      permissions=permissions_for(Role.PLATFORM_SUPPORT), support=True)
