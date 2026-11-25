"""Cross-channel analytics include lead forms (views, submissions, conversion) and chat (conversations, leads,
AI replies, bot-resolved %), with compare-to-previous and the CSV export."""
from datetime import timedelta

from sqlalchemy import update

from app.core.database import SessionLocal
from app.models.chat import ChatConversation
from app.models.forms import LeadFormDailyStat
from app.utils.time import utcnow
from tests.test_chat import Visitor, chat, new_bot  # noqa: F401  (fixture)
from tests.test_forms import _create


def test_analytics_include_forms_and_chat(chat):  # noqa: F811
    a = chat
    a.f = f"/apps/{a.app_id}/forms"
    form = _create(a)
    today = utcnow().date()
    with SessionLocal() as db:
        db.add(LeadFormDailyStat(form_id=form["id"], day=today, application_id=a.app_id, views=40, starts=10,
                                 submissions=8))
        db.add(LeadFormDailyStat(form_id=form["id"], day=today - timedelta(days=1), application_id=a.app_id,
                                 views=10, starts=3, submissions=2))
        # The previous 30-day period, for the comparison.
        db.add(LeadFormDailyStat(form_id=form["id"], day=today - timedelta(days=35), application_id=a.app_id,
                                 views=25, starts=5, submissions=5))
        db.commit()
    bot = new_bot(a)
    convs = []
    for text in ("What does it cost?", "Talk to a person"):
        v = Visitor(bot["public_key"])
        v.hello()
        v.start()
        assert v.say(text).status_code == 200
        convs.append(v.conv)
    with SessionLocal() as db:
        db.execute(update(ChatConversation).where(ChatConversation.id == convs[0]).values(
            lead_captured_at=utcnow(), ai_replies=3, handoff_requested_at=None))
        db.execute(update(ChatConversation).where(ChatConversation.id == convs[1]).values(
            handoff_requested_at=utcnow(), ai_replies=1))
        db.commit()

    d = a.get(f"/apps/{a.app_id}/analytics").json()
    keys = {m["key"] for m in d["metrics"]}
    assert {"form_views", "form_submissions", "chat_conversations", "chat_leads", "chat_ai_replies",
            "chat_bot_resolved"} <= keys
    t = d["totals"]
    assert (t["form_views"], t["form_submissions"]) == (50, 10)
    assert (t["chat_conversations"], t["chat_leads"], t["chat_ai_replies"], t["chat_bot_resolved"]) == (2, 1, 4, 1)
    assert d["rates"]["form_conversion"] == 20.0
    assert d["rates"]["chat_bot_resolved"] == 50.0 and d["rates"]["chat_lead"] == 50.0
    assert d["previous"]["totals"]["form_views"] == 25 and d["changes"]["form_views"] == 100.0
    assert d["previous_rates"]["form_conversion"] == 20.0
    assert d["changes"]["chat_conversations"] is None  # nothing before: no percentage
    # A custom range that excludes today leaves only yesterday's form numbers.
    y = (today - timedelta(days=1)).isoformat()
    d2 = a.get(f"/apps/{a.app_id}/analytics?start={y}&end={y}").json()
    assert d2["totals"]["form_views"] == 10 and d2["totals"]["chat_conversations"] == 0
    csv = a.client.get(f"/api/v1/apps/{a.app_id}/analytics/export.csv", headers=a.headers).text
    header = csv.splitlines()[0].split(",")
    assert "form_views" in header and "chat_bot_resolved" in header
    assert "form_conversion_pct,20.0,20.0" in csv and "chat_bot_resolved_pct,50.0," in csv
