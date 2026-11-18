"""Application dashboard data. Everything is computed from database records.

Channel KPIs (campaigns, messages) are added as their modules land; until then the dashboard
reports only what exists, and the API marks unavailable modules explicitly rather than
returning placeholder numbers."""
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.permissions import ORG_WIDE_ROLES, Perm, Role
from app.models import ApplicationMember, AuditLog, Invitation, OrganizationMember, Segment, User
from app.models.email import EmailCampaign
from app.services.audience import overview as audience_overview
from app.services.email import campaigns as email_campaigns
from app.services.tenancy import AppContext
from app.utils.time import utcnow


def overview(db: Session, ctx: AppContext) -> dict:
    ctx.require(Perm.APP_READ)
    org_id, app_id = ctx.organization_id, ctx.application_id

    org_wide = db.scalar(select(func.count(OrganizationMember.id)).where(
        OrganizationMember.organization_id == org_id,
        OrganizationMember.role_key.in_([r.value for r in ORG_WIDE_ROLES]))) or 0
    explicit = db.scalar(select(func.count(ApplicationMember.id)).where(
        ApplicationMember.application_id == app_id)) or 0
    org_members = db.scalar(select(func.count(OrganizationMember.id)).where(
        OrganizationMember.organization_id == org_id)) or 0
    pending_invites = db.scalar(select(func.count(Invitation.id)).where(
        Invitation.organization_id == org_id, Invitation.status == "pending", Invitation.expires_at > utcnow())) or 0

    activity_rows = db.execute(
        select(AuditLog, User.full_name).outerjoin(User, User.id == AuditLog.actor_user_id)
        .where(AuditLog.organization_id == org_id,
               (AuditLog.application_id == app_id) | (AuditLog.application_id.is_(None)))
        .order_by(AuditLog.created_at.desc()).limit(10)
    ).all()

    audience = audience_overview.overview(db, ctx) if ctx.has(Perm.AUDIENCE_READ) else None
    if audience is None:
        audience = {"total": 0}
    segment_count = db.scalar(select(func.count(Segment.id)).where(Segment.application_id == app_id)) or 0
    email = email_campaigns.overview(db, ctx) if ctx.has(Perm.CAMPAIGNS_READ) else None
    email_sent = db.scalar(select(func.count(EmailCampaign.id)).where(
        EmailCampaign.application_id == app_id, EmailCampaign.launched_at.is_not(None))) or 0

    checklist = [
        {"key": "verify_email", "label": "Verify your email address", "done": ctx.user.email_verified},
        {"key": "create_application", "label": "Create your first application", "done": True},
        {"key": "invite_team", "label": "Invite a teammate", "done": org_members > 1 or pending_invites > 0,
         "available": ctx.has(Perm.MEMBERS_INVITE)},
        {"key": "import_contacts", "label": "Import your contacts", "done": audience["total"] > 0,
         "available": ctx.has(Perm.AUDIENCE_WRITE)},
        {"key": "create_segment", "label": "Create a segment", "done": segment_count > 0,
         "available": ctx.has(Perm.AUDIENCE_WRITE)},
        {"key": "first_campaign", "label": "Send your first email campaign", "done": email_sent > 0,
         "available": ctx.has(Perm.CAMPAIGNS_WRITE)},
    ]

    return {
        "application": {"id": ctx.application.id, "name": ctx.application.name, "timezone": ctx.application.timezone,
                        "created_at": ctx.application.created_at},
        "your_role": ctx.role.value,
        "team": {"with_access": org_wide + explicit, "organization_members": org_members,
                 "pending_invitations": pending_invites},
        "checklist": checklist,
        "recent_activity": [
            {"id": log.id, "action": log.action, "summary": log.summary, "actor_name": name,
             "created_at": log.created_at}
            for log, name in activity_rows
        ],
        # Modules whose metrics will appear here once implemented (see DEVELOPMENT_STATUS.md).
        "audience": audience if ctx.has(Perm.AUDIENCE_READ) else None,
        "segment_count": segment_count,
        "email": email,
        "modules": {"audience": True, "email": True, "sms": False, "voice": False, "analytics": False,
                    "billing": False},
        "is_org_wide_role": Role(ctx.role) in ORG_WIDE_ROLES,
    }
