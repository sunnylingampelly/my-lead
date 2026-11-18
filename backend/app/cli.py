"""Operator commands.

    python -m app.cli create-superadmin someone@example.com "Full Name"   (prompts for a password)
    python -m app.cli grant-admin someone@example.com      (make an existing user a super admin)
    python -m app.cli grant-support someone@example.com    (read-only platform support)
    python -m app.cli revoke-admin someone@example.com
    python -m app.cli settle-usage
    python -m app.cli sync-rbac        (roles and permissions; migrations do this automatically)
"""
import sys

from sqlalchemy import func, select

from app.core.database import SessionLocal
from app.models import User


def _set_admin(email: str, value: bool, role: str = "super_admin") -> int:
    with SessionLocal() as db:
        u = db.scalar(select(User).where(func.lower(User.email) == email.strip().lower()))
        if u is None:
            print(f"No user with email {email}. They must register first.")
            return 1
        u.is_platform_admin = value
        u.platform_role = role if value else None
        from app.services import audit_service

        audit_service.record(db, "admin.platform_admin_granted" if value else "admin.platform_admin_revoked",
                             actor_user_id=None, target_type="user", target_id=u.id, summary=f"{u.email} (via CLI)")
        db.commit()
        print(f"{u.email} is {'now a platform ' + role.replace('_', ' ') if value else 'no longer platform staff'}.")
        return 0


def _create_superadmin(email: str, name: str, password: str | None) -> int:
    import getpass

    from app.core.security import hash_password
    from app.utils.time import utcnow

    with SessionLocal() as db:
        exists = db.scalar(select(User.id).where(func.lower(User.email) == email.strip().lower())) is not None
    if exists:
        return _set_admin(email, True)
    password = password or getpass.getpass("Password (12+ characters): ")
    if len(password) < 12:
        print("Use at least 12 characters.")
        return 1
    with SessionLocal() as db:
        u = User(email=email.strip().lower(), full_name=name.strip() or "Super Admin", password_hash=hash_password(password),
                 email_verified_at=utcnow(), is_active=True, is_platform_admin=True, platform_role="super_admin")
        db.add(u)
        db.commit()
        print(f"Created super admin {u.email}. Sign in at /login and open Platform admin from your profile menu.")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "create-superadmin":
        return _create_superadmin(argv[1], argv[2] if len(argv) > 2 else "", argv[3] if len(argv) > 3 else None)
    if len(argv) >= 2 and argv[0] in ("grant-admin", "revoke-admin", "grant-support"):
        return _set_admin(argv[1], argv[0] != "revoke-admin", "support" if argv[0] == "grant-support" else "super_admin")
    if argv[:1] == ["sync-rbac"]:
        from app.core.database import engine
        from app.core.rbac_sync import sync_rbac

        with engine.begin() as conn:
            sync_rbac(conn)
        print("Roles and permissions are up to date.")
        return 0
    if argv[:1] == ["settle-usage"]:
        from app.services.billing.wallet import run_settlement

        print(run_settlement())
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
