"""Workflow send steps reuse the channel engines.

Each email / SMS / call step owns a hidden campaign (status "automation") holding the step's content,
frozen when the workflow is published. Sending to one contact creates that campaign's message for
the contact and runs it through the same send function campaigns use, so consent, suppression,
quiet hours, calling windows, tracking, receipts and opt-outs behave identically. A contact gets each
step's message at most once (unique per campaign and contact).
"""
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Application, ApplicationSettings, Contact, Organization
from app.models.email import EmailCampaign, EmailMessage, EmailSender
from app.models.sms import SmsCampaign, SmsMessage, SmsSender, SmsTemplate
from app.models.voice import VoiceCall, VoiceCampaign
from app.services.automation.graph import data, label
from app.utils.time import utcnow

AUTOMATION = "automation"


@dataclass
class SendResult:
    outcome: str  # done|skipped|waiting|failed
    detail: str
    retry_at: datetime | None = None


# ------------------------------------------------------------------ hidden campaigns


def _common(wf, node) -> dict:
    return {"organization_id": wf.organization_id, "application_id": wf.application_id,
            "name": f"{wf.name} · {label(node)}"[:160], "created_by_id": wf.created_by_id}


def upsert_campaign(db: Session, wf, node: dict):
    """Create or refresh the hidden campaign for a send step from the step's settings."""
    from app.services.email.render import extract_links
    from app.services.email.templates import _get as email_template  # noqa: F401  (validated separately)

    kind, d = node["type"], data(node)
    existing_id = (wf.node_campaigns or {}).get(node["id"])
    model = {"send_email": EmailCampaign, "send_sms": SmsCampaign, "voice_call": VoiceCampaign}[kind]
    c = db.get(model, existing_id) if existing_id else None
    if c is None or c.application_id != wf.application_id:
        extra = {"audience": {}, "status": AUTOMATION}
        if kind != "send_email":
            extra.update(excluded={})
        if kind == "send_sms":
            extra.update(sender_snapshot={})
        if kind == "voice_call":
            extra.update(snapshot={})
        c = model(**_common(wf, node), **extra)
        db.add(c)
    c.name, c.status = _common(wf, node)["name"], AUTOMATION
    if kind == "send_email":
        from app.models.email import EmailTemplate

        t = db.get(EmailTemplate, d.get("template_id")) if d.get("template_id") else None
        s = db.get(EmailSender, d.get("sender_id")) if d.get("sender_id") else None
        c.sender_id = s.id if s and s.application_id == wf.application_id else None
        c.from_name, c.from_email, c.reply_to = (s.from_name, s.from_email, s.reply_to) if c.sender_id else (None, None, None)
        if t and t.application_id == wf.application_id:
            c.subject = (d.get("subject") or "").strip() or t.subject
            c.preheader, c.editor, c.design, c.html, c.text = t.preheader, t.editor, t.design, t.html, t.text
        else:
            c.subject = c.html = c.text = None
        c.links = extract_links(c.html)
        c.track_opens = c.track_clicks = True
        c.launched_at = c.launched_at or utcnow()
    elif kind == "send_sms":
        c.category = d.get("category") or "promotional"
        c.sender_ref = d.get("sender_ref") or None
        c.template_id = d.get("template_id") or None
        t = db.get(SmsTemplate, c.template_id) if c.template_id else None
        c.body = (d.get("body") or (t.body if t else "") or "").strip() or None
        c.append_opt_out = d.get("append_opt_out", True) is not False
        c.launched_at = c.launched_at or utcnow()
    else:
        c.category = d.get("category") or "promotional"
        c.audio_id = d.get("audio_id") or None
        intro = d.get("intro_text")
        c.intro_text = intro if intro is not None else c.intro_text
        c.opt_out_keypress = d.get("opt_out_keypress", True) is not False
        c.max_attempts, c.retry_delay_minutes = 1, 60
        c.launched_at = c.launched_at or utcnow()
    db.flush()
    return c


def freeze(db: Session, wf, node: dict, c) -> None:
    """Snapshot provider-facing details at publish time (after validation passed)."""
    from app.providers.sms.factory import provider_for as sms_provider
    from app.services.sms import rules as sms_rules
    from app.services.sms.registration import dlt_row
    from app.services.voice.campaigns import draft_snapshot

    if node["type"] == "send_email":
        from app.services.email.engine import provider_for

        s = db.scalar(select(ApplicationSettings).where(ApplicationSettings.application_id == wf.application_id))
        c.provider = provider_for(s)[1]
    elif node["type"] == "send_sms":
        sender = db.get(SmsSender, c.sender_ref)
        t = db.get(SmsTemplate, c.template_id) if c.template_id else None
        reg = dlt_row(db, wf.application_id)
        c.provider = sms_provider(sender.provider)[1]
        c.currency = sms_rules.price(sender.country, c.category)[1]
        c.sender_snapshot = {
            "sender_id": sender.sender_id, "country": sender.country, "kind": sender.kind, "provider": sender.provider,
            "dlt_header_id": sender.dlt_header_id, "dlt_template_id": t.dlt_template_id if t else None,
            "principal_entity_id": reg.principal_entity_id if reg else None,
        }
    else:
        from app.core.config import settings
        from app.services.voice import rules as voice_rules

        # No caller to freeze: each call picks a Signalcraft number (and so its provider) at dial time.
        c.snapshot = draft_snapshot(db, c)
        c.provider = "auto" if settings.COMMUNICATION_MODE == "live" else "simulation"
        c.currency = voice_rules.price_per_minute((c.snapshot or {}).get("country") or None)[1]
    db.flush()


# ------------------------------------------------------------------ sending to one contact


def _app_bits(db: Session, application_id: str):
    app = db.get(Application, application_id)
    s = db.scalar(select(ApplicationSettings).where(ApplicationSettings.application_id == application_id))
    return app, s, ((s.quiet_hours_start, s.quiet_hours_end) if s else ("21:00", "09:00"))


def send_email(db: Session, campaign: EmailCampaign, contact: Contact) -> SendResult:
    from app.services.email import engine

    if not contact.email:
        return SendResult("skipped", "No email address")
    m = db.scalar(select(EmailMessage).where(EmailMessage.campaign_id == campaign.id,
                                             EmailMessage.contact_id == contact.id))
    if m is not None and m.status not in ("queued",):
        return SendResult("done" if m.status not in ("skipped", "failed") else "skipped",
                          f"Already handled for this contact ({m.status})")
    if m is None:
        m = EmailMessage(organization_id=campaign.organization_id, application_id=campaign.application_id,
                         campaign_id=campaign.id, contact_id=contact.id, to_email=contact.email, status="sending",
                         attempts=0, open_count=0, click_count=0)
        db.add(m)
        db.flush()
    else:
        m.status = "sending"
    _, s, _ = _app_bits(db, campaign.application_id)
    provider, pname = engine.provider_for(s)
    org = db.get(Organization, campaign.organization_id)
    engine._send_batch(db, campaign, [m], provider, pname,
                       (s.business_name if s and s.business_name else org.name), s.business_address if s else None)
    return _result(m.status, m.error_message, getattr(m, "next_attempt_at", None))


def send_sms(db: Session, campaign: SmsCampaign, contact: Contact) -> SendResult:
    from app.core.config import settings
    from app.providers.sms.factory import provider_for
    from app.services.sms import engine

    if not settings.SMS_ENABLED:  # SMS is "coming soon": existing SMS steps are skipped safely
        return SendResult("skipped", "SMS is coming soon")
    snap = campaign.sender_snapshot or {}
    if not contact.phone:
        return SendResult("skipped", "No phone number")
    m = db.scalar(select(SmsMessage).where(SmsMessage.campaign_id == campaign.id, SmsMessage.contact_id == contact.id))
    if m is not None and m.status not in ("queued", "deferred"):
        return SendResult("done" if m.status not in ("skipped", "failed") else "skipped",
                          f"Already handled for this contact ({m.status})")
    if m is None:
        m = SmsMessage(organization_id=campaign.organization_id, application_id=campaign.application_id,
                       campaign_id=campaign.id, contact_id=contact.id, to_phone=contact.phone,
                       country=snap.get("country"), status="sending", attempts=0, segments=0)
        db.add(m)
        db.flush()
    else:
        m.status = "sending"
    app, _, quiet = _app_bits(db, campaign.application_id)
    provider, pname = provider_for(snap.get("provider"))
    engine._send_batch(db, campaign, app, quiet, [m], provider, pname)
    return _result(m.status, m.error_message or m.deferred_reason, m.next_attempt_at)


def voice_call(db: Session, campaign: VoiceCampaign, contact: Contact) -> SendResult:
    from app.services.voice import engine

    snap = campaign.snapshot or {}
    if not contact.phone:
        return SendResult("skipped", "No phone number")
    call = db.scalar(select(VoiceCall).where(VoiceCall.campaign_id == campaign.id, VoiceCall.contact_id == contact.id))
    if call is not None and call.status not in ("queued", "deferred"):
        return SendResult("done" if call.status not in ("skipped", "failed") else "skipped",
                          f"Already handled for this contact ({call.status})")
    if call is None:
        call = VoiceCall(organization_id=campaign.organization_id, application_id=campaign.application_id,
                         campaign_id=campaign.id, contact_id=contact.id, to_phone=contact.phone,
                         country=snap.get("country"), status="placing", attempts=0, duration_seconds=0,
                         billable_minutes=0, opted_out=False)
        db.add(call)
        db.flush()
    else:
        call.status = "placing"
    app, _, quiet = _app_bits(db, campaign.application_id)
    engine._place_batch(db, campaign, app, quiet, [call])
    return _result(call.status, call.error_message or call.deferred_reason, call.next_attempt_at)


def _result(status: str, detail: str | None, retry_at: datetime | None) -> SendResult:
    if status in ("queued", "deferred") and retry_at:
        return SendResult("waiting", detail or "Waiting to send", retry_at)
    if status == "skipped":
        return SendResult("skipped", detail or "Not eligible")
    if status == "failed":
        return SendResult("failed", detail or "Could not be sent")
    return SendResult("done", {"accepted": "Sent", "delivered": "Delivered", "sending": "Sent", "dialing": "Calling",
                               "completed": "Answered", "voicemail": "Voicemail"}.get(status, status.replace("_", " ")))


def engaged(db: Session, kind: str, campaign_id: str, contact_id: str, event: str) -> bool:
    """Did this contact receive / open / click / answer the message from a send step?"""
    if kind == "send_email":
        m = db.scalar(select(EmailMessage).where(EmailMessage.campaign_id == campaign_id,
                                                 EmailMessage.contact_id == contact_id))
        if m is None:
            return False
        return {"delivered": m.delivered_at is not None, "opened": m.first_opened_at is not None,
                "clicked": m.first_clicked_at is not None}.get(event, False)
    if kind == "send_sms":
        m = db.scalar(select(SmsMessage).where(SmsMessage.campaign_id == campaign_id, SmsMessage.contact_id == contact_id))
        return bool(m and event == "delivered" and m.status == "delivered")
    call = db.scalar(select(VoiceCall).where(VoiceCall.campaign_id == campaign_id, VoiceCall.contact_id == contact_id))
    if call is None:
        return False
    return {"answered": call.status == "completed", "delivered": call.status in ("completed", "voicemail")}.get(event, False)


def cost_of(value) -> float:
    return float(value or Decimal(0))
