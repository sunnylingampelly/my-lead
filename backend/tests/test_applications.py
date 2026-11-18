from tests.conftest import invite_and_join


def test_create_list_update_application(owner):
    org_id = owner.org["id"]
    assert owner.app["role"] == "owner" and owner.app["timezone"] == "Asia/Kolkata"
    apps = owner.get(f"/applications?organization_id={org_id}").json()
    assert [a["name"] for a in apps] == ["Acme Main"]
    r = owner.patch(f"/applications/{owner.app['id']}", json={"name": "Acme Retail", "color": "emerald"})
    assert r.status_code == 200 and r.json()["name"] == "Acme Retail" and r.json()["color"] == "emerald"
    bad = owner.post("/applications", json={"organization_id": org_id, "name": "X App", "timezone": "Nowhere/City"})
    assert bad.status_code == 422


def test_duplicate_names_get_unique_slugs(owner):
    a2 = owner.create_app(owner.org["id"], "Acme Main")
    assert a2["slug"] != owner.app["slug"]


def test_delete_requires_exact_confirmation(owner):
    app_id = owner.app["id"]
    r = owner.delete(f"/applications/{app_id}", json={"confirm_name": "acme main"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "CONFIRMATION_MISMATCH"
    assert owner.delete(f"/applications/{app_id}", json={"confirm_name": "Acme Main"}).status_code == 204
    assert owner.get(f"/applications/{app_id}").status_code == 404
    assert owner.get(f"/applications?organization_id={owner.org['id']}").json() == []
    # Name and slug can be reused after deletion.
    assert owner.create_app(owner.org["id"], "Acme Main")["slug"] == "acme-main"


def test_role_permissions_on_applications(owner):
    app_id = owner.app["id"]
    viewer = invite_and_join(owner, "viewer@example.com", "viewer", [app_id])
    manager = invite_and_join(owner, "mgr@example.com", "application_manager", [app_id])
    assert viewer.patch(f"/applications/{app_id}", json={"name": "Nope"}).status_code == 403
    assert viewer.post("/applications", json={"organization_id": owner.org["id"], "name": "V App"}).status_code == 403
    assert viewer.get(f"/applications/{app_id}/settings").status_code == 403
    assert manager.patch(f"/applications/{app_id}", json={"description": "ok"}).status_code == 200
    assert manager.delete(f"/applications/{app_id}", json={"confirm_name": "Acme Main"}).status_code == 403
    # A manager who creates an app gets explicit access to it automatically.
    new_app = manager.create_app(owner.org["id"], "Manager App")
    assert manager.get(f"/applications/{new_app['id']}").status_code == 200


def test_settings_read_and_update(owner):
    app_id = owner.app["id"]
    s = owner.get(f"/applications/{app_id}/settings").json()
    assert s["contact_identity_rule"] == "email_or_phone" and s["default_email_provider"] == "simulation"
    r = owner.patch(f"/applications/{app_id}/settings", json={"contact_identity_rule": "email",
                                                             "quiet_hours_start": "22:00"})
    assert r.json()["contact_identity_rule"] == "email" and r.json()["quiet_hours_start"] == "22:00"
    assert owner.patch(f"/applications/{app_id}/settings", json={"quiet_hours_end": "25:00"}).status_code == 422


def test_application_member_management(owner):
    org_id, app_id = owner.org["id"], owner.app["id"]
    app2 = owner.create_app(org_id, "Second")
    cm = invite_and_join(owner, "cm@example.com", "campaign_manager", [app_id])
    assert cm.get(f"/applications/{app2['id']}").status_code == 404
    r = owner.post(f"/applications/{app2['id']}/members", json={"user_id": cm.user["id"], "role": "analyst"})
    assert r.status_code == 204
    got = cm.get(f"/applications/{app2['id']}").json()
    assert got["role"] == "analyst" and "campaigns.write" not in got["permissions"]
    members = owner.get(f"/applications/{app2['id']}/members").json()
    assert {m["email"]: m["access"] for m in members} == {"owner@example.com": "org_wide", "cm@example.com": "explicit"}
    # Cannot elevate above org role.
    assert owner.post(f"/applications/{app2['id']}/members",
                      json={"user_id": cm.user["id"], "role": "application_manager"}).status_code == 422
    assert owner.delete(f"/applications/{app2['id']}/members/{cm.user['id']}").status_code == 204
    assert cm.get(f"/applications/{app2['id']}").status_code == 404


def test_dashboard_reflects_real_data(owner):
    d = owner.get(f"/apps/{owner.app['id']}/dashboard").json()
    assert d["application"]["name"] == "Acme Main"
    assert d["team"] == {"with_access": 1, "organization_members": 1, "pending_invitations": 0}
    assert any(a["action"] == "application.created" for a in d["recent_activity"])
    owner.post(f"/organizations/{owner.org['id']}/invitations", json={"email": "p@example.com", "role": "admin"})
    d = owner.get(f"/apps/{owner.app['id']}/dashboard").json()
    assert d["team"]["pending_invitations"] == 1
    assert next(c for c in d["checklist"] if c["key"] == "invite_team")["done"] is True


def test_context_is_remembered_and_validated(owner, api_factory):
    r = owner.put("/users/me/context", json={"application_id": owner.app["id"]})
    assert r.json()["last_application_id"] == owner.app["id"]
    outsider = api_factory().register("out@example.com")
    r = outsider.put("/users/me/context", json={"application_id": owner.app["id"]})
    assert r.status_code == 404


def test_legacy_timezone_names_are_normalised(owner):
    r = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "Legacy TZ",
                                           "timezone": "Asia/Calcutta"})
    assert r.status_code == 201 and r.json()["timezone"] == "Asia/Kolkata"
    assert owner.patch("/users/me", json={"timezone": "Asia/Calcutta"}).json()["timezone"] == "Asia/Kolkata"
