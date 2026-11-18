"""Analytics endpoints, scoped to /apps/{app_id}/analytics."""
from datetime import date

from fastapi import APIRouter, Query
from fastapi.responses import Response

from app.api.deps import DB, AppCtx
from app.services import analytics

router = APIRouter(prefix="/apps/{app_id}/analytics", tags=["Analytics"])


@router.get("")
def overview(ctx: AppCtx, db: DB, start: date | None = Query(None), end: date | None = Query(None)):
    return analytics.series(db, ctx, start, end)


@router.get("/export.csv")
def export(ctx: AppCtx, db: DB, start: date | None = Query(None), end: date | None = Query(None)):
    body = analytics.export_csv(db, ctx, start, end)
    return Response(body, media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="analytics-{body_dates(start, end)}.csv"'})


def body_dates(start: date | None, end: date | None) -> str:
    return f"{start or 'last-30-days'}{'_' + str(end) if end else ''}"
