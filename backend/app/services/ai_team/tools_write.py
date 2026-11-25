"""Write tools. None of them runs when the model asks: `prepare` checks the arguments, resolves names to records
and describes the change for a confirmation card; `run` (execute) happens only after a person confirms (or an
agent in auto mode acts for its owner). Deleting, sending, launching, billing and role changes are not tools
at all (see guide.NEVER)."""
import html
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.permissions import Perm
from app.services.ai_team import lookup
from app.services.ai_team.registry import Prepared, Tool, ToolError, app_path, link, obj, register, result
from app.services.ai_team.tools_read import CONDITION, LIFECYCLE, segment_rules

TASK_TYPES = ["call", "email", "meeting", "follow_up", "todo"]


def _f(label: str, value) -> dict:
    return {"label": label, "value": "" if value is None else str(value)[:300]}


def _contact_fields(db: Session, ctx, a: dict, required: bool = False) -> tuple[dict, list[dict]]:
    """Resolve contact_id / contact_query to a contact id stored in the arguments."""
    c = lookup.contact(db, ctx, a.get("contact_id"), a.get("contact_query"), required=required)
    a = {k: v for k, v in a.items() if k != "contact_query"}
    if c is not None:
        a["contact_id"] = c.id
        return a, [_f("Contact", f"{lookup.contact_name(c)}{' · ' + c.email if c.email else ''}")]
    a.pop("contact_id", None)
    return a, []


# ------------------------------------------------------------------ CRM: tasks, deals, notes, owners


def _prep_task(db: Session, ctx, a: dict) -> Prepared:
    query = a.get("contact_query")
    a, fields = _contact_fields(db, ctx, a) if (a.get("contact_id") or query) else (a, [])
    if query and not a.get("contact_id"):
        fields = [_f("Contact", f"No contact matches “{query}”: the task won't be linked to one")]
    if a.get("deal_id"):
        d = lookup.deal(db, ctx, a["deal_id"])
        fields.append(_f("Deal", d.title))
    due = lookup.due_time(ctx, a.pop("due_at", None), a.pop("due_in_days", None))
    if due is not None:
        a["due_at"] = due.isoformat()
    if a.get("assignee"):
        a["assignee_id"] = lookup.team_member(db, ctx, a.pop("assignee"))
    a.setdefault("type", "todo")
    who = lookup.user_name(db, a.get("assignee_id")) if a.get("assignee_id") else "Contact owner, or you"
    return Prepared(a, f"Create task: {a['title']}"[:200],
                    [_f("Title", a["title"]), _f("Type", a["type"].replace("_", " ")),
                     _f("Due", lookup.fmt_time(ctx, due)), _f("Assignee", who), *fields,
                     *([_f("Notes", a["notes"])] if a.get("notes") else [])])


def _run_task(db: Session, ctx, a: dict) -> dict:
    from datetime import datetime

    from app.schemas.crm import TaskCreate
    from app.services.crm import work

    t = work.create_task(db, ctx, TaskCreate(
        title=a["title"], type=a.get("type") or "todo", priority=a.get("priority") or "normal",
        due_at=datetime.fromisoformat(a["due_at"]) if a.get("due_at") else None, notes=a.get("notes"),
        assignee_id=a.get("assignee_id"), contact_id=a.get("contact_id"), deal_id=a.get("deal_id")))
    href = app_path(ctx, f"/crm/tasks?task={t.id}")
    return result(f"Created task **{t.title}**, due {lookup.fmt_time(ctx, t.due_at)} for "
                  f"{lookup.user_name(db, t.assignee_id)}.", {"task_id": t.id}, [link("Open task", href)])


register(Tool(
    "create_task", "Create a CRM task (a call, email, meeting, follow-up or to-do), optionally for a contact or a "
    "deal. Use due_in_days (0 = today, 1 = tomorrow) or due_at (YYYY-MM-DD or ISO date-time).",
    obj({"title": {"type": "string", "maxLength": 200}, "type": {"type": "string", "enum": TASK_TYPES},
         "priority": {"type": "string", "enum": ["low", "normal", "high"]},
         "due_in_days": {"type": "integer", "minimum": 0, "maximum": 365},
         "due_at": {"type": "string", "maxLength": 40}, "notes": {"type": "string", "maxLength": 5000},
         "contact_id": {"type": "string", "maxLength": 36},
         "contact_query": {"type": "string", "maxLength": 200, "description": "a contact's name or email"},
         "deal_id": {"type": "string", "maxLength": 36},
         "assignee": {"type": "string", "maxLength": 150, "description": "'me', a teammate's name, email or id"}},
        ["title"]),
    (Perm.CRM_WRITE,), "write", _run_task, _prep_task, "Create task", ("title", "due_at", "notes", "priority")))


def _prep_deal(db: Session, ctx, a: dict) -> Prepared:
    from app.services.crm.common import ensure_defaults
    from app.services.crm.deals import _pipeline

    a, fields = _contact_fields(db, ctx, a) if (a.get("contact_id") or a.get("contact_query")) else (a, [])
    ensure_defaults(db, ctx)
    p = _pipeline(db, ctx, a.get("pipeline_id"))
    a["pipeline_id"] = p.id
    st = lookup.stage(db, ctx, p.id, a.pop("stage")) if a.get("stage") else None
    if st is not None:
        if st.kind == "lost":
            raise ToolError("A deal can't start in a Lost stage", "INVALID_ARGUMENTS")
        a["stage_id"] = st.id
    return Prepared(a, f"Create deal: {a['title']}"[:200],
                    [_f("Title", a["title"]), _f("Value", f"{p.currency} {float(a.get('amount') or 0):,.0f}"),
                     _f("Pipeline", p.name), _f("Stage", st.name if st else "First stage"), *fields])


def _run_deal(db: Session, ctx, a: dict) -> dict:
    from app.schemas.crm import DealCreate
    from app.services.crm import deals

    d = deals.create_deal(db, ctx, DealCreate(title=a["title"], amount=a.get("amount") or 0,
                                               pipeline_id=a.get("pipeline_id"), stage_id=a.get("stage_id"),
                                               contact_id=a.get("contact_id"), source="ai_assistant"))
    href = app_path(ctx, f"/crm/deals/{d.id}")
    return result(f"Created deal **{d.title}**.", {"deal_id": d.id}, [link("Open deal", href)])


register(Tool(
    "create_deal", "Create a CRM deal in a pipeline (the default one when omitted), optionally linked to a contact.",
    obj({"title": {"type": "string", "maxLength": 200}, "amount": {"type": "number", "minimum": 0},
         "stage": {"type": "string", "maxLength": 80, "description": "stage name"},
         "pipeline_id": {"type": "string", "maxLength": 36}, "contact_id": {"type": "string", "maxLength": 36},
         "contact_query": {"type": "string", "maxLength": 200}}, ["title"]),
    (Perm.CRM_WRITE,), "write", _run_deal, _prep_deal, "Create deal", ("title", "amount")))


def _prep_note(db: Session, ctx, a: dict) -> Prepared:
    fields = []
    if a.get("deal_id") or a.get("deal_query"):
        d = lookup.deal(db, ctx, a.get("deal_id"), a.pop("deal_query", None))
        a["deal_id"] = d.id
        fields.append(_f("Deal", d.title))
    if a.get("contact_id") or a.get("contact_query"):
        a, more = _contact_fields(db, ctx, a, required=True)
        fields += more
    if not (a.get("deal_id") or a.get("contact_id")):
        raise ToolError("Say which contact or deal the note is for", "INVALID_ARGUMENTS")
    return Prepared(a, "Add a note", [*fields, _f("Note", a["body"])])


def _run_note(db: Session, ctx, a: dict) -> dict:
    from app.schemas.crm import NoteCreate
    from app.services.crm import work

    n = work.create_note(db, ctx, NoteCreate(body=a["body"], contact_id=a.get("contact_id"), deal_id=a.get("deal_id")))
    href = app_path(ctx, f"/crm/deals/{n.deal_id}" if n.deal_id else f"/audience/contacts/{n.contact_id}")
    return result("Note added.", {"note_id": n.id}, [link("Open record", href)])


register(Tool(
    "create_note", "Add a note to a contact or a deal.",
    obj({"body": {"type": "string", "maxLength": 20000}, "contact_id": {"type": "string", "maxLength": 36},
         "contact_query": {"type": "string", "maxLength": 200}, "deal_id": {"type": "string", "maxLength": 36},
         "deal_query": {"type": "string", "maxLength": 200}}, ["body"]),
    (Perm.CRM_WRITE,), "write", _run_note, _prep_note, "Add note", ("body",)))


def _prep_stage(db: Session, ctx, a: dict) -> Prepared:
    d = lookup.deal(db, ctx, a.get("deal_id"), a.pop("deal_query", None))
    st = lookup.stage(db, ctx, d.pipeline_id, a.pop("stage"))
    if st.kind == "lost":
        raise ToolError("Marking a deal lost needs a reason: do it from the deal page", "LOST_NEEDS_REASON",
                        link("Open deal", app_path(ctx, f"/crm/deals/{d.id}")))
    if st.id == d.stage_id:
        raise ToolError(f"“{d.title}” is already in {st.name}", "NO_CHANGE")
    from app.models import PipelineStage

    cur = db.get(PipelineStage, d.stage_id)
    return Prepared({"deal_id": d.id, "stage_id": st.id}, f"Move deal: {d.title} → {st.name}"[:200],
                    [_f("Deal", d.title), _f("From", cur.name if cur else ""), _f("To", st.name)])


def _run_stage(db: Session, ctx, a: dict) -> dict:
    from app.services.crm import deals

    d = deals.move_deal(db, ctx, a["deal_id"], a["stage_id"])
    return result(f"Moved **{d.title}**.", {"deal_id": d.id},
                  [link("Open deal", app_path(ctx, f"/crm/deals/{d.id}"))])


register(Tool(
    "update_deal_stage", "Move a deal to another stage of its pipeline (open or Won; Lost needs a reason on the deal "
    "page).",
    obj({"deal_id": {"type": "string", "maxLength": 36}, "deal_query": {"type": "string", "maxLength": 200},
         "stage": {"type": "string", "maxLength": 80}}, ["stage"]),
    (Perm.CRM_WRITE,), "write", _run_stage, _prep_stage, "Move deal"))


def _prep_owner(db: Session, ctx, a: dict) -> Prepared:
    c = lookup.contact(db, ctx, a.get("contact_id"), a.pop("contact_query", None))
    uid = lookup.team_member(db, ctx, a.get("owner") or "me")
    if uid is None:
        raise ToolError("Choose who should own the contact", "INVALID_ARGUMENTS")
    return Prepared({"contact_id": c.id, "owner_id": uid}, f"Assign {lookup.contact_name(c)} to "
                    f"{lookup.user_name(db, uid)}"[:200],
                    [_f("Contact", lookup.contact_name(c)), _f("From", lookup.user_name(db, c.owner_id)),
                     _f("To", lookup.user_name(db, uid))])


def _run_owner(db: Session, ctx, a: dict) -> dict:
    from app.schemas.crm import ContactCrmUpdate
    from app.services.crm import leads

    leads.update_contact_crm(db, ctx, a["contact_id"], ContactCrmUpdate(owner_id=a["owner_id"]))
    return result(f"Owner set to {lookup.user_name(db, a['owner_id'])}.", {"contact_id": a["contact_id"]},
                  [link("Open contact", app_path(ctx, f"/audience/contacts/{a['contact_id']}"))])


register(Tool(
    "assign_owner", "Make a teammate the owner of a contact.",
    obj({"contact_id": {"type": "string", "maxLength": 36}, "contact_query": {"type": "string", "maxLength": 200},
         "owner": {"type": "string", "maxLength": 150, "description": "'me', a teammate's name, email or id"}},
        ["owner"]),
    (Perm.CRM_WRITE,), "write", _run_owner, _prep_owner, "Assign owner"))


def _prep_assessment(db: Session, ctx, a: dict) -> Prepared:
    c = lookup.contact(db, ctx, a.get("contact_id"), a.pop("contact_query", None))
    a["contact_id"] = c.id
    return Prepared(a, f"Record lead assessment for {lookup.contact_name(c)}"[:200],
                    [_f("Contact", lookup.contact_name(c)), _f("Fit score", f"{a['score']}/100"),
                     _f("Summary", a["summary"])])


def _run_assessment(db: Session, ctx, a: dict) -> dict:
    from app.schemas.crm import NoteCreate
    from app.services.crm import work

    c = lookup.contact(db, ctx, a["contact_id"])
    attrs = dict(c.attributes or {})
    attrs["ai_fit_score"] = int(a["score"])
    c.attributes = attrs
    work.create_note(db, ctx, NoteCreate(body=f"AI lead assessment: fit {a['score']}/100.\n\n{a['summary']}",
                                         contact_id=c.id))
    return result(f"Saved the assessment ({a['score']}/100) to {lookup.contact_name(c)}.", {"contact_id": c.id},
                  [link("Open lead", app_path(ctx, f"/audience/contacts/{c.id}"))])


register(Tool(
    "record_lead_assessment", "Save a lead's fit score (0-100) to the contact (attribute ai_fit_score) with a short "
    "summary note explaining it.",
    obj({"contact_id": {"type": "string", "maxLength": 36}, "contact_query": {"type": "string", "maxLength": 200},
         "score": {"type": "integer", "minimum": 0, "maximum": 100},
         "summary": {"type": "string", "maxLength": 3000}}, ["score", "summary"]),
    (Perm.CRM_WRITE,), "write", _run_assessment, _prep_assessment, "Score lead", ("score", "summary")))


# ------------------------------------------------------------------ audience


def _prep_segment(db: Session, ctx, a: dict) -> Prepared:
    from app.services.audience import segments

    rules = segment_rules(a)
    segments.compile_rules(db, ctx, rules.model_dump())  # validates fields and operators
    p = segments.preview(db, ctx, rules, sample=0)
    conds = "; ".join(f"{c['field']} {c['operator'].replace('_', ' ')} {c.get('value', '')}".strip()
                      for c in a["conditions"])
    return Prepared(a, f"Create segment: {a['name']}"[:200],
                    [_f("Name", a["name"]), _f("Match", "all conditions" if (a.get("match") or "all") == "all"
                                                 else "any condition"),
                     _f("Conditions", conds), _f("Matches now", f"{p.count:,} contacts")])


def _run_segment(db: Session, ctx, a: dict) -> dict:
    from app.schemas.audience import SegmentCreate
    from app.services.audience import segments

    s = segments.create_segment(db, ctx, SegmentCreate(name=a["name"], description=a.get("description"),
                                                       rules=segment_rules(a)))
    return result(f"Created segment **{s.name}**.", {"segment_id": s.id},
                  [link("Open segment", app_path(ctx, f"/audience/segments/{s.id}"))])


register(Tool(
    "create_segment", "Save a dynamic segment from conditions (see preview_segment for the condition format).",
    obj({"name": {"type": "string", "maxLength": 120}, "description": {"type": "string", "maxLength": 500},
         "conditions": {"type": "array", "items": CONDITION, "maxItems": 20},
         "match": {"type": "string", "enum": ["all", "any"]}}, ["name", "conditions"]),
    (Perm.AUDIENCE_WRITE,), "write", _run_segment, _prep_segment, "Create segment", ("name",)))


def _prep_tag(db: Session, ctx, a: dict) -> Prepared:
    from app.models import Contact

    ids = list(dict.fromkeys(a.get("contact_ids") or []))
    if a.get("contact_query"):
        ids.append(lookup.contact(db, ctx, None, a.pop("contact_query")).id)
    if not ids:
        raise ToolError("Say which contacts to tag", "INVALID_ARGUMENTS")
    valid = list(db.scalars(select(Contact.id).where(Contact.application_id == ctx.application_id,
                                                     Contact.id.in_(ids))))
    if not valid:
        raise ToolError("None of those contacts were found", "NOT_FOUND")
    return Prepared({"tag": a["tag"].strip(), "contact_ids": valid}, f"Tag {len(valid)} contact"
                    f"{'s' if len(valid) != 1 else ''} “{a['tag'].strip()}”"[:200],
                    [_f("Tag", a["tag"].strip()), _f("Contacts", f"{len(valid):,}")])


def _run_tag(db: Session, ctx, a: dict) -> dict:
    from app.services.audience import collections, contacts

    tag_ids = collections.get_or_create_tags(db, ctx, [a["tag"]])
    n = contacts.add_tags(db, ctx, a["contact_ids"], tag_ids)
    return result(f"Tagged {n:,} contact{'s' if n != 1 else ''} “{a['tag']}”.", {"tagged": n},
                  [link("Open contacts", app_path(ctx, "/audience/contacts"))])


register(Tool(
    "tag_contacts", "Add a tag (created if new) to contacts, by ids (from search_contacts) or one contact by name.",
    obj({"tag": {"type": "string", "maxLength": 100},
         "contact_ids": {"type": "array", "items": {"type": "string", "maxLength": 36}, "maxItems": 500},
         "contact_query": {"type": "string", "maxLength": 200}}, ["tag"]),
    (Perm.AUDIENCE_WRITE,), "write", _run_tag, _prep_tag, "Tag contacts", ("tag",)))


# ------------------------------------------------------------------ email draft (never sent)


def text_to_html(body: str) -> str:
    paras = [p.strip() for p in re.split(r"\n\s*\n", body.strip()) if p.strip()]
    return "".join(f"<p>{html.escape(p).replace(chr(10), '<br>')}</p>" for p in paras)


def _prep_email(db: Session, ctx, a: dict) -> Prepared:
    from app.models import ContactList, Segment

    aud: dict = {"all": False, "list_ids": [], "segment_ids": [], "contact_ids": []}
    who = "No audience yet (choose it in the editor)"
    if a.get("segment_id") or a.get("segment_name"):
        s = db.get(Segment, a["segment_id"]) if a.get("segment_id") else db.scalar(select(Segment).where(
            Segment.application_id == ctx.application_id, Segment.name.ilike(a["segment_name"].strip())))
        if s is None or s.application_id != ctx.application_id:
            raise ToolError("Segment not found", "NOT_FOUND")
        aud["segment_ids"], who = [s.id], f"Segment: {s.name}"
    elif a.get("list_id"):
        lst = db.get(ContactList, a["list_id"])
        if lst is None or lst.application_id != ctx.application_id:
            raise ToolError("List not found", "NOT_FOUND")
        aud["list_ids"], who = [lst.id], f"List: {lst.name}"
    elif a.get("contact_ids") or a.get("contact_query"):
        ids = list(a.get("contact_ids") or [])
        if a.get("contact_query"):
            c = lookup.contact(db, ctx, None, a["contact_query"])
            ids.append(c.id)
        aud["contact_ids"], who = ids[:500], f"{len(ids)} chosen contact{'s' if len(ids) != 1 else ''}"
    args = {"name": a["name"], "subject": a["subject"], "body": a["body"], "audience": aud}
    return Prepared(args, f"Create draft email: {a['name']}"[:200],
                    [_f("Campaign", a["name"]), _f("Subject", a["subject"]), _f("Audience", who),
                     _f("Body", a["body"][:300] + ("…" if len(a["body"]) > 300 else "")),
                     _f("Status", "Draft: nothing is sent. You review and send it yourself.")])


def _run_email(db: Session, ctx, a: dict) -> dict:
    from app.schemas.email import Audience, CampaignCreate, CampaignUpdate
    from app.services.email import campaigns

    c = campaigns.create_campaign(db, ctx, CampaignCreate(name=a["name"], audience=Audience(**a["audience"])))
    campaigns.update_campaign(db, ctx, c.id, CampaignUpdate(subject=a["subject"], editor="html",
                                                            html=text_to_html(a["body"]), text=a["body"]))
    href = app_path(ctx, f"/email/campaigns/{c.id}/edit")
    return result(f"Created the draft **{c.name}**. Nothing was sent: review it and send it when you're ready.",
                  {"campaign_id": c.id}, [link("Review draft", href)])


register(Tool(
    "create_email_draft", "Create a DRAFT email campaign (name, subject, plain-text body, audience: a segment, a list "
    "or chosen contacts). It is never sent or scheduled: the person reviews and sends it themselves.",
    obj({"name": {"type": "string", "maxLength": 160}, "subject": {"type": "string", "maxLength": 255},
         "body": {"type": "string", "maxLength": 20000}, "segment_id": {"type": "string", "maxLength": 36},
         "segment_name": {"type": "string", "maxLength": 120}, "list_id": {"type": "string", "maxLength": 36},
         "contact_ids": {"type": "array", "items": {"type": "string", "maxLength": 36}, "maxItems": 500},
         "contact_query": {"type": "string", "maxLength": 200}}, ["name", "subject", "body"]),
    (Perm.CAMPAIGNS_WRITE,), "write", _run_email, _prep_email, "Draft email", ("name", "subject", "body")))


# ------------------------------------------------------------------ automation, forms, agents


WORKFLOW_STEP = {"type": "object", "properties": {
    "type": {"type": "string", "enum": ["wait", "create_task", "add_tag", "set_lifecycle", "send_to_slack",
                                        "ai_step"]},
    "amount": {"type": "integer", "minimum": 1, "maximum": 365}, "unit": {"type": "string",
                                                                          "enum": ["minutes", "hours", "days"]},
    "title": {"type": "string", "maxLength": 200}, "due_in_hours": {"type": "integer", "minimum": 0, "maximum": 2160},
    "tag": {"type": "string", "maxLength": 100}, "stage": {"type": "string", "enum": LIFECYCLE},
    "channel": {"type": "string", "maxLength": 80}, "message": {"type": "string", "maxLength": 3000},
    "mode": {"type": "string", "enum": ["classify", "extract", "write"]},
    "prompt": {"type": "string", "maxLength": 2000}, "output_field": {"type": "string", "maxLength": 60}},
    "required": ["type"]}


def build_graph(a: dict, tag_ids: dict[str, str] | None = None, channels: dict[str, dict] | None = None) -> dict:
    trig_data = {"kind": a["trigger"]}
    for k in ("form_id", "bot_id", "pipeline_id", "stage_id", "interest"):
        if a.get(k):
            trig_data[k] = a[k]
    nodes = [{"id": "trigger", "type": "trigger", "position": {"x": 0, "y": 0}, "data": trig_data}]
    for i, s in enumerate(a.get("steps") or []):
        nid, t = f"n{i + 1}", s["type"]
        if t == "wait":
            node = {"type": "wait", "data": {"amount": s.get("amount") or 1, "unit": s.get("unit") or "days"}}
        elif t == "create_task":
            node = {"type": "crm_action", "data": {"action": "create_task", "title": s.get("title") or "Follow up with "
                                                   "{{name}}", "task_type": "follow_up",
                                                   "due_in_hours": s.get("due_in_hours") or 24}}
        elif t == "add_tag":
            node = {"type": "update_contact", "data": {"action": "add_tag",
                                                       "tag_id": (tag_ids or {}).get((s.get("tag") or "").lower())}}
        elif t == "set_lifecycle":
            node = {"type": "crm_action", "data": {"action": "set_lifecycle", "lifecycle_stage": s.get("stage")}}
        elif t == "send_to_slack":
            ch = (channels or {}).get((s.get("channel") or "").lstrip("#").lower()) or {}
            node = {"type": "slack_message", "data": {"channel_id": ch.get("id"), "channel_name": ch.get("name"),
                                                      "message": s.get("message") or ""}}
        else:
            node = {"type": "ai_step", "data": {"mode": s.get("mode") or "classify", "prompt": s.get("prompt") or "",
                                                "output_field": s.get("output_field") or ""}}
        nodes.append({"id": nid, "position": {"x": 0, "y": 140 * (i + 1)}, **node})
    edges = [{"id": f"e{i}", "source": nodes[i]["id"], "target": nodes[i + 1]["id"]} for i in range(len(nodes) - 1)]
    return {"nodes": nodes, "edges": edges}


STEP_TEXT = {"wait": lambda s: f"Wait {s.get('amount') or 1} {s.get('unit') or 'days'}",
             "create_task": lambda s: f"Create task “{s.get('title') or 'Follow up'}”",
             "add_tag": lambda s: f"Add tag “{s.get('tag')}”",
             "set_lifecycle": lambda s: f"Set lifecycle to {s.get('stage')}",
             "send_to_slack": lambda s: f"Send to Slack #{(s.get('channel') or '?').lstrip('#')}",
             "ai_step": lambda s: f"AI step ({s.get('mode') or 'classify'})"}


def _prep_workflow(db: Session, ctx, a: dict) -> Prepared:
    from app.services.automation.graph import TRIGGER_NAMES, TRIGGERS, Graph, structural_issues

    if a["trigger"] not in TRIGGERS:
        raise ToolError(f"Unknown trigger. Use one of: {', '.join(TRIGGERS)}", "INVALID_ARGUMENTS")
    if a["trigger"] in ("added_to_list", "tag_added", "segment_entered"):
        raise ToolError("That trigger needs a list, tag or segment picked in the builder: start from “Contact is "
                        "created” or an event trigger and change it in the builder", "INVALID_ARGUMENTS")
    issues = structural_issues(Graph.load(build_graph(a)))
    if issues and a.get("steps"):
        raise ToolError(issues[0].message, "INVALID_WORKFLOW")
    steps = " → ".join(STEP_TEXT[s["type"]](s) for s in a.get("steps") or []) or "No steps yet"
    return Prepared(a, f"Create draft workflow: {a['name']}"[:200],
                    [_f("Name", a["name"]), _f("Trigger", TRIGGER_NAMES.get(a["trigger"], a["trigger"])),
                     _f("Steps", steps), _f("Status", "Draft: it won't run until you publish it")])


def _run_workflow(db: Session, ctx, a: dict) -> dict:
    from app.services.audience import collections
    from app.services.automation import workflows

    tags = [s["tag"] for s in a.get("steps") or [] if s["type"] == "add_tag" and s.get("tag")]
    tag_ids = {t.lower(): collections.get_or_create_tags(db, ctx, [t])[0] for t in tags}
    channels = {}
    if any(s["type"] == "send_to_slack" for s in a.get("steps") or []):
        from app.services.ai_team import slack

        try:
            channels = {c["name"].lower(): c for c in slack.list_channels(db, ctx.organization_id)}
        except ToolError:
            channels = {}
    w = workflows.create_workflow(db, ctx, a["name"], a.get("description"), build_graph(a, tag_ids, channels))
    problems = workflows.validate(db, ctx, w)
    href = app_path(ctx, f"/automation/{w.id}")
    text = f"Created the draft workflow **{w.name}**."
    if problems:
        text += " Before publishing, finish these in the builder:\n" + "\n".join(f"- {p.message}" for p in problems[:5])
    else:
        text += " It's valid: review it and publish when you're ready."
    return result(text, {"workflow_id": w.id, "issues": [p.message for p in problems]}, [link("Open builder", href)])


register(Tool(
    "create_workflow_draft", "Create a DRAFT automation workflow from a trigger and a list of steps (wait, "
    "create_task, add_tag, set_lifecycle, send_to_slack, ai_step). It is validated and saved as a draft; it never "
    "runs until the person publishes it. Triggers: contact_created, form_submitted, chat_lead_captured, "
    "chat_conversation_closed, ai_call_completed, deal_created, deal_stage_changed, deal_won, deal_lost, "
    "deal_rotting, score_reached, sla_breached, owner_assigned, email_clicked, call_answered, unsubscribed.",
    obj({"name": {"type": "string", "maxLength": 160}, "description": {"type": "string", "maxLength": 500},
         "trigger": {"type": "string", "maxLength": 40}, "form_id": {"type": "string", "maxLength": 36},
         "steps": {"type": "array", "items": WORKFLOW_STEP, "maxItems": 20}}, ["name", "trigger"]),
    (Perm.AUTOMATION_WRITE,), "write", _run_workflow, _prep_workflow, "Draft workflow", ("name",)))


def _prep_form(db: Session, ctx, a: dict) -> Prepared:
    from app.services.forms import templates

    tpl = a.get("template") or "contact"
    if tpl not in templates.TEMPLATES:
        raise ToolError(f"Templates: {', '.join(templates.TEMPLATES)}", "INVALID_ARGUMENTS")
    a["template"] = tpl
    return Prepared(a, f"Create lead form: {a['name']}"[:200],
                    [_f("Name", a["name"]), _f("Template", templates.TEMPLATES[tpl]["name"]),
                     _f("Status", "Draft: publish it from the form page")])


def _run_form(db: Session, ctx, a: dict) -> dict:
    from app.services.forms import service

    f = service.create_form(db, ctx, a["name"], a["template"])
    return result(f"Created the lead form **{f.name}** (draft).", {"form_id": f.id},
                  [link("Open form", app_path(ctx, f"/forms/{f.id}"))])


register(Tool(
    "create_lead_form", "Create a draft lead form from a template: newsletter, contact, demo, event, guide, "
    "callback or blank.",
    obj({"name": {"type": "string", "maxLength": 120}, "template": {"type": "string", "maxLength": 40}}, ["name"]),
    (Perm.FORMS_WRITE,), "write", _run_form, _prep_form, "Create form", ("name",)))


def _prep_agent(db: Session, ctx, a: dict) -> Prepared:
    from app.services.ai_team import agents

    cfg = agents.draft_config(db, ctx, a)
    return Prepared({"config": cfg}, f"Create AI agent: {cfg['name']}"[:200],
                    [_f("Name", cfg["name"]), _f("Starts", agents.describe_trigger(cfg["trigger"])),
                     _f("Mode", "Asks for approval" if cfg["mode"] == "approve" else "Acts on its own"),
                     _f("Tools", ", ".join(cfg["allowed_tools"])), _f("Status", "Off until you switch it on")])


def _run_agent(db: Session, ctx, a: dict) -> dict:
    from app.services.ai_team import agents

    ag = agents.create_agent(db, ctx, a["config"])
    return result(f"Created the agent **{ag.name}** (switched off). Review it and switch it on.", {"agent_id": ag.id},
                  [link("Open agent", app_path(ctx, f"/ai/agents/{ag.id}"))])


register(Tool(
    "create_ai_agent", "Create an AI agent (switched off) from a template key or a description. Templates: "
    "lead_qualifier, hot_lead_alert, stale_deal_watchdog, daily_report, weekly_campaign_report, chat_followup, "
    "balance_alert, unanswered_digest.",
    obj({"name": {"type": "string", "maxLength": 120}, "template": {"type": "string", "maxLength": 40},
         "description": {"type": "string", "maxLength": 500}, "instructions": {"type": "string", "maxLength": 4000}}),
    (Perm.AI_MANAGE,), "write", _run_agent, _prep_agent, "Create agent", ("name",)))


def _prep_slack(db: Session, ctx, a: dict) -> Prepared:
    from app.services.ai_team import slack

    ch = slack.find_channel(db, ctx.organization_id, a["channel"])
    return Prepared({"channel_id": ch["id"], "channel_name": ch["name"], "text": a["text"]},
                    f"Post to Slack #{ch['name']}"[:200],
                    [_f("Channel", f"#{ch['name']}"), _f("Message", a["text"])])


def _run_slack(db: Session, ctx, a: dict) -> dict:
    from app.services.ai_team import slack

    slack.post(db, ctx.organization_id, a["channel_id"], a["text"],
               blocks=slack.text_blocks(a["text"], open_url=None))
    return result(f"Posted to #{a['channel_name']}.", {"channel": a["channel_name"]})


register(Tool(
    "post_to_slack", "Post a message to a channel in the organization's connected Slack workspace.",
    obj({"channel": {"type": "string", "maxLength": 80, "description": "channel name (e.g. sales) or id"},
         "text": {"type": "string", "maxLength": 3000}}, ["channel", "text"]),
    (Perm.AI_MANAGE,), "write", _run_slack, _prep_slack, "Post to Slack", ("text",)))
