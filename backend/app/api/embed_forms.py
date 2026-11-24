"""Lead form pages and scripts served to customers' websites:
    /embed/forms.js            the loader (vanilla JS, cached; ?v=<hash> is immutable)
    /embed/forms-assets/*      the iframe's script and stylesheet (versioned)
    /embed/form/{public_id}    the iframe page (published version only)
    /embed/f/{public_id}       the hosted, shareable page with OG tags
    /embed/forms/confirm       double opt-in confirmation link
Pages set Content-Security-Policy frame-ancestors from the form's allowed domains (X-Frame-Options is
skipped for /embed/ paths in main.py)."""

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, Response

from app.api.deps import DB
from app.core.errors import NotFound
from app.services.forms import render, service
from app.services.forms import submit as svc

router = APIRouter(prefix="/embed", tags=["Lead forms (embed)"], include_in_schema=False)
TYPES = {"form.js": "application/javascript; charset=utf-8", "form.css": "text/css; charset=utf-8"}


def _static(name: str, versioned: bool, request: Request) -> Response:
    text, h = render.asset(name)
    etag = f'"{h}"'
    cache = "public, max-age=31536000, immutable" if versioned else "public, max-age=3600, stale-while-revalidate=86400"
    headers = {"Cache-Control": cache, "ETag": etag, "Access-Control-Allow-Origin": "*"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=text, media_type=TYPES.get(name, "application/javascript; charset=utf-8"),
                    headers=headers)


@router.get("/forms.js")
def loader(request: Request, v: str | None = None):
    return _static("loader.js", bool(v), request)


@router.get("/forms-assets/{name}")
def assets(name: str, request: Request, v: str | None = None):
    if name not in TYPES:
        raise NotFound("Not found")
    return _static(name, bool(v), request)


def _page(db, public_id: str, request: Request, hosted: bool) -> HTMLResponse:
    try:
        f = svc.public_form(db, public_id)
    except NotFound:
        html = render.message_page("Form unavailable", "This form is no longer accepting responses.", False)
        return HTMLResponse(html, status_code=404, headers={"Cache-Control": "no-store",
                                                            "Content-Security-Policy": render.csp(None)})
    q = request.query_params
    mode = q.get("mode") if q.get("mode") in ("inline", "popup", "slide_in") else "inline"
    html = render.form_html(f, hosted=hosted, branding=service.branding(db, f.organization_id),
                            countries=service.countries(), default_country=_default_country(db, f),
                            site_font=q.get("font"), iid=(q.get("iid") or "")[:20], mode=mode)
    return HTMLResponse(html, headers={
        "Content-Security-Policy": render.csp(f.published["settings"].get("allowed_domains")),
        "Cache-Control": "no-store", "Referrer-Policy": "strict-origin-when-cross-origin"})


def _default_country(db, f) -> str | None:
    from app.models import Application

    app = db.get(Application, f.application_id)
    return app.default_country if app else None


@router.get("/form/{public_id}", response_class=HTMLResponse)
def iframe_page(public_id: str, request: Request, db: DB):
    return _page(db, public_id, request, hosted=False)


@router.get("/f/{public_id}", response_class=HTMLResponse)
def hosted_page(public_id: str, request: Request, db: DB):
    return _page(db, public_id, request, hosted=True)


@router.get("/forms/confirm", response_class=HTMLResponse)
def confirm(db: DB, token: str = Query("", max_length=300)):
    result, form = svc.confirm(db, token)
    db.commit()
    titles = {"confirmed": ("You're confirmed", "Thanks! Your subscription is confirmed.", True),
              "already": ("Already confirmed", "Your subscription was already confirmed. Nothing else to do.", True),
              "expired": ("Link expired", "This confirmation link has expired. Please fill in the form again.", False),
              "invalid": ("Link not valid", "This confirmation link isn't valid.", False)}
    t, m, ok = titles[result]
    return HTMLResponse(render.message_page(t, m, ok), status_code=200 if ok else 400,
                        headers={"Cache-Control": "no-store", "Content-Security-Policy": render.csp(None)})


