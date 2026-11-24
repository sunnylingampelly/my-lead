"""Dashboard: real module flags, channel cards, dependency-ordered checklist, activity links,
compliance status and the providers-status endpoint."""
from tests.conftest import invite_and_join
from tests.test_sms import india, ready_india  # noqa: F401 (fixture)

# No phone number step: calls come from Signalcraft-managed numbers.
ORDER = ["invite_team", "import_contacts", "lead_form", "verify_sender", "first_email", "sms_setup", "first_workflow", "first_deal", "add_chatbot", "create_segment"]


def _items(a, app_id):
    return {c["key"]: c for c in a.get(f"/apps/{app_id}/dashboard").json()["checklist"]}


def test_modules_are_real_and_checklist_is_ordered(owner):
    d = owner.get(f"/apps/{owner.app['id']}/dashboard").json()
    assert all(d["modules"][k] for k in ("audience", "email", "sms", "voice", "analytics", "billing"))
    assert [c["key"] for c in d["checklist"]] == ORDER
    for c in d["checklist"]:
        assert set(c) >= {"key", "label", "done", "href", "cta", "available", "optional"}
        assert c["href"].startswith("/") and c["available"] is True
    assert {c["key"] for c in d["checklist"] if c["optional"]} == {"invite_team", "add_chatbot", "create_segment"}
    assert set(d["channels"]) == {"audience", "email", "sms", "voice"}
    assert d["channels"]["email"] == {"count_30d": 0, "ready": False,
                                      "setup_href": f"/apps/{owner.app['id']}/email/senders"}
    # The light endpoint returns the same steps.
    light = owner.get(f"/apps/{owner.app['id']}/dashboard/checklist").json()
    assert [c["key"] for c in light] == ORDER


def test_checklist_tracks_real_records(owner):
    app_id = owner.app["id"]
    base = f"/apps/{app_id}"
    assert owner.post(f"{base}/contacts", json={"email": "c@example.com"}).status_code == 201
    r = owner.post(f"{base}/crm/deals", json={"title": "First deal"})
    assert r.status_code == 201, r.text
    r = owner.post(f"{base}/automation/workflows", json={"name": "Welcome"})
    assert r.status_code == 201, r.text
    items = _items(owner, app_id)
    assert items["import_contacts"]["done"] and items["first_deal"]["done"] and items["first_workflow"]["done"]
    assert not items["verify_sender"]["done"] and "voice_caller" not in items
    d = owner.get(f"{base}/dashboard").json()
    assert d["channels"]["audience"]["count_30d"] == 1 and d["channels"]["audience"]["ready"] is True


def test_india_sms_step_follows_dlt_progress(india):  # noqa: F811
    a = india
    item = _items(a, a.app_id)["sms_setup"]
    assert not item["done"] and item["href"].endswith("/sms/registration") and "DLT" in item["detail"]
    ready_india(a)
    item = _items(a, a.app_id)["sms_setup"]
    assert item["done"] and item["detail"] is None
    comp = a.get(f"/applications/{a.app_id}/compliance").json()
    dlt = next(c for c in comp["checks"] if c["key"] == "dlt")
    assert dlt["done"] is True and "pending_module" not in dlt
    assert a.get(f"{a.base}/dashboard").json()["channels"]["sms"]["ready"] is True


def test_us_sms_step_points_to_10dlc(owner):
    r = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "US App",
                                          "default_country": "US", "timezone": "America/New_York"})
    item = _items(owner, r.json()["id"])["sms_setup"]
    assert "10DLC" in item["label"] and item["href"].endswith("/sms/registration")


def test_checklist_is_role_aware(owner):
    viewer = invite_and_join(owner, "viewer@example.com", "viewer", [owner.app["id"]])
    items = _items(viewer, owner.app["id"])
    assert items["import_contacts"]["available"] is False
    assert items["invite_team"]["available"] is False


def test_recent_activity_links_to_records(owner):
    base = f"/apps/{owner.app['id']}"
    deal = owner.post(f"{base}/crm/deals", json={"title": "Linked"}).json()
    acts = owner.get(f"{base}/dashboard").json()["recent_activity"]
    entry = next(a for a in acts if a["action"] == "crm_deal.created")
    assert entry["href"] == f"{base}/crm/deals/{deal['id']}"
    created = next(a for a in acts if a["action"] == "application.created")
    assert created["href"] == f"{base}/settings"


def test_providers_status(owner):
    s = owner.get(f"/apps/{owner.app['id']}/providers/status").json()
    assert s["communication_mode"] == "simulation" and s["simulation"] is True
    assert set(s["providers"]["voice"]) == {"simulation", "telnyx", "exotel", "twilio"}
    assert all(isinstance(v, bool) for ch in s["providers"].values() for v in ch.values())
    r = owner.patch(f"/applications/{owner.app['id']}/settings", json={"default_voice_provider": "telnyx"})
    assert r.status_code == 200 and r.json()["default_voice_provider"] == "telnyx"
