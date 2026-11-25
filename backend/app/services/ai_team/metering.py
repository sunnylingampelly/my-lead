"""Metered wallet billing for the AI Team.

Every model call records the tokens it used. A billable unit (one assistant message, one agent run, one
automation AI step) is charged once:

    provider cost (USD) = Σ  (input − cached) × input price + cached × cached price + output × output price
    charge              = max(AI_MIN_CHARGE[wallet currency], convert(cost × AI_MARKUP, USD → wallet currency))
                          × the plan's usage multiplier (Pro: 20% off)

posted as a wallet `usage` entry on channel "ai" with an idempotency key (ai:msg:{id} / ai:run:{id} /
ai:step:{run}:{node}), so a retry never charges twice. Dry runs and simulation mode (no OpenAI key) are free.
Before calling the model we check the wallet can pay at least the minimum; if not the request is refused with
INSUFFICIENT_BALANCE (the app turns that into an "Add credit" prompt)."""
from dataclasses import dataclass, field
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ValidationFailed
from app.services.billing import plans
from app.services.billing import wallet as wl

PER_MILLION = Decimal("1000000")
NO_CREDIT = "Add credit to keep using AI. Your wallet doesn't have enough balance for AI requests right now."


def _price(model: str | None) -> dict:
    table = settings.OPENAI_PRICING
    if model in table:
        return table[model]
    # Unknown (e.g. a newly configured) model: never under-charge, price it like the most expensive one.
    return max(table.values(), key=lambda p: p["output"])


def call_cost(model: str | None, input_tokens: int, cached_tokens: int, output_tokens: int) -> Decimal:
    p = _price(model)
    cached = min(max(cached_tokens, 0), max(input_tokens, 0))
    fresh = max(input_tokens, 0) - cached
    cost = (Decimal(fresh) * Decimal(str(p["input"])) + Decimal(cached) * Decimal(str(p["cached"]))
            + Decimal(max(output_tokens, 0)) * Decimal(str(p["output"]))) / PER_MILLION
    return cost.quantize(Decimal("0.00000001"))


@dataclass
class Meter:
    """Token usage of every model call in one billable unit."""

    calls: list[dict] = field(default_factory=list)

    def add(self, turn) -> dict | None:
        if getattr(turn, "simulated", False) or not getattr(turn, "model", None):
            return None
        c = {"model": turn.model, "input": turn.input_tokens, "cached": turn.cached_tokens,
             "output": turn.output_tokens,
             "cost_usd": float(call_cost(turn.model, turn.input_tokens, turn.cached_tokens, turn.output_tokens))}
        self.calls.append(c)
        return c

    @property
    def cost_usd(self) -> Decimal:
        return sum((Decimal(str(c["cost_usd"])) for c in self.calls), Decimal(0))

    @property
    def input_tokens(self) -> int:
        return sum(c["input"] for c in self.calls)

    @property
    def cached_tokens(self) -> int:
        return sum(c["cached"] for c in self.calls)

    @property
    def output_tokens(self) -> int:
        return sum(c["output"] for c in self.calls)

    @property
    def models(self) -> list[str]:
        return list(dict.fromkeys(c["model"] for c in self.calls))


def min_charge(currency: str) -> Decimal:
    return Decimal(str(settings.AI_MIN_CHARGE.get(currency, settings.AI_MIN_CHARGE["USD"])))


def amount_for(db: Session, organization_id: str, cost_usd: Decimal, currency: str) -> Decimal:
    raw = wl.convert(Decimal(str(cost_usd)) * Decimal(str(settings.AI_MARKUP)), "USD", currency)
    return wl.dec(max(min_charge(currency), raw) * plans.usage_multiplier(db, organization_id))


def ensure_can_afford(db: Session, organization_id: str) -> None:
    """Refuse before calling the model when the wallet can't cover the minimum charge."""
    if not settings.OPENAI_API_KEY:
        return  # simulation mode is free
    w = wl.get_wallet(db, organization_id)
    need = wl.dec(min_charge(w.currency) * plans.usage_multiplier(db, organization_id))
    if wl.available(db, w) < need:
        raise ValidationFailed(NO_CREDIT, code="INSUFFICIENT_BALANCE",
                               details={"needed": float(need), "currency": w.currency})


def can_afford(db: Session, organization_id: str) -> bool:
    try:
        ensure_can_afford(db, organization_id)
        return True
    except ValidationFailed:
        return False


def charge(db: Session, organization_id: str, application_id: str | None, meter: Meter, *, key: str,
           description: str, reference_type: str, reference_id: str, meta: dict | None = None) -> dict | None:
    """Post the charge for one unit. Returns {"amount", "currency", "cost_usd"} or None when nothing is charged
    (no billable calls: simulation, or already charged with this key)."""
    if not meter.calls:
        return None
    w = wl.get_wallet(db, organization_id)
    amount = amount_for(db, organization_id, meter.cost_usd, w.currency)
    tx = wl.post(db, w, "usage", -amount, description=description[:255], idempotency_key=key,
                 application_id=application_id, channel="ai", reference_type=reference_type,
                 reference_id=reference_id,
                 meta={"models": meter.models, "input_tokens": meter.input_tokens,
                       "cached_tokens": meter.cached_tokens, "output_tokens": meter.output_tokens,
                       "cost_usd": float(meter.cost_usd), "markup": settings.AI_MARKUP, **(meta or {})})
    if tx is None:
        return None
    return {"amount": float(amount), "currency": w.currency, "cost_usd": float(meter.cost_usd)}


def typical(currency: str) -> dict:
    t = settings.AI_TYPICAL_CHARGE
    return {"ai_assistant_message_from": float(min_charge(currency)),
            "ai_assistant_message_typical": float(t["assistant_message"].get(currency, 0)),
            "ai_agent_run_from": float(min_charge(currency)),
            "ai_agent_run_typical": float(t["agent_run"].get(currency, 0)),
            "ai_markup": float(settings.AI_MARKUP)}
