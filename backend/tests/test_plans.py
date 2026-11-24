"""Plans: Pro upgrade paid from the wallet, scheduled downgrade, monthly renewal, past due and grace,
the Pro usage discount, plan limits and recurring charges."""
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.database import SessionLocal
from app.models import AuditLog, Notification
from app.models.billing import WalletHold, WalletTransaction
from app.services.billing import plans, subscriptions
from app.services.billing import wallet as wl
from tests.conftest import invite_and_join, make_pro
from tests.test_billing import email_campaign, india, set_balance  # noqa: F401  (india is a fixture)


def plan_url(a) -> str:
    return f"/organizations/{a.org['id']}/billing/plan"


def sub_txs(org_id: str) -> list[WalletTransaction]:
    with SessionLocal() as db:
        return list(db.scalars(select(WalletTransaction).where(WalletTransaction.organization_id == org_id,
                                                                WalletTransaction.type == "subscription")
                               .order_by(WalletTransaction.created_at)))


def renew(now) -> dict:
    with SessionLocal() as db:
        out = subscriptions.renew_due(db, now=now)
        db.commit()
    return out


def period_end(org_id: str):
    with SessionLocal() as db:
        return subscriptions.get(db, org_id).current_period_end


def test_starter_by_default_and_catalogue(owner):
    p = owner.get(plan_url(owner)).json()
    assert p["plan"] == "starter" and p["status"] == "active" and p["currency"] == "USD"
    assert p["usage"]["applications"] == 1 and p["usage"]["members"] == 1 and p["usage"]["contacts"] == 0
    assert p["limits"]["applications"] == 2
    cat = {c["key"]: c for c in p["catalogue"]}
    assert cat["pro"]["price"] == 49 and cat["starter"]["price"] == 0 and cat["pro"]["usage_discount"] == 0.2
    assert p["next_charge"]["date"] is None and p["next_charge"]["total"] == 0
    assert owner.get(f"/organizations/{owner.org['id']}/billing").json()["plan"]["key"] == "starter"


def test_upgrade_charges_wallet_once(owner):
    set_balance(owner.org["id"], "100")
    r = owner.post(plan_url(owner), json={"plan": "pro"})
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["plan"] == "pro" and p["status"] == "active" and p["current_period_end"]
    assert p["next_charge"]["plan"] == 49 and p["next_charge"]["date"] == p["current_period_end"]
    # Asking again does not charge again.
    assert owner.post(plan_url(owner), json={"plan": "pro"}).status_code == 200
    txs = sub_txs(owner.org["id"])
    assert len(txs) == 1 and txs[0].amount == Decimal("-49") and txs[0].idempotency_key.startswith("sub:")
    assert owner.get(f"/organizations/{owner.org['id']}/billing").json()["balance"] == 51
    with SessionLocal() as db:
        assert db.scalar(select(AuditLog.id).where(AuditLog.action == "billing.plan_upgraded"))
    tx = owner.get(f"/organizations/{owner.org['id']}/billing/transactions", params={"type": "subscription"}).json()
    assert tx["total"] == 1 and tx["items"][0]["type"] == "subscription"


def test_insufficient_balance_blocks_upgrade(owner):
    set_balance(owner.org["id"], "10")
    r = owner.post(plan_url(owner), json={"plan": "pro"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "INSUFFICIENT_BALANCE"
    assert "49" in r.json()["error"]["message"]
    assert owner.get(plan_url(owner)).json()["plan"] == "starter"
    assert sub_txs(owner.org["id"]) == []


def test_plan_change_requires_billing_manage(owner):
    viewer = invite_and_join(owner, "v@example.com", "viewer", [owner.app["id"]])
    viewer.org = owner.org
    assert viewer.post(plan_url(owner), json={"plan": "pro"}).status_code == 403
    assert owner.post(plan_url(owner), json={"plan": "gold"}).status_code == 422


def test_downgrade_is_scheduled_undoable_and_applied_at_renewal(owner):
    set_balance(owner.org["id"], "500")
    owner.post(plan_url(owner), json={"plan": "pro"})
    p = owner.post(plan_url(owner), json={"plan": "starter"}).json()
    assert p["plan"] == "pro" and p["scheduled_plan"] == "starter" and p["scheduled_change_at"] == p["current_period_end"]
    assert p["next_charge"]["plan"] == 0 and p["next_charge"]["date"] is None  # Pro ends; nothing renews
    # Undo, then schedule again.
    p = owner.post(f"{plan_url(owner)}/cancel-change").json()
    assert p["scheduled_plan"] is None and p["next_charge"]["plan"] == 49
    owner.post(plan_url(owner), json={"plan": "starter"})
    end = period_end(owner.org["id"])
    assert renew(end - timedelta(minutes=1))["downgraded"] == 0
    assert renew(end + timedelta(seconds=1))["downgraded"] == 1
    p = owner.get(plan_url(owner)).json()
    assert p["plan"] == "starter" and p["scheduled_plan"] is None
    assert len(sub_txs(owner.org["id"])) == 1  # no renewal charge


def test_renewal_charges_monthly(owner):
    set_balance(owner.org["id"], "500")
    owner.post(plan_url(owner), json={"plan": "pro"})
    end = period_end(owner.org["id"])
    assert renew(end + timedelta(minutes=1)) == {"renewed": 1, "downgraded": 0, "past_due": 0, "expired": 0}
    assert renew(end + timedelta(minutes=1))["renewed"] == 0  # the new period has not ended
    txs = sub_txs(owner.org["id"])
    assert len(txs) == 2 and all(t.amount == Decimal("-49") for t in txs)
    new_end = period_end(owner.org["id"])
    assert subscriptions.add_month(end) == new_end and new_end > end + timedelta(days=27)


def test_past_due_grace_then_starter(owner):
    org = owner.org["id"]
    set_balance(org, "49")
    owner.post(plan_url(owner), json={"plan": "pro"})
    end = period_end(org)
    assert renew(end + timedelta(minutes=1))["past_due"] == 1
    p = owner.get(plan_url(owner)).json()
    assert p["plan"] == "pro" and p["status"] == "past_due" and p["grace_ends_at"]
    with SessionLocal() as db:
        assert db.scalar(select(Notification.id).where(Notification.type == "plan_past_due"))
    # Retried on every run; still in grace after 3 days.
    assert renew(end + timedelta(days=3)) == {"renewed": 0, "downgraded": 0, "past_due": 0, "expired": 0}
    assert renew(end + timedelta(days=plans.GRACE_DAYS, minutes=2))["expired"] == 1
    p = owner.get(plan_url(owner)).json()
    assert p["plan"] == "starter" and p["status"] == "active"
    with SessionLocal() as db:
        assert db.scalar(select(Notification.id).where(Notification.type == "plan_expired"))
        assert db.scalar(select(AuditLog.id).where(AuditLog.action == "billing.plan_expired"))
    assert len(sub_txs(org)) == 1


def test_past_due_recovers_when_credit_is_added(owner):
    org = owner.org["id"]
    set_balance(org, "49")
    owner.post(plan_url(owner), json={"plan": "pro"})
    end = period_end(org)
    renew(end + timedelta(minutes=1))
    set_balance(org, "60")
    assert renew(end + timedelta(days=1))["renewed"] == 1
    p = owner.get(plan_url(owner)).json()
    assert p["status"] == "active" and p["past_due_since"] is None
    assert period_end(org) == subscriptions.add_month(end)


def test_pro_discount_applies_to_usage(india):  # noqa: F811
    a = india
    make_pro(a.org["id"])
    cid = email_campaign(a)
    assert a.post(f"{a.base}/email/campaigns/{cid}/send").status_code == 200
    with SessionLocal() as db:
        h = db.scalar(select(WalletHold).where(WalletHold.reference_id == cid))
        assert h.amount == Decimal("0.0800")  # 2 emails × ₹0.05 × 0.8
    assert wl.run_settlement()["entries"] == 1
    assert wl.run_settlement()["entries"] == 0  # idempotent
    usage = a.get(f"{a.b}/transactions", params={"type": "usage"}).json()["items"]
    assert len(usage) == 1 and usage[0]["amount"] == -0.08 and usage[0]["meta"]["plan_discount"] == 0.2


def test_limits_block_third_application_and_fourth_member(owner):
    org = owner.org["id"]
    owner.create_app(org, "Second")
    r = owner.post("/applications", json={"organization_id": org, "name": "Third", "timezone": "Asia/Kolkata"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "PLAN_LIMIT"
    assert "Upgrade to Pro" in r.json()["error"]["message"]
    # Owner + one member + one pending invitation = 3 seats.
    invite_and_join(owner, "m1@example.com", "admin")
    body = {"role": "admin", "application_ids": []}
    assert owner.post(f"/organizations/{org}/invitations", json={**body, "email": "m2@example.com"}).status_code == 201
    # Re-sending to the same address does not take another seat.
    assert owner.post(f"/organizations/{org}/invitations", json={**body, "email": "m2@example.com"}).status_code == 201
    r = owner.post(f"/organizations/{org}/invitations", json={**body, "email": "m3@example.com"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "PLAN_LIMIT"
    make_pro(org)
    assert owner.post("/applications", json={"organization_id": org, "name": "Third",
                                             "timezone": "Asia/Kolkata"}).status_code == 201
    assert owner.post(f"/organizations/{org}/invitations", json={**body, "email": "m3@example.com"}).status_code == 201
    u = owner.get(plan_url(owner)).json()["usage"]
    assert u["applications"] == 3 and u["members"] == 4


def test_contact_limit_on_create_and_import(owner, monkeypatch):
    from tests.test_imports import make_csv, start, upload

    mapping = {"Name": "full_name", "Email Address": "email"}
    monkeypatch.setitem(plans.PLANS[plans.STARTER]["limits"], "contacts", 3)
    owner.base = f"/apps/{owner.app['id']}"
    assert owner.post(f"{owner.base}/contacts", json={"email": "a@example.com"}).status_code == 201
    imp = upload(owner, make_csv(4))
    done = start(owner, imp["id"], mapping)
    assert done["status"] == "completed", done
    assert done["created_count"] == 2 and done["skipped_count"] == 2
    with SessionLocal() as db:
        from app.models import ImportRow

        reasons = set(db.scalars(select(ImportRow.reason).where(ImportRow.import_id == imp["id"],
                                                                ImportRow.status == "skipped")))
    assert len(reasons) == 1 and "Contact limit reached" in reasons.pop()
    r = owner.post(f"{owner.base}/contacts", json={"email": "z@example.com"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "PLAN_LIMIT"
    imp2 = upload(owner, make_csv(1))
    r = owner.post(f"{owner.base}/imports/{imp2['id']}/start",
                   json={"mapping": mapping, "options": {"duplicate_handling": "skip"}})
    assert r.status_code == 422 and r.json()["error"]["code"] == "PLAN_LIMIT"


def test_charge_recurring_idempotent_and_low_balance(owner):
    org = owner.org["id"]
    set_balance(org, "10")
    with SessionLocal() as db:
        kw = {"currency": "USD", "description": "Monthly add-on, Dec 2026"}
        assert subscriptions.charge_recurring(db, org, key="num:1:2026-12", amount=Decimal("3"), **kw) is True
        assert subscriptions.charge_recurring(db, org, key="num:1:2026-12", amount=Decimal("3"), **kw) is True
        assert subscriptions.charge_recurring(db, org, key="num:2:2026-12", amount=Decimal("50"), **kw) is False
        db.commit()
    with SessionLocal() as db:
        rec = list(db.scalars(select(WalletTransaction).where(WalletTransaction.organization_id == org,
                                                               WalletTransaction.type == "recurring")))
        assert len(rec) == 1 and rec[0].amount == Decimal("-3")
        assert wl.get_wallet(db, org).balance == Decimal("7")
    # Phone numbers are Signalcraft-managed: nothing about number rental appears on the plan.
    p = owner.get(plan_url(owner)).json()
    assert "numbers" not in p["recurring"] and "numbers" not in p["next_charge"]
    assert "included_numbers" not in p and "phone_numbers" not in p["limits"]
    assert p["recurring"]["total"] == p["next_charge"]["total"] == 0
    assert not any("number" in f for c in p["catalogue"] for f in c["features"])
    assert "phone_numbers" not in p["usage"]


@pytest.mark.parametrize("day,expected", [(31, 28), (15, 15)])
def test_add_month_clamps(day, expected):
    from datetime import UTC, datetime

    assert subscriptions.add_month(datetime(2026, 1, day, tzinfo=UTC)).day == expected
