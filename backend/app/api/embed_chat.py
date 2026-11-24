"""The website chat widget's static pieces, served by the backend (not the React app):

* /embed/chat.js                 the loader customers paste (tiny vanilla JS, short cache, versioned assets)
* /embed/chat/{public_key}       the chat page inside the widget's iframe (plain HTML + vanilla JS + CSS)
* /embed/chat-assets/{name}      the iframe's script and stylesheet (immutable when requested with ?v=<hash>)
* /embed/chat-preview/{key}      a blank test page with the widget, for previews and end-to-end tests

Embed paths skip X-Frame-Options (app/main.py); the iframe page sends CSP frame-ancestors for the bot's
allowed domains instead, and a strict CSP otherwise (no inline script, same-origin API calls only).
"""
import hashlib
import json
from html import escape
from pathlib import Path

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, Response
from sqlalchemy import select

from app.api.deps import DB
from app.core.config import settings
from app.core.embed import frame_ancestors
from app.models.chat import ChatBot

router = APIRouter(prefix="/embed", tags=["Chat widget (embed)"], include_in_schema=False)
STATIC = Path(__file__).resolve().parents[1] / "static" / "chat"
ASSETS = {"widget.js": "application/javascript; charset=utf-8", "widget.css": "text/css; charset=utf-8"}
_cache: dict[str, tuple[float, bytes, str]] = {}


def _asset(name: str) -> tuple[bytes, str]:
    """File bytes and a short content hash, re-read when the file changes (development)."""
    p = STATIC / name
    mtime = p.stat().st_mtime
    hit = _cache.get(name)
    if hit is None or hit[0] != mtime:
        data = p.read_bytes()
        hit = (mtime, data, hashlib.sha256(data).hexdigest()[:12])
        _cache[name] = hit
    return hit[1], hit[2]


def version() -> str:
    return hashlib.sha256("".join(_asset(n)[1] for n in sorted(ASSETS)).encode()).hexdigest()[:12]


def _not_found_page() -> HTMLResponse:
    return HTMLResponse("<!doctype html><title>Chat unavailable</title><p>This chat isn't available.</p>",
                        status_code=404, headers={"Content-Security-Policy": "default-src 'none'",
                                                  "Cache-Control": "no-store"})


@router.get("/chat.js")
def loader(request: Request):
    data, etag = _asset("loader.js")
    body = data.replace(b"__SC_VERSION__", version().encode())
    tag = f'"{hashlib.sha256(body).hexdigest()[:16]}"'
    headers = {"Cache-Control": "public, max-age=300", "ETag": tag, "Access-Control-Allow-Origin": "*"}
    if request.headers.get("if-none-match") == tag:
        return Response(status_code=304, headers=headers)
    return Response(body, media_type="application/javascript; charset=utf-8", headers=headers)


@router.get("/chat-assets/{name}")
def asset(name: str, v: str | None = Query(None, max_length=40)):
    if name not in ASSETS:
        return Response(status_code=404)
    data, h = _asset(name)
    cache = "public, max-age=31536000, immutable" if v == version() else "public, max-age=300"
    return Response(data, media_type=ASSETS[name], headers={"Cache-Control": cache, "ETag": f'"{h}"'})


def _csp(bot: ChatBot) -> str:
    return ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; "
            "connect-src 'self'; font-src 'self'; media-src 'self' data:; base-uri 'none'; form-action 'none'; "
            + frame_ancestors(bot.allowed_domains))


@router.get("/chat/{public_key}", response_class=HTMLResponse)
def frame(public_key: str, db: DB, h: str | None = Query(None, max_length=300)):
    bot = db.scalar(select(ChatBot).where(ChatBot.public_key == public_key[:40]))
    if bot is None:
        return _not_found_page()
    from app.api.v1.public_chat import _own, public_config

    if bot.status != "live" and not (_own(h) or h is None):
        return _not_found_page()
    cfg = public_config(db, bot)
    cfg["base"] = settings.API_V1_PREFIX
    payload = json.dumps(cfg, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e") \
        .replace("&", "\\u0026")
    v = version()
    html = (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            f'<meta name="robots" content="noindex"><title>{escape(bot.name)}</title>'
            f'<link rel="stylesheet" href="/embed/chat-assets/widget.css?v={v}"></head>'
            f'<body><div id="sc-app" class="sc-app"></div>'
            f'<script type="application/json" id="sc-config">{payload}</script>'
            f'<script src="/embed/chat-assets/widget.js?v={v}" defer></script></body></html>')
    return HTMLResponse(html, headers={"Content-Security-Policy": _csp(bot), "Cache-Control": "no-cache",
                                       "Referrer-Policy": "strict-origin-when-cross-origin"})


@router.get("/chat-preview/{public_key}", response_class=HTMLResponse)
def preview(public_key: str, db: DB):
    bot = db.scalar(select(ChatBot).where(ChatBot.public_key == public_key[:40]))
    if bot is None:
        return _not_found_page()
    key = escape(bot.public_key, quote=True)
    html = (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
            f'<title>Preview: {escape(bot.name)}</title></head><body>'
            f'<main><h1>Chat widget preview</h1><p>This is a blank test page with the '
            f'<strong>{escape(bot.name)}</strong> chat widget, exactly as visitors see it on your website.</p>'
            f'<p>Open the chat with the button in the corner.</p></main>'
            f'<script src="/embed/chat.js" data-bot="{key}" async></script></body></html>')
    return HTMLResponse(html, headers={
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                                   "img-src 'self' https: data:; connect-src 'self'; frame-src 'self'; "
                                   "base-uri 'none'; form-action 'none'; frame-ancestors 'self' "
                                   + settings.FRONTEND_URL.rstrip("/"),
        "Cache-Control": "no-store"})
