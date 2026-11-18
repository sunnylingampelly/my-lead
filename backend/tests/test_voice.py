"""Voice end to end: caller rules, calling windows, audio library, calling, retries, press-9 opt-out,
signed callbacks and access control."""
import io
import json
import wave
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import pytest
from sqlalchemy import select, update

from app.api.v1.public_email import simulation_signature
from app.core.config import settings
from app.core.database import SessionLocal
from app.models import ApplicationSettings, Contact
from app.models.voice import VoiceCall, VoiceCampaign
from app.providers.sms.twilio import twilio_signature
from app.providers.voice.base import CallScript, ScriptStep
from app.providers.voice.simulation import call_log_path
from app.providers.voice.twilio import twiml
from app.services.email import tokens
from app.services.email.render import public_url
from app.services.voice import engine, rules
from tests.conftest import Api, invite_and_join


def wav_bytes(seconds: float = 2.0) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\x00\x00" * int(8000 * seconds))
    return buf.getvalue()


# ------------------------------------------------------------------ pure rules

def test_caller_rules_windows_and_twiml():
    assert rules.validate_caller("IN", "series_140", "+911401234567") is None
    assert rules.validate_caller("IN", "series_140", "+919876543210")
    assert rules.validate_caller("IN", "series_160", "+911601234567") is None
    assert rules.validate_caller("US", "local", "+14155550100") is None
    assert rules.validate_caller("US", "toll_free", "+14155550100")
    assert rules.validate_caller("US", "toll_free", "+18885550100") is None
    assert rules.caller_fits_category("IN", "series_140", "promotional")
    assert not rules.caller_fits_category("IN", "series_140", "transactional")

    no_quiet = ("00:00", "00:00")
    # 07:00 in New York: marketing calls wait for 08:00 (TCPA); transactional calls may go now.
    ny7 = datetime(2026, 7, 1, 11, 0, tzinfo=UTC)
    assert rules.next_allowed(ny7, "America/New_York", "US", "promotional", no_quiet) == datetime(2026, 7, 1, 12, 0, tzinfo=UTC)
    assert rules.next_allowed(ny7, "America/New_York", "US", "transactional", no_quiet) is None
    # 08:30 IST: India's promotional window opens at 09:00.
    ist = datetime(2026, 3, 10, 3, 0, tzinfo=UTC)
    assert rules.next_allowed(ist, "Asia/Kolkata", "IN", "promotional", no_quiet) == datetime(2026, 3, 10, 3, 30, tzinfo=UTC)
    # App quiet hours can only narrow the window: quiet until 11:00 IST.
    assert rules.next_allowed(ist, "Asia/Kolkata", "IN", "promotional", ("21:00", "11:00")) == \
        datetime(2026, 3, 10, 5, 30, tzinfo=UTC)
    assert rules.billable_minutes(61) == 2 and rules.billable_minutes(0) == 0

    xml = twiml(CallScript(steps=(ScriptStep("say", text="Hi <Asha> & co", language="en-IN"),
                                  ScriptStep("play", url="https://x.test/a.mp3")),
                           gather_digit_url="https://x.test/k?t=1&u=2",
                           gather_prompt=ScriptStep("say", text="Press 9.", language="en-IN")))
    assert "Hi &lt;Asha&gt; &amp; co" in xml and "<Play>https://x.test/a.mp3</Play>" in xml
    assert 'action="https://x.test/k?t=1&amp;u=2"' in xml and 'numDigits="1"' in xml


# ------------------------------------------------------------------ fixtures

def _open_window(app_id: str) -> None:
    with SessionLocal() as db:
        db.execute(update(ApplicationSettings).where(ApplicationSettings.application_id == app_id)
                   .values(quiet_hours_start="00:00", quiet_hours_end="00:00"))
        db.commit()


@pytest.fixture
def india(owner, monkeypatch):
    # Treat every hour as inside the legal window so results do not depend on when tests run.
    monkeypatch.setattr(rules, "LEGAL_WINDOW", {"IN": ("00:00", "23:59"), "US": ("00:00", "23:59")})
    r = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "Voice India",
                                           "default_country": "IN", "timezone": "Asia/Kolkata"})
    owner.app_id = r.json()["id"]
    owner.base = f"/apps/{owner.app_id}"
    owner.v = f"{owner.base}/voice"
    _open_window(owner.app_id)
    owner.contacts = {}
    for name, phone, consent in [("Asha", "+919876543210", True), ("Nobody", "+919876500000", True),
                                 ("Busy", "+919876522222", True), ("Machine", "+919876533333", True),
                                 ("Stopper", "+919876599999", True), ("Silent", "+919876512345", False)]:
        body = {"first_name": name, "phone": phone}
        if consent:
            body["consent"] = {"voice": True, "source": "Store form", "evidence": "Signed form"}
        r = owner.post(f"{owner.base}/contacts", json=body)
        assert r.status_code == 201, r.text
        owner.contacts[name] = r.json()["id"]
    return owner


def ready_india(a, category: str = "promotional") -> dict:
    a.put(f"{a.base}/sms/registration", json={"principal_entity_id": "1101456789012345678", "attest": True})
    kind, number = ("series_140", "+911401234567") if category == "promotional" else ("series_160", "+911601234567")
    c = a.post(f"{a.v}/callers", json={"number": number, "country": "IN", "kind": kind})
    assert c.status_code == 201 and c.json()["status"] == "pending", c.text
    a.caller_id = c.json()["id"]
    assert a.post(f"{a.v}/callers/{a.caller_id}/attest").json()["status"] == "active"
    t = a.post(f"{a.v}/audio/tts", json={"name": "Diwali", "tts_text": "Namaste {{first_name}}, our Diwali sale starts "
                                                                       "today with fifty percent off.",
                                         "tts_language": "en-IN"})
    assert t.status_code == 201 and float(t.json()["duration_seconds"]) > 3, t.text
    camp = a.post(f"{a.v}/campaigns", json={"name": "Diwali calls", "category": category,
                                           "audio_id": t.json()["id"]}).json()
    assert camp["caller_ref"] == a.caller_id and camp["intro_text"].startswith("Hello, this is a call from")
    r = a.patch(f"{a.v}/campaigns/{camp['id']}", json={"audience": {"all": True}})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------ audio library

def test_audio_upload_validation_and_signed_playback(india):
    a = india
    bad = a.client.post(f"/api/v1{a.v}/audio/upload", files={"file": ("x.mp3", b"not audio at all", "audio/mpeg")},
                        headers=a.headers)
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "UNSUPPORTED_AUDIO"
    r = a.client.post(f"/api/v1{a.v}/audio/upload", files={"file": ("welcome.wav", wav_bytes(2.0), "audio/wav")},
                      headers=a.headers)
    assert r.status_code == 201, r.text
    au = r.json()
    assert au["kind"] == "upload" and au["name"] == "welcome" and abs(float(au["duration_seconds"]) - 2.0) < 0.1
    path = au["url"].split("/api/v1", 1)[1]
    got = Api().client.get(f"/api/v1{path}")
    assert got.status_code == 200 and got.content[:4] == b"RIFF"
    assert Api().client.get(f"/api/v1/public/voice/audio/{tokens.make('vs', au['id'])}").status_code == 404
    long = a.client.post(f"/api/v1{a.v}/audio/upload", files={"file": ("long.wav", wav_bytes(130), "audio/wav")},
                         headers=a.headers)
    assert long.status_code == 422 and long.json()["error"]["code"] == "AUDIO_TOO_LONG"
    assert a.patch(f"{a.v}/audio/{au['id']}", json={"tts_text": "x"}).status_code == 422
    assert a.delete(f"{a.v}/audio/{au['id']}").status_code == 204
    assert Api().client.get(f"/api/v1{path}").status_code == 404


# ------------------------------------------------------------------ calling

def test_readiness_blocks_wrong_series_and_missing_registration(india):
    a = india
    bad = a.post(f"{a.v}/callers", json={"number": "+919876543210", "country": "IN", "kind": "series_140"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_CALLER_ID"
    c = a.post(f"{a.v}/callers", json={"number": "+911601234567", "country": "IN", "kind": "series_160"}).json()
    camp = a.post(f"{a.v}/campaigns", json={"name": "Promo"}).json()
    a.patch(f"{a.v}/campaigns/{camp['id']}", json={"caller_ref": c["id"], "audience": {"all": True}})
    rd = a.get(f"{a.v}/campaigns/{camp['id']}/readiness").json()
    assert {ch["key"] for ch in rd["checks"] if not ch["ok"]} == {"caller", "registration", "category", "message"}
    assert rd["estimate"]["eligible"] == 5 and rd["estimate"]["excluded"]["no_consent"] == 1
    assert a.post(f"{a.v}/campaigns/{camp['id']}/send").json()["error"]["code"] == "CAMPAIGN_NOT_READY"


def test_campaign_outcomes_retry_opt_out_and_cost(india):
    a = india
    c = ready_india(a)
    rd = a.get(f"{a.v}/campaigns/{c['id']}/readiness").json()
    assert rd["ready"], rd
    assert rd["cost"]["currency"] == "INR" and rd["cost"]["minutes_per_call"] == 1
    prev = a.get(f"{a.v}/campaigns/{c['id']}/preview").json()
    assert prev["steps"][1]["text"].startswith("Namaste Asha,") and prev["steps"][-1]["kind"] == "keypress"

    assert a.post(f"{a.v}/campaigns/{c['id']}/send").status_code == 200
    out = a.get(f"{a.v}/campaigns/{c['id']}").json()
    st = out["stats"]
    # Five recipients: answered, no answer (retry pending), busy (retry pending), voicemail, opted out.
    assert out["status"] == "sending" and out["recipient_count"] == 5 and out["provider"] == "simulation"
    assert (st["answered"], st["voicemail"], st["pending"], st["opted_out"]) == (2, 1, 2, 1)
    assert st["billable_minutes"] == 3 and st["cost"] == pytest.approx(1.8)
    files = [json.loads(f.read_text(encoding="utf-8")) for f in call_log_path().glob("*.json")]
    asha = next(f for f in files if f["to"] == "+919876543210")
    assert "Namaste Asha" in asha["script"][1]["text"] and asha["keypress_prompt"] == rules.DEFAULT_OPT_OUT_PROMPT
    stopper = a.get(f"{a.base}/contacts/{a.contacts['Stopper']}").json()
    assert stopper["voice_consent"] is False and stopper["voice_unsubscribed_at"]

    # Retries become due: second attempt is the last, so no answer / busy become final.
    with SessionLocal() as db:
        db.execute(update(VoiceCall).where(VoiceCall.campaign_id == c["id"], VoiceCall.status == "queued")
                   .values(next_attempt_at=datetime.now(UTC) - timedelta(seconds=1)))
        db.commit()
    assert engine.dispatch_due() == 1
    out = a.get(f"{a.v}/campaigns/{c['id']}").json()
    assert out["status"] == "completed", out["stats"]
    assert (out["stats"]["no_answer"], out["stats"]["busy"], out["stats"]["attempts"]) == (1, 1, 7)
    rep = a.get(f"{a.v}/campaigns/{c['id']}/report").json()
    assert rep["outcomes"] == {"answered": 2, "voicemail": 1, "no_answer": 1, "busy": 1, "failed": 0}
    assert rep["rates"]["answer_rate"] == pytest.approx(40.0) and rep["simulated"]
    opted = a.get(f"{a.v}/campaigns/{c['id']}/calls?status=opted_out").json()
    assert opted["total"] == 1 and opted["items"][0]["to_phone"] == "+919876599999"
    assert a.patch(f"{a.v}/campaigns/{c['id']}", json={"name": "x"}).status_code == 409
    ov = a.get(f"{a.v}/overview").json()
    assert ov["last_30_days"]["answered"] == 2 and ov["last_30_days"]["spend"] == {"INR": 1.8}


def test_calling_window_defers_until_open(india, monkeypatch):
    a = india
    c = ready_india(a)
    monkeypatch.setattr(rules, "LEGAL_WINDOW", {"IN": ("00:00", "00:01")})
    with SessionLocal() as db:
        db.execute(update(Contact).where(Contact.application_id == a.app_id).values(timezone="UTC"))
        db.commit()
    now = datetime.now(UTC)
    if now.hour == 0 and now.minute < 2:
        pytest.skip("too close to the test window")
    a.post(f"{a.v}/campaigns/{c['id']}/send")
    out = a.get(f"{a.v}/campaigns/{c['id']}").json()
    assert out["stats"]["deferred"] == 5 and out["stats"]["attempts"] == 0
    rep = a.get(f"{a.v}/campaigns/{c['id']}/report").json()
    assert rep["waiting"][0]["reason"] == "calling_window"
    assert a.post(f"{a.v}/campaigns/{c['id']}/cancel").json()["status"] == "cancelled"
    assert a.get(f"{a.v}/campaigns/{c['id']}").json()["stats"]["skipped"] == 5


# ------------------------------------------------------------------ US & callbacks

@pytest.fixture
def us(owner, monkeypatch):
    monkeypatch.setattr(rules, "LEGAL_WINDOW", {"US": ("00:00", "23:59")})
    r = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "Voice US",
                                           "default_country": "US", "timezone": "America/New_York"})
    owner.app_id = r.json()["id"]
    owner.base = f"/apps/{owner.app_id}"
    owner.v = f"{owner.base}/voice"
    _open_window(owner.app_id)
    r = owner.post(f"{owner.base}/contacts", json={"first_name": "Jane", "phone": "+14155552671", "consent": {
        "voice": True, "source": "Checkout", "evidence": "TCPA disclosure accepted, order 1001"}})
    owner.jane = r.json()["id"]
    return owner


def test_us_tcpa_checks_and_twilio_callbacks(us, monkeypatch):
    a = us
    c = a.post(f"{a.v}/callers", json={"number": "+14155550100", "country": "US", "kind": "local",
                                       "provider": "twilio"}).json()
    a.post(f"{a.v}/callers/{c['id']}/attest")
    t = a.post(f"{a.v}/audio/tts", json={"name": "Sale", "tts_text": "Spring sale ends Sunday.", "tts_language": "en-US"})
    camp = a.post(f"{a.v}/campaigns", json={"name": "Spring", "audio_id": t.json()["id"]}).json()
    a.patch(f"{a.v}/campaigns/{camp['id']}", json={"intro_text": "", "opt_out_keypress": False,
                                                   "audience": {"all": True}})
    rd = a.get(f"{a.v}/campaigns/{camp['id']}/readiness").json()
    assert {ch["key"] for ch in rd["checks"] if not ch["ok"]} == {"identification", "opt_out"}
    assert rd["cost"]["currency"] == "USD"
    a.patch(f"{a.v}/campaigns/{camp['id']}", json={"intro_text": "Hi, this is Acme calling.", "opt_out_keypress": True})
    assert a.get(f"{a.v}/campaigns/{camp['id']}/readiness").json()["ready"]
    a.post(f"{a.v}/campaigns/{camp['id']}/send")  # simulation mode: no Twilio request is made
    with SessionLocal() as db:
        call = db.scalar(select(VoiceCall).where(VoiceCall.campaign_id == camp["id"]))
        assert call.status == "completed"
        # Pretend this attempt went through Twilio and is still ringing, to exercise real callbacks.
        call.status, call.provider, call.provider_call_id, call.ended_at, call.answered_at = \
            "ringing", "twilio", "CA123", None, None
        call.duration_seconds, call.billable_minutes, call.cost = 0, 0, None
        db.execute(update(VoiceCampaign).where(VoiceCampaign.id == camp["id"]).values(status="sending"))
        db.commit()
        call_id = call.id
    monkeypatch.setattr(settings, "TWILIO_AUTH_TOKEN", "tw-secret")
    url = public_url("/webhooks/voice/twilio/status")
    hdr = {"content-type": "application/x-www-form-urlencoded"}
    anon = Api()
    params = {"CallSid": "CA123", "CallStatus": "completed", "CallDuration": "75", "AnsweredBy": "human"}
    assert anon.client.post("/api/v1/webhooks/voice/twilio/status", content=urlencode(params),
                            headers={**hdr, "x-twilio-signature": "forged"}).status_code == 401
    r = anon.client.post("/api/v1/webhooks/voice/twilio/status", content=urlencode(params),
                         headers={**hdr, "x-twilio-signature": twilio_signature("tw-secret", url, params)})
    assert r.status_code == 204
    with SessionLocal() as db:
        call = db.get(VoiceCall, call_id)
        assert call.status == "completed" and call.duration_seconds == 75 and call.billable_minutes == 2
    # The keypress URL is bound to this call by a signed token.
    k = anon.client.post(f"/api/v1/public/voice/keypress/{tokens.make('vk', call_id)}", data={"Digits": "9"})
    assert k.status_code == 200 and "not receive further calls" in k.text
    assert anon.client.post(f"/api/v1/public/voice/keypress/{tokens.make('va', call_id)}",
                            data={"Digits": "9"}).status_code == 404
    jane = a.get(f"{a.base}/contacts/{a.jane}").json()
    assert jane["voice_consent"] is False


def test_simulation_webhook_requires_signature(india):
    a = india
    c = ready_india(a, "transactional")
    a.post(f"{a.v}/campaigns/{c['id']}/send")
    with SessionLocal() as db:
        call = db.scalar(select(VoiceCall).where(VoiceCall.to_phone == "+919876543210"))
        pid = call.provider_call_id
    body = json.dumps({"event_id": "sim-x", "call_id": pid, "type": "keypress", "digits": "9"}).encode()
    anon = Api()
    assert anon.client.post("/api/v1/webhooks/voice/simulation", content=body,
                            headers={"x-signature": "bad"}).status_code == 401
    assert anon.client.post("/api/v1/webhooks/voice/simulation", content=body,
                            headers={"x-signature": simulation_signature(body)}).status_code == 200
    assert a.get(f"{a.base}/contacts/{a.contacts['Asha']}").json()["voice_consent"] is False


def test_permissions_and_isolation(india):
    a = india
    c = ready_india(a)
    viewer = invite_and_join(a, "viewer@example.com", "viewer", [a.app_id])
    assert viewer.get(f"{a.v}/campaigns").status_code == 200
    assert viewer.post(f"{a.v}/callers", json={"number": "+911401111111", "country": "IN",
                                               "kind": "series_140"}).status_code == 403
    assert viewer.post(f"{a.v}/audio/tts", json={"name": "x", "tts_text": "hello"}).status_code == 403
    assert viewer.post(f"{a.v}/campaigns/{c['id']}/send").status_code == 403
    other = Api().register("other@example.com", "Other")
    org = other.post("/organizations", json={"name": "Other Org"}).json()
    other.post("/applications", json={"organization_id": org["id"], "name": "Theirs"})
    assert other.get(f"{a.v}/campaigns/{c['id']}").status_code in (403, 404)
    assert other.get(f"{a.v}/audio").status_code in (403, 404)


# ------------------------------------------------------------------ Telnyx

def test_telnyx_request_callbacks_and_signature(us, monkeypatch):
    import base64
    import time as _time

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    from app.providers.voice import telnyx
    from app.providers.voice.base import OutboundCall

    sent = {}

    class Resp:
        status_code = 200
        headers = {"content-type": "application/json"}

        def json(self):
            return {"from": "+14155550100", "to": "+14155552671", "status": "queued", "call_sid": "v3:abc"}

    def fake_post(url, json=None, headers=None, timeout=None):
        sent.update(url=url, body=json, headers=headers)
        return Resp()

    monkeypatch.setattr(telnyx.httpx, "post", fake_post)
    p = telnyx.TelnyxVoiceProvider("KEY123", "acct-uuid", "1293384261075731499")
    res = p.place(OutboundCall(to="+14155552671", caller_id="+14155550100",
                               script=CallScript(steps=(ScriptStep("say", text="Hello", language="en-US"),)),
                               status_callback="https://x.test/cb", idempotency_key="c1:1"))
    assert res.accepted and res.provider_call_id == "v3:abc"
    assert sent["url"].endswith("/v2/texml/Accounts/acct-uuid/Calls")
    assert sent["headers"]["Authorization"] == "Bearer KEY123"
    assert sent["body"]["ApplicationSid"] == "1293384261075731499" and "<Say" in sent["body"]["Texml"]
    assert sent["body"]["StatusCallback"] == "https://x.test/cb"

    # A campaign whose caller uses Telnyx; in simulation mode no request is made.
    a = us
    c = a.post(f"{a.v}/callers", json={"number": "+14155550100", "country": "US", "kind": "local",
                                       "provider": "telnyx"}).json()
    assert c["provider"] == "telnyx"
    a.post(f"{a.v}/callers/{c['id']}/attest")
    t = a.post(f"{a.v}/audio/tts", json={"name": "Note", "tts_text": "Your order shipped.", "tts_language": "en-US"})
    camp = a.post(f"{a.v}/campaigns", json={"name": "Ship", "category": "transactional",
                                           "audio_id": t.json()["id"]}).json()
    a.patch(f"{a.v}/campaigns/{camp['id']}", json={"audience": {"all": True}})
    a.post(f"{a.v}/campaigns/{camp['id']}/send")
    with SessionLocal() as db:
        call = db.scalar(select(VoiceCall).where(VoiceCall.campaign_id == camp["id"]))
        call.status, call.provider, call.provider_call_id, call.ended_at = "ringing", "telnyx", "c1:1", None
        call.duration_seconds, call.billable_minutes, call.cost, call.answered_at = 0, 0, None, None
        db.execute(update(VoiceCampaign).where(VoiceCampaign.id == camp["id"]).values(status="sending"))
        db.commit()
        call_id, attempt = call.id, call.attempts

    priv = Ed25519PrivateKey.generate()
    pub = base64.b64encode(priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()
    monkeypatch.setattr(settings, "TELNYX_PUBLIC_KEY", pub)
    tok = tokens.make("vt", call_id)
    anon = Api()

    def post(attempt_no: int, form: dict, sign: bool = True):
        body = urlencode(form).encode()
        ts = str(int(_time.time()))
        sig = base64.b64encode(priv.sign(ts.encode() + b"|" + body)).decode() if sign else "AAAA"
        return anon.client.post(f"/api/v1/webhooks/voice/telnyx/status/{tok}/{attempt_no}", content=body,
                                headers={"content-type": "application/x-www-form-urlencoded",
                                         "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts})

    done = {"CallSid": "v3:real", "CallStatus": "completed", "CallDuration": "42", "AnsweredBy": "human"}
    assert post(attempt, done, sign=False).status_code == 401
    assert anon.client.post(f"/api/v1/webhooks/voice/telnyx/status/{tokens.make('vk', call_id)}/{attempt}",
                            content=b"").status_code == 404
    assert post(attempt + 5, done).status_code == 204  # stale attempt: stored but ignored
    with SessionLocal() as db:
        assert db.get(VoiceCall, call_id).status == "ringing"
    assert post(attempt, done).status_code == 204
    with SessionLocal() as db:
        call = db.get(VoiceCall, call_id)
        assert call.status == "completed" and call.duration_seconds == 42 and call.provider_call_id == "v3:real"
