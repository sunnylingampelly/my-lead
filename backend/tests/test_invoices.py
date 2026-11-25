"""GST tax invoices: tax split, amounts in words, billing details (GSTIN checks), checkout amounts with GST,
invoices issued on confirmed payments only, gap-free numbering per financial year, PDFs and statements."""
import json
import threading
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.payment import Invoice
from app.providers import payments as pp
from app.services.billing import gst, invoices
from app.services.billing import wallet as wl
from tests.conftest import Api, mailbox


class FakeResp:
    def __init__(self, status: int, body: dict):
        self.status_code, self._body = status, body
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self._body


PROFILE = {"legal_name": "Chai India Pvt Ltd", "gstin": "27AAPFU0939F1ZV", "address": "12 Marine Drive\nFort",
           "city": "Mumbai", "state_code": "27", "pin_code": "400001", "email": "accounts@chai.example"}


@pytest.fixture
def seller(monkeypatch):
    monkeypatch.setattr(settings, "SELLER_LEGAL_NAME", "Signalcraft Technologies Pvt Ltd")
    monkeypatch.setattr(settings, "SELLER_GSTIN", "29AAPFU0939F1ZR")
    monkeypatch.setattr(settings, "SELLER_STATE_CODE", "29")
    monkeypatch.setattr(settings, "SELLER_ADDRESS", "1 MG Road, Bengaluru")
    monkeypatch.setattr(settings, "SELLER_PAN", "AAPFU0939F")
    monkeypatch.setattr(settings, "SELLER_LUT_NUMBER", "AD290000000000X")


@pytest.fixture
def live_inr(api_factory, monkeypatch, seller):
    """An Indian organization with Razorpay configured, in live mode (no trial credit)."""
    monkeypatch.setattr(settings, "COMMUNICATION_MODE", "live")
    for k, v in (("RAZORPAY_KEY_ID", "rzp_test"), ("RAZORPAY_KEY_SECRET", "secret"), ("RAZORPAY_WEBHOOK_SECRET", "hook")):
        monkeypatch.setattr(settings, k, v)
    sent: list[dict] = []

    def fake_post(url, json=None, auth=None, timeout=None, **kw):
        sent.append(json)
        return FakeResp(200, {"id": f"plink_{len(sent)}", "short_url": "https://rzp.io/i/abc"})

    monkeypatch.setattr(pp.httpx, "post", fake_post)
    a = api_factory().register("rupa@example.com", "Rupa")
    a.org = a.post("/organizations", json={"name": "Chai India", "country": "IN"}).json()
    a.b = f"/organizations/{a.org['id']}/billing"
    a.sent = sent
    return a


def razorpay_paid(a: Api, pid: str, link_id: str, paise: int, event_id: str):
    body = json.dumps({"event": "payment_link.paid", "created_at": 1, "payload": {
        "payment_link": {"entity": {"id": link_id, "amount_paid": paise, "currency": "INR", "notes": {"payment_id": pid}}},
        "payment": {"entity": {"id": f"pay_{event_id}", "amount": paise, "currency": "INR"}}}}).encode()
    r = Api().client.post("/api/v1/webhooks/payments/razorpay", content=body,
                          headers={"x-razorpay-signature": pp.razorpay_signature("hook", body),
                                   "x-razorpay-event-id": event_id})
    assert r.status_code == 200, r.text


# ------------------------------------------------------------------ pure rules

def test_intra_state_cgst_sgst_inter_state_igst_and_export():
    intra = gst.split(Decimal("1000"), "INR", "29", "29")
    assert (intra.treatment, intra.cgst, intra.sgst, intra.igst, intra.total) == (
        "intra_state", Decimal("90.00"), Decimal("90.00"), Decimal("0.00"), Decimal("1180.00"))
    assert intra.place_of_supply == "29-Karnataka" and intra.sgst_label == "SGST"
    inter = gst.split(Decimal("1000"), "INR", "27", "29")
    assert (inter.treatment, inter.cgst, inter.sgst, inter.igst, inter.total) == (
        "inter_state", Decimal("0.00"), Decimal("0.00"), Decimal("180.00"), Decimal("1180.00"))
    assert inter.place_of_supply == "27-Maharashtra"
    # Odd paise: each half is rounded, and the invoice total is the sum of its lines.
    odd = gst.split(Decimal("100.05"), "INR", "29", "29")
    assert odd.cgst == odd.sgst == Decimal("9.00") and odd.total == Decimal("118.05")
    ut = gst.split(Decimal("100"), "INR", "04", "04")
    assert ut.sgst_label == "UTGST"
    export = gst.split(Decimal("20"), "USD", None, "29")
    assert (export.treatment, export.tax, export.total) == ("export_lut", Decimal("0.00"), Decimal("20.00"))


def test_amount_in_words_indian_numbering():
    assert gst.amount_in_words(1180) == "Rupees One Thousand One Hundred Eighty Only"
    assert gst.indian_words(12345678) == "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight"
    assert gst.amount_in_words(Decimal("12345678")) == ("Rupees One Crore Twenty Three Lakh Forty Five Thousand "
                                                        "Six Hundred Seventy Eight Only")
    assert gst.amount_in_words("100000.50") == "Rupees One Lakh and Fifty Paise Only"
    assert gst.amount_in_words(20, "USD") == "US Dollars Twenty Only"
    assert invoices.fmt_amount(12345678.5, "INR") == "INR 1,23,45,678.50"


def test_financial_year_numbering_and_reset():
    # 31 March 23:30 IST is still 2026-27; 1 April 00:01 IST starts 2027-28 at 1 again.
    with SessionLocal() as db:
        a = gst.allocate_number(db, "invoice", datetime(2027, 3, 31, 18, 0, tzinfo=UTC))
        b = gst.allocate_number(db, "invoice", datetime(2027, 3, 31, 18, 10, tzinfo=UTC))
        c = gst.allocate_number(db, "invoice", datetime(2027, 3, 31, 18, 31, tzinfo=UTC))
        cn = gst.allocate_number(db, "credit_note", datetime(2027, 3, 31, 18, 31, tzinfo=UTC))
        db.commit()
    assert a == ("SC/26-27/000001", "2026-27", 1) and b[0] == "SC/26-27/000002"
    assert c == ("SC/27-28/000001", "2027-28", 1) and cn[0] == "SCN/27-28/000001"
    assert all(len(x[0]) <= 16 for x in (a, b, c, cn))
    # A rolled-back allocation gives its number back: no gaps.
    at = datetime(2027, 6, 1, tzinfo=UTC)
    with SessionLocal() as db:
        assert gst.allocate_number(db, "invoice", at)[2] == 2
        db.rollback()
    with SessionLocal() as db:
        assert gst.allocate_number(db, "invoice", at)[2] == 2
        db.commit()


def test_numbering_is_unique_and_gap_free_under_concurrency():
    at = datetime(2030, 5, 1, tzinfo=UTC)
    got: list[int] = []
    errors: list[Exception] = []

    def worker():
        try:
            for _ in range(8):
                with SessionLocal() as db:
                    got.append(gst.allocate_number(db, "invoice", at)[2])
                    db.commit()
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert sorted(got) == list(range(1, 33))


# ------------------------------------------------------------------ billing details

def test_billing_details_validation(live_inr):
    a = live_inr
    g = a.get(f"{a.b}/profile").json()
    assert g["profile"] is None and g["required"] is True and {"code": "29", "name": "Karnataka"} in g["states"]
    bad = a.put(f"{a.b}/profile", json={**PROFILE, "gstin": "27AAPFU0939F1ZX"})  # wrong check character
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_GSTIN"
    mismatch = a.put(f"{a.b}/profile", json={**PROFILE, "state_code": "29"})  # GSTIN registered in 27
    assert mismatch.json()["error"]["code"] == "GSTIN_STATE_MISMATCH"
    assert a.put(f"{a.b}/profile", json={**PROFILE, "pin_code": "0123"}).status_code == 422
    assert a.put(f"{a.b}/profile", json={**PROFILE, "state_code": None, "gstin": None}).status_code == 422
    ok = a.put(f"{a.b}/profile", json={**PROFILE, "gstin": " 27aapfu0939f1zv "})
    assert ok.status_code == 200 and ok.json()["gstin"] == "27AAPFU0939F1ZV" and ok.json()["state"] == "Maharashtra"
    b2c = a.put(f"{a.b}/profile", json={**PROFILE, "gstin": ""})
    assert b2c.status_code == 200 and b2c.json()["gstin"] is None


def test_billing_details_only_owners_and_admins(live_inr, api_factory):
    from tests.conftest import invite_and_join

    a = live_inr
    app = a.create_app(a.org["id"], "Chai")
    viewer = invite_and_join(a, "v@example.com", "viewer", [app["id"]])
    assert viewer.put(f"{a.b}/profile", json=PROFILE).status_code == 403
    outsider = api_factory().register("x@example.com")
    assert outsider.get(f"{a.b}/profile").status_code in (403, 404)


# ------------------------------------------------------------------ checkout and invoices

def test_inr_checkout_needs_details_and_charges_gst(live_inr):
    a = live_inr
    r = a.post(f"{a.b}/checkout", json={"amount": "1000"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "BILLING_PROFILE_REQUIRED"
    a.put(f"{a.b}/profile", json=PROFILE)  # Maharashtra buyer, Karnataka seller: IGST
    q = a.get(f"{a.b}/quote?amount=1000").json()
    assert (q["credit"], q["tax"], q["total"], q["igst"], q["treatment"]) == (1000, 180, 1180, 180, "inter_state")
    r = a.post(f"{a.b}/checkout", json={"amount": "1000"})
    assert r.status_code == 200, r.text
    assert a.sent[-1]["amount"] == 118000  # ₹1,180 in paise
    assert "GST INR 180.00" in a.sent[-1]["description"]
    p = a.get(f"{a.b}/payments/{r.json()['id']}").json()
    assert (p["amount"], p["tax_amount"], p["gross_amount"]) == (1000, 180, 1180)


def test_checkout_refused_without_platform_gst_details(live_inr, monkeypatch):
    a = live_inr
    a.put(f"{a.b}/profile", json=PROFILE)
    monkeypatch.setattr(settings, "SELLER_GSTIN", None)
    r = a.post(f"{a.b}/checkout", json={"amount": "1000"})
    assert r.json()["error"]["code"] == "TAX_NOT_CONFIGURED"


def test_confirmed_payment_issues_invoice_emails_it_and_only_the_org_downloads_it(live_inr, api_factory):
    a = live_inr
    a.put(f"{a.b}/profile", json={**PROFILE, "gstin": "29AAPFU0939F1ZR", "state_code": "29", "city": "Bengaluru",
                                  "pin_code": "560001"})  # same state as the seller: CGST + SGST
    pid = a.post(f"{a.b}/checkout", json={"amount": "1000"}).json()["id"]
    assert a.get(f"{a.b}/invoices").json()["total"] == 0  # nothing before payment is confirmed
    razorpay_paid(a, pid, "plink_1", 118000, "e1")
    p = a.get(f"{a.b}/payments/{pid}").json()
    assert p["status"] == "paid" and p["invoice_id"]
    assert a.get(a.b).json()["balance"] == 1000  # the wallet gets the amount without GST
    razorpay_paid(a, pid, "plink_1", 118000, "e2")  # replay: no second credit, no second invoice
    lst = a.get(f"{a.b}/invoices").json()
    assert lst["total"] == 1
    inv = lst["items"][0]
    fy = gst.financial_year(datetime.now(UTC))
    assert inv["number"] == f"SC/{fy[2:4]}-{fy[5:7]}/000001"
    assert (inv["taxable_value"], inv["cgst"], inv["sgst"], inv["igst"], inv["total"]) == (1000, 90, 90, 0, 1180)
    assert inv["tax_treatment"] == "intra_state" and inv["place_of_supply"] == "29-Karnataka"
    mails = mailbox("accounts@chai.example")
    assert len(mails) == 1 and inv["number"] in mails[0]["subject"]
    assert mails[0]["attachments"][0]["content_type"] == "application/pdf"
    pdf = a.client.get(f"/api/v1{a.b}/invoices/{inv['id']}.pdf", headers=a.headers)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    assert "attachment" in pdf.headers["content-disposition"]
    import io

    import pypdf

    text = pypdf.PdfReader(io.BytesIO(pdf.content)).pages[0].extract_text()
    for needle in ("TAX INVOICE", "29AAPFU0939F1ZR", "Place of supply: 29-Karnataka", "998431", "CGST @ 9%",
                   "SGST @ 9%", "INR 1,180.00", "Rupees One Thousand One Hundred Eighty Only", "razorpay:pay_e1",
                   "computer-generated invoice"):
        assert needle in text, needle
    # Deterministic: the same stored invoice gives the same bytes.
    again = a.client.get(f"/api/v1{a.b}/invoices/{inv['id']}.pdf", headers=a.headers)
    assert again.content == pdf.content
    # Another organization cannot download it, even with the id.
    other = api_factory().register("other@example.com")
    org2 = other.create_org("Other")
    r = other.client.get(f"/api/v1/organizations/{org2['id']}/billing/invoices/{inv['id']}.pdf", headers=other.headers)
    assert r.status_code == 404
    r = other.client.get(f"/api/v1{a.b}/invoices/{inv['id']}.pdf", headers=other.headers)
    assert r.status_code in (403, 404)


def test_usd_export_invoice_is_zero_rated(owner, monkeypatch, seller):
    monkeypatch.setattr(settings, "COMMUNICATION_MODE", "live")
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_x")
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", "whsec_x")
    sent = {}

    def fake_post(url, data=None, auth=None, timeout=None, headers=None, json=None):
        sent.update(data=data)
        return FakeResp(200, {"id": "cs_test_9", "url": "https://checkout.stripe.com/c/pay/cs_test_9"})

    monkeypatch.setattr(pp.httpx, "post", fake_post)
    b = f"/organizations/{owner.org['id']}/billing"
    assert owner.get(f"{b}/quote?amount=20").json()["tax"] == 0
    pid = owner.post(f"{b}/checkout", json={"amount": "20"}).json()["id"]  # no billing details needed for USD
    assert sent["data"]["line_items[0][price_data][unit_amount]"] == "2000"
    body = json.dumps({"id": "evt_9", "type": "checkout.session.completed", "data": {"object": {
        "id": "cs_test_9", "payment_status": "paid", "amount_total": 2000, "currency": "usd",
        "client_reference_id": pid, "metadata": {"payment_id": pid}, "payment_intent": "pi_9"}}}).encode()
    Api().client.post("/api/v1/webhooks/payments/stripe", content=body,
                      headers={"stripe-signature": pp.stripe_signature("whsec_x", body)})
    inv = owner.get(f"{b}/invoices").json()["items"][0]
    assert (inv["tax_treatment"], inv["tax"], inv["total"], inv["currency"]) == ("export_lut", 0, 20, "USD")
    import io

    import pypdf

    pdf = owner.client.get(f"/api/v1{b}/invoices/{inv['id']}.pdf", headers=owner.headers).content
    text = pypdf.PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
    assert "EXPORT OF SERVICES" in text and "zero-rated" in text and "AD290000000000X" in text
    assert "US Dollars Twenty Only" in text


def test_simulation_test_credit_creates_no_invoice(api_factory, seller):
    a = api_factory().register("sim@example.com")
    org = a.post("/organizations", json={"name": "Sim", "country": "IN"}).json()
    b = f"/organizations/{org['id']}/billing"
    r = a.post(f"{b}/test-credit", json={"amount": "500", "idempotency_key": "abcdefgh1"})
    assert r.status_code == 200 and r.json()["added"]
    assert a.get(f"{b}/invoices").json()["total"] == 0
    with SessionLocal() as db:
        assert db.scalar(select(Invoice.id)) is None


def test_monthly_statement_csv_and_pdf(api_factory):
    a = api_factory().register("st@example.com")
    org = a.post("/organizations", json={"name": "Stmt", "country": "IN"}).json()
    b = f"/organizations/{org['id']}/billing"
    a.get(b)
    with SessionLocal() as db:
        w = wl.get_wallet(db, org["id"])
        wl.post(db, w, "subscription", Decimal("-2999"), description="Pro plan", idempotency_key="s1")
        wl.post(db, w, "usage", Decimal("-12.5"), description="Email usage: Offer", idempotency_key="u1",
                channel="email", meta={"units": 250})
        wl.post(db, w, "usage", Decimal("-3"), description="Chatbot AI replies", idempotency_key="u2", channel="chat")
        db.commit()
    month = (datetime.now(UTC) + gst.IST).strftime("%Y-%m")
    csv = a.client.get(f"/api/v1{b}/statements/{month}.csv", headers=a.headers)
    assert csv.status_code == 200
    assert "Plan fees" in csv.text and "Email usage" in csv.text and "Chatbot AI replies" in csv.text
    assert "total,,,3014.50" in csv.text and "Not a tax invoice" in csv.text
    pdf = a.client.get(f"/api/v1{b}/statements/{month}.pdf", headers=a.headers)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    assert a.get(f"{b}/statements/2026-13.csv").status_code == 422
