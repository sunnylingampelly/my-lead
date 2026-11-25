"""Audience: contacts, regional rules (India/US), consent, suppression, segments, lists, tags, export."""
import pytest

from tests.conftest import Api, invite_and_join, make_pro


@pytest.fixture
def india(owner):
    """Owner with an India-focused application (default country IN)."""
    r = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "Bharat Retail",
                                           "timezone": "Asia/Kolkata", "default_country": "IN"})
    assert r.status_code == 201, r.text
    owner.in_app = r.json()
    owner.base = f"/apps/{owner.in_app['id']}"
    return owner


def contact(api, base, **body):
    r = api.post(f"{base}/contacts", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_indian_and_us_numbers_normalise(india):
    a, base = india, india.base
    c = contact(a, base, first_name="Asha", phone="98765 43210", city="Hyderabad")
    assert c["phone"] == "+919876543210" and c["phone_country"] == "IN" and c["country"] == "IN"
    assert c["timezone"] == "Asia/Kolkata" and c["phone_display"] == "+91 98765 43210"
    us = contact(a, base, first_name="John", phone="+1 (415) 555-2671", state="California")
    assert us["phone"] == "+14155552671" and us["state"] == "CA" and us["timezone"] == "America/Los_Angeles"
    assert us["jurisdiction_name"] == "United States"
    bad = a.post(f"{base}/contacts", json={"phone": "12345"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_CONTACT"


def test_identity_rule_and_duplicates(india):
    a, base = india, india.base
    contact(a, base, email="Asha@Example.com")
    dup = a.post(f"{base}/contacts", json={"email": "asha@example.com", "first_name": "Dup"})
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "DUPLICATE_CONTACT"
    none = a.post(f"{base}/contacts", json={"first_name": "Nobody"})
    assert none.json()["error"]["code"] == "IDENTIFIER_REQUIRED"
    # Contacts without email do not collide with each other (NULL identity keys).
    contact(a, base, phone="9000000001")
    contact(a, base, phone="9000000002")
    # The identity rule is locked once contacts exist.
    r = a.patch(f"/applications/{a.in_app['id']}/settings", json={"contact_identity_rule": "email"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "IDENTITY_RULE_LOCKED"


def test_consent_is_never_assumed_and_us_needs_written_evidence(india):
    a, base = india, india.base
    c = contact(a, base, email="x@example.com", phone="+12025550143")
    assert not (c["email_consent"] or c["sms_consent"] or c["voice_consent"])
    assert c["eligibility"]["email"]["reasons"] == ["No marketing consent"]
    r = a.post(f"{base}/contacts/{c['id']}/consent", json={"channel": "sms", "status": "granted",
                                                           "source": "Website form"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "WRITTEN_CONSENT_REQUIRED"
    r = a.post(f"{base}/contacts/{c['id']}/consent", json={"channel": "sms", "status": "granted",
                                                           "source": "Website form",
                                                           "evidence": "Signed TCPA checkbox, 2026-11-01"})
    assert r.status_code == 200 and r.json()["eligibility"]["sms"]["eligible"] is True
    # India numbers: source is enough at this layer (DLT checks happen at send time).
    ind = contact(a, base, phone="9123456780")
    r = a.post(f"{base}/contacts/{ind['id']}/consent", json={"channel": "sms", "status": "granted",
                                                             "source": "Store sign-up", "consent_reference": "CT-1"})
    assert r.status_code == 200 and r.json()["sms_consent"] is True
    hist = a.get(f"{base}/contacts/{c['id']}/consents").json()
    assert hist[0]["evidence"].startswith("Signed TCPA") and hist[0]["jurisdiction"] == "US"


def test_unsubscribe_suppresses_and_survives_deletion(india):
    a, base = india, india.base
    c = contact(a, base, email="leave@example.com",
                consent={"email": True, "source": "Newsletter form"})
    assert c["eligibility"]["email"]["eligible"] is True
    r = a.post(f"{base}/contacts/{c['id']}/consent", json={"channel": "email", "status": "revoked"})
    assert r.json()["email_unsubscribed"] is True and r.json()["status"] == "unsubscribed"
    supp = a.get(f"{base}/suppressions?channel=email").json()
    assert supp["total"] == 1 and supp["items"][0]["value_masked"].startswith("le")
    assert "leave@example.com" not in str(supp)
    # The suppression cannot simply be deleted.
    assert a.delete(f"{base}/suppressions/{supp['items'][0]['id']}").status_code == 409
    # Erasure: after deletion the hash-based suppression still applies to a re-created contact.
    assert a.delete(f"{base}/contacts/{c['id']}").status_code == 204
    again = contact(a, base, email="leave@example.com")
    assert "Previously unsubscribed" in again["eligibility"]["email"]["reasons"]
    assert a.get(f"{base}/contacts?eligible_for=email").json()["total"] == 0
    # Only an explicit, recorded re-opt-in lifts it.
    r = a.post(f"{base}/contacts/{again['id']}/consent", json={"channel": "email", "status": "granted",
                                                               "source": "Customer re-subscribed by email"})
    assert r.json()["eligibility"]["email"]["eligible"] is True


def test_manual_suppression_and_search(india):
    a, base = india, india.base
    r = a.post(f"{base}/suppressions", json={"channel": "sms", "value": "98765 11111", "note": "DND request"})
    assert r.status_code == 201 and r.json()["value_masked"].startswith("+91")
    assert a.get(f"{base}/suppressions?search=9876511111").json()["total"] == 1
    c = contact(a, base, phone="9876511111", consent={"sms": True, "source": "Store"})
    assert c["eligibility"]["sms"]["eligible"] is False
    assert a.delete(f"{base}/suppressions/{r.json()['id']}").status_code == 204


def test_custom_fields_typed_and_date_formats(india, owner):
    a, base = india, india.base
    for body in [{"key": "purchase_amount", "label": "Purchase amount", "data_type": "number"},
                 {"key": "membership_status", "label": "Membership", "data_type": "select",
                  "options": ["Basic", "Premium"]},
                 {"key": "subscription_date", "label": "Subscription date", "data_type": "date"}]:
        assert a.post(f"{base}/audience/attributes", json=body).status_code == 201
    c = contact(a, base, email="p@example.com", attributes={"purchase_amount": "₹12,500", "membership_status":
                                                             "premium", "subscription_date": "05/03/2026"})
    # India app: 05/03/2026 is 5 March.
    assert c["attributes"] == {"purchase_amount": 12500, "membership_status": "Premium",
                               "subscription_date": "2026-03-05"}
    bad = a.post(f"{base}/contacts", json={"email": "q@example.com", "attributes": {"membership_status": "Gold"}})
    assert bad.status_code == 422
    assert a.post(f"{base}/audience/attributes", json={"key": "email", "label": "x", "data_type": "text"}
                  ).status_code == 422
    # A US app reads the same slash date month-first.
    make_pro(owner.org["id"])  # a third application
    us = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "US App",
                                           "default_country": "US", "timezone": "America/New_York"}).json()
    ub = f"/apps/{us['id']}"
    owner.post(f"{ub}/audience/attributes", json={"key": "subscription_date", "label": "Sub", "data_type": "date"})
    uc = contact(owner, ub, email="u@example.com", attributes={"subscription_date": "05/03/2026"})
    assert uc["attributes"]["subscription_date"] == "2026-05-03"


def test_tags_lists_bulk_and_filters(india):
    a, base = india, india.base
    tag = a.post(f"{base}/tags", json={"name": "VIP"}).json()
    lst = a.post(f"{base}/lists", json={"name": "Diwali 2026"}).json()
    ids = [contact(a, base, email=f"b{i}@example.com", city="Pune")["id"] for i in range(5)]
    r = a.post(f"{base}/contacts/bulk", json={"action": "add_tag", "contact_ids": ids[:3], "tag_id": tag["id"]})
    assert r.json() == {"matched": 3, "affected": 3}
    r = a.post(f"{base}/contacts/bulk", json={"action": "add_to_list", "filters": {"search": "pune"},
                                              "list_id": lst["id"]})
    assert r.json()["matched"] == 0  # search matches name/email/company, not city
    r = a.post(f"{base}/contacts/bulk", json={"action": "add_to_list", "contact_ids": ids, "list_id": lst["id"]})
    assert r.json()["affected"] == 5
    assert a.get(f"{base}/contacts?tag_id={tag['id']}").json()["total"] == 3
    assert a.get(f"{base}/lists/{lst['id']}").json()["contact_count"] == 5
    assert a.delete(f"{base}/lists/{lst['id']}/contacts", json={"contact_ids": ids[:2]}).json() == {"removed": 2}
    assert [t["contact_count"] for t in a.get(f"{base}/tags").json()] == [3]
    assert a.post(f"{base}/tags", json={"name": "vip"}).status_code == 409
    r = a.post(f"{base}/contacts/bulk", json={"action": "delete", "contact_ids": ids[:2]})
    assert r.json()["affected"] == 2 and a.get(f"{base}/contacts").json()["total"] == 3


def test_search_sort_paginate(india):
    a, base = india, india.base
    for i, n in enumerate(["Zara", "Amit", "Meera"]):
        contact(a, base, email=f"s{i}@example.com", first_name=n, last_name="Shah", phone=f"98100000{i}0")
    assert [c["first_name"] for c in a.get(f"{base}/contacts?sort=first_name").json()["items"]] == \
        ["Amit", "Meera", "Zara"]
    assert a.get(f"{base}/contacts?search=meera shah").json()["total"] == 1
    assert a.get(f"{base}/contacts?search=8100000").json()["total"] == 3
    p = a.get(f"{base}/contacts?page=2&page_size=2").json()
    assert p["total"] == 3 and len(p["items"]) == 1
    assert a.get(f"{base}/contacts?sort=password").status_code == 422


def test_segments_hyderabad_premium_and_sms_eligible(india):
    a, base = india, india.base
    a.post(f"{base}/audience/attributes", json={"key": "purchase_amount", "label": "Purchase", "data_type": "number"})
    a.post(f"{base}/audience/attributes", json={"key": "membership_status", "label": "Membership",
                                                "data_type": "select", "options": ["Basic", "Premium"]})
    contact(a, base, email="h1@example.com", city="Hyderabad", attributes={"purchase_amount": 15000,
                                                                           "membership_status": "Premium"})
    contact(a, base, email="h2@example.com", city="hyderabad", phone="9000011111",
            consent={"sms": True, "source": "Store"})
    contact(a, base, phone="9000022222", city="Hyderabad")
    contact(a, base, email="m@example.com", city="Mumbai", attributes={"purchase_amount": 20000,
                                                                       "membership_status": "Premium"})
    hyd = {"match": "all", "conditions": [
        {"field": "city", "operator": "is", "value": "Hyderabad"},
        {"field": "email", "operator": "is_not_empty"},
        {"field": "status", "operator": "is", "value": "active"}]}
    r = a.post(f"{base}/segments", json={"name": "Hyderabad Customers", "rules": hyd})
    assert r.status_code == 201 and r.json()["last_count"] == 2
    seg_id = r.json()["id"]
    assert a.get(f"{base}/contacts?segment_id={seg_id}").json()["total"] == 2

    premium = {"match": "all", "conditions": [
        {"field": "attr.purchase_amount", "operator": "gt", "value": 10000},
        {"field": "attr.membership_status", "operator": "is", "value": "Premium"}]}
    assert a.post(f"{base}/segments/preview", json={"rules": premium}).json()["count"] == 2

    sms = {"match": "all", "conditions": [
        {"field": "phone", "operator": "is_not_empty"},
        {"field": "sms_consent", "operator": "is", "value": True},
        {"field": "sms_unsubscribed", "operator": "is", "value": False}]}
    pv = a.post(f"{base}/segments/preview", json={"rules": sms}).json()
    assert pv["count"] == 1 and pv["eligible"]["sms"] == 1

    nested = {"match": "any", "conditions": [
        {"field": "city", "operator": "is", "value": "Mumbai"},
        {"type": "group", "match": "all", "conditions": [
            {"field": "city", "operator": "starts_with", "value": "hyd"},
            {"field": "email", "operator": "is_empty"}]}]}
    assert a.post(f"{base}/segments/preview", json={"rules": nested}).json()["count"] == 2

    # Segments are dynamic: new matching contacts appear without re-saving.
    contact(a, base, email="h3@example.com", city="Hyderabad")
    assert a.get(f"{base}/segments/{seg_id}").json()["last_count"] == 3


def test_segment_rules_are_validated_not_executed(india):
    a, base = india, india.base
    contact(a, base, email="safe@example.com", city="Delhi")
    evil = {"match": "all", "conditions": [{"field": "city", "operator": "is", "value": "x' OR '1'='1"}]}
    assert a.post(f"{base}/segments/preview", json={"rules": evil}).json()["count"] == 0
    for cond in [{"field": "password_hash", "operator": "is", "value": "x"},
                 {"field": "city", "operator": "gt", "value": 1},
                 {"field": "attr.nope", "operator": "is", "value": 1},
                 {"field": "tag", "operator": "has_tag", "value": "not-a-tag"}]:
        r = a.post(f"{base}/segments/preview", json={"rules": {"match": "all", "conditions": [cond]}})
        assert r.status_code == 422 and r.json()["error"]["code"] == "INVALID_SEGMENT_RULES", cond
    pct = {"match": "all", "conditions": [{"field": "city", "operator": "contains", "value": "%"}]}
    assert a.post(f"{base}/segments/preview", json={"rules": pct}).json()["count"] == 0


def test_cannot_delete_tag_used_by_segment(india):
    a, base = india, india.base
    tag = a.post(f"{base}/tags", json={"name": "Lead"}).json()
    a.post(f"{base}/segments", json={"name": "Leads", "rules": {"match": "all", "conditions": [
        {"field": "tag", "operator": "has_tag", "value": tag["id"]}]}})
    r = a.delete(f"{base}/tags/{tag['id']}")
    assert r.status_code == 409 and r.json()["error"]["details"]["segments"] == ["Leads"]


def test_export_is_permissioned_audited_and_injection_safe(india):
    a, base = india, india.base
    contact(a, base, email="x@example.com", first_name="=HYPERLINK(\"http://evil\")", phone="9811111111")
    r = a.get(f"{base}/contacts/export")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    body = r.content.decode("utf-8-sig")
    assert "'=HYPERLINK" in body and "+919811111111" in body
    logs = a.get(f"/organizations/{a.org['id']}/audit-logs").json()["items"]
    assert any(i["action"] == "contacts.exported" for i in logs)
    viewer = invite_and_join(a, "viewer@example.com", "viewer", [a.in_app["id"]])
    assert viewer.get(f"{base}/contacts/export").status_code == 403
    assert viewer.get(f"{base}/contacts").status_code == 200
    assert viewer.post(f"{base}/contacts", json={"email": "v@example.com"}).status_code == 403


def test_activity_and_overview(india):
    a, base = india, india.base
    c = contact(a, base, email="o@example.com", phone="9822222222", consent={"email": True, "source": "Form"})
    acts = a.get(f"{base}/contacts/{c['id']}/activity").json()["items"]
    assert {x["type"] for x in acts} >= {"created", "consent_granted"}
    ov = a.get(f"{base}/audience/overview").json()
    assert ov["total"] == 1 and ov["reachable"]["email"] == 1 and ov["reachable"]["sms"] == 0
    assert ov["countries"] == [{"country": "IN", "count": 1}] and ov["growth"][-1]["total"] == 1
    d = a.get(f"{base[:-len(a.in_app['id'])]}{a.in_app['id']}/dashboard").json()
    assert d["audience"]["total"] == 1 and d["modules"]["audience"] is True


def test_compliance_profiles(india, owner):
    comp = owner.get(f"/applications/{india.in_app['id']}/compliance").json()
    assert comp["region"] == "IN" and comp["currency"] == "INR"
    assert any("DLT" in r["name"] for r in comp["regulations"])
    s = owner.get(f"/applications/{india.in_app['id']}/settings").json()
    assert (s["quiet_hours_start"], s["quiet_hours_end"]) == ("21:00", "09:00")
    make_pro(owner.org["id"])  # a third application
    us = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "US Shop",
                                           "default_country": "US"}).json()
    comp = owner.get(f"/applications/{us['id']}/compliance").json()
    assert comp["region"] == "US" and comp["sms_voice_requires_written_consent"] is True
    assert {c["key"] for c in comp["checks"]} == {"business_address", "quiet_hours", "10dlc"}
    assert owner.get(f"/applications/{us['id']}/settings").json()["quiet_hours_end"] == "08:00"
    owner.patch(f"/applications/{us['id']}/settings", json={"business_address": "1 Main St, Austin, TX 78701"})
    comp = owner.get(f"/applications/{us['id']}/compliance").json()
    assert next(c for c in comp["checks"] if c["key"] == "business_address")["done"] is True


def test_audience_isolation_between_apps_and_orgs(india):
    a, base = india, india.base
    c = contact(a, base, email="secret@example.com")
    tag = a.post(f"{base}/tags", json={"name": "Private"}).json()
    make_pro(a.org["id"])  # a third application
    other_app =a.post("/applications", json={"organization_id": a.org["id"], "name": "Other"}).json()
    ob = f"/apps/{other_app['id']}"
    assert a.get(f"{ob}/contacts").json()["total"] == 0
    assert a.get(f"{ob}/contacts/{c['id']}").status_code == 404
    assert a.patch(f"{ob}/contacts/{c['id']}", json={"first_name": "x"}).status_code == 404
    r = a.post(f"{ob}/contacts/bulk", json={"action": "delete", "contact_ids": [c["id"]]})
    assert r.json()["matched"] == 0
    assert a.post(f"{ob}/contacts", json={"email": "n@example.com", "tag_ids": [tag["id"]]}).status_code == 422
    # Same email may exist independently in another application.
    contact(a, ob, email="secret@example.com")

    bob = Api().register("bob@example.com")
    bob_org = bob.create_org("Bobco")
    bob.create_app(bob_org["id"], "Bob App")
    for method, url in [("get", f"{base}/contacts"), ("get", f"{base}/contacts/{c['id']}"),
                        ("get", f"{base}/contacts/export"), ("get", f"{base}/segments"), ("get", f"{base}/tags"),
                        ("get", f"{base}/audience/overview"), ("get", f"{base}/imports")]:
        assert getattr(bob, method)(url).status_code == 404, url
    assert a.get(f"{base}/contacts/{c['id']}").json()["email"] == "secret@example.com"
