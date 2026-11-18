"""SMS end to end: encoding, India DLT and US 10DLC rules, sending, receipts, keywords, webhooks, access."""
import json
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import pytest
from sqlalchemy import select, update

from app.api.v1.public_email import simulation_signature
from app.core.config import settings
from app.core.database import SessionLocal
from app.models import ApplicationSettings, Contact, SuppressionEntry
from app.models.sms import SmsCampaign, SmsMessage
from app.providers.sms.simulation import outbox_path
from app.providers.sms.twilio import twilio_signature
from app.services.email.render import public_url
from app.services.sms import engine, rules
from app.services.sms.encoding import analyse
from tests.conftest import Api, invite_and_join

IN_BODY = "Hi {{first_name}}, our Diwali sale is live at {{company}}. Shop now!"
IN_DLT = "Hi {#var#}, our Diwali sale is live at {#var#}. Shop now!"


# ------------------------------------------------------------------ pure rules

def test_segment_counting_gsm_unicode_and_extended():
    assert analyse("a" * 160).segments == 1 and analyse("a" * 161).segments == 2
    assert analyse("a" * 306).segments == 2 and analyse("a" * 307).segments == 3
    ext = analyse("€" * 80)  # extended GSM characters use two units each
    assert ext.encoding == "GSM-7" and ext.units == 160 and ext.segments == 1
    hindi = analyse("नमस्ते " * 11)  # 77 UCS-2 characters
    assert hindi.encoding == "UCS-2" and hindi.per_segment == 67 and hindi.segments == 2
    assert analyse("Hi 😊").encoding == "UCS-2" and analyse("Hi 😊").non_gsm == ("😊",)


def test_sender_formats_dlt_matching_quiet_hours_and_opt_out():
    assert rules.validate_sender("IN", "promotional", "561234") is None
    assert rules.validate_sender("IN", "promotional", "ACMEIN")
    assert rules.validate_sender("IN", "transactional", "ACMEIN") is None
    assert rules.validate_sender("IN", "service", "ACME12")
    assert rules.validate_sender("US", "long_code", "+14155552671") is None
    assert rules.validate_sender("US", "short_code", "12345") is None
    assert rules.validate_sender("US", "toll_free", "8005551234")
    assert rules.validate_sender("GB", "long_code", "+447700900123")

    assert rules.matches_dlt(IN_BODY, IN_DLT)
    assert rules.matches_dlt("Hi  {{ first_name }},  our Diwali sale is live at {{company}}. Shop now!", IN_DLT)
    assert not rules.matches_dlt("Hi {{first_name}}, our sale is live at {{company}}. Shop now!", IN_DLT)

    # 21:00 → 09:00 in Kolkata. 22:30 IST (17:00 UTC) is quiet until 09:00 IST (03:30 UTC) next day.
    at = datetime(2026, 3, 10, 17, 0, tzinfo=UTC)
    assert rules.quiet_until(at, "Asia/Kolkata", "21:00", "09:00") == datetime(2026, 3, 11, 3, 30, tzinfo=UTC)
    assert rules.quiet_until(datetime(2026, 3, 10, 6, 0, tzinfo=UTC), "Asia/Kolkata", "21:00", "09:00") is None
    # 07:00 in New York is quiet until 09:00 the same day.
    ny = rules.quiet_until(datetime(2026, 7, 1, 11, 0, tzinfo=UTC), "America/New_York", "21:00", "09:00")
    assert ny == datetime(2026, 7, 1, 13, 0, tzinfo=UTC)

    assert rules.final_body("Sale!", country="US", category="promotional", append_opt_out=True).endswith(
        "Reply STOP to opt out")
    assert rules.final_body("Sale! Text STOP to quit", country="US", category="promotional",
                            append_opt_out=True) == "Sale! Text STOP to quit"
    assert rules.final_body("Sale!", country="IN", category="promotional", append_opt_out=True) == "Sale!"


# ------------------------------------------------------------------ fixtures

def _no_quiet_hours(app_id: str) -> None:
    with SessionLocal() as db:
        db.execute(update(ApplicationSettings).where(ApplicationSettings.application_id == app_id)
                   .values(quiet_hours_start="00:00", quiet_hours_end="00:00"))
        db.commit()


@pytest.fixture
def india(owner):
    r = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "SMS India",
                                           "default_country": "IN", "timezone": "Asia/Kolkata"})
    owner.app_id = r.json()["id"]
    owner.base = f"/apps/{owner.app_id}"
    owner.s = f"{owner.base}/sms"
    _no_quiet_hours(owner.app_id)
    owner.contacts = {}
    for name, phone, consent in [("Asha", "+919876543210", True), ("Ravi", "+919876512345", True),
                                 ("Dnd", "+919876500000", True), ("Reject", "+919876511111", True),
                                 ("Noconsent", "+919876522222", False), ("Bob", "+14155552671", True)]:
        body = {"first_name": name, "phone": phone, "company": "Acme Super Bazaar and General Stores Private Ltd"}
        if consent:
            body["consent"] = {"sms": True, "source": "In-store form",
                               "evidence": "Signed paper form, March 2026" if phone.startswith("+1") else None}
        r = owner.post(f"{owner.base}/contacts", json=body)
        assert r.status_code == 201, r.text
        owner.contacts[name] = r.json()["id"]
    return owner


def ready_india(a) -> dict:
    """Register DLT, add and confirm a header, create a matching template and a campaign."""
    r = a.put(f"{a.s}/registration", json={"principal_entity_id": "1101456789012345678", "entity_name": "Acme",
                                          "dlt_platform": "Jio", "attest": True})
    assert r.status_code == 200 and r.json()["attested_at"], r.text
    s = a.post(f"{a.s}/senders", json={"sender_id": "561234", "country": "IN", "kind": "promotional"})
    assert s.status_code == 201 and s.json()["status"] == "pending" and s.json()["is_default"]
    a.sender_id = s.json()["id"]
    assert a.post(f"{a.s}/senders/{a.sender_id}/attest").json()["status"] == "active"
    t = a.post(f"{a.s}/templates", json={"name": "Diwali", "category": "promotional", "body": IN_BODY,
                                        "sender_ref": a.sender_id, "dlt_template_id": "1107160000000012345",
                                        "dlt_template_text": IN_DLT})
    assert t.status_code == 201 and t.json()["dlt_match"] is True, t.text
    c = a.post(f"{a.s}/campaigns", json={"name": "Diwali SMS", "template_id": t.json()["id"]}).json()
    assert c["body"] == IN_BODY and c["sender_ref"] == a.sender_id
    r = a.patch(f"{a.s}/campaigns/{c['id']}", json={"audience": {"all": True}})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------ India

def test_india_readiness_blocks_until_dlt_complete(india):
    a = india
    bad = a.post(f"{a.s}/senders", json={"sender_id": "ACMEIN", "country": "IN", "kind": "promotional"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_SENDER_ID"
    s = a.post(f"{a.s}/senders", json={"sender_id": "561234", "country": "IN", "kind": "promotional"}).json()
    c = a.post(f"{a.s}/campaigns", json={"name": "Raw"}).json()
    a.patch(f"{a.s}/campaigns/{c['id']}", json={"body": IN_BODY, "audience": {"all": True}})
    rd = a.get(f"{a.s}/campaigns/{c['id']}/readiness").json()
    failing = {ch["key"] for ch in rd["checks"] if not ch["ok"]}
    assert failing == {"sender", "registration", "dlt_template"}, rd
    assert rd["estimate"]["eligible"] == 4  # four consented Indian mobiles; US number excluded
    assert rd["estimate"]["excluded"]["no_consent"] == 1 and rd["estimate"]["excluded"]["other_country"] == 1
    assert rd["cost"]["currency"] == "INR" and rd["cost"]["total"] == pytest.approx(4 * 0.25)
    r = a.post(f"{a.s}/campaigns/{c['id']}/send")
    assert r.status_code == 422 and r.json()["error"]["code"] == "CAMPAIGN_NOT_READY"
    # A transactional campaign may not use a numeric (promotional) header.
    a.post(f"{a.s}/senders/{s['id']}/attest")
    a.patch(f"{a.s}/campaigns/{c['id']}", json={"category": "transactional"})
    rd = a.get(f"{a.s}/campaigns/{c['id']}/readiness").json()
    assert "category" in {ch["key"] for ch in rd["checks"] if not ch["ok"]}


def test_india_send_receipts_cost_and_truncation(india):
    a = india
    c = ready_india(a)
    rd = a.get(f"{a.s}/campaigns/{c['id']}/readiness").json()
    assert rd["ready"], rd
    r = a.post(f"{a.s}/campaigns/{c['id']}/send")
    assert r.status_code == 200, r.text
    out = a.get(f"{a.s}/campaigns/{c['id']}").json()
    assert out["status"] == "completed" and out["provider"] == "simulation" and out["recipient_count"] == 4
    assert out["sender_snapshot"]["dlt_template_id"] == "1107160000000012345" and out["currency"] == "INR"
    st = out["stats"]
    assert (st["sent"], st["delivered"], st["undelivered"], st["failed"]) == (3, 2, 1, 1)
    assert st["cost"] == pytest.approx(0.75)  # three accepted single-segment texts at ₹0.25
    msgs = {m["to_phone"]: m for m in a.get(f"{a.s}/campaigns/{c['id']}/messages").json()["items"]}
    assert msgs["+919876511111"]["status"] == "failed" and msgs["+919876500000"]["status"] == "undelivered"
    with SessionLocal() as db:
        body = db.scalar(select(SmsMessage.body).where(SmsMessage.to_phone == "+919876543210"))
    assert body == "Hi Asha, our Diwali sale is live at Acme Super Bazaar and General. Shop now!"  # 30-char cap
    files = [json.loads(f.read_text()) for f in outbox_path().glob("*.json")]
    assert any(f["to"] == "+919876543210" and f["dlt_template_id"] == "1107160000000012345" for f in files)
    rep = a.get(f"{a.s}/campaigns/{c['id']}/report").json()
    assert rep["simulated"] and rep["rates"]["delivery_rate"] == pytest.approx(66.67)
    assert {x["status"] for x in rep["failure_reasons"]} == {"failed", "undelivered"}
    assert a.patch(f"{a.s}/campaigns/{c['id']}", json={"name": "x"}).status_code == 409
    ov = a.get(f"{a.s}/overview").json()
    assert ov["last_30_days"]["sent"] == 3 and ov["last_30_days"]["spend"] == {"INR": 0.75}
    assert ov["registration"]["india"] is True


def test_quiet_hours_defer_then_resume(india):
    a = india
    c = ready_india(a)
    with SessionLocal() as db:
        db.execute(update(ApplicationSettings).where(ApplicationSettings.application_id == a.app_id)
                   .values(quiet_hours_start="00:00", quiet_hours_end="23:59"))
        db.execute(update(Contact).where(Contact.application_id == a.app_id).values(timezone="UTC"))
        db.commit()
    now = datetime.now(UTC)
    if now.hour == 23 and now.minute >= 58:
        pytest.skip("too close to the end of the test quiet window")
    a.post(f"{a.s}/campaigns/{c['id']}/send")
    out = a.get(f"{a.s}/campaigns/{c['id']}").json()
    assert out["status"] == "sending" and out["stats"]["deferred"] == 4 and out["stats"]["sent"] == 0
    rep = a.get(f"{a.s}/campaigns/{c['id']}/report").json()
    assert rep["deferred"][0]["reason"] == "quiet_hours" and rep["deferred"][0]["count"] == 4
    # Nothing is due yet, so the scheduler leaves it alone.
    assert engine.dispatch_due() == 0
    with SessionLocal() as db:
        db.execute(update(SmsMessage).where(SmsMessage.campaign_id == c["id"])
                   .values(next_attempt_at=datetime.now(UTC) - timedelta(seconds=1)))
        db.execute(update(ApplicationSettings).where(ApplicationSettings.application_id == a.app_id)
                   .values(quiet_hours_start="00:00", quiet_hours_end="00:00"))
        db.commit()
    assert engine.dispatch_due() == 1
    out = a.get(f"{a.s}/campaigns/{c['id']}").json()
    assert out["status"] == "completed" and out["stats"]["sent"] == 3 and out["stats"]["deferred"] == 0


def test_lifecycle_schedule_cancel_and_dispatch(india):
    a = india
    c = ready_india(a)
    when = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    r = a.post(f"{a.s}/campaigns/{c['id']}/schedule", json={"scheduled_at": when, "timezone": "Asia/Kolkata"})
    assert r.status_code == 200 and r.json()["status"] == "scheduled"
    assert a.post(f"{a.s}/campaigns/{c['id']}/unschedule").json()["status"] == "draft"
    a.post(f"{a.s}/campaigns/{c['id']}/schedule", json={"scheduled_at": when, "timezone": "Asia/Kolkata"})
    with SessionLocal() as db:
        db.execute(update(SmsCampaign).where(SmsCampaign.id == c["id"])
                   .values(scheduled_at=datetime.now(UTC) - timedelta(minutes=1)))
        db.commit()
    assert engine.dispatch_due() == 1
    assert a.get(f"{a.s}/campaigns/{c['id']}").json()["status"] == "completed"
    assert a.post(f"{a.s}/campaigns/{c['id']}/cancel").status_code == 409
    dup = a.post(f"{a.s}/campaigns/{c['id']}/duplicate").json()
    assert dup["status"] == "draft" and dup["body"] == IN_BODY
    assert a.delete(f"{a.s}/campaigns/{dup['id']}").status_code == 204
    assert a.delete(f"{a.s}/senders/{a.sender_id}").status_code == 204


# ------------------------------------------------------------------ US

@pytest.fixture
def us(owner):
    r = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "SMS US",
                                           "default_country": "US", "timezone": "America/New_York"})
    owner.app_id = r.json()["id"]
    owner.base = f"/apps/{owner.app_id}"
    owner.s = f"{owner.base}/sms"
    _no_quiet_hours(owner.app_id)
    no_evidence = owner.post(f"{owner.base}/contacts", json={"first_name": "Nope", "phone": "+14155552672",
                                                             "consent": {"sms": True, "source": "Web"}})
    assert no_evidence.status_code == 422 and no_evidence.json()["error"]["code"] == "WRITTEN_CONSENT_REQUIRED"
    r = owner.post(f"{owner.base}/contacts", json={"first_name": "Jane", "phone": "+14155552671", "consent": {
        "sms": True, "source": "Checkout", "evidence": "Unticked checkbox + TCPA disclosure, order 1001"}})
    owner.jane = r.json()["id"]
    return owner


def test_us_requires_10dlc_and_appends_opt_out(us):
    a = us
    s = a.post(f"{a.s}/senders", json={"sender_id": "+14155550100", "country": "US", "kind": "long_code"}).json()
    a.post(f"{a.s}/senders/{s['id']}/attest")
    c = a.post(f"{a.s}/campaigns", json={"name": "Spring"}).json()
    a.patch(f"{a.s}/campaigns/{c['id']}", json={"body": "Hi {{first_name}}, spring sale ends Sunday.",
                                                "append_opt_out": False, "audience": {"all": True}})
    rd = a.get(f"{a.s}/campaigns/{c['id']}/readiness").json()
    assert {ch["key"] for ch in rd["checks"] if not ch["ok"]} == {"registration", "opt_out"}
    assert rd["cost"]["currency"] == "USD"
    a.put(f"{a.s}/registration", json={"us_brand_id": "BXXXXXXX", "us_campaign_id": "CXXXXXXX", "attest": True})
    a.patch(f"{a.s}/campaigns/{c['id']}", json={"append_opt_out": True})
    rd = a.get(f"{a.s}/campaigns/{c['id']}/readiness").json()
    assert rd["ready"], rd
    assert rd["message"]["text"].endswith("Reply STOP to opt out")
    # Changing registration details clears the confirmation.
    a.put(f"{a.s}/registration", json={"us_brand_id": "BYYYYYYY", "us_campaign_id": "CXXXXXXX"})
    assert not a.get(f"{a.s}/campaigns/{c['id']}/readiness").json()["ready"]
    a.put(f"{a.s}/registration", json={"us_brand_id": "BYYYYYYY", "us_campaign_id": "CXXXXXXX", "attest": True})
    a.post(f"{a.s}/campaigns/{c['id']}/send")
    with SessionLocal() as db:
        m = db.scalar(select(SmsMessage).where(SmsMessage.campaign_id == c["id"]))
    assert m.status == "delivered" and m.body == "Hi Jane, spring sale ends Sunday. Reply STOP to opt out"
    t = a.post(f"{a.s}/campaigns/{c['id']}/test", json={"phones": ["+919876543210", "(415) 555-2671"]}).json()
    assert [x["accepted"] for x in t["results"]] == [False, True]


def test_stop_and_start_keywords(us):
    a = us
    a.post(f"{a.s}/senders", json={"sender_id": "+14155550100", "country": "US", "kind": "long_code"})
    r = a.post(f"{a.s}/simulate-inbound", json={"from_phone": "+14155552671", "to_sender": "+14155550100",
                                                "body": "stop", "event_id": "in-1"})
    assert r.status_code == 200 and r.json() == {"keyword": "stop", "contacts_updated": 1}
    ct = a.get(f"{a.base}/contacts/{a.jane}").json()
    assert ct["sms_consent"] is False and ct["sms_unsubscribed_at"]
    # Replaying the same provider event changes nothing.
    assert a.post(f"{a.s}/simulate-inbound", json={"from_phone": "+14155552671", "to_sender": "+14155550100",
                                                   "body": "stop", "event_id": "in-1"}).status_code == 404
    r = a.post(f"{a.s}/simulate-inbound", json={"from_phone": "+14155552671", "to_sender": "+14155550100",
                                                "body": "START", "event_id": "in-2"})
    assert r.json() == {"keyword": "start", "contacts_updated": 1}
    assert a.get(f"{a.base}/contacts/{a.jane}").json()["sms_consent"] is True
    # STOP from an unknown number still suppresses it.
    a.post(f"{a.s}/simulate-inbound", json={"from_phone": "+14155552699", "to_sender": "+14155550100",
                                            "body": "Unsubscribe", "event_id": "in-3"})
    with SessionLocal() as db:
        assert db.scalar(select(SuppressionEntry).where(SuppressionEntry.application_id == a.app_id,
                                                        SuppressionEntry.channel == "sms",
                                                        SuppressionEntry.value_masked.like("%99")))
    inbox = a.get(f"{a.s}/inbound").json()
    assert inbox["total"] == 3 and inbox["items"][-1]["from"] == "+14******671"


# ------------------------------------------------------------------ webhooks

def test_simulation_webhook_signed_receipts(india):
    a = india
    c = ready_india(a)
    a.post(f"{a.s}/campaigns/{c['id']}/send")
    with SessionLocal() as db:
        m = db.scalar(select(SmsMessage).where(SmsMessage.campaign_id == c["id"], SmsMessage.status == "delivered"))
        pmid = m.provider_message_id
    body = json.dumps({"event_id": "sim-1", "kind": "status", "message_id": pmid, "status": "undelivered",
                       "error_code": "30005"}).encode()
    anon = Api()
    bad = anon.client.post("/api/v1/webhooks/sms/simulation", content=body, headers={"x-signature": "nope"})
    assert bad.status_code == 401
    ok = anon.client.post("/api/v1/webhooks/sms/simulation", content=body,
                          headers={"x-signature": simulation_signature(body)})
    assert ok.status_code == 200
    with SessionLocal() as db:
        m = db.scalar(select(SmsMessage).where(SmsMessage.provider_message_id == pmid))
        assert m.status == "undelivered" and m.error_code == "30005"


def test_twilio_signature_and_carrier_opt_out(us, monkeypatch):
    a = us
    s = a.post(f"{a.s}/senders", json={"sender_id": "+14155550100", "country": "US", "kind": "long_code"}).json()
    a.post(f"{a.s}/senders/{s['id']}/attest")
    a.put(f"{a.s}/registration", json={"us_brand_id": "B1", "us_campaign_id": "C1", "attest": True})
    c = a.post(f"{a.s}/campaigns", json={"name": "Hi", "category": "transactional"}).json()
    a.patch(f"{a.s}/campaigns/{c['id']}", json={"body": "Your order shipped.", "audience": {"all": True}})
    a.post(f"{a.s}/campaigns/{c['id']}/send")
    with SessionLocal() as db:
        db.execute(update(SmsMessage).where(SmsMessage.campaign_id == c["id"])
                   .values(provider="twilio", provider_message_id="SM123", status="accepted", delivered_at=None))
        db.commit()
    monkeypatch.setattr(settings, "TWILIO_AUTH_TOKEN", "tw-secret")
    url = public_url("/webhooks/sms/twilio/status")
    params = {"MessageSid": "SM123", "MessageStatus": "failed", "ErrorCode": "21610"}
    anon = Api()
    hdr = {"content-type": "application/x-www-form-urlencoded"}
    r = anon.client.post("/api/v1/webhooks/sms/twilio/status", content=urlencode(params),
                         headers={**hdr, "x-twilio-signature": "forged"})
    assert r.status_code == 401
    r = anon.client.post("/api/v1/webhooks/sms/twilio/status", content=urlencode(params),
                         headers={**hdr, "x-twilio-signature": twilio_signature("tw-secret", url, params)})
    assert r.status_code == 204
    ct = a.get(f"{a.base}/contacts/{a.jane}").json()
    assert ct["sms_consent"] is False  # 21610: the recipient had opted out at the carrier


# ------------------------------------------------------------------ access

def test_permissions_and_isolation(india):
    a = india
    c = ready_india(a)
    viewer = invite_and_join(a, "viewer@example.com", "viewer", [a.app_id])
    assert viewer.get(f"{a.s}/campaigns").status_code == 200
    assert viewer.post(f"{a.s}/senders", json={"sender_id": "ACMEIN", "country": "IN",
                                               "kind": "service"}).status_code == 403
    assert viewer.post(f"{a.s}/campaigns/{c['id']}/send").status_code == 403
    assert viewer.post(f"{a.s}/simulate-inbound", json={"from_phone": "+919876543210", "to_sender": "561234",
                                                        "body": "STOP", "event_id": "x"}).status_code == 403
    other = Api().register("other@example.com", "Other")
    org = other.post("/organizations", json={"name": "Other Org"}).json()
    other.post("/applications", json={"organization_id": org["id"], "name": "Theirs"})
    assert other.get(f"{a.s}/campaigns/{c['id']}").status_code in (403, 404)
    assert other.get(f"{a.s}/registration").status_code in (403, 404)
