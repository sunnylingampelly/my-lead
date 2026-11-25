"""Slack for the AI Team: one workspace connection per organization ("Add to Slack", OAuth v2), channel listing,
Block Kit messages with Approve / Reject / Open in Signalcraft buttons, and the interactivity endpoint's logic.

Docs (docs.slack.dev): OAuth v2 install (https://slack.com/oauth/v2/authorize → oauth.v2.access), request
verification (X-Slack-Signature = "v0=" + HMAC-SHA256(signing secret, "v0:{timestamp}:{raw body}"), rejected
when the timestamp is more than five minutes off), block_actions payloads (form field `payload`, answered within
3 s, ephemeral replies through `response_url`), Web API methods chat.postMessage, chat.update,
conversations.list, users.info (needs users:read.email for the email), auth.revoke. Web API calls use
`Authorization: Bearer xoxb-…` and report failures as {"ok": false, "error": "..."}.

The bot token is encrypted at rest (core/crypto.py). Without SLACK_CLIENT_ID/SECRET a *simulated* connection can
be made: messages are written to a local log shown at /dev/slack, nothing leaves the machine."""
import hashlib
import hmac
import json
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode

import httpx
import jwt
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.crypto import decrypt_str, encrypt_str
from app.core.errors import NotFound, ValidationFailed
from app.core.logging import get_logger
from app.core.permissions import Perm
from app.models import OrganizationMember, User
from app.models.ai_team import AiPendingAction, SlackConnection
from app.services import audit_service
from app.services.ai_team.registry import ToolError
from app.utils.time import utcnow

log = get_logger(__name__)

API = "https://slack.com/api/"
AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"
# chat:write posts, chat:write.public posts to public channels the bot hasn't joined, channels:read/groups:read
# list channels for the picker, users:read + users:read.email map a clicking Slack user to a Signalcraft user.
BOT_SCOPES = ("chat:write", "chat:write.public", "channels:read", "groups:read", "users:read", "users:read.email")
SIGNATURE_WINDOW = 60 * 5
SIM_CHANNELS = [{"id": "CSIMGENERAL", "name": "general", "is_private": False},
                {"id": "CSIMSALES", "name": "sales", "is_private": False},
                {"id": "CSIMMARKETING", "name": "marketing", "is_private": False}]
SIM_USER_PREFIX = "SIMU:"  # simulated Slack user ids carry the email: "SIMU:priya@example.com"
transport: httpx.BaseTransport | None = None  # tests install httpx.MockTransport here


class SlackError(Exception):
    def __init__(self, error: str):
        super().__init__(error)
        self.error = error


def configured() -> bool:
    return bool(settings.SLACK_CLIENT_ID and settings.SLACK_CLIENT_SECRET)


def redirect_uri() -> str:
    return f"{settings.BACKEND_PUBLIC_URL.rstrip('/')}{settings.API_V1_PREFIX}/integrations/slack/oauth/callback"


def interactivity_url() -> str:
    return f"{settings.BACKEND_PUBLIC_URL.rstrip('/')}{settings.API_V1_PREFIX}/integrations/slack/interactivity"


def log_path() -> Path:
    return Path(settings.SIMULATION_MAILBOX_PATH).parent / "slack_log"


# ------------------------------------------------------------------ Web API


def _http() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(10.0, connect=5.0), transport=transport)


def api(token: str | None, method: str, *, params: dict | None = None, body: dict | None = None,
        form: dict | None = None, auth: tuple[str, str] | None = None) -> dict:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with _http() as c:
        if body is not None:
            r = c.post(API + method, json=body, headers={**headers, "Content-Type": "application/json; charset=utf-8"})
        elif form is not None:
            r = c.post(API + method, data=form, headers=headers, auth=auth)
        else:
            r = c.get(API + method, params=params or {}, headers=headers)
    try:
        data = r.json()
    except ValueError as exc:
        raise SlackError(f"http_{r.status_code}") from exc
    if not data.get("ok"):
        raise SlackError(str(data.get("error") or f"http_{r.status_code}"))
    return data


def _token(conn: SlackConnection) -> str:
    return decrypt_str(conn.token_encrypted or "")


def _sim_log(record: dict) -> dict:
    box = log_path()
    box.mkdir(parents=True, exist_ok=True)
    rec = {"id": f"simslack-{uuid.uuid4()}", "created_at": utcnow().isoformat(), **record}
    (box / f"{utcnow().strftime('%Y%m%dT%H%M%S%f')}_{rec['id']}.json").write_text(json.dumps(rec), encoding="utf-8")
    return rec


def sim_messages(limit: int = 100) -> list[dict]:
    box = log_path()
    out = []
    for f in sorted(box.glob("*.json"), reverse=True) if box.exists() else []:
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
        if len(out) >= limit:
            break
    return out


# ------------------------------------------------------------------ connection


def connection(db: Session, organization_id: str) -> SlackConnection | None:
    return db.scalar(select(SlackConnection).where(SlackConnection.organization_id == organization_id))


def status(db: Session, ctx) -> dict:
    c = connection(db, ctx.organization_id)
    return {"configured": configured(), "connected": c is not None, "simulated": bool(c and c.simulated),
            "team_name": c.team_name if c else None, "team_id": c.team_id if c else None,
            "scopes": (c.scopes.split(",") if c and c.scopes else []),
            "connected_at": c.created_at.isoformat() if c else None,
            "can_manage": ctx.has(Perm.AI_MANAGE), "redirect_url": redirect_uri(),
            "interactivity_url": interactivity_url(), "bot_scopes": list(BOT_SCOPES)}


def install_url(ctx) -> str:
    ctx.require(Perm.AI_MANAGE)
    if not configured():
        raise ValidationFailed("The Slack app isn't configured on this server. Use the simulated connection to try it.",
                               code="SLACK_NOT_CONFIGURED")
    state = jwt.encode({"typ": "slack_oauth", "org": ctx.organization_id, "app": ctx.application_id,
                        "uid": ctx.user.id, "exp": int(time.time()) + 600, "n": uuid.uuid4().hex},
                       settings.SECRET_KEY, algorithm="HS256")
    return AUTHORIZE_URL + "?" + urlencode({"client_id": settings.SLACK_CLIENT_ID, "scope": ",".join(BOT_SCOPES),
                                            "redirect_uri": redirect_uri(), "state": state})


def _save(db: Session, organization_id: str, user_id: str | None, **values) -> SlackConnection:
    c = connection(db, organization_id)
    if c is None:
        c = SlackConnection(organization_id=organization_id)
        db.add(c)
    for k, v in values.items():
        setattr(c, k, v)
    c.connected_by_id = user_id
    db.flush()
    return c


def oauth_callback(db: Session, code: str | None, state: str | None, error: str | None) -> str:
    """Finish "Add to Slack". Returns the app page to send the browser back to."""
    try:
        st = jwt.decode(state or "", settings.SECRET_KEY, algorithms=["HS256"])
        if st.get("typ") != "slack_oauth":
            raise jwt.InvalidTokenError("wrong type")
    except jwt.PyJWTError:
        return f"{settings.FRONTEND_URL.rstrip('/')}/?slack=invalid_state"
    back = f"{settings.FRONTEND_URL.rstrip('/')}/apps/{st['app']}/ai/integrations"
    if error or not code:
        return f"{back}?slack=cancelled"
    # The person must still be allowed to manage AI in that application.
    from app.services.tenancy import resolve_app_context

    user = db.get(User, st["uid"])
    try:
        ctx = resolve_app_context(db, user, st["app"]) if user else None
    except Exception:  # noqa: BLE001
        ctx = None
    if ctx is None or not ctx.has(Perm.AI_MANAGE) or ctx.organization_id != st["org"]:
        return f"{back}?slack=forbidden"
    try:
        data = api(None, "oauth.v2.access", form={"code": code, "redirect_uri": redirect_uri()},
                   auth=(settings.SLACK_CLIENT_ID or "", settings.SLACK_CLIENT_SECRET or ""))
    except (SlackError, httpx.HTTPError) as exc:
        log.warning("slack_oauth_failed", error=str(exc))
        return f"{back}?slack=error"
    if data.get("token_type") != "bot" or not data.get("access_token"):
        return f"{back}?slack=error"
    team = data.get("team") or {}
    _save(db, st["org"], user.id, team_id=team.get("id") or "", team_name=team.get("name") or "",
          bot_user_id=data.get("bot_user_id"), app_id=data.get("app_id"), scopes=data.get("scope") or "",
          token_encrypted=encrypt_str(data["access_token"]), simulated=False)
    audit_service.record(db, "slack.connected", actor_user_id=user.id, organization_id=st["org"],
                         application_id=st["app"], target_type="slack", summary=f"Connected Slack {team.get('name')}")
    db.commit()
    return f"{back}?slack=connected"


def connect_simulated(db: Session, ctx) -> SlackConnection:
    ctx.require(Perm.AI_MANAGE)
    if configured():
        raise ValidationFailed("Connect your real Slack workspace with “Add to Slack”.", code="SLACK_CONFIGURED")
    c = _save(db, ctx.organization_id, ctx.user.id, team_id="TSIMULATED", team_name="Simulated Slack",
              bot_user_id="USIMBOT", app_id="ASIMULATED", scopes=",".join(BOT_SCOPES), token_encrypted=None,
              simulated=True)
    audit_service.record(db, "slack.connected", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="slack", summary="Connected simulated Slack")
    return c


def disconnect(db: Session, ctx) -> None:
    ctx.require(Perm.AI_MANAGE)
    c = connection(db, ctx.organization_id)
    if c is None:
        raise NotFound("Slack isn't connected")
    if not c.simulated and c.token_encrypted:
        try:
            api(_token(c), "auth.revoke", form={})
        except (SlackError, httpx.HTTPError, ValueError) as exc:
            log.warning("slack_revoke_failed", error=str(exc))  # still forget the token on our side
    from app.models.ai_team import AgentSlackDestination

    db.execute(AgentSlackDestination.__table__.delete().where(
        AgentSlackDestination.organization_id == ctx.organization_id))
    db.delete(c)
    audit_service.record(db, "slack.disconnected", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="slack", summary="Disconnected Slack")


def _require(db: Session, organization_id: str) -> SlackConnection:
    c = connection(db, organization_id)
    if c is None:
        raise ToolError("Slack isn't connected. Connect it under AI Team → Integrations.", "SLACK_NOT_CONNECTED")
    return c


def list_channels(db: Session, organization_id: str) -> list[dict]:
    c = _require(db, organization_id)
    if c.simulated:
        return list(SIM_CHANNELS)
    out, cursor = [], None
    for _ in range(10):  # up to 2,000 channels
        params = {"types": "public_channel,private_channel", "exclude_archived": "true", "limit": 200}
        if cursor:
            params["cursor"] = cursor
        try:
            data = api(_token(c), "conversations.list", params=params)
        except (SlackError, httpx.HTTPError) as exc:
            raise ToolError(f"Slack didn't return the channels ({exc})", "SLACK_ERROR") from exc
        out += [{"id": ch["id"], "name": ch.get("name") or ch["id"], "is_private": bool(ch.get("is_private"))}
                for ch in data.get("channels") or []]
        cursor = (data.get("response_metadata") or {}).get("next_cursor")
        if not cursor:
            break
    return sorted(out, key=lambda ch: ch["name"])


def find_channel(db: Session, organization_id: str, name_or_id: str) -> dict:
    want = name_or_id.strip().lstrip("#").lower()
    chans = list_channels(db, organization_id)
    for ch in chans:
        if ch["id"].lower() == want or ch["name"].lower() == want:
            return ch
    raise ToolError(f"No Slack channel “#{want}”. Channels: " + ", ".join("#" + c["name"] for c in chans[:15]),
                    "NOT_FOUND")


def post(db: Session, organization_id: str, channel_id: str, text: str, blocks: list | None = None,
         meta: dict | None = None) -> dict:
    c = _require(db, organization_id)
    if c.simulated:
        name = next((ch["name"] for ch in SIM_CHANNELS if ch["id"] == channel_id), channel_id)
        rec = _sim_log({"kind": "message", "organization_id": organization_id, "channel": channel_id,
                        "channel_name": name, "text": text, "blocks": blocks or [], **(meta or {})})
        return {"channel": channel_id, "ts": rec["id"]}
    try:
        data = api(_token(c), "chat.postMessage", body={"channel": channel_id, "text": text[:3900],
                                                        **({"blocks": blocks} if blocks else {}),
                                                        "unfurl_links": False})
    except (SlackError, httpx.HTTPError) as exc:
        raise ToolError(f"Slack refused the message ({exc})", "SLACK_ERROR") from exc
    return {"channel": data.get("channel") or channel_id, "ts": data.get("ts")}


def update_message(db: Session, organization_id: str, channel: str, ts: str, text: str, blocks: list) -> None:
    c = _require(db, organization_id)
    if c.simulated:
        _sim_log({"kind": "update", "organization_id": organization_id, "channel": channel, "ts": ts, "text": text,
                  "blocks": blocks})
        return
    api(_token(c), "chat.update", body={"channel": channel, "ts": ts, "text": text[:3900], "blocks": blocks})


# ------------------------------------------------------------------ Block Kit


def _mrkdwn(text: str) -> str:
    """Our markdown → Slack mrkdwn (bold, links)."""
    import re

    text = re.sub(r"\*\*(.+?)\*\*", r"*\1*", text)
    base = settings.FRONTEND_URL.rstrip("/")
    return re.sub(r"\[([^\]]+)\]\((/[^)\s]*)\)", lambda m: f"<{base}{m.group(2)}|{m.group(1)}>", text)


def text_blocks(text: str, open_url: str | None, open_label: str = "Open in Signalcraft",
                extra_buttons: list[dict] | None = None) -> list[dict]:
    chunks = [text[i:i + 2900] for i in range(0, min(len(text), 2900 * 5), 2900)] or [""]
    blocks: list[dict] = [{"type": "section", "text": {"type": "mrkdwn", "text": _mrkdwn(c)}} for c in chunks]
    buttons = list(extra_buttons or [])
    if open_url:
        buttons.append({"type": "button", "text": {"type": "plain_text", "text": open_label[:75]},
                        "action_id": "ai_open", "url": open_url})
    if buttons:
        blocks.append({"type": "actions", "elements": buttons[:5]})
    return blocks


def app_url(application_id: str, path: str) -> str:
    return f"{settings.FRONTEND_URL.rstrip('/')}/apps/{application_id}{path}"


def approval_blocks(a: AiPendingAction, agent_name: str) -> list[dict]:
    fields = [{"type": "mrkdwn", "text": f"*{f['label']}*\n{str(f['value'])[:300] or '—'}"} for f in a.fields[:10]]
    blocks: list[dict] = [{"type": "section", "text": {"type": "mrkdwn",
                                                       "text": f":robot_face: *{agent_name}* wants to: *{a.title}*"}}]
    if fields:
        blocks.append({"type": "section", "fields": fields})
    blocks.append({"type": "actions", "block_id": f"ai_action:{a.id}", "elements": [
        {"type": "button", "text": {"type": "plain_text", "text": "Approve"}, "style": "primary",
         "action_id": "ai_approve", "value": a.id},
        {"type": "button", "text": {"type": "plain_text", "text": "Reject"}, "style": "danger",
         "action_id": "ai_reject", "value": a.id},
        {"type": "button", "text": {"type": "plain_text", "text": "Open in Signalcraft"}, "action_id": "ai_open",
         "url": app_url(a.application_id, "/ai/approvals")}]})
    return blocks


def post_approval(db: Session, a: AiPendingAction, agent_name: str, channel_id: str) -> None:
    res = post(db, a.organization_id, channel_id, f"{agent_name} wants to: {a.title}", approval_blocks(a, agent_name),
               meta={"action_id": a.id, "application_id": a.application_id})
    a.slack_channel, a.slack_ts = res["channel"], res["ts"]


def update_decided(db: Session, a: AiPendingAction, who: str) -> None:
    verb = {"executed": "✅ Approved", "failed": "⚠️ Approved but failed", "rejected": "❌ Rejected",
            "cancelled": "Cancelled", "expired": "Expired"}.get(a.status, a.status)
    text = f"{verb} by {who}: {a.title}"
    blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": _mrkdwn(f"{verb} by *{who}*: {a.title}")}},
              {"type": "context", "elements": [{"type": "mrkdwn", "text": (a.error or (a.result or {}).get(
                  "summary") or "")[:300] or " "}]}]
    update_message(db, a.organization_id, a.slack_channel, a.slack_ts, text, blocks)


# ------------------------------------------------------------------ interactivity


def verify_signature(timestamp: str | None, signature: str | None, body: bytes, now: float | None = None) -> bool:
    secret = settings.SLACK_SIGNING_SECRET
    if not secret or not timestamp or not signature:
        return False
    try:
        ts = int(timestamp)
    except ValueError:
        return False
    if abs((now or time.time()) - ts) > SIGNATURE_WINDOW:
        return False
    base = b"v0:" + timestamp.encode() + b":" + body
    expected = "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def sign(body: bytes, timestamp: int | None = None) -> dict:
    """Headers Slack would send (tests and the development Slack log's buttons)."""
    ts = str(timestamp or int(time.time()))
    sig = "v0=" + hmac.new((settings.SLACK_SIGNING_SECRET or "").encode(), b"v0:" + ts.encode() + b":" + body,
                           hashlib.sha256).hexdigest()
    return {"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig}


def slack_user_email(conn: SlackConnection, slack_user_id: str) -> str | None:
    if conn.simulated:
        return slack_user_id[len(SIM_USER_PREFIX):].lower() if slack_user_id.startswith(SIM_USER_PREFIX) else None
    try:
        data = api(_token(conn), "users.info", params={"user": slack_user_id})
    except (SlackError, httpx.HTTPError) as exc:
        log.warning("slack_users_info_failed", error=str(exc))
        return None
    email = ((data.get("user") or {}).get("profile") or {}).get("email")
    return email.lower() if email else None


def respond(conn: SlackConnection | None, response_url: str | None, text: str, replace: bool = False) -> None:
    body = {"response_type": "ephemeral", "text": text, "replace_original": replace}
    if conn is None or conn.simulated or not response_url:
        _sim_log({"kind": "ephemeral", "organization_id": conn.organization_id if conn else None, "text": text})
        return
    if not response_url.startswith("https://hooks.slack.com/"):
        return  # only ever post back to Slack
    try:
        with _http() as c:
            c.post(response_url, json=body)
    except httpx.HTTPError:
        log.warning("slack_respond_failed")


def handle_interaction(db: Session, payload: dict) -> dict:
    """A button click from Slack. Returns {"ok": bool, "message": str} (also sent to the clicker ephemerally)."""
    from app.services.ai_team import actions
    from app.services.tenancy import resolve_app_context

    if payload.get("type") != "block_actions":
        return {"ok": True, "message": ""}
    act = next((x for x in payload.get("actions") or [] if x.get("action_id") in ("ai_approve", "ai_reject")), None)
    if act is None:
        return {"ok": True, "message": ""}  # "Open in Signalcraft" is a link button: nothing to do
    response_url = payload.get("response_url")
    a = db.get(AiPendingAction, str(act.get("value") or ""))
    conn = connection(db, a.organization_id) if a else None
    team_id = (payload.get("team") or {}).get("id") or (payload.get("user") or {}).get("team_id")

    def refuse(msg: str) -> dict:
        respond(conn, response_url, msg)
        return {"ok": False, "message": msg}

    if a is None or conn is None or (team_id and team_id != conn.team_id):
        return refuse("This approval request is no longer available.")
    email = slack_user_email(conn, (payload.get("user") or {}).get("id") or "")
    user = db.scalar(select(User).where(func.lower(User.email) == email, User.is_active.is_(True))) if email else None
    member = db.scalar(select(OrganizationMember.id).where(OrganizationMember.organization_id == a.organization_id,
                                                          OrganizationMember.user_id == user.id)) if user else None
    if user is None or member is None:
        return refuse("We couldn't match your Slack account to a Signalcraft user (by email). Ask an admin to "
                      "invite you with the email you use in Slack, or approve it in Signalcraft.")
    try:
        ctx = resolve_app_context(db, user, a.application_id)
    except Exception:  # noqa: BLE001 - NotFound/Forbidden: no access to the application
        return refuse("You don't have access to this application in Signalcraft.")
    if not ctx.has(Perm.AI_MANAGE):
        return refuse("Your Signalcraft role can't approve AI agent actions.")
    if a.status != "pending":
        return refuse(f"Already handled ({a.status}).")
    try:
        done = actions.decide(db, ctx, a.id, act["action_id"] == "ai_approve", via="slack", action=a)
    except ToolError as exc:
        return refuse(exc.message)
    except Exception as exc:  # noqa: BLE001
        msg = getattr(exc, "message", None) or "Something went wrong."
        return refuse(msg)
    msg = {"executed": "Approved and done.", "rejected": "Rejected.", "failed": f"Approved, but it failed: {done.error}",
           "expired": "This request expired."}.get(done.status, done.status)
    return {"ok": done.status in ("executed", "rejected"), "message": msg}
