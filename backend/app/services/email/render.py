"""Safe personalisation and final rendering of campaign email.

Templates support only `{{ field }}` and `{{ field | default: "fallback" }}` against a whitelist
of contact fields and the application's custom fields. Nothing is evaluated: no expressions,
filters, loops or attribute access, so template injection is impossible. Values are
HTML-escaped in HTML bodies and kept as plain text in subjects and text bodies.
"""
import html as html_lib
import re
from dataclasses import dataclass
from typing import Any

from app.core.config import settings
from app.services.email import tokens

VAR_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|\s*default\s*:\s*(\"[^\"]*\"|'[^']*'))?\s*\}\}")
# Anything that looks like template syntax but did not match the strict grammar above.
LOOSE_RE = re.compile(r"\{\{.*?\}\}|\{%.*?%\}", re.S)
HREF_RE = re.compile(r"""(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?://[^"']+)\2""", re.I)

CORE_VARIABLES = {
    "first_name": "First name", "last_name": "Last name", "full_name": "Full name", "email": "Email",
    "phone": "Phone", "company": "Company", "city": "City", "state": "State", "country": "Country",
    "postal_code": "Postal code",
}
SYSTEM_VARIABLES = {"unsubscribe_url": "Unsubscribe link"}


@dataclass
class TemplateIssues:
    unknown: list[str]
    malformed: list[str]

    @property
    def ok(self) -> bool:
        return not self.unknown and not self.malformed


def variables_in(*parts: str | None) -> set[str]:
    return {m.group(1) for p in parts if p for m in VAR_RE.finditer(p)}


def check(parts: list[str | None], custom_keys: set[str]) -> TemplateIssues:
    allowed = set(CORE_VARIABLES) | set(SYSTEM_VARIABLES) | custom_keys
    unknown = sorted(v for v in variables_in(*parts) if v not in allowed)
    malformed = []
    for p in parts:
        if not p:
            continue
        stripped = VAR_RE.sub("", p)
        malformed += [m.group(0)[:60] for m in LOOSE_RE.finditer(stripped)]
    return TemplateIssues(unknown=unknown, malformed=sorted(set(malformed)))


def contact_values(contact: Any | None, sample: bool = False) -> dict[str, str]:
    if contact is None:
        if not sample:
            return {}
        return {"first_name": "Asha", "last_name": "Rao", "full_name": "Asha Rao", "email": "asha@example.com",
                "company": "Acme", "city": "Hyderabad", "state": "Telangana", "country": "IN"}
    vals = {k: getattr(contact, k, None) for k in CORE_VARIABLES if k != "full_name"}
    vals["full_name"] = contact.full_name
    vals.update({k: v for k, v in (contact.attributes or {}).items()})
    return {k: "" if v is None else (("Yes" if v else "No") if isinstance(v, bool) else str(v)) for k, v in vals.items()}


def substitute(template: str | None, values: dict[str, str], *, escape: bool) -> str:
    if not template:
        return ""

    def repl(m: re.Match) -> str:
        name, default = m.group(1), m.group(2)
        val = values.get(name, "")
        if not val and default is not None:
            val = default[1:-1]
        return html_lib.escape(val, quote=True) if escape else val

    return VAR_RE.sub(repl, template)


def html_to_text(html: str) -> str:
    t = re.sub(r"(?is)<(script|style|head).*?</\1>", "", html)
    t = re.sub(r"(?i)<br\s*/?>|</p>|</h[1-6]>|</tr>|</div>", "\n", t)
    t = re.sub(r"(?i)<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", r"\2 (\1)", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = html_lib.unescape(t)
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", t).strip()


def extract_links(html: str | None) -> list[str]:
    """Trackable links: absolute http(s) URLs without template variables, in first-seen order."""
    seen: list[str] = []
    for m in HREF_RE.finditer(html or ""):
        url = html_lib.unescape(m.group(3))
        if "{{" not in url and url not in seen:
            seen.append(url)
    return seen[:200]


def public_url(path: str) -> str:
    return f"{settings.BACKEND_PUBLIC_URL.rstrip('/')}{settings.API_V1_PREFIX}{path}"


def unsubscribe_url(message_id: str | None) -> str:
    if not message_id:
        return f"{settings.FRONTEND_URL}/unsubscribe?t=preview"
    return f"{settings.FRONTEND_URL}/unsubscribe?t={tokens.make('u', message_id)}"


def footer_html(business_name: str | None, address: str | None, unsub: str) -> str:
    name = html_lib.escape(business_name or "")
    addr = "<br>".join(html_lib.escape(line.strip()) for line in (address or "").splitlines() if line.strip())
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" data-sc-footer>'
        '<tr><td align="center" style="padding:24px 16px;font-family:Arial,sans-serif;font-size:12px;'
        'line-height:18px;color:#6b7280">'
        f"You are receiving this email because you opted in to hear from {name or 'us'}.<br>"
        + (f"{name}<br>" if name else "") + (f"{addr}<br>" if addr else "")
        + f'<a href="{html_lib.escape(unsub, quote=True)}" style="color:#6b7280;text-decoration:underline">'
        "Unsubscribe</a></td></tr></table>"
    )


def footer_text(business_name: str | None, address: str | None, unsub: str) -> str:
    lines = ["--", f"You are receiving this email because you opted in to hear from {business_name or 'us'}."]
    if business_name:
        lines.append(business_name)
    if address:
        lines += [line.strip() for line in address.splitlines() if line.strip()]
    lines.append(f"Unsubscribe: {unsub}")
    return "\n".join(lines)


def _inject_before_body_end(html: str, fragment: str) -> str:
    idx = html.lower().rfind("</body>")
    return html[:idx] + fragment + html[idx:] if idx != -1 else html + fragment


def _inject_after_body_start(html: str, fragment: str) -> str:
    m = re.search(r"(?i)<body[^>]*>", html)
    return html[: m.end()] + fragment + html[m.end():] if m else fragment + html


@dataclass
class Rendered:
    subject: str
    html: str
    text: str
    headers: dict[str, str]


def render(*, subject: str | None, preheader: str | None, html: str | None, text: str | None,
           values: dict[str, str], message_id: str | None, links: list[str] | None,
           business_name: str | None, business_address: str | None,
           track_opens: bool = True, track_clicks: bool = True) -> Rendered:
    unsub = unsubscribe_url(message_id)
    vals = {**values, "unsubscribe_url": unsub}
    out_subject = substitute(subject, vals, escape=False).replace("\r", " ").replace("\n", " ").strip()
    body = substitute(html, vals, escape=True) if html else ""
    plain = substitute(text, vals, escape=False) if text else (html_to_text(body) if body else "")

    if body:
        if "<html" not in body.lower():
            head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            body = f"<!doctype html><html><head>{head}</head><body>{body}</body></html>"
        if preheader:
            pre = html_lib.escape(substitute(preheader, vals, escape=False))
            body = _inject_after_body_start(body, f'<div style="display:none;max-height:0;overflow:hidden;opacity:0">{pre}</div>')
        if message_id and track_clicks and links:
            index = {u: i for i, u in enumerate(links)}
            ctoken = tokens.make("c", message_id)

            def rewrite(m: re.Match) -> str:
                url = html_lib.unescape(m.group(3))
                if url not in index or url == unsub:
                    return m.group(0)
                return f'{m.group(1)}{m.group(2)}{public_url(f"/t/c/{ctoken}/{index[url]}")}{m.group(2)}'

            body = HREF_RE.sub(rewrite, body)
        body = _inject_before_body_end(body, footer_html(business_name, business_address, unsub))
        if message_id and track_opens:
            pixel = public_url(f"/t/o/{tokens.make('o', message_id)}.gif")
            img = f'<img src="{pixel}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">'
            body = _inject_before_body_end(body, img)
    plain = (plain + "\n\n" if plain else "") + footer_text(business_name, business_address, unsub)

    headers = {}
    if message_id:
        one_click = public_url(f"/u/{tokens.make('u', message_id)}")
        headers = {"List-Unsubscribe": f"<{one_click}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"}
    return Rendered(subject=out_subject, html=body, text=plain, headers=headers)
