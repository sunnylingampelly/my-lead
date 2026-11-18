from fastapi import APIRouter, Depends

from app.api.deps import DB, CurrentUser
from app.core.rate_limit import rate_limit
from app.schemas.auth import TokenRequest
from app.schemas.organization import InvitationPreview, MyOrganizationOut
from app.services import invitation_service, organization_service
from app.services.tenancy import resolve_org_context

router = APIRouter(prefix="/invitations", tags=["Invitations"])


@router.post("/preview", response_model=InvitationPreview, dependencies=[Depends(rate_limit("invite_preview", 30))])
def preview_invitation(body: TokenRequest, db: DB):
    """Public: shows which organization and address an invitation is for, so the invitee can
    sign in or register with the right email. The token is sent in the body, not the URL."""
    return invitation_service.preview(db, body.token)


@router.post("/accept", response_model=MyOrganizationOut)
def accept_invitation(body: TokenRequest, user: CurrentUser, db: DB):
    org = invitation_service.accept(db, user, body.token)
    db.commit()
    return organization_service.describe_for_member(db, resolve_org_context(db, user, org.id))
