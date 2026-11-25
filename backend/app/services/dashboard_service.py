"""Application dashboard data. Everything is computed from database records.

The getting-started checklist is derived from real setup records (senders, registrations,
workflows, deals) and ordered by dependency, so a new user always has a next step."""
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.permissions import ORG_WIDE_ROLES, Perm, Role
from app.models import (
    ApplicationMember,
    AuditLog,
    Contact,
    Deal,
    Invitation,
    OrganizationMember,
    Segment,
    User,
    Workflow,
)
from app.models.email import EmailCampaign, EmailMessage, EmailSender
from app.models.forms import LeadForm
from app.models.sms import SmsDltConfiguration, SmsMessage, SmsSender, SmsTemplate
from app.models.voice import VoiceCall
from app.services.audience import overview as audience_overview
from app.services.email import campaigns as email_campaigns
from app.services.tenancy import AppContext
from app.utils.time import utcnow


def _count(db: Session, model, *where) -> int:
    return db.scalar(select(func.count()).select_from(model).where(*where)) or 0


def sms_setup(db: Session, application_id: str, country: str | None) -> dict:
    """SMS readiness for the application's market and the next missing step.

    India needs an attested DLT registration, an approved sender ID (header) and a template with a
    DLT template ID. The US needs an attested 10DLC brand/campaign and an active number. Elsewhere an
    active sender is enough."""
    base = f"/apps/{application_id}/sms"
    dlt = db.scalar(select(SmsDltConfiguration).where(SmsDltConfiguration.application_id == application_id))
    active_senders = _count(db, SmsSender, SmsSender.application_id == application_id, SmsSender.status == "active")
    country = (country or "").upper()
    if country == "IN":
        steps = [
            ("DLT registration", bool(dlt and dlt.principal_entity_id and dlt.attested_at), f"{base}/registration"),
            ("approved sender ID", active_senders > 0, f"{base}/senders"),
            ("DLT template", _count(db, SmsTemplate, SmsTemplate.application_id == application_id,
                                    SmsTemplate.dlt_template_id.is_not(None)) > 0, f"{base}/templates"),
        ]
        label = "Set up SMS for India (DLT registration, sender ID, template)"
    elif country == "US":
        steps = [
            ("10DLC registration", bool(dlt and dlt.us_brand_id and dlt.attested_at), f"{base}/registration"),
            ("active sending number", active_senders > 0, f"{base}/senders"),
        ]
        label = "Set up SMS for the US (10DLC registration and a number)"
    else:
        steps = [("active sender", active_senders > 0, f"{base}/senders")]
        label = "Add an SMS sender"
    missing = [s for s in steps if not s[1]]
    return {
        "label": label,
        "done": not missing,
        "href": missing[0][2] if missing else f"{base}/senders",
        "detail": f"Next: {missing[0][0]}" if missing else None,
        "steps": [{"label": s[0], "done": s[1], "href": s[2]} for s in steps],
    }


def voice_ready(db: Session, application_id: str, country: str | None) -> bool:
    """Calls come from Signalcraft-managed numbers, so voice is ready once Indian apps have DLT registration."""
    if country != "IN":
        return True
    from app.services.sms.registration import dlt_row

    reg = dlt_row(db, application_id)
    return bool(reg and reg.principal_entity_id and reg.attested_at)


def _target_href(app_id: str, org_id: str, action: str, target_type: str | None, target_id: str | None) -> str | None:
    """Deep link to the record an audit entry is about, when it still exists in a page."""
    if not target_type or action.endswith((".deleted", "_deleted", ".removed", ".revoked", ".left")):
        return None
    a = f"/apps/{app_id}"
    tid = target_id or ""
    return {
        "email_campaign": f"{a}/email/campaigns/{tid}",
        "sms_campaign": f"{a}/sms/campaigns/{tid}",
        "voice_campaign": f"{a}/voice/campaigns/{tid}",
        "workflow": f"{a}/automation/{tid}",
        "segment": f"{a}/audience/segments/{tid}",
        "list": f"{a}/audience/lists/{tid}",
        "contact": f"{a}/audience/contacts/{tid}",
        "import": f"{a}/audience/import/{tid}",
        "tag": f"{a}/audience/tags",
        "custom_field": f"{a}/audience/fields",
        "email_template": f"{a}/email/templates/{tid}",
        "email_sender": f"{a}/email/senders",
        "sms_sender": f"{a}/sms/senders",
        "sms_registration": f"{a}/sms/registration",
        "voice_agent": f"{a}/voice/agents/{tid}",
        "voice_audio": f"{a}/voice/audio",
        "crm_deal": f"{a}/crm/deals/{tid}",
        "crm_company": f"{a}/crm/companies/{tid}",
        "crm_pipeline": f"{a}/crm/settings",
        "crm_settings": f"{a}/crm/settings",
        "crm_assignment_rule": f"{a}/crm/settings",
        "crm_scoring_rule": f"{a}/crm/settings",
        "application": f"{a}/settings",
        "invitation": f"/orgs/{org_id}/team",
        "member": f"/orgs/{org_id}/team",
        "organization": f"/orgs/{org_id}/settings",
        "wallet": f"/orgs/{org_id}/billing",
        "payment": f"/orgs/{org_id}/billing",
    }.get(target_type)


def _live_chatbots(db: Session, app_id: str) -> int:
    from app.models.chat import ChatBot

    return _count(db, ChatBot, ChatBot.application_id == app_id, ChatBot.status == "live")


def _facts(db: Session, ctx: AppContext) -> dict:
    org_id, app_id = ctx.organization_id, ctx.application_id
    country = ctx.application.default_country or getattr(ctx.organization, "country", None)
    return {
        "org_members": _count(db, OrganizationMember, OrganizationMember.organization_id == org_id),
        "pending_invites": _count(db, Invitation, Invitation.organization_id == org_id,
                                  Invitation.status == "pending", Invitation.expires_at > utcnow()),
        "contacts": _count(db, Contact, Contact.application_id == app_id),
        "segments": _count(db, Segment, Segment.application_id == app_id),
        "verified_senders": _count(db, EmailSender, EmailSender.application_id == app_id,
                                   EmailSender.status == "verified"),
        "emails_launched": _count(db, EmailCampaign, EmailCampaign.application_id == app_id,
                                  EmailCampaign.launched_at.is_not(None)),
        "sms": sms_setup(db, app_id, country),
        "voice_ready": voice_ready(db, app_id, country),
        "workflows": _count(db, Workflow, Workflow.application_id == app_id),
        "deals": _count(db, Deal, Deal.application_id == app_id),
        "live_forms": _count(db, LeadForm, LeadForm.application_id == app_id, LeadForm.published_version.is_not(None)),
        "live_chatbots": _live_chatbots(db, app_id),
    }


def checklist(db: Session, ctx: AppContext, facts: dict | None = None) -> list[dict]:
    """Getting-started steps in dependency order, computed from real records. `available` is False
    when the viewer's role cannot do the step (the UI then says to ask an admin)."""
    ctx.require(Perm.APP_READ)
    f = facts or _facts(db, ctx)
    a = f"/apps/{ctx.application_id}"
    sms = f["sms"]

    def item(key, label, done, href, cta, perm, optional=False, detail=None):
        return {"key": key, "label": label, "done": bool(done), "href": href, "cta": cta,
                "available": ctx.has(perm), "optional": optional, "detail": detail}

    return [
        item("invite_team", "Invite a teammate", f["org_members"] > 1 or f["pending_invites"] > 0,
             f"/orgs/{ctx.organization_id}/team?invite=1", "Invite", Perm.MEMBERS_INVITE, optional=True),
        item("import_contacts", "Import or add your contacts", f["contacts"] > 0,
             f"{a}/audience/import", "Import", Perm.AUDIENCE_WRITE),
        item("lead_form", "Add a lead form to your website", f["live_forms"] > 0,
             f"{a}/forms", "Create form", Perm.FORMS_WRITE),
        item("verify_sender", "Verify an email sender", f["verified_senders"] > 0,
             f"{a}/email/senders", "Add sender", Perm.SETTINGS_WRITE),
        item("first_email", "Send your first email campaign", f["emails_launched"] > 0,
             f"{a}/email/campaigns", "Create campaign", Perm.CAMPAIGNS_WRITE),
        item("sms_setup", sms["label"], sms["done"], sms["href"], "Set up SMS", Perm.SETTINGS_WRITE,
             detail=sms["detail"]),
        item("first_workflow", "Build your first workflow", f["workflows"] > 0,
             f"{a}/automation", "Build workflow", Perm.AUTOMATION_WRITE),
        item("first_deal", "Add your first deal", f["deals"] > 0,
             f"{a}/crm/deals", "Add deal", Perm.CRM_WRITE),
        item("add_chatbot", "Add a chatbot to your website", f.get("live_chatbots", 0) > 0,
             f"{a}/chat/bots", "Add chatbot", Perm.CHAT_WRITE, optional=True),
        item("create_segment", "Create a segment", f["segments"] > 0,
             f"{a}/audience/segments/new", "Create", Perm.AUDIENCE_WRITE, optional=True),
    ]


def overview(db: Session, ctx: AppContext) -> dict:
    ctx.require(Perm.APP_READ)
    org_id, app_id = ctx.organization_id, ctx.application_id
    a = f"/apps/{app_id}"
    since = utcnow() - timedelta(days=30)

    org_wide = db.scalar(select(func.count(OrganizationMember.id)).where(
        OrganizationMember.organization_id == org_id,
        OrganizationMember.role_key.in_([r.value for r in ORG_WIDE_ROLES]))) or 0
    explicit = db.scalar(select(func.count(ApplicationMember.id)).where(
        ApplicationMember.application_id == app_id)) or 0

    activity_rows = db.execute(
        select(AuditLog, User.full_name).outerjoin(User, User.id == AuditLog.actor_user_id)
        .where(AuditLog.organization_id == org_id,
               (AuditLog.application_id == app_id) | (AuditLog.application_id.is_(None)))
        .order_by(AuditLog.created_at.desc()).limit(10)
    ).all()

    audience = audience_overview.overview(db, ctx) if ctx.has(Perm.AUDIENCE_READ) else None
    email = email_campaigns.overview(db, ctx) if ctx.has(Perm.CAMPAIGNS_READ) else None
    facts = _facts(db, ctx)
    items = checklist(db, ctx, facts)
    sms = facts["sms"]

    channels = {
        "audience": {"count_30d": _count(db, Contact, Contact.application_id == app_id, Contact.created_at >= since),
                     "ready": facts["contacts"] > 0, "setup_href": f"{a}/audience/import"},
        "email": {"count_30d": _count(db, EmailMessage, EmailMessage.application_id == app_id,
                                      EmailMessage.created_at >= since),
                  "ready": facts["verified_senders"] > 0, "setup_href": f"{a}/email/senders"},
        "sms": {"count_30d": _count(db, SmsMessage, SmsMessage.application_id == app_id,
                                    SmsMessage.created_at >= since),
                "ready": sms["done"], "setup_href": sms["href"]},
        "voice": {"count_30d": _count(db, VoiceCall, VoiceCall.application_id == app_id,
                                      VoiceCall.created_at >= since),
                  "ready": facts["voice_ready"], "setup_href": f"{a}/voice"},
    }

    return {
        "application": {"id": ctx.application.id, "name": ctx.application.name, "timezone": ctx.application.timezone,
                        "created_at": ctx.application.created_at},
        "your_role": ctx.role.value,
        "team": {"with_access": org_wide + explicit, "organization_members": facts["org_members"],
                 "pending_invitations": facts["pending_invites"]},
        "checklist": items,
        "recent_activity": [
            {"id": log.id, "action": log.action, "summary": log.summary, "actor_name": name,
             "target_type": log.target_type, "target_id": log.target_id,
             "href": _target_href(app_id, org_id, log.action, log.target_type, log.target_id),
             "created_at": log.created_at}
            for log, name in activity_rows
        ],
        "audience": audience,
        "segment_count": facts["segments"],
        "email": email,
        "channels": channels,
        "modules": {"audience": True, "email": True, "sms": True, "voice": True, "analytics": True,
                    "billing": True, "automation": True, "crm": True},
        "is_org_wide_role": Role(ctx.role) in ORG_WIDE_ROLES,
    }
