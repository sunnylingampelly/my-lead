"""Email campaigns end to end: senders, rendering, launch, sending, tracking, webhooks, lifecycle."""
import base64
import json
import re
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, update

from app.core.database import SessionLocal
from app.models.email import EmailCampaign, EmailEvent, EmailMessage
from app.services.email import render, tokens
from tests.conftest import Api, invite_and_join, mailbox, make_pro, token_from_last_email

HTML = ('<html><body><h1>Hello {{first_name | default: "there"}}</h1><p>From {{company}} in {{city}}.</p>'
        '<a href="https://shop.example.com/sale">Shop the sale</a> '
        '<a href="https://example.com/blog?ref={{email}}">Personal link</a></body></html>')


# ------------------------------------------------------------------ helpers

@pytest.fixture
def em(owner):
    """Owner with an India app, a verified sender and four contacts (three consented)."""
    r = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "Mail App",
                                           "default_country": "IN", "timezone": "Asia/Kolkata"})
    owner.app_id = r.json()["id"]
    owner.base = f"/apps/{owner.app_id}"
    owner.e = f"{owner.base}/email"
    s = owner.post(f"{owner.e}/senders", json={"from_name": "Acme Deals", "from_email": "deals@acme.example",
                                               "reply_to": "support@acme.example"})
    assert s.status_code == 201 and s.json()["status"] == "pending"
    tok = token_from_last_email("deals@acme.example", "/verify-sender")
    assert Api().post("/public/email-senders/verify", json={"token": tok}).json()["status"] == "verified"
    owner.sender_id = s.json()["id"]
    owner.contacts = {}
    for email, city, consent in ([("asha@example.com", "Hyderabad", True),
                                                ("ravi@example.com", "Hyderabad", True),
                                                ("bounce@example.com", "Hyderabad", True),
                                                ("noconsent@example.com", "Hyderabad", False),
                                                ("pune@example.com", "Pune", True)]):
        body = {"email": email, "first_name": email.split("@")[0].title(), "city": city, "company": "Acme & Sons"}
        if consent:
            body["consent"] = {"email": True, "source": "Website form"}
        owner.contacts[email] = owner.post(f"{owner.base}/contacts", json=body).json()["id"]
    seg = owner.post(f"{owner.base}/segments", json={"name": "Hyderabad Customers", "rules": {
        "match": "all", "conditions": [{"field": "city", "operator": "is", "value": "Hyderabad"}]}})
    owner.segment_id = seg.json()["id"]
    return owner


def make_campaign(a, **overrides):
    c = a.post(f"{a.e}/campaigns", json={"name": "Diwali Sale"}).json()
    body = {"sender_id": a.sender_id, "subject": "Hi {{first_name}}, the sale is live", "preheader": "Up to 50% off",
            "editor": "html", "html": HTML, "audience": {"segment_ids": [a.segment_id]}, **overrides}
    r = a.patch(f"{a.e}/campaigns/{c['id']}", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def campaign_mail(to: str) -> dict:
    items = [m for m in mailbox(to) if "Diwali" in m["subject"] or "sale" in m["subject"].lower()]
    assert items, f"no campaign email to {to}"
    return items[-1]


# ------------------------------------------------------------------ rendering

def test_render_escapes_values_and_rejects_template_code():
    vals = {"first_name": '<script>alert(1)</script>', "company": "A&B"}
    r = render.render(subject="Hi {{first_name}}", preheader=None, html="<p>{{first_name}} at {{company}}</p>",
                      text=None, values=vals, message_id=None, links=None, business_name="Acme",
                      business_address="1 Road\nHyderabad", track_opens=False, track_clicks=False)
    assert "<script>" not in r.html and "&lt;script&gt;" in r.html and "A&amp;B" in r.html
    assert r.subject == "Hi <script>alert(1)</script>"  # subjects are plain text, never HTML
    assert "Unsubscribe" in r.html and "1 Road<br>Hyderabad" in r.html and "Unsubscribe:" in r.text
    issues = render.check(["{{ first_name }} {{ secret.attr }} {{ config.__class__ }} {% for x in y %}"], set())
    assert issues.malformed and not issues.ok
    assert render.check(["{{nope}}"], set()).unknown == ["nope"]
    assert render.substitute('{{first_name | default: "friend"}}', {}, escape=True) == "friend"


def test_tokens_are_purpose_bound_and_tamper_proof():
    mid = "6f1c2f4e-2b7a-4f3c-9b1d-1a2b3c4d5e6f"
    t = tokens.make("o", mid)
    assert tokens.read("o", t) == mid
    assert tokens.read("u", t) is None and tokens.read("o", t[:-2] + "AA") is None and tokens.read("o", "x") is None


# ------------------------------------------------------------------ senders & readiness

def test_unverified_sender_and_missing_content_block_launch(em):
    s = em.post(f"{em.e}/senders", json={"from_name": "New", "from_email": "new@acme.example"}).json()
    c = em.post(f"{em.e}/campaigns", json={"name": "Draft"}).json()
    assert c["sender_id"] == em.sender_id  # the first sender became the default
    em.patch(f"{em.e}/campaigns/{c['id']}", json={"sender_id": s["id"]})
    r = em.post(f"{em.e}/campaigns/{c['id']}/send")
    assert r.status_code == 422 and r.json()["error"]["code"] == "CAMPAIGN_NOT_READY"
    failing = {d["key"] for d in r.json()["error"]["details"]}
    assert failing == {"sender", "subject", "content", "audience"}
    ready = em.get(f"{em.e}/campaigns/{c['id']}/readiness").json()
    assert ready["ready"] is False


def test_us_apps_require_postal_address(owner):
    app = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "US Mail",
                                             "default_country": "US"}).json()
    e = f"/apps/{app['id']}/email"
    sid = owner.post(f"{e}/senders", json={"from_name": "US", "from_email": "hi@us.example"}).json()["id"]
    Api().post("/public/email-senders/verify", json={"token": token_from_last_email("hi@us.example", "/verify-sender")})
    owner.post(f"/apps/{app['id']}/contacts", json={"email": "j@example.com", "consent": {"email": True, "source": "Form"}})
    c = owner.post(f"{e}/campaigns", json={"name": "US"}).json()
    owner.patch(f"{e}/campaigns/{c['id']}", json={"sender_id": sid, "subject": "Hi", "html": "<p>Hi</p>",
                                                   "audience": {"all": True}})
    checks = {ch["key"]: ch for ch in owner.get(f"{e}/campaigns/{c['id']}/readiness").json()["checks"]}
    assert checks["postal_address"]["ok"] is False and "CAN-SPAM" in checks["postal_address"]["detail"]
    owner.patch(f"/applications/{app['id']}/settings", json={"business_address": "100 Congress Ave, Austin, TX 78701"})
    assert owner.get(f"{e}/campaigns/{c['id']}/readiness").json()["ready"] is True


def test_estimate_breaks_down_exclusions(em):
    est = em.post(f"{em.e}/campaigns/estimate", json={"segment_ids": [em.segment_id]}).json()
    assert est == {"matched": 4, "eligible": 3, "excluded": {"no_email": 0, "unsubscribed": 0,
                                                             "bounced_or_blocked": 0, "suppressed": 0,
                                                             "no_consent": 1}}


# ------------------------------------------------------------------ sending

def test_send_campaign_to_segment_with_simulated_receipts(em):
    c = make_campaign(em)
    r = em.post(f"{em.e}/campaigns/{c['id']}/send")
    assert r.status_code == 200, r.text
    done = em.get(f"{em.e}/campaigns/{c['id']}").json()
    assert done["status"] == "completed" and done["recipient_count"] == 3 and done["provider"] == "simulation"
    assert done["excluded"]["no_consent"] == 1
    st = done["stats"]
    assert (st["sent"], st["delivered"], st["bounced"], st["hard_bounced"]) == (3, 2, 1, 1)
    # Personalised, escaped, with footer and List-Unsubscribe headers handled by render.
    mail = campaign_mail("asha@example.com")
    assert mail["subject"] == "Hi Asha, the sale is live"
    assert "Acme &amp; Sons" in mail["html"] and "Unsubscribe" in mail["html"]
    assert "/api/v1/t/c/" in mail["html"] and "/api/v1/t/o/" in mail["html"]
    assert "https://example.com/blog?ref=asha@example.com" in mail["html"]  # personalised links are not rewritten
    assert not mailbox("noconsent@example.com") and not mailbox("pune@example.com")
    # Hard bounce suppressed the address and flagged the contact.
    b = em.get(f"{em.base}/contacts/{em.contacts['bounce@example.com']}").json()
    assert b["status"] == "bounced" and b["eligibility"]["email"]["eligible"] is False
    rep = em.get(f"{em.e}/campaigns/{c['id']}/report").json()
    assert rep["rates"]["delivery_rate"] == pytest.approx(66.67) and rep["simulated"] is True
    n = em.get("/notifications").json()["items"][0]
    assert n["type"] == "campaign_sent" and "1 failed or bounced" in n["body"]


def test_relaunch_and_retries_never_duplicate(em):
    from app.services.email import engine

    c = make_campaign(em)
    em.post(f"{em.e}/campaigns/{c['id']}/send")
    with SessionLocal() as db:
        db.execute(update(EmailCampaign).where(EmailCampaign.id == c["id"]).values(status="queued"))
        db.commit()
    engine.launch(c["id"])  # redelivered launch task
    engine.send(c["id"])
    with SessionLocal() as db:
        n = db.scalar(select(func.count()).select_from(EmailMessage).where(EmailMessage.campaign_id == c["id"]))
        accepted = db.scalar(select(func.count()).select_from(EmailEvent).where(
            EmailEvent.campaign_id == c["id"], EmailEvent.type == "accepted"))
    assert n == 3 and accepted == 3
    assert len(mailbox("asha@example.com")) == 1
    assert em.post(f"{em.e}/campaigns/{c['id']}/send").status_code == 409


def test_interrupted_messages_are_not_resent(em):
    from app.services.email import engine

    c = make_campaign(em)
    with SessionLocal() as db:
        db.execute(update(EmailCampaign).where(EmailCampaign.id == c["id"]).values(status="queued"))
        db.commit()
    import app.services.email.engine as eng

    real = eng._send_batch
    eng._send_batch = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("worker died"))
    try:
        with pytest.raises(RuntimeError):
            engine.launch(c["id"])
    finally:
        eng._send_batch = real
    with SessionLocal() as db:
        db.execute(update(EmailMessage).where(EmailMessage.campaign_id == c["id"])
                   .values(updated_at=datetime.now(UTC) - timedelta(minutes=30)))
        db.commit()
    assert engine.send(c["id"]) == "completed"
    msgs = em.get(f"{em.e}/campaigns/{c['id']}/messages").json()["items"]
    assert {m["status"] for m in msgs} == {"failed"} and msgs[0]["error_code"] == "interrupted"
    assert not mailbox("asha@example.com")


def test_unsubscribe_after_launch_is_respected_at_send_time(em):
    from app.services.email import engine

    c = make_campaign(em)
    with SessionLocal() as db:
        db.execute(update(EmailCampaign).where(EmailCampaign.id == c["id"]).values(status="queued"))
        db.commit()
    import app.services.email.engine as eng

    real_send = eng.send
    eng.send = lambda *a, **k: "sending"  # materialise only
    try:
        engine.launch(c["id"])
    finally:
        eng.send = real_send
    em.post(f"{em.base}/contacts/{em.contacts['ravi@example.com']}/consent",
            json={"channel": "email", "status": "revoked"})
    engine.send(c["id"])
    msgs = {m["to_email"]: m for m in em.get(f"{em.e}/campaigns/{c['id']}/messages").json()["items"]}
    assert msgs["ravi@example.com"]["status"] == "skipped"
    assert not mailbox("ravi@example.com")


# ------------------------------------------------------------------ tracking

def test_open_click_and_unsubscribe_tracking(em):
    c = make_campaign(em)
    em.post(f"{em.e}/campaigns/{c['id']}/send")
    html = campaign_mail("asha@example.com")["html"]
    anon = Api()
    pixel = re.search(r"/api/v1(/t/o/[^\"]+\.gif)", html).group(1)
    r = anon.get(pixel)
    assert r.status_code == 200 and r.headers["content-type"] == "image/gif"
    anon.get(pixel)
    click = re.search(r"/api/v1(/t/c/[^\"]+)", html).group(1)
    r = anon.client.get(f"/api/v1{click}", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "https://shop.example.com/sale"
    # No open redirect: unknown index or forged token.
    assert anon.client.get(f"/api/v1{click[:-1]}9", follow_redirects=False).status_code == 404
    assert anon.client.get("/api/v1/t/c/forged.token/0", follow_redirects=False).status_code == 404
    st = em.get(f"{em.e}/campaigns/{c['id']}").json()["stats"]
    assert (st["unique_opens"], st["total_opens"], st["unique_clicks"]) == (1, 2, 1)
    rep = em.get(f"{em.e}/campaigns/{c['id']}/report").json()
    assert rep["top_links"][0]["url"] == "https://shop.example.com/sale" and rep["timeline"]["points"]

    unsub = re.search(r"/unsubscribe\?t=([^\"&]+)", html).group(1)
    info = anon.get(f"/public/unsubscribe/{unsub}").json()
    assert info["email"].startswith("as") and info["unsubscribed"] is False and "Acme" in info["sender"]
    assert anon.post("/public/unsubscribe", json={"token": unsub}).json()["unsubscribed"] is True
    contact = em.get(f"{em.base}/contacts/{em.contacts['asha@example.com']}").json()
    assert contact["email_unsubscribed"] is True
    assert em.get(f"{em.e}/campaigns/{c['id']}").json()["stats"]["unsubscribed"] == 1
    # One-click (RFC 8058) endpoint for another recipient.
    html2 = campaign_mail("ravi@example.com")["html"]
    t2 = re.search(r"/unsubscribe\?t=([^\"&]+)", html2).group(1)
    assert anon.client.post(f"/api/v1/u/{t2}", content="List-Unsubscribe=One-Click").status_code == 200
    assert em.get(f"{em.base}/contacts/{em.contacts['ravi@example.com']}").json()["email_unsubscribed"] is True


# ------------------------------------------------------------------ webhooks

def _sim_hook(api, payload: dict):
    from app.api.v1.public_email import simulation_signature

    body = json.dumps(payload).encode()
    return api.client.post("/api/v1/webhooks/email/simulation", content=body,
                           headers={"x-signature": simulation_signature(body), "content-type": "application/json"})


def test_webhooks_verify_dedupe_and_handle_out_of_order(em):
    c = make_campaign(em, audience={"list_ids": [], "segment_ids": [em.segment_id]})
    em.post(f"{em.e}/campaigns/{c['id']}/send")
    with SessionLocal() as db:
        m = db.scalar(select(EmailMessage).where(EmailMessage.campaign_id == c["id"],
                                                 EmailMessage.to_email == "ravi@example.com"))
        pmid = m.provider_message_id
    anon = Api()
    assert anon.client.post("/api/v1/webhooks/email/simulation", content=b"{}",
                            headers={"x-signature": "bad"}).status_code == 401
    complaint = {"event_id": "evt-1", "message_id": pmid, "type": "complained", "occurred_at": "2026-11-17T10:00:00Z"}
    assert _sim_hook(anon, complaint).status_code == 200
    assert _sim_hook(anon, complaint).status_code == 200  # duplicate delivery from provider
    late_delivery = {"event_id": "evt-2", "message_id": pmid, "type": "delivered", "occurred_at": "2026-11-17T09:00:00Z"}
    _sim_hook(anon, late_delivery)
    msgs = {x["to_email"]: x for x in em.get(f"{em.e}/campaigns/{c['id']}/messages").json()["items"]}
    assert msgs["ravi@example.com"]["status"] == "complained"  # terminal state wins over late delivery
    with SessionLocal() as db:
        n = db.scalar(select(func.count()).select_from(EmailEvent).where(EmailEvent.provider_event_id == "evt-1"))
    assert n == 1
    supp = em.get(f"{em.base}/suppressions?channel=email").json()["items"]
    assert any(s["reason"] == "complaint" for s in supp)


def test_brevo_webhook_requires_configured_token(em, monkeypatch):
    from app.core import config

    anon = Api()
    assert anon.client.post("/api/v1/webhooks/email/brevo", json={}).status_code == 503
    monkeypatch.setattr(config.settings, "BREVO_WEBHOOK_TOKEN", "s3cret-token")
    assert anon.client.post("/api/v1/webhooks/email/brevo?token=nope", json={}).status_code == 401
    r = anon.client.post("/api/v1/webhooks/email/brevo?token=s3cret-token",
                         json={"event": "delivered", "message-id": "<unknown@brevo>", "ts_event": 1763370000})
    assert r.status_code == 200


def test_ses_sns_signature_verification():
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    from cryptography.x509.oid import NameOID

    from app.providers.email.webhooks import WebhookError, _sns_string_to_sign, parse_ses, verify_sns

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "sns.amazonaws.com")])
    now = datetime.now(UTC)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(now).not_valid_after(now + timedelta(days=1)).sign(key, hashes.SHA256()))
    pem = cert.public_bytes(serialization.Encoding.PEM)
    ses_msg = {"eventType": "Bounce", "mail": {"messageId": "abc"},
               "bounce": {"bounceType": "Permanent", "timestamp": "2026-11-17T10:00:00.000Z"}}
    msg = {"Type": "Notification", "MessageId": "m-1", "TopicArn": "arn:aws:sns:ap-south-1:1:ses",
           "Message": json.dumps(ses_msg), "Timestamp": "2026-11-17T10:00:01.000Z", "SignatureVersion": "2",
           "SigningCertURL": "https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-x.pem"}
    msg["Signature"] = base64.b64encode(key.sign(_sns_string_to_sign(msg).encode(), padding.PKCS1v15(),
                                                 hashes.SHA256())).decode()
    verify_sns(msg, fetch_cert=lambda url: pem)
    ev = parse_ses(msg)[0]
    assert (ev.provider_message_id, ev.type, ev.bounce_type) == ("abc", "bounced", "hard")
    tampered = {**msg, "Message": msg["Message"].replace("Permanent", "Transient")}
    with pytest.raises(WebhookError):
        verify_sns(tampered, fetch_cert=lambda url: pem)
    with pytest.raises(WebhookError):
        verify_sns({**msg, "SigningCertURL": "https://evil.example.com/cert.pem"}, fetch_cert=lambda url: pem)


# ------------------------------------------------------------------ lifecycle

def test_schedule_unschedule_and_dispatch_due(em):
    from app.services.email.engine import dispatch_due

    c = make_campaign(em)
    past = em.post(f"{em.e}/campaigns/{c['id']}/schedule",
                   json={"scheduled_at": "2020-01-01T10:00:00", "timezone": "Asia/Kolkata"})
    assert past.json()["error"]["code"] == "SCHEDULE_IN_PAST"
    when = (datetime.now(UTC) + timedelta(days=1)).replace(tzinfo=None).isoformat()
    s = em.post(f"{em.e}/campaigns/{c['id']}/schedule", json={"scheduled_at": when, "timezone": "Asia/Kolkata"})
    assert s.json()["status"] == "scheduled" and s.json()["schedule_timezone"] == "Asia/Kolkata"
    assert em.patch(f"{em.e}/campaigns/{c['id']}", json={"subject": "x"}).status_code == 409
    assert em.post(f"{em.e}/campaigns/{c['id']}/unschedule").json()["status"] == "draft"
    em.post(f"{em.e}/campaigns/{c['id']}/schedule", json={"scheduled_at": when, "timezone": "Asia/Kolkata"})
    assert dispatch_due() == 0
    with SessionLocal() as db:
        db.execute(update(EmailCampaign).where(EmailCampaign.id == c["id"])
                   .values(scheduled_at=datetime.now(UTC) - timedelta(minutes=1)))
        db.commit()
    assert dispatch_due() == 1
    assert em.get(f"{em.e}/campaigns/{c['id']}").json()["status"] == "completed"


def test_pause_resume_cancel(em):
    c = make_campaign(em)
    with SessionLocal() as db:
        db.execute(update(EmailCampaign).where(EmailCampaign.id == c["id"]).values(status="sending",
                                                                                   launched_at=datetime.now(UTC)))
        for email, cid in em.contacts.items():
            if email in ("asha@example.com", "ravi@example.com"):
                db.add(EmailMessage(organization_id=em.org["id"], application_id=em.app_id, campaign_id=c["id"],
                                    contact_id=cid, to_email=email))
        db.commit()
    assert em.post(f"{em.e}/campaigns/{c['id']}/pause").json()["status"] == "paused"
    assert em.post(f"{em.e}/campaigns/{c['id']}/resume").json()["status"] == "completed"
    c2 = make_campaign(em)
    with SessionLocal() as db:
        db.execute(update(EmailCampaign).where(EmailCampaign.id == c2["id"]).values(status="paused"))
        db.add(EmailMessage(organization_id=em.org["id"], application_id=em.app_id, campaign_id=c2["id"],
                            contact_id=em.contacts["asha@example.com"], to_email="asha@example.com"))
        db.commit()
    out = em.post(f"{em.e}/campaigns/{c2['id']}/cancel").json()
    assert out["status"] == "cancelled" and out["stats"]["skipped"] == 1
    assert em.delete(f"{em.e}/campaigns/{c2['id']}").status_code == 409


def test_preview_test_send_duplicate_and_templates(em):
    c = make_campaign(em)
    p = em.post(f"{em.e}/campaigns/{c['id']}/preview", json={"contact_id": em.contacts["asha@example.com"]}).json()
    assert p["subject"] == "Hi Asha, the sale is live" and "Hello Asha" in p["html"] and p["issues"]["unknown"] == []
    bad = em.post(f"{em.e}/campaigns/{c['id']}/preview", json={"html": "<p>{{favourite_colour}}</p>"}).json()
    assert bad["issues"]["unknown"] == ["favourite_colour"]
    t = em.post(f"{em.e}/campaigns/{c['id']}/test", json={"emails": ["qa@acme.example"]}).json()
    assert t["results"][0]["accepted"] is True and mailbox("qa@acme.example")[0]["subject"].startswith("[Test]")
    dup = em.post(f"{em.e}/campaigns/{c['id']}/duplicate").json()
    assert dup["status"] == "draft" and dup["html"] == HTML
    tpl = em.post(f"{em.e}/templates", json={"name": "Sale", "editor": "html", "html": "<p>Hi</p>",
                                             "subject": "Sale"}).json()
    from_tpl = em.post(f"{em.e}/campaigns", json={"name": "From template", "template_id": tpl["id"]}).json()
    assert from_tpl["html"] == "<p>Hi</p>" and from_tpl["subject"] == "Sale"
    assert em.post(f"{em.e}/templates/{tpl['id']}/duplicate").json()["name"] == "Sale (copy)"


def test_permissions_and_isolation(em):
    c = make_campaign(em)
    viewer = invite_and_join(em, "viewer@example.com", "viewer", [em.app_id])
    assert viewer.get(f"{em.e}/campaigns/{c['id']}").status_code == 200
    assert viewer.post(f"{em.e}/campaigns/{c['id']}/send").status_code == 403
    assert viewer.patch(f"{em.e}/campaigns/{c['id']}", json={"subject": "x"}).status_code == 403
    analyst = invite_and_join(em, "an@example.com", "campaign_manager", [em.app_id])
    assert analyst.post(f"{em.e}/senders", json={"from_name": "x", "from_email": "x@acme.example"}).status_code == 403
    bob = Api().register("bob@example.com")
    org = bob.create_org("Bobco")
    bob.create_app(org["id"], "Bob")
    for url in [f"{em.e}/campaigns", f"{em.e}/campaigns/{c['id']}", f"{em.e}/senders", f"{em.e}/overview"]:
        assert bob.get(url).status_code == 404
    make_pro(em.org["id"])  # a third application
    other = em.post("/applications", json={"organization_id": em.org["id"], "name": "Other"}).json()
    r = em.patch(f"/apps/{other['id']}/email/campaigns/{c['id']}", json={"subject": "x"})
    assert r.status_code == 404
    oc = em.post(f"/apps/{other['id']}/email/campaigns", json={"name": "x"}).json()
    r = em.patch(f"/apps/{other['id']}/email/campaigns/{oc['id']}", json={"sender_id": em.sender_id})
    assert r.status_code == 422 and r.json()["error"]["code"] == "INVALID_SENDER"


# ------------------------------------------------------------------ first-send guidance (UX fixes)

def _deep(levels: int) -> dict:
    node: dict = {"type": "text", "content": "Hello"}
    for i in range(levels):
        node = {"type": "cell", "attributes": {"id": f"c{i}"}, "components": [node]}
    return {"pages": [{"frames": [{"component": node}]}]}


def _depth(d) -> int:
    if isinstance(d, dict):
        return 1 + max((_depth(v) for v in d.values()), default=0)
    if isinstance(d, list):
        return 1 + max((_depth(v) for v in d), default=0)
    return 0


def test_deeply_nested_design_saves_through_campaign_and_template_apis(em):
    """Regression: MariaDB's JSON CHECK rejected designs nested more than 32 levels (autosave returned 500)."""
    design = _deep(60)
    assert _depth(design) > 120
    c = em.post(f"{em.e}/campaigns", json={"name": "Deep"}).json()
    r = em.patch(f"{em.e}/campaigns/{c['id']}", json={"design": design, "html": "<p>Hi</p>", "editor": "visual"})
    assert r.status_code == 200, r.text
    assert em.get(f"{em.e}/campaigns/{c['id']}").json()["design"] == design
    t = em.post(f"{em.e}/templates", json={"name": "Deep", "design": {"a": 1}, "html": "<p>x</p>"}).json()
    r = em.patch(f"{em.e}/templates/{t['id']}", json={"design": design})
    assert r.status_code == 200, r.text
    assert em.get(f"{em.e}/templates/{t['id']}").json()["design"] == design
    # Audience saved separately is untouched by a later design save, and a bad payload is a 4xx, never a 500.
    assert em.patch(f"{em.e}/campaigns/{c['id']}", json={"audience": {"all": True}}).status_code == 200
    bad = em.patch(f"{em.e}/campaigns/{c['id']}", json={"design": "not an object"})
    assert bad.status_code == 422
    assert em.get(f"{em.e}/campaigns/{c['id']}").json()["audience"]["all"] is True


def test_readiness_checks_are_self_describing_with_wallet_row(em):
    pending = em.post(f"{em.e}/senders", json={"from_name": "New", "from_email": "new@acme.example"}).json()
    c = em.post(f"{em.e}/campaigns", json={"name": "Guided"}).json()
    assert c["sender_id"] == em.sender_id  # a verified sender is preferred as the default
    em.patch(f"{em.e}/campaigns/{c['id']}", json={"sender_id": pending["id"]})
    rd = em.get(f"{em.e}/campaigns/{c['id']}/readiness").json()
    checks = {ch["key"]: ch for ch in rd["checks"]}
    sender = checks["sender"]
    assert sender["ok"] is False and sender["step"] == "setup"
    assert sender["action_url"] == f"{em.base}/email/senders" and sender["meta"]["status"] == "pending"
    assert sender["meta"]["sender_id"] == pending["id"]
    assert checks["audience"]["step"] == "audience" and checks["content"]["step"] == "content"
    assert rd["wallet"]["currency"] in ("INR", "USD") and "available" in rd["wallet"]
    em.patch(f"{em.e}/campaigns/{c['id']}", json={"sender_id": em.sender_id, "subject": "Hi", "html": "<p>Hi</p>",
                                                   "audience": {"all": True}})
    rd = em.get(f"{em.e}/campaigns/{c['id']}/readiness").json()
    wallet = next(ch for ch in rd["checks"] if ch["key"] == "wallet")
    assert {"available", "need", "currency", "estimate", "can_top_up"} <= set(wallet["meta"])
    assert wallet["meta"]["can_top_up"] is True  # the owner may buy credit
    assert rd["cost"]["currency"] == "INR" and rd["cost"]["total"] == pytest.approx(rd["cost"]["unit_price"] * 4)


def test_postal_address_check_links_to_compliance_settings(owner):
    app = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "US Mail 2",
                                             "default_country": "US"}).json()
    e = f"/apps/{app['id']}/email"
    c = owner.post(f"{e}/campaigns", json={"name": "US"}).json()
    checks = {ch["key"]: ch for ch in owner.get(f"{e}/campaigns/{c['id']}/readiness").json()["checks"]}
    assert checks["postal_address"]["action_url"] == f"/apps/{app['id']}/settings?tab=compliance"
    assert checks["sender"]["detail"] == "Choose a sender address"


def test_contact_ids_audience_mode_and_new_campaign_with_audience(em):
    ids = [em.contacts["asha@example.com"], em.contacts["noconsent@example.com"]]
    est = em.post(f"{em.e}/campaigns/estimate", json={"contact_ids": ids}).json()
    assert (est["matched"], est["eligible"]) == (2, 1)
    c = em.post(f"{em.e}/campaigns", json={"name": "Picked", "audience": {"contact_ids": ids}})
    assert c.status_code == 201 and c.json()["audience"]["contact_ids"] == ids
    seg = em.post(f"{em.e}/campaigns", json={"name": "Seg", "audience": {"segment_ids": [em.segment_id]}}).json()
    assert seg["audience"]["segment_ids"] == [em.segment_id]
    # Contacts of another application or unknown ids are rejected; at most 1,000 explicit contacts.
    bad = em.post(f"{em.e}/campaigns", json={"name": "Bad", "audience": {"contact_ids": ["nope"]}})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_AUDIENCE"
    too_many = em.post(f"{em.e}/campaigns/estimate", json={"contact_ids": [f"id-{i}" for i in range(1001)]})
    assert too_many.status_code == 422
    c = make_campaign(em, audience={"contact_ids": ids})
    assert em.post(f"{em.e}/campaigns/{c['id']}/send").status_code == 200
    done = em.get(f"{em.e}/campaigns/{c['id']}").json()
    assert done["recipient_count"] == 1 and mailbox("asha@example.com") and not mailbox("ravi@example.com")


def test_recipient_ids_resolve_report_filters(em):
    c = make_campaign(em)
    em.post(f"{em.e}/campaigns/{c['id']}/send")
    html = campaign_mail("asha@example.com")["html"]
    Api().get(re.search(r"/api/v1(/t/o/[^\"]+\.gif)", html).group(1))
    r = em.get(f"{em.e}/campaigns/{c['id']}/recipients/ids", params={"status": "opened"}).json()
    assert r["contact_ids"] == [em.contacts["asha@example.com"]] and r["total"] == 1 and r["truncated"] is False
    non = em.get(f"{em.e}/campaigns/{c['id']}/recipients/ids", params={"status": "not_opened"}).json()
    assert set(non["contact_ids"]) == {em.contacts["ravi@example.com"]}  # the bounce is not a non-opener
    bounced = em.get(f"{em.e}/campaigns/{c['id']}/recipients/ids", params={"status": "bounced"}).json()
    assert bounced["contact_ids"] == [em.contacts["bounce@example.com"]]
    every = em.get(f"{em.e}/campaigns/{c['id']}/recipients/ids").json()
    assert every["total"] == 3 and every["limit"] == 5000
