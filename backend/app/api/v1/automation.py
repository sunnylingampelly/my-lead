"""Automation endpoints, scoped to /apps/{app_id}/automation."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field

from app.api.deps import DB, AppCtx
from app.core.permissions import Perm
from app.schemas.common import PageParams
from app.services.automation import workflows

router = APIRouter(prefix="/apps/{app_id}/automation", tags=["Automation"])
Paging = Annotated[PageParams, Depends()]


class WorkflowCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    graph: dict | None = None


class WorkflowUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    allow_reentry: bool | None = None
    graph: dict | None = None


class PublishBody(BaseModel):
    activate: bool = True


@router.get("/workflows")
def list_workflows(ctx: AppCtx, db: DB, paging: Paging, status_: str | None = Query(None, alias="status", max_length=20),
                   search: str | None = Query(None, max_length=100)):
    return workflows.list_workflows(db, ctx, paging, status_, search)


@router.post("/workflows", status_code=status.HTTP_201_CREATED)
def create_workflow(body: WorkflowCreate, ctx: AppCtx, db: DB):
    w = workflows.create_workflow(db, ctx, body.name, body.description, body.graph)
    db.commit()
    return workflows.detail(db, w)


@router.get("/workflows/{workflow_id}")
def get_workflow(workflow_id: str, ctx: AppCtx, db: DB):
    ctx.require(Perm.AUTOMATION_READ)
    return workflows.detail(db, workflows._get(db, ctx, workflow_id))


@router.patch("/workflows/{workflow_id}")
def update_workflow(workflow_id: str, body: WorkflowUpdate, ctx: AppCtx, db: DB):
    w = workflows.update_workflow(db, ctx, workflow_id, body.model_dump(exclude_unset=True))
    db.commit()
    return workflows.detail(db, w)


@router.get("/workflows/{workflow_id}/validate")
def validate(workflow_id: str, ctx: AppCtx, db: DB):
    """Check the draft graph. Read-only: hidden campaigns are only created when publishing."""
    ctx.require(Perm.AUTOMATION_READ)
    issues = workflows.validate(db, ctx, workflows._get(db, ctx, workflow_id))
    db.rollback()
    return {"valid": not issues, "issues": workflows.issues_out(issues)}


@router.post("/workflows/{workflow_id}/publish")
def publish(workflow_id: str, body: PublishBody, ctx: AppCtx, db: DB):
    w = workflows.publish(db, ctx, workflow_id, body.activate)
    db.commit()
    return workflows.detail(db, w)


@router.post("/workflows/{workflow_id}/pause")
def pause(workflow_id: str, ctx: AppCtx, db: DB):
    w = workflows.pause(db, ctx, workflow_id)
    db.commit()
    return workflows.detail(db, w)


@router.post("/workflows/{workflow_id}/resume")
def resume(workflow_id: str, ctx: AppCtx, db: DB):
    w = workflows.resume(db, ctx, workflow_id)
    db.commit()
    return workflows.detail(db, w)


@router.post("/workflows/{workflow_id}/archive")
def archive(workflow_id: str, ctx: AppCtx, db: DB):
    w = workflows.archive(db, ctx, workflow_id)
    db.commit()
    return workflows.detail(db, w)


@router.post("/workflows/{workflow_id}/duplicate", status_code=status.HTTP_201_CREATED)
def duplicate(workflow_id: str, ctx: AppCtx, db: DB):
    w = workflows.duplicate(db, ctx, workflow_id)
    db.commit()
    return workflows.detail(db, w)


@router.delete("/workflows/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workflow(workflow_id: str, ctx: AppCtx, db: DB):
    workflows.delete_workflow(db, ctx, workflow_id)
    db.commit()


@router.get("/workflows/{workflow_id}/stats")
def stats(workflow_id: str, ctx: AppCtx, db: DB):
    return workflows.node_stats(db, ctx, workflow_id)


@router.get("/workflows/{workflow_id}/runs")
def runs(workflow_id: str, ctx: AppCtx, db: DB, paging: Paging,
         status_: str | None = Query(None, alias="status", max_length=20)):
    return workflows.list_runs(db, ctx, workflow_id, paging, status_)


@router.get("/workflows/{workflow_id}/runs/{run_id}")
def run_steps(workflow_id: str, run_id: str, ctx: AppCtx, db: DB):
    return {"steps": workflows.run_steps(db, ctx, workflow_id, run_id)}


@router.post("/workflows/{workflow_id}/runs/{run_id}/stop", status_code=status.HTTP_204_NO_CONTENT)
def stop_run(workflow_id: str, run_id: str, ctx: AppCtx, db: DB):
    workflows.stop_run(db, ctx, workflow_id, run_id)
    db.commit()
