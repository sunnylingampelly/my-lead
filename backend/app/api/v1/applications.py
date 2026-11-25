from typing import Annotated

from fastapi import APIRouter, Query, status

from app.api.deps import DB, AppCtx, CurrentUser
from app.schemas.application import (
    ApplicationCreate,
    ApplicationDelete,
    ApplicationSettingsOut,
    ApplicationSettingsUpdate,
    ApplicationUpdate,
    AppMemberAdd,
    AppMemberOut,
    MyApplicationOut,
)
from app.services import application_service, dashboard_service, provider_status
from app.services.tenancy import resolve_org_context

router = APIRouter(tags=["Applications"])


@router.get("/applications", response_model=list[MyApplicationOut])
def list_applications(organization_id: Annotated[str, Query(max_length=36)], user: CurrentUser, db: DB):
    """Applications in an organization that the current user can access."""
    ctx = resolve_org_context(db, user, organization_id)
    return application_service.list_applications(db, ctx)


@router.post("/applications", response_model=MyApplicationOut, status_code=status.HTTP_201_CREATED)
def create_application(body: ApplicationCreate, user: CurrentUser, db: DB):
    ctx = resolve_org_context(db, user, body.organization_id)
    app = application_service.create_application(db, ctx, body)
    db.commit()
    from app.services.tenancy import resolve_app_context

    actx = resolve_app_context(db, user, app.id)
    return application_service.to_my_app(app, actx.role)


@router.get("/applications/{app_id}", response_model=MyApplicationOut)
def get_application(ctx: AppCtx):
    return application_service.to_my_app(ctx.application, ctx.role)


@router.patch("/applications/{app_id}", response_model=MyApplicationOut)
def update_application(body: ApplicationUpdate, ctx: AppCtx, db: DB):
    app = application_service.update_application(db, ctx, body)
    db.commit()
    return application_service.to_my_app(app, ctx.role)


@router.delete("/applications/{app_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_application(body: ApplicationDelete, ctx: AppCtx, db: DB):
    """Requires the exact application name in the body as confirmation."""
    application_service.delete_application(db, ctx, body.confirm_name)
    db.commit()


@router.get("/applications/{app_id}/settings", response_model=ApplicationSettingsOut)
def get_settings(ctx: AppCtx, db: DB):
    s = application_service.get_settings(db, ctx)
    db.commit()
    return s


@router.patch("/applications/{app_id}/settings", response_model=ApplicationSettingsOut)
def update_settings(body: ApplicationSettingsUpdate, ctx: AppCtx, db: DB):
    s = application_service.update_settings(db, ctx, body)
    db.commit()
    return s


@router.get("/applications/{app_id}/members", response_model=list[AppMemberOut])
def list_members(ctx: AppCtx, db: DB):
    return application_service.list_app_members(db, ctx)


@router.post("/applications/{app_id}/members", status_code=status.HTTP_204_NO_CONTENT)
def add_member(body: AppMemberAdd, ctx: AppCtx, db: DB):
    application_service.add_app_member(db, ctx, body)
    db.commit()


@router.delete("/applications/{app_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(user_id: str, ctx: AppCtx, db: DB):
    application_service.remove_app_member(db, ctx, user_id)
    db.commit()


@router.get("/applications/{app_id}/compliance")
def compliance(ctx: AppCtx, db: DB):
    return application_service.compliance(db, ctx)


@router.get("/regions")
def regions(user: CurrentUser):
    """Markets with first-class support and their defaults."""
    from app.services.regions import PROFILES

    return [{"code": p.code, "name": p.name, "currency": p.currency, "dial_code": p.dial_code,
             "default_timezone": p.default_timezone} for p in PROFILES.values()]


@router.get("/apps/{app_id}/dashboard")
def dashboard(ctx: AppCtx, db: DB):
    return dashboard_service.overview(db, ctx)


@router.get("/apps/{app_id}/dashboard/checklist")
def dashboard_checklist(ctx: AppCtx, db: DB):
    """Just the getting-started steps (light enough for the sidebar's setup progress)."""
    return dashboard_service.checklist(db, ctx)


@router.get("/apps/{app_id}/providers/status")
def providers_status(ctx: AppCtx):
    """Which delivery providers are connected on the platform and whether sending is simulated."""
    return provider_status.status(ctx)
