"""Platform administration. Only users with is_platform_admin may call these; every change is audited.
Secrets are never returned: settings are reported as configured / not configured."""
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.models import Application, Contact, Organization, OrganizationMember, User, UserSession
from app.models.automation import WorkflowRun
from app.models.billing import Wallet, WalletTransaction
from app.models.email import EmailMessage, WebhookEvent
from app.models.sms import SmsMessage
from app.models.voice import VoiceCall
from app.schemas.common import Page, PageParams
from app.services import audit_service
from app.services.billing import wallet as wl
from app.utils.time import utcnow


def _audit(db: Session, admin: User, action: str, target_type: str, target_id: str, summary: str,
           organization_id: str | None = None, meta: dict | None = None) -> None:
    audit_service.record(db, f"admin.{action}", actor_user_id=admin.id, organization_id=organization_id,
                         target_type=target_type, target_id=target_id, summary=summary, meta=meta)


def overview(db: Session) -> dict:
    since = utcnow() - timedelta(hours=24)
    count = lambda q: db.scalar(q) or 0  # noqa: E731
    balances = dict(db.execute(select(Wallet.currency, func.sum(Wallet.balance)).group_by(Wallet.currency)).all())
    webhooks = dict(db.execute(select(WebhookEvent.status, func.count()).where(WebhookEvent.received_at >= since)
                               .group_by(WebhookEvent.status)).all())
    return {
        "organizations": count(select(func.count()).select_from(Organization)),
        "suspended_organizations": count(select(func.count()).select_from(Organization)
                                         .where(Organization.status == "suspended")),
        "users": count(select(func.count()).select_from(User).where(User.deleted_at.is_(None))),
        "applications": count(select(func.count()).select_from(Application)),
        "contacts": count(select(func.count()).select_from(Contact)),
        "last_24h": {
            "emails": count(select(func.count()).select_from(EmailMessage).where(EmailMessage.accepted_at >= since)),
            "texts": count(select(func.count()).select_from(SmsMessage).where(SmsMessage.accepted_at >= since)),
            "calls": count(select(func.count()).select_from(VoiceCall).where(VoiceCall.ended_at >= since)),
            "journeys": count(select(func.count()).select_from(WorkflowRun).where(WorkflowRun.started_at >= since)),
            "webhooks": webhooks,
        },
        "failed_runs": count(select(func.count()).select_from(WorkflowRun).where(WorkflowRun.status == "failed")),
        "wallet_balances": {k: float(v or 0) for k, v in balances.items()},
        "communication_mode": settings.COMMUNICATION_MODE,
    }


# ------------------------------------------------------------------ organizations


def list_organizations(db: Session, params: PageParams, search: str | None, status: str | None) -> Page:
    q = select(Organization)
    if search:
        like = f"%{search.strip().lower()}%"
        q = q.where(or_(func.lower(Organization.name).like(like), func.lower(Organization.slug).like(like)))
    if status:
        q = q.where(Organization.status == status)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = list(db.scalars(q.order_by(Organization.created_at.desc()).offset(params.offset).limit(params.page_size)))
    ids = [o.id for o in rows]
    members = dict(db.execute(select(OrganizationMember.organization_id, func.count()).where(
        OrganizationMember.organization_id.in_(ids)).group_by(OrganizationMember.organization_id)).all())
    apps = dict(db.execute(select(Application.organization_id, func.count()).where(
        Application.organization_id.in_(ids)).group_by(Application.organization_id)).all())
    wallets = {w.organization_id: w for w in db.scalars(select(Wallet).where(Wallet.organization_id.in_(ids)))}
    items = [{"id": o.id, "name": o.name, "slug": o.slug, "country": o.country, "status": o.status,
              "created_at": o.created_at.isoformat(), "members": members.get(o.id, 0), "applications": apps.get(o.id, 0),
              "wallet": ({"currency": wallets[o.id].currency, "balance": float(wallets[o.id].balance)}
                         if o.id in wallets else None)}
             for o in rows]
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def organization_detail(db: Session, org_id: str) -> dict:
    o = db.get(Organization, org_id)
    if o is None:
        raise NotFound("Organization not found")
    w = wl.get_wallet(db, o.id)
    db.commit()
    members = db.execute(select(User.id, User.full_name, User.email, OrganizationMember.role_key).join(
        OrganizationMember, OrganizationMember.user_id == User.id).where(OrganizationMember.organization_id == o.id)).all()
    apps = db.execute(select(Application.id, Application.name, Application.default_country, Application.created_at).where(
        Application.organization_id == o.id)).all()
    tx = db.scalars(select(WalletTransaction).where(WalletTransaction.wallet_id == w.id)
                    .order_by(WalletTransaction.created_at.desc()).limit(20))
    return {
        "id": o.id, "name": o.name, "slug": o.slug, "country": o.country, "status": o.status,
        "industry": o.industry, "website": o.website, "created_at": o.created_at.isoformat(),
        "members": [{"id": i, "name": n, "email": e, "role": r} for i, n, e, r in members],
        "applications": [{"id": i, "name": n, "country": c, "created_at": t.isoformat()} for i, n, c, t in apps],
        "wallet": {"currency": w.currency, "balance": float(w.balance), "available": float(wl.available(db, w)),
                   "held": float(wl.held(db, w))},
        "transactions": [{"id": t.id, "type": t.type, "amount": float(t.amount), "description": t.description,
                          "balance_after": float(t.balance_after), "created_at": t.created_at.isoformat()} for t in tx],
    }


def set_org_status(db: Session, admin: User, org_id: str, status: str, reason: str) -> None:
    o = db.get(Organization, org_id)
    if o is None:
        raise NotFound("Organization not found")
    if o.status == status:
        return
    o.status = status
    _audit(db, admin, "organization_suspended" if status == "suspended" else "organization_reactivated",
           "organization", o.id, f"{o.name}: {reason}"[:255], organization_id=o.id, meta={"reason": reason})


def adjust_wallet(db: Session, admin: User, org_id: str, kind: str, amount: Decimal, reason: str, key: str) -> dict:
    o = db.get(Organization, org_id)
    if o is None:
        raise NotFound("Organization not found")
    if kind not in ("credit", "adjustment", "refund"):
        raise ValidationFailed("Choose credit, refund or adjustment")
    if kind in ("credit", "refund") and amount <= 0:
        raise ValidationFailed("Credits and refunds must be positive")
    if amount == 0:
        raise ValidationFailed("Enter a non-zero amount")
    w = wl.get_wallet(db, o.id)
    tx = wl.post(db, w, kind, amount, description=f"{kind.capitalize()} by platform: {reason}"[:255],
                 idempotency_key=f"admin:{key}", actor_id=admin.id, meta={"reason": reason})
    if tx is None:
        raise Conflict("This adjustment was already applied", code="DUPLICATE_REQUEST")
    _audit(db, admin, f"wallet_{kind}", "wallet", w.id, f"{o.name}: {w.currency} {amount}", organization_id=o.id,
           meta={"amount": float(amount), "currency": w.currency, "reason": reason})
    return {"balance": float(w.balance), "currency": w.currency}


# ------------------------------------------------------------------ users


def list_users(db: Session, params: PageParams, search: str | None) -> Page:
    q = select(User).where(User.deleted_at.is_(None))
    if search:
        like = f"%{search.strip().lower()}%"
        q = q.where(or_(func.lower(User.email).like(like), func.lower(User.full_name).like(like)))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = list(db.scalars(q.order_by(User.created_at.desc()).offset(params.offset).limit(params.page_size)))
    orgs = {}
    for uid, n in db.execute(select(OrganizationMember.user_id, func.count()).where(
            OrganizationMember.user_id.in_([u.id for u in rows])).group_by(OrganizationMember.user_id)):
        orgs[uid] = n
    items = [{"id": u.id, "name": u.full_name, "email": u.email, "is_active": u.is_active,
              "is_platform_admin": u.is_platform_admin, "email_verified": u.email_verified_at is not None,
              "organizations": orgs.get(u.id, 0), "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
              "created_at": u.created_at.isoformat()} for u in rows]
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def set_user_active(db: Session, admin: User, user_id: str, active: bool, reason: str) -> None:
    u = db.get(User, user_id)
    if u is None or u.deleted_at is not None:
        raise NotFound("User not found")
    if u.id == admin.id:
        raise ValidationFailed("You cannot suspend your own account", code="SELF_ACTION")
    if u.is_active == active:
        return
    u.is_active = active
    if not active:
        # Sign the user out everywhere straight away.
        db.execute(update(UserSession).where(UserSession.user_id == u.id, UserSession.revoked_at.is_(None))
                   .values(revoked_at=utcnow()))
    _audit(db, admin, "user_reactivated" if active else "user_suspended", "user", u.id, f"{u.email}: {reason}"[:255],
           meta={"reason": reason})


# ------------------------------------------------------------------ webhooks


def list_webhooks(db: Session, params: PageParams, status: str | None, provider: str | None) -> Page:
    q = select(WebhookEvent)
    if status:
        q = q.where(WebhookEvent.status == status)
    if provider:
        q = q.where(WebhookEvent.provider == provider)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(q.order_by(WebhookEvent.received_at.desc()).offset(params.offset).limit(params.page_size))
    items = [{"id": w.id, "provider": w.provider, "channel": w.channel, "event_type": w.event_type, "status": w.status,
              "error": w.error, "received_at": w.received_at.isoformat(),
              "processed_at": w.processed_at.isoformat() if w.processed_at else None} for w in rows]
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def retry_webhook(db: Session, admin: User, webhook_id: str) -> str:
    w = db.get(WebhookEvent, webhook_id)
    if w is None:
        raise NotFound("Webhook event not found")
    if w.status == "processed":
        raise Conflict("This event was already processed", code="ALREADY_PROCESSED")
    w.status, w.error, w.processed_at = "received", None, None
    _audit(db, admin, "webhook_retried", "webhook_event", w.id, f"{w.provider} {w.event_type or ''}")
    db.commit()
    from app.workers.dispatch import dispatch

    if w.channel == "sms":
        from app.tasks.sms import process_sms_webhook as task
    elif w.channel == "voice":
        from app.tasks.voice import process_voice_webhook as task
    elif w.channel == "payments":
        from app.tasks.payments import process_payment_webhook as task
    else:
        from app.tasks.email import process_webhook_event as task
    dispatch(task, w.id)
    db.refresh(w)
    return w.status


# ------------------------------------------------------------------ settings


def effective_settings() -> dict:
    """What is configured, without revealing any secret."""
    s = settings
    has = lambda *vals: all(bool(v) for v in vals)  # noqa: E731
    return {
        "environment": s.ENVIRONMENT, "communication_mode": s.COMMUNICATION_MODE,
        "queue": "in-process" if s.CELERY_TASK_ALWAYS_EAGER else "celery",
        "storage": s.STORAGE_BACKEND, "public_url": s.BACKEND_PUBLIC_URL,
        "providers": {
            "email": {"brevo": has(s.BREVO_API_KEY), "ses": has(s.AWS_ACCESS_KEY_ID, s.AWS_SECRET_ACCESS_KEY),
                      "brevo_webhook": has(s.BREVO_WEBHOOK_TOKEN)},
            "sms": {"sns": has(s.AWS_ACCESS_KEY_ID, s.AWS_SECRET_ACCESS_KEY)},
            "voice": {"telnyx": has(s.TELNYX_API_KEY, s.TELNYX_ACCOUNT_SID, s.TELNYX_TEXML_APP_ID),
                      "telnyx_signatures": has(s.TELNYX_PUBLIC_KEY),
                      "exotel": has(s.EXOTEL_SID, s.EXOTEL_API_KEY, s.EXOTEL_API_TOKEN, s.EXOTEL_APP_ID),
                      "twilio": has(s.TWILIO_ACCOUNT_SID, s.TWILIO_AUTH_TOKEN)},
            "payments": {"stripe": has(s.STRIPE_SECRET_KEY, s.STRIPE_WEBHOOK_SECRET),
                         "razorpay": has(s.RAZORPAY_KEY_ID, s.RAZORPAY_KEY_SECRET, s.RAZORPAY_WEBHOOK_SECRET)},
            "monitoring": {"metrics": has(s.METRICS_TOKEN), "sentry": has(s.SENTRY_DSN)},
        },
        "pricing": {"email": s.EMAIL_PRICING, "sms": s.SMS_PRICING, "voice": s.VOICE_PRICING, "fx": s.FX_RATES},
        "limits": {"email_per_second": s.EMAIL_RATE_PER_SECOND, "sms_per_second": s.SMS_RATE_PER_SECOND,
                   "calls_per_second": s.VOICE_CALLS_PER_SECOND, "max_concurrent_calls": s.VOICE_MAX_CONCURRENT_CALLS},
        "backups": backup_status(),
    }


def backup_status() -> dict:
    """The newest database backup (scripts/backup_db.py) by file modification time. The folder path is
    not returned, only whether one is configured."""
    from datetime import UTC, datetime
    from pathlib import Path

    folder = Path(settings.BACKUP_DIR) if settings.BACKUP_DIR else \
        Path(__file__).resolve().parents[2] / "var" / "backups"
    files = [p for p in folder.glob("*.sql.gz")] if folder.is_dir() else []
    newest = max(files, key=lambda p: p.stat().st_mtime) if files else None
    last = datetime.fromtimestamp(newest.stat().st_mtime, tz=UTC) if newest else None
    age_hours = round((utcnow() - last).total_seconds() / 3600, 1) if last else None
    return {"configured_dir": bool(settings.BACKUP_DIR), "count": len(files),
            "last_backup_at": last.isoformat() if last else None,
            "last_backup_file": newest.name if newest else None,
            "last_backup_bytes": newest.stat().st_size if newest else None,
            "age_hours": age_hours, "stale": last is None or age_hours > 26}



# ------------------------------------------------------------------ platform staff


def _staff_out(u: User) -> dict:
    return {"id": u.id, "name": u.full_name, "email": u.email, "role": u.platform_role, "is_active": u.is_active,
            "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None}


def list_staff(db: Session) -> list[dict]:
    rows = db.scalars(select(User).where(User.platform_role.is_not(None), User.deleted_at.is_(None))
                      .order_by(User.platform_role.desc(), User.full_name))
    return [_staff_out(u) for u in rows]


def _apply_role(u: User, role: str | None) -> None:
    u.platform_role = role
    u.is_platform_admin = role is not None


def _super_admin_count(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(User).where(
        User.platform_role == "super_admin", User.is_active.is_(True), User.deleted_at.is_(None))) or 0


def set_staff_role(db: Session, admin: User, email: str, role: str) -> dict:
    u = db.scalar(select(User).where(func.lower(User.email) == email.strip().lower(), User.deleted_at.is_(None)))
    if u is None:
        raise NotFound("No account with that email. Ask them to sign up first.")
    if u.platform_role == role:
        return _staff_out(u)
    if u.id == admin.id:
        raise ValidationFailed("You cannot change your own platform role", code="SELF_ACTION")
    _apply_role(u, role)
    _audit(db, admin, "staff_granted", "user", u.id, f"{u.email} → {role}", meta={"role": role})
    return _staff_out(u)


def change_staff_role(db: Session, admin: User, user_id: str, role: str) -> dict:
    u = db.get(User, user_id)
    if u is None or u.platform_role is None:
        raise NotFound("Staff member not found")
    if u.id == admin.id:
        raise ValidationFailed("You cannot change your own platform role", code="SELF_ACTION")
    if u.platform_role == "super_admin" and role != "super_admin" and _super_admin_count(db) <= 1:
        raise Conflict("The platform needs at least one super admin", code="LAST_SUPER_ADMIN")
    _apply_role(u, role)
    _audit(db, admin, "staff_role_changed", "user", u.id, f"{u.email} → {role}", meta={"role": role})
    return _staff_out(u)


def remove_staff(db: Session, admin: User, user_id: str) -> None:
    u = db.get(User, user_id)
    if u is None or u.platform_role is None:
        raise NotFound("Staff member not found")
    if u.id == admin.id:
        raise ValidationFailed("You cannot remove yourself", code="SELF_ACTION")
    if u.platform_role == "super_admin" and _super_admin_count(db) <= 1:
        raise Conflict("The platform needs at least one super admin", code="LAST_SUPER_ADMIN")
    _apply_role(u, None)
    # Their open support sessions end with their access.
    from app.models.support import SupportGrant

    db.execute(update(SupportGrant).where(SupportGrant.user_id == u.id, SupportGrant.ended_at.is_(None))
               .values(ended_at=utcnow()))
    _audit(db, admin, "staff_removed", "user", u.id, u.email)


# ------------------------------------------------------------------ support sessions


def _session_out(g, org_name: str, user_name: str) -> dict:
    return {"id": g.id, "organization_id": g.organization_id, "organization": org_name, "user": user_name,
            "reason": g.reason, "created_at": g.created_at.isoformat(), "expires_at": g.expires_at.isoformat(),
            "active": g.ended_at is None and g.expires_at > utcnow()}


def start_support_session(db: Session, admin: User, org_id: str, reason: str, minutes: int) -> dict:
    from app.models.support import SupportGrant
    from app.services.notification_service import notify

    o = db.get(Organization, org_id)
    if o is None or o.deleted_at is not None:
        raise NotFound("Organization not found")
    db.execute(update(SupportGrant).where(SupportGrant.user_id == admin.id, SupportGrant.organization_id == o.id,
                                          SupportGrant.ended_at.is_(None)).values(ended_at=utcnow()))
    g = SupportGrant(organization_id=o.id, user_id=admin.id, reason=reason.strip()[:255],
                     expires_at=utcnow() + timedelta(minutes=minutes))
    db.add(g)
    db.flush()
    # Recorded in the customer's own audit log, and owners are told.
    audit_service.record(db, "support.access_started", actor_user_id=admin.id, organization_id=o.id,
                         target_type="organization", target_id=o.id,
                         summary=f"Platform support ({admin.full_name}) opened read-only access: {reason}"[:255],
                         meta={"minutes": minutes, "grant_id": g.id})
    owners = db.scalars(select(OrganizationMember.user_id).where(
        OrganizationMember.organization_id == o.id, OrganizationMember.role_key.in_(("owner", "admin"))))
    for uid in owners:
        notify(db, uid, type_="support_access", level="info", title="Platform support is viewing your workspace",
               body=f"{admin.full_name} has read-only access for {minutes} minutes. Reason: {reason}"[:500],
               link=f"/orgs/{o.id}/audit-log", organization_id=o.id)
    return _session_out(g, o.name, admin.full_name)


def end_support_session(db: Session, admin: User, grant_id: str) -> None:
    from app.models.support import SupportGrant

    g = db.get(SupportGrant, grant_id)
    if g is None:
        raise NotFound("Support session not found")
    if g.user_id != admin.id and admin.platform_role != "super_admin":
        raise ValidationFailed("You can only end your own support sessions", code="NOT_YOURS")
    if g.ended_at is None:
        g.ended_at = utcnow()
        audit_service.record(db, "support.access_ended", actor_user_id=admin.id, organization_id=g.organization_id,
                             target_type="organization", target_id=g.organization_id,
                             summary=f"Platform support access ended by {admin.full_name}")


def list_support_sessions(db: Session, user_id: str | None) -> list[dict]:
    from app.models.support import SupportGrant

    q = (select(SupportGrant, Organization.name, User.full_name)
         .join(Organization, Organization.id == SupportGrant.organization_id)
         .join(User, User.id == SupportGrant.user_id)
         .order_by(SupportGrant.created_at.desc()).limit(50))
    if user_id:
        q = q.where(SupportGrant.user_id == user_id)
    return [_session_out(g, o, u) for g, o, u in db.execute(q)]
