"""Public lead form endpoints called from customers' websites (CORS handled for /public/forms in main.py).

No authentication: the form's public id identifies it, and every request is rate limited, checked
against the form's allowed domains and validated against the published definition."""
from fastapi import APIRouter, Request, Response, status

from app.api.deps import DB
from app.core.rate_limit import client_ip
from app.schemas.forms import EventIn, SubmitIn
from app.services.forms import submit as svc
from app.services.notifications import enqueue_system_email

router = APIRouter(prefix="/public/forms/{public_id}", tags=["Lead forms (public)"])


@router.get("")
def form_config(public_id: str, db: DB, response: Response):
    """What the loader needs to decide when and how to show a popup / slide-in / floating form."""
    f = svc.public_form(db, public_id)
    d = f.published
    response.headers["Cache-Control"] = "public, max-age=60"
    return {"public_id": f.public_id, "name": f.name, "version": f.published_version, "display": d["display"],
            "button_color": d["design"]["button_color"], "button_text_color": d["design"]["button_text_color"]}


@router.post("/event", status_code=status.HTTP_204_NO_CONTENT)
def form_event(public_id: str, body: EventIn, request: Request, db: DB):
    """A view or the first interaction (start), for the funnel. Cheap and silently rate limited."""
    f = svc.public_form(db, public_id)
    svc.track_event(db, f, body.type, client_ip(request))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/submit")
def submit_form(public_id: str, body: SubmitIn, request: Request, db: DB):
    f = svc.public_form(db, public_id)
    out = svc.submit(db, f, body, ip=client_ip(request), origin=request.headers.get("origin"),
                     user_agent=request.headers.get("user-agent"),
                     country=request.headers.get("cf-ipcountry"))
    db.commit()
    for kind, to, name, email in out.emails:
        enqueue_system_email(kind, to, name, email)
    if out.confirm:
        svc.send_confirmation(db, out.confirm[0])
    return out.response
