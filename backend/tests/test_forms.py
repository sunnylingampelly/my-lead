"""Lead forms: CRUD, publish and versions, plan limit, the embed loader and pages (CSP), public submissions
(contact, consent, lists, tags, activity, CRM owner, trigger, notifications), validation and spam protection,
idempotency, double opt-in, conditional fields, CSV export and analytics."""
import time

import pytest
from sqlalchemy import select

from app.core.database import SessionLocal
from app.models import ConsentRecord, Contact, ContactActivity, CrmEvent, Notification
from app.models.forms import LeadFormSubmission
from app.services.forms import security
from tests.conftest import invite_and_join, mailbox, make_pro


@pytest.fixture
def fa(owner):
    a = owner
    a.app_id = a.app["id"]
    a.f = f"/apps/{a.app_id}/forms"
    return a


def _create(a, template="contact", name="Contact us") -> dict:
    r = a.post(a.f, json={"name": name, "template": template})
    assert r.status_code == 201, r.text
    return r.json()


def _publish(a, form) -> dict:
    r = a.post(f"{a.f}/{form['id']}/publish")
    assert r.status_code == 200, r.text
    return r.json()


def _token(public_id: str, age: float = 10) -> str:
    return security.render_token(public_id, now=time.time() - age)


def _submit(a, form, values, client_id="client-0001", age: float = 10, headers=None, **extra):
    body = {"client_id": client_id, "values": values, "render_token": _token(form["public_id"], age),
            "page_url": "https://acme.example/contact?utm_source=google", "referrer": "https://www.google.com/",
            "utm": {"utm_source": "google", "utm_medium": "cpc"}, **extra}
    return a.client.post(f"/api/v1/public/forms/{form['public_id']}/submit", json=body, headers=headers or {})


def _update_draft(a, form, mutate) -> dict:
    d = a.get(f"{a.f}/{form['id']}").json()["draft"]
    mutate(d)
    r = a.patch(f"{a.f}/{form['id']}", json={"draft": d})
    assert r.status_code == 200, r.text
    return r.json()


CONTACT = {"first_name": "Asha", "last_name": "Rao", "email": "asha@example.com",
           "phone": {"country": "IN", "number": "98765 43210"}, "message": "Need a quote", "consent": True}


# ------------------------------------------------------------------ CRUD, publish, versions, limit

def test_crud_publish_versions_and_draft_isolation(fa):
    a = fa
    tpls = a.get(f"{a.f}/templates").json()
    assert {"newsletter", "contact", "demo", "event", "guide", "callback"} <= {t["key"] for t in tpls}
    form = _create(a)
    assert form["status"] == "draft" and form["published_version"] is None and form["has_unpublished_changes"]
    assert [f["id"] for f in form["draft"]["fields"]][:3] == ["first_name", "last_name", "email"]
    assert form["embed"]["inline"].count(form["public_id"]) == 1 and "/embed/forms.js" in form["embed"]["inline"]
    assert form["branding"] is True  # Starter
    # Not live until published.
    assert a.client.get(f"/embed/form/{form['public_id']}").status_code == 404
    pub = _publish(a, form)
    assert pub["status"] == "published" and pub["published_version"] == 1 and not pub["has_unpublished_changes"]
    # Editing the draft does not change the live form.
    edited = _update_draft(a, form, lambda d: d.update(title="Brand new title"))
    assert edited["has_unpublished_changes"]
    page = a.client.get(f"/embed/form/{form['public_id']}").text
    assert "Brand new title" not in page and "Contact us" in page
    assert _publish(a, form)["published_version"] == 2
    assert "Brand new title" in a.client.get(f"/embed/form/{form['public_id']}").text
    assert [v["version"] for v in a.get(f"{a.f}/{form['id']}/versions").json()] == [2, 1]
    # Discard reverts the draft; pause takes it offline.
    _update_draft(a, form, lambda d: d.update(title="Oops"))
    assert a.post(f"{a.f}/{form['id']}/discard").json()["draft"]["title"] == "Brand new title"
    assert a.post(f"{a.f}/{form['id']}/pause").json()["status"] == "paused"
    assert a.client.get(f"/embed/form/{form['public_id']}").status_code == 404
    rows = a.get(a.f).json()
    assert rows[0]["id"] == form["id"] and rows[0]["status"] == "paused"
    assert a.patch(f"{a.f}/{form['id']}", json={"name": "Renamed"}).json()["name"] == "Renamed"
    assert a.delete(f"{a.f}/{form['id']}").status_code == 204
    assert a.get(f"{a.f}/{form['id']}").status_code == 404


def test_definition_validation_and_publish_checks(fa):
    a = fa
    form = _create(a)
    d = a.get(f"{a.f}/{form['id']}").json()["draft"]
    d["success"]["redirect_url"] = "javascript:alert(1)"
    assert a.patch(f"{a.f}/{form['id']}", json={"draft": d}).status_code == 422
    d["success"]["redirect_url"] = None
    d["success"]["message_html"] = '<p onclick="x()">Hi <script>alert(1)</script><a href="javascript:x">l</a></p>'
    out = a.patch(f"{a.f}/{form['id']}", json={"draft": d}).json()
    assert out["draft"]["success"]["message_html"] == "<p>Hi <a>l</a></p>"
    d = out["draft"]
    d["success"]["mode"] = "redirect"
    a.patch(f"{a.f}/{form['id']}", json={"draft": d})
    r = a.post(f"{a.f}/{form['id']}/publish")
    assert r.status_code == 422 and r.json()["error"]["code"] == "REDIRECT_REQUIRED"
    d["success"]["mode"] = "message"
    d["fields"] = [f for f in d["fields"] if f["type"] not in ("email", "phone")]
    a.patch(f"{a.f}/{form['id']}", json={"draft": d})
    r = a.post(f"{a.f}/{form['id']}/publish")
    assert r.status_code == 422 and r.json()["error"]["code"] == "IDENTIFIER_FIELD_REQUIRED"


def test_plan_limit_on_create_and_duplicate(fa):
    a = fa
    forms = [_create(a, "blank", f"Form {i}") for i in range(3)]
    r = a.post(a.f, json={"name": "Fourth"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "PLAN_LIMIT"
    assert a.post(f"{a.f}/{forms[0]['id']}/duplicate").json()["error"]["code"] == "PLAN_LIMIT"
    assert a.get(f"{a.f}/meta").json()["usage"] == {"used": 3, "limit": 3}
    make_pro(a.org["id"])
    dup = a.post(f"{a.f}/{forms[0]['id']}/duplicate")
    assert dup.status_code == 201 and dup.json()["name"] == "Form 0 (copy)" and dup.json()["branding"] is False


def test_permissions(fa):
    a = fa
    form = _create(a)
    viewer = invite_and_join(a, "viewer@example.com", "viewer", [a.app_id])
    assert viewer.get(a.f).status_code == 200
    assert viewer.post(a.f, json={"name": "Nope"}).status_code == 403
    assert viewer.post(f"{a.f}/{form['id']}/publish").status_code == 403


# ------------------------------------------------------------------ embed assets and pages

def test_loader_and_embed_page_headers(fa):
    a = fa
    form = _publish(a, _create(a))
    js = a.client.get("/embed/forms.js")
    assert js.status_code == 200 and "javascript" in js.headers["content-type"]
    assert "max-age" in js.headers["cache-control"] and len(js.content) < 10_000
    assert "immutable" in a.client.get("/embed/forms.js?v=1").headers["cache-control"]
    assert a.client.get("/embed/forms.js", headers={"If-None-Match": js.headers["etag"]}).status_code == 304
    page = a.client.get(f"/embed/form/{form['public_id']}?iid=f1&page=https://acme.example/")
    assert page.status_code == 200
    assert "frame-ancestors *" in page.headers["content-security-policy"]
    assert "x-frame-options" not in page.headers
    assert 'for="f_email"' in page.text and 'id="f_email"' in page.text and "sc_website" in page.text
    assert "Powered by" in page.text  # Starter branding
    hosted = a.client.get(f"/embed/f/{form['public_id']}")
    assert hosted.status_code == 200 and 'property="og:title"' in hosted.text
    # Allowed domains narrow frame-ancestors.
    _update_draft(a, form, lambda d: d["settings"].update(allowed_domains=["acme.example"]))
    _publish(a, form)
    csp = a.client.get(f"/embed/form/{form['public_id']}").headers["content-security-policy"]
    assert "https://acme.example" in csp and "frame-ancestors *" not in csp
    cfg = a.client.get(f"/api/v1/public/forms/{form['public_id']}").json()
    assert cfg["display"]["mode"] == "inline"
    assert a.client.get("/embed/forms-assets/form.js?v=x").status_code == 200
    assert a.client.get("/embed/forms-assets/secret.py").status_code == 404


def test_embed_page_escapes_definition(fa):
    a = fa
    form = _create(a)
    _update_draft(a, form, lambda d: (d.update(title='<script>alert("t")</script>'),
                                      d["fields"][0].update(label='"><img src=x onerror=alert(1)>')))
    _publish(a, form)
    html = a.client.get(f"/embed/f/{form['public_id']}").text
    assert "<script>alert" not in html and "<img src=x" not in html
    assert "&lt;script&gt;" in html


# ------------------------------------------------------------------ submissions

def test_submit_happy_path_is_fully_connected(fa):
    a = fa
    lst = a.post(f"/apps/{a.app_id}/lists", json={"name": "Website leads"}).json()
    tag = a.post(f"/apps/{a.app_id}/tags", json={"name": "web"}).json()
    rule = a.post(f"/apps/{a.app_id}/crm/assignment-rules",
                  json={"name": "All", "user_ids": [a.user["id"]], "conditions": {}, "active": True})
    assert rule.status_code in (200, 201), rule.text
    form = _create(a)
    _update_draft(a, form, lambda d: d["settings"].update(
        list_ids=[lst["id"]], tag_ids=[tag["id"]], notify_user_ids=[a.user["id"]], source="Website contact"))
    form = _publish(a, form)
    r = _submit(a, form, CONTACT, headers={"Origin": "https://acme.example"})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] and "Thank you" in r.json()["message_html"]
    with SessionLocal() as db:
        sub = db.scalar(select(LeadFormSubmission))
        assert sub.status == "new" and sub.values["email"] == "asha@example.com"
        assert sub.values["phone"] == "+919876543210" and sub.utm["utm_source"] == "google"
        assert sub.ip_hash and sub.ip_hash != "testclient"
        c = db.get(Contact, sub.contact_id)
        assert (c.first_name, c.last_name, c.email, c.phone) == ("Asha", "Rao", "asha@example.com", "+919876543210")
        assert c.source == "Website contact" and c.lifecycle_stage == "lead" and c.owner_id == a.user["id"]
        assert c.email_consent is True
        cr = db.scalar(select(ConsentRecord).where(ConsentRecord.contact_id == c.id))
        assert cr.method == "form" and "Contact us" in cr.source and "acme.example/contact" in cr.evidence
        acts = {x.type for x in db.scalars(select(ContactActivity).where(ContactActivity.contact_id == c.id))}
        assert "form_submitted" in acts
        ev = db.scalar(select(CrmEvent).where(CrmEvent.kind == "form_submitted"))
        assert ev.contact_id == c.id and ev.data["form_id"] == form["id"]
        n = db.scalars(select(Notification).where(Notification.type == "form_submission")).all()
        assert len(n) == 1
    contact = a.get(f"/apps/{a.app_id}/contacts/{sub.contact_id}").json()
    assert [t["name"] for t in contact["tags"]] == ["web"] and contact["lists"][0]["id"] == lst["id"]
    assert mailbox("owner@example.com")[-1]["subject"].startswith("New submission")
    # The submission shows in the list with its labels and contact.
    page = a.get(f"{a.f}/{form['id']}/submissions").json()
    assert page["total"] == 1 and page["items"][0]["contact_name"] == "Asha Rao"
    assert page["items"][0]["labels"]["email"] == "Email"
    assert a.get(f"{a.f}/{form['id']}/submissions", params={"search": "nomatch"}).json()["total"] == 0
    assert a.get(f"{a.f}/{form['id']}/submissions", params={"search": "asha"}).json()["total"] == 1


def test_automation_trigger_filters_by_form(fa):
    from app.services.crm.automation import candidates
    from app.utils.time import utcnow

    a = fa
    form = _publish(a, _create(a))
    since = utcnow()
    assert _submit(a, form, CONTACT).status_code == 200
    with SessionLocal() as db:
        any_form = candidates(db, a.app_id, {"kind": "form_submitted"}, since, True, 100)
        this = candidates(db, a.app_id, {"kind": "form_submitted", "form_id": form["id"]}, since, True, 100)
        other = candidates(db, a.app_id, {"kind": "form_submitted", "form_id": "nope"}, since, True, 100)
    assert len(any_form) == 1 and this == any_form and other == []


def test_validation_errors(fa):
    a = fa
    form = _publish(a, _create(a))
    r = _submit(a, form, {"first_name": "", "email": "not-an-email", "phone": {"country": "IN", "number": "12"},
                          "message": "x" * 6000})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "INVALID_FIELDS"
    assert set(err["details"]["fields"]) == {"first_name", "email", "phone", "message"}
    with SessionLocal() as db:
        assert db.scalar(select(LeadFormSubmission)) is None


def test_spam_protection(fa, monkeypatch):
    a = fa
    form = _publish(a, _create(a))
    # Honeypot: looks like success to the bot, stored as spam, no contact.
    r = _submit(a, form, CONTACT, client_id="bot-00001", hp="http://spam.example")
    assert r.status_code == 200 and r.json()["ok"]
    with SessionLocal() as db:
        s = db.scalar(select(LeadFormSubmission))
        assert s.status == "spam" and s.spam_reason == "honeypot" and s.contact_id is None
        assert db.scalar(select(Contact)) is None
    # Too fast, missing and forged tokens.
    assert _submit(a, form, CONTACT, client_id="fast-0001", age=0.5).json()["error"]["code"] == "TOO_FAST"
    bad = {"client_id": "forge-001", "values": CONTACT, "render_token": "abc.def"}
    assert a.client.post(f"/api/v1/public/forms/{form['public_id']}/submit", json=bad).json()["error"]["code"] \
        == "INVALID_TOKEN"
    other = _publish(a, _create(a, "blank", "Other"))
    stolen = {"client_id": "forge-002", "values": CONTACT, "render_token": _token(other["public_id"])}
    assert a.client.post(f"/api/v1/public/forms/{form['public_id']}/submit", json=stolen).status_code == 422
    # Origin not allowed.
    _update_draft(a, form, lambda d: d["settings"].update(allowed_domains=["acme.example"]))
    _publish(a, form)
    r = _submit(a, form, CONTACT, client_id="evil-0001", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "ORIGIN_NOT_ALLOWED"
    r = _submit(a, form, CONTACT, client_id="evil-0002", page_url="https://evil.example/page")
    assert r.status_code == 403
    assert _submit(a, form, CONTACT, client_id="good-0001",
                   headers={"Origin": "https://www.acme.example"}).status_code == 200
    # Rate limit per IP.
    monkeypatch.setitem(security.LIMITS, "submit_ip", (2, 600))
    codes = [_submit(a, form, {**CONTACT, "email": f"p{i}@example.com"}, client_id=f"rate-{i:04d}").status_code
             for i in range(3)]
    assert codes[-1] == 429


def test_turnstile_required_when_enabled(fa, monkeypatch):
    from app.core.config import settings

    a = fa
    monkeypatch.setattr(settings, "TURNSTILE_SITE_KEY", "site")
    monkeypatch.setattr(settings, "TURNSTILE_SECRET_KEY", "secret")
    monkeypatch.setattr(security, "verify_turnstile", lambda token, ip: token == "good")
    form = _create(a)
    _update_draft(a, form, lambda d: d["settings"].update(turnstile=True))
    form = _publish(a, form)
    assert "cf-turnstile" in a.client.get(f"/embed/form/{form['public_id']}").text
    assert _submit(a, form, CONTACT, client_id="ts-000001").json()["error"]["code"] == "TURNSTILE_FAILED"
    assert _submit(a, form, CONTACT, client_id="ts-000002", turnstile_token="good").status_code == 200


def test_idempotent_resubmit(fa):
    a = fa
    form = _publish(a, _create(a))
    first = _submit(a, form, CONTACT, client_id="same-0001")
    again = _submit(a, form, CONTACT, client_id="same-0001")
    assert first.status_code == again.status_code == 200 and first.json() == again.json()
    with SessionLocal() as db:
        assert len(db.scalars(select(LeadFormSubmission)).all()) == 1
        assert len(db.scalars(select(Contact)).all()) == 1
    # A second, different submission by the same person updates the contact, not a duplicate.
    assert _submit(a, form, {**CONTACT, "last_name": "Rao-Kumar"}, client_id="same-0002").status_code == 200
    with SessionLocal() as db:
        cs = db.scalars(select(Contact)).all()
        assert len(cs) == 1 and cs[0].last_name == "Rao-Kumar"


def test_conditional_required_field_ignored_when_hidden(fa):
    a = fa
    form = _publish(a, _create(a, "event", "Event"))
    base = {"first_name": "Ravi", "email": "ravi@example.com"}
    # "dietary" shows only for in-person attendance; it isn't required here but must be dropped when hidden.
    r = _submit(a, form, {**base, "attendance": "Online", "dietary": "vegan"}, client_id="cond-0001")
    assert r.status_code == 200, r.text
    with SessionLocal() as db:
        s = db.scalar(select(LeadFormSubmission))
        assert "dietary" not in s.values and s.values["attendance"] == "Online"
    _update_draft(a, form, lambda d: [f.update(required=True) for f in d["fields"] if f["id"] == "dietary"])
    _publish(a, form)
    assert _submit(a, form, {**base, "attendance": "Online"}, client_id="cond-0002").status_code == 200
    r = _submit(a, form, {**base, "attendance": "In person"}, client_id="cond-0003")
    assert r.status_code == 422 and "dietary" in r.json()["error"]["details"]["fields"]
    # Checkbox values map to tags.
    assert _submit(a, form, {**base, "attendance": "In person", "dietary": "none", "sessions": ["Keynote"]},
                   client_id="cond-0004").status_code == 200
    c = a.get(f"/apps/{a.app_id}/contacts", params={"search": "ravi"}).json()["items"][0]
    assert "Keynote" in [t["name"] for t in c["tags"]]


def test_double_opt_in(fa):
    a = fa
    r = a.post(f"/apps/{a.app_id}/email/senders", json={"from_name": "Acme", "from_email": "hello@acme.example"})
    assert r.status_code == 201, r.text
    from app.models.email import EmailSender

    with SessionLocal() as db:
        s = db.get(EmailSender, r.json()["id"])
        s.status = "verified"
        db.commit()
    form = _create(a, "newsletter", "Newsletter")
    _update_draft(a, form, lambda d: d["settings"].update(double_opt_in=True))
    form = _publish(a, form)
    r = _submit(a, form, {"first_name": "Meera", "email": "meera@example.com"})
    assert r.status_code == 200 and r.json()["pending_confirmation"] is True
    with SessionLocal() as db:
        sub = db.scalar(select(LeadFormSubmission))
        c = db.get(Contact, sub.contact_id)
        assert sub.status == "pending_confirmation" and c.email_consent is False
        assert db.scalar(select(CrmEvent).where(CrmEvent.kind == "form_submitted")) is None
    mail = mailbox("meera@example.com")[-1]
    assert mail["from"].endswith("<hello@acme.example>")
    import re

    token = re.search(r"/embed/forms/confirm\?token=([^\s\"&<]+)", mail["text"]).group(1)
    page = a.client.get(f"/embed/forms/confirm?token={token}")
    assert page.status_code == 200 and "confirmed" in page.text
    with SessionLocal() as db:
        sub = db.scalar(select(LeadFormSubmission))
        c = db.get(Contact, sub.contact_id)
        assert sub.status == "confirmed" and sub.confirmed_at and c.email_consent is True
        assert db.scalar(select(CrmEvent).where(CrmEvent.kind == "form_submitted")) is not None
    assert "Already" in a.client.get(f"/embed/forms/confirm?token={token}").text
    assert a.client.get("/embed/forms/confirm?token=forged.token").status_code == 400
    expired = security.sign("confirm", f"{sub.id}|{int(time.time()) - 10}")
    assert "Already" in a.client.get(f"/embed/forms/confirm?token={expired}").text  # confirmed wins over expiry


def test_spam_mark_delete_export_and_analytics(fa):
    a = fa
    form = _publish(a, _create(a))
    pid = form["public_id"]
    for _ in range(4):
        assert a.client.post(f"/api/v1/public/forms/{pid}/event", json={"type": "view"}).status_code == 204
    a.client.post(f"/api/v1/public/forms/{pid}/event", json={"type": "start"})
    a.client.post(f"/api/v1/public/forms/{pid}/event", json={"type": "start"})
    assert _submit(a, form, CONTACT).status_code == 200
    assert _submit(a, form, {**CONTACT, "email": "ravi@example.com", "first_name": "=HYPERLINK(1)"},
                   client_id="client-0002").status_code == 200
    an = a.get(f"{a.f}/{form['id']}/analytics", params={"days": 7}).json()
    assert (an["views"], an["starts"]) == (4, 2) and an["submissions"] >= 1
    assert an["conversion"] == round(100 * an["submissions"] / 4, 1) and len(an["daily"]) == 7
    assert an["top_pages"][0]["value"] == "acme.example/contact"
    assert an["top_referrers"][0]["value"] == "www.google.com" and an["top_utm_sources"][0]["value"] == "google"
    lst = a.get(a.f).json()[0]
    assert lst["views_30d"] == 4 and lst["submissions_30d"] == an["submissions"] and lst["last_submission_at"]
    csv = a.get(f"{a.f}/{form['id']}/submissions/export")
    assert csv.status_code == 200 and "text/csv" in csv.headers["content-type"]
    lines = csv.text.lstrip("﻿").splitlines()
    assert lines[0].startswith("submitted_at,status,contact_id,First name,Last name,Email")
    assert "asha@example.com" in csv.text and "'=HYPERLINK(1)" in csv.text  # formula injection neutralised
    sid = a.get(f"{a.f}/{form['id']}/submissions").json()["items"][-1]["id"]
    assert a.post(f"{a.f}/{form['id']}/submissions/{sid}/spam", json={"spam": True}).json()["status"] == "spam"
    assert a.get(f"{a.f}/{form['id']}/submissions", params={"status": "spam"}).json()["total"] == 1
    assert a.post(f"{a.f}/{form['id']}/submissions/{sid}/spam", json={"spam": False}).json()["status"] == "new"
    assert a.delete(f"{a.f}/{form['id']}/submissions/{sid}").status_code == 204
    assert a.get(f"{a.f}/{form['id']}/submissions", params={"status": "spam"}).json()["total"] == 0


def test_send_to_developer_and_dashboard_checklist(fa):
    a = fa
    form = _create(a)
    items = {c["key"]: c for c in a.get(f"/apps/{a.app_id}/dashboard").json()["checklist"]}
    assert items["lead_form"]["done"] is False and items["lead_form"]["href"].endswith("/forms")
    _publish(a, form)
    items = {c["key"]: c for c in a.get(f"/apps/{a.app_id}/dashboard").json()["checklist"]}
    assert items["lead_form"]["done"] is True
    r = a.post(f"{a.f}/{form['id']}/send-to-developer", json={"email": "dev@example.com", "note": "Footer please"})
    assert r.json() == {"sent": True}
    mail = mailbox("dev@example.com")[-1]
    assert form["public_id"] in mail["text"] and "Footer please" in mail["text"]
