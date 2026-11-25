"""Server-rendered HTML for the embed iframe and the hosted form page.

Plain HTML plus one small vanilla script (static/forms/form.js); no framework. Every value from a
definition is HTML-escaped; the only markup that passes through is the thank-you message, which was
sanitised by an allowlist when saved. Config for the script is JSON in a non-executable script tag with
<, > and & escaped so it can never close the tag."""
import hashlib
import json
from functools import lru_cache
from html import escape
from pathlib import Path
from urllib.parse import quote

from app.core.config import settings
from app.core.embed import frame_ancestors
from app.schemas.forms import FONTS
from app.services.forms.security import render_token, sanitize_html, turnstile_available

STATIC = Path(__file__).resolve().parents[2] / "static" / "forms"
AUTOCOMPLETE = {"first_name": "given-name", "last_name": "family-name", "email": "email", "phone": "tel-national"}
INPUT_TYPES = {"first_name": "text", "last_name": "text", "email": "email", "text": "text", "number": "number",
               "date": "date"}


@lru_cache(maxsize=8)
def asset(name: str) -> tuple[str, str]:
    """(content, short content hash) of a static embed asset."""
    text = (STATIC / name).read_text(encoding="utf-8")
    return text, hashlib.sha256(text.encode()).hexdigest()[:10]


def e(v) -> str:
    return escape(str(v or ""), quote=True)


def json_for_script(data) -> str:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False).replace("<", "\\u003c") \
        .replace(">", "\\u003e").replace("&", "\\u0026").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def csp(domains: list[str] | None) -> str:
    return (f"{frame_ancestors(domains)}; default-src 'none'; script-src 'self' https://challenges.cloudflare.com; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; "
            "img-src 'self' data:; connect-src 'self'; frame-src https://challenges.cloudflare.com; "
            "form-action 'self'; base-uri 'none'")


def _font_link(font: str) -> str:
    if font not in FONTS or font == "system":
        return ""
    fam = quote(font).replace("%20", "+")
    return (f'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
            f'<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family={fam}:wght@400;500;600;700'
            f'&amp;display=swap">')


def _safe_family(v: str | None) -> str | None:
    """A CSS font-family list passed by the loader ("use my website's font"): letters, digits, spaces,
    commas, quotes and dashes only, so it can't break out of the declaration."""
    v = (v or "").strip()[:200]
    if not v or any(not (c.isalnum() or c in " ,'\"-_") for c in v):
        return None
    return v


def _style(d: dict, site_font: str | None) -> str:
    dark = d["theme"] == "dark"
    bg = d["background_color"] if not (dark and d["background_color"].lower() == "#ffffff") else "#0f172a"
    text = d["text_color"] if not (dark and d["text_color"].lower() == "#0f172a") else "#f1f5f9"
    font = site_font if (d.get("use_site_font") and site_font) else (
        "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" if d["font"] == "system"
        else f"'{d['font']}', system-ui, sans-serif")
    return (f":root{{--sc-primary:{d['primary_color']};--sc-bg:{bg};--sc-text:{text};--sc-radius:{int(d['radius'])}px;"
            f"--sc-btn:{d['button_color']};--sc-btn-text:{d['button_text_color']};--sc-font:{font};"
            f"--sc-maxw:{int(d['max_width'])}px}}")


def _options_html(f: dict, kind: str) -> str:
    fid, out = f["id"], []
    for i, o in enumerate(f.get("options") or []):
        checked = " checked" if f.get("default") and o["value"] == f["default"] else ""
        out.append(f'<label class="sc-choice" for="f_{e(fid)}_{i}"><input type="{kind}" id="f_{e(fid)}_{i}" '
                   f'name="{e(fid)}" value="{e(o["value"])}"{checked}><span>{e(o["label"])}</span></label>')
    return "".join(out)


def _field_html(f: dict, countries: list[dict], default_country: str | None) -> str:
    fid, t = f["id"], f["type"]
    if t == "hidden":
        return f'<input type="hidden" name="{e(fid)}" id="f_{e(fid)}" value="{e(f.get("default"))}">'
    req = bool(f.get("required"))
    star = '<span class="sc-req" aria-hidden="true"> *</span>' if req else ""
    described = f'e_{e(fid)}' + (f' h_{e(fid)}' if f.get("help") else "")
    # dir="auto": Arabic (and other right-to-left) text typed or configured renders right to left.
    common = (f'id="f_{e(fid)}" name="{e(fid)}" aria-describedby="{described}" dir="auto"'
              + (' required aria-required="true"' if req else ""))
    ph = f' placeholder="{e(f.get("placeholder"))}"' if f.get("placeholder") else ""
    help_ = f'<p class="sc-help" id="h_{e(fid)}" dir="auto">{e(f["help"])}</p>' if f.get("help") else ""
    err = f'<p class="sc-error" id="e_{e(fid)}"></p>'
    cls = f'sc-field sc-w-{e(f.get("width") or "full")} sc-t-{e(t)}'
    attrs = f'class="{cls}" data-field="{e(fid)}" data-step="{int(f.get("step") or 0)}" dir="auto"'
    label = f'<label class="sc-label" for="f_{e(fid)}" dir="auto">{e(f.get("label"))}{star}</label>'
    if t in ("radio", "checkboxes"):
        kind = "radio" if t == "radio" else "checkbox"
        return (f'<fieldset {attrs} aria-describedby="{described}"'
                + (' aria-required="true"' if req else "") + f'><legend class="sc-label">{e(f.get("label"))}{star}'
                f'</legend><div class="sc-choices">{_options_html(f, kind)}</div>{help_}{err}</fieldset>')
    if t == "consent":
        link = (f' <a href="{e(f["privacy_url"])}" target="_blank" rel="noopener noreferrer">Privacy policy</a>'
                if f.get("privacy_url") else "")
        return (f'<div {attrs}><div class="sc-consent"><input type="checkbox" value="true" {common}>'
                f'<label for="f_{e(fid)}">{e(f.get("label"))}{star}</label></div>'
                f'<p class="sc-consent-link">{link}</p>{help_}{err}</div>' if link else
                f'<div {attrs}><div class="sc-consent"><input type="checkbox" value="true" {common}>'
                f'<label for="f_{e(fid)}">{e(f.get("label"))}{star}</label></div>{help_}{err}</div>')
    if t == "textarea":
        ml = f' maxlength="{int(f.get("max_length") or 5000)}"'
        control = f'<textarea rows="4" {common}{ph}{ml}>{e(f.get("default"))}</textarea>'
    elif t == "select":
        opts = "".join(f'<option value="{e(o["value"])}"' + (" selected" if o["value"] == f.get("default") else "")
                       + f'>{e(o["label"])}</option>' for o in f.get("options") or [])
        control = (f'<select {common}><option value="">{e(f.get("placeholder") or "Select…")}</option>'
                   f'{opts}</select>')
    elif t == "phone":
        cc = (f.get("default_country") or default_country or "US").upper()
        opts = "".join(f'<option value="{e(c["code"])}"' + (" selected" if c["code"] == cc else "")
                       + f'>{e(c["name"])} ({e(c["dial"])})</option>' for c in countries)
        control = (f'<div class="sc-phone"><select class="sc-cc" id="c_{e(fid)}" aria-label="Country code" '
                   f'data-cc-for="{e(fid)}">{opts}</select><input type="tel" inputmode="tel" autocomplete="tel-national"'
                   f' {common}{ph} value="{e(f.get("default"))}" maxlength="30"></div>')
    else:
        typ = INPUT_TYPES.get(t, "text")
        extra = ""
        if t == "number":
            extra += ' step="any" inputmode="decimal"'
            if f.get("min") is not None:
                extra += f' min="{f["min"]:g}"'
            if f.get("max") is not None:
                extra += f' max="{f["max"]:g}"'
        if t in ("text", "first_name", "last_name"):
            extra += f' maxlength="{int(min(f.get("max_length") or 500, 500))}"'
        if t in AUTOCOMPLETE:
            extra += f' autocomplete="{AUTOCOMPLETE[t]}"'
        control = f'<input type="{typ}" {common}{ph}{extra} value="{e(f.get("default"))}">'
    return f'<div {attrs}>{label}<div class="sc-control">{control}</div>{help_}{err}</div>'


def form_html(form, *, hosted: bool, branding: bool, countries: list[dict], default_country: str | None,
              site_font: str | None = None, iid: str = "", mode: str = "inline") -> str:
    d = form.published
    des, st = d["design"], d["settings"]
    steps = d["steps"]
    fields_by_step: dict[int, list[str]] = {}
    hidden = []
    for f in d["fields"]:
        html = _field_html(f, countries, default_country)
        if f["type"] == "hidden":
            hidden.append(html)
        else:
            fields_by_step.setdefault(min(int(f.get("step") or 0), len(steps) - 1), []).append(html)
    multi = len(steps) > 1
    step_html = []
    for i, s in enumerate(steps):
        legend = f'<h2 class="sc-step-title">{e(s.get("title"))}</h2>' if multi and s.get("title") else ""
        step_html.append(f'<section class="sc-step" data-step-index="{i}"' + (" hidden" if i else "")
                         + f' aria-label="Step {i + 1} of {len(steps)}">{legend}<div class="sc-grid">'
                         + "".join(fields_by_step.get(i, [])) + "</div></section>")
    title = (f'<h1 class="sc-title" dir="auto">{e(d.get("title"))}</h1>' if des.get("show_title") and d.get("title")
             else "")
    desc = (f'<p class="sc-desc" dir="auto">{e(d.get("description"))}</p>'
            if des.get("show_title") and d.get("description") else "")
    progress = (f'<div class="sc-progress" role="progressbar" aria-valuemin="1" aria-valuemax="{len(steps)}" '
                f'aria-valuenow="1" aria-label="Form progress"><div class="sc-progress-track">'
                f'<div class="sc-progress-bar" style="width:{100 / len(steps):.0f}%"></div></div>'
                f'<p class="sc-progress-label">Step 1 of {len(steps)}</p></div>' if multi else "")
    ts_key = settings.TURNSTILE_SITE_KEY if st.get("turnstile") and turnstile_available() else None
    turnstile = (f'<div class="cf-turnstile" data-sitekey="{e(ts_key)}"></div>'
                 '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
                 if ts_key else "")
    consent_text = (f'<p class="sc-consent-text">{e(st.get("consent_text"))}</p>'
                    if st.get("subscribe_on_submit") and st.get("consent_text") else "")
    brand = (f'<p class="sc-brand"><a href="{e(settings.FRONTEND_URL)}" target="_blank" rel="noopener">'
             f'Powered by {e(settings.APP_NAME)}</a></p>' if branding else "")
    nav = ('<button type="button" class="sc-btn sc-btn-secondary sc-back" hidden>Back</button>'
           '<button type="button" class="sc-btn sc-next">Next</button>' if multi else "")
    config = {
        "public_id": form.public_id, "api": f"{settings.API_V1_PREFIX}/public/forms/{form.public_id}",
        "token": render_token(form.public_id), "iid": iid, "mode": mode, "hosted": hosted,
        "steps": len(steps), "default_country": default_country,
        "fields": [{"id": f["id"], "type": f["type"], "required": bool(f.get("required")),
                    "step": int(f.get("step") or 0), "condition": f.get("condition"), "hidden": f.get("hidden"),
                    "label": f.get("label") or "", "min": f.get("min"), "max": f.get("max")}
                   for f in d["fields"]],
        "success": {"mode": d["success"]["mode"], "redirect_delay": d["success"].get("redirect_delay", 3)},
    }
    _, css_v = asset("form.css")
    _, js_v = asset("form.js")
    font_family = _safe_family(site_font)
    body_cls = (f'sc-theme-{e(des["theme"])} sc-labels-{e(des["label_position"])}'
                + (" sc-hosted" if hosted else " sc-embedded"))
    title_text = d.get("title") or form.name
    head_meta = ""
    if hosted:
        desc_text = d.get("description") or f"{form.name}"
        url = f"{settings.BACKEND_PUBLIC_URL.rstrip('/')}/embed/f/{form.public_id}"
        head_meta = (f'<meta name="description" content="{e(desc_text)}">'
                     f'<meta property="og:type" content="website"><meta property="og:title" content="{e(title_text)}">'
                     f'<meta property="og:description" content="{e(desc_text)}"><meta property="og:url" content="{e(url)}">'
                     f'<meta name="twitter:card" content="summary"><meta name="twitter:title" content="{e(title_text)}">'
                     f'<meta name="twitter:description" content="{e(desc_text)}"><link rel="canonical" href="{e(url)}">')
    success = sanitize_html(d["success"]["message_html"]) if d["success"]["mode"] != "redirect" else ""
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f'<title>{e(title_text)}</title>{head_meta}'
        '<meta name="robots" content="' + ("index,follow" if hosted else "noindex") + '">'
        f'<link rel="stylesheet" href="/embed/forms-assets/form.css?v={css_v}">{_font_link(des["font"])}'
        f'<style>{_style(des, font_family)}</style></head>'
        f'<body class="{body_cls}"><main class="sc-wrap">'
        f'<form class="sc-form" id="sc-form" novalidate data-sc-form aria-labelledby="sc-heading">'
        f'<div id="sc-heading">{title}{desc}</div>{progress}'
        '<div class="sc-summary" id="sc-summary" role="alert" aria-live="assertive"></div>'
        + "".join(step_html) + "".join(hidden)
        + '<div class="sc-hp" aria-hidden="true"><label for="sc_website">Leave this field empty</label>'
          '<input type="text" id="sc_website" name="sc_website" tabindex="-1" autocomplete="off"></div>'
        + turnstile + consent_text
        + f'<div class="sc-actions">{nav}<button type="submit" class="sc-btn sc-submit"'
        + (" hidden" if multi else "") + f'>{e(des["button_text"])}</button></div>'
        + '<p class="sc-status" id="sc-status" role="status" aria-live="polite"></p>'
        + brand + '</form>'
        f'<div class="sc-success" data-sc-success hidden role="status" tabindex="-1" dir="auto">{success}{brand}</div>'
        f'</main><script type="application/json" id="sc-config">{json_for_script(config)}</script>'
        f'<script src="/embed/forms-assets/form.js?v={js_v}" defer></script></body></html>'
    )


def message_page(title: str, message: str, status_ok: bool = True) -> str:
    css, v = asset("form.css")
    icon = "✓" if status_ok else "!"
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
            f'<title>{e(title)}</title><link rel="stylesheet" href="/embed/forms-assets/form.css?v={v}">'
            '<style>:root{--sc-primary:#4f46e5;--sc-bg:#ffffff;--sc-text:#0f172a;--sc-radius:12px;'
            "--sc-font:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--sc-maxw:520px}</style></head>"
            '<body class="sc-hosted sc-theme-light"><main class="sc-wrap"><div class="sc-form sc-message">'
            f'<div class="sc-message-icon" aria-hidden="true">{icon}</div><h1 class="sc-title">{e(title)}</h1>'
            f'<p class="sc-desc">{e(message)}</p></div></main></body></html>')
