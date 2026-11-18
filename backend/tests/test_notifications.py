from tests.conftest import Api, invite_and_join


def test_invite_acceptance_and_role_change_notify_the_right_people(owner):
    member = invite_and_join(owner, "nina@example.com", "viewer", [owner.app["id"]])
    assert owner.get("/notifications/unread-count").json() == {"unread": 1}
    n = owner.get("/notifications").json()["items"][0]
    assert n["type"] == "member_joined" and "joined Acme Corp" in n["title"] and n["link"].endswith("/team")
    assert member.get("/notifications/unread-count").json()["unread"] == 0

    mid = next(m["id"] for m in owner.get(f"/organizations/{owner.org['id']}/members").json()["items"]
               if m["user"]["email"] == "nina@example.com")
    owner.patch(f"/organizations/{owner.org['id']}/members/{mid}", json={"role": "analyst"})
    mine = member.get("/notifications").json()["items"]
    assert mine[0]["type"] == "role_changed" and "Analyst" in mine[0]["body"]

    # Notifications are private.
    assert member.post(f"/notifications/{n['id']}/read").status_code == 404
    assert owner.post(f"/notifications/{n['id']}/read").status_code == 204
    assert owner.get("/notifications/unread-count").json()["unread"] == 0
    assert owner.get("/notifications?unread_only=true").json()["total"] == 0


def test_removed_member_stops_seeing_org_notifications(owner):
    member = invite_and_join(owner, "rex@example.com", "viewer", [owner.app["id"]])
    app2 = owner.create_app(owner.org["id"], "Second")
    owner.post(f"/applications/{app2['id']}/members", json={"user_id": member.user["id"]})
    assert member.get("/notifications").json()["items"][0]["type"] == "app_access_granted"
    mid = next(m["id"] for m in owner.get(f"/organizations/{owner.org['id']}/members").json()["items"]
               if m["user"]["email"] == "rex@example.com")
    owner.delete(f"/organizations/{owner.org['id']}/members/{mid}")
    items = member.get("/notifications").json()["items"]
    assert [i["type"] for i in items] == ["member_removed"]
    assert member.post("/notifications/read-all").json() == {"unread": 0}


def test_import_completion_notifies_uploader(owner):
    r = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "N App", "default_country": "IN"})
    base = f"/apps/{r.json()['id']}"
    up = owner.client.post(f"/api/v1{base}/contacts/import", headers=owner.headers,
                           files={"file": ("a.csv", b"Email\nx@example.com\nbad\n", "text/csv")})
    owner.post(f"{base}/imports/{up.json()['id']}/start", json={"mapping": {"Email": "email"}, "options": {}})
    n = owner.get("/notifications").json()["items"][0]
    assert n["type"] == "import_completed" and n["level"] == "warning"
    assert n["body"] == "1 created, 0 updated, 1 not imported (see report)"
    assert Api().register("other@example.com").get("/notifications").json()["total"] == 0
