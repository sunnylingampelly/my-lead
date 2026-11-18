"""Platform administration (/admin) and payment endpoints (checkout and provider webhooks)."""
import json
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DB, CurrentUser, OrgCtx
from app.core.config import settings
from app.core.errors import Forbidden, NotFound, Unauthorized
from app.models import User
from app.models.email import WebhookEvent
from app.schemas.common import PageParams
from app.services import admin
from app.services.billing import payments

Paging = Annotated[PageParams, Depends()]


def platform_staff(user: CurrentUser) -> User:
    # The role is read from the database on every request, never trusted from the token.
    if user.platform_role not in ("super_admin", "support"):
        raise Forbidden("Platform staff only", code="NOT_PLATFORM_ADMIN")
    return user


def super_admin(user: CurrentUser) -> User:
    if user.platform_role != "super_admin":
        raise Forbidden("Only super admins can make this change", code="SUPER_ADMIN_REQUIRED")
    return user


Admin = Annotated[User, Depends(platform_staff)]
Super = Annotated[User, Depends(super_admin)]
router = APIRouter(prefix="/admin", tags=["Platform admin"])
public = APIRouter(tags=["Payments"])


class Reason(BaseModel):
    reason: str = Field(min_length=3, max_length=200)


class Adjust(BaseModel):
    kind: str = Field(pattern="^(credit|adjustment|refund)$")
    amount: Decimal = Field(max_digits=12, decimal_places=2)
    reason: str = Field(min_length=3, max_length=200)
    idempotency_key: str = Field(min_length=8, max_length=64)


@router.get("/overview")
def overview(_: Admin, db: DB):
    return admin.overview(db)


@router.get("/settings")
def effective_settings(_: Admin):
    return admin.effective_settings()


@router.get("/organizations")
def organizations(_: Admin, db: DB, paging: Paging, search: str | None = Query(None, max_length=100),
                  status: str | None = Query(None, max_length=20)):
    return admin.list_organizations(db, paging, search, status)


@router.get("/organizations/{org_id}")
def organization(org_id: str, _: Admin, db: DB):
    return admin.organization_detail(db, org_id)


@router.post("/organizations/{org_id}/suspend")
def suspend_org(org_id: str, body: Reason, me: Super, db: DB):
    admin.set_org_status(db, me, org_id, "suspended", body.reason)
    db.commit()
    return admin.organization_detail(db, org_id)


@router.post("/organizations/{org_id}/reactivate")
def reactivate_org(org_id: str, body: Reason, me: Super, db: DB):
    admin.set_org_status(db, me, org_id, "active", body.reason)
    db.commit()
    return admin.organization_detail(db, org_id)


@router.post("/organizations/{org_id}/wallet")
def adjust_wallet(org_id: str, body: Adjust, me: Super, db: DB):
    out = admin.adjust_wallet(db, me, org_id, body.kind, body.amount, body.reason, body.idempotency_key)
    db.commit()
    return out


@router.get("/users")
def users(_: Admin, db: DB, paging: Paging, search: str | None = Query(None, max_length=100)):
    return admin.list_users(db, paging, search)


@router.post("/users/{user_id}/suspend")
def suspend_user(user_id: str, body: Reason, me: Super, db: DB):
    admin.set_user_active(db, me, user_id, False, body.reason)
    db.commit()
    return {"ok": True}


@router.post("/users/{user_id}/reactivate")
def reactivate_user(user_id: str, body: Reason, me: Super, db: DB):
    admin.set_user_active(db, me, user_id, True, body.reason)
    db.commit()
    return {"ok": True}


@router.get("/webhooks")
def webhooks(_: Admin, db: DB, paging: Paging, status: str | None = Query(None, max_length=20),
             provider: str | None = Query(None, max_length=30)):
    return admin.list_webhooks(db, paging, status, provider)


@router.post("/webhooks/{webhook_id}/retry")
def retry_webhook(webhook_id: str, me: Super, db: DB):
    return {"status": admin.retry_webhook(db, me, webhook_id)}


# ------------------------------------------------------------------ staff & support sessions


class StaffBody(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    role: str = Field(pattern="^(super_admin|support)$")


class RoleBody(BaseModel):
    role: str = Field(pattern="^(super_admin|support)$")


class SupportBody(BaseModel):
    reason: str = Field(min_length=5, max_length=200)
    minutes: int = Field(default=60, ge=15, le=240)


@router.get("/me")
def me(user: Admin):
    return {"id": user.id, "email": user.email, "name": user.full_name, "platform_role": user.platform_role}


@router.get("/staff")
def staff(_: Admin, db: DB):
    return admin.list_staff(db)


@router.post("/staff")
def add_staff(body: StaffBody, me: Super, db: DB):
    out = admin.set_staff_role(db, me, body.email, body.role)
    db.commit()
    return out


@router.patch("/staff/{user_id}")
def change_staff(user_id: str, body: RoleBody, me: Super, db: DB):
    out = admin.change_staff_role(db, me, user_id, body.role)
    db.commit()
    return out


@router.delete("/staff/{user_id}", status_code=204)
def remove_staff(user_id: str, me: Super, db: DB):
    admin.remove_staff(db, me, user_id)
    db.commit()


@router.get("/support-sessions")
def support_sessions(me: Admin, db: DB, mine: bool = False):
    return admin.list_support_sessions(db, me.id if mine else None)


@router.post("/organizations/{org_id}/support-session")
def start_support(org_id: str, body: SupportBody, me: Admin, db: DB):
    out = admin.start_support_session(db, me, org_id, body.reason, body.minutes)
    db.commit()
    return out


@router.post("/support-sessions/{grant_id}/end")
def end_support(grant_id: str, me: Admin, db: DB):
    admin.end_support_session(db, me, grant_id)
    db.commit()
    return {"ended": True}


# ------------------------------------------------------------------ payments


class CheckoutBody(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)


@public.get("/organizations/{organization_id}/billing/payments")
def list_payments(ctx: OrgCtx, db: DB, paging: Paging):
    return payments.list_payments(db, ctx, paging)


@public.get("/organizations/{organization_id}/billing/payments/options")
def payment_options(ctx: OrgCtx, db: DB):
    from app.services.billing.wallet import get_wallet

    w = get_wallet(db, ctx.organization_id)
    db.commit()
    return {"currency": w.currency, **payments.availability(w.currency)}


@public.post("/organizations/{organization_id}/billing/checkout")
def checkout(body: CheckoutBody, ctx: OrgCtx, db: DB):
    p = payments.create_checkout(db, ctx, body.amount)
    db.commit()
    return {**payments.out(p), "checkout_url": p.checkout_url}


@public.get("/organizations/{organization_id}/billing/payments/{payment_id}")
def payment(payment_id: str, ctx: OrgCtx, db: DB):
    return payments.get_payment(db, ctx, payment_id)


def _store(db, provider: str, event_id: str, event_type: str, payload: dict) -> None:
    if not event_id or db.scalar(select(WebhookEvent.id).where(WebhookEvent.provider == provider,
                                                               WebhookEvent.event_id == event_id[:255])):
        return
    w = WebhookEvent(provider=provider, channel="payments", event_id=event_id[:255], event_type=event_type[:60],
                     payload=payload, signature_valid=True)
    db.add(w)
    db.commit()
    from app.tasks.payments import process_payment_webhook
    from app.workers.dispatch import dispatch

    dispatch(process_payment_webhook, w.id)


@public.post("/webhooks/payments/stripe", include_in_schema=False)
async def stripe_webhook(request: Request, db: DB):
    from app.providers.payments import verify_stripe

    if not settings.STRIPE_WEBHOOK_SECRET:
        raise NotFound()
    body = await request.body()
    if not verify_stripe(settings.STRIPE_WEBHOOK_SECRET, request.headers.get("stripe-signature", ""), body):
        raise Unauthorized("Invalid signature", code="INVALID_SIGNATURE")
    try:
        evt = json.loads(body)
    except ValueError:
        return JSONResponse({"error": "invalid json"}, status_code=400)
    _store(db, "stripe", str(evt.get("id", "")), str(evt.get("type", "")), evt)
    return {"received": True}


@public.post("/webhooks/payments/razorpay", include_in_schema=False)
async def razorpay_webhook(request: Request, db: DB):
    from app.providers.payments import verify_razorpay

    if not settings.RAZORPAY_WEBHOOK_SECRET:
        raise NotFound()
    body = await request.body()
    if not verify_razorpay(settings.RAZORPAY_WEBHOOK_SECRET, request.headers.get("x-razorpay-signature", ""), body):
        raise Unauthorized("Invalid signature", code="INVALID_SIGNATURE")
    try:
        evt = json.loads(body)
    except ValueError:
        return JSONResponse({"error": "invalid json"}, status_code=400)
    # Razorpay sends a unique id per delivery in this header; the event body has none.
    event_id = request.headers.get("x-razorpay-event-id") or f"{evt.get('event')}:{evt.get('created_at')}"
    _store(db, "razorpay", event_id, str(evt.get("event", "")), evt)
    return {"received": True}
