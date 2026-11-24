"""Automation x CRM prerequisites (SLA, scoring warnings, fallback task assignee, run-history links) and the
analytics CRM block with previous-period comparison."""
from datetime import timedelta

import pytest
from sqlalchemy import select, update

from app.core.database import SessionLocal
from app.models import CrmTask, Deal
from app.services.automation import engine
from app.utils.time import utcnow


def node(id_, type_, **data):
    return {"id": id_, "type": type_, "position": {"x": 0, "y": 0}, "data": data}


def edge(s, t):
    return {"id": f"{s}-{t}", "source": s, "target": t}


@pytest.fixture
def crm(owner):
    a = owner
    a.app_id = a.app["id"]
    a.base = f"/apps/{a.app_id}"
    a.c = f"{a.base}/crm"
    a.a = f"{a.base}/automation"
    return a


def _wf(a, name, *nodes):
    ids = [n["id"] for n in nodes]
    g = {"nodes": list(nodes), "edges": [edge(s, t) for s, t in zip(ids, ids[1:], strict=False)]}
    return a.post(f"{a.a}/workflows", json={"name": name, "graph": g}).json()


def test_sla_trigger_needs_sla_and_score_warns_without_rules(crm):
    a = crm
    a.get(f"{a.c}/settings")
    w = _wf(a, "SLA", node("t", "trigger", kind="sla_breached"), node("e", "end"))
    v = a.get(f"{a.a}/workflows/{w['id']}/validate").json()
    assert v["issues"] == [{"node_id": "t", "message": "Turn on the first-response SLA in CRM settings"}]
    a.patch(f"{a.c}/settings", json={"sla_enabled": True})
    assert a.get(f"{a.a}/workflows/{w['id']}/validate").json()["valid"]

    hot = _wf(a, "Hot", node("t", "trigger", kind="score_reached"), node("e", "end"))
    v = a.get(f"{a.a}/workflows/{hot['id']}/validate").json()
    assert v["valid"] and "scoring rules" in v["warnings"][0]["message"]
    a.post(f"{a.c}/scoring-rules", json={"kind": "fit", "field": "country", "operator": "eq", "value": "IN",
                                         "points": 15})
    assert a.get(f"{a.a}/workflows/{hot['id']}/validate").json()["warnings"] == []


def test_task_fallback_assignee_and_run_links(crm):
    a = crm
    task = {"action": "create_task", "title": "Follow up with {{name}}", "task_type": "call", "due_in_hours": 24}
    w = _wf(a, "Tasks", node("t", "trigger", kind="contact_created"), node("x", "crm_action", **task))
    v = a.get(f"{a.a}/workflows/{w['id']}/validate").json()
    assert v["valid"] and "fallback" in v["warnings"][0]["message"]
    bad = {"nodes": [node("t", "trigger", kind="contact_created"),
                     node("x", "crm_action", **task, fallback_user_id="nobody")], "edges": [edge("t", "x")]}
    a.patch(f"{a.a}/workflows/{w['id']}", json={"graph": bad})
    assert "no owner" in a.get(f"{a.a}/workflows/{w['id']}/validate").json()["issues"][0]["message"]
    good = {"nodes": [node("t", "trigger", kind="contact_created"),
                      node("x", "crm_action", **task, fallback_user_id=a.user["id"])], "edges": [edge("t", "x")]}
    a.patch(f"{a.a}/workflows/{w['id']}", json={"graph": good})
    assert a.get(f"{a.a}/workflows/{w['id']}/validate").json()["warnings"] == []
    assert a.post(f"{a.a}/workflows/{w['id']}/publish", json={"activate": True}).status_code == 200

    ravi = a.post(f"{a.base}/contacts", json={"first_name": "Ravi", "email": "ravi@example.com"}).json()
    dry = a.post(f"{a.a}/workflows/{w['id']}/test", json={"contact_id": ravi["id"]}).json()["steps"]
    assert "fallback" in dry[-1]["detail"] and "Follow up with Ravi" in dry[-1]["detail"]
    engine.tick()
    with SessionLocal() as db:
        t = db.scalar(select(CrmTask).where(CrmTask.contact_id == ravi["id"]))
    assert t.assignee_id == a.user["id"] and t.title == "Follow up with Ravi"
    run = a.get(f"{a.a}/workflows/{w['id']}/runs").json()["items"][0]
    steps = a.get(f"{a.a}/workflows/{w['id']}/runs/{run['id']}").json()["steps"]
    assert steps[-1]["label"] == "CRM action" and steps[-1]["summary"] == "Create task: Follow up with {{name}}"
    assert steps[-1]["links"] == [{"kind": "task", "id": t.id, "label": "Open task"}]
    assert "(fallback)" in steps[-1]["detail"]


def test_analytics_crm_block_and_previous_period(crm):
    a = crm
    c = a.post(f"{a.base}/contacts", json={"first_name": "Asha", "email": "asha@example.com"}).json()
    ids = []
    for title, amount in (("Old win", 1000), ("New win", 5000), ("Open", 2000)):
        d = a.post(f"{a.c}/deals", json={"title": title, "contact_id": c["id"], "amount": amount})
        assert d.status_code == 201, d.text
        ids.append(d.json()["id"])
    for i in ids[:2]:
        a.post(f"{a.c}/deals/{i}/close", json={"outcome": "won"})
    old = utcnow() - timedelta(days=40)
    with SessionLocal() as db:
        db.execute(update(Deal).where(Deal.id == ids[0]).values(created_at=old, closed_at=old))
        db.commit()
    d = a.get(f"{a.base}/analytics").json()["crm"]
    assert d["deals_created"] == 2 and d["won"] == 1 and d["won_amount"] == 5000 and d["win_rate"] == 100
    assert d["pipeline_value"] == 2000 and d["open_deals"] == 1
    assert d["previous"]["won"] == 1 and d["previous"]["won_amount"] == 1000
    assert d["changes"]["won_amount"] == 400.0 and d["changes"]["won"] == 0
    empty = a.get(f"{a.base}/analytics").json()["setup"]
    assert empty == {"sender_verified": False, "campaign_sent": False, "workflow_created": False}
