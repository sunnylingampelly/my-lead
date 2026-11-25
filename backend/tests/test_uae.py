"""United Arab Emirates (AE): AED wallet, prices and plan, FX through USD, TRN-only sales with reverse-charge
invoices, Razorpay checkout in AED, SMS and voice rules behind their kill switches, Arabic segment counting and
the public AED price list."""
import io
import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pypdf
import pytest
from sqlalchemy import select, update

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import ApplicationSettings, Contact
from app.models.sms import SmsMessage
from app.models.voice import VoiceCall, VoiceCampaign, VoiceEvent
from app.providers import payments as pp
from app.services import uae
from app.services.billing import gst, plans
from app.services.billing import wallet as wl
from app.services.sms import engine as sms_engine
from app.services.sms import rules as sms_rules
from app.services.sms.encoding import analyse
from app.services.voice import rules as voice_rules
from tests.conftest import Api

TRN = "100123456700003"
UAE_PROFILE = {"legal_name": "Falcon Trading LLC", "address": "Office 1201, Bay Square\nBusiness Bay",
               "city": "Dubai", "emirate": "Dubai", "trn": "100-1234-5670-0003", "email": "accounts@falcon.example"}


class FakeResp:
    def __init__(self, status: int, body: dict):
        self.status_code, self._body = status, body
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self._body


def uae_org(api_factory, email: str = "omar@example.com") -> Api:
    a = api_factory().register(email, "Omar")
    a.org = a.post("/organizations", json={"name": "Falcon Trading", "country": "AE"}).json()
    a.b = f"/organizations/{a.org['id']}/billing"
    return a


def uae_app(a: Api) -> Api:
    r = a.post("/applications", json={"organization_id": a.org["id"], "name": "Dubai", "default_country": "AE",
                                      "timezone": "Asia/Dubai"})
    assert r.status_code == 201, r.text
    a.app_id = r.json()["id"]
    a.base = f"/apps/{a.app_id}"
    with SessionLocal() as db:
        db.execute(update(ApplicationSettings).where(ApplicationSettings.application_id == a.app_id)
                   .values(quiet_hours_start="00:00", quiet_hours_end="00:00"))
        db.commit()
    return a


# ------------------------------------------------------------------ money

def test_currency_fx_through_usd_and_plan_prices():
    assert (wl.currency_for("AE"), wl.currency_for("ae"), wl.currency_for("IN"), wl.currency_for("GB"),
            wl.currency_for(None)) == ("AED", "AED", "INR", "USD", "USD")
    assert wl.convert(10, "USD", "AED") == Decimal("36.7250")
    assert wl.convert("36.725", "AED", "USD") == Decimal("10.0000")
    # No direct INR/AED pair: through USD (83 INR = 1 USD = 3.6725 AED).
    assert wl.convert(83, "INR", "AED") == Decimal("3.6725")
    assert wl.convert("3.6725", "AED", "INR") == Decimal("83.0000")
    assert plans.plan_price(plans.PRO, "AED") == Decimal("179")
    assert plans.plan_price(plans.STARTER, "AED") == Decimal("0")
    for table in ("EMAIL_PRICING", "SMS_PRICING", "VOICE_PRICING", "VOICE_AI_PRICING", "CHAT_AI_PRICING"):
        assert getattr(settings, table)["AE"]["currency"] == "AED", table
    assert gst.amount_in_words(Decimal("179.50"), "AED") == "UAE Dirhams One Hundred Seventy Nine and Fifty Fils Only"


def test_uae_org_gets_aed_wallet_prices_and_plan(api_factory):
    a = uae_org(api_factory)
    s = a.get(a.b).json()
    assert s["currency"] == "AED" and s["balance"] == settings.TRIAL_CREDIT["AED"]
    assert s["low_balance_threshold"] == settings.LOW_BALANCE_DEFAULT["AED"]
    rows = {r["country"]: r for r in s["pricing"]}
    assert set(rows) == {"IN", "AE", "US"}
    assert rows["AE"]["email"] == pytest.approx(0.004) and rows["AE"]["chat_reply"] == pytest.approx(0.22)
    assert rows["US"]["email"] == pytest.approx(0.0037)  # USD 0.001 shown in AED
    catalogue = {p["key"]: p for p in a.get(f"{a.b}/plan").json()["catalogue"]}
    assert (catalogue["pro"]["price"], catalogue["pro"]["currency"]) == (179, "AED")
    assert catalogue["starter"]["price"] == 0
    regions = {r["code"]: r for r in a.get("/regions").json()}
    assert regions["AE"]["currency"] == "AED" and regions["AE"]["default_timezone"] == "Asia/Dubai"
    assert regions["AE"]["dial_code"] == "+971" and regions["AE"]["business_days"] == [0, 1, 2, 3, 4]


def test_public_pricing_in_aed():
    r = Api().client.get("/api/v1/public/pricing?currency=AED")
    assert r.status_code == 200, r.text
    p = r.json()
    assert (p["currency"], p["market"], p["gst_rate"], p["reverse_charge"]) == ("AED", "AE", None, True)
    assert p["channels"] == {"sms": False, "voice": False}  # coming soon
    assert {x["key"]: x["price"] for x in p["plans"]}["pro"] == 179
    assert p["rates"]["email"] == pytest.approx(0.004) and p["rates"]["voice_ai_minute"] == pytest.approx(4.75)
    assert p["rates"]["voice_minute"] == pytest.approx(3.50) and p["rates"]["chat_reply"] == pytest.approx(0.22)
    assert p["rates"]["ai_assistant_message_from"] == 0.05 and p["rates"]["ai_assistant_message_typical"] == 0.15
    assert p["rates"]["ai_agent_run_typical"] == 0.45 and p["topup_min"] == 50
    assert Api().client.get("/api/v1/public/pricing?currency=EUR").status_code == 422


def test_uae_contact_phone_and_region(api_factory):
    a = uae_app(uae_org(api_factory, "dina@example.com"))
    r = a.post(f"{a.base}/contacts", json={"first_name": "Layla", "phone": "050 123 4567"})
    assert r.status_code == 201, r.text
    c = a.get(f"{a.base}/contacts/{r.json()['id']}").json()
    assert c["phone"] == "+971501234567" and c["phone_country"] == "AE"
    assert c["jurisdiction_name"] == "United Arab Emirates" and c["timezone"] == "Asia/Dubai"
    comp = a.get(f"/applications/{a.app_id}/compliance").json()
    assert comp["region"] == "AE" and comp["currency"] == "AED" and comp["marketing_window"] == ["09:00", "18:00"]
    names = " ".join(x["name"] for x in comp["regulations"])
    assert "Resolution 56" in names and "Personal Data Protection Law" in names and "TDRA" in names
    assert {n["key"] for n in comp["notices"]} == {"uae_sms", "uae_voice"}


# ------------------------------------------------------------------ TRN, reverse charge, Razorpay AED

@pytest.fixture
def live_aed(api_factory, monkeypatch):
    monkeypatch.setattr(settings, "COMMUNICATION_MODE", "live")
    for k, v in (("RAZORPAY_KEY_ID", "rzp_test"), ("RAZORPAY_KEY_SECRET", "secret"), ("RAZORPAY_WEBHOOK_SECRET", "hook"),
                 ("SELLER_LEGAL_NAME", "Signalcraft Technologies Pvt Ltd"), ("SELLER_GSTIN", "29AAPFU0939F1ZR"),
                 ("SELLER_STATE_CODE", "29"), ("SELLER_LUT_NUMBER", "AD290000000000X")):
        monkeypatch.setattr(settings, k, v)
    sent: list[dict] = []

    def fake_post(url, json=None, auth=None, timeout=None, **kw):
        sent.append(json)
        return FakeResp(200, {"id": f"plink_ae_{len(sent)}", "short_url": "https://rzp.io/i/aed"})

    monkeypatch.setattr(pp.httpx, "post", fake_post)
    a = uae_org(api_factory, "farah@example.com")
    a.sent = sent
    return a


def test_billing_details_require_a_valid_trn_and_emirate(live_aed):
    a = live_aed
    prof = a.get(f"{a.b}/profile").json()
    assert prof["required"] and prof["trn_required"] and "Ras Al Khaimah" in prof["emirates"]
    for bad, code in (({"trn": ""}, "INVALID_TRN"), ({"trn": "200123456700003"}, "INVALID_TRN"),
                      ({"trn": "10012345670000"}, "INVALID_TRN"), ({"emirate": "Doha"}, "INVALID_BILLING_PROFILE"),
                      ({"email": "nope"}, "INVALID_BILLING_PROFILE"), ({"legal_name": "  "}, "INVALID_BILLING_PROFILE"),
                      ({"address": "  "}, "INVALID_BILLING_PROFILE")):
        r = a.put(f"{a.b}/profile", json={**UAE_PROFILE, **bad})
        assert r.status_code == 422 and r.json()["error"]["code"] == code, (bad, r.text)
    r = a.put(f"{a.b}/profile", json={**UAE_PROFILE, "gstin": "27AAPFU0939F1ZV", "emirate": "dubai"})
    assert r.status_code == 200, r.text
    p = r.json()
    assert (p["trn"], p["emirate"], p["country"], p["gstin"], p["state_code"]) == (TRN, "Dubai", "AE", None, None)


def test_aed_top_up_blocked_without_trn_then_reverse_charge_invoice(live_aed):
    a = live_aed
    q = a.get(f"{a.b}/quote?amount=500").json()
    assert (q["currency"], q["tax"], q["total"], q["reverse_charge"], q["trn_required"]) == ("AED", 0, 500, True, True)
    r = a.post(f"{a.b}/checkout", json={"amount": "500"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "UAE_TRN_REQUIRED"
    assert "VAT-registered UAE businesses" in r.json()["error"]["message"]
    assert not a.sent  # Razorpay was never called
    a.put(f"{a.b}/profile", json=UAE_PROFILE)
    q = a.get(f"{a.b}/quote?amount=500").json()
    assert (q["tax"], q["cgst"], q["sgst"], q["igst"], q["treatment"]) == (0, 0, 0, 0, "export_lut")
    assert q["trn_required"] is False and q["profile_ready"] is True
    r = a.post(f"{a.b}/checkout", json={"amount": "500"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert a.sent[-1]["currency"] == "AED" and a.sent[-1]["amount"] == 50000  # AED 500 in fils
    assert "GST" not in a.sent[-1]["description"]
    pay = a.get(f"{a.b}/payments/{pid}").json()
    assert (pay["amount"], pay["tax_amount"], pay["gross_amount"], pay["currency"]) == (500, 0, 500, "AED")

    def webhook(fils: int, currency: str, event_id: str):
        body = json.dumps({"event": "payment_link.paid", "created_at": 1, "payload": {
            "payment_link": {"entity": {"id": "plink_ae_1", "amount_paid": fils, "currency": currency,
                                        "notes": {"payment_id": pid}}},
            "payment": {"entity": {"id": f"pay_{event_id}", "amount": fils, "currency": currency}}}}).encode()
        r = Api().client.post("/api/v1/webhooks/payments/razorpay", content=body,
                              headers={"x-razorpay-signature": pp.razorpay_signature("hook", body),
                                       "x-razorpay-event-id": event_id})
        assert r.status_code == 200, r.text

    webhook(500, "AED", "ae1")  # AED 5.00, not 500.00: the fils check refuses it
    assert a.get(f"{a.b}/payments/{pid}").json()["status"] == "failed"
    with SessionLocal() as db:  # reset for the genuine payment
        from app.models.payment import Payment

        p = db.get(Payment, pid)
        p.status, p.failure_reason = "pending", None
        db.commit()
    webhook(50000, "AED", "ae2")
    pay = a.get(f"{a.b}/payments/{pid}").json()
    assert pay["status"] == "paid" and pay["invoice_id"]
    assert a.get(a.b).json()["balance"] == 500  # live mode: no trial credit
    inv = a.get(f"{a.b}/invoices").json()["items"][0]
    fy = gst.financial_year(datetime.now(UTC))
    assert inv["number"].startswith(f"SC/{fy[2:4]}-{fy[5:7]}/")  # the same Indian series
    assert (inv["currency"], inv["tax"], inv["total"], inv["tax_treatment"]) == ("AED", 0, 500, "export_lut")
    pdf = a.client.get(f"/api/v1{a.b}/invoices/{inv['id']}.pdf", headers=a.headers).content
    text = pypdf.PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
    for needle in ("EXPORT OF SERVICES", f"TRN: {TRN}", "Supply meant for export under LUT without payment of IGST",
                   "Reverse charge - the recipient accounts for UAE VAT", "No UAE VAT is charged",
                   "AED 500.00", "UAE Dirhams Five Hundred Only", "Dubai", "United Arab Emirates", "AD290000000000X"):
        assert needle in text, needle
    assert "VAT @" not in text and "Whether tax is payable on reverse charge: No" not in text


# ------------------------------------------------------------------ SMS

def test_uae_sms_rules():
    assert sms_rules.validate_sender("AE", "promotional", "AD-FALCON") is None
    assert sms_rules.validate_sender("AE", "promotional", "FALCON")  # no AD- prefix
    assert sms_rules.validate_sender("AE", "promotional", "AD-FALCONTRD")  # 12 characters
    assert sms_rules.validate_sender("AE", "promotional", "AD-FALCONTR") is None  # 11 characters
    assert sms_rules.validate_sender("AE", "transactional", "FALCON") is None
    assert sms_rules.validate_sender("AE", "transactional", "AD-FALCON")
    # Opt-out text: English, or Arabic for an Arabic message; never twice.
    en = sms_rules.final_body("Eid sale today!", country="AE", category="promotional", append_opt_out=False)
    assert en == "Eid sale today!\nTo opt out reply STOP"
    ar = sms_rules.final_body("تخفيضات العيد اليوم", country="AE", category="promotional", append_opt_out=True)
    assert ar.endswith(settings.SMS_UAE_OPT_OUT_AR)
    assert sms_rules.final_body("Sale! Reply STOP to opt out", country="AE", category="promotional",
                                append_opt_out=True) == "Sale! Reply STOP to opt out"
    assert sms_rules.final_body("Your code is 1234", country="AE", category="transactional",
                                append_opt_out=True) == "Your code is 1234"
    # Promotional texts wait for 07:00 Dubai: 22:00 Dubai (18:00 UTC) resumes at 03:00 UTC the next day.
    night = datetime(2026, 12, 1, 18, 0, tzinfo=UTC)
    no_quiet = ("00:00", "00:00")
    assert sms_rules.promo_resume_at(night, "AE", "Asia/Dubai", no_quiet) == datetime(2026, 12, 2, 3, 0, tzinfo=UTC)
    assert sms_rules.promo_resume_at(datetime(2026, 12, 1, 6, 0, tzinfo=UTC), "AE", "Asia/Dubai", no_quiet) is None
    assert sms_rules.promo_resume_at(night, "IN", "Asia/Kolkata", no_quiet) is None  # India: app quiet hours only
    assert uae.has_url("Shop at www.falcon.ae now") and uae.has_url("https://x.test") and not uae.has_url("Hello")


def test_arabic_segment_counting():
    one = analyse("م" * 70)
    assert (one.encoding, one.segments, one.per_segment) == ("UCS-2", 1, 70)
    two = analyse("م" * 71)
    assert (two.segments, two.per_segment) == (2, 67)
    assert analyse("م" * 134).segments == 2 and analyse("م" * 135).segments == 3
    mixed = analyse("Eid Mubarak! عيد مبارك")
    assert mixed.encoding == "UCS-2" and mixed.segments == 1


def _uae_contacts(a: Api, channel: str) -> dict:
    out = {}
    for name, phone in (("Layla", "+971501234567"), ("Khalid", "+971551234567")):
        r = a.post(f"{a.base}/contacts", json={"first_name": name, "phone": phone, "consent": {
            channel: True, "source": "Website form", "evidence": "Opt-in checkbox, Nov 2026"}})
        assert r.status_code == 201, r.text
        out[name] = r.json()["id"]
    return out


def test_uae_sms_kill_switch_then_rules_when_enabled(api_factory, monkeypatch):
    a = uae_app(uae_org(api_factory, "sara@example.com"))
    a.s = f"{a.base}/sms"
    _uae_contacts(a, "sms")
    ov = a.get(f"{a.s}/overview").json()
    assert ov["setup"]["coming_soon"] == uae.SMS_COMING_SOON and ov["setup"]["market_rules"]
    r = a.post(f"{a.s}/senders", json={"sender_id": "AD-FALCON", "country": "AE", "kind": "promotional"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "UAE_SMS_COMING_SOON"
    c = a.post(f"{a.s}/campaigns", json={"name": "Eid"}).json()
    a.patch(f"{a.s}/campaigns/{c['id']}", json={"body": "Eid offers at www.falcon.ae", "audience": {"all": True}})
    rd = a.get(f"{a.s}/campaigns/{c['id']}/readiness").json()
    assert rd["country"] == "AE" and not rd["ready"]
    off = {ch["key"]: ch for ch in rd["checks"]}["uae_available"]
    assert not off["ok"] and off["detail"] == uae.SMS_COMING_SOON
    assert rd["cost"]["currency"] == "AED"
    dash = {i["key"]: i for i in a.get(f"/apps/{a.app_id}/dashboard").json()["checklist"]}
    assert dash["sms_setup"]["label"] == "SMS for the UAE: coming soon" and dash["sms_setup"]["optional"]

    # Switched on: the UAE rules apply.
    monkeypatch.setattr(settings, "SMS_UAE_ENABLED", True)
    bad = a.post(f"{a.s}/senders", json={"sender_id": "FALCON", "country": "AE", "kind": "promotional"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_SENDER_ID"
    s = a.post(f"{a.s}/senders", json={"sender_id": "AD-FALCON", "country": "AE", "kind": "promotional"}).json()
    a.post(f"{a.s}/senders/{s['id']}/attest")
    a.patch(f"{a.s}/campaigns/{c['id']}", json={"sender_ref": s["id"]})
    rd = a.get(f"{a.s}/campaigns/{c['id']}/readiness").json()
    failing = {ch["key"]: ch for ch in rd["checks"] if not ch["ok"]}
    assert set(failing) == {"uae_attestation", "uae_links"}, failing
    assert failing["uae_links"]["warning"] is True  # a warning: never blocks on its own
    r = a.put(f"{a.s}/registration", json={"uae_attest": True})
    assert r.status_code == 200 and r.json()["uae_attested_at"] and r.json()["uae_attested_by_name"] == "Omar"
    a.patch(f"{a.s}/campaigns/{c['id']}", json={"body": "عروض العيد في متجرنا"})
    rd = a.get(f"{a.s}/campaigns/{c['id']}/readiness").json()
    assert rd["ready"], rd
    assert rd["message"]["text"].endswith(settings.SMS_UAE_OPT_OUT_AR) and rd["message"]["encoding"] == "UCS-2"
    # 22:00 in Dubai: promotional texts are deferred to 07:00.
    monkeypatch.setattr(sms_engine, "utcnow", lambda: datetime(2026, 12, 1, 18, 0, tzinfo=UTC))
    assert a.post(f"{a.s}/campaigns/{c['id']}/send").status_code == 200
    with SessionLocal() as db:
        msgs = list(db.scalars(select(SmsMessage).where(SmsMessage.campaign_id == c["id"])))
    assert len(msgs) == 2 and all(m.status == "deferred" and m.deferred_reason == "quiet_hours" for m in msgs)
    assert all(m.next_attempt_at == datetime(2026, 12, 2, 3, 0, tzinfo=UTC) for m in msgs)
    # Switched off again: nothing is sent, even for queued messages.
    monkeypatch.setattr(settings, "SMS_UAE_ENABLED", False)
    monkeypatch.setattr(sms_engine, "utcnow", lambda: datetime(2026, 12, 2, 6, 0, tzinfo=UTC))
    with SessionLocal() as db:
        db.execute(update(SmsMessage).where(SmsMessage.campaign_id == c["id"]).values(next_attempt_at=None))
        db.commit()
    sms_engine.send(c["id"])
    with SessionLocal() as db:
        msgs = list(db.scalars(select(SmsMessage).where(SmsMessage.campaign_id == c["id"])))
    assert all(m.status == "skipped" and m.error_message == uae.SMS_COMING_SOON for m in msgs)


# ------------------------------------------------------------------ voice

def test_uae_calling_window_weekdays_only():
    no_quiet = ("00:00", "00:00")
    # Tuesday 08:00 Dubai (04:00 UTC): wait for 09:00 Dubai (05:00 UTC), for every category.
    tue8 = datetime(2026, 12, 1, 4, 0, tzinfo=UTC)
    for category in ("promotional", "transactional", "service"):
        assert voice_rules.next_allowed(tue8, "Asia/Dubai", "AE", category, no_quiet) == \
            datetime(2026, 12, 1, 5, 0, tzinfo=UTC)
    assert voice_rules.next_allowed(datetime(2026, 12, 1, 10, 0, tzinfo=UTC), "Asia/Dubai", "AE", "promotional",
                                    no_quiet) is None  # 14:00 Tuesday
    # Friday 18:30 Dubai: closed until Monday 09:00 (Saturday and Sunday are blocked).
    fri = datetime(2026, 12, 4, 14, 30, tzinfo=UTC)
    assert voice_rules.next_allowed(fri, "Asia/Dubai", "AE", "promotional", no_quiet) == \
        datetime(2026, 12, 7, 5, 0, tzinfo=UTC)
    sat_noon = datetime(2026, 12, 5, 8, 0, tzinfo=UTC)
    assert voice_rules.next_allowed(sat_noon, "Asia/Dubai", "AE", "transactional", no_quiet) == \
        datetime(2026, 12, 7, 5, 0, tzinfo=UTC)
    # The window is UAE time even if the contact's time zone says otherwise.
    assert voice_rules.next_allowed(tue8, "Asia/Kolkata", "AE", "promotional", no_quiet) == \
        datetime(2026, 12, 1, 5, 0, tzinfo=UTC)
    # App quiet hours still narrow it: quiet until 11:00 Dubai (07:00 UTC).
    assert voice_rules.next_allowed(tue8, "Asia/Dubai", "AE", "promotional", ("21:00", "11:00")) == \
        datetime(2026, 12, 1, 7, 0, tzinfo=UTC)
    assert voice_rules.validate_caller("AE", "local", "+97142345678")  # own UAE numbers: not supported yet
    assert "ar-AE" in voice_rules.LANGUAGES and voice_rules.opt_out_prompt("ar-AE").endswith("9.")
    assert uae.recording_notice("Falcon") == ("This call is recorded. You're speaking with an AI assistant for "
                                              "Falcon.")


@pytest.fixture
def uae_voice(api_factory):
    a = uae_app(uae_org(api_factory, "nadia@example.com"))
    a.v = f"{a.base}/voice"
    a.contacts = _uae_contacts(a, "voice")
    t = a.post(f"{a.v}/audio/tts", json={"name": "Offer", "tts_text": "Hello {{first_name}}, our offer ends soon.",
                                         "tts_language": "en-US"})
    assert t.status_code == 201, t.text
    a.camp = a.post(f"{a.v}/campaigns", json={"name": "Offer calls", "audio_id": t.json()["id"]}).json()
    a.patch(f"{a.v}/campaigns/{a.camp['id']}", json={"audience": {"all": True}})
    return a


def test_uae_voice_kill_switch_and_coming_soon(uae_voice, monkeypatch):
    a = uae_voice
    rd = a.get(f"{a.v}/campaigns/{a.camp['id']}/readiness").json()
    assert not rd["ready"]
    off = {ch["key"]: ch for ch in rd["checks"]}["uae_available"]
    assert not off["ok"] and off["detail"] == uae.VOICE_COMING_SOON and off["meta"]["rules"]
    r = a.post(f"{a.v}/campaigns/{a.camp['id']}/send")
    assert r.status_code == 422 and r.json()["error"]["code"] == "CAMPAIGN_NOT_READY"
    t = a.post(f"{a.v}/campaigns/{a.camp['id']}/test", json={"phones": ["+971501234567"]})
    assert t.status_code == 422 and uae.VOICE_COMING_SOON in t.json()["error"]["message"]
    setup = a.get(f"{a.v}/overview").json()["setup"]
    assert setup["coming_soon"] == uae.VOICE_COMING_SOON and setup["market_rules"]
    # Even switched on, calls need the customer's own UAE number, which isn't supported yet.
    monkeypatch.setattr(settings, "VOICE_UAE_ENABLED", True)
    rd = a.get(f"{a.v}/campaigns/{a.camp['id']}/readiness").json()
    calling = {ch["key"]: ch for ch in rd["checks"]}["calling"]
    assert not calling["ok"] and "own licensed UAE number" in calling["detail"]


def _history(a: Api, contact_id: str, placed_at: list[datetime], **call_fields) -> None:
    """Earlier calls to a contact from another campaign (what a workflow or campaign left behind)."""
    with SessionLocal() as db:
        other = VoiceCampaign(organization_id=a.org["id"], application_id=a.app_id, name="Earlier",
                              category="promotional", status="completed", audience={})
        db.add(other)
        db.flush()
        call = VoiceCall(organization_id=a.org["id"], application_id=a.app_id, campaign_id=other.id,
                         contact_id=contact_id, to_phone="+971501234567", country="AE", status="no_answer",
                         attempts=len(placed_at), **call_fields)
        db.add(call)
        db.flush()
        for i, at in enumerate(placed_at):
            db.add(VoiceEvent(organization_id=a.org["id"], application_id=a.app_id, campaign_id=other.id,
                              call_id=call.id, contact_id=contact_id, type="placed", provider="simulation",
                              provider_event_id=f"{call.id}:{i}:placed", occurred_at=at))
        db.commit()


def test_uae_retry_limits_refusal_and_dncr(uae_voice):
    a = uae_voice
    layla, khalid = a.contacts["Layla"], a.contacts["Khalid"]
    now = datetime(2026, 12, 3, 8, 0, tzinfo=UTC)  # Thursday 12:00 Dubai
    with SessionLocal() as db:
        contact = db.get(Contact, layla)
        assert voice_rules.uae_contact_block(db, contact, now) == (None, None)
    # Called this morning (another campaign or workflow): no second call today.
    _history(a, layla, [now - timedelta(hours=2)])
    with SessionLocal() as db:
        why, when = voice_rules.uae_contact_block(db, db.get(Contact, layla), now)
    assert "today" in why and when == datetime(2026, 12, 3, 20, 0, tzinfo=UTC)  # midnight Dubai
    # Three calls in the last 7 days (first call + 2 retries): wait until the oldest is 7 days old.
    _history(a, khalid, [now - timedelta(days=5), now - timedelta(days=3), now - timedelta(days=1)])
    with SessionLocal() as db:
        why, when = voice_rules.uae_contact_block(db, db.get(Contact, khalid), now)
    assert "3 times" in why and when == now + timedelta(days=2)
    # Two calls in a week on different days: a retry is still allowed.
    with SessionLocal() as db:
        db.execute(VoiceEvent.__table__.delete().where(VoiceEvent.contact_id == khalid,
                                                       VoiceEvent.occurred_at < now - timedelta(days=4)))
        db.commit()
        assert voice_rules.uae_contact_block(db, db.get(Contact, khalid), now) == (None, None)
    # A refusal (pressed 9, or the AI heard "not interested") means never again, even with new consent.
    _history(a, khalid, [now - timedelta(days=10)], ai_interest="not_interested")
    with SessionLocal() as db:
        why, when = voice_rules.uae_contact_block(db, db.get(Contact, khalid), now)
    assert "Refused" in why and when is None
    # DNCR: the contact flag blocks calls and the contact's voice eligibility.
    r = a.patch(f"{a.base}/contacts/{layla}", json={"dncr_registered": True})
    assert r.status_code == 200, r.text
    c = a.get(f"{a.base}/contacts/{layla}").json()
    assert c["dncr_registered"] is True and not c["eligibility"]["voice"]["eligible"]
    assert "Do Not Call Registry" in " ".join(c["eligibility"]["voice"]["reasons"])
    with SessionLocal() as db:
        why, when = voice_rules.uae_contact_block(db, db.get(Contact, layla), now)
    assert "Do Not Call Registry" in why and when is None
    est = a.get(f"{a.v}/campaigns/{a.camp['id']}/readiness").json()["estimate"]
    assert est["eligible"] == 1  # Layla (DNCR) is excluded


def test_uae_ai_refusal_opts_out_and_notice_is_spoken(uae_voice, monkeypatch):
    from app.services.voice import ai as ai_mod
    from app.services.voice import ai_results, script

    a = uae_voice
    snap = {"message_type": "ai_agent", "country": "AE", "business_name": "Falcon Trading",
            "agent": {"greeting": "Hello {{first_name}}!", "language": "ar-AE"}, "language": "ar-AE"}
    sc = script.build(snap, None, None, sample=True)
    assert sc.steps[0].text.startswith("This call is recorded. You're speaking with an AI assistant for "
                                       "Falcon Trading.")
    plain = script.build({"country": "AE", "business_name": "Falcon Trading", "audio_kind": "tts",
                          "tts_text": "Our offer ends soon.", "language": "en-US"}, None, None, sample=True)
    assert plain.steps[0].text.startswith("This call is recorded.")
    # The AI heard "not interested" on a UAE call: the contact is opted out of calls for good.
    agent = a.post(f"{a.v}/agents", json={"name": "Arabic agent", "language": "ar-AE"})
    assert agent.status_code == 201 and agent.json()["language"] == "ar-AE", agent.text
    with SessionLocal() as db:
        camp = db.get(VoiceCampaign, a.camp["id"])
        camp.snapshot = {"message_type": "ai_agent", "country": "AE", "agent": {"name": "Arabic agent"}}
        call = VoiceCall(organization_id=a.org["id"], application_id=a.app_id, campaign_id=a.camp["id"],
                         contact_id=a.contacts["Khalid"], to_phone="+971551234567", country="AE",
                         status="completed", attempts=1, agent_id=agent.json()["id"],
                         transcript=[{"role": "assistant", "text": "Hello"}, {"role": "user", "text": "لا شكرا"}])
        db.add(call)
        db.commit()
        cid = call.id
    monkeypatch.setattr(ai_mod, "extract", lambda agent, transcript, values: {
        "summary": "Not interested", "interest": "not_interested", "sentiment": "neutral", "outcomes": {}})
    assert ai_results.process(cid) == "processed"
    c = a.get(f"{a.base}/contacts/{a.contacts['Khalid']}").json()
    assert c["voice_unsubscribed_at"] and not c["eligibility"]["voice"]["eligible"]
    with SessionLocal() as db:
        assert db.get(VoiceCall, cid).opted_out is True
        assert voice_rules.refused_before(db, a.contacts["Khalid"])


# ------------------------------------------------------------------ SMS "coming soon" everywhere

def test_sms_kill_switch_refuses_every_action(owner, monkeypatch):
    monkeypatch.setattr(settings, "SMS_ENABLED", False)
    a = owner
    s = f"/apps/{a.app['id']}/sms"
    assert a.get(f"{s}/overview").status_code == 200  # read-only GETs still answer
    for method, url, body in (
        ("post", f"{s}/campaigns", {"name": "Diwali"}),
        ("post", f"{s}/senders", {"sender_id": "561234", "country": "IN", "kind": "promotional"}),
        ("post", f"{s}/templates", {"name": "Hi", "body": "Hi"}),
        ("put", f"{s}/registration", {"uae_attest": True}),
        ("patch", f"{s}/campaigns/x", {"name": "y"}),
        ("post", f"{s}/campaigns/x/send", None),
        ("post", f"{s}/campaigns/x/test", {"phones": ["+919876543210"]}),
    ):
        r = getattr(a, method)(url, **({"json": body} if body is not None else {}))
        assert r.status_code == 422 and r.json()["error"]["code"] == "SMS_COMING_SOON", (url, r.text)
        assert r.json()["error"]["message"] == "SMS is coming soon."
    # The shared TRAI DLT registration stays open: Indian voice calls need it.
    r = a.put(f"{s}/registration", json={"principal_entity_id": "1101456789012345678", "attest": True})
    assert r.status_code == 200, r.text
    # Automation: SMS steps and SMS-reply triggers can't be added.
    auto = f"/apps/{a.app['id']}/automation"
    g = {"nodes": [{"id": "t", "type": "trigger", "position": {"x": 0, "y": 0}, "data": {"kind": "contact_created"}},
                   {"id": "s", "type": "send_sms", "position": {"x": 0, "y": 100}, "data": {"body": "Hi"}}],
         "edges": [{"id": "e", "source": "t", "target": "s"}]}
    r = a.post(f"{auto}/workflows", json={"name": "SMS", "graph": g})
    assert r.status_code == 422 and r.json()["error"]["code"] == "SMS_COMING_SOON"
    w = a.post(f"{auto}/workflows", json={"name": "Plain"}).json()
    r = a.patch(f"{auto}/workflows/{w['id']}", json={"graph": g})
    assert r.status_code == 422 and r.json()["error"]["code"] == "SMS_COMING_SOON"
    # Public prices, dashboard checklist and channels.
    assert Api().client.get("/api/v1/public/pricing?currency=INR").json()["channels"]["sms"] is False
    dash = a.get(f"/apps/{a.app['id']}/dashboard").json()
    assert "sms_setup" not in {i["key"] for i in dash["checklist"]}
    assert dash["channels"]["sms"]["coming_soon"] is True and dash["channels"]["sms"]["ready"] is False


def test_existing_sms_automation_step_is_skipped_when_sms_is_off(monkeypatch):
    from app.services.automation import actions

    monkeypatch.setattr(settings, "SMS_ENABLED", False)
    res = actions.send_sms(None, None, None)  # never touches the campaign or contact
    assert (res.outcome, res.detail) == ("skipped", "SMS is coming soon")
