from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status

from app.api.deps import DB, CurrentUser, OrgCtx, ip_of
from app.schemas.common import Page, PageParams
from app.schemas.organization import (
    AuditLogOut,
    InvitationCreate,
    InvitationOut,
    MemberOut,
    MemberUpdate,
    MyOrganizationOut,
    OrganizationCreate,
    OrganizationUpdate,
    RoleOut,
)
from app.services import invitation_service, organization_service

router = APIRouter(prefix="/organizations", tags=["Organizations"])

Paging = Annotated[PageParams, Depends()]


@router.get("", response_model=list[MyOrganizationOut])
def list_organizations(user: CurrentUser, db: DB):
    return organization_service.list_my_organizations(db, user)


@router.post("", response_model=MyOrganizationOut, status_code=status.HTTP_201_CREATED)
def create_organization(body: OrganizationCreate, request: Request, user: CurrentUser, db: DB):
    org = organization_service.create_organization(db, user, body, ip=ip_of(request))
    db.commit()
    return organization_service._my_org(org, "owner", 0)


@router.get("/{organization_id}", response_model=MyOrganizationOut)
def get_organization(ctx: OrgCtx, db: DB):
    return organization_service.describe_for_member(db, ctx)


@router.patch("/{organization_id}", response_model=MyOrganizationOut)
def update_organization(body: OrganizationUpdate, ctx: OrgCtx, db: DB):
    organization_service.update_organization(db, ctx, body)
    db.commit()
    return organization_service.describe_for_member(db, ctx)


@router.get("/{organization_id}/roles", response_model=list[RoleOut])
def list_roles(ctx: OrgCtx):
    return organization_service.list_roles(ctx)


@router.get("/{organization_id}/members", response_model=Page[MemberOut])
def list_members(ctx: OrgCtx, db: DB, paging: Paging, search: str | None = Query(None, max_length=100)):
    return organization_service.list_members(db, ctx, paging, search)


@router.patch("/{organization_id}/members/{member_id}", response_model=MemberOut)
def update_member(member_id: str, body: MemberUpdate, ctx: OrgCtx, db: DB):
    out = organization_service.update_member(db, ctx, member_id, body)
    db.commit()
    return out


@router.delete("/{organization_id}/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(member_id: str, ctx: OrgCtx, db: DB):
    organization_service.remove_member(db, ctx, member_id)
    db.commit()


@router.get("/{organization_id}/invitations", response_model=list[InvitationOut])
def list_invitations(ctx: OrgCtx, db: DB, include_inactive: bool = False):
    return invitation_service.list_invitations(db, ctx, include_inactive)


@router.post("/{organization_id}/invitations", response_model=InvitationOut, status_code=status.HTTP_201_CREATED)
def create_invitation(body: InvitationCreate, ctx: OrgCtx, db: DB):
    return invitation_service.create_invitation(db, ctx, body)


@router.post("/{organization_id}/invitations/{invitation_id}/resend", response_model=InvitationOut)
def resend_invitation(invitation_id: str, ctx: OrgCtx, db: DB):
    return invitation_service.resend_invitation(db, ctx, invitation_id)


@router.delete("/{organization_id}/invitations/{invitation_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_invitation(invitation_id: str, ctx: OrgCtx, db: DB):
    invitation_service.revoke_invitation(db, ctx, invitation_id)
    db.commit()


@router.get("/{organization_id}/audit-logs", response_model=Page[AuditLogOut])
def audit_logs(ctx: OrgCtx, db: DB, paging: Paging, application_id: str | None = Query(None, max_length=36)):
    return organization_service.list_audit_logs(db, ctx, paging, application_id)
