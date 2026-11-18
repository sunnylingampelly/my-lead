"""Migrations, security primitives, logging redaction and system endpoints."""
import jwt
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, select

from app.core import crypto, security
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import _redact
from app.core.permissions import ROLE_PERMISSIONS, Perm, Role, can_assign
from app.models import Base, RolePermission
from tests.conftest import Api


def test_migrations_match_models(tmp_path):
    from alembic import command

    from tests.conftest import alembic_config

    url = f"sqlite:///{(tmp_path / 'm.db').as_posix()}"
    command.upgrade(alembic_config(url), "head")
    eng = create_engine(url)
    with eng.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn, opts={"compare_type": True}), Base.metadata)
    eng.dispose()
    assert diff == [], diff
    command.downgrade(alembic_config(url), "base")


def test_rbac_seeded_matches_code():
    with SessionLocal() as db:
        rows = db.execute(select(RolePermission.role_key, RolePermission.permission_key)).all()
    seeded = {(r, p) for r, p in rows}
    expected = {(r.value, p.value) for r, perms in ROLE_PERMISSIONS.items() for p in perms}
    assert seeded == expected


def test_role_hierarchy_rules():
    assert can_assign(Role.OWNER, Role.OWNER)
    assert not can_assign(Role.ADMIN, Role.ADMIN)
    assert can_assign(Role.ADMIN, Role.APPLICATION_MANAGER)
    assert Perm.ORG_DELETE not in ROLE_PERMISSIONS[Role.ADMIN]
    assert Perm.CAMPAIGNS_WRITE not in ROLE_PERMISSIONS[Role.ANALYST]


def test_password_hashing_and_tokens():
    h = security.hash_password("Abcdefgh123")
    assert h.startswith("$argon2") and security.verify_password("Abcdefgh123", h)
    assert not security.verify_password("wrong", h)
    token, _ = security.create_access_token("u1", "s1")
    assert security.decode_access_token(token)["sub"] == "u1"
    forged = jwt.encode({"sub": "u1", "sid": "s1", "typ": "access", "exp": 9999999999}, "wrong-key", "HS256")
    try:
        security.decode_access_token(forged)
        raise AssertionError("forged token accepted")
    except jwt.InvalidTokenError:
        pass
    assert security.hash_token("abc") != "abc" and len(security.hash_token("abc")) == 64


def test_secret_encryption_roundtrip():
    enc = crypto.encrypt_json({"api_key": "sk_live_123456789"})
    assert "sk_live" not in enc
    assert crypto.decrypt_json(enc) == {"api_key": "sk_live_123456789"}
    assert crypto.mask_secret("sk_live_123456789") == "****6789"


def test_log_redaction():
    out = _redact(None, None, {"event": "x", "password": "p", "Authorization": "Bearer t", "user_id": "u"})
    assert out["password"] == "[REDACTED]" and out["Authorization"] == "[REDACTED]" and out["user_id"] == "u"


def test_health_and_error_envelope():
    a = Api()
    h = a.get("/health")
    assert h.status_code == 200 and h.json()["checks"]["database"] == "ok"
    assert h.json()["communication_mode"] == "simulation"
    nf = a.get("/does-not-exist")
    assert nf.status_code == 404 and nf.json()["error"]["code"] == "NOT_FOUND"
    assert nf.headers["x-request-id"] and nf.json()["error"]["request_id"] == nf.headers["x-request-id"]


def test_dev_mailbox_lists_simulated_mail():
    Api().register("mb@example.com", verify=False)
    box = Api().get("/dev/mailbox?to=mb@example.com").json()
    assert box["simulation"] is True and box["items"][0]["subject"].startswith("Verify your email")


def test_production_settings_guards():
    import pytest
    from pydantic import ValidationError

    from app.core.config import Settings

    with pytest.raises(ValidationError):
        Settings(ENVIRONMENT="production")
    ok = Settings(ENVIRONMENT="production", SECRET_KEY="x" * 40, ENCRYPTION_KEY="y" * 40, DEV_MAILBOX_ENABLED=False,
                  COOKIE_SECURE=True)
    assert ok.dev_mailbox_active is False
    assert settings.ENVIRONMENT == "test"
