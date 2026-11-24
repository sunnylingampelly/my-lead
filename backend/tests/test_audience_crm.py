"""Audience <-> CRM connections: bulk owner/lifecycle, contact CRM filters, segment CRM fields, company
auto-linking (create, update, rename, import, from-contacts), synchronous assignment, the merged
timeline, and leads/deals filtered by tags, lists and segments."""
import csv
import io

import pytest
from sqlalchemy import select

from app.core.database import SessionLocal
from app.models import Contact
from tests.conftest import invite_and_join


@pytest.fixture
def a(owner):
    owner.app_id = owner.app["id"]
    owner.base = f"/apps/{owner.app_id}"
    owner.c = f"{owner.base}/crm"
    return owner


def _contact(a, first="Asha", **kw) -> dict:
    body = {"first_name": first, "email": f"{first.lower()}@example.com", **kw}
    r = a.post(f"{a.base}/contacts", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_bulk_assign_owner_and_lifecycle(a):
    rep = invite_and_join(a, "rep@example.com", "campaign_manager", [a.app_id])
    ids = [_contact(a, f"P{i}")["id"] for i in range(3)]
    r = a.post(f"{a.base}/contacts/bulk", json={"action": "assign_owner", "contact_ids": ids[:2],
                                                 "owner_id": rep.user["id"]})
    assert r.status_code == 200 and r.json() == {"matched": 2, "affected": 2}
    bad = a.post(f"{a.base}/contacts/bulk", json={"action": "assign_owner", "contact_ids": ids,
                                                   "owner_id": "nobody"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_OWNER"
    r = a.post(f"{a.base}/contacts/bulk", json={"action": "set_lifecycle", "contact_ids": ids,
                                                 "lifecycle_stage": "sql"})
    assert r.json()["affected"] == 3
    assert a.post(f"{a.base}/contacts/bulk", json={"action": "set_lifecycle", "contact_ids": ids}).status_code == 422

    # List filters and columns
    page = a.get(f"{a.base}/contacts", params={"owner_id": rep.user["id"]}).json()
    assert page["total"] == 2 and page["items"][0]["owner_name"] == rep.user["full_name"]
    assert page["items"][0]["lifecycle_stage"] == "sql"
    assert a.get(f"{a.base}/contacts", params={"owner_id": "unassigned"}).json()["total"] == 1
    assert a.get(f"{a.base}/contacts", params={"lifecycle_stage": "sql", "min_lead_score": 0}).json()["total"] == 3
    assert a.get(f"{a.base}/contacts", params={"sort": "-lead_score"}).status_code == 200

    # History like a single update; clearing the owner
    tl = a.get(f"{a.c}/timeline", params={"contact_id": ids[0]}).json()
    titles = [i["title"] for i in tl]
    assert any(t.startswith("Owner assigned") for t in titles) and any("Lifecycle stage" in t for t in titles)
    r = a.post(f"{a.base}/contacts/bulk", json={"action": "assign_owner", "contact_ids": ids[:1], "owner_id": None})
    assert r.json()["affected"] == 1
    assert a.get(f"{a.c}/contacts/{ids[0]}").json()["owner"] is None

    # Leads list honours audience filters
    tag = a.post(f"{a.base}/tags", json={"name": "VIP"}).json()
    a.post(f"{a.base}/contacts/{ids[1]}/tags/{tag['id']}")
    leads = a.get(f"{a.c}/leads", params={"tag_id": tag["id"]}).json()
    assert leads["total"] == 1 and leads["items"][0]["id"] == ids[1]
    lst = a.post(f"{a.base}/lists", json={"name": "Hot"}).json()
    a.post(f"{a.base}/lists/{lst['id']}/contacts", json={"contact_ids": ids[:2]})
    assert a.get(f"{a.c}/leads", params={"list_id": lst["id"]}).json()["total"] == 2


def test_contact_form_crm_fields_and_sync_assignment(a):
    rep = invite_and_join(a, "rep2@example.com", "campaign_manager", [a.app_id])
    a.patch(f"{a.c}/settings", json={"sla_enabled": True, "sla_minutes": 30})
    a.post(f"{a.c}/assignment-rules", json={"name": "Web", "conditions": {"source": "web"},
                                            "user_ids": [rep.user["id"]]})
    c = _contact(a, "Webby", source="web")
    crm = a.get(f"{a.c}/contacts/{c['id']}").json()
    assert crm["owner"]["id"] == rep.user["id"] and crm["sla_due_at"]  # no periodic job needed
    assert c["owner_id"] == rep.user["id"]

    explicit = _contact(a, "Picked", source="web", owner_id=a.user["id"], lifecycle_stage="mql")
    assert explicit["owner_id"] == a.user["id"] and explicit["lifecycle_stage"] == "mql"
    r = a.patch(f"{a.base}/contacts/{explicit['id']}", json={"lifecycle_stage": "customer", "clear_owner": True})
    assert r.status_code == 200 and r.json()["lifecycle_stage"] == "customer" and r.json()["owner_id"] is None


def test_company_auto_linking_rename_and_from_contacts(a):
    co = a.post(f"{a.c}/companies", json={"name": "Acme Traders", "domain": "acme.in"}).json()
    by_name = _contact(a, "Ravi", company="acme traders")
    assert by_name["company_id"] == co["id"]
    by_domain = _contact(a, "Meena", email="meena@acme.in")
    assert by_domain["company_id"] == co["id"] and by_domain["company"] == "Acme Traders"
    free_mail = _contact(a, "Gopal", email="gopal@gmail.com")
    assert free_mail["company_id"] is None

    # Editing the company text re-links or unlinks
    other = a.post(f"{a.c}/companies", json={"name": "Globex"}).json()
    r = a.patch(f"{a.base}/contacts/{by_name['id']}", json={"company": "Globex"}).json()
    assert r["company_id"] == other["id"]
    r = a.patch(f"{a.base}/contacts/{by_name['id']}", json={"company": "Nobody Inc"}).json()
    assert r["company_id"] is None
    r = a.patch(f"{a.base}/contacts/{by_name['id']}", json={"company_id": co["id"]}).json()
    assert r["company_id"] == co["id"] and r["company"] == "Acme Traders"

    # Renaming the company updates linked contacts' text
    a.patch(f"{a.c}/companies/{co['id']}", json={"name": "Acme Pvt Ltd"})
    assert a.get(f"{a.base}/contacts/{by_domain['id']}").json()["company"] == "Acme Pvt Ltd"

    # Suggestions, unlink
    stray = _contact(a, "Stray", company="Globex")  # links to Globex automatically
    assert stray["company_id"] == other["id"]
    a.post(f"{a.c}/companies/{other['id']}/contacts/unlink", json={"ids": [stray["id"]]})
    assert a.get(f"{a.base}/contacts/{stray['id']}").json()["company_id"] is None
    late = _contact(a, "Late", email="late@acme.in", company="Someone Else")
    sugg = a.get(f"{a.c}/companies/{co['id']}/suggested-contacts").json()
    assert [s["id"] for s in sugg] == [late["id"]] and sugg[0]["matched_on"] == "domain"

    # Create companies from free-text names
    _contact(a, "Hari", company="Initech")
    _contact(a, "Uma", company="initech ")
    prev = a.get(f"{a.c}/companies/from-contacts").json()
    assert prev["companies"] == 2  # Initech, Someone Else
    out = a.post(f"{a.c}/companies/from-contacts").json()
    assert out["created"] == 2 and out["linked"] == 3
    initech = a.get(f"{a.c}/companies", params={"search": "Initech"}).json()["items"][0]
    assert initech["contact_count"] == 2
    assert a.get(f"{a.c}/companies/from-contacts").json()["companies"] == 0


def test_segment_crm_fields(a):
    rep = invite_and_join(a, "rep3@example.com", "campaign_manager", [a.app_id])
    co = a.post(f"{a.c}/companies", json={"name": "Wayne", "industry": "Steel", "size": "51-200"}).json()
    x = _contact(a, "Bruce", company="Wayne", owner_id=rep.user["id"], lifecycle_stage="sql")
    y = _contact(a, "Alfred")
    fields = {f["key"]: f for f in a.get(f"{a.base}/audience/fields").json()["fields"]}
    for k in ("owner", "lifecycle_stage", "lead_score", "fit_score", "engagement_score", "company.industry",
              "has_open_deal", "deal_stage", "sla_breached"):
        assert k in fields, k
    assert fields["owner"]["option_labels"][rep.user["id"]] == rep.user["full_name"]

    def count(*conds, match="all"):
        r = a.post(f"{a.base}/segments/preview", json={"rules": {"type": "group", "match": match, "conditions": [
            {"type": "condition", "field": f, "operator": o, "value": v} for f, o, v in conds]}})
        assert r.status_code == 200, r.text
        return r.json()["count"]

    assert count(("owner", "is", rep.user["id"])) == 1
    assert count(("owner", "is", "unassigned")) == 1
    assert count(("lifecycle_stage", "is", "sql")) == 1
    assert count(("lead_score", "gt", -1)) == 2
    assert count(("company.industry", "is", "steel")) == 1
    assert count(("company.size", "is", "51-200")) == 1
    assert count(("company.name", "is_empty", None)) == 1
    assert count(("has_open_deal", "is", True)) == 0
    d = a.post(f"{a.c}/deals", json={"title": "Armour", "contact_id": x["id"], "company_id": co["id"]})
    assert d.status_code == 201, d.text
    assert count(("has_open_deal", "is", True)) == 1 and count(("has_open_deal", "is", False)) == 1
    assert count(("deal_stage", "is", d.json()["stage_id"])) == 1
    assert count(("sla_breached", "is", True)) == 0
    bad = a.post(f"{a.base}/segments/preview", json={"rules": {"type": "group", "conditions": [
        {"type": "condition", "field": "deal_stage", "operator": "is", "value": "nope"}]}})
    assert bad.status_code == 422

    # Deals filter by the primary contact's segment / tag
    seg = a.post(f"{a.base}/segments", json={"name": "Owned", "rules": {"type": "group", "conditions": [
        {"type": "condition", "field": "owner", "operator": "is", "value": rep.user["id"]}]}}).json()
    assert a.get(f"{a.c}/deals", params={"segment_id": seg["id"]}).json()["total"] == 1
    tag = a.post(f"{a.base}/tags", json={"name": "Cold"}).json()
    a.post(f"{a.base}/contacts/{y['id']}/tags/{tag['id']}")
    assert a.get(f"{a.c}/deals", params={"tag_id": tag["id"]}).json()["total"] == 0
    assert a.get(f"{a.c}/deals", params={"source": "nowhere"}).json()["total"] == 0


def test_timeline_includes_contact_activity_and_task_lookup(a):
    c = _contact(a, "Tara")
    a.post(f"{a.base}/contacts/{c['id']}/consent", json={"channel": "email", "status": "granted",
                                                          "source": "Website form"})
    tl = a.get(f"{a.c}/timeline", params={"contact_id": c["id"]}).json()
    profile = [i for i in tl if i["kind"] == "profile"]
    assert {i["type"] for i in profile} >= {"created", "consent_granted"}
    only = a.get(f"{a.c}/timeline", params={"contact_id": c["id"], "kinds": "email,sms,call"}).json()
    assert all(i["kind"] in ("email", "sms", "call") for i in only)
    t = a.post(f"{a.c}/tasks", json={"title": "Call Tara", "type": "call", "contact_id": c["id"]}).json()
    got = a.get(f"{a.c}/tasks/{t['id']}").json()
    assert got["title"] == "Call Tara" and got["contact"]["reach"] == {"email": True, "sms": False,
                                                                        "voice": False}


def test_import_crm_targets_and_company_creation(a):
    rep = invite_and_join(a, "rep4@example.com", "campaign_manager", [a.app_id])
    a.post(f"{a.c}/companies", json={"name": "Stark", "domain": "stark.com"})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Name", "Email", "Company", "Owner", "Lifecycle stage"])
    w.writerow(["Tony S", "tony@stark.com", "", "rep4@example.com", "SQL"])
    w.writerow(["Pepper P", "pepper@x.io", "Rand Corp", "nobody@example.com", "bogus"])
    w.writerow(["Happy H", "happy@y.io", "rand corp", "", "customer"])
    r = a.client.post(f"/api/v1{a.base}/contacts/import", headers=a.headers,
                      files={"file": ("c.csv", buf.getvalue().encode(), "text/csv")})
    imp = r.json()
    assert imp["suggested_mapping"]["Owner"] == "owner_email"
    assert imp["suggested_mapping"]["Lifecycle stage"] == "lifecycle_stage"
    mapping = {"Name": "full_name", "Email": "email", "Company": "company", "Owner": "owner_email",
               "Lifecycle stage": "lifecycle_stage"}
    r = a.post(f"{a.base}/imports/{imp['id']}/start", json={"mapping": mapping, "options": {
        "duplicate_handling": "skip", "create_companies": True}})
    assert r.status_code == 200, r.text
    assert a.get(f"{a.base}/imports/{imp['id']}").json()["created_count"] == 3
    with SessionLocal() as db:
        rows = {c.email: c for c in db.scalars(select(Contact).where(Contact.application_id == a.app_id))}
    tony, pepper, happy = rows["tony@stark.com"], rows["pepper@x.io"], rows["happy@y.io"]
    assert tony.owner_id == rep.user["id"] and tony.lifecycle_stage == "sql" and tony.company == "Stark"
    assert tony.company_id is not None
    assert pepper.owner_id is None and pepper.lifecycle_stage == "lead"
    assert pepper.company_id and pepper.company_id == happy.company_id and happy.lifecycle_stage == "customer"
    assert a.get(f"{a.c}/companies", params={"search": "Rand"}).json()["total"] == 1
