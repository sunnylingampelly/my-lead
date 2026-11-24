"""CRM end to end: companies (GSTIN, duplicates), pipelines and deals (board, moves, won/lost, weighted
values), tasks, notes with mentions, activities and the unified timeline, owner assignment, SLA,
rotting, lead scoring, reports, automation triggers and actions, permissions and isolation."""
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select, update

from app.core.database import SessionLocal
from app.models import Contact, CrmEvent, CrmTask, Deal, Notification
from app.services.automation import engine
from app.services.crm import leads
from app.services.crm.companies import gstin_checksum_ok
from app.utils.time import utcnow
from tests.conftest import Api, invite_and_join


def node(id_, type_, **data):
    return {"id": id_, "type": type_, "position": {"x": 0, "y": 0}, "data": data}


@pytest.fixture
def crm(owner):
    a = owner
    a.app_id = a.app["id"]
    a.c = f"/apps/{a.app_id}/crm"
    a.base = f"/apps/{a.app_id}"
    return a


def _contact(a, first="Asha", **kw) -> dict:
    body = {"first_name": first, "email": f"{first.lower()}@example.com", **kw}
    r = a.post(f"{a.base}/contacts", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _tick() -> dict:
    with SessionLocal() as db:
        return leads.tick(db)


def _stages(a) -> dict[str, dict]:
    p = a.get(f"{a.c}/pipelines").json()[0]
    return {s["name"]: s for s in p["stages"]} | {"_pipeline": p}


# ------------------------------------------------------------------ companies

def test_gstin_checksum():
    assert gstin_checksum_ok("27AAPFU0939F1ZV")
    assert not gstin_checksum_ok("27AAPFU0939F1ZX")


def test_companies_gst_validation_duplicates_and_contacts(crm):
    a = crm
    bad = a.post(f"{a.c}/companies", json={"name": "Acme", "gstin": "27AAPFU0939F1ZX"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_GSTIN"
    r = a.post(f"{a.c}/companies", json={"name": "Acme Traders", "website": "https://www.Acme.in/about",
                                         "gstin": "27aapfu0939f1zv", "phone": "98765 43210", "state": "Maharashtra"})
    assert r.status_code == 201, r.text
    co = r.json()
    assert co["domain"] == "acme.in" and co["gstin"] == "27AAPFU0939F1ZV" and co["pan"] == "AAPFU0939F"
    assert co["phone"] == "+919876543210" and co["currency"] == "INR" and co["owner"]["id"] == a.user["id"]

    dup = a.post(f"{a.c}/companies", json={"name": "Acme Again", "domain": "acme.in"})
    assert dup.status_code == 409 and dup.json()["error"]["details"]["duplicates"][0]["matched_on"] == "domain"
    hits = a.get(f"{a.c}/companies/duplicates", params={"gstin": "27AAPFU0939F1ZV"}).json()
    assert hits and hits[0]["id"] == co["id"]
    assert a.post(f"{a.c}/companies", json={"name": "Acme Again", "domain": "acme.in",
                                            "allow_duplicate": True}).status_code == 201

    asha = _contact(a)
    assert a.post(f"{a.c}/companies/{co['id']}/contacts", json={"ids": [asha["id"]]}).json() == {"linked": 1}
    assert a.get(f"{a.c}/companies/{co['id']}").json()["contact_count"] == 1
    assert a.get(f"{a.c}/contacts/{asha['id']}").json()["company"]["name"] == "Acme Traders"
    assert a.get(f"{a.c}/companies", params={"search": "acme.in"}).json()["total"] == 2


# ------------------------------------------------------------------ pipelines & deals

def test_default_pipeline_board_moves_and_close(crm):
    a = crm
    st = _stages(a)
    p = st["_pipeline"]
    assert p["is_default"] and [s["kind"] for s in p["stages"]].count("won") == 1
    asha = _contact(a)
    d = a.post(f"{a.c}/deals", json={"title": "Annual plan", "amount": "500000", "contact_id": asha["id"]})
    assert d.status_code == 201, d.text
    d = d.json()
    assert d["stage_name"] == "New" and d["probability"] == 10 and Decimal(d["weighted_amount"]) == Decimal("50000.00")
    assert d["owner"]["id"] == a.user["id"]
    assert a.get(f"{a.c}/contacts/{asha['id']}").json()["lifecycle_stage"] == "opportunity"
    a.post(f"{a.c}/deals", json={"title": "Add-on", "amount": "100000", "probability": 90})

    board = a.get(f"{a.c}/board").json()
    new_col = next(c for c in board["columns"] if c["stage"]["name"] == "New")
    assert new_col["count"] == 2 and Decimal(new_col["total"]) == Decimal("600000")
    assert Decimal(board["weighted_total"]) == Decimal("140000.00")  # 50k + 90k (override)

    moved = a.post(f"{a.c}/deals/{d['id']}/move", json={"stage_id": st["Proposal sent"]["id"]}).json()
    assert moved["stage_name"] == "Proposal sent" and moved["probability"] == 50
    assert [h["to_stage"] for h in moved["stage_history"]] == ["New", "Proposal sent"]

    lost = a.post(f"{a.c}/deals/{d['id']}/move", json={"stage_id": st["Lost"]["id"]})
    assert lost.status_code == 422 and lost.json()["error"]["code"] == "LOST_REASON_REQUIRED"
    reason = a.get(f"{a.c}/lost-reasons").json()[0]
    lost = a.post(f"{a.c}/deals/{d['id']}/close", json={"outcome": "lost", "lost_reason_id": reason["id"]}).json()
    assert lost["status"] == "lost" and lost["lost_reason"]["id"] == reason["id"] and lost["probability"] == 0
    reopened = a.post(f"{a.c}/deals/{d['id']}/reopen").json()
    assert reopened["status"] == "open" and reopened["stage_name"] == "Proposal sent" and reopened["lost_reason"] is None
    won = a.post(f"{a.c}/deals/{d['id']}/close", json={"outcome": "won"}).json()
    assert won["status"] == "won" and won["closed_at"]
    assert a.get(f"{a.c}/contacts/{asha['id']}").json()["lifecycle_stage"] == "customer"
    with SessionLocal() as db:
        kinds = [e.kind for e in db.scalars(select(CrmEvent).where(CrmEvent.deal_id == d["id"])
                                            .order_by(CrmEvent.created_at))]
    assert kinds[0] == "deal_created" and "deal_lost" in kinds and kinds[-1] == "deal_won"

    assert a.get(f"{a.c}/deals", params={"status": "won"}).json()["total"] == 1
    assert a.get(f"{a.c}/deals", params={"contact_id": asha["id"]}).json()["total"] == 1


def test_pipeline_editing_rules(crm):
    a = crm
    p = a.post(f"{a.c}/pipelines", json={"name": "Partnerships", "currency": "USD"}).json()
    assert p["currency"] == "USD" and len(p["stages"]) == 6
    stages = [{"id": s["id"], "name": s["name"], "probability": s["probability"], "kind": s["kind"],
               "rotting_days": s["rotting_days"]} for s in p["stages"]]
    no_won = [s for s in stages if s["kind"] != "won"]
    assert a.patch(f"{a.c}/pipelines/{p['id']}", json={"stages": no_won}).status_code == 422
    d = a.post(f"{a.c}/deals", json={"title": "Reseller", "pipeline_id": p["id"]}).json()
    removed = [s for s in stages if s["id"] != d["stage_id"]]
    r = a.patch(f"{a.c}/pipelines/{p['id']}", json={"stages": removed})
    assert r.status_code == 409 and r.json()["error"]["code"] == "STAGE_IN_USE"
    stages.insert(1, {"name": "Demo", "probability": 30, "kind": "open", "rotting_days": 5})
    p2 = a.patch(f"{a.c}/pipelines/{p['id']}", json={"stages": stages}).json()
    assert [s["name"] for s in p2["stages"]][:2] == ["New", "Demo"]
    assert a.delete(f"{a.c}/pipelines/{p['id']}").status_code == 409  # has deals
    assert a.patch(f"{a.c}/pipelines/{p['id']}", json={"is_default": True}).json()["is_default"]
    assert sum(x["is_default"] for x in a.get(f"{a.c}/pipelines").json()) == 1


# ------------------------------------------------------------------ work: tasks, notes, activities, timeline

def test_tasks_notes_mentions_activities_and_timeline(crm):
    a = crm
    rep = invite_and_join(a, "rep@example.com", "campaign_manager", [a.app_id])
    asha = _contact(a)
    team = a.get(f"{a.c}/team").json()
    assert {u["id"] for u in team} == {a.user["id"], rep.user["id"]}
    d = a.post(f"{a.c}/deals", json={"title": "Pilot", "contact_id": asha["id"], "owner_id": rep.user["id"]}).json()

    t = a.post(f"{a.c}/tasks", json={"title": "Call Asha", "type": "call", "deal_id": d["id"],
                                     "due_at": (utcnow() - timedelta(hours=1)).isoformat()}).json()
    assert t["assignee"]["id"] == rep.user["id"] and t["overdue"] and t["contact"]["id"] == asha["id"]
    assert rep.get(f"{a.c}/tasks/summary").json() == {"open": 1, "overdue": 1, "today": 0}
    with SessionLocal() as db:
        assert db.scalar(select(Notification).where(Notification.user_id == rep.user["id"],
                                                    Notification.type == "crm_task_assigned"))

    note = a.post(f"{a.c}/notes", json={"body": f"Spoke to @[Rep]({rep.user['id']}) about pricing",
                                        "deal_id": d["id"]}).json()
    assert [m["id"] for m in note["mentions"]] == [rep.user["id"]] and note["contact_id"] == asha["id"]
    with SessionLocal() as db:
        assert db.scalar(select(Notification).where(Notification.user_id == rep.user["id"],
                                                    Notification.type == "crm_mention"))
    assert rep.patch(f"{a.c}/notes/{note['id']}", json={"body": "edited"}).status_code == 403
    assert a.post(f"{a.c}/activities", json={"type": "call", "subject": "Discovery call", "outcome": "connected",
                                             "duration_minutes": 20, "contact_id": asha["id"],
                                             "deal_id": d["id"]}).status_code == 201
    done = rep.patch(f"{a.c}/tasks/{t['id']}", json={"status": "done"}).json()
    assert done["status"] == "done" and done["completed_at"]

    tl = a.get(f"{a.c}/timeline", params={"deal_id": d["id"]}).json()
    kinds = [i["kind"] for i in tl]
    assert {"activity", "note", "task", "system"} <= set(kinds)
    assert tl == sorted(tl, key=lambda i: i["occurred_at"], reverse=True)
    contact_tl = a.get(f"{a.c}/timeline", params={"contact_id": asha["id"], "kinds": "activity"}).json()
    assert [i["title"] for i in contact_tl] == ["Discovery call"]
    assert a.get(f"{a.c}/contacts/{asha['id']}").json()["first_response_at"]
    assert a.get(f"{a.c}/tasks", params={"status": "done", "assignee_id": rep.user["id"]}).json()["total"] == 1


# ------------------------------------------------------------------ leads: assignment, SLA, scoring, rotting

def test_round_robin_assignment_and_sla(crm):
    a = crm
    r1 = invite_and_join(a, "r1@example.com", "campaign_manager", [a.app_id])
    r2 = invite_and_join(a, "r2@example.com", "campaign_manager", [a.app_id])
    a.patch(f"{a.c}/settings", json={"sla_enabled": True, "sla_minutes": 30})
    rule = a.post(f"{a.c}/assignment-rules", json={"name": "IndiaMART", "conditions": {"source": "indiamart"},
                                                   "user_ids": [r1.user["id"], r2.user["id"]]})
    assert rule.status_code == 201, rule.text
    bad = a.post(f"{a.c}/assignment-rules", json={"name": "x", "user_ids": ["nobody"]})
    assert bad.status_code == 422
    leads_ = [_contact(a, f"Lead{i}", source="IndiaMART") for i in range(3)]
    other = _contact(a, "Walkin", source="walk-in")
    assert _tick()["assigned"] == 0  # rules ran as each contact was created
    owners = [a.get(f"{a.c}/contacts/{c['id']}").json()["owner"]["id"] for c in leads_]
    assert owners == [r1.user["id"], r2.user["id"], r1.user["id"]]
    assert a.get(f"{a.c}/contacts/{other['id']}").json()["owner"] is None
    assert a.get(f"{a.c}/leads", params={"unassigned": True}).json()["total"] == 1
    assert r1.get(f"{a.c}/leads", params={"owner_id": "me"}).json()["total"] == 2

    # Nobody responded in time to the first lead; the second got a logged call.
    a.post(f"{a.c}/activities", json={"type": "call", "subject": "Intro", "contact_id": leads_[1]["id"]})
    with SessionLocal() as db:
        db.execute(update(Contact).where(Contact.id.in_([c["id"] for c in leads_[:2]]))
                   .values(sla_due_at=utcnow() - timedelta(minutes=1)))
        db.commit()
    assert _tick()["breached"] == 1
    crm1 = a.get(f"{a.c}/contacts/{leads_[0]['id']}").json()
    assert crm1["sla_breached_at"] and a.get(f"{a.c}/leads", params={"sla": "breached"}).json()["total"] == 1
    with SessionLocal() as db:
        assert db.scalar(select(Notification).where(Notification.user_id == r1.user["id"],
                                                    Notification.type == "crm_sla_breached"))


def test_lead_scoring_fit_and_engagement(crm):
    a = crm
    a.patch(f"{a.c}/settings", json={"hot_score_threshold": 30})
    assert a.post(f"{a.c}/scoring-rules", json={"kind": "fit", "field": "country", "operator": "eq", "value": "in",
                                                "points": 20}).status_code == 201
    assert a.post(f"{a.c}/scoring-rules", json={"kind": "fit", "field": "nope", "operator": "set",
                                                "points": 5}).status_code == 422
    a.post(f"{a.c}/scoring-rules", json={"kind": "engagement", "event": "activity_logged", "points": 5,
                                         "max_points": 10})
    asha = _contact(a, country="IN")
    bob = _contact(a, "Bob", country="US")
    for i in range(3):  # capped at 10 points
        a.post(f"{a.c}/activities", json={"type": "meeting", "subject": f"Meeting {i}", "contact_id": asha["id"]})
    assert a.post(f"{a.c}/scoring/rescore").json()["scored"] >= 2
    s = a.get(f"{a.c}/contacts/{asha['id']}").json()
    assert (s["fit_score"], s["engagement_score"], s["lead_score"], s["hot"]) == (20, 10, 30, True)
    assert s["grade"] == "A2"  # fit ≥ half the threshold; engagement ≥ a quarter
    assert a.get(f"{a.c}/contacts/{bob['id']}").json()["lead_score"] == 0
    with SessionLocal() as db:
        assert db.scalar(select(CrmEvent).where(CrmEvent.kind == "score_reached", CrmEvent.contact_id == asha["id"]))
    rows = a.get(f"{a.c}/leads", params={"min_score": 25}).json()["items"]
    assert [r["id"] for r in rows] == [asha["id"]]


def test_rotting_deals_and_task_reminders(crm):
    a = crm
    d = a.post(f"{a.c}/deals", json={"title": "Quiet deal"}).json()  # New stage rots after 7 days
    a.post(f"{a.c}/tasks", json={"title": "Follow up", "due_at": (utcnow() + timedelta(minutes=5)).isoformat()})
    with SessionLocal() as db:
        db.execute(update(Deal).where(Deal.id == d["id"]).values(last_activity_at=utcnow() - timedelta(days=8)))
        db.commit()
    out = _tick()
    assert out["rotting"] == 1 and out["reminded"] == 1
    assert a.get(f"{a.c}/deals/{d['id']}").json()["rotting"]
    assert a.get(f"{a.c}/deals", params={"rotting": True}).json()["total"] == 1
    a.post(f"{a.c}/notes", json={"body": "Pinged them", "deal_id": d["id"]})
    fresh = a.get(f"{a.c}/deals/{d['id']}").json()
    assert not fresh["rotting"] and a.get(f"{a.c}/deals", params={"rotting": True}).json()["total"] == 0
    assert _tick()["reminded"] == 0  # reminded once


# ------------------------------------------------------------------ reports

def test_reports(crm):
    a = crm
    st = _stages(a)
    reason = a.get(f"{a.c}/lost-reasons").json()[0]
    month = utcnow().date().replace(day=15).isoformat()
    won = a.post(f"{a.c}/deals", json={"title": "W", "amount": "200000"}).json()
    lost = a.post(f"{a.c}/deals", json={"title": "L", "amount": "50000"}).json()
    a.post(f"{a.c}/deals", json={"title": "O", "amount": "100000", "expected_close_date": month,
                                 "stage_id": st["Negotiation"]["id"]})
    a.post(f"{a.c}/deals/{won['id']}/move", json={"stage_id": st["Qualified"]["id"]})
    a.post(f"{a.c}/deals/{won['id']}/close", json={"outcome": "won"})
    a.post(f"{a.c}/deals/{lost['id']}/close", json={"outcome": "lost", "lost_reason_id": reason["id"]})

    ov = a.get(f"{a.c}/reports/overview").json()
    assert ov["open_deals"] == 1 and Decimal(ov["weighted_amount"]) == Decimal("75000.00")
    assert ov["won_this_month"] == 1 and ov["win_rate_90d"] == 50.0
    fc = a.get(f"{a.c}/reports/forecast").json()
    this = fc["months"][0]
    assert this["deals"] == 1 and Decimal(this["commit"]) == Decimal("100000") and Decimal(this["won"]) == Decimal("200000")
    wl = a.get(f"{a.c}/reports/win-loss").json()
    assert wl["won"] == 1 and wl["lost"] == 1 and wl["lost_reasons"][0]["reason"] == reason["name"]
    conv = a.get(f"{a.c}/reports/conversion").json()
    assert conv["created"] == 3
    by_name = {s["name"]: s for s in conv["stages"]}
    assert by_name["New"]["reached"] == 3 and by_name["Won"]["reached"] == 1
    lb = a.get(f"{a.c}/reports/leaderboard").json()
    assert lb["rows"][0]["owner"]["id"] == a.user["id"] and lb["rows"][0]["won"] == 1


# ------------------------------------------------------------------ automation

def test_automation_deal_won_trigger_and_crm_actions(crm):
    a = crm
    st = _stages(a)
    a.app_auto = f"/apps/{a.app_id}/automation"
    bad = {"nodes": [node("t", "trigger", kind="deal_won"), node("x", "crm_action", action="create_task")],
           "edges": [{"id": "e", "source": "t", "target": "x"}]}
    w = a.post(f"{a.app_auto}/workflows", json={"name": "Won follow-up", "graph": bad}).json()
    r = a.post(f"{a.app_auto}/workflows/{w['id']}/publish", json={"activate": True})
    assert r.status_code == 422 and any("task title" in i["message"] for i in r.json()["error"]["details"])
    good = {"nodes": [node("t", "trigger", kind="deal_won", pipeline_id=st["_pipeline"]["id"]),
                      node("x", "crm_action", action="create_task", title="Onboard {{name}}", task_type="call",
                           due_in_hours=48),
                      node("y", "crm_action", action="set_lifecycle", lifecycle_stage="customer")],
            "edges": [{"id": "e1", "source": "t", "target": "x"}, {"id": "e2", "source": "x", "target": "y"}]}
    a.patch(f"{a.app_auto}/workflows/{w['id']}", json={"graph": good})
    assert a.post(f"{a.app_auto}/workflows/{w['id']}/publish", json={"activate": True}).status_code == 200

    asha = _contact(a)
    a.patch(f"{a.c}/contacts/{asha['id']}", json={"owner_id": a.user["id"]})
    d = a.post(f"{a.c}/deals", json={"title": "Big one", "contact_id": asha["id"]}).json()
    a.post(f"{a.c}/deals/{d['id']}/close", json={"outcome": "won"})
    assert engine.tick() == {"enrolled": 1, "advanced": 1}
    with SessionLocal() as db:
        t = db.scalar(select(CrmTask).where(CrmTask.contact_id == asha["id"]))
    assert t.title == "Onboard Asha" and t.type == "call" and t.assignee_id == a.user["id"]

    # A second workflow: a hot score creates a deal for the contact.
    g2 = {"nodes": [node("t", "trigger", kind="score_reached"),
                    node("x", "crm_action", action="create_deal", title="{{name}} – inbound", amount=25000)],
          "edges": [{"id": "e", "source": "t", "target": "x"}]}
    w2 = a.post(f"{a.app_auto}/workflows", json={"name": "Hot lead deal", "graph": g2}).json()
    assert a.post(f"{a.app_auto}/workflows/{w2['id']}/publish", json={"activate": True}).status_code == 200
    bob = _contact(a, "Bob", country="IN")
    a.patch(f"{a.c}/settings", json={"hot_score_threshold": 10})
    a.post(f"{a.c}/scoring-rules", json={"kind": "fit", "field": "country", "operator": "eq", "value": "IN",
                                         "points": 15})
    a.post(f"{a.c}/scoring/rescore")
    engine.tick()
    deals = a.get(f"{a.c}/deals", params={"contact_id": bob["id"]}).json()["items"]
    assert [x["title"] for x in deals] == ["Bob – inbound"] and Decimal(deals[0]["amount"]) == Decimal("25000")


# ------------------------------------------------------------------ access

def test_permissions_and_isolation(crm):
    a = crm
    d = a.post(f"{a.c}/deals", json={"title": "Secret"}).json()
    viewer = invite_and_join(a, "viewer@example.com", "viewer", [a.app_id])
    assert viewer.get(f"{a.c}/board").status_code == 200
    assert viewer.post(f"{a.c}/deals", json={"title": "x"}).status_code == 403
    assert viewer.patch(f"{a.c}/settings", json={"sla_enabled": True}).status_code == 403
    rep = invite_and_join(a, "rep@example.com", "campaign_manager", [a.app_id])
    assert rep.post(f"{a.c}/deals", json={"title": "Mine"}).status_code == 201
    assert rep.post(f"{a.c}/pipelines", json={"name": "Nope"}).status_code == 403  # needs crm.manage
    assert a.patch(f"{a.c}/deals/{d['id']}", json={"owner_id": viewer.user["id"]}).status_code == 422

    other = Api().register("other@example.com", "Other")
    org = other.create_org("Other Org")
    other.create_app(org["id"], "Theirs")
    assert other.get(f"{a.c}/deals/{d['id']}").status_code in (403, 404)
    their_app = other.get("/applications", params={"organization_id": org["id"]}).json()
    their_id = (their_app["items"] if isinstance(their_app, dict) else their_app)[0]["id"]
    assert other.get(f"/apps/{their_id}/crm/deals/{d['id']}").status_code == 404


def test_task_due_buckets_agree(crm):
    a = crm
    now = utcnow()
    for title, due in (("late", now - timedelta(hours=2)), ("soon", now + timedelta(minutes=5)),
                       ("later", now + timedelta(days=3))):
        a.post(f"{a.c}/tasks", json={"title": title, "due_at": due.isoformat()})
    a.post(f"{a.c}/tasks", json={"title": "whenever"})

    def titles(due):
        return {t["title"] for t in a.get(f"{a.c}/tasks", params={"assignee_id": "me", "due": due}).json()["items"]}

    assert titles("overdue") == {"late"} and titles("upcoming") == {"later"} and titles("none") == {"whenever"}
    assert "late" not in titles("today")
    summary = a.get(f"{a.c}/tasks/summary").json()
    assert summary["overdue"] == 1 and summary["today"] == len(titles("today")) and summary["open"] == 4
    assert a.get(f"{a.c}/deals", params={"sort": "-title"}).status_code == 200
