"""Payment providers for wallet top-ups: hosted pages, so card details never touch this platform.

* Stripe Checkout (USD): POST /v1/checkout/sessions; webhooks signed with the Stripe-Signature
  header, an HMAC-SHA256 of "{timestamp}.{raw body}" with the endpoint secret, with a tolerance window.
* Razorpay Payment Links (INR): POST /v1/payment_links; webhooks signed with X-Razorpay-Signature,
  an HMAC-SHA256 of the raw body with the webhook secret.

Requests follow each provider's published API. They have not been run against the live services from
this codebase; use test-mode keys first.
"""
import hashlib
import hmac
import time
from dataclasses import dataclass
from decimal import Decimal

import httpx


class PaymentError(Exception):
    pass


@dataclass(frozen=True)
class Checkout:
    provider_ref: str
    url: str


def minor_units(amount: Decimal) -> int:
    """Paise or cents."""
    return int((amount * 100).quantize(Decimal("1")))


def stripe_checkout(secret_key: str, *, amount: Decimal, currency: str, payment_id: str, org_name: str,
                    success_url: str, cancel_url: str, email: str | None) -> Checkout:
    data = {
        "mode": "payment",
        "success_url": success_url,
        "cancel_url": cancel_url,
        "client_reference_id": payment_id,
        "metadata[payment_id]": payment_id,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": currency.lower(),
        "line_items[0][price_data][unit_amount]": str(minor_units(amount)),
        "line_items[0][price_data][product_data][name]": f"Wallet credit for {org_name}"[:250],
    }
    if email:
        data["customer_email"] = email
    try:
        r = httpx.post("https://api.stripe.com/v1/checkout/sessions", data=data, auth=(secret_key, ""), timeout=20,
                       headers={"Idempotency-Key": f"checkout-{payment_id}"})
    except httpx.HTTPError as exc:
        raise PaymentError(f"Stripe is unreachable ({type(exc).__name__})") from exc
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code >= 400 or not body.get("url"):
        raise PaymentError((body.get("error") or {}).get("message") or f"Stripe returned {r.status_code}")
    return Checkout(provider_ref=body["id"], url=body["url"])


def verify_stripe(secret: str, header: str, body: bytes, tolerance: int = 300) -> bool:
    try:
        parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
        ts = int(parts["t"])
    except (KeyError, ValueError):
        return False
    if abs(time.time() - ts) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    sigs = [v for k, v in (p.split("=", 1) for p in header.split(",") if "=" in p) if k == "v1"]
    return any(hmac.compare_digest(expected, s) for s in sigs)


def stripe_signature(secret: str, body: bytes, ts: int | None = None) -> str:
    ts = ts or int(time.time())
    return f"t={ts},v1={hmac.new(secret.encode(), f'{ts}.'.encode() + body, hashlib.sha256).hexdigest()}"


def razorpay_link(key_id: str, key_secret: str, *, amount: Decimal, payment_id: str, org_name: str,
                  callback_url: str, email: str | None) -> Checkout:
    payload = {
        "amount": minor_units(amount), "currency": "INR", "accept_partial": False,
        "reference_id": payment_id[:40], "description": f"Wallet credit for {org_name}"[:2048],
        "notes": {"payment_id": payment_id}, "callback_url": callback_url, "callback_method": "get",
        "notify": {"email": False, "sms": False},
    }
    if email:
        payload["customer"] = {"email": email}
    try:
        r = httpx.post("https://api.razorpay.com/v1/payment_links", json=payload, auth=(key_id, key_secret), timeout=20)
    except httpx.HTTPError as exc:
        raise PaymentError(f"Razorpay is unreachable ({type(exc).__name__})") from exc
    try:
        body = r.json()
    except ValueError:
        body = {}
    if r.status_code >= 400 or not body.get("short_url"):
        raise PaymentError((body.get("error") or {}).get("description") or f"Razorpay returned {r.status_code}")
    return Checkout(provider_ref=body["id"], url=body["short_url"])


def verify_razorpay(secret: str, header: str, body: bytes) -> bool:
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return bool(header) and hmac.compare_digest(expected, header)


def razorpay_signature(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
