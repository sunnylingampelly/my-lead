"""Sender domain authentication: SPF, DKIM, DMARC and MX checks over DNS.

* SPF: one TXT "v=spf1 ..." record at the domain that includes settings.EMAIL_SPF_INCLUDE.
* DKIM: at each selector in settings.EMAIL_DKIM_SELECTORS, a CNAME to EMAIL_DKIM_CNAME_TARGET when that is
  set, otherwise a TXT record carrying a DKIM key.
* DMARC: one TXT "v=DMARC1; ..." record at _dmarc.<domain>; its policy is shown.
* MX: warning only (replies and bounces to a domain without MX are lost).

Results are cached per domain for 10 minutes (email_domain_checks), refreshed on demand ("Check again") and
daily for every sender domain. Campaign readiness shows a warning for unauthenticated domains but never blocks
sending, so simulation mode keeps working. Free-mail domains (gmail.com etc.) cannot be authenticated by the
customer and are reported as such.
"""
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.logging import get_logger
from app.models.email import EmailDomainCheck, EmailSender
from app.utils.time import utcnow

log = get_logger(__name__)
CACHE_TTL = timedelta(minutes=10)
MIN_RECHECK = timedelta(seconds=10)  # "Check again" spam guard


class DnsLookupError(Exception):
    pass


def _resolve(name: str, rtype: str) -> list[str]:
    """Record values as text ([] when the name or record does not exist). Tests replace this function."""
    import dns.exception
    import dns.resolver

    r = dns.resolver.Resolver()
    r.timeout = r.lifetime = settings.EMAIL_DNS_TIMEOUT_SECONDS
    try:
        answer = r.resolve(name, rtype)
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
        return []
    except (dns.exception.Timeout, dns.resolver.NoNameservers, dns.resolver.YXDOMAIN) as exc:
        raise DnsLookupError(f"{rtype} lookup for {name} failed ({type(exc).__name__})") from exc
    except dns.exception.DNSException as exc:
        raise DnsLookupError(f"{rtype} lookup for {name} failed ({type(exc).__name__})") from exc
    out = []
    for rr in answer:
        if rtype == "TXT":
            out.append(b"".join(rr.strings).decode("utf-8", "replace"))
        elif rtype == "MX":
            out.append(f"{rr.preference} {rr.exchange.to_text().rstrip('.').lower()}")
        else:
            out.append(rr.to_text().rstrip(".").lower())
    return out


def _lookup(name: str, rtype: str) -> tuple[list[str], str | None]:
    try:
        return _resolve(name, rtype), None
    except DnsLookupError as exc:
        return [], str(exc)


def _record(key: str, label: str, rtype: str, host: str, status: str, expected: str | None, found: list[str],
            detail: str, required: bool = True, **extra) -> dict:
    return {"key": key, "label": label, "type": rtype, "host": host, "status": status, "expected": expected,
            "found": found, "detail": detail, "required": required, **extra}


def _spf(domain: str) -> dict:
    inc = settings.EMAIL_SPF_INCLUDE
    want = f"v=spf1 include:{inc} ~all"
    txt, err = _lookup(domain, "TXT")
    spf = [t for t in txt if t.lower().startswith("v=spf1")]
    if err:
        return _record("spf", "SPF", "TXT", domain, "error", want, [], err)
    if not spf:
        return _record("spf", "SPF", "TXT", domain, "missing", want, [],
                       "No SPF record. Add this TXT record so receivers know we may send for your domain.")
    if len(spf) > 1:
        return _record("spf", "SPF", "TXT", domain, "wrong", want, spf,
                       "A domain may have only one SPF record. Merge them into one.")
    terms = spf[0].split()
    if f"include:{inc}".lower() in (t.lower() for t in terms):
        return _record("spf", "SPF", "TXT", domain, "pass", spf[0], spf, "SPF includes our sending servers.")
    # Suggest the existing record with our include added before its "all" mechanism.
    keep = [t for t in terms if not t.lower().lstrip("+-~?").startswith("all")]
    tail = [t for t in terms if t.lower().lstrip("+-~?").startswith("all")] or ["~all"]
    fixed = " ".join(keep + [f"include:{inc}"] + tail)
    return _record("spf", "SPF", "TXT", domain, "wrong", fixed, spf,
                   f"Your SPF record does not include {inc}. Replace it with the value shown.")


def _dkim(domain: str, selector: str) -> dict:
    host = f"{selector}._domainkey.{domain}"
    label = f"DKIM ({selector})"
    target = settings.EMAIL_DKIM_CNAME_TARGET
    if target:
        want = target.format(selector=selector, domain=domain).rstrip(".").lower()
        found, err = _lookup(host, "CNAME")
        if err:
            return _record(f"dkim:{selector}", label, "CNAME", host, "error", want, [], err)
        if not found:
            return _record(f"dkim:{selector}", label, "CNAME", host, "missing", want, [],
                           "No DKIM record. Add this CNAME so your emails are signed for your domain.")
        if want in found:
            return _record(f"dkim:{selector}", label, "CNAME", host, "pass", want, found, "DKIM is set up.")
        return _record(f"dkim:{selector}", label, "CNAME", host, "wrong", want, found,
                       "This CNAME points somewhere else. Change it to the value shown.")
    found, err = _lookup(host, "TXT")
    want = "v=DKIM1; k=rsa; p=<public key from your email provider>"
    if err:
        return _record(f"dkim:{selector}", label, "TXT", host, "error", want, [], err)
    if not found:
        return _record(f"dkim:{selector}", label, "TXT", host, "missing", want, [],
                       "No DKIM key at this selector. Add the DKIM TXT record from your email provider.")
    if any("p=" in t.replace(" ", "") and not t.replace(" ", "").rstrip(";").endswith("p=") for t in found):
        return _record(f"dkim:{selector}", label, "TXT", host, "pass", found[0], found, "DKIM key found.")
    return _record(f"dkim:{selector}", label, "TXT", host, "wrong", want, found,
                   "This TXT record has no DKIM public key (p=...).")


def _dmarc(domain: str) -> dict:
    host = f"_dmarc.{domain}"
    want = f"v=DMARC1; p=none; rua=mailto:dmarc@{domain}"
    txt, err = _lookup(host, "TXT")
    found = [t for t in txt if t.replace(" ", "").lower().startswith("v=dmarc1")]
    if err:
        return _record("dmarc", "DMARC", "TXT", host, "error", want, [], err)
    if not found:
        return _record("dmarc", "DMARC", "TXT", host, "missing", want, [],
                       "No DMARC record. Gmail and Yahoo require one for bulk senders. Start with p=none.")
    if len(found) > 1:
        return _record("dmarc", "DMARC", "TXT", host, "wrong", want, found, "Only one DMARC record is allowed.")
    tags = dict(p.strip().split("=", 1) for p in found[0].split(";") if "=" in p)
    policy = (tags.get("p") or "").strip().lower() or None
    if policy not in ("none", "quarantine", "reject"):
        return _record("dmarc", "DMARC", "TXT", host, "wrong", want, found, "The DMARC record has no valid policy (p=).",
                       policy=policy)
    return _record("dmarc", "DMARC", "TXT", host, "pass", found[0], found, f"DMARC policy: {policy}.", policy=policy)


def _mx(domain: str) -> dict:
    found, err = _lookup(domain, "MX")
    if err:
        return _record("mx", "MX", "MX", domain, "error", None, [], err, required=False)
    if not found:
        return _record("mx", "MX", "MX", domain, "warn", None, [],
                       "No MX record: replies to this domain cannot be delivered. Recommended, not required.",
                       required=False)
    return _record("mx", "MX", "MX", domain, "pass", None, found, "The domain receives email.", required=False)


def _free_mail(domain: str) -> bool:
    from app.services.email.senders import FREE_MAIL

    return domain in FREE_MAIL


def run_checks(domain: str) -> tuple[str, dict]:
    records = [_spf(domain)] + [_dkim(domain, s) for s in settings.EMAIL_DKIM_SELECTORS] + [_dmarc(domain), _mx(domain)]
    required = [r for r in records if r["required"]]
    if any(r["status"] == "error" for r in required):
        status = "error"
    elif all(r["status"] == "pass" for r in required):
        status = "authenticated"
    elif any(r["status"] == "pass" for r in required):
        status = "partial"
    else:
        status = "unauthenticated"
    policy = next((r.get("policy") for r in records if r["key"] == "dmarc"), None)
    return status, {"records": records, "dmarc_policy": policy}


def check_domain(domain: str, force: bool = False) -> dict:
    """Cached result for `domain`, refreshed when older than 10 minutes (or on `force`). The cache is written in
    its own short transaction, so callers on read-only requests (readiness) still fill it."""
    from sqlalchemy.exc import IntegrityError

    from app.core.database import SessionLocal

    domain = domain.strip().lower().rstrip(".")
    if _free_mail(domain):
        return {"domain": domain, "status": "free_mail", "checked_at": None, "records": [], "dmarc_policy": None}
    if not settings.EMAIL_DNS_CHECKS_ENABLED:
        return {"domain": domain, "status": "disabled", "checked_at": None, "records": [], "dmarc_policy": None}
    with SessionLocal() as db:
        now = utcnow()
        row = db.get(EmailDomainCheck, domain)
        fresh = row is not None and now - row.checked_at < (MIN_RECHECK if force else CACHE_TTL)
        if not fresh:
            status, results = run_checks(domain)  # DNS outside any row lock
            if row is None:
                row = EmailDomainCheck(domain=domain, status=status, results=results, checked_at=now)
                db.add(row)
            else:
                row.status, row.results, row.checked_at = status, results, now
            try:
                db.commit()
            except IntegrityError:  # a concurrent check stored it first
                db.rollback()
                row = db.get(EmailDomainCheck, domain)
        return {"domain": domain, "status": row.status, "checked_at": row.checked_at.isoformat(),
                **(row.results or {})}


def sender_domain(db: Session, ctx, sender_id: str, force: bool = False) -> dict:
    from app.core.permissions import Perm
    from app.services.email.senders import _get

    ctx.require(Perm.CAMPAIGNS_READ)
    s = _get(db, ctx, sender_id)
    out = check_domain(s.from_email.split("@", 1)[1], force=force)
    return {**out, "sender_id": s.id, "spf_include": settings.EMAIL_SPF_INCLUDE}


STATUS_TEXT = {"partial": "is only partly authenticated", "unauthenticated": "is not authenticated",
               "error": "could not be checked"}


def readiness_check(db: Session, ctx, sender: EmailSender):
    """A warning (never blocking) when the sender's domain lacks SPF / DKIM / DMARC."""
    from app.schemas.email import ReadinessCheck
    from app.services.email.readiness import app_url

    domain = sender.from_email.split("@", 1)[1]
    try:
        res = check_domain(domain)
    except Exception:  # noqa: BLE001 - a DNS problem must never break readiness
        log.exception("domain_check_failed", domain=domain)
        return None
    if res["status"] in ("disabled", "free_mail"):
        return None
    ok = res["status"] == "authenticated"
    missing = [r["label"] for r in res.get("records", []) if r["required"] and r["status"] != "pass"]
    detail = None if ok else (f"{domain} {STATUS_TEXT.get(res['status'], 'is not authenticated')}"
                              + (f" ({', '.join(missing)})" if missing else "")
                              + ". Emails may land in spam. You can still send.")
    return ReadinessCheck(key="domain_auth", label="Sender domain authentication", ok=ok, warning=not ok,
                          detail=detail, action_url=None if ok else app_url(ctx, "/email/senders"),
                          action_label=None if ok else "Set up DNS",
                          meta={"domain": domain, "status": res["status"], "sender_id": sender.id})


def refresh_all() -> dict:
    """Daily: re-check every sender domain."""
    from app.core.database import SessionLocal

    if not settings.EMAIL_DNS_CHECKS_ENABLED:
        return {"checked": 0}
    with SessionLocal() as db:
        domains = sorted({e.split("@", 1)[1].lower() for e in db.scalars(select(EmailSender.from_email)) if "@" in e})
    n = 0
    for d in domains:
        if _free_mail(d):
            continue
        try:
            check_domain(d, force=True)
            n += 1
        except Exception:  # noqa: BLE001
            log.exception("domain_check_failed", domain=d)
    return {"checked": n}
