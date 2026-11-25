"""Data-subject rights (DPDP Act 2023 / GDPR): download all of a contact's data, erase a contact, and the
organization's log of these requests. Owners and admins only (privacy.manage)."""
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response

from app.api.deps import DB, AppCtx, OrgCtx, ip_of
from app.core.rate_limit import rate_limit
from app.schemas.privacy import DataRequestPage, EraseRequest, EraseResult
from app.services import privacy

router = APIRouter(tags=["Privacy"])


@router.get("/apps/{app_id}/contacts/{contact_id}/data-export",
            dependencies=[Depends(rate_limit("data_export", 20))],
            responses={200: {"content": {"application/zip": {}}}})
def export_contact_data(contact_id: str, request: Request, ctx: AppCtx, db: DB):
    """A ZIP with contact.json (everything: profile, custom fields, consents with evidence, lists, tags,
    email/SMS/voice/chat messages and transcripts, form submissions, CRM notes, tasks, deals and activities)
    plus a CSV per area."""
    filename, payload = privacy.export_contact(db, ctx, contact_id, ip_of(request))
    db.commit()
    return Response(payload, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"})


@router.post("/apps/{app_id}/contacts/{contact_id}/erase", response_model=EraseResult,
             dependencies=[Depends(rate_limit("data_erase", 30))])
def erase_contact(contact_id: str, body: EraseRequest, request: Request, ctx: AppCtx, db: DB):
    """Permanently erase a contact and their personal data everywhere (send `{"confirm": "ERASE"}`).
    A hashed suppression entry is kept so they are never re-imported or messaged. Idempotent."""
    out = privacy.erase_contact(db, ctx, contact_id, body.confirm, ip_of(request))
    db.commit()
    return out


@router.get("/organizations/{organization_id}/data-requests", response_model=DataRequestPage)
def data_requests(ctx: OrgCtx, db: DB, page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100),
                  kind: Literal["export", "erasure"] | None = None):
    return privacy.list_requests(db, ctx, page, page_size, kind)
