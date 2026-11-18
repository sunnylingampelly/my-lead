"""Automation: graph validation, triggers, enrollment, waits, branching on engagement, contact updates,
channel sends through the existing engines, re-entry, pause/archive and access control."""
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from app.core.database import SessionLocal
from app.models import ApplicationSettings
from app.models.automation import WorkflowRun
from app.models.email import EmailMessage
from app.models.sms import SmsMessage
from app.services.automation import engine
from app.services.automation.graph import Graph, structural_issues
from app.services.email import tokens
from tests.conftest import Api, invite_and_join, token_from_last_email


def node(id_, type_, **data):
    return {"id": id_, "type": type_, "position": {"x": 0, "y": 0}, "data": data}


def edge(s, t, handle=None):
    e = {"id": f"{s}-{t}-{handle}", "source": s, "target": t}
    if handle:
        e["sourceHandle"] = handle
    return e


def test_structural_validation():
    ok = Graph.load({"nodes": [node("t", "trigger", kind="contact_created"), node("a", "end")], "edges": [edge("t", "a")]})
    assert structural_issues(ok) == []
    loop = Graph.load({"nodes": [node("t", "trigger"), node("w", "wait"), node("c", "condition")],
                       "edges": [edge("t", "w"), edge("w", "c"), edge("c", "w", "yes")]})
    assert any("loops back" in i.message for i in structural_issues(loop))
    orphan = Graph.load({"nodes": [node("t", "trigger"), node("a", "end"), node("b", "end")], "edges": [edge("t", "a")]})
    assert [i.node_id for i in structural_issues(orphan)] == ["b"]
    two = Graph.load({"nodes": [node("t", "trigger"), node("a", "end"), node("b", "end")],
                      "edges": [edge("t", "a"), edge("t", "b")]})
    assert any("only lead to one" in i.message for i in structural_issues(two))
    assert any("exactly one trigger" in i.message for i in structural_issues(Graph.load({"nodes": [], "edges": []})))
    bad = Graph.load({"nodes": [node("t", "trigger"), node("x", "run_python")], "edges": [edge("t", "x")]})
    assert any("Unknown step type" in i.message for i in structural_issues(bad))


# ------------------------------------------------------------------ fixture

@pytest.fixture
def auto(owner):
    r = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "Journeys",
                                           "default_country": "IN", "timezone": "Asia/Kolkata"})
    owner.app_id = r.json()["id"]
    owner.base = f"/apps/{owner.app_id}"
    owner.a = f"{owner.base}/automation"
    with SessionLocal() as db:
        db.execute(update(ApplicationSettings).where(ApplicationSettings.application_id == owner.app_id)
                   .values(quiet_hours_start="00:00", quiet_hours_end="00:00"))
        db.commit()
    s = owner.post(f"{owner.base}/email/senders", json={"from_name": "Chai", "from_email": "hello@chai.example"})
    Api().post("/public/email-senders/verify", json={"token": token_from_last_email("hello@chai.example", "/verify-sender")})
    owner.sender_id = s.json()["id"]
    owner.template_id = owner.post(f"{owner.base}/email/templates", json={
        "name": "Welcome", "subject": "Welcome {{first_name}}", "editor": "html",
        "html": "<html><body><p>Hi {{first_name}}</p><a href='https://chai.example'>Shop</a></body></html>"}).json()["id"]
    owner.list_id = owner.post(f"{owner.base}/lists", json={"name": "Newsletter"}).json()["id"]
    owner.tag_id = owner.post(f"{owner.base}/tags", json={"name": "Engaged"}).json()["id"]
    owner.contacts = {}
    for name, city in (("Asha", "Pune"), ("Ravi", "Delhi")):
        r = owner.post(f"{owner.base}/contacts", json={"first_name": name, "email": f"{name.lower()}@example.com",
                                                       "phone": "+9198765" + ("43210" if name == "Asha" else "12345"),
                                                       "city": city,
                                                       "consent": {"email": True, "sms": True, "source": "Web form"}})
        assert r.status_code == 201, r.text
        owner.contacts[name] = r.json()["id"]
    return owner


def journey(a) -> dict:
    return {"nodes": [node("t", "trigger", kind="added_to_list", list_id=a.list_id),
                      node("e", "send_email", label="Welcome email", sender_id=a.sender_id, template_id=a.template_id),
                      node("w", "wait", amount=1, unit="days"),
                      node("c", "condition", kind="engagement", node_id="e", event="opened"),
                      node("tag", "update_contact", action="add_tag", tag_id=a.tag_id),
                      node("end", "end")],
            "edges": [edge("t", "e"), edge("e", "w"), edge("w", "c"), edge("c", "tag", "yes"), edge("c", "end", "no")]}


def add_to_list(a, *names):
    r = a.post(f"{a.base}/contacts/bulk", json={"action": "add_to_list", "list_id": a.list_id,
                                                 "contact_ids": [a.contacts[n] for n in names]})
    assert r.status_code == 200, r.text


def wake_all(workflow_id):
    with SessionLocal() as db:
        db.execute(update(WorkflowRun).where(WorkflowRun.workflow_id == workflow_id, WorkflowRun.status == "waiting")
                   .values(wake_at=datetime.now(UTC) - timedelta(seconds=1)))
        db.commit()


# ------------------------------------------------------------------ journeys

def test_list_journey_with_wait_and_open_branch(auto):
    a = auto
    w = a.post(f"{a.a}/workflows", json={"name": "Welcome series"}).json()
    g = journey(a)
    g["nodes"][1]["data"]["template_id"] = None
    a.patch(f"{a.a}/workflows/{w['id']}", json={"graph": g})
    v = a.get(f"{a.a}/workflows/{w['id']}/validate").json()
    assert not v["valid"] and v["issues"] == [{"node_id": "e", "message": "Choose an email template"}]
    r = a.post(f"{a.a}/workflows/{w['id']}/publish", json={"activate": True})
    assert r.status_code == 422 and r.json()["error"]["code"] == "WORKFLOW_INVALID"

    a.patch(f"{a.a}/workflows/{w['id']}", json={"graph": journey(a)})
    r = a.post(f"{a.a}/workflows/{w['id']}/publish", json={"activate": True})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "active" and r.json()["version"] == 1 and not r.json()["has_unpublished_changes"]

    add_to_list(a, "Asha", "Ravi")
    assert engine.tick() == {"enrolled": 2, "advanced": 2}
    with SessionLocal() as db:
        msgs = list(db.scalars(select(EmailMessage).where(EmailMessage.to_email.in_(("asha@example.com", "ravi@example.com")))))
        runs = list(db.scalars(select(WorkflowRun).where(WorkflowRun.workflow_id == w["id"])))
    assert {m.status for m in msgs} == {"delivered"} and len(msgs) == 2
    assert {r.status for r in runs} == {"waiting"} and {r.current_node_id for r in runs} == {"c"}
    # The hidden step campaign never shows up in the email campaign list.
    assert a.get(f"{a.base}/email/campaigns").json()["total"] == 0

    # Asha opens the email (tracking pixel); Ravi does not.
    asha_msg = next(m for m in msgs if m.to_email == "asha@example.com")
    Api().client.get(f"/api/v1/t/o/{tokens.make('o', asha_msg.id)}.gif")
    assert engine.tick()["advanced"] == 0  # still waiting a day
    wake_all(w["id"])
    assert engine.tick()["advanced"] == 2
    asha = a.get(f"{a.base}/contacts/{a.contacts['Asha']}").json()
    ravi = a.get(f"{a.base}/contacts/{a.contacts['Ravi']}").json()
    assert [t["name"] for t in asha["tags"]] == ["Engaged"] and ravi["tags"] == []
    runs = a.get(f"{a.a}/workflows/{w['id']}/runs").json()
    assert runs["total"] == 2 and {r["status"] for r in runs["items"]} == {"completed"}
    steps = a.get(f"{a.a}/workflows/{w['id']}/runs/{runs['items'][0]['id']}").json()["steps"]
    assert [s["node_id"] for s in steps][:3] == ["e", "w", "c"]
    st = a.get(f"{a.a}/workflows/{w['id']}/stats").json()
    assert st["nodes"]["c"] == {"branch_yes": 1, "branch_no": 1} and st["channel"]["e"]["unique_opens"] == 1

    # No re-entry: removing and re-adding does not start the journey again.
    a.post(f"{a.base}/contacts/bulk", json={"action": "remove_from_list", "list_id": a.list_id,
                                            "contact_ids": [a.contacts["Asha"]]})
    add_to_list(a, "Asha")
    assert engine.tick()["enrolled"] == 0
    # Archiving exits nothing (all done) and blocks edits.
    assert a.post(f"{a.a}/workflows/{w['id']}/archive").json()["status"] == "archived"
    assert a.patch(f"{a.a}/workflows/{w['id']}", json={"name": "x"}).status_code == 409
    assert a.delete(f"{a.a}/workflows/{w['id']}").status_code == 409


def test_segment_trigger_pause_and_republish(auto):
    a = auto
    seg = a.post(f"{a.base}/segments", json={"name": "Pune", "rules": {
        "match": "all", "conditions": [{"field": "city", "operator": "is", "value": "Pune"}]}}).json()
    g = {"nodes": [node("t", "trigger", kind="segment_entered", segment_id=seg["id"]),
                   node("w", "wait", amount=2, unit="hours"),
                   node("tag", "update_contact", action="add_tag", tag_id=a.tag_id)],
         "edges": [edge("t", "w"), edge("w", "tag")]}
    w = a.post(f"{a.a}/workflows", json={"name": "Pune", "graph": g}).json()
    assert a.post(f"{a.a}/workflows/{w['id']}/publish", json={"activate": True}).status_code == 200
    assert engine.tick()["enrolled"] == 1  # Asha is in Pune
    assert engine.tick()["enrolled"] == 0
    a.post(f"{a.a}/workflows/{w['id']}/pause")
    wake_all(w["id"])
    assert engine.tick()["advanced"] == 0  # paused workflows hold their runs
    # A published change that removes the tag step: the waiting run exits with a reason.
    g2 = {"nodes": [g["nodes"][0], g["nodes"][1], node("end", "end")], "edges": [edge("t", "w"), edge("w", "end")]}
    a.patch(f"{a.a}/workflows/{w['id']}", json={"graph": g2})
    assert a.get(f"{a.a}/workflows/{w['id']}").json()["has_unpublished_changes"]
    assert a.post(f"{a.a}/workflows/{w['id']}/publish", json={"activate": True}).json()["status"] == "active"
    engine.tick()
    run = a.get(f"{a.a}/workflows/{w['id']}/runs").json()["items"][0]
    assert run["status"] == "exited" and "removed" in run["exit_reason"]


def test_sms_step_uses_sms_engine(auto):
    a = auto
    a.put(f"{a.base}/sms/registration", json={"principal_entity_id": "1101456789012345678", "attest": True})
    sender = a.post(f"{a.base}/sms/senders", json={"sender_id": "CHAIIN", "country": "IN", "kind": "transactional"}).json()
    a.post(f"{a.base}/sms/senders/{sender['id']}/attest")
    tpl = a.post(f"{a.base}/sms/templates", json={"name": "Hi", "category": "transactional",
                                                  "body": "Hi {{first_name}}, welcome to Chai.",
                                                  "dlt_template_id": "1107000000000000001",
                                                  "dlt_template_text": "Hi {#var#}, welcome to Chai."}).json()
    g = {"nodes": [node("t", "trigger", kind="contact_created"),
                   node("s", "send_sms", sender_ref=sender["id"], template_id=tpl["id"], category="transactional")],
         "edges": [edge("t", "s")]}
    w = a.post(f"{a.a}/workflows", json={"name": "SMS welcome", "graph": g}).json()
    bad = {**g, "nodes": [g["nodes"][0], node("s", "send_sms", sender_ref=sender["id"], category="transactional",
                                               body="Totally different text")]}
    a.patch(f"{a.a}/workflows/{w['id']}", json={"graph": bad})
    r = a.post(f"{a.a}/workflows/{w['id']}/publish", json={"activate": True})
    assert r.status_code == 422 and any("DLT" in i["message"] for i in r.json()["error"]["details"])
    a.patch(f"{a.a}/workflows/{w['id']}", json={"graph": g})
    assert a.post(f"{a.a}/workflows/{w['id']}/publish", json={"activate": True}).status_code == 200
    assert engine.tick()["enrolled"] == 0  # existing contacts were created before activation
    r = a.post(f"{a.base}/contacts", json={"first_name": "Meera", "phone": "+919876598765",
                                           "consent": {"sms": True, "source": "Store"}})
    assert engine.tick() == {"enrolled": 1, "advanced": 1}
    with SessionLocal() as db:
        m = db.scalar(select(SmsMessage).where(SmsMessage.contact_id == r.json()["id"]))
    assert m.status == "delivered" and m.body == "Hi Meera, welcome to Chai."
    assert a.get(f"{a.base}/sms/campaigns").json()["total"] == 0


def test_permissions_and_isolation(auto):
    a = auto
    w = a.post(f"{a.a}/workflows", json={"name": "Private"}).json()
    viewer = invite_and_join(a, "viewer@example.com", "viewer", [a.app_id])
    assert viewer.get(f"{a.a}/workflows").json()["total"] == 1
    assert viewer.post(f"{a.a}/workflows", json={"name": "x"}).status_code == 403
    assert viewer.post(f"{a.a}/workflows/{w['id']}/publish", json={"activate": True}).status_code == 403
    other = Api().register("other@example.com", "Other")
    org = other.post("/organizations", json={"name": "Other Org"}).json()
    other.post("/applications", json={"organization_id": org["id"], "name": "Theirs"})
    assert other.get(f"{a.a}/workflows/{w['id']}").status_code in (403, 404)
