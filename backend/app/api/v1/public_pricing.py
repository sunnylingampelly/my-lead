"""Public price list for the marketing home page: plans and pay-as-you-go rates, read from the same
settings billing charges with, so the page can never drift from what customers actually pay."""
from typing import Literal

from fastapi import APIRouter, Query, Response

from app.core.config import settings
from app.services.billing import plans
from app.services.billing import wallet as wl
from app.services.billing.service import pricing
from app.services.billing.subscriptions import _plan_card

router = APIRouter(prefix="/public", tags=["Public"])


MARKET_FOR_CURRENCY = {"INR": "IN", "AED": "AE", "USD": "US"}


@router.get("/pricing")
def public_pricing(response: Response, currency: Literal["INR", "AED", "USD"] = Query("INR")) -> dict:
    home = MARKET_FOR_CURRENCY[currency]
    rates = next(r for r in pricing(currency) if r["country"] == home)
    ai = settings.VOICE_AI_PRICING.get(home) or settings.VOICE_AI_PRICING["default"]
    rates["voice_ai_minute"] = float(wl.convert(ai["per_minute"], ai["currency"], currency))
    # AI Team: metered from the wallet (about AI_MARKUP x the model cost), at least the minimum per message/run.
    from app.services.ai_team.metering import typical

    rates.update(typical(currency))
    response.headers["Cache-Control"] = "public, max-age=300"
    uae = home == "AE"
    return {
        "currency": currency,
        "market": home,
        "gst_rate": float(settings.GST_RATE) if currency == "INR" else None,
        # UAE: sold to VAT-registered businesses only, reverse charge (no UAE VAT on our invoice).
        "reverse_charge": uae,
        # Channels open in this market (UAE SMS and calls are "coming soon" behind settings flags).
        # SMS is "coming soon" everywhere while SMS_ENABLED is off.
        "channels": {"sms": settings.SMS_ENABLED and (settings.SMS_UAE_ENABLED if uae else True),
                     "voice": settings.VOICE_UAE_ENABLED if uae else True},
        "plans": [_plan_card(p, currency) for p in plans.PLANS.values()],
        "rates": rates,
        "topup_min": float(settings.TOPUP_MIN[currency]),
    }
