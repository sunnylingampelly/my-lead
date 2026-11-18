"""Tenant isolation: one organization or application can never reach another's records."""
from tests.conftest import Api, invite_and_join


def _second_tenant():
    b = Api().register("bob@example.com", "Bob")
    b.org = b.create_org("Bobco")
    b.app = b.create_app(b.org["id"], "Bob App")
    return b


def test_organization_isolation(owner):
    bob = _second_tenant()
    a_org = owner.org["id"]
    for method, url, kw in [
        ("get", f"/organizations/{a_org}", {}),
        ("patch", f"/organizations/{a_org}", {"json": {"name": "Pwned"}}),
        ("get", f"/organizations/{a_org}/members", {}),
        ("get", f"/organizations/{a_org}/invitations", {}),
        ("post", f"/organizations/{a_org}/invitations", {"json": {"email": "x@example.com", "role": "admin"}}),
        ("get", f"/organizations/{a_org}/audit-logs", {}),
        ("get", f"/applications?organization_id={a_org}", {}),
    ]:
        r = getattr(bob, method)(url, **kw)
        assert r.status_code == 404, (method, url, r.status_code)
    assert [o["id"] for o in bob.get("/organizations").json()] == [bob.org["id"]]


def test_application_isolation_across_orgs(owner):
    bob = _second_tenant()
    a_app = owner.app["id"]
    for method, url, kw in [
        ("get", f"/applications/{a_app}", {}),
        ("patch", f"/applications/{a_app}", {"json": {"name": "Pwned"}}),
        ("delete", f"/applications/{a_app}", {"json": {"confirm_name": "Acme Main"}}),
        ("get", f"/applications/{a_app}/settings", {}),
        ("get", f"/applications/{a_app}/members", {}),
        ("get", f"/apps/{a_app}/dashboard", {}),
    ]:
        r = getattr(bob, method)(url, **kw)
        assert r.status_code == 404, (method, url, r.status_code)


def test_cannot_create_application_in_foreign_org(owner):
    bob = _second_tenant()
    r = bob.post("/applications", json={"organization_id": owner.org["id"], "name": "Sneaky"})
    assert r.status_code == 404
    assert owner.get(f"/applications?organization_id={owner.org['id']}").json()[0]["name"] == "Acme Main"


def test_cannot_grant_access_to_foreign_application(owner):
    bob = _second_tenant()
    # Bob tries to invite someone into his org with access to Acme's application id.
    r = bob.post(f"/organizations/{bob.org['id']}/invitations",
                 json={"email": "x@example.com", "role": "viewer", "application_ids": [owner.app["id"]]})
    assert r.status_code == 422 and r.json()["error"]["code"] == "INVALID_APPLICATIONS"
    # Bob tries to add an Acme user to his app.
    r = bob.post(f"/applications/{bob.app['id']}/members", json={"user_id": owner.user["id"]})
    assert r.status_code == 404


def test_application_isolation_within_org(owner):
    org_id = owner.org["id"]
    app_b = owner.create_app(org_id, "App B")
    cm = invite_and_join(owner, "cm@example.com", "campaign_manager", [owner.app["id"]])
    assert cm.get(f"/applications/{owner.app['id']}").status_code == 200
    for url in [f"/applications/{app_b['id']}", f"/applications/{app_b['id']}/settings",
                f"/apps/{app_b['id']}/dashboard"]:
        assert cm.get(url).status_code == 404


def test_member_ids_scoped_to_org(owner):
    bob = _second_tenant()
    bob_member = bob.get(f"/organizations/{bob.org['id']}/members").json()["items"][0]["id"]
    # Owner of Acme uses Bob's member id under Acme's org path.
    r = owner.patch(f"/organizations/{owner.org['id']}/members/{bob_member}", json={"role": "viewer"})
    assert r.status_code == 404
    assert owner.delete(f"/organizations/{owner.org['id']}/members/{bob_member}").status_code == 404


def test_suspended_org_blocks_access(owner):
    from sqlalchemy import update

    from app.core.database import SessionLocal
    from app.models import Organization

    with SessionLocal() as db:
        db.execute(update(Organization).where(Organization.id == owner.org["id"]).values(status="suspended"))
        db.commit()
    r = owner.get(f"/applications/{owner.app['id']}")
    assert r.status_code == 403 and r.json()["error"]["code"] == "ORG_SUSPENDED"
