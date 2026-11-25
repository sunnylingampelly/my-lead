"""CRM endpoints: companies, pipelines, deals, tasks, notes, activities, timeline, leads, rules and
reports. Every route is scoped to /apps/{app_id}/crm and resolves an AppContext."""
from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response, status
from pydantic import BaseModel, Field

from app.api.deps import DB, AppCtx
from app.schemas.common import Page, PageParams
from app.schemas.crm import (
    ActivityCreate,
    AssignmentRuleIn,
    AssignmentRuleOut,
    Board,
    CompanyCreate,
    CompanyOut,
    CompanyUpdate,
    ContactCrmOut,
    ContactCrmUpdate,
    CrmSettingsIn,
    CrmSettingsOut,
    DealClose,
    DealContactIn,
    DealCreate,
    DealDetail,
    DealMove,
    DealOut,
    DealUpdate,
    DuplicateMatch,
    LeadRow,
    LostReasonIn,
    LostReasonOut,
    NoteCreate,
    NoteOut,
    NoteUpdate,
    PipelineCreate,
    PipelineOut,
    PipelineUpdate,
    ScoringRuleIn,
    ScoringRuleOut,
    TaskCreate,
    TaskOut,
    TaskUpdate,
    TimelineItem,
    UserRef,
)
from app.services.crm import companies, deals, leads, reports, work
from app.services.crm.companies import normalize_domain, normalize_gstin

router = APIRouter(prefix="/apps/{app_id}/crm", tags=["CRM"])
Paging = Annotated[PageParams, Depends()]
NO_CONTENT = status.HTTP_204_NO_CONTENT


class Ids(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=5000)


class DealContacts(BaseModel):
    contacts: list[DealContactIn] = Field(max_length=50)


# ------------------------------------------------------------------ team & settings

@router.get("/team", response_model=list[UserRef])
def crm_team(ctx: AppCtx, db: DB):
    """People who can own CRM records and be assigned tasks in this application."""
    return leads.team_out(db, ctx)


@router.get("/settings", response_model=CrmSettingsOut)
def get_settings(ctx: AppCtx, db: DB):
    s = leads.get_settings(db, ctx)
    db.commit()
    return s


@router.patch("/settings", response_model=CrmSettingsOut)
def update_settings(body: CrmSettingsIn, ctx: AppCtx, db: DB):
    s = leads.update_settings(db, ctx, body)
    db.commit()
    return s


# ------------------------------------------------------------------ companies

@router.get("/companies", response_model=Page[CompanyOut])
def list_companies(ctx: AppCtx, db: DB, paging: Paging, search: str | None = Query(None, max_length=200),
                   owner_id: str | None = None, industry: str | None = None, sort: str = "name"):
    return companies.list_companies(db, ctx, paging, search, owner_id, industry, sort)


@router.get("/companies/duplicates", response_model=list[DuplicateMatch])
def company_duplicates(ctx: AppCtx, db: DB, name: str | None = Query(None, max_length=200),
                       domain: str | None = Query(None, max_length=253), gstin: str | None = Query(None, max_length=20),
                       exclude_id: str | None = None):
    """Possible duplicates while someone types, so the form can warn before saving."""
    try:
        d = normalize_domain(domain)
    except Exception:  # noqa: BLE001 - half-typed values simply don't match
        d = None
    try:
        g = normalize_gstin(gstin)
    except Exception:  # noqa: BLE001
        g = None
    return companies.find_duplicates(db, ctx, name=name, domain=d, gstin=g, exclude_id=exclude_id)


@router.get("/companies/from-contacts")
def companies_from_contacts_preview(ctx: AppCtx, db: DB):
    """How many companies would be created from contacts' free-text company names."""
    return companies.from_contacts_preview(db, ctx)


@router.post("/companies/from-contacts")
def companies_from_contacts(ctx: AppCtx, db: DB):
    """Create a company for each distinct contact company name and link those contacts."""
    out = companies.create_from_contacts(db, ctx)
    db.commit()
    return out


@router.post("/companies", response_model=CompanyOut, status_code=status.HTTP_201_CREATED)
def create_company(body: CompanyCreate, ctx: AppCtx, db: DB):
    c = companies.create_company(db, ctx, body)
    db.commit()
    return companies.get_company(db, ctx, c.id)


@router.get("/companies/{company_id}", response_model=CompanyOut)
def get_company(company_id: str, ctx: AppCtx, db: DB):
    return companies.get_company(db, ctx, company_id)


@router.patch("/companies/{company_id}", response_model=CompanyOut)
def update_company(company_id: str, body: CompanyUpdate, ctx: AppCtx, db: DB):
    companies.update_company(db, ctx, company_id, body)
    db.commit()
    return companies.get_company(db, ctx, company_id)


@router.delete("/companies/{company_id}", status_code=NO_CONTENT)
def delete_company(company_id: str, ctx: AppCtx, db: DB):
    companies.delete_company(db, ctx, company_id)
    db.commit()
    return Response(status_code=NO_CONTENT)


@router.get("/companies/{company_id}/contacts")
def company_contacts(company_id: str, ctx: AppCtx, db: DB):
    return companies.company_contacts(db, ctx, company_id)


@router.post("/companies/{company_id}/contacts")
def link_company_contacts(company_id: str, body: Ids, ctx: AppCtx, db: DB):
    n = companies.link_contacts(db, ctx, company_id, body.ids)
    db.commit()
    return {"linked": n}


@router.post("/companies/{company_id}/contacts/unlink")
def unlink_company_contacts(company_id: str, body: Ids, ctx: AppCtx, db: DB):
    n = companies.unlink_contacts(db, ctx, company_id, body.ids)
    db.commit()
    return {"unlinked": n}


@router.get("/companies/{company_id}/suggested-contacts")
def suggested_company_contacts(company_id: str, ctx: AppCtx, db: DB):
    """Unlinked contacts whose company name or email domain matches this company."""
    return companies.suggested_contacts(db, ctx, company_id)


# ------------------------------------------------------------------ pipelines & lost reasons

@router.get("/pipelines", response_model=list[PipelineOut])
def list_pipelines(ctx: AppCtx, db: DB, include_archived: bool = False):
    out = deals.list_pipelines(db, ctx, include_archived)
    db.commit()  # defaults may have been created
    return out


@router.post("/pipelines", response_model=PipelineOut, status_code=status.HTTP_201_CREATED)
def create_pipeline(body: PipelineCreate, ctx: AppCtx, db: DB):
    out = deals.create_pipeline(db, ctx, body)
    db.commit()
    return out


@router.patch("/pipelines/{pipeline_id}", response_model=PipelineOut)
def update_pipeline(pipeline_id: str, body: PipelineUpdate, ctx: AppCtx, db: DB):
    out = deals.update_pipeline(db, ctx, pipeline_id, body)
    db.commit()
    return out


@router.delete("/pipelines/{pipeline_id}", status_code=NO_CONTENT)
def delete_pipeline(pipeline_id: str, ctx: AppCtx, db: DB):
    deals.delete_pipeline(db, ctx, pipeline_id)
    db.commit()
    return Response(status_code=NO_CONTENT)


@router.get("/lost-reasons", response_model=list[LostReasonOut])
def list_lost_reasons(ctx: AppCtx, db: DB):
    out = deals.list_lost_reasons(db, ctx)
    db.commit()
    return out


@router.post("/lost-reasons", response_model=LostReasonOut, status_code=status.HTTP_201_CREATED)
def create_lost_reason(body: LostReasonIn, ctx: AppCtx, db: DB):
    r = deals.save_lost_reason(db, ctx, body.name, body.active)
    db.commit()
    return r


@router.patch("/lost-reasons/{reason_id}", response_model=LostReasonOut)
def update_lost_reason(reason_id: str, body: LostReasonIn, ctx: AppCtx, db: DB):
    r = deals.save_lost_reason(db, ctx, body.name, body.active, reason_id)
    db.commit()
    return r


# ------------------------------------------------------------------ deals

@router.get("/board", response_model=Board)
def deal_board(ctx: AppCtx, db: DB, pipeline_id: str | None = None, owner_id: str | None = None,
               search: str | None = Query(None, max_length=200)):
    out = deals.board(db, ctx, pipeline_id, owner_id, search)
    db.commit()
    return out


@router.get("/deals", response_model=Page[DealOut])
def list_deals(ctx: AppCtx, db: DB, paging: Paging, pipeline_id: str | None = None, stage_id: str | None = None,
               status_: Literal["open", "won", "lost"] | None = Query(None, alias="status"),
               owner_id: str | None = None, contact_id: str | None = None, company_id: str | None = None,
               search: str | None = Query(None, max_length=200), rotting: bool | None = None,
               close_from: date | None = None, close_to: date | None = None, sort: str = "-created_at",
               source: str | None = Query(None, max_length=60), tag_id: str | None = None,
               list_id: str | None = None, segment_id: str | None = None):
    """tag_id / list_id / segment_id filter by the deal's primary contact's audience membership."""
    return deals.list_deals(db, ctx, paging, sort, pipeline_id=pipeline_id, stage_id=stage_id, status=status_,
                            owner_id=owner_id, contact_id=contact_id, company_id=company_id, search=search,
                            rotting=rotting, close_from=close_from, close_to=close_to, source=source,
                            tag_id=tag_id, list_id=list_id, segment_id=segment_id)


@router.post("/deals", response_model=DealDetail, status_code=status.HTTP_201_CREATED)
def create_deal(body: DealCreate, ctx: AppCtx, db: DB):
    d = deals.create_deal(db, ctx, body)
    db.commit()
    return deals.get_deal(db, ctx, d.id)


@router.get("/deals/{deal_id}", response_model=DealDetail)
def get_deal(deal_id: str, ctx: AppCtx, db: DB):
    return deals.get_deal(db, ctx, deal_id)


@router.patch("/deals/{deal_id}", response_model=DealDetail)
def update_deal(deal_id: str, body: DealUpdate, ctx: AppCtx, db: DB):
    deals.update_deal(db, ctx, deal_id, body)
    db.commit()
    return deals.get_deal(db, ctx, deal_id)


@router.post("/deals/{deal_id}/move", response_model=DealDetail)
def move_deal(deal_id: str, body: DealMove, ctx: AppCtx, db: DB):
    deals.move_deal(db, ctx, deal_id, body.stage_id, body.position, body.lost_reason_id, body.lost_note)
    db.commit()
    return deals.get_deal(db, ctx, deal_id)


@router.post("/deals/{deal_id}/close", response_model=DealDetail)
def close_deal(deal_id: str, body: DealClose, ctx: AppCtx, db: DB):
    deals.close_deal(db, ctx, deal_id, body.outcome, body.lost_reason_id, body.lost_note)
    db.commit()
    return deals.get_deal(db, ctx, deal_id)


@router.post("/deals/{deal_id}/reopen", response_model=DealDetail)
def reopen_deal(deal_id: str, ctx: AppCtx, db: DB):
    deals.reopen_deal(db, ctx, deal_id)
    db.commit()
    return deals.get_deal(db, ctx, deal_id)


@router.put("/deals/{deal_id}/contacts", response_model=DealDetail)
def set_deal_contacts(deal_id: str, body: DealContacts, ctx: AppCtx, db: DB):
    deals.set_deal_contacts(db, ctx, deal_id, [(c.contact_id, c.role) for c in body.contacts])
    db.commit()
    return deals.get_deal(db, ctx, deal_id)


@router.delete("/deals/{deal_id}", status_code=NO_CONTENT)
def delete_deal(deal_id: str, ctx: AppCtx, db: DB):
    deals.delete_deal(db, ctx, deal_id)
    db.commit()
    return Response(status_code=NO_CONTENT)


# ------------------------------------------------------------------ tasks

@router.get("/tasks", response_model=Page[TaskOut])
def list_tasks(ctx: AppCtx, db: DB, paging: Paging, assignee_id: str | None = None,
               status_: Literal["open", "done", "all"] = Query("open", alias="status"),
               due: Literal["overdue", "today", "upcoming", "none"] | None = None, contact_id: str | None = None,
               deal_id: str | None = None, company_id: str | None = None):
    return work.list_tasks(db, ctx, paging, assignee_id=assignee_id, status=None if status_ == "all" else status_,
                           due=due, contact_id=contact_id, deal_id=deal_id, company_id=company_id)


@router.get("/tasks/summary")
def task_summary(ctx: AppCtx, db: DB):
    """Counts for the signed-in user: open, overdue and due today."""
    return work.task_counts(db, ctx, ctx.user.id)


@router.post("/tasks", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
def create_task(body: TaskCreate, ctx: AppCtx, db: DB):
    t = work.create_task(db, ctx, body)
    db.commit()
    return work.tasks_out(db, [t])[0]


@router.get("/tasks/{task_id}", response_model=TaskOut)
def get_task(task_id: str, ctx: AppCtx, db: DB):
    return work.tasks_out(db, [work.get_task(db, ctx, task_id)])[0]


@router.patch("/tasks/{task_id}", response_model=TaskOut)
def update_task(task_id: str, body: TaskUpdate, ctx: AppCtx, db: DB):
    t = work.update_task(db, ctx, task_id, body)
    db.commit()
    return work.tasks_out(db, [t])[0]


@router.delete("/tasks/{task_id}", status_code=NO_CONTENT)
def delete_task(task_id: str, ctx: AppCtx, db: DB):
    work.delete_task(db, ctx, task_id)
    db.commit()
    return Response(status_code=NO_CONTENT)


# ------------------------------------------------------------------ notes, activities, timeline

@router.get("/notes", response_model=list[NoteOut])
def list_notes(ctx: AppCtx, db: DB, contact_id: str | None = None, deal_id: str | None = None,
               company_id: str | None = None):
    return work.list_notes(db, ctx, contact_id=contact_id, deal_id=deal_id, company_id=company_id)


@router.post("/notes", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
def create_note(body: NoteCreate, ctx: AppCtx, db: DB):
    n = work.create_note(db, ctx, body)
    db.commit()
    return work.notes_out(db, [n])[0]


@router.patch("/notes/{note_id}", response_model=NoteOut)
def update_note(note_id: str, body: NoteUpdate, ctx: AppCtx, db: DB):
    n = work.update_note(db, ctx, note_id, body)
    db.commit()
    return work.notes_out(db, [n])[0]


@router.delete("/notes/{note_id}", status_code=NO_CONTENT)
def delete_note(note_id: str, ctx: AppCtx, db: DB):
    work.delete_note(db, ctx, note_id)
    db.commit()
    return Response(status_code=NO_CONTENT)


@router.post("/activities", status_code=status.HTTP_201_CREATED)
def log_activity(body: ActivityCreate, ctx: AppCtx, db: DB):
    a = work.log_activity(db, ctx, body)
    db.commit()
    return {"id": a.id}


@router.delete("/activities/{activity_id}", status_code=NO_CONTENT)
def delete_activity(activity_id: str, ctx: AppCtx, db: DB):
    work.delete_activity(db, ctx, activity_id)
    db.commit()
    return Response(status_code=NO_CONTENT)


@router.get("/timeline", response_model=list[TimelineItem])
def timeline(ctx: AppCtx, db: DB, contact_id: str | None = None, deal_id: str | None = None,
             company_id: str | None = None, before: datetime | None = None, limit: int = Query(50, ge=1, le=200),
             kinds: str | None = Query(None, max_length=100)):
    """Newest first. Page with `before` = the last item's occurred_at."""
    kind_set = {k for k in (kinds or "").split(",") if k} or None
    return work.timeline(db, ctx, contact_id=contact_id, deal_id=deal_id, company_id=company_id, before=before,
                         limit=limit, kinds=kind_set)


# ------------------------------------------------------------------ contacts & leads

@router.get("/contacts/{contact_id}", response_model=ContactCrmOut)
def contact_crm(contact_id: str, ctx: AppCtx, db: DB):
    out = leads.contact_crm(db, ctx, contact_id)
    db.commit()
    return out


@router.patch("/contacts/{contact_id}", response_model=ContactCrmOut)
def update_contact_crm(contact_id: str, body: ContactCrmUpdate, ctx: AppCtx, db: DB):
    out = leads.update_contact_crm(db, ctx, contact_id, body)
    db.commit()
    return out


@router.get("/leads", response_model=Page[LeadRow])
def list_leads(ctx: AppCtx, db: DB, paging: Paging, owner_id: str | None = None, lifecycle: str | None = None,
               min_score: int | None = None, sla: Literal["due", "breached"] | None = None,
               search: str | None = Query(None, max_length=200), unassigned: bool = False, sort: str = "-lead_score",
               tag_id: str | None = None, list_id: str | None = None, segment_id: str | None = None):
    out = leads.list_leads(db, ctx, paging, owner_id=owner_id, lifecycle=lifecycle, min_score=min_score, sla=sla,
                           search=search, unassigned=unassigned, sort=sort, tag_id=tag_id, list_id=list_id,
                           segment_id=segment_id)
    db.commit()
    return out


# ------------------------------------------------------------------ assignment & scoring rules

@router.get("/assignment-rules", response_model=list[AssignmentRuleOut])
def list_assignment_rules(ctx: AppCtx, db: DB):
    return leads.list_assignment_rules(db, ctx)


@router.post("/assignment-rules", response_model=AssignmentRuleOut, status_code=status.HTTP_201_CREATED)
def create_assignment_rule(body: AssignmentRuleIn, ctx: AppCtx, db: DB):
    r = leads.save_assignment_rule(db, ctx, body)
    db.commit()
    return r


@router.put("/assignment-rules/{rule_id}", response_model=AssignmentRuleOut)
def update_assignment_rule(rule_id: str, body: AssignmentRuleIn, ctx: AppCtx, db: DB):
    r = leads.save_assignment_rule(db, ctx, body, rule_id)
    db.commit()
    return r


@router.post("/assignment-rules/order", status_code=NO_CONTENT)
def reorder_assignment_rules(body: Ids, ctx: AppCtx, db: DB):
    leads.reorder_assignment_rules(db, ctx, body.ids)
    db.commit()
    return Response(status_code=NO_CONTENT)


@router.delete("/assignment-rules/{rule_id}", status_code=NO_CONTENT)
def delete_assignment_rule(rule_id: str, ctx: AppCtx, db: DB):
    leads.delete_assignment_rule(db, ctx, rule_id)
    db.commit()
    return Response(status_code=NO_CONTENT)


@router.get("/scoring-rules", response_model=list[ScoringRuleOut])
def list_scoring_rules(ctx: AppCtx, db: DB):
    return leads.list_scoring_rules(db, ctx)


@router.post("/scoring-rules", response_model=ScoringRuleOut, status_code=status.HTTP_201_CREATED)
def create_scoring_rule(body: ScoringRuleIn, ctx: AppCtx, db: DB):
    r = leads.save_scoring_rule(db, ctx, body)
    db.commit()
    return r


@router.put("/scoring-rules/{rule_id}", response_model=ScoringRuleOut)
def update_scoring_rule(rule_id: str, body: ScoringRuleIn, ctx: AppCtx, db: DB):
    r = leads.save_scoring_rule(db, ctx, body, rule_id)
    db.commit()
    return r


@router.delete("/scoring-rules/{rule_id}", status_code=NO_CONTENT)
def delete_scoring_rule(rule_id: str, ctx: AppCtx, db: DB):
    leads.delete_scoring_rule(db, ctx, rule_id)
    db.commit()
    return Response(status_code=NO_CONTENT)


@router.post("/scoring/rescore")
def rescore(ctx: AppCtx, db: DB):
    """Recompute every contact's score now (also runs automatically every 10 minutes)."""
    n = leads.rescore_now(db, ctx)
    db.commit()
    return {"scored": n}


# ------------------------------------------------------------------ reports

@router.get("/reports/overview")
def report_overview(ctx: AppCtx, db: DB, pipeline_id: str | None = None):
    out = reports.overview(db, ctx, pipeline_id)
    db.commit()
    return out


@router.get("/reports/forecast")
def report_forecast(ctx: AppCtx, db: DB, pipeline_id: str | None = None, months: int = Query(6, ge=1, le=24),
                    owner_id: str | None = None):
    out = reports.forecast(db, ctx, pipeline_id, months, owner_id)
    db.commit()
    return out


@router.get("/reports/win-loss")
def report_win_loss(ctx: AppCtx, db: DB, pipeline_id: str | None = None, days: int = Query(90, ge=1, le=730)):
    return reports.win_loss(db, ctx, pipeline_id, days)


@router.get("/reports/conversion")
def report_conversion(ctx: AppCtx, db: DB, pipeline_id: str | None = None, days: int = Query(90, ge=1, le=730)):
    return reports.stage_conversion(db, ctx, pipeline_id, days)


@router.get("/reports/leaderboard")
def report_leaderboard(ctx: AppCtx, db: DB, pipeline_id: str | None = None, days: int = Query(30, ge=1, le=730)):
    return reports.leaderboard(db, ctx, pipeline_id, days)
