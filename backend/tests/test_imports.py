"""CSV/XLSX import: upload, mapping, validation, processing, restart safety and reports."""
import csv
import io
import random

import pytest
from openpyxl import Workbook
from sqlalchemy import func, select

from app.core.database import SessionLocal
from app.models import Contact, Import, ImportRow

CITIES = ["Hyderabad", "Bengaluru", "Mumbai", "Chennai", "Pune", "Delhi"]


@pytest.fixture
def app_in(owner):
    r = owner.post("/applications", json={"organization_id": owner.org["id"], "name": "Import App",
                                           "default_country": "IN", "timezone": "Asia/Kolkata"})
    owner.base = f"/apps/{r.json()['id']}"
    owner.app_id = r.json()["id"]
    return owner


def make_csv(n: int, extra_rows: list[list[str]] | None = None) -> bytes:
    rnd = random.Random(42)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Name", "Email Address", "Mobile", "City", "Lifetime Value"])
    for i in range(n):
        w.writerow([f"Person {i} Kumar", f"person{i}@example.com", f"9{800000000 + i:09d}",
                    CITIES[i % len(CITIES)], str(rnd.randint(100, 50000))])
    for r in extra_rows or []:
        w.writerow(r)
    return buf.getvalue().encode("utf-8")


MAPPING = {"Name": "full_name", "Email Address": "email", "Mobile": "phone", "City": "city"}


def upload(api, data: bytes, name="contacts.csv"):
    r = api.client.post(f"/api/v1{api.base}/contacts/import", headers=api.headers,
                        files={"file": (name, data, "text/csv")})
    assert r.status_code == 201, r.text
    return r.json()


def start(api, imp_id, mapping=MAPPING, **options):
    body = {"mapping": mapping, "options": {"duplicate_handling": "skip", **options}}
    r = api.post(f"{api.base}/imports/{imp_id}/start", json=body)
    assert r.status_code == 200, r.text
    return api.get(f"{api.base}/imports/{imp_id}").json()


def test_upload_suggests_mapping_and_previews(app_in):
    imp = upload(app_in, make_csv(3))
    assert imp["columns"] == ["Name", "Email Address", "Mobile", "City", "Lifetime Value"]
    assert imp["total_rows"] == 3 and len(imp["preview"]) == 3
    assert imp["suggested_mapping"] == {"Name": "full_name", "Email Address": "email", "Mobile": "phone",
                                        "City": "city", "Lifetime Value": ""}


def test_upload_rejects_bad_files(app_in):
    r = app_in.client.post(f"/api/v1{app_in.base}/contacts/import", headers=app_in.headers,
                           files={"file": ("x.exe", b"MZ\x00\x00", "application/octet-stream")})
    assert r.json()["error"]["code"] == "UNSUPPORTED_FILE_TYPE"
    r = app_in.client.post(f"/api/v1{app_in.base}/contacts/import", headers=app_in.headers,
                           files={"file": ("x.xlsx", b"not a zip", "application/octet-stream")})
    assert r.json()["error"]["code"] == "INVALID_FILE"
    r = app_in.client.post(f"/api/v1{app_in.base}/contacts/import", headers=app_in.headers,
                           files={"file": ("x.csv", b"a,b\n", "text/csv")})
    assert r.json()["error"]["code"] == "EMPTY_FILE"


def test_validation_reports_problems(app_in):
    extra = [["Bad Email", "not-an-email", "9811111111", "Pune", "1"],
             ["Bad Phone", "bp@example.com", "12345", "Pune", "1"],
             ["Dup", "person0@example.com", "9700000000", "Pune", "1"],
             ["", "", "", "", ""],
             ["US Person", "us@example.com", "+1 415 555 2671", "SF", "1"]]
    imp = upload(app_in, make_csv(10, extra))
    r = app_in.post(f"{app_in.base}/imports/{imp['id']}/validate", json={"mapping": MAPPING})
    v = r.json()
    assert v["total_rows"] == 14  # fully empty rows are ignored
    assert v["invalid_rows"] == 2 and v["duplicates_in_file"] == 1 and v["valid_rows"] == 11
    assert v["india_numbers"] == 10 and v["us_numbers"] == 1
    assert {e["row"] for e in v["errors"]} == {12, 13}
    bad = app_in.post(f"{app_in.base}/imports/{imp['id']}/validate", json={"mapping": {"City": "city"}})
    assert bad.json()["error"]["code"] == "IDENTIFIER_NOT_MAPPED"
    bad = app_in.post(f"{app_in.base}/imports/{imp['id']}/validate",
                      json={"mapping": {"Name": "email", "Email Address": "email"}})
    assert bad.json()["error"]["code"] == "INVALID_MAPPING"


def test_import_5000_contacts_with_list_tags_and_report(app_in):
    extra = [["Bad", "bad-email", "", "Pune", "1"], ["Dup", "person1@example.com", "", "Pune", "1"]]
    imp = upload(app_in, make_csv(5000, extra))
    app_in.post(f"{app_in.base}/audience/attributes", json={"key": "lifetime_value", "label": "Lifetime Value",
                                                            "data_type": "number"})
    mapping = {**MAPPING, "Lifetime Value": "attr:lifetime_value"}
    done = start(app_in, imp["id"], mapping, new_list_name="Q4 Import", tag_names=["imported", "festive"])
    assert done["status"] == "completed" and done["progress"] == 100
    assert (done["created_count"], done["invalid_count"], done["duplicate_count"]) == (5000, 1, 1)
    assert app_in.get(f"{app_in.base}/contacts").json()["total"] == 5000
    lists = app_in.get(f"{app_in.base}/lists").json()
    assert lists[0]["name"] == "Q4 Import" and lists[0]["contact_count"] == 5000
    assert {t["name"]: t["contact_count"] for t in app_in.get(f"{app_in.base}/tags").json()} == \
        {"imported": 5000, "festive": 5000}
    # No consent was confirmed, so nobody is reachable for marketing.
    ov = app_in.get(f"{app_in.base}/audience/overview").json()
    assert ov["reachable"] == {"email": 0, "sms": 0, "voice": 0}
    hyd = app_in.post(f"{app_in.base}/segments/preview", json={"rules": {"match": "all", "conditions": [
        {"field": "city", "operator": "is", "value": "Hyderabad"}]}}).json()
    assert hyd["count"] == 834
    rep = app_in.get(f"{app_in.base}/imports/{imp['id']}/report")
    lines = rep.content.decode("utf-8-sig").strip().splitlines()
    assert lines[0].startswith("row_number,outcome,reason,Name") and len(lines) == 3
    assert "Invalid email" in rep.text and "Same email or phone as row 3" in rep.text


def test_consent_requires_confirmation_and_evidence(app_in):
    imp = upload(app_in, make_csv(3))
    body = {"mapping": MAPPING, "options": {"consent": {"email": True, "sms": True, "source": "POS sign-up"}}}
    r = app_in.post(f"{app_in.base}/imports/{imp['id']}/start", json=body)
    assert r.json()["error"]["code"] == "CONSENT_NOT_CONFIRMED"
    body["options"]["consent"]["confirmed"] = True
    r = app_in.post(f"{app_in.base}/imports/{imp['id']}/start", json=body)
    assert r.json()["error"]["code"] == "WRITTEN_CONSENT_REQUIRED"
    body["options"]["consent"]["evidence"] = "Paper forms archived at HQ"
    assert app_in.post(f"{app_in.base}/imports/{imp['id']}/start", json=body).status_code == 200
    ov = app_in.get(f"{app_in.base}/audience/overview").json()
    assert ov["reachable"]["email"] == 3 and ov["reachable"]["sms"] == 3


def test_reimport_never_resubscribes(app_in):
    a = app_in
    first = upload(a, make_csv(2))
    start(a, first["id"], consent={"email": True, "confirmed": True, "source": "Form"})
    c = a.get(f"{a.base}/contacts?search=person0").json()["items"][0]
    a.post(f"{a.base}/contacts/{c['id']}/consent", json={"channel": "email", "status": "revoked"})
    second = upload(a, make_csv(2))
    done = start(a, second["id"], duplicate_handling="update",
                 consent={"email": True, "confirmed": True, "source": "Form again"})
    assert done["updated_count"] == 2
    again = a.get(f"{a.base}/contacts/{c['id']}").json()
    assert again["email_unsubscribed"] is True and again["email_consent"] is False


def test_update_mode_fills_fields_without_erasing(app_in):
    a = app_in
    first = upload(a, make_csv(1))
    start(a, first["id"])
    buf = io.StringIO()
    csv.writer(buf).writerows([["Email Address", "City", "Company"], ["person0@example.com", "", "Acme India"]])
    second = upload(a, buf.getvalue().encode())
    done = start(a, second["id"], {"Email Address": "email", "City": "city", "Company": "company"},
                 duplicate_handling="update")
    assert done["updated_count"] == 1
    c = a.get(f"{a.base}/contacts?search=person0").json()["items"][0]
    assert c["company"] == "Acme India" and c["city"] == "Hyderabad"


def test_xlsx_import_handles_numeric_phones_and_dates(app_in):
    a = app_in
    a.post(f"{a.base}/audience/attributes", json={"key": "joined", "label": "Joined", "data_type": "date"})
    wb = Workbook()
    ws = wb.active
    ws.append(["First Name", "Phone", "Joined", "Country"])
    ws.append(["Ravi", 919876500001, "31/12/2025", "India"])
    ws.append(["Emily", 14155550101, "2026-01-15", "USA"])
    out = io.BytesIO()
    wb.save(out)
    imp = upload(a, out.getvalue(), "people.xlsx")
    assert imp["file_type"] == "xlsx"
    done = start(a, imp["id"], {"First Name": "first_name", "Phone": "phone", "Joined": "attr:joined",
                                "Country": "country"})
    assert done["created_count"] == 2, done
    items = {c["first_name"]: c for c in a.get(f"{a.base}/contacts").json()["items"]}
    assert items["Ravi"]["phone"] == "+919876500001" and items["Emily"]["country"] == "US"
    ravi = a.get(f"{a.base}/contacts/{items['Ravi']['id']}").json()
    assert ravi["attributes"]["joined"] == "2025-12-31"


def test_restart_after_crash_creates_no_duplicates(app_in, monkeypatch):
    from app.services.audience import import_processor

    a = app_in
    imp = upload(a, make_csv(1200, [["Again", "person5@example.com", "", "Pune", "1"]]))
    real_chunk = import_processor._chunk
    calls = {"n": 0}

    def crashing_chunk(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("worker died")
        return real_chunk(*args, **kwargs)

    monkeypatch.setattr(import_processor, "_chunk", crashing_chunk)
    r = a.post(f"{a.base}/imports/{imp['id']}/start", json={"mapping": MAPPING, "options": {}})
    assert r.status_code == 200  # the request only queues work; the worker crash happens in the background
    partial = a.get(f"{a.base}/imports/{imp['id']}").json()
    from app.core.config import settings

    first_chunk = import_processor.SQLITE_CHUNK if settings.is_sqlite else import_processor.CHUNK
    assert partial["status"] == "processing" and partial["processed_rows"] == first_chunk

    monkeypatch.setattr(import_processor, "_chunk", real_chunk)
    assert import_processor.run_import(imp["id"]) == "completed"
    assert import_processor.run_import(imp["id"]) == "completed"  # re-delivery is a no-op
    with SessionLocal() as db:
        n_contacts = db.scalar(select(func.count()).select_from(Contact).where(Contact.application_id == a.app_id))
        n_rows = db.scalar(select(func.count()).select_from(ImportRow).where(ImportRow.import_id == imp["id"]))
        row = db.get(Import, imp["id"])
    assert n_contacts == 1200 and n_rows == 1201
    assert (row.created_count, row.duplicate_count, row.attempts) == (1200, 1, 2)


def test_cannot_restart_or_touch_other_tenants_imports(app_in, api_factory):
    imp = upload(app_in, make_csv(2))
    start(app_in, imp["id"])
    r = app_in.post(f"{app_in.base}/imports/{imp['id']}/start", json={"mapping": MAPPING, "options": {}})
    assert r.status_code == 409
    bob = api_factory().register("bob@example.com")
    org = bob.create_org("Bobco")
    bob_app = bob.create_app(org["id"], "Bob")
    assert bob.get(f"/apps/{bob_app['id']}/imports/{imp['id']}").status_code == 404
    assert bob.get(f"{app_in.base}/imports/{imp['id']}/report").status_code == 404
