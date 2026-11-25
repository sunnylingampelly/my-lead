"""Pipelines, stages, lost reasons and deals: board, moves, won/lost, weighted values, rotting."""
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.permissions import Perm
from app.models import Company, Contact, Deal, DealContact, DealStageHistory, LostReason, Pipeline, PipelineStage, User
from app.schemas.common import Page, PageParams
from app.schemas.crm import DealCreate, DealUpdate, PipelineCreate, PipelineUpdate, StageIn
from app.services.crm.common import (
    DEFAULT_STAGES,
    audit,
    check_owner,
    contact_ref,
    currency_for,
    ensure_defaults,
    get_in_app,
    optional_in_app,
    record_event,
    system_activity,
    touched,
    user_ref,
    users_by_id,
)
from app.utils.time import utcnow

# ------------------------------------------------------------------ pipelines


def _stages(db: Session, pipeline_id: str) -> list[PipelineStage]:
    return list(db.scalars(select(PipelineStage).where(PipelineStage.pipeline_id == pipeline_id)
                           .order_by(PipelineStage.position)))


def pipeline_out(db: Session, p: Pipeline) -> dict:
    return {"id": p.id, "name": p.name, "currency": p.currency, "is_default": p.is_default, "archived": p.archived,
            "position": p.position, "stages": [{"id": s.id, "name": s.name, "position": s.position,
                                                "probability": s.probability, "kind": s.kind,
                                                "rotting_days": s.rotting_days} for s in _stages(db, p.id)]}


def list_pipelines(db: Session, ctx, include_archived: bool = False) -> list[dict]:
    ctx.require(Perm.CRM_READ)
    ensure_defaults(db, ctx)
    q = select(Pipeline).where(Pipeline.application_id == ctx.application_id)
    if not include_archived:
        q = q.where(Pipeline.archived.is_(False))
    return [pipeline_out(db, p) for p in db.scalars(q.order_by(Pipeline.position, Pipeline.name))]


def _validate_stages(stages: list[StageIn]) -> None:
    kinds = [s.kind for s in stages]
    if kinds.count("won") != 1 or kinds.count("lost") != 1 or kinds.count("open") < 1:
        raise ValidationFailed("A pipeline needs at least one open stage, one Won stage and one Lost stage",
                               code="INVALID_STAGES")
    if len(stages) > 30:
        raise ValidationFailed("A pipeline can have up to 30 stages", code="INVALID_STAGES")
    if len({s.name.strip().lower() for s in stages}) != len(stages):
        raise ValidationFailed("Stage names must be different", code="INVALID_STAGES")


def _apply_stages(db: Session, ctx, p: Pipeline, stages: list[StageIn]) -> None:
    _validate_stages(stages)
    existing = {s.id: s for s in _stages(db, p.id)}
    keep = set()
    for i, s in enumerate(stages):
        row = existing.get(s.id) if s.id else None
        if s.id and row is None:
            raise ValidationFailed("A stage does not belong to this pipeline", code="INVALID_STAGES")
        if row is None:
            row = PipelineStage(pipeline_id=p.id, application_id=ctx.application_id)
            db.add(row)
        prob = 100 if s.kind == "won" else 0 if s.kind == "lost" else s.probability
        row.name, row.position, row.probability, row.kind = s.name.strip(), i, prob, s.kind
        row.rotting_days = s.rotting_days if s.kind == "open" else None
        db.flush()
        keep.add(row.id)
    removed = [sid for sid in existing if sid not in keep]
    if removed:
        used = db.scalar(select(func.count()).select_from(Deal).where(Deal.stage_id.in_(removed))) or 0
        if used:
            raise Conflict(f"{used} deals are in stages you removed. Move them first.", code="STAGE_IN_USE")
        db.execute(delete(PipelineStage).where(PipelineStage.id.in_(removed)))


def create_pipeline(db: Session, ctx, data: PipelineCreate) -> dict:
    ctx.require(Perm.CRM_MANAGE)
    ensure_defaults(db, ctx)
    if db.scalar(select(Pipeline.id).where(Pipeline.application_id == ctx.application_id,
                                           func.lower(Pipeline.name) == data.name.strip().lower())):
        raise Conflict("A pipeline with this name already exists", code="DUPLICATE_NAME")
    n = db.scalar(select(func.count()).select_from(Pipeline).where(Pipeline.application_id == ctx.application_id)) or 0
    p = Pipeline(organization_id=ctx.organization_id, application_id=ctx.application_id, name=data.name.strip(),
                 currency=data.currency or currency_for(ctx), is_default=False, position=n)
    db.add(p)
    db.flush()
    stages = data.stages or [StageIn(name=a, probability=b, kind=c, rotting_days=d) for a, b, c, d in DEFAULT_STAGES]
    _apply_stages(db, ctx, p, stages)
    audit(db, ctx, "crm_pipeline.created", "crm_pipeline", p.id, f"Created pipeline {p.name}")
    return pipeline_out(db, p)


def update_pipeline(db: Session, ctx, pipeline_id: str, data: PipelineUpdate) -> dict:
    ctx.require(Perm.CRM_MANAGE)
    p = get_in_app(db, ctx, Pipeline, pipeline_id, "Pipeline")
    if data.name is not None:
        p.name = data.name.strip()
    if data.currency is not None:
        p.currency = data.currency
    if data.archived is not None:
        if data.archived and p.is_default:
            raise ValidationFailed("Make another pipeline the default before archiving this one",
                                   code="DEFAULT_PIPELINE")
        p.archived = data.archived
    if data.is_default:
        db.execute(update(Pipeline).where(Pipeline.application_id == ctx.application_id).values(is_default=False))
        p.is_default, p.archived = True, False
    if data.stages is not None:
        _apply_stages(db, ctx, p, data.stages)
    audit(db, ctx, "crm_pipeline.updated", "crm_pipeline", p.id, f"Updated pipeline {p.name}")
    return pipeline_out(db, p)


def delete_pipeline(db: Session, ctx, pipeline_id: str) -> None:
    ctx.require(Perm.CRM_MANAGE)
    p = get_in_app(db, ctx, Pipeline, pipeline_id, "Pipeline")
    if p.is_default:
        raise ValidationFailed("The default pipeline cannot be deleted", code="DEFAULT_PIPELINE")
    if db.scalar(select(func.count()).select_from(Deal).where(Deal.pipeline_id == p.id)):
        raise Conflict("This pipeline has deals. Archive it instead.", code="PIPELINE_IN_USE")
    audit(db, ctx, "crm_pipeline.deleted", "crm_pipeline", p.id, f"Deleted pipeline {p.name}")
    db.delete(p)


# ------------------------------------------------------------------ lost reasons

def list_lost_reasons(db: Session, ctx) -> list[LostReason]:
    ctx.require(Perm.CRM_READ)
    ensure_defaults(db, ctx)
    return list(db.scalars(select(LostReason).where(LostReason.application_id == ctx.application_id)
                           .order_by(LostReason.position, LostReason.name)))


def save_lost_reason(db: Session, ctx, name: str, active: bool, reason_id: str | None = None) -> LostReason:
    ctx.require(Perm.CRM_MANAGE)
    dup = db.scalar(select(LostReason).where(LostReason.application_id == ctx.application_id,
                                             func.lower(LostReason.name) == name.strip().lower()))
    if dup is not None and dup.id != reason_id:
        raise Conflict("This reason already exists", code="DUPLICATE_NAME")
    if reason_id:
        r = get_in_app(db, ctx, LostReason, reason_id, "Lost reason")
    else:
        n = db.scalar(select(func.count()).select_from(LostReason).where(
            LostReason.application_id == ctx.application_id)) or 0
        r = LostReason(organization_id=ctx.organization_id, application_id=ctx.application_id, position=n)
        db.add(r)
    r.name, r.active = name.strip(), active
    db.flush()
    return r


# ------------------------------------------------------------------ deal output

def effective_probability(d: Deal, stage: PipelineStage) -> int:
    if d.status == "won":
        return 100
    if d.status == "lost":
        return 0
    return d.probability if d.probability is not None else stage.probability


def is_rotting(d: Deal, stage: PipelineStage, now=None) -> bool:
    if d.status != "open" or not stage.rotting_days:
        return False
    return d.last_activity_at < (now or utcnow()) - timedelta(days=stage.rotting_days)


def deals_out(db: Session, deals: list[Deal]) -> list[dict]:
    if not deals:
        return []
    stages = {s.id: s for s in db.scalars(select(PipelineStage).where(
        PipelineStage.id.in_({d.stage_id for d in deals})))}
    users = users_by_id(db, [d.owner_id for d in deals])
    contacts = {c.id: c for c in db.scalars(select(Contact).where(
        Contact.id.in_({d.contact_id for d in deals if d.contact_id})))}
    companies = {c.id: c for c in db.scalars(select(Company).where(
        Company.id.in_({d.company_id for d in deals if d.company_id})))}
    reasons = {r.id: r for r in db.scalars(select(LostReason).where(
        LostReason.id.in_({d.lost_reason_id for d in deals if d.lost_reason_id})))}
    now, rows = utcnow(), []
    for d in deals:
        st = stages[d.stage_id]
        prob = effective_probability(d, st)
        amount = Decimal(str(d.amount or 0))
        co, lr = companies.get(d.company_id), reasons.get(d.lost_reason_id)
        rows.append({
            "id": d.id, "title": d.title, "pipeline_id": d.pipeline_id, "stage_id": d.stage_id, "stage_name": st.name,
            "amount": amount, "currency": d.currency, "probability": prob,
            "probability_overridden": d.probability is not None,
            "weighted_amount": (amount * prob / 100).quantize(Decimal("0.01")),
            "expected_close_date": d.expected_close_date, "status": d.status,
            "lost_reason": {"id": lr.id, "name": lr.name} if lr else None, "lost_note": d.lost_note,
            "source": d.source, "owner": user_ref(users.get(d.owner_id)),
            "contact": contact_ref(contacts.get(d.contact_id)),
            "company": {"id": co.id, "name": co.name} if co else None,
            "stage_entered_at": d.stage_entered_at, "last_activity_at": d.last_activity_at,
            "rotting": is_rotting(d, st, now), "rotting_days": st.rotting_days,
            "days_in_stage": max(0, (now - d.stage_entered_at).days), "closed_at": d.closed_at,
            "position": d.position, "attributes": d.attributes or {}, "created_at": d.created_at,
            "updated_at": d.updated_at})
    return rows


def _filtered(ctx, q, *, pipeline_id=None, stage_id=None, status=None, owner_id=None, contact_id=None,
              company_id=None, search=None, rotting=None, close_from=None, close_to=None, source=None,
              audience=None):
    if pipeline_id:
        q = q.where(Deal.pipeline_id == pipeline_id)
    if stage_id:
        q = q.where(Deal.stage_id == stage_id)
    if status:
        q = q.where(Deal.status == status)
    if owner_id:
        q = q.where(Deal.owner_id == (ctx.user.id if owner_id == "me" else owner_id))
    if contact_id:
        q = q.where(or_(Deal.contact_id == contact_id, Deal.id.in_(
            select(DealContact.deal_id).where(DealContact.contact_id == contact_id))))
    if company_id:
        q = q.where(Deal.company_id == company_id)
    if search:
        q = q.where(Deal.title.ilike(f"%{search.strip()}%"))
    if close_from:
        q = q.where(Deal.expected_close_date >= close_from)
    if close_to:
        q = q.where(Deal.expected_close_date <= close_to)
    if rotting:
        q = q.where(Deal.rotting_since.is_not(None), Deal.status == "open")
    if source:
        q = q.where(Deal.source == source)
    if audience is not None:  # primary contact in a tag, list or segment
        q = q.where(Deal.contact_id.in_(audience))
    return q


def list_deals(db: Session, ctx, params: PageParams, sort: str = "-created_at", *, tag_id: str | None = None,
               list_id: str | None = None, segment_id: str | None = None, **filters) -> Page:
    ctx.require(Perm.CRM_READ)
    if tag_id or list_id or segment_id:
        from app.services.crm.leads import audience_filter

        filters["audience"] = audience_filter(db, ctx, select(Contact.id).where(
            Contact.application_id == ctx.application_id), tag_id=tag_id, list_id=list_id, segment_id=segment_id)
    q = _filtered(ctx, select(Deal).where(Deal.application_id == ctx.application_id), **filters)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    order = {"-created_at": Deal.created_at.desc(), "created_at": Deal.created_at, "-amount": Deal.amount.desc(),
             "amount": Deal.amount, "close_date": Deal.expected_close_date,
             "-close_date": Deal.expected_close_date.desc(), "title": Deal.title, "-title": Deal.title.desc(),
             "-last_activity": Deal.last_activity_at.desc(), "last_activity": Deal.last_activity_at}.get(
        sort, Deal.created_at.desc())
    items = list(db.scalars(q.order_by(order, Deal.id).offset(params.offset).limit(params.page_size)))
    return Page(items=deals_out(db, items), total=total, page=params.page, page_size=params.page_size)


def board(db: Session, ctx, pipeline_id: str | None, owner_id: str | None = None, search: str | None = None,
          per_stage: int = 100) -> dict:
    ctx.require(Perm.CRM_READ)
    ensure_defaults(db, ctx)
    p = _pipeline(db, ctx, pipeline_id)
    stages = _stages(db, p.id)
    columns, open_total, weighted_total = [], Decimal(0), Decimal(0)
    for st in stages:
        base = _filtered(ctx, select(Deal).where(Deal.application_id == ctx.application_id, Deal.stage_id == st.id),
                         owner_id=owner_id, search=search)
        if st.kind != "open":  # won/lost columns show the last 30 days only
            base = base.where(Deal.closed_at >= utcnow() - timedelta(days=30))
        sub = base.subquery()
        agg = db.execute(select(func.count(), func.coalesce(func.sum(sub.c.amount), 0)).select_from(sub)).one()
        deals = deals_out(db, list(db.scalars(base.order_by(Deal.position, Deal.created_at.desc()).limit(per_stage))))
        total = Decimal(str(agg[1]))
        weighted = sum((d["weighted_amount"] for d in deals), Decimal(0)) if agg[0] <= per_stage else \
            (total * st.probability / 100).quantize(Decimal("0.01"))
        if st.kind == "open":
            open_total += total
            weighted_total += weighted
        columns.append({"stage": {"id": st.id, "name": st.name, "position": st.position, "probability": st.probability,
                                  "kind": st.kind, "rotting_days": st.rotting_days},
                        "deals": deals, "count": agg[0], "total": total, "weighted_total": weighted})
    return {"pipeline": pipeline_out(db, p), "columns": columns, "open_total": open_total,
            "weighted_total": weighted_total}


def _pipeline(db: Session, ctx, pipeline_id: str | None) -> Pipeline:
    if pipeline_id:
        return get_in_app(db, ctx, Pipeline, pipeline_id, "Pipeline")
    p = db.scalar(select(Pipeline).where(Pipeline.application_id == ctx.application_id, Pipeline.is_default.is_(True)))
    p = p or db.scalar(select(Pipeline).where(Pipeline.application_id == ctx.application_id,
                                              Pipeline.archived.is_(False)).order_by(Pipeline.position))
    if p is None:
        raise NotFound("Pipeline not found")
    return p


def get_deal(db: Session, ctx, deal_id: str) -> dict:
    ctx.require(Perm.CRM_READ)
    d = get_in_app(db, ctx, Deal, deal_id, "Deal")
    row = deals_out(db, [d])[0]
    links = db.execute(select(DealContact, Contact).join(Contact, Contact.id == DealContact.contact_id).where(
        DealContact.deal_id == d.id)).all()
    row["contacts"] = [contact_ref(c, dc.role) for dc, c in links]
    stage_names = {s.id: s.name for s in _stages(db, d.pipeline_id)}
    hist = list(db.scalars(select(DealStageHistory).where(DealStageHistory.deal_id == d.id)
                           .order_by(DealStageHistory.changed_at)))
    users = users_by_id(db, [h.changed_by_id for h in hist])
    row["stage_history"] = [{"from_stage": stage_names.get(h.from_stage_id or ""), "to_stage": stage_names.get(
        h.to_stage_id, "Removed stage"), "changed_at": h.changed_at, "changed_by": user_ref(users.get(h.changed_by_id)),
        "days_in_previous": round((h.seconds_in_previous or 0) / 86400, 1)} for h in hist]
    return row


# ------------------------------------------------------------------ deal writes

def _links(db: Session, ctx, values: dict) -> tuple[Contact | None, Company | None]:
    contact = optional_in_app(db, ctx, Contact, values.get("contact_id"), "Contact")
    company = optional_in_app(db, ctx, Company, values.get("company_id"), "Company")
    if contact is not None and company is None and "company_id" not in values and contact.company_id:
        values["company_id"] = contact.company_id
    if "owner_id" in values:
        check_owner(db, ctx, values["owner_id"])
    return contact, company


def create_deal(db: Session, ctx, data: DealCreate, actor_id: str | None = None) -> Deal:
    ctx.require(Perm.CRM_WRITE)
    ensure_defaults(db, ctx)
    p = _pipeline(db, ctx, data.pipeline_id)
    if p.archived:
        raise ValidationFailed("This pipeline is archived", code="PIPELINE_ARCHIVED")
    stages = _stages(db, p.id)
    if data.stage_id:
        stage = next((s for s in stages if s.id == data.stage_id), None)
        if stage is None:
            raise ValidationFailed("That stage is not in this pipeline", code="INVALID_STAGE")
    else:
        stage = next(s for s in stages if s.kind == "open")
    values = data.model_dump(exclude={"pipeline_id", "stage_id"}, exclude_unset=True)
    contact, _ = _links(db, ctx, values)
    owner = values.pop("owner_id", None) or (contact.owner_id if contact and contact.owner_id else None) or (
        ctx.user.id if ctx.user else None)
    now = utcnow()
    d = Deal(organization_id=ctx.organization_id, application_id=ctx.application_id, pipeline_id=p.id,
             stage_id=stage.id, currency=values.pop("currency", None) or p.currency,
             amount=values.pop("amount", None) or 0, attributes=values.pop("attributes", None) or {},
             owner_id=owner, created_by_id=ctx.user.id if ctx.user else None, stage_entered_at=now,
             last_activity_at=now, status="open" if stage.kind == "open" else stage.kind,
             closed_at=None if stage.kind == "open" else now, **values)
    db.add(d)
    db.flush()
    db.add(DealStageHistory(application_id=ctx.application_id, deal_id=d.id, from_stage_id=None, to_stage_id=stage.id,
                            changed_by_id=actor_id or (ctx.user.id if ctx.user else None), changed_at=now))
    if contact is not None and contact.lifecycle_stage in ("subscriber", "lead", "mql", "sql"):
        contact.lifecycle_stage = "opportunity"
    record_event(db, ctx.organization_id, ctx.application_id, "deal_created", contact_id=d.contact_id, deal_id=d.id,
                 data={"pipeline_id": p.id, "stage_id": stage.id})
    system_activity(db, ctx.organization_id, ctx.application_id, f"Deal created: {d.title}",
                    actor_id=ctx.user.id if ctx.user else None, contact_id=d.contact_id, deal_id=d.id,
                    company_id=d.company_id)
    if ctx.user:
        audit(db, ctx, "crm_deal.created", "crm_deal", d.id, f"Created deal {d.title}")
    return d


def update_deal(db: Session, ctx, deal_id: str, data: DealUpdate) -> Deal:
    ctx.require(Perm.CRM_WRITE)
    d = get_in_app(db, ctx, Deal, deal_id, "Deal")
    values = data.model_dump(exclude_unset=True, exclude={"clear_probability"})
    _links(db, ctx, values)
    if "title" in values and not values["title"]:
        raise ValidationFailed("Title is required", code="TITLE_REQUIRED")
    if "attributes" in values:
        values["attributes"] = values["attributes"] or {}
    if values.get("amount") is None:
        values.pop("amount", None)
    old_owner = d.owner_id
    for k, v in values.items():
        setattr(d, k, v)
    if data.clear_probability:
        d.probability = None
    if "owner_id" in values and d.owner_id != old_owner:
        record_event(db, ctx.organization_id, ctx.application_id, "owner_assigned", contact_id=d.contact_id,
                     deal_id=d.id, data={"owner_id": d.owner_id, "object": "deal"})
        system_activity(db, ctx.organization_id, ctx.application_id, "Deal owner changed", actor_id=ctx.user.id,
                        deal_id=d.id, contact_id=d.contact_id, meta={"owner_id": d.owner_id})
    audit(db, ctx, "crm_deal.updated", "crm_deal", d.id, f"Updated deal {d.title}", {"fields": sorted(values)})
    return d


def move_deal(db: Session, ctx, deal_id: str, stage_id: str, position: int | None = None,
              lost_reason_id: str | None = None, lost_note: str | None = None, actor_id: str | None = None) -> Deal:
    """Move a deal to a stage (drag on the board). Won/Lost stages close it; Lost needs a reason."""
    ctx.require(Perm.CRM_WRITE)
    d = get_in_app(db, ctx, Deal, deal_id, "Deal")
    stage = db.get(PipelineStage, stage_id)
    if stage is None or stage.pipeline_id != d.pipeline_id:
        raise ValidationFailed("That stage is not in this deal's pipeline", code="INVALID_STAGE")
    actor = actor_id or (ctx.user.id if ctx.user else None)
    if stage.kind == "lost":
        reason = optional_in_app(db, ctx, LostReason, lost_reason_id, "Lost reason")
        if reason is None:
            raise ValidationFailed("Choose why the deal was lost", code="LOST_REASON_REQUIRED")
        d.lost_reason_id, d.lost_note = reason.id, lost_note
    if position is not None:
        db.execute(update(Deal).where(Deal.stage_id == stage.id, Deal.position >= position, Deal.id != d.id)
                   .values(position=Deal.position + 1))
        d.position = position
    if stage.id == d.stage_id:
        return d
    now, prev = utcnow(), d.stage_id
    db.add(DealStageHistory(application_id=ctx.application_id, deal_id=d.id, from_stage_id=prev, to_stage_id=stage.id,
                            changed_by_id=actor, changed_at=now,
                            seconds_in_previous=int((now - d.stage_entered_at).total_seconds())))
    d.stage_id, d.stage_entered_at = stage.id, now
    old_status = d.status
    d.status = "open" if stage.kind == "open" else stage.kind
    d.closed_at = None if stage.kind == "open" else now
    if stage.kind != "lost":
        d.lost_reason_id = d.lost_note = None
    touched(db, deal=d, at=now)
    contact = db.get(Contact, d.contact_id) if d.contact_id else None
    if d.status == "won" and contact is not None:
        contact.lifecycle_stage = "customer"
    record_event(db, ctx.organization_id, ctx.application_id, "deal_stage_changed", contact_id=d.contact_id,
                 deal_id=d.id, data={"pipeline_id": d.pipeline_id, "from_stage_id": prev, "stage_id": stage.id})
    if d.status in ("won", "lost") and old_status != d.status:
        record_event(db, ctx.organization_id, ctx.application_id, f"deal_{d.status}", contact_id=d.contact_id,
                     deal_id=d.id, data={"pipeline_id": d.pipeline_id, "amount": str(d.amount)})
    system_activity(db, ctx.organization_id, ctx.application_id,
                    f"Deal {'won' if d.status == 'won' else 'lost' if d.status == 'lost' else 'moved to ' + stage.name}",
                    actor_id=actor, contact_id=d.contact_id, deal_id=d.id, company_id=d.company_id,
                    meta={"stage_id": stage.id})
    if ctx.user:
        audit(db, ctx, "crm_deal.moved", "crm_deal", d.id, f"Moved deal {d.title} to {stage.name}")
    return d


def close_deal(db: Session, ctx, deal_id: str, outcome: str, lost_reason_id: str | None, lost_note: str | None) -> Deal:
    d = get_in_app(db, ctx, Deal, deal_id, "Deal")
    stage = db.scalar(select(PipelineStage).where(PipelineStage.pipeline_id == d.pipeline_id,
                                                  PipelineStage.kind == outcome))
    return move_deal(db, ctx, d.id, stage.id, lost_reason_id=lost_reason_id, lost_note=lost_note)


def reopen_deal(db: Session, ctx, deal_id: str) -> Deal:
    d = get_in_app(db, ctx, Deal, deal_id, "Deal")
    if d.status == "open":
        return d
    prev = db.scalar(select(DealStageHistory.from_stage_id).where(
        DealStageHistory.deal_id == d.id, DealStageHistory.to_stage_id == d.stage_id)
        .order_by(DealStageHistory.changed_at.desc()).limit(1))
    stage = db.get(PipelineStage, prev) if prev else None
    if stage is None or stage.kind != "open":
        stage = db.scalar(select(PipelineStage).where(PipelineStage.pipeline_id == d.pipeline_id,
                                                      PipelineStage.kind == "open").order_by(PipelineStage.position))
    return move_deal(db, ctx, d.id, stage.id)


def delete_deal(db: Session, ctx, deal_id: str) -> None:
    ctx.require(Perm.CRM_WRITE)
    d = get_in_app(db, ctx, Deal, deal_id, "Deal")
    audit(db, ctx, "crm_deal.deleted", "crm_deal", d.id, f"Deleted deal {d.title}")
    db.delete(d)


def set_deal_contacts(db: Session, ctx, deal_id: str, links: list[tuple[str, str | None]]) -> None:
    ctx.require(Perm.CRM_WRITE)
    d = get_in_app(db, ctx, Deal, deal_id, "Deal")
    ids = [c for c, _ in links]
    found = set(db.scalars(select(Contact.id).where(Contact.application_id == ctx.application_id,
                                                    Contact.id.in_(ids)))) if ids else set()
    if len(found) != len(set(ids)):
        raise NotFound("Contact not found")
    db.execute(delete(DealContact).where(DealContact.deal_id == d.id))
    for cid, role in dict(links).items():
        db.add(DealContact(deal_id=d.id, contact_id=cid, application_id=ctx.application_id, role=role))


def users_of(db: Session, ids) -> dict[str, User]:
    return users_by_id(db, ids)
