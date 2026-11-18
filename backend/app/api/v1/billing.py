"""Wallet endpoints for an organization, and the same wallet seen from one application."""
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.api.deps import DB, AppCtx, OrgCtx
from app.schemas.common import PageParams
from app.services.billing import service

router = APIRouter(tags=["Billing"])
Paging = Annotated[PageParams, Depends()]


class TopUp(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    idempotency_key: str = Field(min_length=8, max_length=64)


class Threshold(BaseModel):
    low_balance_threshold: Decimal = Field(ge=0, max_digits=12, decimal_places=2)


@router.get("/organizations/{organization_id}/billing")
def org_summary(ctx: OrgCtx, db: DB):
    return service.summary(db, ctx)


@router.get("/organizations/{organization_id}/billing/transactions")
def org_transactions(ctx: OrgCtx, db: DB, paging: Paging, type_: str | None = Query(None, alias="type", max_length=20),
                     application_id: str | None = Query(None, max_length=36)):
    return service.transactions(db, ctx, paging, type_, application_id)


@router.get("/organizations/{organization_id}/billing/transactions.csv")
def org_export(ctx: OrgCtx, db: DB, application_id: str | None = Query(None, max_length=36)):
    return Response(service.export_csv(db, ctx, application_id), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="wallet-transactions.csv"'})


@router.post("/organizations/{organization_id}/billing/test-credit")
def test_credit(body: TopUp, ctx: OrgCtx, db: DB):
    out = service.add_test_credit(db, ctx, body.amount, body.idempotency_key)
    db.commit()
    return out


@router.put("/organizations/{organization_id}/billing/threshold")
def threshold(body: Threshold, ctx: OrgCtx, db: DB):
    service.set_threshold(db, ctx, body.low_balance_threshold)
    db.commit()
    return service.summary(db, ctx)


@router.get("/apps/{app_id}/billing")
def app_summary(ctx: AppCtx, db: DB):
    return service.summary(db, ctx, ctx.application_id)


@router.get("/apps/{app_id}/billing/transactions")
def app_transactions(ctx: AppCtx, db: DB, paging: Paging, type_: str | None = Query(None, alias="type", max_length=20)):
    return service.transactions(db, ctx, paging, type_, ctx.application_id)
