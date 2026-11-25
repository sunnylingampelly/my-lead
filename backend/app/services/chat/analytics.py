"""Chat analytics: volume, leads, bot-resolved vs handed-off, human first response time, CSAT, AI spend, top
questions and the unanswered-questions training list."""
import re
from collections import Counter
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.permissions import Perm
from app.models.billing import WalletTransaction
from app.models.chat import ChatBot, ChatConversation, ChatMessage
from app.utils.time import utcnow


def _norm(q: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s']", " ", (q or "").lower())).strip()


def overview(db: Session, ctx, days: int = 30, bot_id: str | None = None) -> dict:
    ctx.require(Perm.CHAT_READ)
    days = max(1, min(days, 365))
    since = (utcnow() - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    conds = [ChatConversation.application_id == ctx.application_id, ChatConversation.created_at >= since,
             ChatConversation.visitor_messages > 0]
    if bot_id:
        conds.append(ChatConversation.bot_id == bot_id)
    rows = db.execute(select(ChatConversation.id, ChatConversation.created_at, ChatConversation.handoff_requested_at,
                             ChatConversation.first_human_response_at, ChatConversation.lead_captured_at,
                             ChatConversation.rating, ChatConversation.offline, ChatConversation.ai_replies,
                             ChatConversation.status).where(*conds)).all()
    total = len(rows)
    handed = sum(1 for r in rows if r.handoff_requested_at)
    leads = sum(1 for r in rows if r.lead_captured_at)
    waits = [(r.first_human_response_at - r.handoff_requested_at).total_seconds() for r in rows
             if r.first_human_response_at and r.handoff_requested_at
             and r.first_human_response_at >= r.handoff_requested_at]
    rated = [r.rating for r in rows if r.rating]
    daily: dict[str, dict] = {}
    for r in rows:
        d = daily.setdefault(r.created_at.date().isoformat(), {"conversations": 0, "leads": 0, "handed_off": 0})
        d["conversations"] += 1
        d["leads"] += 1 if r.lead_captured_at else 0
        d["handed_off"] += 1 if r.handoff_requested_at else 0
    series = [{"date": (since + timedelta(days=i)).date().isoformat(),
               **daily.get((since + timedelta(days=i)).date().isoformat(),
                           {"conversations": 0, "leads": 0, "handed_off": 0})} for i in range(days)]
    spend_q = select(func.coalesce(func.sum(WalletTransaction.amount), 0)).where(
        WalletTransaction.organization_id == ctx.organization_id, WalletTransaction.application_id == ctx.application_id,
        WalletTransaction.channel == "chat", WalletTransaction.type == "usage", WalletTransaction.created_at >= since)
    ids = [r.id for r in rows]

    # Top questions: the first thing each visitor asked.
    firsts: dict[str, str] = {}
    if ids:
        for cid, body in db.execute(select(ChatMessage.conversation_id, ChatMessage.body).where(
                ChatMessage.application_id == ctx.application_id, ChatMessage.role == "visitor",
                ChatMessage.created_at >= since).order_by(ChatMessage.created_at).limit(20000)):
            if cid not in firsts:
                firsts[cid] = body
    top = Counter()
    sample: dict[str, str] = {}
    for cid in ids:
        if cid in firsts:
            k = _norm(firsts[cid])[:120]
            if k:
                top[k] += 1
                sample.setdefault(k, firsts[cid][:200])
    return {
        "days": days,
        "conversations": total,
        "leads": leads,
        "lead_rate": round(leads / total * 100, 1) if total else 0.0,
        "bot_resolved": total - handed,
        "handed_off": handed,
        "bot_resolved_pct": round((total - handed) / total * 100, 1) if total else 0.0,
        "handed_off_pct": round(handed / total * 100, 1) if total else 0.0,
        "avg_first_response_seconds": round(sum(waits) / len(waits)) if waits else None,
        "csat": round(sum(1 for r in rated if r == "up") / len(rated) * 100, 1) if rated else None,
        "ratings": len(rated),
        "ai_replies": sum(r.ai_replies or 0 for r in rows),
        "ai_spend": round(float(-(db.scalar(spend_q) or 0)), 4),
        "offline_messages": sum(1 for r in rows if r.offline),
        "series": series,
        "top_questions": [{"question": sample[k], "count": n} for k, n in top.most_common(10)],
        "unanswered": unanswered(db, ctx, since, bot_id),
    }


def unanswered(db: Session, ctx, since=None, bot_id: str | None = None, limit: int = 30) -> list[dict]:
    """Questions the bot couldn't answer, grouped, most frequent first: the training to-do list."""
    ctx.require(Perm.CHAT_READ)
    q = select(ChatMessage.id, ChatMessage.question, ChatMessage.created_at, ChatConversation.bot_id,
               ChatMessage.conversation_id).join(
        ChatConversation, ChatConversation.id == ChatMessage.conversation_id).where(
        ChatMessage.application_id == ctx.application_id, ChatMessage.flag == "unanswered")
    if since is not None:
        q = q.where(ChatMessage.created_at >= since)
    if bot_id:
        q = q.where(ChatConversation.bot_id == bot_id)
    groups: dict[tuple[str, str], dict] = {}
    for mid, question, at, b, cid in db.execute(q.order_by(ChatMessage.created_at.desc()).limit(5000)):
        k = (b, _norm(question or "")[:200])
        if not k[1]:
            continue
        g = groups.setdefault(k, {"question": (question or "")[:500], "count": 0, "last_at": at.isoformat(),
                                  "message_id": mid, "bot_id": b, "conversation_id": cid})
        g["count"] += 1
    bots = dict(db.execute(select(ChatBot.id, ChatBot.name).where(
        ChatBot.id.in_({k[0] for k in groups}))).all()) if groups else {}
    out = sorted(groups.values(), key=lambda g: (-g["count"], g["last_at"]))[:limit]
    for g in out:
        g["bot_name"] = bots.get(g["bot_id"])
    return out
