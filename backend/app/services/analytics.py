"""Cross-channel analytics for one application, computed from the message, call, run and ledger
records. Days are the application's local days (its time zone's current UTC offset)."""
import csv
import io
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import case, func, select, text
from sqlalchemy.orm import Session

from app.core.errors import ValidationFailed
from app.core.permissions import Perm
from app.models.automation import Workflow, WorkflowRun
from app.models.billing import WalletTransaction
from app.models.chat import ChatConversation
from app.models.email import EmailCampaign, EmailMessage
from app.models.forms import LeadFormDailyStat
from app.models.sms import SmsCampaign, SmsMessage
from app.models.voice import VoiceCall, VoiceCampaign
from app.services.tenancy import AppContext
from app.utils.time import utcnow

MAX_DAYS = 366
METRICS = [
    ("email_sent", "Emails sent"), ("email_delivered", "Emails delivered"), ("email_opened", "Unique opens"),
    ("email_clicked", "Unique clicks"), ("email_bounced", "Bounces"), ("email_unsubscribed", "Email unsubscribes"),
    ("sms_sent", "Texts sent"), ("sms_delivered", "Texts delivered"), ("sms_failed", "Texts not delivered"),
    ("voice_calls", "Calls finished"), ("voice_answered", "Calls answered"), ("voice_minutes", "Billable minutes"),
    ("voice_opt_outs", "Pressed 9"), ("automation_entered", "Entered workflows"),
    ("automation_completed", "Completed workflows"),
    ("form_views", "Form views"), ("form_submissions", "Form submissions"),
    ("chat_conversations", "Chat conversations"), ("chat_leads", "Leads from chat"),
    ("chat_ai_replies", "AI chat replies"), ("chat_bot_resolved", "Resolved by the bot"),
    ("spend", "Spend"),
]


def _offset_minutes(tz_name: str | None) -> int:
    try:
        off = datetime.now(ZoneInfo(tz_name or "UTC")).utcoffset()
    except Exception:  # noqa: BLE001
        off = None
    return int(off.total_seconds() // 60) if off else 0


def _local_day(db: Session, col, minutes: int):
    """Date of a UTC timestamp shifted to local time, in SQL."""
    return func.date(func.date_add(col, text(f"INTERVAL {int(minutes)} MINUTE")))


def _range(start: date | None, end: date | None, tz: str | None) -> tuple[date, date]:
    today = (utcnow() + timedelta(minutes=_offset_minutes(tz))).date()
    end = end or today
    start = start or (end - timedelta(days=29))
    if start > end:
        raise ValidationFailed("The start date must be before the end date", code="INVALID_RANGE")
    if (end - start).days >= MAX_DAYS:
        raise ValidationFailed("Choose a range of up to one year", code="INVALID_RANGE")
    return start, end


def _bounds(start: date, end: date, minutes: int) -> tuple[datetime, datetime]:
    from datetime import UTC

    lo = datetime.combine(start, datetime.min.time(), tzinfo=UTC) - timedelta(minutes=minutes)
    hi = datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=UTC) - timedelta(minutes=minutes)
    return lo, hi


# Metrics compared with the previous period of the same length.
COMPARED = ("email_sent", "email_opened", "email_clicked", "sms_sent", "sms_delivered", "voice_calls",
            "voice_answered", "automation_entered", "automation_completed", "form_views", "form_submissions",
            "chat_conversations", "chat_leads", "chat_ai_replies", "chat_bot_resolved", "spend")


def series(db: Session, ctx: AppContext, start: date | None, end: date | None, rank: str = "volume") -> dict:
    ctx.require(Perm.ANALYTICS_READ)
    app_id = ctx.application_id
    tz = ctx.application.timezone if ctx.application else "UTC"
    start, end = _range(start, end, tz)
    minutes = _offset_minutes(tz)
    lo, hi = _bounds(start, end, minutes)
    days, data = _collect(db, app_id, start, end, minutes)
    totals = {k: round(sum(data[d][k] for d in days), 2) for k, _ in METRICS}
    length = (end - start).days + 1
    p_start, p_end = start - timedelta(days=length), start - timedelta(days=1)
    p_days, p_data = _collect(db, app_id, p_start, p_end, minutes)
    previous = {k: round(sum(p_data[d][k] for d in p_days), 2) for k, _ in METRICS}

    def change(k: str) -> float | None:
        return round(100 * (totals[k] - previous[k]) / previous[k], 1) if previous[k] else None

    def rate(n, d):
        return round(100 * n / d, 1) if d else None

    from app.services.billing.wallet import get_wallet

    currency = get_wallet(db, ctx.organization_id).currency
    p_lo, p_hi = _bounds(p_start, p_end, minutes)
    crm = crm_block(db, ctx, lo, hi, p_lo, p_hi) if ctx.has(Perm.CRM_READ) else None
    return {
        "start": start.isoformat(), "end": end.isoformat(), "timezone": tz, "currency": currency,
        "metrics": [{"key": k, "label": label} for k, label in METRICS],
        "points": [{"date": d, **{k: round(val, 2) for k, val in data[d].items()}} for d in days],
        "totals": totals,
        "previous": {"start": p_start.isoformat(), "end": p_end.isoformat(), "totals": previous},
        "changes": {k: change(k) for k in COMPARED},
        "rates": {
            "email_delivery": rate(totals["email_delivered"], totals["email_sent"]),
            "email_open": rate(totals["email_opened"], totals["email_delivered"]),
            "email_click": rate(totals["email_clicked"], totals["email_delivered"]),
            "sms_delivery": rate(totals["sms_delivered"], totals["sms_sent"]),
            "voice_answer": rate(totals["voice_answered"], totals["voice_calls"]),
            "automation_completion": rate(totals["automation_completed"], totals["automation_entered"]),
            # Same definitions as the lead-form report (submissions / views) and chat analytics (conversations
            # without a hand-off to a person are bot-resolved).
            "form_conversion": rate(totals["form_submissions"], totals["form_views"]),
            "chat_bot_resolved": rate(totals["chat_bot_resolved"], totals["chat_conversations"]),
            "chat_lead": rate(totals["chat_leads"], totals["chat_conversations"]),
        },
        "previous_rates": {
            "form_conversion": rate(previous["form_submissions"], previous["form_views"]),
            "chat_bot_resolved": rate(previous["chat_bot_resolved"], previous["chat_conversations"]),
            "chat_lead": rate(previous["chat_leads"], previous["chat_conversations"]),
        },
        "top_campaigns": top_campaigns(db, app_id, lo, hi, rank=rank),
        "workflows": top_workflows(db, app_id, lo, hi),
        "crm": crm,
        "setup": setup_state(db, app_id),
    }


def setup_state(db: Session, app_id: str) -> dict:
    """What the application has set up, for the empty state's next steps."""
    from app.models.email import EmailSender

    sender = db.scalar(select(EmailSender.id).where(EmailSender.application_id == app_id,
                                                    EmailSender.status == "verified").limit(1))
    sent = any(db.scalar(select(m.id).where(m.application_id == app_id, col.is_not(None)).limit(1))
               for m, col in ((EmailMessage, EmailMessage.accepted_at), (SmsMessage, SmsMessage.accepted_at),
                              (VoiceCall, VoiceCall.ended_at)))
    workflow = db.scalar(select(Workflow.id).where(Workflow.application_id == app_id).limit(1))
    return {"sender_verified": bool(sender), "campaign_sent": bool(sent), "workflow_created": bool(workflow)}


def crm_block(db: Session, ctx: AppContext, lo: datetime, hi: datetime, p_lo: datetime, p_hi: datetime) -> dict:
    """Deals created / won, won revenue and win rate in the period (and the previous one), plus the value of
    open deals now. Money is in the default pipeline's currency; deals in other currencies are left out."""
    from decimal import Decimal

    from app.models import Deal, Pipeline

    app_id = ctx.application_id
    p = db.scalar(select(Pipeline).where(Pipeline.application_id == app_id)
                  .order_by(Pipeline.is_default.desc(), Pipeline.position).limit(1))
    country = (getattr(ctx.application, "default_country", "") or "IN").upper()
    currency = p.currency if p else {"IN": "INR", "AE": "AED"}.get(country, "USD")

    def period(a: datetime, b: datetime) -> dict:
        created = db.scalar(select(func.count()).select_from(Deal).where(
            Deal.application_id == app_id, Deal.created_at >= a, Deal.created_at < b)) or 0
        rows = db.execute(select(Deal.status, func.count(), func.coalesce(func.sum(
            case((Deal.currency == currency, Deal.amount), else_=0)), 0)).where(
            Deal.application_id == app_id, Deal.status.in_(("won", "lost")), Deal.closed_at >= a, Deal.closed_at < b)
            .group_by(Deal.status)).all()
        by = {s: (n, Decimal(str(amt or 0))) for s, n, amt in rows}
        won, lost = by.get("won", (0, Decimal(0))), by.get("lost", (0, Decimal(0)))
        closed = won[0] + lost[0]
        return {"deals_created": created, "won": won[0], "lost": lost[0], "won_amount": float(round(won[1], 2)),
                "win_rate": round(100 * won[0] / closed, 1) if closed else None}

    now, before = period(lo, hi), period(p_lo, p_hi)
    open_value = db.scalar(select(func.coalesce(func.sum(Deal.amount), 0)).where(
        Deal.application_id == app_id, Deal.status == "open", Deal.currency == currency)) or 0
    open_count = db.scalar(select(func.count()).select_from(Deal).where(
        Deal.application_id == app_id, Deal.status == "open")) or 0

    def change(k: str) -> float | None:
        a, b = now[k] or 0, before[k] or 0
        return round(100 * (a - b) / b, 1) if b else None

    return {**now, "currency": currency, "pipeline_value": float(open_value), "open_deals": open_count,
            "previous": before, "changes": {k: change(k) for k in ("deals_created", "won", "won_amount", "win_rate")}}


def _collect(db: Session, app_id: str, start: date, end: date, minutes: int):
    lo, hi = _bounds(start, end, minutes)
    days = [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]
    data: dict[str, dict[str, float]] = {d: {k: 0 for k, _ in METRICS} for d in days}

    def count(metric: str, model, col, *where, agg=None) -> None:
        day = _local_day(db, col, minutes)
        value = agg if agg is not None else func.count()
        q = select(day, value).where(model.application_id == app_id, col >= lo, col < hi, *where).group_by(day)
        for d, n in db.execute(q):
            key = str(d)[:10]
            if key in data:
                data[key][metric] += float(n or 0)

    m = EmailMessage
    count("email_sent", m, m.accepted_at)
    count("email_delivered", m, m.delivered_at, m.bounced_at.is_(None))
    count("email_opened", m, m.first_opened_at)
    count("email_clicked", m, m.first_clicked_at)
    count("email_bounced", m, m.bounced_at)
    count("email_unsubscribed", m, m.unsubscribed_at)
    s = SmsMessage
    count("sms_sent", s, s.accepted_at)
    count("sms_delivered", s, s.delivered_at, s.status == "delivered")
    count("sms_failed", s, s.failed_at, s.status.in_(("undelivered", "failed")))
    v = VoiceCall
    finished = v.status.in_(("completed", "voicemail", "no_answer", "busy", "failed"))
    count("voice_calls", v, v.ended_at, finished)
    count("voice_answered", v, v.ended_at, v.status == "completed")
    count("voice_minutes", v, v.ended_at, finished, agg=func.coalesce(func.sum(v.billable_minutes), 0))
    count("voice_opt_outs", v, v.ended_at, v.opted_out.is_(True))
    r = WorkflowRun
    count("automation_entered", r, r.started_at)
    count("automation_completed", r, r.finished_at, r.status == "completed")
    # Lead forms: the same per-form daily counters the form report reads (kept per UTC day).
    fs = LeadFormDailyStat
    for d, views, subs in db.execute(
            select(fs.day, func.coalesce(func.sum(fs.views), 0), func.coalesce(func.sum(fs.submissions), 0))
            .where(fs.application_id == app_id, fs.day >= start, fs.day <= end).group_by(fs.day)):
        key = str(d)[:10]
        if key in data:
            data[key]["form_views"] += float(views or 0)
            data[key]["form_submissions"] += float(subs or 0)
    # Chat: conversations where the visitor wrote something (as in chat analytics).
    cc = ChatConversation
    real = cc.visitor_messages > 0
    count("chat_conversations", cc, cc.created_at, real)
    count("chat_bot_resolved", cc, cc.created_at, real, cc.handoff_requested_at.is_(None))
    count("chat_ai_replies", cc, cc.created_at, real, agg=func.coalesce(func.sum(cc.ai_replies), 0))
    count("chat_leads", cc, cc.lead_captured_at)
    t = WalletTransaction
    count("spend", t, t.created_at, t.type == "usage", agg=-func.coalesce(func.sum(t.amount), 0))
    return days, data


def top_campaigns(db: Session, app_id: str, lo: datetime, hi: datetime, limit: int = 8,
                  rank: str = "volume") -> list[dict]:
    # Hidden automation campaigns map back to the workflow step that owns them.
    owners: dict[str, tuple[str, str]] = {}
    for wid, mapping in db.execute(select(Workflow.id, Workflow.node_campaigns).where(
            Workflow.application_id == app_id)):
        for node_id, cid in (mapping or {}).items():
            owners[cid] = (wid, node_id)
    rows = []
    for channel, camp, msg, sent_col, good_col, good_label in (
            ("email", EmailCampaign, EmailMessage, EmailMessage.accepted_at, EmailMessage.first_opened_at, "opened"),
            ("sms", SmsCampaign, SmsMessage, SmsMessage.accepted_at, SmsMessage.delivered_at, "delivered"),
            ("voice", VoiceCampaign, VoiceCall, VoiceCall.ended_at, VoiceCall.answered_at, "answered")):
        q = (select(camp.id, camp.name, camp.status, func.count(msg.id), func.count(good_col))
             .join(msg, msg.campaign_id == camp.id)
             .where(camp.application_id == app_id, sent_col >= lo, sent_col < hi)
             .group_by(camp.id, camp.name, camp.status))
        for cid, name, status, n, good in db.execute(q):
            wid, node_id = owners.get(cid, (None, None)) if status == "automation" else (None, None)
            rows.append({"channel": channel, "id": cid, "name": name, "automation": status == "automation",
                         "workflow_id": wid, "node_id": node_id,
                         "sent": n, "engaged": good, "engaged_label": good_label,
                         "rate": round(100 * good / n, 1) if n else None})
    if rank == "rate":
        # Engagement rate, ignoring tiny sends that make rates noisy unless nothing else exists.
        big = [r for r in rows if r["sent"] >= 10] or rows
        return sorted(big, key=lambda x: (-(x["rate"] or 0), -x["sent"]))[:limit]
    return sorted(rows, key=lambda x: -x["sent"])[:limit]


def top_workflows(db: Session, app_id: str, lo: datetime, hi: datetime) -> list[dict]:
    q = (select(Workflow.id, Workflow.name, Workflow.status, func.count(WorkflowRun.id),
                func.sum(case((WorkflowRun.status == "completed", 1), else_=0)))
         .join(WorkflowRun, WorkflowRun.workflow_id == Workflow.id)
         .where(Workflow.application_id == app_id, WorkflowRun.started_at >= lo, WorkflowRun.started_at < hi)
         .group_by(Workflow.id, Workflow.name, Workflow.status).order_by(func.count(WorkflowRun.id).desc()).limit(8))
    return [{"id": i, "name": n, "status": s, "entered": e, "completed": int(c or 0)} for i, n, s, e, c in db.execute(q)]


def export_csv(db: Session, ctx: AppContext, start: date | None, end: date | None) -> str:
    data = series(db, ctx, start, end)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["date"] + [k if k != "spend" else f"spend_{data['currency']}" for k, _ in METRICS])
    for p in data["points"]:
        w.writerow([p["date"]] + [p[k] for k, _ in METRICS])
    w.writerow(["total"] + [data["totals"][k] for k, _ in METRICS])
    prev = data["previous"]
    w.writerow([f"previous_period_total ({prev['start']} to {prev['end']})"] + [prev["totals"][k] for k, _ in METRICS])
    w.writerow([])
    w.writerow(["rate", "percent", "previous_period_percent"])
    for k, v in data["rates"].items():
        w.writerow([f"{k}_pct", "" if v is None else v,
                    "" if data["previous_rates"].get(k) is None else data["previous_rates"][k]])
    return out.getvalue()
