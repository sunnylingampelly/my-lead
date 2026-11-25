"""Wallet endpoints for an organization, and the same wallet seen from one application."""
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.api.deps import DB, AppCtx, OrgCtx
from app.schemas.common import PageParams
from app.services.billing import invoices, service, subscriptions

router = APIRouter(tags=["Billing"])
Paging = Annotated[PageParams, Depends()]


class TopUp(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    idempotency_key: str = Field(min_length=8, max_length=64)


class Threshold(BaseModel):
    low_balance_threshold: Decimal = Field(ge=0, max_digits=12, decimal_places=2)


class PlanChange(BaseModel):
    plan: Literal["starter", "pro"]


@router.get("/organizations/{organization_id}/billing")
def org_summary(ctx: OrgCtx, db: DB, application_id: str | None = Query(None, max_length=36)):
    # Usage figures narrowed to one application; balance, holds and plan stay organization-wide.
    # Every query is bounded by this organization's wallet, so another org's application id matches nothing.
    return service.summary(db, ctx, application_id)


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


@router.get("/organizations/{organization_id}/billing/plan")
def org_plan(ctx: OrgCtx, db: DB):
    out = subscriptions.overview(db, ctx)
    db.commit()  # persist a newly created wallet
    return out


@router.post("/organizations/{organization_id}/billing/plan")
def change_plan(body: PlanChange, ctx: OrgCtx, db: DB):
    out = subscriptions.change_plan(db, ctx, body.plan)
    db.commit()
    return out


@router.post("/organizations/{organization_id}/billing/plan/cancel-change")
def cancel_plan_change(ctx: OrgCtx, db: DB):
    out = subscriptions.cancel_change(db, ctx)
    db.commit()
    return out


# ------------------------------------------------------------------ GST: billing details, quotes, invoices, statements

class ProfileBody(BaseModel):
    legal_name: str = Field(min_length=1, max_length=200)
    gstin: str | None = Field(default=None, max_length=20)
    address: str = Field(min_length=1, max_length=500)
    city: str | None = Field(default=None, max_length=100)
    state_code: str | None = Field(default=None, max_length=2)
    pin_code: str | None = Field(default=None, max_length=10)
    country: str | None = Field(default=None, max_length=2)
    email: str = Field(min_length=3, max_length=320)
    # UAE (AED wallets): Tax Registration Number and emirate.
    trn: str | None = Field(default=None, max_length=30)
    emirate: str | None = Field(default=None, max_length=40)


@router.get("/organizations/{organization_id}/billing/profile")
def get_profile(ctx: OrgCtx, db: DB):
    return invoices.get_profile(db, ctx)


@router.put("/organizations/{organization_id}/billing/profile")
def put_profile(body: ProfileBody, ctx: OrgCtx, db: DB):
    out = invoices.save_profile(db, ctx, body.model_dump())
    db.commit()
    return out


@router.get("/organizations/{organization_id}/billing/quote")
def checkout_quote(ctx: OrgCtx, db: DB, amount: Decimal = Query(gt=0, max_digits=12, decimal_places=2)):
    return invoices.quote(db, ctx, amount)


@router.get("/organizations/{organization_id}/billing/invoices")
def list_invoices(ctx: OrgCtx, db: DB, paging: Paging):
    return invoices.list_invoices(db, ctx, paging)


@router.get("/organizations/{organization_id}/billing/invoices/{invoice_id}.pdf")
def invoice_pdf(invoice_id: str, ctx: OrgCtx, db: DB):
    inv = invoices.get_invoice(db, ctx, invoice_id)
    return Response(invoices.render_pdf(inv), media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{invoices.pdf_filename(inv)}"',
                             "Cache-Control": "private, no-store"})


@router.get("/organizations/{organization_id}/billing/statements/{month}.csv")
def statement_csv(month: str, ctx: OrgCtx, db: DB):
    return Response(invoices.statement_csv(db, ctx, month), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="usage-statement-{month[:7]}.csv"'})


@router.get("/organizations/{organization_id}/billing/statements/{month}.pdf")
def statement_pdf(month: str, ctx: OrgCtx, db: DB):
    return Response(invoices.statement_pdf(db, ctx, month), media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="usage-statement-{month[:7]}.pdf"'})


@router.get("/apps/{app_id}/billing")
def app_summary(ctx: AppCtx, db: DB):
    return service.summary(db, ctx, ctx.application_id)


@router.get("/apps/{app_id}/billing/transactions")
def app_transactions(ctx: AppCtx, db: DB, paging: Paging, type_: str | None = Query(None, alias="type", max_length=20)):
    return service.transactions(db, ctx, paging, type_, ctx.application_id)
