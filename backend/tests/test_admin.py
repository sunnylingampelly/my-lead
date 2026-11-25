"""Platform admin, live payments (Stripe, Razorpay) and monitoring."""
import json

import pytest

from app.cli import main as cli
from app.core.config import settings
from app.core.database import SessionLocal
from app.models.email import WebhookEvent
from app.providers import payments as pp
from tests.conftest import Api


@pytest.fixture
def admin(api_factory):
    a = api_factory().register("root@example.com", "Platform Root")
    assert cli(["grant-admin", "root@example.com"]) == 0
    return a


def test_admin_requires_platform_flag(owner, admin):
    assert owner.get("/admin/overview").status_code == 403
    r = admin.get("/admin/overview")
    assert r.status_code == 200 and r.json()["organizations"] >= 1 and r.json()["communication_mode"] == "simulation"
    assert cli(["grant-admin", "nobody@example.com"]) == 1
    assert cli(["revoke-admin", "root@example.com"]) == 0
    assert admin.get("/admin/overview").status_code == 403  # read from the database, not the old token


def test_suspend_org_wallet_adjustments_and_users(owner, admin):
    org = owner.org["id"]
    orgs = admin.get("/admin/organizations?search=acme").json()
    assert orgs["total"] == 1 and orgs["items"][0]["id"] == org
    r = admin.post(f"/admin/organizations/{org}/suspend", json={"reason": "Spam complaints"})
    assert r.status_code == 200 and r.json()["status"] == "suspended"
    blocked = owner.get(f"/organizations/{org}")
    assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "ORG_SUSPENDED"
    admin.post(f"/admin/organizations/{org}/reactivate", json={"reason": "Resolved"})
    assert owner.get(f"/organizations/{org}").status_code == 200

    body = {"kind": "credit", "amount": "40.00", "reason": "Goodwill credit", "idempotency_key": "adj-000001"}
    r = admin.post(f"/admin/organizations/{org}/wallet", json=body)
    assert r.status_code == 200 and r.json() == {"balance": 65.0, "currency": "USD"}  # $25 trial + $40
    assert admin.post(f"/admin/organizations/{org}/wallet", json=body).status_code == 409
    neg = {"kind": "credit", "amount": "-5", "reason": "Wrong sign", "idempotency_key": "adj-000002"}
    assert admin.post(f"/admin/organizations/{org}/wallet", json=neg).status_code == 422
    detail = admin.get(f"/admin/organizations/{org}").json()
    assert detail["transactions"][0]["description"] == "Credit by platform: Goodwill credit"

    users = admin.get("/admin/users?search=olivia").json()
    uid = users["items"][0]["id"]
    assert admin.post(f"/admin/users/{uid}/suspend", json={"reason": "Abuse"}).status_code == 200
    assert owner.get("/users/me").status_code in (401, 403)
    me = admin.get("/admin/users?search=root").json()["items"][0]["id"]
    r = admin.post(f"/admin/users/{me}/suspend", json={"reason": "Oops"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "SELF_ACTION"


def test_settings_hide_secrets_and_webhook_retry(admin, monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_supersecret")
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", "whsec_supersecret")
    r = admin.client.get("/api/v1/admin/settings", headers=admin.headers)
    assert r.status_code == 200 and "supersecret" not in r.text
    assert r.json()["providers"]["payments"]["stripe"] is True
    with SessionLocal() as db:
        w = WebhookEvent(provider="simulation", channel="email", event_id="x-1", event_type="delivered",
                         payload={"message_id": "nope", "type": "delivered", "event_id": "x-1"}, signature_valid=True,
                         status="failed", error="boom")
        db.add(w)
        db.commit()
        wid = w.id
    failed = admin.get("/admin/webhooks?status=failed").json()
    assert failed["total"] == 1
    assert admin.post(f"/admin/webhooks/{wid}/retry").json()["status"] in ("ignored", "processed")


# ------------------------------------------------------------------ payments

class FakeResp:
    def __init__(self, status: int, body: dict):
        self.status_code, self._body = status, body
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self._body


def test_stripe_checkout_and_signed_webhook(owner, monkeypatch):
    b = f"/organizations/{owner.org['id']}/billing"
    owner.get(b)  # create the USD wallet (with simulation trial credit)
    r = owner.post(f"{b}/checkout", json={"amount": "20"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "SIMULATION_MODE"
    monkeypatch.setattr(settings, "COMMUNICATION_MODE", "live")
    r = owner.post(f"{b}/checkout", json={"amount": "20"})
    assert r.json()["error"]["code"] == "PAYMENTS_NOT_CONFIGURED"
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_x")
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", "whsec_x")
    assert owner.get(f"{b}/payments/options").json()["provider"] == "stripe"
    sent = {}

    def fake_post(url, data=None, auth=None, timeout=None, headers=None, json=None):
        sent.update(url=url, data=data)
        return FakeResp(200, {"id": "cs_test_1", "url": "https://checkout.stripe.com/c/pay/cs_test_1"})

    monkeypatch.setattr(pp.httpx, "post", fake_post)
    r = owner.post(f"{b}/checkout", json={"amount": "20"})
    assert r.status_code == 200 and r.json()["checkout_url"].startswith("https://checkout.stripe.com/")
    pid = r.json()["id"]
    assert sent["data"]["line_items[0][price_data][unit_amount]"] == "2000" and sent["data"]["metadata[payment_id]"] == pid
    assert owner.post(f"{b}/checkout", json={"amount": "1"}).json()["error"]["code"] == "INVALID_AMOUNT"

    def event(eid: str, amount: int) -> bytes:
        return json.dumps({"id": eid, "type": "checkout.session.completed", "data": {"object": {
            "id": "cs_test_1", "payment_status": "paid", "amount_total": amount, "currency": "usd",
            "client_reference_id": pid, "metadata": {"payment_id": pid}, "payment_intent": "pi_1"}}}).encode()

    anon = Api()
    body = event("evt_1", 2000)
    assert anon.client.post("/api/v1/webhooks/payments/stripe", content=body,
                            headers={"stripe-signature": "t=1,v1=forged"}).status_code == 401
    ok = anon.client.post("/api/v1/webhooks/payments/stripe", content=body,
                          headers={"stripe-signature": pp.stripe_signature("whsec_x", body)})
    assert ok.status_code == 200
    assert owner.get(f"{b}/payments/{pid}").json()["status"] == "paid"
    assert owner.get(b).json()["balance"] == 45.0  # $25 trial + $20
    # A replay with a new event id still credits only once.
    body2 = event("evt_2", 2000)
    anon.client.post("/api/v1/webhooks/payments/stripe", content=body2,
                     headers={"stripe-signature": pp.stripe_signature("whsec_x", body2)})
    assert owner.get(b).json()["balance"] == 45.0


def test_razorpay_link_amount_mismatch_and_credit(api_factory, monkeypatch):
    a = api_factory().register("rupa@example.com", "Rupa")
    org = a.post("/organizations", json={"name": "Chai India", "country": "IN"}).json()
    b = f"/organizations/{org['id']}/billing"
    monkeypatch.setattr(settings, "COMMUNICATION_MODE", "live")  # live wallets get no trial credit
    for k, v in (("RAZORPAY_KEY_ID", "rzp_test"), ("RAZORPAY_KEY_SECRET", "secret"), ("RAZORPAY_WEBHOOK_SECRET", "hook")):
        monkeypatch.setattr(settings, k, v)
    monkeypatch.setattr(pp.httpx, "post", lambda url, json=None, auth=None, timeout=None: FakeResp(
        200, {"id": "plink_1", "short_url": "https://rzp.io/i/abc"}))
    # INR top-ups carry GST: they need the platform's GST registration and the buyer's billing details.
    monkeypatch.setattr(settings, "SELLER_GSTIN", "29AAPFU0939F1ZR")
    monkeypatch.setattr(settings, "SELLER_STATE_CODE", "29")
    a.put(f"{b}/profile", json={"legal_name": "Chai India Pvt Ltd", "address": "1 MG Road", "state_code": "29",
                                "pin_code": "560001", "email": "accounts@chai.example"})
    r = a.post(f"{b}/checkout", json={"amount": "1000"})
    assert r.status_code == 200 and r.json()["provider"] == "razorpay"
    pid = r.json()["id"]

    def event(paid: int) -> bytes:
        return json.dumps({"event": "payment_link.paid", "created_at": paid, "payload": {
            "payment_link": {"entity": {"id": "plink_1", "amount_paid": paid, "currency": "INR",
                                        "notes": {"payment_id": pid}}},
            "payment": {"entity": {"id": "pay_1", "amount": paid, "currency": "INR"}}}}).encode()

    anon = Api()
    short = event(100)  # ₹1 instead of ₹1,000
    anon.client.post("/api/v1/webhooks/payments/razorpay", content=short,
                     headers={"x-razorpay-signature": pp.razorpay_signature("hook", short), "x-razorpay-event-id": "e1"})
    assert a.get(f"{b}/payments/{pid}").json()["status"] == "failed"
    assert a.get(b).json()["balance"] == 0
    assert anon.client.post("/api/v1/webhooks/payments/razorpay", content=short,
                            headers={"x-razorpay-signature": "bad"}).status_code == 401


# ------------------------------------------------------------------ monitoring

def test_metrics_and_health(owner, monkeypatch):
    anon = Api()
    assert anon.client.get("/api/v1/metrics").status_code == 404
    monkeypatch.setattr(settings, "METRICS_TOKEN", "m-token")
    assert anon.client.get("/api/v1/metrics", headers={"authorization": "Bearer nope"}).status_code == 401
    r = anon.client.get("/api/v1/metrics", headers={"authorization": "Bearer m-token"})
    assert r.status_code == 200 and "signalcraft_up 1" in r.text
    assert 'signalcraft_http_requests_total{method="POST",path="auth/register",status="2xx"}' in r.text
    h = anon.client.get("/api/v1/health").json()
    assert h["checks"]["database"] == "ok" and h["checks"]["storage"] == "ok"


# ------------------------------------------------------------------ super admin, staff and support access

def test_staff_roles_and_last_super_admin(admin, api_factory):
    helper = api_factory().register("helper@example.com", "Help Desk")
    r = admin.post("/admin/staff", json={"email": "helper@example.com", "role": "support"})
    assert r.status_code == 200 and r.json()["role"] == "support"
    staff = {s["email"]: s["role"] for s in admin.get("/admin/staff").json()}
    assert staff == {"root@example.com": "super_admin", "helper@example.com": "support"}
    # Support staff can look but not change anything.
    assert helper.get("/admin/organizations").status_code == 200
    some_org = helper.get("/admin/organizations").json()["items"]
    if some_org:
        assert helper.post(f"/admin/organizations/{some_org[0]['id']}/suspend", json={"reason": "nope"}).status_code == 403
    assert helper.post("/admin/staff", json={"email": "root@example.com", "role": "support"}).status_code == 403
    me = admin.get("/admin/me").json()
    assert me["platform_role"] == "super_admin"
    r = admin.patch(f"/admin/staff/{me['id']}", json={"role": "support"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "SELF_ACTION"
    # Promote the helper, then the original super admin may be demoted by them; the last one may not.
    hid = next(s["id"] for s in admin.get("/admin/staff").json() if s["email"] == "helper@example.com")
    assert admin.patch(f"/admin/staff/{hid}", json={"role": "super_admin"}).json()["role"] == "super_admin"
    assert helper.delete(f"/admin/staff/{me['id']}").status_code == 204
    assert admin.get("/admin/overview").status_code == 403
    r = helper.patch(f"/admin/staff/{hid}", json={"role": "support"})
    assert r.status_code == 422  # self
    assert admin.post("/admin/staff", json={"email": "x@example.com", "role": "support"}).status_code == 403


def test_support_session_read_only_audited_and_expiring(owner, admin):
    org, app_id = owner.org["id"], owner.app["id"]
    assert admin.get(f"/organizations/{org}").status_code == 404  # no membership, no session
    r = admin.post(f"/admin/organizations/{org}/support-session", json={"reason": "Ticket 4821: import failing",
                                                                         "minutes": 30})
    assert r.status_code == 200 and r.json()["active"]
    grant = r.json()["id"]
    mine = admin.get("/organizations").json()
    support_org = next(o for o in mine if o["id"] == org)
    assert support_org["role"] == "platform_support" and support_org["support_access_expires_at"]
    assert admin.get(f"/apps/{app_id}/contacts").status_code == 200
    assert admin.get(f"/organizations/{org}/members").status_code == 200
    # Read-only: no writes, no exports.
    assert admin.post(f"/apps/{app_id}/contacts", json={"email": "x@example.com"}).status_code == 403
    assert admin.patch(f"/organizations/{org}", json={"name": "Hacked"}).status_code == 403
    assert admin.client.get(f"/api/v1/apps/{app_id}/contacts/export", headers=admin.headers).status_code == 403
    # The customer can see it happened.
    log = owner.get(f"/organizations/{org}/audit-logs").json()["items"]
    assert any(e["action"] == "support.access_started" and "Ticket 4821" in (e["summary"] or "") for e in log)
    assert any(n["type"] == "support_access" for n in owner.get("/notifications").json()["items"])
    # Roles listed to customers never include the internal support role.
    assert "platform_support" not in [r["key"] for r in owner.get(f"/organizations/{org}/roles").json()]
    assert admin.post(f"/admin/support-sessions/{grant}/end").status_code == 200
    assert admin.get(f"/apps/{app_id}/contacts").status_code == 404
    assert all(o["id"] != org for o in admin.get("/organizations").json())


def test_create_superadmin_cli():
    assert cli(["create-superadmin", "boss@example.com", "The Boss", "a-very-long-password"]) == 0
    a = Api().login("boss@example.com", "a-very-long-password")
    assert a.user["platform_role"] == "super_admin"
    assert a.get("/admin/overview").status_code == 200
    assert cli(["create-superadmin", "boss@example.com"]) == 0  # existing user: just ensures the role
