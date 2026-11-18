"""Team invitations."""
from datetime import timedelta
from urllib.parse import quote

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.core.permissions import ORG_WIDE_ROLES, ROLE_LABELS, Perm, Role, can_assign
from app.core.security import generate_token, hash_token
from app.models import Invitation, Organization, OrganizationMember, User
from app.schemas.organization import InvitationCreate, InvitationOut, InvitationPreview
from app.services import audit_service, mail_templates
from app.services.notification_service import notify
from app.services.notifications import enqueue_system_email
from app.services.organization_service import set_member_applications, validate_application_ids
from app.services.tenancy import OrgContext
from app.utils.time import utcnow


def _out(inv: Invitation, inviter_name: str | None = None) -> InvitationOut:
    role = Role(inv.role_key)
    status = inv.status
    if status == "pending" and inv.expires_at < utcnow():
        status = "expired"
    return InvitationOut(id=inv.id, email=inv.email, role=role.value, role_label=ROLE_LABELS[role],
                         application_ids=list(inv.application_ids or []), status=status, expires_at=inv.expires_at,
                         created_at=inv.created_at, invited_by_name=inviter_name)


def _send(inv: Invitation, org: Organization, inviter: User, token: str) -> None:
    url = f"{settings.FRONTEND_URL}/invite?token={quote(token)}"
    email = mail_templates.invitation_email(org.name, inviter.full_name, ROLE_LABELS[Role(inv.role_key)], url)
    enqueue_system_email("invitation", inv.email, None, email)


def create_invitation(db: Session, ctx: OrgContext, data: InvitationCreate) -> InvitationOut:
    ctx.require(Perm.MEMBERS_INVITE)
    if not can_assign(ctx.role, data.role):
        raise Forbidden("You cannot invite someone with a role higher than your own", code="ROLE_HIERARCHY")
    existing_member = db.scalar(
        select(OrganizationMember.id).join(User, User.id == OrganizationMember.user_id).where(
            OrganizationMember.organization_id == ctx.organization_id, User.email == data.email))
    if existing_member:
        raise Conflict("This person is already a member of the organization", code="ALREADY_MEMBER")
    app_ids = [] if data.role in ORG_WIDE_ROLES else validate_application_ids(
        db, ctx.organization_id, data.application_ids)
    if data.role not in ORG_WIDE_ROLES and not app_ids:
        raise ValidationFailed("Select at least one application for this role", code="APPLICATIONS_REQUIRED")
    # Supersede any older pending invite to the same address.
    for old in db.scalars(select(Invitation).where(Invitation.organization_id == ctx.organization_id,
                                                   Invitation.email == data.email, Invitation.status == "pending")):
        old.status = "revoked"
    token = generate_token()
    inv = Invitation(organization_id=ctx.organization_id, email=data.email, role_key=data.role.value,
                     application_ids=app_ids, token_hash=hash_token(token), invited_by_id=ctx.user.id,
                     expires_at=utcnow() + timedelta(days=settings.INVITATION_TTL_DAYS))
    db.add(inv)
    db.flush()
    audit_service.record(db, "invitation.created", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         target_type="invitation", target_id=inv.id,
                         summary=f"Invited {data.email} as {data.role.value}")
    db.commit()
    _send(inv, ctx.organization, ctx.user, token)
    return _out(inv, ctx.user.full_name)


def list_invitations(db: Session, ctx: OrgContext, include_inactive: bool = False) -> list[InvitationOut]:
    ctx.require(Perm.MEMBERS_READ)
    q = select(Invitation, User.full_name).outerjoin(User, User.id == Invitation.invited_by_id).where(
        Invitation.organization_id == ctx.organization_id)
    if not include_inactive:
        q = q.where(Invitation.status == "pending")
    return [_out(i, n) for i, n in db.execute(q.order_by(Invitation.created_at.desc())).all()]


def _get(db: Session, ctx: OrgContext, invitation_id: str) -> Invitation:
    inv = db.scalar(select(Invitation).where(Invitation.id == invitation_id,
                                             Invitation.organization_id == ctx.organization_id))
    if inv is None:
        raise NotFound("Invitation not found")
    return inv


def revoke_invitation(db: Session, ctx: OrgContext, invitation_id: str) -> None:
    ctx.require(Perm.MEMBERS_INVITE)
    inv = _get(db, ctx, invitation_id)
    if inv.status != "pending":
        raise Conflict("Only pending invitations can be revoked")
    inv.status = "revoked"
    audit_service.record(db, "invitation.revoked", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         target_type="invitation", target_id=inv.id)


def resend_invitation(db: Session, ctx: OrgContext, invitation_id: str) -> InvitationOut:
    ctx.require(Perm.MEMBERS_INVITE)
    inv = _get(db, ctx, invitation_id)
    if inv.status != "pending":
        raise Conflict("Only pending invitations can be resent")
    token = generate_token()
    inv.token_hash = hash_token(token)  # old link stops working
    inv.expires_at = utcnow() + timedelta(days=settings.INVITATION_TTL_DAYS)
    audit_service.record(db, "invitation.resent", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         target_type="invitation", target_id=inv.id)
    db.commit()
    _send(inv, ctx.organization, ctx.user, token)
    return _out(inv, ctx.user.full_name)


def _by_token(db: Session, token: str, lock: bool = False) -> Invitation:
    q = select(Invitation).where(Invitation.token_hash == hash_token(token))
    if lock:
        q = q.with_for_update()
    inv = db.scalar(q)
    if inv is None:
        raise NotFound("Invitation not found", code="INVALID_INVITATION")
    return inv


def preview(db: Session, token: str) -> InvitationPreview:
    inv = _by_token(db, token)
    org = db.get(Organization, inv.organization_id)
    status = "expired" if inv.status == "pending" and inv.expires_at < utcnow() else inv.status
    exists = db.scalar(select(func.count(User.id)).where(User.email == inv.email)) > 0
    role = Role(inv.role_key)
    return InvitationPreview(organization_name=org.name if org else "", email=inv.email, role=role.value,
                             role_label=ROLE_LABELS[role], expires_at=inv.expires_at, status=status,
                             account_exists=exists)


def accept(db: Session, user: User, token: str) -> Organization:
    inv = _by_token(db, token, lock=True)
    if inv.status != "pending" or inv.expires_at < utcnow():
        raise ValidationFailed("This invitation is no longer valid", code="INVALID_INVITATION")
    if inv.email.lower() != user.email.lower():
        raise Forbidden("This invitation was sent to a different email address", code="INVITATION_EMAIL_MISMATCH")
    org = db.get(Organization, inv.organization_id)
    if org is None or org.deleted_at is not None:
        raise NotFound("Organization not found")
    existing = db.scalar(select(OrganizationMember).where(
        OrganizationMember.organization_id == org.id, OrganizationMember.user_id == user.id))
    if existing is None:
        db.add(OrganizationMember(organization_id=org.id, user_id=user.id, role_key=inv.role_key,
                                  invited_by_id=inv.invited_by_id))
        if inv.role_key not in {r.value for r in ORG_WIDE_ROLES}:
            ids = validate_application_ids(db, org.id, list(inv.application_ids or [])) if inv.application_ids else []
            set_member_applications(db, org.id, user.id, ids)
    inv.status = "accepted"
    inv.accepted_at = utcnow()
    inv.accepted_by_id = user.id
    # Receiving the invite proves control of the inbox.
    if user.email_verified_at is None:
        user.email_verified_at = utcnow()
    user.last_organization_id = org.id
    user.last_application_id = None
    audit_service.record(db, "invitation.accepted", actor_user_id=user.id, organization_id=org.id,
                         target_type="invitation", target_id=inv.id)
    notify(db, inv.invited_by_id, type_="member_joined", level="success", title=f"{user.full_name} joined {org.name}",
           body=f"They accepted your invitation as {ROLE_LABELS[Role(inv.role_key)]}.",
           link=f"/orgs/{org.id}/team", organization_id=org.id)
    return org
