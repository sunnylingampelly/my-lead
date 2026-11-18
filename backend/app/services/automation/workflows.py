"""Workflow lifecycle: draft → active ⇄ paused → archived. Editing changes the draft graph; publishing
validates it, refreshes the hidden campaigns behind send steps and makes it the graph runs follow."""
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.permissions import Perm
from app.models import ContactList, Segment, Tag
from app.models.automation import Workflow, WorkflowRun, WorkflowStep
from app.models.email import EmailCampaign, EmailSender, EmailTemplate
from app.models.sms import SmsCampaign, SmsSender, SmsTemplate
from app.models.voice import VoiceAudio, VoiceCallerId, VoiceCampaign
from app.schemas.common import Page, PageParams
from app.services import audit_service
from app.services.audience.segments import compile_rules
from app.services.automation import actions
from app.services.automation.graph import SEND_TYPES, TRIGGERS, WAIT_UNITS, Graph, Issue, data, label, structural_issues
from app.services.tenancy import AppContext
from app.utils.time import utcnow

CAMPAIGN_MODEL = {"send_email": EmailCampaign, "send_sms": SmsCampaign, "voice_call": VoiceCampaign}


def _get(db: Session, ctx, workflow_id: str) -> Workflow:
    w = db.scalar(select(Workflow).where(Workflow.id == workflow_id, Workflow.application_id == ctx.application_id))
    if w is None:
        raise NotFound("Workflow not found")
    return w


def _audit(db: Session, ctx, action: str, w: Workflow, meta: dict | None = None) -> None:
    audit_service.record(db, f"workflow.{action}", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="workflow", target_id=w.id, summary=w.name,
                         meta=meta)


def _owned(db: Session, model, obj_id, app_id: str):
    if not obj_id:
        return None
    o = db.get(model, obj_id)
    return o if o is not None and o.application_id == app_id else None


# ------------------------------------------------------------------ validation


def node_issues(db: Session, ctx, g: Graph) -> list[Issue]:
    """Settings problems for each step, checked against this application's data."""
    issues: list[Issue] = []
    app_id = ctx.application_id
    for nid, n in g.nodes.items():
        t, d = n.get("type"), data(n)
        if t == "trigger":
            kind = d.get("kind")
            if kind not in TRIGGERS:
                issues.append(Issue(nid, "Choose what starts this workflow"))
            elif kind == "added_to_list" and not _owned(db, ContactList, d.get("list_id"), app_id):
                issues.append(Issue(nid, "Choose a list"))
            elif kind == "tag_added" and not _owned(db, Tag, d.get("tag_id"), app_id):
                issues.append(Issue(nid, "Choose a tag"))
            elif kind == "segment_entered" and not _owned(db, Segment, d.get("segment_id"), app_id):
                issues.append(Issue(nid, "Choose a segment"))
        elif t == "send_email":
            s = _owned(db, EmailSender, d.get("sender_id"), app_id)
            if s is None or s.status != "verified":
                issues.append(Issue(nid, "Choose a verified sender"))
            if not _owned(db, EmailTemplate, d.get("template_id"), app_id):
                issues.append(Issue(nid, "Choose an email template"))
        elif t == "send_sms":
            s = _owned(db, SmsSender, d.get("sender_ref"), app_id)
            if s is None or s.status != "active":
                issues.append(Issue(nid, "Choose an approved sender ID"))
            if d.get("template_id") and not _owned(db, SmsTemplate, d.get("template_id"), app_id):
                issues.append(Issue(nid, "The SMS template no longer exists"))
            if not (d.get("body") or d.get("template_id")):
                issues.append(Issue(nid, "Write the message or choose a template"))
        elif t == "voice_call":
            c = _owned(db, VoiceCallerId, d.get("caller_ref"), app_id)
            if c is None or c.status != "active":
                issues.append(Issue(nid, "Choose an approved caller ID"))
            if not _owned(db, VoiceAudio, d.get("audio_id"), app_id):
                issues.append(Issue(nid, "Choose a recording or text-to-speech message"))
        elif t == "wait":
            secs = 0
            try:
                secs = int(d.get("amount") or 0) * WAIT_UNITS.get(d.get("unit"), 0)
            except (TypeError, ValueError):
                pass
            if secs < 60 or secs > 365 * 86400:
                issues.append(Issue(nid, "Wait between 1 minute and 365 days"))
        elif t == "condition":
            kind = d.get("kind") or "rules"
            if kind == "rules":
                try:
                    compile_rules(db, ctx, d.get("rules") or {})
                    if not (d.get("rules") or {}).get("conditions"):
                        raise ValidationFailed("empty")
                except ValidationFailed:
                    issues.append(Issue(nid, "Add at least one valid condition"))
            elif kind == "engagement":
                src = g.nodes.get(d.get("node_id") or "")
                if src is None or src.get("type") not in SEND_TYPES:
                    issues.append(Issue(nid, "Choose an earlier email, SMS or call step"))
                elif d.get("event") not in {"send_email": ("delivered", "opened", "clicked"),
                                            "send_sms": ("delivered",),
                                            "voice_call": ("answered", "delivered")}[src["type"]]:
                    issues.append(Issue(nid, "Choose what to check for"))
            else:
                issues.append(Issue(nid, "Choose a condition type"))
        elif t == "split":
            try:
                p = int(d.get("percent_a", 50))
            except (TypeError, ValueError):
                p = 0
            if not 1 <= p <= 99:
                issues.append(Issue(nid, "Split between 1% and 99%"))
        elif t == "update_contact":
            action = d.get("action")
            if action in ("add_tag", "remove_tag"):
                if not _owned(db, Tag, d.get("tag_id"), app_id):
                    issues.append(Issue(nid, "Choose a tag"))
            elif action in ("add_to_list", "remove_from_list"):
                if not _owned(db, ContactList, d.get("list_id"), app_id):
                    issues.append(Issue(nid, "Choose a list"))
            else:
                issues.append(Issue(nid, "Choose what to change"))
    return issues


def channel_issues(db: Session, ctx, w: Workflow, g: Graph) -> list[Issue]:
    """Build the hidden campaigns and run each channel's own compliance checks (minus audience)."""
    from app.services.email.campaigns import readiness as email_ready
    from app.services.sms.campaigns import readiness as sms_ready
    from app.services.voice.campaigns import readiness as voice_ready

    issues: list[Issue] = []
    mapping = dict(w.node_campaigns or {})
    for nid, n in g.nodes.items():
        if n.get("type") not in SEND_TYPES:
            continue
        c = actions.upsert_campaign(db, w, n)
        mapping[nid] = c.id
        w.node_campaigns = mapping
        checks, _ = {"send_email": email_ready, "send_sms": sms_ready, "voice_call": voice_ready}[n["type"]](db, ctx, c)
        for ch in checks:
            if not ch.ok and ch.key not in ("audience", "sender", "caller", "message", "content"):
                issues.append(Issue(nid, f"{ch.label}: {ch.detail}"))
    w.node_campaigns = mapping
    return issues


def validate(db: Session, ctx, w: Workflow, deep: bool = False) -> list[Issue]:
    g = Graph.load(w.graph)
    issues = structural_issues(g)
    issues += node_issues(db, ctx, g)
    if deep and not issues:
        issues += channel_issues(db, ctx, w, g)
    return issues


def issues_out(issues: list[Issue]) -> list[dict]:
    return [{"node_id": i.node_id, "message": i.message} for i in issues]


# ------------------------------------------------------------------ CRUD


def list_workflows(db: Session, ctx: AppContext, params: PageParams, status: str | None, search: str | None) -> Page:
    ctx.require(Perm.AUTOMATION_READ)
    q = select(Workflow).where(Workflow.application_id == ctx.application_id)
    q = q.where(Workflow.status == status) if status else q.where(Workflow.status != "archived")
    if search:
        q = q.where(func.lower(Workflow.name).like(f"%{search.strip().lower()}%"))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = list(db.scalars(q.order_by(Workflow.updated_at.desc()).offset(params.offset).limit(params.page_size)))
    counts = run_counts(db, [w.id for w in rows])
    items = [{**summary(w), "runs": counts.get(w.id, {})} for w in rows]
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def summary(w: Workflow) -> dict:
    trig = Graph.load(w.published_graph or w.graph).trigger()
    return {"id": w.id, "name": w.name, "description": w.description, "status": w.status, "version": w.version,
            "has_unpublished_changes": w.has_unpublished_changes, "allow_reentry": w.allow_reentry,
            "trigger": data(trig).get("kind") if trig else None,
            "steps": max(len((w.graph or {}).get("nodes", [])) - 1, 0),
            "activated_at": w.activated_at.isoformat() if w.activated_at else None,
            "created_at": w.created_at.isoformat(), "updated_at": w.updated_at.isoformat()}


def detail(db: Session, w: Workflow) -> dict:
    return {**summary(w), "graph": w.graph, "published_graph": w.published_graph,
            "runs": run_counts(db, [w.id]).get(w.id, {})}


def run_counts(db: Session, ids: list[str]) -> dict[str, dict[str, int]]:
    if not ids:
        return {}
    out: dict[str, dict[str, int]] = {}
    for wid, status, n in db.execute(select(WorkflowRun.workflow_id, WorkflowRun.status, func.count())
                                     .where(WorkflowRun.workflow_id.in_(ids))
                                     .group_by(WorkflowRun.workflow_id, WorkflowRun.status)):
        out.setdefault(wid, {})[status] = n
    return out


def create_workflow(db: Session, ctx: AppContext, name: str, description: str | None, graph: dict | None) -> Workflow:
    ctx.require(Perm.AUTOMATION_WRITE)
    w = Workflow(organization_id=ctx.organization_id, application_id=ctx.application_id, name=name.strip(),
                 description=description, status="draft", created_by_id=ctx.user.id, node_campaigns={},
                 published_graph={}, has_unpublished_changes=True,
                 graph=graph or {"nodes": [{"id": "trigger", "type": "trigger", "position": {"x": 0, "y": 0},
                                            "data": {"kind": "contact_created"}}], "edges": []})
    db.add(w)
    db.flush()
    _audit(db, ctx, "created", w)
    return w


def update_workflow(db: Session, ctx: AppContext, workflow_id: str, changes: dict) -> Workflow:
    ctx.require(Perm.AUTOMATION_WRITE)
    w = _get(db, ctx, workflow_id)
    if w.status == "archived":
        raise Conflict("Archived workflows cannot be edited", code="NOT_EDITABLE")
    if "graph" in changes and changes["graph"] is not None:
        g = changes["graph"]
        if len(g.get("nodes", [])) > 100 or len(g.get("edges", [])) > 300:
            raise ValidationFailed("Workflows can have up to 100 steps", code="WORKFLOW_TOO_LARGE")
        w.graph = g
        # Only a real difference from what is live counts as an unpublished change.
        w.has_unpublished_changes = w.version == 0 or g != (w.published_graph or {})
    for k in ("name", "description", "allow_reentry"):
        if changes.get(k) is not None:
            setattr(w, k, changes[k].strip() if isinstance(changes[k], str) else changes[k])
    return w


def publish(db: Session, ctx: AppContext, workflow_id: str, activate: bool) -> Workflow:
    ctx.require(Perm.AUTOMATION_WRITE)
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    w = _get(db, ctx, workflow_id)
    if w.status == "archived":
        raise Conflict("Archived workflows cannot be published")
    issues = validate(db, ctx, w, deep=True)
    if issues:
        raise ValidationFailed("Fix the highlighted steps before publishing", code="WORKFLOW_INVALID",
                               details=issues_out(issues))
    g = Graph.load(w.graph)
    for nid, n in g.nodes.items():
        if n.get("type") in SEND_TYPES:
            c = db.get(CAMPAIGN_MODEL[n["type"]], w.node_campaigns[nid])
            actions.freeze(db, w, n, c)
    w.published_graph, w.version, w.has_unpublished_changes = w.graph, w.version + 1, False
    if activate and w.status in ("draft", "paused"):
        if w.status == "draft":
            w.activated_at, w.trigger_cursor = utcnow(), None
        w.status = "active"
    _audit(db, ctx, "published", w, {"version": w.version, "status": w.status})
    return w


def pause(db: Session, ctx: AppContext, workflow_id: str) -> Workflow:
    ctx.require(Perm.AUTOMATION_WRITE)
    w = _get(db, ctx, workflow_id)
    if w.status != "active":
        raise Conflict("Only active workflows can be paused")
    w.status = "paused"
    _audit(db, ctx, "paused", w)
    return w


def resume(db: Session, ctx: AppContext, workflow_id: str) -> Workflow:
    ctx.require(Perm.AUTOMATION_WRITE)
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    w = _get(db, ctx, workflow_id)
    if w.status != "paused":
        raise Conflict("Only paused workflows can be resumed")
    w.status = "active"
    _audit(db, ctx, "resumed", w)
    return w


def archive(db: Session, ctx: AppContext, workflow_id: str) -> Workflow:
    ctx.require(Perm.AUTOMATION_WRITE)
    w = _get(db, ctx, workflow_id)
    w.status = "archived"
    now = utcnow()
    db.execute(update(WorkflowRun).where(WorkflowRun.workflow_id == w.id, WorkflowRun.status.in_(("waiting", "running")))
               .values(status="exited", exit_reason="Workflow was archived", finished_at=now, updated_at=now))
    _audit(db, ctx, "archived", w)
    return w


def delete_workflow(db: Session, ctx: AppContext, workflow_id: str) -> None:
    ctx.require(Perm.AUTOMATION_WRITE)
    w = _get(db, ctx, workflow_id)
    if w.version > 0:
        raise Conflict("Published workflows keep their history. Archive it instead.", code="NOT_DELETABLE")
    db.delete(w)
    _audit(db, ctx, "deleted", w)


def duplicate(db: Session, ctx: AppContext, workflow_id: str) -> Workflow:
    ctx.require(Perm.AUTOMATION_WRITE)
    src = _get(db, ctx, workflow_id)
    return create_workflow(db, ctx, f"{src.name} (copy)"[:160], src.description, src.graph)


# ------------------------------------------------------------------ reporting


def node_stats(db: Session, ctx: AppContext, workflow_id: str) -> dict:
    ctx.require(Perm.AUTOMATION_READ)
    w = _get(db, ctx, workflow_id)
    per: dict[str, dict] = {}
    for nid, outcome, n in db.execute(select(WorkflowStep.node_id, WorkflowStep.outcome, func.count())
                                      .where(WorkflowStep.workflow_id == w.id)
                                      .group_by(WorkflowStep.node_id, WorkflowStep.outcome)):
        per.setdefault(nid, {})[outcome] = n
    for nid, n in db.execute(select(WorkflowRun.current_node_id, func.count()).where(
            WorkflowRun.workflow_id == w.id, WorkflowRun.status == "waiting").group_by(WorkflowRun.current_node_id)):
        if nid:
            per.setdefault(nid, {})["here_now"] = n
    g = Graph.load(w.published_graph)
    channel: dict[str, dict] = {}
    for nid, cid in (w.node_campaigns or {}).items():
        n = g.nodes.get(nid)
        if not n:
            continue
        if n["type"] == "send_email":
            from app.services.email.campaigns import stats_for
        elif n["type"] == "send_sms":
            from app.services.sms.campaigns import stats_for
        else:
            from app.services.voice.campaigns import stats_for
        st = stats_for(db, [cid]).get(cid)
        channel[nid] = st.model_dump() if st else {}
    since = utcnow() - timedelta(days=30)
    entered = db.scalar(select(func.count()).select_from(WorkflowRun).where(WorkflowRun.workflow_id == w.id,
                                                                             WorkflowRun.started_at >= since)) or 0
    return {"nodes": per, "channel": channel, "runs": run_counts(db, [w.id]).get(w.id, {}), "entered_30d": entered}


def list_runs(db: Session, ctx: AppContext, workflow_id: str, params: PageParams, status: str | None) -> Page:
    ctx.require(Perm.AUTOMATION_READ)
    from app.models import Contact

    w = _get(db, ctx, workflow_id)
    q = select(WorkflowRun, Contact).outerjoin(Contact, Contact.id == WorkflowRun.contact_id).where(
        WorkflowRun.workflow_id == w.id)
    if status:
        q = q.where(WorkflowRun.status == status)
    total = db.scalar(select(func.count()).select_from(WorkflowRun).where(
        WorkflowRun.workflow_id == w.id, *([WorkflowRun.status == status] if status else []))) or 0
    g = Graph.load(w.published_graph)
    items = []
    for r, c in db.execute(q.order_by(WorkflowRun.started_at.desc()).offset(params.offset).limit(params.page_size)):
        node = g.nodes.get(r.current_node_id or "")
        items.append({"id": r.id, "contact_id": r.contact_id,
                      "contact": (c.full_name or c.email or c.phone) if c else "Deleted contact",
                      "status": r.status, "current_step": label(node) if node else None,
                      "wake_at": r.wake_at.isoformat() if r.wake_at else None, "exit_reason": r.exit_reason,
                      "started_at": r.started_at.isoformat(),
                      "finished_at": r.finished_at.isoformat() if r.finished_at else None})
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def run_steps(db: Session, ctx: AppContext, workflow_id: str, run_id: str) -> list[dict]:
    ctx.require(Perm.AUTOMATION_READ)
    w = _get(db, ctx, workflow_id)
    rows = db.scalars(select(WorkflowStep).where(WorkflowStep.workflow_id == w.id, WorkflowStep.run_id == run_id)
                      .order_by(WorkflowStep.created_at, WorkflowStep.id))
    g = Graph.load(w.published_graph)
    return [{"node_id": s.node_id, "node_type": s.node_type,
             "label": label(g.nodes[s.node_id]) if s.node_id in g.nodes else s.node_type,
             "outcome": s.outcome, "detail": s.detail, "at": s.created_at.isoformat()} for s in rows]


def stop_run(db: Session, ctx: AppContext, workflow_id: str, run_id: str) -> None:
    ctx.require(Perm.AUTOMATION_WRITE)
    w = _get(db, ctx, workflow_id)
    r = db.scalar(select(WorkflowRun).where(WorkflowRun.id == run_id, WorkflowRun.workflow_id == w.id))
    if r is None:
        raise NotFound("Enrollment not found")
    if r.status in ("waiting", "running"):
        r.status, r.exit_reason, r.finished_at = "exited", f"Stopped by {ctx.user.full_name}", utcnow()
