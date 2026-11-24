"""Chatbot billing: each AI reply is charged from the wallet right away, once per message (idempotent).

* Price: settings.CHAT_AI_PRICING by the application's default country, converted to the wallet currency and
  multiplied by the plan's usage multiplier (Pro: 20% off).
* Before generating a reply we check the wallet can pay for it. If it can't, the bot stops answering with AI
  and offers the lead form / a human instead; owners are told at most once a day per bot.
* Human live chat and simulated replies (no ANTHROPIC_API_KEY) are free.
"""
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import Application, OrganizationMember
from app.models.chat import ChatBot
from app.services.billing import plans
from app.services.billing import wallet as wl
from app.utils.time import utcnow


def price_row(country: str | None) -> dict:
    return settings.CHAT_AI_PRICING.get((country or "").upper()) or settings.CHAT_AI_PRICING["default"]


def reply_price(db: Session, bot: ChatBot, wallet=None) -> tuple[Decimal, dict]:
    """(price of one AI reply in the wallet currency after the plan discount, the list price row)."""
    app = db.get(Application, bot.application_id)
    row = price_row(app.default_country if app else None)
    w = wallet or wl.get_wallet(db, bot.organization_id)
    amount = wl.dec(wl.convert(row["per_reply"], row["currency"], w.currency) * plans.usage_multiplier(
        db, bot.organization_id))
    return amount, row


def can_afford(db: Session, bot: ChatBot) -> bool:
    w = wl.get_wallet(db, bot.organization_id)
    amount, _ = reply_price(db, bot, w)
    return wl.available(db, w) >= amount


def charge_reply(db: Session, bot: ChatBot, conversation_id: str, message_id: str):
    """Debit one AI reply. Returns the ledger entry, or None if this message was already charged."""
    w = wl.get_wallet(db, bot.organization_id)
    amount, row = reply_price(db, bot, w)
    if amount <= 0:
        return None
    return wl.post(db, w, "usage", -amount, description=f"AI chat reply · {bot.name}"[:255],
                   idempotency_key=f"chat:{message_id}", application_id=bot.application_id, channel="chat",
                   reference_type="chat_message", reference_id=message_id,
                   meta={"units": 1, "original_amount": row["per_reply"], "original_currency": row["currency"],
                         "bot_id": bot.id, "conversation_id": conversation_id})


def notify_paused(db: Session, bot: ChatBot) -> bool:
    """Tell owners and admins (once a day per bot) that AI replies are paused until the wallet is topped up."""
    now = utcnow()
    if bot.wallet_paused_notified_at and bot.wallet_paused_notified_at > now - timedelta(days=1):
        return False
    from app.services.notification_service import notify

    bot.wallet_paused_notified_at = now
    for uid in db.scalars(select(OrganizationMember.user_id).where(
            OrganizationMember.organization_id == bot.organization_id,
            OrganizationMember.role_key.in_(("owner", "admin")))):
        notify(db, uid, type_="chat_wallet_empty", level="warning",
               title=f"Chatbot “{bot.name}” paused its AI replies"[:160],
               body="Your wallet is empty, so visitors are offered the contact form and live chat instead of AI "
                    "answers. Add credit to turn AI replies back on.",
               link=f"/orgs/{bot.organization_id}/billing", organization_id=bot.organization_id,
               application_id=bot.application_id)
    return True
