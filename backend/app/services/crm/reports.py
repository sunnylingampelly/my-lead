"""CRM reports for one pipeline, in that pipeline's currency: weighted forecast by close month,
win/loss analysis with lost reasons, stage conversion, owner leaderboard and headline numbers.
Deals in another currency are counted separately and left out of money totals."""
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.permissions import Perm
from app.models import CrmActivity, CrmTask, Deal, DealStageHistory, LostReason, PipelineStage
from app.services.crm.common import ensure_defaults, user_ref, users_by_id
from app.services.crm.deals import _pipeline, _stages, effective_probability
from app.utils.time import utcnow


def _d(v) -> Decimal:
    return Decimal(str(v or 0)).quantize(Decimal("0.01"))


def _month(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    return date(d.year + m // 12, m % 12 + 1, 1)


def forecast(db: Session, ctx, pipeline_id: str | None, months: int = 6, owner_id: str | None = None) -> dict:
    ctx.require(Perm.CRM_READ)
    ensure_defaults(db, ctx)
    p = _pipeline(db, ctx, pipeline_id)
    stages = {s.id: s for s in _stages(db, p.id)}
    q = select(Deal).where(Deal.application_id == ctx.application_id, Deal.pipeline_id == p.id)
    if owner_id:
        q = q.where(Deal.owner_id == (ctx.user.id if owner_id == "me" else owner_id))
    today = utcnow().date()
    first = date(today.year, today.month, 1)
    keys = [_month(_add_months(first, i)) for i in range(months)]
    rows = {k: {"month": k, "deals": 0, "total": Decimal(0), "weighted": Decimal(0), "won": Decimal(0),
                "commit": Decimal(0), "best_case": Decimal(0)} for k in keys}
    overdue = {"deals": 0, "total": Decimal(0), "weighted": Decimal(0)}
    undated = {"deals": 0, "total": Decimal(0), "weighted": Decimal(0)}
    other_currency = 0
    for d in db.scalars(q.where(Deal.status.in_(("open", "won")))):
        if d.currency != p.currency:
            other_currency += 1
            continue
        amount = _d(d.amount)
        if d.status == "won":
            if d.closed_at and _month(d.closed_at.date()) in rows:
                rows[_month(d.closed_at.date())]["won"] += amount
            continue
        prob = effective_probability(d, stages[d.stage_id])
        weighted = _d(amount * prob / 100)
        if d.expected_close_date is None:
            bucket = undated
        elif d.expected_close_date < first:
            bucket = overdue
        else:
            bucket = rows.get(_month(d.expected_close_date))
            if bucket is None:
                continue
            # Commit = likely to close (>= 75%), best case = everything still open in the month.
            if prob >= 75:
                bucket["commit"] += amount
            bucket["best_case"] += amount
        bucket["deals"] += 1
        bucket["total"] += amount
        bucket["weighted"] += weighted
    return {"pipeline_id": p.id, "currency": p.currency, "months": list(rows.values()), "overdue": overdue,
            "no_close_date": undated, "other_currency_deals": other_currency}


def win_loss(db: Session, ctx, pipeline_id: str | None, days: int = 90) -> dict:
    ctx.require(Perm.CRM_READ)
    ensure_defaults(db, ctx)
    p = _pipeline(db, ctx, pipeline_id)
    since = utcnow() - timedelta(days=days)
    closed = list(db.scalars(select(Deal).where(Deal.application_id == ctx.application_id, Deal.pipeline_id == p.id,
                                                Deal.status.in_(("won", "lost")), Deal.closed_at >= since)))
    won = [d for d in closed if d.status == "won"]
    lost = [d for d in closed if d.status == "lost"]
    reasons = {r.id: r.name for r in db.scalars(select(LostReason).where(
        LostReason.application_id == ctx.application_id))}
    by_reason: dict[str, dict] = defaultdict(lambda: {"count": 0, "amount": Decimal(0)})
    for d in lost:
        r = by_reason[reasons.get(d.lost_reason_id or "", "No reason")]
        r["count"] += 1
        r["amount"] += _d(d.amount) if d.currency == p.currency else 0
    won_amount = sum((_d(d.amount) for d in won if d.currency == p.currency), Decimal(0))
    cycles = [(d.closed_at - d.created_at).days for d in won if d.closed_at]
    return {"pipeline_id": p.id, "currency": p.currency, "days": days, "won": len(won), "lost": len(lost),
            "win_rate": round(100 * len(won) / len(closed), 1) if closed else None,
            "won_amount": won_amount, "average_won_amount": _d(won_amount / len(won)) if won else Decimal(0),
            "average_cycle_days": round(sum(cycles) / len(cycles), 1) if cycles else None,
            "lost_reasons": sorted(({"reason": k, **v} for k, v in by_reason.items()), key=lambda x: -x["count"])}


def stage_conversion(db: Session, ctx, pipeline_id: str | None, days: int = 90) -> dict:
    """For deals created in the period: how many reached each stage, and the average days spent there."""
    ctx.require(Perm.CRM_READ)
    ensure_defaults(db, ctx)
    p = _pipeline(db, ctx, pipeline_id)
    stages = _stages(db, p.id)
    since = utcnow() - timedelta(days=days)
    deal_ids = select(Deal.id).where(Deal.application_id == ctx.application_id, Deal.pipeline_id == p.id,
                                     Deal.created_at >= since)
    spent = dict(db.execute(select(DealStageHistory.from_stage_id, func.avg(DealStageHistory.seconds_in_previous))
                            .where(DealStageHistory.deal_id.in_(deal_ids), DealStageHistory.from_stage_id.is_not(None))
                            .group_by(DealStageHistory.from_stage_id)).all())
    # Ordered funnel: open stages, then Won. A deal counts as having reached every stage up to the
    # furthest one it ever entered (deals can skip stages or be created part-way along).
    funnel = [s for s in stages if s.kind == "open"] + [s for s in stages if s.kind == "won"]
    index = {s.id: i for i, s in enumerate(funnel)}
    furthest: dict[str, int] = {}
    for deal_id, to_stage in db.execute(select(DealStageHistory.deal_id, DealStageHistory.to_stage_id).where(
            DealStageHistory.deal_id.in_(deal_ids))).all():
        i = index.get(to_stage)
        if i is not None:
            furthest[deal_id] = max(furthest.get(deal_id, -1), i)
    created = db.scalar(select(func.count()).select_from(deal_ids.subquery())) or 0
    out = []
    for i, st in enumerate(funnel):
        reached = sum(1 for f in furthest.values() if f >= i)
        base = created if i == 0 else out[i - 1]["reached"]
        out.append({"stage_id": st.id, "name": st.name, "kind": st.kind, "reached": reached,
                    "conversion": round(100 * reached / base, 1) if base else None,
                    "average_days": round(float(spent[st.id]) / 86400, 1) if spent.get(st.id) else None})
    return {"pipeline_id": p.id, "days": days, "created": created, "stages": out}


def leaderboard(db: Session, ctx, pipeline_id: str | None, days: int = 30) -> dict:
    ctx.require(Perm.CRM_READ)
    ensure_defaults(db, ctx)
    p = _pipeline(db, ctx, pipeline_id)
    since = utcnow() - timedelta(days=days)
    stats: dict[str, dict] = defaultdict(lambda: {"won": 0, "won_amount": Decimal(0), "lost": 0, "open": 0,
                                                  "open_amount": Decimal(0), "activities": 0, "tasks_done": 0})
    for d in db.scalars(select(Deal).where(Deal.application_id == ctx.application_id, Deal.pipeline_id == p.id,
                                           Deal.owner_id.is_not(None))):
        s = stats[d.owner_id]
        same = d.currency == p.currency
        if d.status == "open":
            s["open"] += 1
            s["open_amount"] += _d(d.amount) if same else 0
        elif d.closed_at and d.closed_at >= since:
            s[d.status] += 1
            if d.status == "won" and same:
                s["won_amount"] += _d(d.amount)
    for uid, n in db.execute(select(CrmActivity.actor_user_id, func.count()).where(
            CrmActivity.application_id == ctx.application_id, CrmActivity.type != "system",
            CrmActivity.occurred_at >= since, CrmActivity.actor_user_id.is_not(None))
            .group_by(CrmActivity.actor_user_id)).all():
        stats[uid]["activities"] = n
    for uid, n in db.execute(select(CrmTask.assignee_id, func.count()).where(
            CrmTask.application_id == ctx.application_id, CrmTask.status == "done", CrmTask.completed_at >= since,
            CrmTask.assignee_id.is_not(None)).group_by(CrmTask.assignee_id)).all():
        stats[uid]["tasks_done"] = n
    users = users_by_id(db, stats)
    rows = [{"owner": user_ref(users.get(uid)), **s} for uid, s in stats.items() if uid in users]
    rows.sort(key=lambda r: (-r["won_amount"], -r["won"], -r["activities"]))
    return {"pipeline_id": p.id, "currency": p.currency, "days": days, "rows": rows}


def overview(db: Session, ctx, pipeline_id: str | None) -> dict:
    ctx.require(Perm.CRM_READ)
    ensure_defaults(db, ctx)
    p = _pipeline(db, ctx, pipeline_id)
    stages = {s.id: s for s in db.scalars(select(PipelineStage).where(PipelineStage.pipeline_id == p.id))}
    open_deals = [d for d in db.scalars(select(Deal).where(Deal.application_id == ctx.application_id,
                                                          Deal.pipeline_id == p.id, Deal.status == "open"))
                  if d.currency == p.currency]
    month_start = utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    won_month = db.execute(select(func.count(), func.coalesce(func.sum(Deal.amount), 0)).where(
        Deal.application_id == ctx.application_id, Deal.pipeline_id == p.id, Deal.status == "won",
        Deal.currency == p.currency, Deal.closed_at >= month_start)).one()
    wl = win_loss(db, ctx, p.id, 90)
    return {"pipeline_id": p.id, "currency": p.currency, "open_deals": len(open_deals),
            "open_amount": sum((_d(d.amount) for d in open_deals), Decimal(0)),
            "weighted_amount": sum((_d(_d(d.amount) * effective_probability(d, stages[d.stage_id]) / 100)
                                    for d in open_deals), Decimal(0)),
            "rotting_deals": sum(1 for d in open_deals if d.rotting_since is not None),
            "won_this_month": won_month[0], "won_amount_this_month": _d(won_month[1]),
            "win_rate_90d": wl["win_rate"], "average_cycle_days": wl["average_cycle_days"]}
