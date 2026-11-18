"""Billing: wallets, trial credit, holds at launch, usage settlement, idempotency, currency
conversion, blocked launches, test top-ups, CSV export and access control."""
from decimal import Decimal

import pytest
from sqlalchemy import func, select, update

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import ApplicationSettings
from app.models.billing import Wallet, WalletHold, WalletTransaction
from app.services.billing import wallet as wl
from tests.conftest import Api, invite_and_join, token_from_last_email


@pytest.fixture
def india(api_factory):
    """An Indian organization (INR wallet) with an app, a verified sender and two consented contacts."""
    a = api_factory().register("rupa@example.com", "Rupa Owner")
    a.org = a.post("/organizations", json={"name": "Chai India", "country": "IN"}).json()
    a.app_id = a.post("/applications", json={"organization_id": a.org["id"], "name": "Chai", "default_country": "IN",
                                              "timezone": "Asia/Kolkata"}).json()["id"]
    a.base = f"/apps/{a.app_id}"
    a.b = f"/organizations/{a.org['id']}/billing"
    with SessionLocal() as db:
        db.execute(update(ApplicationSettings).where(ApplicationSettings.application_id == a.app_id)
                   .values(quiet_hours_start="00:00", quiet_hours_end="00:00"))
        db.commit()
    s = a.post(f"{a.base}/email/senders", json={"from_name": "Chai", "from_email": "hi@chai.example"})
    Api().post("/public/email-senders/verify", json={"token": token_from_last_email("hi@chai.example", "/verify-sender")})
    a.sender_id = s.json()["id"]
    for name in ("asha", "ravi"):
        a.post(f"{a.base}/contacts", json={"first_name": name.title(), "email": f"{name}@example.com",
                                           "phone": "+9198765" + ("43210" if name == "asha" else "12345"),
                                           "consent": {"email": True, "sms": True, "source": "Form"}})
    return a


def email_campaign(a) -> str:
    c = a.post(f"{a.base}/email/campaigns", json={"name": "Offer"}).json()
    r = a.patch(f"{a.base}/email/campaigns/{c['id']}", json={
        "sender_id": a.sender_id, "subject": "Hi", "editor": "html", "html": "<p>Hello</p>", "audience": {"all": True}})
    assert r.status_code == 200, r.text
    return c["id"]


def set_balance(org_id: str, amount: str) -> None:
    with SessionLocal() as db:
        w = wl.get_wallet(db, org_id)
        wl.post(db, w, "adjustment", Decimal(amount) - wl.dec(w.balance), description="Test adjustment",
                idempotency_key=f"adj:{amount}:{w.balance}")
        db.commit()


def test_trial_credit_currency_and_summary(india, owner):
    a = india
    s = a.get(a.b).json()
    assert s["currency"] == "INR" and s["balance"] == 1000 and s["available"] == 1000 and s["test_mode"]
    tx = a.get(f"{a.b}/transactions").json()
    assert tx["total"] == 1 and tx["items"][0]["type"] == "trial_credit"
    # Loading again does not add a second trial credit.
    assert a.get(a.b).json()["balance"] == 1000
    # An organization without a country gets a USD wallet.
    assert owner.get(f"/organizations/{owner.org['id']}/billing").json()["currency"] == "USD"
    p = {r["country"]: r for r in s["pricing"]}
    assert p["IN"]["sms_promotional"] == 0.25 and p["US"]["voice_minute"] == pytest.approx(0.014 * 83, rel=1e-3)


def test_email_hold_settlement_idempotent_and_released(india):
    a = india
    cid = email_campaign(a)
    rd = a.get(f"{a.base}/email/campaigns/{cid}/readiness").json()
    assert {ch["key"]: ch["ok"] for ch in rd["checks"]}["wallet"] is True
    assert a.post(f"{a.base}/email/campaigns/{cid}/send").status_code == 200
    with SessionLocal() as db:
        h = db.scalar(select(WalletHold).where(WalletHold.reference_id == cid))
        assert h is not None and h.amount == Decimal("0.1000")  # 2 emails × ₹0.05
    assert wl.run_settlement() == {"entries": 1, "released": 0}
    assert wl.run_settlement() == {"entries": 0, "released": 0}  # nothing new to charge
    s = a.get(a.b).json()
    assert s["balance"] == pytest.approx(999.90) and s["held"] == 0
    assert s["month_usage"]["by_channel"] == {"email": pytest.approx(0.10)}
    with SessionLocal() as db:
        assert db.scalar(select(WalletHold.status).where(WalletHold.reference_id == cid)) == "released"
        usage = db.scalar(select(WalletTransaction).where(WalletTransaction.type == "usage"))
        assert usage.meta["units"] == 2 and usage.application_id == a.app_id
    app_view = a.get(f"{a.base}/billing").json()
    assert app_view["month_usage"]["total"] == pytest.approx(0.10)
    csv = a.client.get(f"/api/v1{a.b}/transactions.csv", headers=a.headers)
    assert csv.status_code == 200 and "usage,email,Email usage: Offer" in csv.text


def test_low_balance_blocks_launch_and_notifies(india):
    a = india
    cid = email_campaign(a)
    set_balance(a.org["id"], "0.05")
    rd = a.get(f"{a.base}/email/campaigns/{cid}/readiness").json()
    wallet = next(ch for ch in rd["checks"] if ch["key"] == "wallet")
    assert not wallet["ok"] and "Add credit" in wallet["detail"]
    r = a.post(f"{a.base}/email/campaigns/{cid}/send")
    assert r.status_code == 422 and r.json()["error"]["code"] == "CAMPAIGN_NOT_READY"
    notes = a.get("/notifications").json()
    assert any(n["type"] == "low_balance" for n in notes["items"])


def test_holds_prevent_overspending_across_campaigns(india):
    a = india
    with SessionLocal() as db:
        w = wl.get_wallet(db, a.org["id"])
        wl.place_hold(db, a.org["id"], a.app_id, "sms_campaign", "00000000-0000-0000-0000-000000000001", 999.95, "INR",
                      "Big campaign")
        db.commit()
        assert wl.available(db, db.get(Wallet, w.id)) == Decimal("0.0500")
        with pytest.raises(Exception, match="Not enough credit"):
            wl.place_hold(db, a.org["id"], a.app_id, "email_campaign", "00000000-0000-0000-0000-000000000002", 0.10,
                          "INR", "Second")


def test_currency_conversion_into_usd_wallet(owner):
    with SessionLocal() as db:
        w = wl.get_wallet(db, owner.org["id"])
        assert w.currency == "USD"
        assert wl.convert(Decimal("83"), "INR", "USD") == Decimal("1.0000")
        assert wl.convert(Decimal("1"), "USD", "INR") == Decimal("83.0000")
        db.commit()


def test_test_credit_rules_and_permissions(india, monkeypatch):
    a = india
    r = a.post(f"{a.b}/test-credit", json={"amount": "500", "idempotency_key": "topup-0001"})
    assert r.status_code == 200 and r.json() == {"added": True, "balance": 1500.0}
    # The same request retried does not credit twice.
    assert a.post(f"{a.b}/test-credit", json={"amount": "500", "idempotency_key": "topup-0001"}).json()["added"] is False
    assert a.post(f"{a.b}/test-credit", json={"amount": "999999", "idempotency_key": "topup-0002"}).status_code == 422
    a.put(f"{a.b}/threshold", json={"low_balance_threshold": "2000"})
    assert a.get(a.b).json()["low"] is True
    viewer = invite_and_join(a, "viewer@example.com", "viewer", [a.app_id])
    assert viewer.get(a.b).status_code == 403
    manager = invite_and_join(a, "mgr@example.com", "application_manager", [a.app_id])
    assert manager.get(f"{a.base}/billing").status_code == 200
    assert manager.post(f"{a.b}/test-credit", json={"amount": "5", "idempotency_key": "topup-0003"}).status_code in (403, 404)
    monkeypatch.setattr(settings, "COMMUNICATION_MODE", "live")
    r = a.post(f"{a.b}/test-credit", json={"amount": "5", "idempotency_key": "topup-0004"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "LIVE_MODE"
    with SessionLocal() as db:
        n = db.scalar(select(func.count()).select_from(WalletTransaction))
    assert n == 2  # trial credit + one test credit; the ledger is append-only
    other = Api().register("other@example.com", "Other")
    assert other.get(a.b).status_code in (403, 404)


# ------------------------------------------------------------------ analytics

def test_analytics_cross_channel_and_csv(india):
    from app.services.email import tokens

    a = india
    cid = email_campaign(a)
    a.post(f"{a.base}/email/campaigns/{cid}/send")
    with SessionLocal() as db:
        from app.models.email import EmailMessage

        mid = db.scalar(select(EmailMessage.id).where(EmailMessage.to_email == "asha@example.com"))
    Api().client.get(f"/api/v1/t/o/{tokens.make('o', mid)}.gif")
    wl.run_settlement()
    r = a.get(f"{a.base}/analytics")
    assert r.status_code == 200, r.text
    d = r.json()
    assert len(d["points"]) == 30 and d["timezone"] == "Asia/Kolkata" and d["currency"] == "INR"
    t = d["totals"]
    assert (t["email_sent"], t["email_delivered"], t["email_opened"]) == (2, 2, 1)
    assert t["spend"] == pytest.approx(0.10) and d["rates"]["email_open"] == 50.0
    assert d["points"][-1]["email_sent"] == 2  # today, in India time
    assert d["top_campaigns"][0]["name"] == "Offer" and d["top_campaigns"][0]["rate"] == 50.0
    csv = a.client.get(f"/api/v1{a.base}/analytics/export.csv", headers=a.headers)
    assert csv.status_code == 200 and csv.text.splitlines()[0].startswith("date,email_sent")
    assert csv.text.splitlines()[-1].startswith("total,2.0,2.0,1.0")
    bad = a.get(f"{a.base}/analytics?start=2026-05-01&end=2026-01-01")
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_RANGE"
    assert a.get(f"{a.base}/analytics?start=2024-01-01&end=2026-01-01").status_code == 422
    viewer = invite_and_join(a, "viewer2@example.com", "viewer", [a.app_id])
    assert viewer.get(f"{a.base}/analytics").status_code == 200
