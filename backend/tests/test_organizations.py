from tests.conftest import Api, invite_and_join, token_from_last_email


def test_unverified_user_cannot_create_org():
    a = Api().register("unv@example.com", verify=False)
    r = a.post("/organizations", json={"name": "Nope Inc"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "EMAIL_NOT_VERIFIED"


def test_create_and_list_organizations(owner):
    orgs = owner.get("/organizations").json()
    assert len(orgs) == 1
    assert orgs[0]["role"] == "owner" and orgs[0]["application_count"] == 1
    assert "org.delete" in orgs[0]["permissions"]
    second = owner.create_org("Acme Corp")  # same name gets a unique slug
    assert second["slug"] != owner.org["slug"]
    assert len(owner.get("/organizations").json()) == 2


def test_update_org_requires_permission(owner):
    viewer = invite_and_join(owner, "viewer@example.com", "viewer", [owner.app["id"]])
    org_id = owner.org["id"]
    assert owner.patch(f"/organizations/{org_id}", json={"name": "Acme Global"}).json()["name"] == "Acme Global"
    r = viewer.patch(f"/organizations/{org_id}", json={"name": "Hacked"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "PERMISSION_DENIED"


def test_invitation_flow_grants_app_access(owner):
    org_id = owner.org["id"]
    other_app = owner.create_app(org_id, "Second App")
    member = invite_and_join(owner, "cm@example.com", "campaign_manager", [owner.app["id"]])
    assert member.user["email_verified"] is True  # invite proves inbox ownership
    orgs = member.get("/organizations").json()
    assert [o["role"] for o in orgs] == ["campaign_manager"]
    apps = member.get(f"/applications?organization_id={org_id}").json()
    assert [a["id"] for a in apps] == [owner.app["id"]]
    assert member.get(f"/applications/{other_app['id']}").status_code == 404
    inv = owner.get(f"/organizations/{org_id}/invitations?include_inactive=true").json()
    assert inv[0]["status"] == "accepted"


def test_existing_user_accepts_invitation_and_email_must_match(owner):
    org_id = owner.org["id"]
    existing = Api().register("existing@example.com")
    stranger = Api().register("stranger@example.com")
    owner.post(f"/organizations/{org_id}/invitations", json={"email": "existing@example.com", "role": "admin"})
    token = token_from_last_email("existing@example.com", "/invite")

    preview = Api().post("/invitations/preview", json={"token": token}).json()
    assert preview["organization_name"] == "Acme Corp" and preview["account_exists"] is True

    r = stranger.post("/invitations/accept", json={"token": token})
    assert r.status_code == 403 and r.json()["error"]["code"] == "INVITATION_EMAIL_MISMATCH"
    ok = existing.post("/invitations/accept", json={"token": token})
    assert ok.status_code == 200 and ok.json()["role"] == "admin"
    assert existing.post("/invitations/accept", json={"token": token}).status_code == 422


def test_invitation_validation_and_hierarchy(owner):
    org_id = owner.org["id"]
    r = owner.post(f"/organizations/{org_id}/invitations", json={"email": "a@example.com", "role": "analyst"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "APPLICATIONS_REQUIRED"
    r = owner.post(f"/organizations/{org_id}/invitations",
                   json={"email": "a@example.com", "role": "analyst", "application_ids": ["0" * 36]})
    assert r.json()["error"]["code"] == "INVALID_APPLICATIONS"
    admin = invite_and_join(owner, "admin@example.com", "admin")
    r = admin.post(f"/organizations/{org_id}/invitations", json={"email": "o2@example.com", "role": "owner"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "ROLE_HIERARCHY"
    r = owner.post(f"/organizations/{org_id}/invitations", json={"email": "admin@example.com", "role": "viewer",
                                                                  "application_ids": [owner.app["id"]]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "ALREADY_MEMBER"


def test_revoke_and_resend_invitation(owner):
    org_id = owner.org["id"]
    inv = owner.post(f"/organizations/{org_id}/invitations", json={"email": "z@example.com", "role": "admin"}).json()
    first = token_from_last_email("z@example.com", "/invite")
    assert owner.post(f"/organizations/{org_id}/invitations/{inv['id']}/resend").status_code == 200
    second = token_from_last_email("z@example.com", "/invite")
    assert Api().post("/invitations/preview", json={"token": first}).status_code == 404
    assert owner.delete(f"/organizations/{org_id}/invitations/{inv['id']}").status_code == 204
    joiner = Api().register("z@example.com", verify=False)
    assert joiner.post("/invitations/accept", json={"token": second}).status_code == 422


def test_member_management_rules(owner):
    org_id = owner.org["id"]
    admin = invite_and_join(owner, "adm@example.com", "admin")
    viewer = invite_and_join(owner, "v@example.com", "viewer", [owner.app["id"]])
    members = {m["user"]["email"]: m for m in owner.get(f"/organizations/{org_id}/members").json()["items"]}
    assert len(members) == 3

    # Admin can manage viewer, but not the owner, and cannot promote to owner.
    vid, oid = members["v@example.com"]["id"], members["owner@example.com"]["id"]
    assert admin.patch(f"/organizations/{org_id}/members/{vid}", json={"role": "analyst"}).json()["role"] == "analyst"
    assert admin.patch(f"/organizations/{org_id}/members/{vid}", json={"role": "owner"}).status_code == 403
    assert admin.delete(f"/organizations/{org_id}/members/{oid}").status_code == 403
    # Viewer cannot manage anyone.
    assert viewer.patch(f"/organizations/{org_id}/members/{oid}", json={"role": "viewer"}).status_code == 403
    # The last owner cannot leave or be demoted.
    assert owner.delete(f"/organizations/{org_id}/members/{oid}").json()["error"]["code"] == "LAST_OWNER"
    assert owner.patch(f"/organizations/{org_id}/members/{oid}", json={"role": "admin"}).status_code == 403
    # A member can leave on their own.
    assert viewer.delete(f"/organizations/{org_id}/members/{vid}").status_code == 204
    assert viewer.get(f"/organizations/{org_id}").status_code == 404


def test_member_application_access_update(owner):
    org_id = owner.org["id"]
    app2 = owner.create_app(org_id, "App Two")
    analyst = invite_and_join(owner, "an@example.com", "analyst", [owner.app["id"]])
    mid = next(m["id"] for m in owner.get(f"/organizations/{org_id}/members").json()["items"]
               if m["user"]["email"] == "an@example.com")
    r = owner.patch(f"/organizations/{org_id}/members/{mid}", json={"application_ids": [app2["id"]]})
    assert r.json()["application_ids"] == [app2["id"]]
    assert analyst.get(f"/applications/{owner.app['id']}").status_code == 404
    assert analyst.get(f"/applications/{app2['id']}").status_code == 200


def test_roles_endpoint_and_audit_log(owner):
    org_id = owner.org["id"]
    roles = owner.get(f"/organizations/{org_id}/roles").json()
    assert [r["key"] for r in roles][0] == "owner" and all(r["assignable"] for r in roles)
    logs = owner.get(f"/organizations/{org_id}/audit-logs").json()
    actions = {i["action"] for i in logs["items"]}
    assert {"organization.created", "application.created"} <= actions
    viewer = invite_and_join(owner, "v2@example.com", "viewer", [owner.app["id"]])
    assert viewer.get(f"/organizations/{org_id}/audit-logs").status_code == 403
