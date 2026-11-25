"""Leads: CRM fields on contacts, the leads list, rule-based scoring (fit + engagement), round-robin
owner assignment, the first-response SLA, rotting deals and task reminders.

The background parts run from `tick()` (Celery Beat or the local scheduler thread)."""
from datetime import timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import ValidationFailed
from app.core.logging import get_logger
from app.core.permissions import Perm
from app.models import (
    AssignmentRule,
    Company,
    Contact,
    CrmActivity,
    CrmNote,
    CrmSettings,
    CrmTask,
    Deal,
    EmailEvent,
    PipelineStage,
    ScoringRule,
    Segment,
    SmsEvent,
    SmsInbound,
    VoiceCall,
)
from app.schemas.common import Page, PageParams
from app.schemas.crm import AssignmentRuleIn, ContactCrmUpdate, CrmSettingsIn, ScoringRuleIn
from app.services.crm.common import (
    audit,
    check_owner,
    get_in_app,
    record_event,
    settings_for,
    system_activity,
    system_ctx,
    team,
    user_ref,
    users_by_id,
)
from app.services.notification_service import notify
from app.utils.time import utcnow

log = get_logger(__name__)
OPEN_LIFECYCLE = ("subscriber", "lead", "mql", "sql", "opportunity")
FIT_FIELDS = {"country", "state", "city", "source", "lifecycle_stage", "company", "email", "phone", "phone_type",
              "timezone", "company.industry", "company.size", "company.country", "company.state"}
SCORE_BATCH = 2000


# ------------------------------------------------------------------ grades

def grade(fit: int, engagement: int, threshold: int) -> str:
    t = max(threshold, 4)
    letter = "A" if fit >= t / 2 else "B" if fit >= t / 4 else "C"
    number = "1" if engagement >= t / 2 else "2" if engagement >= t / 4 else "3"
    return letter + number


# ------------------------------------------------------------------ contact CRM fields

def contact_crm(db: Session, ctx, contact_id: str) -> dict:
    ctx.require(Perm.CRM_READ)
    c = get_in_app(db, ctx, Contact, contact_id, "Contact")
    s = settings_for(db, ctx.organization_id, ctx.application_id)
    owner = users_by_id(db, [c.owner_id]).get(c.owner_id)
    company = db.get(Company, c.company_id) if c.company_id else None
    return {"contact_id": c.id, "owner": user_ref(owner), "company": {"id": company.id, "name": company.name}
            if company else None, "lifecycle_stage": c.lifecycle_stage, "fit_score": c.fit_score,
            "engagement_score": c.engagement_score, "lead_score": c.lead_score,
            "grade": grade(c.fit_score, c.engagement_score, s.hot_score_threshold),
            "hot": c.lead_score >= s.hot_score_threshold, "sla_due_at": c.sla_due_at,
            "first_response_at": c.first_response_at, "sla_breached_at": c.sla_breached_at,
            "open_deals": db.scalar(select(func.count()).select_from(Deal).where(
                Deal.contact_id == c.id, Deal.status == "open")) or 0,
            "open_tasks": db.scalar(select(func.count()).select_from(CrmTask).where(
                CrmTask.contact_id == c.id, CrmTask.status == "open")) or 0}


def update_contact_crm(db: Session, ctx, contact_id: str, data: ContactCrmUpdate) -> dict:
    ctx.require(Perm.CRM_WRITE)
    c = get_in_app(db, ctx, Contact, contact_id, "Contact")
    if data.clear_owner:
        c.owner_id = None
    elif data.owner_id is not None and data.owner_id != c.owner_id:
        c.owner_id = check_owner(db, ctx, data.owner_id)
        _assigned(db, c, by_user=ctx.user.id if ctx.user else None)
    if data.clear_company:
        c.company_id = None
    elif data.company_id is not None:
        co = get_in_app(db, ctx, Company, data.company_id, "Company")
        c.company_id, c.company = co.id, co.name
    if data.lifecycle_stage is not None and data.lifecycle_stage != c.lifecycle_stage:
        system_activity(db, ctx.organization_id, ctx.application_id,
                        f"Lifecycle stage: {c.lifecycle_stage} → {data.lifecycle_stage}",
                        actor_id=ctx.user.id if ctx.user else None, contact_id=c.id)
        c.lifecycle_stage = data.lifecycle_stage
    audit(db, ctx, "contact.crm_updated", "contact", c.id, "Updated CRM fields",
          {"fields": sorted(data.model_dump(exclude_unset=True))})
    return contact_crm(db, ctx, c.id)


def _assigned(db: Session, c: Contact, by_user: str | None = None, rule: AssignmentRule | None = None) -> None:
    record_event(db, c.organization_id, c.application_id, "owner_assigned", contact_id=c.id,
                 data={"owner_id": c.owner_id, "object": "contact", "rule_id": rule.id if rule else None})
    system_activity(db, c.organization_id, c.application_id,
                    f"Owner assigned{' by rule ' + rule.name if rule else ''}", actor_id=by_user, contact_id=c.id,
                    meta={"owner_id": c.owner_id})
    if c.owner_id and c.owner_id != by_user:
        name = c.full_name or c.email or c.phone or "a contact"
        notify(db, c.owner_id, type_="crm_lead_assigned", title=f"New lead assigned: {name}"[:160],
               body=f"Respond by {c.sla_due_at:%d %b %H:%M} UTC" if c.sla_due_at else None,
               link=f"/apps/{c.application_id}/audience/contacts/{c.id}", organization_id=c.organization_id,
               application_id=c.application_id, level="info")


def list_leads(db: Session, ctx, params: PageParams, *, owner_id: str | None = None, lifecycle: str | None = None,
               min_score: int | None = None, sla: str | None = None, search: str | None = None,
               unassigned: bool = False, sort: str = "-lead_score", tag_id: str | None = None,
               list_id: str | None = None, segment_id: str | None = None) -> Page:
    ctx.require(Perm.CRM_READ)
    s = settings_for(db, ctx.organization_id, ctx.application_id)
    q = select(Contact).where(Contact.application_id == ctx.application_id)
    q = audience_filter(db, ctx, q, tag_id=tag_id, list_id=list_id, segment_id=segment_id)
    if owner_id:
        q = q.where(Contact.owner_id == (ctx.user.id if owner_id == "me" else owner_id))
    if unassigned:
        q = q.where(Contact.owner_id.is_(None))
    if lifecycle:
        q = q.where(Contact.lifecycle_stage == lifecycle)
    if min_score is not None:
        q = q.where(Contact.lead_score >= min_score)
    if sla == "breached":
        q = q.where(Contact.sla_breached_at.is_not(None), Contact.first_response_at.is_(None))
    elif sla == "due":
        q = q.where(Contact.sla_due_at.is_not(None), Contact.first_response_at.is_(None),
                    Contact.sla_breached_at.is_(None))
    if search:
        like = f"%{search.strip()}%"
        q = q.where(or_(Contact.first_name.ilike(like), Contact.last_name.ilike(like), Contact.email.ilike(like),
                        Contact.phone.ilike(like), Contact.company.ilike(like)))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    order = {"-lead_score": Contact.lead_score.desc(), "lead_score": Contact.lead_score,
             "-created_at": Contact.created_at.desc(), "sla_due_at": Contact.sla_due_at,
             "-engagement_score": Contact.engagement_score.desc()}.get(sort, Contact.lead_score.desc())
    rows = list(db.scalars(q.order_by(order, Contact.id).offset(params.offset).limit(params.page_size)))
    users = users_by_id(db, [r.owner_id for r in rows])
    companies = {c.id: c for c in db.scalars(select(Company).where(
        Company.id.in_({r.company_id for r in rows if r.company_id})))} if rows else {}
    items = [{"id": r.id, "name": r.full_name or r.email or r.phone or "Unnamed", "email": r.email, "phone": r.phone,
              "company": {"id": r.company_id, "name": companies[r.company_id].name} if r.company_id in companies
              else ({"id": "", "name": r.company} if r.company else None),
              "owner": user_ref(users.get(r.owner_id)), "lifecycle_stage": r.lifecycle_stage,
              "lead_score": r.lead_score, "fit_score": r.fit_score, "engagement_score": r.engagement_score,
              "grade": grade(r.fit_score, r.engagement_score, s.hot_score_threshold), "source": r.source,
              "sla_due_at": r.sla_due_at, "sla_breached_at": r.sla_breached_at,
              "first_response_at": r.first_response_at, "created_at": r.created_at} for r in rows]
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def audience_filter(db: Session, ctx, q, *, tag_id: str | None = None, list_id: str | None = None,
                    segment_id: str | None = None):
    """Narrow a Contact query by audience tag, list or segment membership."""
    if tag_id or list_id or segment_id:
        from app.schemas.audience import ContactFilters
        from app.services.audience.query import apply_filters

        q = apply_filters(db, ctx, q, ContactFilters(tag_id=tag_id, list_id=list_id, segment_id=segment_id))
    return q


def bulk_assign_owner(db: Session, ctx, contacts: list[Contact], owner_id: str | None) -> int:
    """Set (or clear) the owner of many contacts, recording the same history as a single update."""
    ctx.require(Perm.CRM_WRITE)
    owner = check_owner(db, ctx, owner_id) if owner_id else None
    actor = ctx.user.id if ctx.user else None
    n = 0
    for c in contacts:
        if c.owner_id == owner:
            continue
        c.owner_id = owner
        n += 1
        if owner:
            _assigned(db, c, by_user=actor)
        else:
            system_activity(db, ctx.organization_id, ctx.application_id, "Owner removed", actor_id=actor,
                            contact_id=c.id)
    return n


def bulk_set_lifecycle(db: Session, ctx, contacts: list[Contact], stage: str) -> int:
    """Change the lifecycle stage of many contacts, with the same timeline entry as a single update."""
    ctx.require(Perm.CRM_WRITE)
    actor = ctx.user.id if ctx.user else None
    n = 0
    for c in contacts:
        if c.lifecycle_stage == stage:
            continue
        system_activity(db, ctx.organization_id, ctx.application_id,
                        f"Lifecycle stage: {c.lifecycle_stage} → {stage}", actor_id=actor, contact_id=c.id)
        c.lifecycle_stage = stage
        n += 1
    return n


def team_out(db: Session, ctx) -> list[dict]:
    ctx.require(Perm.CRM_READ)
    users = team(db, ctx.organization_id, ctx.application_id)
    return sorted((user_ref(u) for u in users.values()), key=lambda u: u["full_name"].lower())


# ------------------------------------------------------------------ settings and rules

def get_settings(db: Session, ctx) -> CrmSettings:
    ctx.require(Perm.CRM_READ)
    return settings_for(db, ctx.organization_id, ctx.application_id)


def update_settings(db: Session, ctx, data: CrmSettingsIn) -> CrmSettings:
    ctx.require(Perm.CRM_MANAGE)
    s = settings_for(db, ctx.organization_id, ctx.application_id)
    values = data.model_dump(exclude_unset=True, exclude_none=True)
    for k, v in values.items():
        setattr(s, k, v)
    if {"engagement_window_days", "hot_score_threshold"} & set(values):
        s.scored_at = None  # rescore everyone
    audit(db, ctx, "crm_settings.updated", "crm_settings", ctx.application_id, "Updated CRM settings",
          {"fields": sorted(values)})
    return s


def list_assignment_rules(db: Session, ctx) -> list[AssignmentRule]:
    ctx.require(Perm.CRM_READ)
    return list(db.scalars(select(AssignmentRule).where(AssignmentRule.application_id == ctx.application_id)
                           .order_by(AssignmentRule.position, AssignmentRule.created_at)))


def save_assignment_rule(db: Session, ctx, data: AssignmentRuleIn, rule_id: str | None = None) -> AssignmentRule:
    ctx.require(Perm.CRM_MANAGE)
    members = team(db, ctx.organization_id, ctx.application_id)
    bad = [u for u in data.user_ids if u not in members]
    if bad:
        raise ValidationFailed("Some people in the rotation can't own CRM records here", code="INVALID_OWNER")
    if data.conditions.get("segment_id"):
        get_in_app(db, ctx, Segment, data.conditions["segment_id"], "Segment")
    if rule_id:
        r = get_in_app(db, ctx, AssignmentRule, rule_id, "Assignment rule")
    else:
        n = db.scalar(select(func.count()).select_from(AssignmentRule).where(
            AssignmentRule.application_id == ctx.application_id)) or 0
        r = AssignmentRule(organization_id=ctx.organization_id, application_id=ctx.application_id, position=n,
                           next_index=0, assigned_count=0)
        db.add(r)
    r.name, r.active, r.conditions = data.name.strip(), data.active, data.conditions
    r.user_ids, r.max_open_per_user = list(dict.fromkeys(data.user_ids)), data.max_open_per_user
    r.next_index = r.next_index % len(r.user_ids)
    db.flush()
    audit(db, ctx, "crm_assignment_rule.saved", "crm_assignment_rule", r.id, f"Saved assignment rule {r.name}")
    return r


def reorder_assignment_rules(db: Session, ctx, ids: list[str]) -> None:
    ctx.require(Perm.CRM_MANAGE)
    rules = {r.id: r for r in list_assignment_rules(db, ctx)}
    for i, rid in enumerate(ids):
        if rid in rules:
            rules[rid].position = i


def delete_assignment_rule(db: Session, ctx, rule_id: str) -> None:
    ctx.require(Perm.CRM_MANAGE)
    db.delete(get_in_app(db, ctx, AssignmentRule, rule_id, "Assignment rule"))


def list_scoring_rules(db: Session, ctx) -> list[ScoringRule]:
    ctx.require(Perm.CRM_READ)
    return list(db.scalars(select(ScoringRule).where(ScoringRule.application_id == ctx.application_id)
                           .order_by(ScoringRule.kind, ScoringRule.created_at)))


def save_scoring_rule(db: Session, ctx, data: ScoringRuleIn, rule_id: str | None = None) -> ScoringRule:
    ctx.require(Perm.CRM_MANAGE)
    if data.kind == "fit":
        if not data.field or (data.field not in FIT_FIELDS and not data.field.startswith("attr:")):
            raise ValidationFailed("Choose a contact field", code="INVALID_FIELD")
        if not data.operator:
            raise ValidationFailed("Choose how to compare", code="INVALID_OPERATOR")
        if data.operator in ("eq", "neq", "contains") and not data.value:
            raise ValidationFailed("Enter a value to compare with", code="VALUE_REQUIRED")
    elif not data.event:
        raise ValidationFailed("Choose an engagement event", code="INVALID_EVENT")
    r = get_in_app(db, ctx, ScoringRule, rule_id, "Scoring rule") if rule_id else ScoringRule(
        organization_id=ctx.organization_id, application_id=ctx.application_id)
    if not rule_id:
        db.add(r)
    for k, v in data.model_dump().items():
        setattr(r, k, v)
    if data.kind == "fit":
        r.event = None
    else:
        r.field = r.operator = r.value = None
    settings_for(db, ctx.organization_id, ctx.application_id).scored_at = None
    db.flush()
    audit(db, ctx, "crm_scoring_rule.saved", "crm_scoring_rule", r.id, "Saved a lead scoring rule")
    return r


def delete_scoring_rule(db: Session, ctx, rule_id: str) -> None:
    ctx.require(Perm.CRM_MANAGE)
    db.delete(get_in_app(db, ctx, ScoringRule, rule_id, "Scoring rule"))
    settings_for(db, ctx.organization_id, ctx.application_id).scored_at = None


# ------------------------------------------------------------------ scoring

def _field_value(c: Contact, company: Company | None, field: str) -> str | None:
    if field.startswith("attr:"):
        v = (c.attributes or {}).get(field[5:])
    elif field.startswith("company."):
        v = getattr(company, field[8:], None) if company else None
    else:
        v = getattr(c, field, None)
    return None if v is None or v == "" else str(v)


def fit_points(rule: ScoringRule, c: Contact, company: Company | None) -> int:
    v = _field_value(c, company, rule.field or "")
    want = (rule.value or "").strip().lower()
    have = (v or "").strip().lower()
    hit = {"set": v is not None, "not_set": v is None, "eq": v is not None and have == want,
           "neq": have != want, "contains": v is not None and want in have}.get(rule.operator or "", False)
    return rule.points if hit else 0


def _event_counts(db: Session, app_id: str, ids: list[str], event: str, since) -> dict[str, int]:
    def grouped(stmt):
        return dict(db.execute(stmt).all())

    if event.startswith("email_"):
        t = {"email_opened": "opened", "email_clicked": "clicked", "email_bounced": "bounced",
             "email_unsubscribed": "unsubscribed"}[event]
        return grouped(select(EmailEvent.contact_id, func.count()).where(
            EmailEvent.application_id == app_id, EmailEvent.contact_id.in_(ids), EmailEvent.type == t,
            EmailEvent.occurred_at >= since).group_by(EmailEvent.contact_id))
    if event == "sms_delivered":
        return grouped(select(SmsEvent.contact_id, func.count()).where(
            SmsEvent.application_id == app_id, SmsEvent.contact_id.in_(ids), SmsEvent.type == "delivered",
            SmsEvent.occurred_at >= since).group_by(SmsEvent.contact_id))
    if event == "sms_replied":
        phones = dict(db.execute(select(Contact.phone, Contact.id).where(Contact.id.in_(ids),
                                                                        Contact.phone.is_not(None))).all())
        if not phones:
            return {}
        rows = db.execute(select(SmsInbound.from_phone, func.count()).where(
            SmsInbound.application_id == app_id, SmsInbound.from_phone.in_(list(phones)),
            SmsInbound.keyword.is_(None), SmsInbound.received_at >= since).group_by(SmsInbound.from_phone)).all()
        return {phones[p]: n for p, n in rows}
    if event == "call_answered":
        return grouped(select(VoiceCall.contact_id, func.count()).where(
            VoiceCall.application_id == app_id, VoiceCall.contact_id.in_(ids), VoiceCall.answered_by == "human",
            VoiceCall.answered_at >= since).group_by(VoiceCall.contact_id))
    if event == "call_opted_out":
        return grouped(select(VoiceCall.contact_id, func.count()).where(
            VoiceCall.application_id == app_id, VoiceCall.contact_id.in_(ids), VoiceCall.opted_out.is_(True),
            VoiceCall.ended_at >= since).group_by(VoiceCall.contact_id))
    if event == "note_added":
        return grouped(select(CrmNote.contact_id, func.count()).where(
            CrmNote.contact_id.in_(ids), CrmNote.created_at >= since).group_by(CrmNote.contact_id))
    if event == "activity_logged":
        return grouped(select(CrmActivity.contact_id, func.count()).where(
            CrmActivity.contact_id.in_(ids), CrmActivity.type != "system", CrmActivity.occurred_at >= since)
            .group_by(CrmActivity.contact_id))
    if event == "form_submitted":
        from app.models.forms import LeadFormSubmission

        return grouped(select(LeadFormSubmission.contact_id, func.count()).where(
            LeadFormSubmission.application_id == app_id, LeadFormSubmission.contact_id.in_(ids),
            LeadFormSubmission.status != "spam", LeadFormSubmission.created_at >= since)
            .group_by(LeadFormSubmission.contact_id))
    if event == "deal_created":
        return grouped(select(Deal.contact_id, func.count()).where(
            Deal.contact_id.in_(ids), Deal.created_at >= since).group_by(Deal.contact_id))
    return {}


def score_contacts(db: Session, s: CrmSettings, contacts: list[Contact], rules: list[ScoringRule]) -> int:
    """Recompute scores for these contacts. Returns how many crossed the hot threshold upwards."""
    if not contacts:
        return 0
    ids = [c.id for c in contacts]
    since = utcnow() - timedelta(days=s.engagement_window_days)
    fit_rules = [r for r in rules if r.kind == "fit" and r.active]
    eng = {}
    for r in rules:
        if r.kind == "engagement" and r.active and r.event:
            counts = _event_counts(db, s.application_id, ids, r.event, since)
            for cid, n in counts.items():
                pts = n * r.points
                if r.max_points:
                    pts = max(-r.max_points, min(r.max_points, pts))
                eng[cid] = eng.get(cid, 0) + pts
    companies = {c.id: c for c in db.scalars(select(Company).where(
        Company.id.in_({c.company_id for c in contacts if c.company_id})))} if fit_rules else {}
    crossed = 0
    for c in contacts:
        fit = sum(fit_points(r, c, companies.get(c.company_id)) for r in fit_rules)
        engagement = eng.get(c.id, 0)
        total = fit + engagement
        if c.lead_score < s.hot_score_threshold <= total:
            crossed += 1
            record_event(db, c.organization_id, c.application_id, "score_reached", contact_id=c.id,
                         data={"score": total, "threshold": s.hot_score_threshold})
            if c.owner_id:
                notify(db, c.owner_id, type_="crm_hot_lead",
                       title=f"Hot lead: {c.full_name or c.email or c.phone or 'a contact'} scored {total}"[:160],
                       link=f"/apps/{c.application_id}/audience/contacts/{c.id}", organization_id=c.organization_id,
                       application_id=c.application_id, level="success")
        if (c.fit_score, c.engagement_score, c.lead_score) != (fit, engagement, total):
            c.fit_score, c.engagement_score, c.lead_score = fit, engagement, total
    return crossed


def rescore_application(db: Session, s: CrmSettings, full: bool = False) -> int:
    rules = list(db.scalars(select(ScoringRule).where(ScoringRule.application_id == s.application_id)))
    base = select(Contact).where(Contact.application_id == s.application_id)
    if not rules:
        if full or s.scored_at is None:  # rules removed: clear scores
            for c in db.scalars(base.where(Contact.lead_score != 0).limit(SCORE_BATCH * 5)):
                c.fit_score = c.engagement_score = c.lead_score = 0
        s.scored_at = utcnow()
        return 0
    started, done, offset = utcnow(), 0, 0
    if full or s.scored_at is None:
        # Everyone, in batches.
        while True:
            batch = list(db.scalars(base.order_by(Contact.id).offset(offset).limit(SCORE_BATCH)))
            if not batch:
                break
            score_contacts(db, s, batch, rules)
            db.flush()
            done += len(batch)
            offset += SCORE_BATCH
            if done >= SCORE_BATCH * 25:
                break
    else:
        since = s.scored_at - timedelta(minutes=2)
        recent = set(db.scalars(select(EmailEvent.contact_id).where(
            EmailEvent.application_id == s.application_id, EmailEvent.occurred_at >= since).limit(SCORE_BATCH)))
        recent |= set(db.scalars(select(SmsEvent.contact_id).where(
            SmsEvent.application_id == s.application_id, SmsEvent.occurred_at >= since).limit(SCORE_BATCH)))
        recent |= set(db.scalars(select(Contact.id).where(Contact.application_id == s.application_id, or_(
            Contact.updated_at >= since, Contact.last_activity_at >= since)).limit(SCORE_BATCH)))
        # Engagement decays as events leave the window, so contacts with engagement are always rescored.
        recent |= set(db.scalars(select(Contact.id).where(Contact.application_id == s.application_id,
                                                          Contact.engagement_score != 0).limit(SCORE_BATCH)))
        recent.discard(None)
        ids = list(recent)
        for i in range(0, len(ids), SCORE_BATCH):
            score_contacts(db, s, list(db.scalars(base.where(Contact.id.in_(ids[i:i + SCORE_BATCH])))), rules)
        done = len(ids)
    s.scored_at = started
    return done


def rescore_now(db: Session, ctx) -> int:
    ctx.require(Perm.CRM_MANAGE)
    return rescore_application(db, settings_for(db, ctx.organization_id, ctx.application_id), full=True)


# ------------------------------------------------------------------ assignment

def _matches(db: Session, rule: AssignmentRule, c: Contact) -> bool:
    for key, want in (rule.conditions or {}).items():
        if key == "segment_id":
            seg = db.get(Segment, want)
            if seg is None:
                return False
            from app.services.audience.query import base_query
            from app.services.audience.segments import compile_rules

            ctx = system_ctx(db, c.organization_id, c.application_id)
            hit = db.scalar(select(func.count()).select_from(base_query(ctx).where(
                Contact.id == c.id, compile_rules(db, ctx, seg.rules)).subquery()))
            if not hit:
                return False
        elif str(getattr(c, key, "") or "").strip().lower() != str(want).strip().lower():
            return False
    return True


def _pick(db: Session, rule: AssignmentRule, members: set[str]) -> str | None:
    pool = [u for u in rule.user_ids if u in members]
    if not pool:
        return None
    for step in range(len(pool)):
        i = (rule.next_index + step) % len(pool)
        uid = pool[i]
        if rule.max_open_per_user:
            open_n = db.scalar(select(func.count()).select_from(Contact).where(
                Contact.application_id == rule.application_id, Contact.owner_id == uid,
                Contact.lifecycle_stage.in_(OPEN_LIFECYCLE))) or 0
            if open_n >= rule.max_open_per_user:
                continue
        rule.next_index = (i + 1) % len(pool)
        return uid
    return None


def _active_rules(db: Session, application_id: str) -> list[AssignmentRule]:
    return list(db.scalars(select(AssignmentRule).where(
        AssignmentRule.application_id == application_id, AssignmentRule.active.is_(True))
        .order_by(AssignmentRule.position)))


def _assign_one(db: Session, s: CrmSettings, c: Contact, rules: list[AssignmentRule], members: set[str]) -> int:
    """Start the contact's SLA clock and give it an owner by the first matching rule. 1 if assigned."""
    if s.sla_enabled and c.sla_due_at is None and c.first_response_at is None:
        c.sla_due_at = (c.created_at or utcnow()) + timedelta(minutes=s.sla_minutes)
    if c.owner_id is not None:
        return 0
    for r in rules:
        if _matches(db, r, c):
            uid = _pick(db, r, members)
            if uid:
                c.owner_id = uid
                r.assigned_count += 1
                _assigned(db, c, rule=r)
                return 1
            break
    return 0


def assign_contact_now(db: Session, c: Contact) -> bool:
    """Run assignment rules and start the SLA for one contact as it is created (API or UI). The periodic
    job still covers imports and anything created elsewhere."""
    s = settings_for(db, c.organization_id, c.application_id)
    rules = _active_rules(db, c.application_id) if c.owner_id is None else []
    members = set(team(db, c.organization_id, c.application_id)) if rules else set()
    db.flush()
    return bool(_assign_one(db, s, c, rules, members))


def assign_new_contacts(db: Session, s: CrmSettings) -> int:
    """Give new, unowned contacts an owner by the first matching rule, and start their SLA clock."""
    now = utcnow()
    since = (s.assignment_cursor or now) - timedelta(minutes=1)
    contacts = list(db.scalars(select(Contact).where(Contact.application_id == s.application_id,
                                                     Contact.created_at >= since).order_by(Contact.created_at)
                               .limit(1000)))
    rules = _active_rules(db, s.application_id)
    members = set(team(db, s.organization_id, s.application_id)) if rules else set()
    assigned = sum(_assign_one(db, s, c, rules, members) for c in contacts)
    s.assignment_cursor = contacts[-1].created_at if len(contacts) == 1000 else now
    return assigned


# ------------------------------------------------------------------ SLA, rotting, reminders

def breach_slas(db: Session, application_id: str) -> int:
    now = utcnow()
    rows = list(db.scalars(select(Contact).where(
        Contact.application_id == application_id, Contact.sla_due_at < now, Contact.first_response_at.is_(None),
        Contact.sla_breached_at.is_(None)).limit(500)))
    for c in rows:
        c.sla_breached_at = now
        record_event(db, c.organization_id, c.application_id, "sla_breached", contact_id=c.id,
                     data={"owner_id": c.owner_id, "due_at": c.sla_due_at.isoformat()})
        system_activity(db, c.organization_id, c.application_id, "First-response time missed", contact_id=c.id)
        if c.owner_id:
            notify(db, c.owner_id, type_="crm_sla_breached",
                   title=f"Response overdue: {c.full_name or c.email or c.phone or 'a lead'}"[:160],
                   link=f"/apps/{c.application_id}/audience/contacts/{c.id}", organization_id=c.organization_id,
                   application_id=c.application_id, level="warning")
    return len(rows)


def flag_rotting(db: Session, application_id: str) -> int:
    now, n = utcnow(), 0
    stages = list(db.scalars(select(PipelineStage).where(PipelineStage.application_id == application_id,
                                                         PipelineStage.kind == "open",
                                                         PipelineStage.rotting_days.is_not(None))))
    for st in stages:
        for d in db.scalars(select(Deal).where(Deal.stage_id == st.id, Deal.status == "open",
                                               Deal.rotting_since.is_(None),
                                               Deal.last_activity_at < now - timedelta(days=st.rotting_days))
                            .limit(500)):
            d.rotting_since = now
            n += 1
            record_event(db, d.organization_id, d.application_id, "deal_rotting", contact_id=d.contact_id,
                         deal_id=d.id, data={"stage_id": st.id, "days": st.rotting_days})
            if d.owner_id:
                notify(db, d.owner_id, type_="crm_deal_rotting", title=f"Deal going cold: {d.title}"[:160],
                       body=f"No activity for {st.rotting_days}+ days in {st.name}",
                       link=f"/apps/{d.application_id}/crm/deals/{d.id}", organization_id=d.organization_id,
                       application_id=d.application_id, level="warning")
    return n


def remind_tasks(db: Session, application_id: str) -> int:
    now = utcnow()
    rows = list(db.scalars(select(CrmTask).where(
        CrmTask.application_id == application_id, CrmTask.status == "open", CrmTask.reminded_at.is_(None),
        CrmTask.due_at.is_not(None), CrmTask.due_at <= now + timedelta(minutes=15)).limit(500)))
    for t in rows:
        t.reminded_at = now
        if t.assignee_id:
            late = t.due_at < now
            notify(db, t.assignee_id, type_="crm_task_due",
                   title=f"{'Overdue' if late else 'Due soon'}: {t.title}"[:160],
                   link=f"/apps/{t.application_id}/crm/tasks?task={t.id}", organization_id=t.organization_id,
                   application_id=t.application_id, level="warning" if late else "info")
    return len(rows)


def tick(db: Session) -> dict:
    """One pass over every application that uses the CRM. Each application commits on its own."""
    out = {"assigned": 0, "breached": 0, "rotting": 0, "reminded": 0, "scored": 0}
    for s in list(db.scalars(select(CrmSettings))):
        try:
            out["assigned"] += assign_new_contacts(db, s)
            out["breached"] += breach_slas(db, s.application_id)
            out["rotting"] += flag_rotting(db, s.application_id)
            out["reminded"] += remind_tasks(db, s.application_id)
            if s.scored_at is None or utcnow() - s.scored_at >= timedelta(minutes=10):
                out["scored"] += rescore_application(db, s)
            db.commit()
        except Exception:  # noqa: BLE001 - one application must not stop the others
            log.exception("crm_tick_failed", application_id=s.application_id)
            db.rollback()
    return out
