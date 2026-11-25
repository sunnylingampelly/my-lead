"""Sender domain authentication with a mocked DNS resolver: pass, missing and wrong records, caching,
"Check again", campaign readiness warnings (never blocking) and free-mail domains."""
import pytest

from app.core.config import settings
from app.services.email import domains
from tests.test_billing import email_campaign, india  # noqa: F401  (fixture)

GOOD = {
    ("chai.example", "TXT"): ["v=spf1 include:amazonses.com ~all", "google-site-verification=x"],
    ("signalcraft._domainkey.chai.example", "TXT"): ["v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GN"],
    ("_dmarc.chai.example", "TXT"): ["v=DMARC1; p=quarantine; rua=mailto:d@chai.example"],
    ("chai.example", "MX"): ["10 mx.chai.example"],
}


@pytest.fixture
def app_(request):
    """The Indian organization from test_billing (verified sender hi@chai.example)."""
    return request.getfixturevalue("india")


@pytest.fixture
def dns(monkeypatch):
    monkeypatch.setattr(settings, "EMAIL_DNS_CHECKS_ENABLED", True)
    monkeypatch.setattr(settings, "EMAIL_SPF_INCLUDE", "amazonses.com")
    monkeypatch.setattr(settings, "EMAIL_DKIM_SELECTORS", ["signalcraft"])
    monkeypatch.setattr(settings, "EMAIL_DKIM_CNAME_TARGET", None)
    zone: dict = {}
    calls: list = []

    def fake(name, rtype):
        calls.append((name, rtype))
        v = zone.get((name, rtype))
        if isinstance(v, Exception):
            raise v
        return list(v or [])

    monkeypatch.setattr(domains, "_resolve", fake)
    return zone, calls


def by_key(res: dict) -> dict:
    return {r["key"]: r for r in res["records"]}


def test_domain_pass_and_cache(app_, dns):
    zone, calls = dns
    zone.update(GOOD)
    a = app_
    r = a.get(f"{a.base}/email/senders/{a.sender_id}/domain")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "authenticated" and d["domain"] == "chai.example" and d["dmarc_policy"] == "quarantine"
    recs = by_key(d)
    assert {k: v["status"] for k, v in recs.items()} == {"spf": "pass", "dkim:signalcraft": "pass", "dmarc": "pass",
                                                         "mx": "pass"}
    n = len(calls)
    a.get(f"{a.base}/email/senders/{a.sender_id}/domain")  # cached for 10 minutes: no new lookups
    assert len(calls) == n
    c = email_campaign(a)
    ready = a.get(f"{a.base}/email/campaigns/{c}/readiness").json()
    check = next(x for x in ready["checks"] if x["key"] == "domain_auth")
    assert check["ok"] is True and ready["ready"] is True


def test_domain_missing_records_warn_but_do_not_block(app_, dns):
    a = app_
    d = a.post(f"{a.base}/email/senders/{a.sender_id}/domain/check").json()
    assert d["status"] == "unauthenticated"
    recs = by_key(d)
    assert recs["spf"]["status"] == "missing" and recs["spf"]["expected"] == "v=spf1 include:amazonses.com ~all"
    assert recs["spf"]["host"] == "chai.example" and recs["spf"]["type"] == "TXT"
    assert recs["dkim:signalcraft"]["status"] == "missing"
    assert recs["dkim:signalcraft"]["host"] == "signalcraft._domainkey.chai.example"
    assert recs["dmarc"]["status"] == "missing" and recs["dmarc"]["host"] == "_dmarc.chai.example"
    assert recs["dmarc"]["expected"].startswith("v=DMARC1; p=none")
    assert recs["mx"]["status"] == "warn" and recs["mx"]["required"] is False
    c = email_campaign(a)
    ready = a.get(f"{a.base}/email/campaigns/{c}/readiness").json()
    check = next(x for x in ready["checks"] if x["key"] == "domain_auth")
    assert check["ok"] is False and check["warning"] is True and "SPF" in check["detail"]
    assert ready["ready"] is True  # a warning never blocks
    r = a.post(f"{a.base}/email/campaigns/{c}/send")
    assert r.status_code == 200, r.text


def test_domain_wrong_records(app_, dns, monkeypatch):
    zone, _ = dns
    monkeypatch.setattr(settings, "EMAIL_DKIM_CNAME_TARGET", "{selector}.dkim.signalcraft.example")
    zone.update({
        ("chai.example", "TXT"): ["v=spf1 include:_spf.google.com -all"],
        ("signalcraft._domainkey.chai.example", "CNAME"): ["somewhere.else.example"],
        ("_dmarc.chai.example", "TXT"): ["v=DMARC1; rua=mailto:x@chai.example"],
    })
    a = app_
    d = a.post(f"{a.base}/email/senders/{a.sender_id}/domain/check").json()
    recs = by_key(d)
    assert recs["spf"]["status"] == "wrong"
    assert recs["spf"]["expected"] == "v=spf1 include:_spf.google.com include:amazonses.com -all"
    assert recs["dkim:signalcraft"]["status"] == "wrong" and recs["dkim:signalcraft"]["type"] == "CNAME"
    assert recs["dkim:signalcraft"]["expected"] == "signalcraft.dkim.signalcraft.example"
    assert recs["dmarc"]["status"] == "wrong"
    assert d["status"] == "unauthenticated"
    # Fix two of three: partial. "Check again" re-reads DNS (after the short anti-spam pause).
    zone[("chai.example", "TXT")] = ["v=spf1 include:_spf.google.com include:amazonses.com -all"]
    zone[("signalcraft._domainkey.chai.example", "CNAME")] = ["signalcraft.dkim.signalcraft.example"]
    monkeypatch.setattr(domains, "MIN_RECHECK", domains.timedelta(0))
    d = a.post(f"{a.base}/email/senders/{a.sender_id}/domain/check").json()
    assert d["status"] == "partial" and by_key(d)["spf"]["status"] == "pass"


def test_dns_errors_and_free_mail(app_, dns):
    zone, _ = dns
    zone[("chai.example", "TXT")] = domains.DnsLookupError("TXT lookup for chai.example failed (Timeout)")
    a = app_
    d = a.post(f"{a.base}/email/senders/{a.sender_id}/domain/check").json()
    assert d["status"] == "error" and by_key(d)["spf"]["status"] == "error"
    assert domains.check_domain("gmail.com")["status"] == "free_mail"
