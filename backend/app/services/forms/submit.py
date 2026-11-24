"""Public form submissions: spam checks, server-side validation against the published definition, and
everything a submission does (contact upsert, consent with evidence, lists/tags/custom fields, activity,
lifecycle, CRM owner, scoring, optional deal, automation trigger, team notifications, double opt-in).

Every input here comes from the internet and is treated as hostile."""
import time
from dataclasses import dataclass, field
from datetime import date
from html import escape
from urllib.parse import urlencode, urlparse, urlsplit, urlunsplit

from sqlalchemy import select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.embed import origin_allowed
from app.core.errors import Forbidden, NotFound, RateLimited, ValidationFailed
from app.core.logging import get_logger
from app.core.permissions import Perm
from app.models import Application, ApplicationSettings, Contact, ContactList, Tag
from app.models.forms import LeadForm, LeadFormDailyStat, LeadFormSubmission
from app.services.audience import consent as consent_svc
from app.services.audience.contacts import (
    _find_conflict,
    add_tags,
    add_to_lists,
    apply_normalized,
    attr_defs,
    identity_rule,
)
from app.services.audience.normalize import check_identity, coerce_attribute, identity_keys, normalize_contact
from app.services.billing import plans
from app.services.crm.common import record_event, system_ctx
from app.services.forms import security
from app.services.forms.service import confirm_sender, members_with
from app.services.mail_templates import RenderedEmail
from app.services.notification_service import notify
from app.utils.contact_normalize import InvalidValue, normalize_email, parse_phone
from app.utils.time import utcnow

log = get_logger(__name__)
MIN_SECONDS = 2.0  # a human needs at least this long between seeing the form and submitting it
MAX_TOKEN_AGE = 7 * 86400
TEXT_LIMITS = {"first_name": 100, "last_name": 100, "text": 500, "textarea": 5000, "hidden": 500}
UTM_KEYS = ("utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content")


# ------------------------------------------------------------------ lookup and stats

def public_form(db: Session, public_id: str, *, live_only: bool = True) -> LeadForm:
    f = db.scalar(select(LeadForm).where(LeadForm.public_id == (public_id or "")[:24]))
    if f is None or f.published is None or (live_only and f.status != "published"):
        raise NotFound("This form is not available")
    return f


def bump(db: Session, form: LeadForm, column: str) -> None:
    """Add one to today's views/starts/submissions with a single upsert."""
    counts = {"views": 0, "starts": 0, "submissions": 0, column: 1}
    stmt = mysql_insert(LeadFormDailyStat).values(form_id=form.id, day=utcnow().date(),
                                                  application_id=form.application_id, **counts)
    db.execute(stmt.on_duplicate_key_update(**{column: getattr(LeadFormDailyStat, column) + 1}))


def track_event(db: Session, form: LeadForm, kind: str, ip: str) -> None:
    if security.over_limit("event_ip", f"{ip}:{form.id}"):
        return  # silently ignored: analytics pings must never error on a customer's site
    bump(db, form, "views" if kind == "view" else "starts")


# ------------------------------------------------------------------ validation

def _matches(cond: dict, values: dict) -> bool:
    v = values.get(cond["field"])
    want = (cond.get("value") or "").strip().lower()
    items = [str(x).strip().lower() for x in v] if isinstance(v, list) else \
        ([] if v in (None, "", False) else [str(v).strip().lower()])
    if isinstance(v, bool):
        items = ["true", "yes"] if v else []
    op = cond.get("op") or "equals"
    if op == "is_set":
        return bool(items)
    if op == "is_not_set":
        return not items
    if op == "equals":
        return want in items
    if op == "not_equals":
        return want not in items
    return any(want in i for i in items)  # contains


def visible_ids(defn: dict, values: dict) -> set[str]:
    """Fields shown for these answers. A field whose controlling field is hidden is hidden too."""
    by_id = {f["id"]: f for f in defn["fields"]}
    memo: dict[str, bool] = {}

    def vis(fid: str, depth: int = 0) -> bool:
        if fid in memo:
            return memo[fid]
        f = by_id[fid]
        c = f.get("condition")
        ok = True
        if c and c.get("field") in by_id and depth < 20:
            ok = vis(c["field"], depth + 1) and _matches(c, values)
        memo[fid] = ok
        return ok

    return {fid for fid in by_id if vis(fid)}


def _hidden_value(f: dict, raw, meta: dict) -> str | None:
    src = f.get("hidden") or {"kind": "fixed", "value": f.get("default") or ""}
    kind = src.get("kind")
    if kind == "fixed":
        return (src.get("value") or f.get("default") or "")[:500] or None
    if kind == "page_url":
        return (meta.get("page_url") or "")[:500] or None
    if kind == "referrer":
        return (meta.get("referrer") or "")[:500] or None
    if kind in UTM_KEYS:
        return str(meta.get("utm", {}).get(kind) or "")[:200] or None
    return (str(raw).strip()[:500] if isinstance(raw, (str, int, float)) else "") or None  # url_param


def validate(defn: dict, raw: dict, meta: dict, default_country: str | None,
             defs: dict) -> tuple[dict, dict, dict[str, str]]:
    """Returns (values by field id, phone countries by field id, errors by field id)."""
    raw = raw if isinstance(raw, dict) else {}
    # Conditions are evaluated on the submitted answers (trimmed strings/lists only).
    shown = visible_ids(defn, {k: v for k, v in raw.items() if isinstance(v, (str, list, bool))})
    out, phones, errors = {}, {}, {}
    for f in defn["fields"]:
        fid, t = f["id"], f["type"]
        if fid not in shown:
            continue
        v = raw.get(fid)
        if t == "hidden":
            hv = _hidden_value(f, v, meta)
            if hv:
                out[fid] = hv
            continue
        empty = v is None or v == "" or v == [] or v is False or (isinstance(v, dict) and not v.get("number"))
        if empty:
            if f.get("required"):
                errors[fid] = "Please tick this box to continue" if t == "consent" else "This field is required"
            continue
        try:
            out[fid] = _coerce(f, v, default_country, phones)
        except InvalidValue as exc:
            errors[fid] = str(exc)
            continue
        m = f.get("map_to") or {}
        if m.get("kind") == "custom" and m.get("key") in defs:
            try:
                coerce_attribute(defs[m["key"]], out[fid] if not isinstance(out[fid], list) else ", ".join(out[fid]),
                                 default_country)
            except InvalidValue as exc:
                errors[fid] = str(exc).split(": ", 1)[-1]
    return out, phones, errors


def _coerce(f: dict, v, default_country: str | None, phones: dict):
    t = f["type"]
    opts = [o["value"] for o in f.get("options") or []]
    if t == "consent":
        if v not in (True, "true", "on", "yes", "1", 1):
            raise InvalidValue("Invalid value")
        return True
    if t == "checkboxes":
        items = v if isinstance(v, list) else [v]
        items = [str(x) for x in items if isinstance(x, (str, int, float))][:100]
        bad = [x for x in items if x not in opts]
        if bad:
            raise InvalidValue("Choose from the listed options")
        return items
    if isinstance(v, (dict, list)) and t != "phone":
        raise InvalidValue("Invalid value")
    if t == "phone":
        country, number = None, v
        if isinstance(v, dict):
            country = str(v.get("country") or "")[:2].upper() or None
            number = v.get("number")
        number = str(number or "").strip()[:40]
        try:
            p = parse_phone(number, country or f.get("default_country") or default_country)
        except InvalidValue as exc:
            raise InvalidValue("Enter a valid phone number for the selected country") from exc
        if p is None:
            raise InvalidValue("Enter a valid phone number")
        phones[f["id"]] = p.country
        return p.e164
    s = str(v).strip()
    if t == "email":
        try:
            e = normalize_email(s[:320])
        except InvalidValue as exc:
            raise InvalidValue("Enter a valid email address") from exc
        return e
    if t in ("select", "radio"):
        if s not in opts:
            raise InvalidValue("Choose one of the listed options")
        return s
    if t == "number":
        try:
            n = float(s.replace(",", ""))
        except ValueError as exc:
            raise InvalidValue("Enter a number") from exc
        if n != n or n in (float("inf"), float("-inf")):
            raise InvalidValue("Enter a number")
        if f.get("min") is not None and n < f["min"]:
            raise InvalidValue(f"Must be at least {f['min']:g}")
        if f.get("max") is not None and n > f["max"]:
            raise InvalidValue(f"Must be at most {f['max']:g}")
        return int(n) if n.is_integer() else n
    if t == "date":
        try:
            return date.fromisoformat(s[:10]).isoformat()
        except ValueError as exc:
            raise InvalidValue("Enter a valid date") from exc
    limit = min(f.get("max_length") or 5000, TEXT_LIMITS.get(t, 500))
    if len(s) > limit:
        raise InvalidValue(f"Keep this under {limit} characters")
    return s


# ------------------------------------------------------------------ submission

@dataclass
class Outcome:
    response: dict
    emails: list = field(default_factory=list)  # (kind, to, name, RenderedEmail) system emails
    confirm: tuple | None = None  # (submission_id) needing a double opt-in email


def _clean_url(u: str | None) -> str | None:
    u = (u or "").strip()
    if not u:
        return None
    try:
        p = urlparse(u)
    except ValueError:
        return None
    return u[:1000] if p.scheme in ("http", "https") and p.netloc else None


def _clean_utm(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    return {k: str(raw[k]).strip()[:200] for k in UTM_KEYS if isinstance(raw.get(k), (str, int)) and str(raw[k]).strip()}


def success_response(form: LeadForm, defn: dict, values: dict, status: str) -> dict:
    s = defn["success"]
    redirect = None
    if s["mode"] in ("redirect", "both") and s.get("redirect_url"):
        redirect = s["redirect_url"]
        if s.get("pass_values"):
            params = {k: (", ".join(v) if isinstance(v, list) else str(v))[:200]
                      for k, v in list(values.items())[:20] if not isinstance(v, bool)}
            parts = urlsplit(redirect)
            q = (parts.query + "&" if parts.query else "") + urlencode(params)
            redirect = urlunsplit((parts.scheme, parts.netloc, parts.path, q, parts.fragment))
    return {"ok": True, "status": "pending_confirmation" if status == "pending_confirmation" else "received",
            "mode": s["mode"], "message_html": s["message_html"] if s["mode"] != "redirect" else None,
            "redirect_url": redirect, "redirect_delay": s.get("redirect_delay", 3) if s["mode"] == "both" else 0,
            "pending_confirmation": status == "pending_confirmation"}


def submit(db: Session, form: LeadForm, body, *, ip: str, origin: str | None, user_agent: str | None,
           country: str | None) -> Outcome:
    defn = form.published
    st = defn["settings"]
    if security.over_limit("submit_ip", f"{ip}:{form.id}") or security.over_limit("submit_form", form.id):
        raise RateLimited("Too many submissions. Please wait a few minutes and try again.")
    page_url, referrer = _clean_url(body.page_url), _clean_url(body.referrer)
    domains = st.get("allowed_domains") or []
    if origin and not origin_allowed(origin, domains):
        raise Forbidden("This form can't be used on this website", code="ORIGIN_NOT_ALLOWED")
    if domains and page_url and not origin_allowed(page_url, domains):
        raise Forbidden("This form can't be used on this website", code="ORIGIN_NOT_ALLOWED")

    existing = db.scalar(select(LeadFormSubmission).where(LeadFormSubmission.form_id == form.id,
                                                          LeadFormSubmission.client_id == body.client_id))
    if existing is not None:  # a retry: same answer, nothing created twice
        return Outcome(success_response(form, defn, existing.values or {}, existing.status))

    meta = {"page_url": page_url, "referrer": referrer, "utm": _clean_utm(body.utm)}
    sub = LeadFormSubmission(organization_id=form.organization_id, application_id=form.application_id,
                             form_id=form.id, form_version=form.published_version or 0, client_id=body.client_id,
                             values={}, page_url=page_url, referrer=referrer, utm=meta["utm"],
                             ip_hash=security.ip_hash(ip), country=(country or "")[:2].upper() or None,
                             user_agent=(user_agent or "")[:400] or None, status="new")

    if body.hp.strip():
        sub.status, sub.spam_reason = "spam", "honeypot"
        _store(db, sub)
        return Outcome(success_response(form, defn, {}, "new"))  # bots see success and learn nothing
    shown_at = security.rendered_at(form.public_id, body.render_token)
    now = time.time()
    if shown_at is None:
        raise ValidationFailed("This form has expired. Reload the page and try again.", code="INVALID_TOKEN")
    if now - shown_at < MIN_SECONDS:
        raise ValidationFailed("That was quick! Please take a moment and submit again.", code="TOO_FAST")
    if now - shown_at > MAX_TOKEN_AGE:
        raise ValidationFailed("This form has expired. Reload the page and try again.", code="INVALID_TOKEN")
    if st.get("turnstile") and security.turnstile_available() and \
            not security.verify_turnstile(body.turnstile_token, ip):
        raise ValidationFailed("Please complete the verification and try again.", code="TURNSTILE_FAILED")

    app = db.get(Application, form.application_id)
    ctx = system_ctx(db, form.organization_id, form.application_id)
    defs = attr_defs(db, ctx)
    values, phone_countries, errors = validate(defn, body.values, meta, app.default_country if app else None, defs)
    if errors:
        raise ValidationFailed("Please check the highlighted fields.", code="INVALID_FIELDS",
                               details={"fields": errors})
    sub.values = values
    if not _store(db, sub):  # lost a race with a concurrent retry of the same client id
        again = db.scalar(select(LeadFormSubmission).where(LeadFormSubmission.form_id == form.id,
                                                           LeadFormSubmission.client_id == body.client_id))
        return Outcome(success_response(form, defn, again.values if again else values, again.status if again else "new"))
    bump(db, form, "submissions")
    form.last_submission_at = utcnow()
    out = Outcome(success_response(form, defn, values, "new"))
    contact = _apply_to_contact(db, ctx, form, defn, sub, values, phone_countries, defs, ip, out)
    out.response = success_response(form, defn, values, sub.status)
    _notify_team(db, form, defn, sub, contact, out)
    return out


def _store(db: Session, sub: LeadFormSubmission) -> bool:
    try:
        with db.begin_nested():
            db.add(sub)
            db.flush()
        return True
    except IntegrityError:
        return False


# ------------------------------------------------------------------ the contact side

def _contact_input(defn: dict, values: dict, phone_countries: dict) -> tuple[dict, list[str], str | None]:
    """(normalize_contact raw input, tag names, phone country hint) from mapped fields."""
    raw: dict = {"attributes": {}}
    tags: list[str] = []
    hint = None
    for f in defn["fields"]:
        if f["id"] not in values:
            continue
        v = values[f["id"]]
        m = f.get("map_to") or {}
        kind, key = m.get("kind"), m.get("key")
        if kind == "standard" and key:
            raw[key] = ", ".join(v) if isinstance(v, list) else v
            if f["type"] == "phone" and key == "phone":
                hint = phone_countries.get(f["id"])
        elif kind == "custom" and key:
            raw["attributes"][key] = ", ".join(v) if isinstance(v, list) else v
        elif kind == "tag":
            tags += [str(x) for x in (v if isinstance(v, list) else [v]) if not isinstance(x, bool)]
    return raw, [t.strip()[:60] for t in tags if str(t).strip()], hint


def _tag_ids(db: Session, ctx, names: list[str], ids: list[str]) -> list[str]:
    out = list(db.scalars(select(Tag.id).where(Tag.application_id == ctx.application_id, Tag.id.in_(ids)))) \
        if ids else []
    for name in dict.fromkeys(names):
        t = db.scalar(select(Tag).where(Tag.application_id == ctx.application_id, Tag.name == name))
        if t is None:
            t = Tag(organization_id=ctx.organization_id, application_id=ctx.application_id, name=name)
            try:
                with db.begin_nested():
                    db.add(t)
                    db.flush()
            except IntegrityError:
                t = db.scalar(select(Tag).where(Tag.application_id == ctx.application_id, Tag.name == name))
        if t is not None and t.id not in out:
            out.append(t.id)
    return out


def _apply_to_contact(db: Session, ctx, form: LeadForm, defn: dict, sub: LeadFormSubmission, values: dict,
                      phone_countries: dict, defs: dict, ip: str, out: Outcome) -> Contact | None:
    st = defn["settings"]
    source = (st.get("source") or form.name)[:60]
    raw, tag_names, hint = _contact_input(defn, values, phone_countries)
    raw["source"] = source
    try:
        n = normalize_contact(raw, default_country=ctx.application.default_country, attr_defs=defs,
                              phone_country_hint=hint, strict_attributes=False)
    except InvalidValue as exc:
        log.info("form_contact_normalize_failed", form_id=form.id, error=str(exc)[:120])
        return None
    rule = identity_rule(db, ctx)
    phone = n.phone.e164 if n.phone else None
    try:
        check_identity(rule, n.email, phone)
    except InvalidValue:
        return None  # stored as a submission only: nothing identifies a contact
    email_key, phone_key = identity_keys(rule, n.email, phone)
    c = _find_conflict(db, ctx, email_key, phone_key)
    created = False
    if c is not None:
        if st.get("duplicate", "update") == "update":
            n.provided.discard("source")
            # Never take an identifier another contact already uses.
            for attr, key in (("email", email_key), ("phone", phone_key)):
                if key and _find_conflict(db, ctx, key if attr == "email" else None,
                                          key if attr == "phone" else None, exclude_id=c.id):
                    n.provided.discard(attr)
            if c.email and n.email and n.email != c.email:
                n.provided.discard("email")  # an existing address is not replaced from a public form
            apply_normalized(c, n, rule, only_provided=True, keep_existing=True)
    else:
        if plans.limit(db, ctx.organization_id, "contacts") is not None and \
                plans.count_usage(db, ctx.organization_id, "contacts") >= plans.limit(db, ctx.organization_id,
                                                                                      "contacts"):
            log.warning("form_contact_limit_reached", form_id=form.id)
            return None
        c = Contact(organization_id=ctx.organization_id, application_id=ctx.application_id, source=source,
                    attributes={})
        apply_normalized(c, n, rule, only_provided=False)
        c.source = source
        try:
            with db.begin_nested():
                db.add(c)
                db.flush()
            created = True
        except IntegrityError:
            c = _find_conflict(db, ctx, email_key, phone_key)
            if c is None:
                return None
    sub.contact_id = c.id
    now = utcnow()
    c.last_activity_at = now
    if created:
        consent_svc.record_activity(db, ctx, c.id, "created", f"Contact created from form {form.name}"[:255],
                                    {"source": source, "form_id": form.id})
        from app.services.crm.companies import relink_contact

        relink_contact(db, c, company_changed=bool(c.company), email_changed=bool(c.email))
    consent_svc.record_activity(db, ctx, c.id, "form_submitted", f"Submitted form {form.name}"[:255],
                                {"form_id": form.id, "submission_id": sub.id, "page_url": sub.page_url})
    # Lists and tags.
    list_ids = list(db.scalars(select(ContactList.id).where(ContactList.application_id == ctx.application_id,
                                                            ContactList.id.in_(st.get("list_ids") or [])))) \
        if st.get("list_ids") else []
    add_to_lists(db, ctx, [c.id], list_ids)
    add_tags(db, ctx, [c.id], _tag_ids(db, ctx, tag_names, st.get("tag_ids") or []))
    # Consent, with evidence.
    channels = list(st.get("subscribe_on_submit") or [])
    wording = [st.get("consent_text") or ""] if channels else []
    for f in defn["fields"]:
        if f["type"] == "consent" and values.get(f["id"]) is True:
            channels += f.get("consent_channels") or ["email"]
            wording.append(f.get("label") or "")
    channels = list(dict.fromkeys(channels))
    double = bool(st.get("double_opt_in")) and "email" in channels and bool(c.email)
    evidence = (f"Wording: {' / '.join(w for w in wording if w) or 'Submitted the form'} | "
                f"Page: {sub.page_url or 'hosted form'} | Submitted {now.isoformat(timespec='seconds')} UTC")[:2000]
    for ch in channels:
        if ch == "email" and double:
            continue
        try:
            consent_svc.grant(db, ctx, c, ch, method="form", source=f"Form: {form.name}"[:255], evidence=evidence,
                              ip=ip[:64] if ip else None)
        except ValidationFailed:
            log.info("form_consent_not_granted", form_id=form.id, channel=ch)
    # CRM: lifecycle, owner, deal.
    if st.get("set_lifecycle_lead", True) and c.lifecycle_stage in (None, "", "subscriber", "other"):
        c.lifecycle_stage = "lead"
    if st.get("assign_owner", True):
        from app.services.crm import leads as crm_leads

        crm_leads.assign_contact_now(db, c)
    if st.get("create_deal"):
        _create_deal(db, ctx, form, st, c, sub, source)
    if double:
        sub.status = "pending_confirmation"
        out.confirm = (sub.id,)
    else:
        fire_trigger(db, form, sub)
    _rescore(db, c)
    return c


def _create_deal(db: Session, ctx, form: LeadForm, st: dict, c: Contact, sub: LeadFormSubmission,
                 source: str) -> None:
    from app.schemas.crm import DealCreate
    from app.services.crm import deals

    name = c.full_name or c.email or c.phone or "New lead"
    title = (st.get("deal_title") or "{name} – {form}").replace("{name}", name).replace("{form}", form.name) \
        .replace("{email}", c.email or "")[:200] or name[:200]
    try:
        with db.begin_nested():
            d = deals.create_deal(db, ctx, DealCreate(title=title, pipeline_id=st.get("deal_pipeline_id") or None,
                                                      stage_id=st.get("deal_stage_id") or None, contact_id=c.id,
                                                      source=source))
        sub.deal_id = d.id
    except Exception:  # noqa: BLE001 - a deal problem must not lose the lead
        log.exception("form_deal_failed", form_id=form.id)


def _rescore(db: Session, c: Contact) -> None:
    from app.models import ScoringRule
    from app.services.crm import leads as crm_leads
    from app.services.crm.common import settings_for

    rules = list(db.scalars(select(ScoringRule).where(ScoringRule.application_id == c.application_id,
                                                      ScoringRule.active.is_(True))))
    if rules:
        db.flush()
        crm_leads.score_contacts(db, settings_for(db, c.organization_id, c.application_id), [c], rules)


def fire_trigger(db: Session, form: LeadForm, sub: LeadFormSubmission) -> None:
    if sub.contact_id:
        record_event(db, form.organization_id, form.application_id, "form_submitted", contact_id=sub.contact_id,
                     data={"form_id": form.id, "submission_id": sub.id})


# ------------------------------------------------------------------ notifications and emails

def _value_text(v) -> str:
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    if isinstance(v, bool):
        return "Yes" if v else "No"
    return str(v)


def _notify_team(db: Session, form: LeadForm, defn: dict, sub: LeadFormSubmission, contact: Contact | None,
                 out: Outcome) -> None:
    st = defn["settings"]
    ids = st.get("notify_user_ids") or []
    if not ids or not (st.get("notify_email") or st.get("notify_in_app")):
        return
    members = members_with(db, form.organization_id, form.application_id, Perm.FORMS_READ)
    who = (contact.full_name or contact.email or contact.phone) if contact else None
    title = f"New submission: {form.name}" + (f" from {who}" if who else "")
    link = f"/apps/{form.application_id}/forms/{form.id}?tab=submissions"
    labels = {f["id"]: f.get("label") or f["id"] for f in defn["fields"]}
    for uid in ids:
        u = members.get(uid)
        if u is None:
            continue
        if st.get("notify_in_app", True):
            notify(db, uid, type_="form_submission", title=title[:160], link=link, level="success",
                   organization_id=form.organization_id, application_id=form.application_id)
        if st.get("notify_email", True) and u.email:
            out.emails.append(("form_submission", u.email, u.full_name, submission_email(form, labels, sub, link)))


def submission_email(form: LeadForm, labels: dict, sub: LeadFormSubmission, link: str) -> RenderedEmail:
    from app.services.mail_templates import _layout

    rows = "".join(f'<tr><td style="padding:4px 12px 4px 0;color:#64748b;vertical-align:top">{escape(labels.get(k, k))}'
                   f'</td><td style="padding:4px 0">{escape(_value_text(v))[:2000]}</td></tr>'
                   for k, v in (sub.values or {}).items())
    url = f"{settings.FRONTEND_URL.rstrip('/')}{link}"
    page = f"<p style='font-size:13px;color:#64748b'>Page: {escape(sub.page_url)}</p>" if sub.page_url else ""
    text = "\n".join(f"{labels.get(k, k)}: {_value_text(v)}" for k, v in (sub.values or {}).items())
    return RenderedEmail(
        subject=f"New submission: {form.name}"[:200],
        html=_layout(f"New submission: {form.name}", f'<table role="presentation">{rows}</table>{page}',
                     "View submission", url, "You get this email because you're notified about this form."),
        text=f"New submission for {form.name}\n\n{text}\n\nView: {url}")


def send_confirmation(db: Session, submission_id: str) -> bool:
    """Double opt-in: email the contact a signed, expiring confirmation link from the app's verified sender."""
    from app.providers.email.base import OutboundEmail
    from app.services.email.engine import provider_for

    sub = db.get(LeadFormSubmission, submission_id)
    form = db.get(LeadForm, sub.form_id) if sub else None
    contact = db.get(Contact, sub.contact_id) if sub and sub.contact_id else None
    if not (sub and form and contact and contact.email and form.published):
        return False
    st = form.published["settings"]
    sender = confirm_sender(db, form.application_id, st.get("confirm_sender_id"))
    if sender is None:
        log.warning("form_confirm_no_sender", form_id=form.id)
        return False
    url = f"{settings.BACKEND_PUBLIC_URL.rstrip('/')}/embed/forms/confirm?token={security.confirm_token(sub.id)}"
    from app.services.mail_templates import _layout

    name = contact.first_name or "there"
    html = _layout(st.get("confirm_subject") or "Please confirm your subscription",
                   f"<p>Hi {escape(name)}, please confirm that you want to hear from "
                   f"<strong>{escape(sender.from_name)}</strong>.</p>",
                   "Yes, confirm my subscription", url,
                   f"This link expires in {security.CONFIRM_TTL_DAYS} days. If you didn't sign up, ignore this email.")
    provider, _ = provider_for(db.get(ApplicationSettings, form.application_id))
    try:
        res = provider.send(OutboundEmail(
            to_email=contact.email, to_name=contact.full_name or None,
            subject=(st.get("confirm_subject") or "Please confirm your subscription")[:200], html=html,
            text=f"Hi {name},\n\nConfirm your subscription: {url}\n\nIf you didn't sign up, ignore this email.",
            from_email=sender.from_email, from_name=sender.from_name, reply_to=sender.reply_to,
            tags=("form_confirmation",), idempotency_key=f"form-confirm-{sub.id}"))
        return res.accepted
    except Exception:  # noqa: BLE001
        log.exception("form_confirm_send_failed", form_id=form.id)
        return False


def confirm(db: Session, token: str) -> tuple[str, LeadForm | None]:
    """'confirmed' | 'already' | 'expired' | 'invalid'."""
    sid, expired = security.read_confirm_token(token)
    sub = db.get(LeadFormSubmission, sid) if sid else None
    form = db.get(LeadForm, sub.form_id) if sub else None
    if sub is None or form is None:
        return "invalid", None
    if sub.status == "confirmed":
        return "already", form
    if expired:
        return "expired", form
    if sub.status != "pending_confirmation":
        return "invalid", form
    contact = db.get(Contact, sub.contact_id) if sub.contact_id else None
    sub.status, sub.confirmed_at = "confirmed", utcnow()
    if contact is not None:
        ctx = system_ctx(db, form.organization_id, form.application_id)
        consent_svc.grant(db, ctx, contact, "email", method="form_double_opt_in", source=f"Form: {form.name}"[:255],
                          evidence=f"Confirmed by email link (double opt-in) at {sub.confirmed_at.isoformat()} UTC; "
                                   f"form submitted from {sub.page_url or 'hosted form'}")
        consent_svc.record_activity(db, ctx, contact.id, "form_confirmed",
                                    f"Confirmed subscription from form {form.name}"[:255],
                                    {"form_id": form.id, "submission_id": sub.id})
        fire_trigger(db, form, sub)
    return "confirmed", form


