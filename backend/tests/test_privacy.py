"""Data-subject rights: full export of a contact's data and erasure everywhere (DPDP Act 2023 / GDPR)."""
import csv
import io
import json
import zipfile

import pytest
from sqlalchemy import func, select, text

from app.core.database import SessionLocal
from app.integrations.storage import get_storage
from app.models import (
    AuditLog,
    Base,
    ChatBot,
    ChatConversation,
    ChatMessage,
    ChatVisitor,
    Company,
    Contact,
    CrmNote,
    CrmTask,
    DataRequest,
    Deal,
    EmailCampaign,
    EmailEvent,
    EmailMessage,
    Import,
    ImportRow,
    LeadForm,
    LeadFormSubmission,
    Pipeline,
    PipelineStage,
    SmsCampaign,
    SmsInbound,
    SmsMessage,
    SuppressionEntry,
    VoiceCall,
    VoiceCampaign,
    WebhookEvent,
)
from tests.conftest import invite_and_join

EMAIL, PHONE, NAME = "priya.sharma@example.com", "+919876543210", "Priya Sharma"
SECRETS = (EMAIL, "9876543210", NAME.lower(), "priya.sharma")


def _upload(api, rows: list[list[str]]) -> dict:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Name", "Email Address", "Mobile"])
    w.writerows(rows)
    r = api.client.post(f"/api/v1{api.base}/contacts/import", headers=api.headers,
                        files={"file": ("people.csv", buf.getvalue().encode(), "text/csv")})
    assert r.status_code == 201, r.text
    imp = r.json()
    body = {"mapping": {"Name": "full_name", "Email Address": "email", "Mobile": "phone"},
            "options": {"duplicate_handling": "skip"}}
    r = api.post(f"{api.base}/imports/{imp['id']}/start", json=body)
    assert r.status_code == 200, r.text
    return api.get(f"{api.base}/imports/{imp['id']}").json()


@pytest.fixture
def subject(owner):
    """A contact with data in every area that holds personal data, plus a bystander who must be untouched."""
    a = owner
    a.base = f"/apps/{a.app['id']}"
    org_id, app_id = a.org["id"], a.app["id"]
    r = a.post(f"{a.base}/contacts", json={"first_name": "Priya", "last_name": "Sharma", "email": EMAIL,
                                           "phone": PHONE, "city": "Pune", "attributes": {}})
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    other = a.post(f"{a.base}/contacts", json={"first_name": "Rahul", "last_name": "Verma",
                                               "email": "rahul@example.com"}).json()["id"]
    r = a.post(f"{a.base}/contacts/{cid}/consent", json={"channel": "email", "status": "granted",
                                                         "source": "Website form", "evidence": "Signed form #42"})
    assert r.status_code == 200, r.text
    tag = a.post(f"{a.base}/tags", json={"name": "VIP"}).json()
    assert a.post(f"{a.base}/contacts/{cid}/tags/{tag['id']}").status_code == 204
    # An import in which she was a duplicate row: the raw row, the preview and the stored file hold her data.
    _upload(a, [[NAME, EMAIL, "+91 98765 43210"], ["Anil Kumar", "anil@example.com", "+91 98123 45678"]])

    t = dict(organization_id=org_id, application_id=app_id)
    with SessionLocal() as db:
        ec = EmailCampaign(name="Diwali offer", subject="Hello", **t)
        sc = SmsCampaign(name="Diwali SMS", **t)
        vc = VoiceCampaign(name="Renewal calls", **t)
        bot = ChatBot(public_key="pk-privacy-test", name="Helper", **t)
        form = LeadForm(public_id="pf-privacy", name="Contact us", draft={}, **t)
        pipe = Pipeline(name="Sales", **t)
        db.add_all([ec, sc, vc, bot, form, pipe])
        db.flush()
        stage = PipelineStage(pipeline_id=pipe.id, application_id=app_id, name="New")
        company = Company(name="Acme Buyers", **t)
        db.add_all([stage, company])
        db.flush()
        em = EmailMessage(campaign_id=ec.id, contact_id=cid, to_email=EMAIL, status="delivered", **t)
        db.add(em)
        db.flush()
        db.add(EmailEvent(campaign_id=ec.id, message_id=em.id, contact_id=cid, type="clicked",
                          url=f"https://shop.example.com/?u={EMAIL}", **t))
        db.add(EmailMessage(campaign_id=ec.id, contact_id=other, to_email="rahul@example.com", status="delivered",
                            **t))
        db.add(SmsMessage(campaign_id=sc.id, contact_id=cid, to_phone=PHONE, body="Hi Priya, 20% off", **t))
        db.add(SmsInbound(contact_id=cid, from_phone=PHONE, body="STOP", keyword="stop", **t))
        db.add(VoiceCall(campaign_id=vc.id, contact_id=cid, to_phone=PHONE, status="completed", duration_seconds=42,
                         transcript=[{"role": "user", "text": "This is Priya Sharma speaking"}],
                         ai_summary="Priya Sharma wants a callback", **t))
        visitor = ChatVisitor(bot_id=bot.id, name="Priya", email=EMAIL, phone=PHONE, ip_address="10.0.0.9",
                              attributes={}, pages=[], utm={}, **t)
        db.add(visitor)
        db.flush()
        conv = ChatConversation(bot_id=bot.id, visitor_id=visitor.id, contact_id=cid, status="closed",
                                page_url="https://example.com/pricing", tags=[], **t)
        db.add(conv)
        db.flush()
        db.add(ChatMessage(conversation_id=conv.id, role="visitor", body=f"My email is {EMAIL}", meta={}, **t))
        db.add(LeadFormSubmission(form_id=form.id, client_id="c1", contact_id=cid, status="new",
                                  values={"name": NAME, "email": EMAIL}, utm={}, user_agent="Mozilla", **t))
        db.add(CrmNote(body="Prefers WhatsApp", contact_id=cid, **t))
        db.add(CrmNote(body="Spoke to Priya Sharma (98765 43210) about the bulk order", company_id=company.id, **t))
        db.add(CrmTask(title="Call back", contact_id=cid, **t))
        db.add(Deal(title="Priya Sharma renewal", pipeline_id=pipe.id, stage_id=stage.id, contact_id=cid,
                    amount=5000, **t))
        db.add(WebhookEvent(provider="ses", event_id="evt-1", payload={"mail": {"destination": [EMAIL]}}))
        db.commit()
    a.cid, a.other = cid, other
    return a


def test_export_contains_everything(subject):
    a = subject
    r = a.get(f"{a.base}/contacts/{a.cid}/data-export")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert "attachment" in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    assert {"contact.json", "profile.csv", "consents.csv", "messages.csv", "form_submissions.csv", "crm_notes.csv",
            "crm_tasks.csv", "crm_deals.csv", "activities.csv", "README.txt"} <= names
    data = json.loads(z.read("contact.json"))
    assert data["profile"]["email"] == EMAIL and data["profile"]["phone"] == PHONE
    assert data["consents"][0]["evidence"] == "Signed form #42"
    assert data["tags"] == ["VIP"]
    m = data["messages"]
    assert m["email"][0]["campaign"] == "Diwali offer" and m["email"][0]["events"][0]["type"] == "clicked"
    assert m["sms"][0]["body"] == "Hi Priya, 20% off" and m["sms_replies"][0]["body"] == "STOP"
    assert m["voice_calls"][0]["transcript"][0]["text"] == "This is Priya Sharma speaking"
    assert m["chat_conversations"][0]["messages"][0]["body"] == f"My email is {EMAIL}"
    assert data["chat_visitor_profiles"][0]["ip_address"] == "10.0.0.9"
    assert data["form_submissions"][0]["values"]["email"] == EMAIL
    assert data["crm"]["notes"][0]["body"] == "Prefers WhatsApp"
    assert data["crm"]["tasks"][0]["title"] == "Call back"
    assert data["crm"]["deals"][0]["title"] == "Priya Sharma renewal"
    assert any(x["type"] == "consent_granted" for x in data["activity"])
    assert "Hi Priya" in z.read("messages.csv").decode("utf-8-sig")
    # Logged without personal data.
    log = a.get(f"/organizations/{a.org['id']}/data-requests").json()
    assert log["total"] == 1 and log["items"][0]["kind"] == "export"
    assert log["items"][0]["subject_label"] != EMAIL and log["items"][0]["requested_by_name"] == "Olivia Owner"
    with SessionLocal() as db:
        entry = db.scalar(select(AuditLog).where(AuditLog.action == "contact.data_exported"))
        assert EMAIL not in json.dumps(entry.meta) + (entry.summary or "")


def test_privacy_actions_need_owner_or_admin(subject):
    a = subject
    cm = invite_and_join(a, "cm@example.com", "campaign_manager", [a.app["id"]])
    r = cm.get(f"{a.base}/contacts/{a.cid}/data-export")
    assert r.status_code == 403 and r.json()["error"]["code"] == "PERMISSION_DENIED"
    r = cm.post(f"{a.base}/contacts/{a.cid}/erase", json={"confirm": "ERASE"})
    assert r.status_code == 403
    assert cm.get(f"/organizations/{a.org['id']}/data-requests").status_code == 403


def _all_rows_text() -> str:
    """Every row of every table, as one lower-case string (to prove nothing personal survives)."""
    parts = []
    with SessionLocal() as db:
        for table in Base.metadata.sorted_tables:
            for row in db.execute(table.select()):
                parts.append(" ".join(str(v) for v in row))
    return "\n".join(parts).lower()


def test_erasure_removes_personal_data_everywhere(subject):
    a = subject
    a.get(f"{a.base}/contacts/{a.cid}/data-export")  # an earlier export shows a masked label in the log
    with SessionLocal() as db:
        sent_before = db.scalar(select(func.count()).select_from(EmailMessage))
        imp_key = db.scalar(select(Import.file_key))
    assert EMAIL in get_storage().get(imp_key).decode()

    r = a.post(f"{a.base}/contacts/{a.cid}/erase", json={"confirm": "erase please"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "CONFIRMATION_REQUIRED"
    r = a.post(f"{a.base}/contacts/{a.cid}/erase", json={"confirm": "ERASE"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["already_erased"] is False and out["details"]["contacts"] == 1

    everything = _all_rows_text()
    for secret in SECRETS:
        assert secret not in everything, f"{secret!r} survived erasure"
    with SessionLocal() as db:
        assert db.get(Contact, a.cid) is None
        imp_key = db.scalar(select(Import.file_key))
        # Aggregates survive: campaign rows are anonymised, not removed.
        assert db.scalar(select(func.count()).select_from(EmailMessage)) == sent_before
        assert db.scalar(select(VoiceCall.duration_seconds)) == 42
        assert db.scalar(select(func.count()).select_from(LeadFormSubmission)) == 1
        assert db.scalar(select(func.count()).select_from(ChatMessage)) == 1
        # Suppression kept, hashed only.
        supp = list(db.scalars(select(SuppressionEntry)))
        assert {s.channel for s in supp} == {"email", "sms", "voice"} and all(s.reason == "erased" for s in supp)
        # The bystander is untouched, and the note about the company is kept with the name redacted.
        assert db.get(Contact, a.other).email == "rahul@example.com"
        assert db.scalar(select(EmailMessage.to_email).where(EmailMessage.contact_id == a.other)) == \
            "rahul@example.com"
        assert db.scalar(select(CrmNote.body).where(CrmNote.company_id.is_not(None))) == \
            "Spoke to [erased] ([erased]) about the bulk order"
        assert db.scalar(select(Deal.title)) == "[erased] renewal"
        assert db.scalar(select(WebhookEvent.payload)) == {"erased": True}
        assert all(r.raw is None or "anil" in json.dumps(r.raw) for r in db.scalars(select(ImportRow)))
        # The audit entry records counts, never personal data.
        entry = db.scalar(select(AuditLog).where(AuditLog.action == "contact.erased"))
        assert entry.target_id == a.cid and all(isinstance(v, int) for v in entry.meta.values())
        reqs = list(db.scalars(select(DataRequest).order_by(DataRequest.created_at)))
        assert [r.kind for r in reqs] == ["export", "erasure"] and all(r.subject_label is None for r in reqs)
    stored = get_storage().get(imp_key).decode().lower()
    assert EMAIL not in stored and "anil@example.com" in stored

    # Idempotent.
    again = a.post(f"{a.base}/contacts/{a.cid}/erase", json={"confirm": "ERASE"})
    assert again.status_code == 200 and again.json()["already_erased"] is True
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(DataRequest).where(DataRequest.kind == "erasure")) == 1
    assert a.get(f"{a.base}/contacts/{a.cid}").status_code == 404
    log = a.get(f"/organizations/{a.org['id']}/data-requests?kind=erasure").json()
    assert log["total"] == 1 and log["items"][0]["details"]["contacts"] == 1


def test_erased_person_is_not_reimported_or_messaged(subject):
    a = subject
    assert a.post(f"{a.base}/contacts/{a.cid}/erase", json={"confirm": "ERASE"}).status_code == 200
    imp = _upload(a, [[NAME, EMAIL, "+919876543210"], ["Meera Nair", "meera@example.com", "+919822222222"]])
    assert imp["status"] == "completed"
    with SessionLocal() as db:
        emails = set(db.scalars(select(Contact.email)))
        assert EMAIL not in emails and "meera@example.com" in emails
        row = db.scalar(select(ImportRow).where(ImportRow.import_id == imp["id"], ImportRow.row_number == 2))
        assert row.status == "skipped" and row.raw is None and "erased" in row.reason
        # Even if someone re-adds them by hand, every channel stays suppressed.
        n = db.scalar(text("SELECT COUNT(*) FROM suppression_entries WHERE reason = 'erased'"))
        assert n == 3
    r = a.post(f"{a.base}/contacts", json={"email": EMAIL, "first_name": "Priya"})
    assert r.status_code == 201
    elig = a.get(f"{a.base}/contacts/{r.json()['id']}").json()
    assert elig["eligibility"]["email"]["eligible"] is False
