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
from app.models.email import EmailCampaign, EmailMessage
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
    ("automation_completed", "Completed workflows"), ("spend", "Spend"),
]


def _offset_minutes(tz_name: str | None) -> int:
    try:
        off = datetime.now(ZoneInfo(tz_name or "UTC")).utcoffset()
    except Exception:  # noqa: BLE001
        off = None
    return int(off.total_seconds() // 60) if off else 0


def _local_day(db: Session, col, minutes: int):
    """Date of a UTC timestamp shifted to local time, in SQL, for SQLite and MySQL."""
    if db.get_bind().dialect.name == "sqlite":
        return func.date(col, f"{minutes:+d} minutes")
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


def series(db: Session, ctx: AppContext, start: date | None, end: date | None) -> dict:
    ctx.require(Perm.ANALYTICS_READ)
    app_id = ctx.application_id
    tz = ctx.application.timezone if ctx.application else "UTC"
    start, end = _range(start, end, tz)
    minutes = _offset_minutes(tz)
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
    t = WalletTransaction
    count("spend", t, t.created_at, t.type == "usage", agg=-func.coalesce(func.sum(t.amount), 0))

    totals = {k: round(sum(data[d][k] for d in days), 2) for k, _ in METRICS}

    def rate(n, d):
        return round(100 * n / d, 1) if d else None

    from app.services.billing.wallet import get_wallet

    currency = get_wallet(db, ctx.organization_id).currency
    return {
        "start": start.isoformat(), "end": end.isoformat(), "timezone": tz, "currency": currency,
        "metrics": [{"key": k, "label": label} for k, label in METRICS],
        "points": [{"date": d, **{k: round(val, 2) for k, val in data[d].items()}} for d in days],
        "totals": totals,
        "rates": {
            "email_delivery": rate(totals["email_delivered"], totals["email_sent"]),
            "email_open": rate(totals["email_opened"], totals["email_delivered"]),
            "email_click": rate(totals["email_clicked"], totals["email_delivered"]),
            "sms_delivery": rate(totals["sms_delivered"], totals["sms_sent"]),
            "voice_answer": rate(totals["voice_answered"], totals["voice_calls"]),
            "automation_completion": rate(totals["automation_completed"], totals["automation_entered"]),
        },
        "top_campaigns": top_campaigns(db, app_id, lo, hi),
        "workflows": top_workflows(db, app_id, lo, hi),
    }


def top_campaigns(db: Session, app_id: str, lo: datetime, hi: datetime, limit: int = 8) -> list[dict]:
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
            rows.append({"channel": channel, "id": cid, "name": name, "automation": status == "automation",
                         "sent": n, "engaged": good, "engaged_label": good_label,
                         "rate": round(100 * good / n, 1) if n else None})
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
    return out.getvalue()
