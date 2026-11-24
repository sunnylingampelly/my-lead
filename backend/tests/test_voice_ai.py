"""Platform phone numbers and AI calling agents, all offline: the pool and automatic caller, agents and
templates, the browser test chat and evaluation (offline responder), AI-agent campaigns in simulation
with CRM results, and the ConversationRelay WebSocket with a mocked model."""
import asyncio
import json
import shutil
from decimal import Decimal

import pytest
from sqlalchemy import select, update
from starlette.websockets import WebSocketDisconnect

from app.core.database import SessionLocal
from app.models import ApplicationSettings, Contact, CrmActivity, CrmEvent, CrmTask
from app.models.voice import PhoneNumber, VoiceCall
from app.providers.voice.base import AgentRelay, CallScript, ScriptStep
from app.providers.voice.simulation import call_log_path
from app.providers.voice.twilio import twiml
from app.services.billing import wallet as wl
from app.services.voice import ai, numbers, relay, rules
from app.utils.time import utcnow
from tests.conftest import invite_and_join, make_pro
from tests.voice_helpers import add_pool_number


@pytest.fixture(autouse=True)
def _clean_call_log():
    yield
    shutil.rmtree(call_log_path(), ignore_errors=True)  # other voice tests read the simulated call log


def balance(org_id: str) -> Decimal:
    with SessionLocal() as db:
        return wl.dec(wl.get_wallet(db, org_id).balance)


def set_balance(org_id: str, amount: str) -> None:
    with SessionLocal() as db:
        w = wl.get_wallet(db, org_id)
        wl.post(db, w, "adjustment", Decimal(amount) - wl.dec(w.balance), description="Test adjustment",
                idempotency_key=f"adj:{amount}:{w.balance}:{utcnow().timestamp()}")
        db.commit()


@pytest.fixture
def app_in(owner, monkeypatch):
    monkeypatch.setattr(rules, "LEGAL_WINDOW", {"IN": ("00:00", "23:59"), "US": ("00:00", "23:59")})
    r = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "AI India",
                                           "default_country": "IN", "timezone": "Asia/Kolkata"})
    owner.app_id = r.json()["id"]
    owner.base = f"/apps/{owner.app_id}"
    owner.v = f"{owner.base}/voice"
    with SessionLocal() as db:
        db.execute(update(ApplicationSettings).where(ApplicationSettings.application_id == owner.app_id)
                   .values(quiet_hours_start="00:00", quiet_hours_end="00:00", business_name="Acme Solar"))
        db.commit()
    owner.contacts = {}
    for name, phone in [("Asha", "+919876543210"), ("Stopper", "+919876599999"), ("Nobody", "+919876500000")]:
        r = owner.post(f"{owner.base}/contacts", json={"first_name": name, "phone": phone, "consent": {
            "voice": True, "source": "Store form", "evidence": "Signed form"}})
        assert r.status_code == 201, r.text
        owner.contacts[name] = r.json()["id"]
    return owner


# ------------------------------------------------------------------ the number pool


def test_pick_caller_is_stable_per_contact_and_follows_the_category(app_in, monkeypatch):
    p1 = add_pool_number("+911405550001", "IN", "series_140")
    p2 = add_pool_number("+911405550002", "IN", "series_140")
    s1 = add_pool_number("+911605550001", "IN", "series_160")
    with SessionLocal() as db:
        first = numbers.pick_caller(db, country="IN", kind="series_140", contact_id="c-1")
        assert first.id in (p1, p2)
        # The same person always gets the same number; different people spread over the pool.
        assert {numbers.pick_caller(db, country="IN", kind="series_140", contact_id="c-1").id
                for _ in range(3)} == {first.id}
        assert {numbers.pick_caller(db, country="IN", kind="series_140", contact_id=f"c-{i}").id
                for i in range(30)} == {p1, p2}
        # Service and transactional calls to India come from 160-series numbers.
        assert numbers.kinds_for("IN", "service") == ("series_160",)
        assert numbers.pick_caller(db, country="IN", kind=numbers.kinds_for("IN", "service"), contact_id="c-1").id == s1
        assert numbers.pick_caller(db, country="GB", kind="local", contact_id="c-1") is None
        # A retired number is never used again.
        db.execute(update(PhoneNumber).where(PhoneNumber.id == first.id).values(status="retired"))
        db.flush()
        assert numbers.pick_caller(db, country="IN", kind="series_140", contact_id="c-1").id != first.id
        db.rollback()
        # Simulation fills an empty kind on the fly (US local here).
        us = numbers.pick_caller(db, country="US", kind=("local", "toll_free"), contact_id="c-1")
        assert us is not None and us.provider == "simulation" and us.kind == "local"
        db.rollback()
        # Live mode with no usable numbers: readiness explains that calling isn't available.
        monkeypatch.setattr(numbers.settings, "COMMUNICATION_MODE", "live")
        assert "isn't available yet" in numbers.availability(db, "US", "promotional")
        assert numbers.availability(db, "GB", "promotional").startswith("Calling is available to India")
    # Customers have no phone-number endpoints.
    a = app_in
    assert a.get(f"{a.v}/numbers").status_code == 404
    assert a.get(f"{a.v}/numbers/available?country=IN&kind=series_140").status_code == 404


def test_admin_loads_numbers_into_the_pool(app_in, api_factory):
    from app.cli import main as cli

    root = api_factory().register("root@example.com", "Platform Root")
    assert cli(["grant-admin", "root@example.com"]) == 0
    a = app_in
    assert a.post("/admin/phone-numbers", json={"bulk": "+14155550111"}).status_code == 403
    r = root.post("/admin/phone-numbers", json={
        "numbers": [{"number": "+1 (415) 555-0123", "country": "US", "kind": "local", "provider": "twilio",
                     "provider_ref": "PN123"}],
        "bulk": "+18885550100, toll_free, twilio, PN9\n+14155550123\nnot a number\n+18885550199",
        "country": "US", "kind": "toll_free"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["added"] == 3 and set(out["numbers"]) == {"+14155550123", "+18885550100", "+18885550199"}
    reasons = {s["number"]: s["reason"] for s in out["skipped"]}
    assert len(reasons) == 2 and "toll-free" in reasons["+14155550123"]  # pasted with the toll-free default
    again = root.post("/admin/phone-numbers", json={"numbers": [{"number": "+18885550100", "country": "US",
                                                                  "kind": "toll_free"}]}).json()
    assert again["added"] == 0 and again["skipped"][0]["reason"] == "Already in the pool"
    pool = root.get("/admin/phone-numbers?country=US").json()
    assert pool["total"] >= 2 and pool["counts"]["available"] >= 2
    pid = next(x["id"] for x in pool["items"] if x["number"] == "+14155550123")
    assert root.post(f"/admin/phone-numbers/{pid}/retire").json()["status"] == "retired"


# ------------------------------------------------------------------ agents


def test_agent_crud_templates_and_plan_limit(app_in):
    a = app_in
    tpl = a.get(f"{a.v}/agents/templates").json()
    assert {t["key"] for t in tpl} == {"lead_qualification", "appointment", "feedback", "payment_reminder"}
    r = a.post(f"{a.v}/agents", json={"name": "Maya", "template": "lead_qualification"})
    assert r.status_code == 201, r.text
    ag = r.json()
    assert ag["status"] == "draft" and ag["version"] == 1 and ag["language"] == "en-IN"
    assert "{{business_name}}" in ag["greeting"] and [f["key"] for f in ag["outcome_fields"]][:2] == ["need", "budget"]
    bad = a.patch(f"{a.v}/agents/{ag['id']}", json={"outcome_fields": [{"key": "x", "label": "X"},
                                                                       {"key": "x", "label": "Y"}]})
    assert bad.status_code == 422
    bad = a.patch(f"{a.v}/agents/{ag['id']}", json={"outcome_fields": [{"key": "size", "label": "Size",
                                                                        "type": "choice", "options": ["S"]}]})
    assert bad.status_code == 422
    r = a.patch(f"{a.v}/agents/{ag['id']}", json={
        "instructions": ag["instructions"] + "\nAlways mention the free site survey.", "knowledge": "Panels: 5kW.",
        "transfer_number": "+91 98765 11111", "max_call_minutes": 4})
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["transfer_number"] == "+919876511111"
    assert a.post(f"{a.v}/agents/{ag['id']}/activate").json()["status"] == "active"
    assert a.get(f"{a.v}/agents").json()[0]["used_by"] == []
    # Starter allows one agent.
    assert a.post(f"{a.v}/agents", json={"name": "Second"}).json()["error"]["code"] == "PLAN_LIMIT"
    assert a.post(f"{a.v}/agents/{ag['id']}/duplicate").json()["error"]["code"] == "PLAN_LIMIT"
    make_pro(a.org["id"])
    dup = a.post(f"{a.v}/agents/{ag['id']}/duplicate").json()
    assert dup["name"] == "Maya (copy)" and dup["status"] == "draft" and dup["knowledge"] == "Panels: 5kW."
    blank = a.post(f"{a.v}/agents", json={"name": "Blank"}).json()
    assert a.post(f"{a.v}/agents/{blank['id']}/activate").json()["error"]["code"] == "AGENT_INCOMPLETE"
    assert a.delete(f"{a.v}/agents/{blank['id']}").status_code == 204
    viewer = invite_and_join(a, "viewer@example.com", "viewer", [a.app_id])
    assert viewer.get(f"{a.v}/agents").status_code == 200
    assert viewer.post(f"{a.v}/agents", json={"name": "x"}).status_code == 403
    assert viewer.post(f"{a.v}/agents/{ag['id']}/test", json={"messages": []}).status_code == 403


def test_test_chat_uses_the_offline_responder_without_a_key(app_in):
    a = app_in
    assert a.get(f"{a.v}/ai/status").json() == {"configured": False, "model": "claude-opus-5-5"}
    ag = a.post(f"{a.v}/agents", json={"name": "Maya", "template": "lead_qualification"}).json()
    url = f"{a.v}/agents/{ag['id']}/test"
    first = a.post(url, json={"messages": [], "contact": {"first_name": "Ravi"}}).json()
    assert first["simulated"] and not first["end_call"]
    assert first["reply"].startswith("Hi Ravi, this is Maya calling from Acme Solar")
    msgs = [{"role": "assistant", "content": first["reply"]}, {"role": "user", "content": "Hi, who is this?"}]
    second = a.post(url, json={"messages": msgs}).json()
    assert second["simulated"] and "qualify the lead" in second["reply"] and not second["end_call"]
    msgs += [{"role": "assistant", "content": second["reply"]}, {"role": "user", "content": "We need solar panels."}]
    third = a.post(url, json={"messages": msgs}).json()
    msgs += [{"role": "assistant", "content": third["reply"]}, {"role": "user", "content": "Tomorrow is fine."}]
    last = a.post(url, json={"messages": msgs}).json()
    assert last["end_call"] and "[END_CALL]" not in last["reply"] and "Goodbye" in last["reply"]
    stop = a.post(url, json={"messages": [{"role": "user", "content": "Please stop calling me"}]}).json()
    assert stop["end_call"] and "won't call you again" in stop["reply"]


def test_evaluate_returns_structured_outcomes(app_in):
    a = app_in
    ag = a.post(f"{a.v}/agents", json={"name": "Maya", "template": "lead_qualification"}).json()
    out = a.post(f"{a.v}/agents/{ag['id']}/test/evaluate", json={"messages": [
        {"role": "assistant", "content": "Hi, this is Maya from Acme Solar."},
        {"role": "user", "content": "Yes, I'm interested. Call me back tomorrow please."}]}).json()
    assert out["simulated"] and out["summary"].startswith("Simulated summary")
    assert out["interest"] == "hot" and out["sentiment"] == "positive" and out["callback_requested_at"]
    assert set(out["outcomes"]) == {"need", "budget", "timeline", "decision_maker"}
    assert out["outcomes"]["timeline"] == "This month" and out["outcomes"]["decision_maker"] is True
    assert a.post(f"{a.v}/agents/{ag['id']}/test/evaluate", json={"messages": []}).status_code == 422


def test_extraction_model_follows_the_outcome_fields():
    fields = [{"key": "score", "label": "Score", "type": "number"},
              {"key": "plan", "label": "Plan", "type": "choice", "options": ["Basic", "Pro"]},
              {"key": "ok", "label": "OK", "type": "yes_no"}]
    schema = ai.extraction_model(fields).model_json_schema()
    assert {"summary", "sentiment", "interest", "next_step", "callback_requested_at", "do_not_call",
            "outcomes"} <= set(schema["properties"])
    m = ai.extraction_model(fields).model_validate({
        "summary": "s", "sentiment": "neutral", "interest": "warm", "next_step": None, "callback_requested_at": None,
        "do_not_call": False, "outcomes": {"score": 8, "plan": "Pro", "ok": None}})
    assert m.outcomes.plan == "Pro"
    blocks = ai.system_blocks({"instructions": "Be nice to {{first_name}} at {{business_name}}", "greeting": "Hi"},
                              ai.values_for("Ravi", "Acme"))
    assert "cache_control" in blocks[-2] and "cache_control" not in blocks[-1]
    assert "Ravi" not in "".join(b["text"] for b in blocks[:-1]) and "Ravi" in blocks[-1]["text"]
    assert "Acme" in blocks[1]["text"] and "[END_CALL]" in blocks[0]["text"]


# ------------------------------------------------------------------ AI-agent campaigns (simulation)


def ai_campaign(a, transfer: str | None = None) -> dict:
    a.put(f"{a.base}/sms/registration", json={"principal_entity_id": "1101456789012345678", "attest": True})
    ag = a.post(f"{a.v}/agents", json={"name": "Maya", "template": "lead_qualification"}).json()
    if transfer:
        a.patch(f"{a.v}/agents/{ag['id']}", json={"transfer_number": transfer})
    camp = a.post(f"{a.v}/campaigns", json={"name": "Solar leads", "agent_id": ag["id"]}).json()
    assert camp["message_type"] == "ai_agent" and camp["agent_id"] == ag["id"]
    a.patch(f"{a.v}/campaigns/{camp['id']}", json={"audience": {"all": True}})
    rd = a.get(f"{a.v}/campaigns/{camp['id']}/readiness").json()
    assert {ch["key"] for ch in rd["checks"] if not ch["ok"]} == {"message"}  # the agent is still a draft
    assert a.post(f"{a.v}/agents/{ag['id']}/activate").status_code == 200
    rd = a.get(f"{a.v}/campaigns/{camp['id']}/readiness").json()
    assert rd["ready"], rd
    # AI rate x 2 expected minutes per answered call.
    assert rd["cost"]["ai"] and rd["cost"]["per_minute"] == 6.0 and rd["cost"]["minutes_per_call"] == 2
    assert rd["cost"]["total"] == 3 * 2 * 6.0
    prev = a.get(f"{a.v}/campaigns/{camp['id']}/preview").json()
    assert prev["ai_agent"] and prev["steps"][0]["text"].startswith("Hi Asha, this is Maya calling from Acme Solar")
    return {"campaign": camp, "agent": ag}


def test_ai_campaign_in_simulation_records_transcripts_and_updates_the_crm(app_in):
    a = app_in
    x = ai_campaign(a)
    cid = x["campaign"]["id"]
    assert a.post(f"{a.v}/campaigns/{cid}/send").status_code == 200
    out = a.get(f"{a.v}/campaigns/{cid}").json()
    assert out["snapshot"]["agent"]["version"] == 1 and out["snapshot"]["message_type"] == "ai_agent"
    assert out["snapshot"]["agent_id"] == x["agent"]["id"]
    calls = {c["to_phone"]: c for c in a.get(f"{a.v}/campaigns/{cid}/calls").json()["items"]}
    asha = calls["+919876543210"]
    assert asha["status"] == "completed" and asha["has_transcript"] and asha["ai_interest"] == "hot"
    assert asha["ai_summary"].startswith("Simulated summary") and asha["contact_name"] == "Asha"
    # Charged at the AI rate per started minute.
    assert float(asha["cost"]) == asha["billable_minutes"] * 6.0 and asha["billable_minutes"] >= 1
    detail = a.get(f"{a.v}/campaigns/{cid}/calls/{asha['id']}").json()
    roles = [t["role"] for t in detail["transcript"]]
    assert roles[0] == "assistant" and "user" in roles and detail["simulated"]
    assert detail["transcript"][0]["text"].startswith("Hi Asha")
    assert "[END_CALL]" not in " ".join(t["text"] for t in detail["transcript"])
    assert {o["key"] for o in detail["ai_outcomes"]} == {"need", "budget", "timeline", "decision_maker"}
    assert detail["callback_requested_at"] and detail["agent"]["name"] == "Maya"
    with SessionLocal() as db:
        act = db.scalar(select(CrmActivity).where(CrmActivity.contact_id == a.contacts["Asha"],
                                                  CrmActivity.type == "ai_call"))
        assert act is not None and act.meta["voice_call_id"] == asha["id"] and act.meta["interest"] == "hot"
        task = db.scalar(select(CrmTask).where(CrmTask.contact_id == a.contacts["Asha"]))
        assert task is not None and task.title == "Call back Asha" and task.type == "call" and task.due_at > utcnow()
        ev = db.scalar(select(CrmEvent).where(CrmEvent.kind == "ai_call_completed",
                                              CrmEvent.contact_id == a.contacts["Asha"]))
        assert ev is not None and ev.data["interest"] == "hot"
        assert db.get(Contact, a.contacts["Asha"]).last_activity_at is not None
    # "Please stop calling me": opted out, no task.
    stop = calls["+919876599999"]
    assert stop["opted_out"] and stop["ai_interest"] == "not_interested"
    stopper = a.get(f"{a.base}/contacts/{a.contacts['Stopper']}").json()
    assert stopper["voice_consent"] is False
    with SessionLocal() as db:
        assert db.scalar(select(CrmTask).where(CrmTask.contact_id == a.contacts["Stopper"])) is None
    # The contact's timeline shows the AI call with its summary.
    tl = a.get(f"{a.base}/crm/timeline?contact_id={a.contacts['Asha']}")
    assert tl.status_code == 200, tl.text
    entry = next(i for i in tl.json() if i["type"] == "ai_call")
    assert entry["kind"] == "activity" and entry["meta"]["voice_call_id"] == asha["id"]
    assert entry["body"].startswith("Simulated summary") and entry["meta"]["outcomes"]
    agents = a.get(f"{a.v}/agents").json()
    assert agents[0]["used_by"][0]["id"] == cid
    # Still calling (a retry is pending), so the agent can't be switched off or deleted.
    assert a.post(f"{a.v}/agents/{x['agent']['id']}/deactivate").json()["error"]["code"] == "AGENT_IN_USE"
    assert a.delete(f"{a.v}/agents/{x['agent']['id']}").status_code == 409
    assert a.post(f"{a.v}/campaigns/{cid}/test", json={"phones": ["+919876543210"]}).json()["error"]["code"] == \
        "AI_TEST_CALL_UNSUPPORTED"


def test_ai_calls_need_a_twilio_number_in_live_mode(app_in, monkeypatch):
    a = app_in
    a.put(f"{a.base}/sms/registration", json={"principal_entity_id": "1101456789012345678", "attest": True})
    add_pool_number("+911402223334", "IN", "series_140", provider="exotel")
    monkeypatch.setattr(numbers.settings, "COMMUNICATION_MODE", "live")
    monkeypatch.setattr(numbers, "_usable", lambda provider: provider != "simulation")
    ag = a.post(f"{a.v}/agents", json={"name": "Maya", "template": "feedback"}).json()
    a.post(f"{a.v}/agents/{ag['id']}/activate")
    camp = a.post(f"{a.v}/campaigns", json={"name": "Survey", "agent_id": ag["id"]}).json()
    a.patch(f"{a.v}/campaigns/{camp['id']}", json={"audience": {"all": True}})
    rd = a.get(f"{a.v}/campaigns/{camp['id']}/readiness").json()
    # Only an Exotel number is in the pool: fine for recorded messages, but AI agents need Twilio.
    calling = next(ch for ch in rd["checks"] if ch["key"] == "calling")
    assert not calling["ok"] and "isn't available yet" in calling["detail"]
    plain = a.post(f"{a.v}/campaigns", json={"name": "Plain"}).json()
    rd = a.get(f"{a.v}/campaigns/{plain['id']}/readiness").json()
    assert next(ch for ch in rd["checks"] if ch["key"] == "calling")["ok"]


# ------------------------------------------------------------------ ConversationRelay


def test_conversation_relay_twiml_and_marker_filter():
    xml = twiml(CallScript(steps=(ScriptStep("say", text="Hi"),), relay=AgentRelay(
        url="wss://x.test/api/v1/public/voice/agent/c1/ws?token=t&x=1", greeting="Hi <Asha>", language="en-IN",
        voice="female", action_url="https://x.test/a")))
    assert '<Connect action="https://x.test/a"><ConversationRelay url="wss://x.test/api/v1/public/voice/agent/c1/ws' \
           '?token=t&amp;x=1"' in xml
    assert 'welcomeGreeting="Hi &lt;Asha&gt;"' in xml and 'language="en-IN"' in xml and 'dtmfDetection="true"' in xml
    assert 'interruptible="any"' in xml and 'voice="Kajal-Neural"' in xml
    f = ai.MarkerFilter()
    out = "".join(f.feed(p) for p in ["Thanks, bye. [EN", "D_CA", "LL]"]) + f.flush()
    assert out.strip() == "Thanks, bye." and f.end and not f.transfer
    f = ai.MarkerFilter()
    out = "".join(f.feed(p) for p in ["Costs [about] 5. ", "Connecting [TRANS", "FER]"]) + f.flush()
    assert out == "Costs [about] 5. Connecting " and f.transfer


def _live_call(a, transfer: str | None = None) -> tuple[str, str]:
    """Run an AI campaign in simulation, then reopen Asha's call as if it were in progress on Twilio."""
    x = ai_campaign(a, transfer)
    cid = x["campaign"]["id"]
    a.post(f"{a.v}/campaigns/{cid}/send")
    with SessionLocal() as db:
        call = db.scalar(select(VoiceCall).where(VoiceCall.campaign_id == cid, VoiceCall.to_phone == "+919876543210"))
        call.status, call.transcript, call.ai_processed_at, call.provider = "in_progress", None, None, "twilio"
        db.commit()
        return call.id, cid


def test_relay_socket_streams_replies_and_ends_the_call(app_in, monkeypatch):
    a = app_in
    call_id, _ = _live_call(a)
    seen = {}

    async def fake_stream(agent, messages, values):
        seen["messages"] = messages
        for piece in ["Great to hear. ", "Thanks for your time, goodbye! [END", "_CALL]"]:
            yield "text", piece
        yield "done", "end_turn"

    monkeypatch.setattr(ai, "stream_reply", fake_stream)
    with pytest.raises(WebSocketDisconnect):
        with a.client.websocket_connect(f"/api/v1/public/voice/agent/{call_id}/ws?token=forged") as ws:
            ws.receive_text()
    other = relay.ws_token("00000000" + call_id[8:])  # signed, but for another call
    with pytest.raises(WebSocketDisconnect):
        with a.client.websocket_connect(f"/api/v1/public/voice/agent/{call_id}/ws?token={other}") as ws:
            ws.receive_text()
    assert not relay.verify(call_id, relay.ws_token(call_id)[:-2] + "AA")

    with a.client.websocket_connect(f"/api/v1/public/voice/agent/{call_id}/ws?token={relay.ws_token(call_id)}") as ws:
        ws.send_text(json.dumps({"type": "setup", "callSid": "CA1", "customParameters": {}}))
        ws.send_text(json.dumps({"type": "prompt", "voicePrompt": "Yes, I want solar", "last": False}))  # partial
        ws.send_text(json.dumps({"type": "prompt", "voicePrompt": "Yes, I want solar panels.", "last": True}))
        got = []
        while True:
            msg = json.loads(ws.receive_text())
            got.append(msg)
            if msg["type"] == "end":
                break
    texts = [m for m in got if m["type"] == "text"]
    assert all("[" not in m["token"] for m in texts) and texts[-1]["last"] is True
    assert "".join(m["token"] for m in texts).strip() == "Great to hear. Thanks for your time, goodbye!"
    assert json.loads(got[-1]["handoffData"])["reason"] == "completed"
    assert seen["messages"][-1] == {"role": "user", "content": "Yes, I want solar panels."}
    with SessionLocal() as db:
        call = db.get(VoiceCall, call_id)
        assert [t["role"] for t in call.transcript] == ["assistant", "user", "assistant"]
        assert call.transcript[0]["text"].startswith("Hi Asha")
        assert call.transcript[2]["text"] == "Great to hear. Thanks for your time, goodbye!"


def test_relay_dtmf_9_opts_out_and_transfer_dials_the_agent_number(app_in, monkeypatch):
    a = app_in
    call_id, _ = _live_call(a, transfer="+919876511111")
    with a.client.websocket_connect(f"/api/v1/public/voice/agent/{call_id}/ws?token={relay.ws_token(call_id)}") as ws:
        ws.send_text(json.dumps({"type": "setup"}))
        ws.send_text(json.dumps({"type": "dtmf", "digit": "1"}))  # ignored
        ws.send_text(json.dumps({"type": "dtmf", "digit": "9"}))
        text = json.loads(ws.receive_text())
        end = json.loads(ws.receive_text())
    assert text["type"] == "text" and "won't receive further calls" in text["token"]
    assert json.loads(end["handoffData"])["reason"] == "opt_out"
    asha = a.get(f"{a.base}/contacts/{a.contacts['Asha']}").json()
    assert asha["voice_consent"] is False
    with SessionLocal() as db:
        assert db.get(VoiceCall, call_id).opted_out

    # Hand-off: [TRANSFER] ends the session with the agent's transfer number; the action URL dials it.
    async def wants_human(agent, messages, values):
        yield "text", "Connecting you now. [TRANSFER]"
        yield "done", "end_turn"

    monkeypatch.setattr(ai, "stream_reply", wants_human)
    with SessionLocal() as db:
        db.execute(update(VoiceCall).where(VoiceCall.id == call_id).values(transcript=None))
        db.commit()
    with a.client.websocket_connect(f"/api/v1/public/voice/agent/{call_id}/ws?token={relay.ws_token(call_id)}") as ws:
        ws.send_text(json.dumps({"type": "setup"}))
        ws.send_text(json.dumps({"type": "prompt", "voicePrompt": "Can I talk to a person?", "last": True}))
        msgs = []
        while not msgs or msgs[-1]["type"] != "end":
            msgs.append(json.loads(ws.receive_text()))
    handoff = msgs[-1]["handoffData"]
    assert json.loads(handoff) == {"reason": "transfer", "transfer_to": "+919876511111"}
    r = a.client.post(f"/api/v1/public/voice/agent/{call_id}/action?token={relay.ws_token(call_id)}",
                      data={"HandoffData": handoff, "SessionStatus": "ended"})
    assert r.status_code == 200 and "<Dial>+919876511111</Dial>" in r.text
    forged = json.dumps({"reason": "transfer", "transfer_to": "+15550001111"})
    r = a.client.post(f"/api/v1/public/voice/agent/{call_id}/action?token={relay.ws_token(call_id)}",
                      data={"HandoffData": forged})
    assert "<Hangup/>" in r.text and "Dial" not in r.text
    assert a.client.post(f"/api/v1/public/voice/agent/{call_id}/action?token=bad").status_code == 404


def test_relay_interrupt_errors_and_refusals():
    """The session alone: interrupt truncates what was said; model errors end the call politely."""
    sent: list[dict] = []

    async def send(m):
        sent.append(m)

    async def run(streamer, msgs):
        s = relay.RelaySession("c", None, send, streamer=streamer)
        s.agent, s.values = {"greeting": "Hi", "max_call_minutes": 5}, {"first_name": "Asha"}
        s.transcript = [{"role": "assistant", "text": "Hi", "at": ""}]
        s.persist = _noop.__get__(s)
        for m in msgs:
            await s.handle(m)
        return s

    async def _noop(self):
        return None

    async def long_reply(agent, messages, values):
        yield "text", "Our panels come with a twenty five year warranty and free installation."
        yield "done", "end_turn"

    s = asyncio.run(run(long_reply, [{"type": "prompt", "voicePrompt": "Tell me more", "last": True},
                                     {"type": "interrupt", "utteranceUntilInterrupt": "Our panels come with",
                                      "durationUntilInterruptMs": 900}]))
    assert s.transcript[-1]["text"] == "Our panels come with …" and s.transcript[-1]["interrupted"]
    assert not s.ended

    async def refuses(agent, messages, values):
        yield "refusal", ""

    sent.clear()
    s = asyncio.run(run(refuses, [{"type": "prompt", "voicePrompt": "Something odd", "last": True}]))
    assert s.ended and ai.REFUSAL_LINE in "".join(m.get("token", "") for m in sent)
    assert json.loads(sent[-1]["handoffData"])["reason"] == "refusal"

    async def broken(agent, messages, values):
        yield "error", "rate_limited"

    sent.clear()
    s = asyncio.run(run(broken, [{"type": "prompt", "voicePrompt": "Hello?", "last": True}]))
    assert s.ended and ai.ERROR_LINE in s.transcript[-1]["text"]


class _FakeStream:
    def __init__(self, chunks, stop_reason):
        self.text_stream = iter(chunks)
        self._final = type("Msg", (), {"stop_reason": stop_reason})()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        return self._final


def test_claude_request_uses_effort_caching_and_refusal_fallback(monkeypatch):
    """With a key set, test chat calls Claude's beta stream with low effort, a cached system prompt and
    server-side refusal fallback; a refusal that still comes back ends the call politely."""
    import anthropic

    from app.core.config import settings

    calls: list[dict] = []
    outcome = {"chunks": ["Hello! ", "This is Chai calling. [END_CALL]"], "stop": "end_turn"}

    class FakeClient:
        def __init__(self, **kw):
            self.beta = type("B", (), {"messages": type("M", (), {"stream": self._stream})()})()

        def _stream(self, **kw):
            calls.append(kw)
            return _FakeStream(outcome["chunks"], outcome["stop"])

    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(anthropic, "Anthropic", FakeClient)
    agent = {"name": "Asha", "instructions": "Be brief.", "knowledge": "We sell chai.", "greeting": "Hi",
             "goal": "Book a tasting", "outcome_fields": []}
    r = ai.reply_sync(agent, [{"role": "user", "content": "Who is this?"}], {"business_name": "Chai"})
    assert r == {"text": "Hello! This is Chai calling.", "end": True, "transfer": False, "simulated": False,
                 "error": None}
    req = calls[0]
    assert req["model"] == "claude-opus-5-5" and req["output_config"] == {"effort": "low"}
    assert req["fallbacks"] == "default" and req["betas"] == ["server-side-fallback-2026-07-01"]
    assert "thinking" not in req and "temperature" not in req
    assert any(b.get("cache_control") == {"type": "ephemeral"} for b in req["system"])

    outcome.update(chunks=["I"], stop="refusal")
    r = ai.reply_sync(agent, [{"role": "user", "content": "Who is this?"}], {"business_name": "Chai"})
    assert r["text"] == ai.REFUSAL_LINE and r["end"] and r["error"] == "refusal"
