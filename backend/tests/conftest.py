"""Test fixtures.

Tests run against a dedicated MySQL database (TEST_DATABASE_URL, default `signalcraft_test` on
localhost) built by the real Alembic migrations, with Celery in eager mode and the simulation email
provider writing to a temporary mailbox. The test database is wiped at the start of every run.
"""
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from urllib.parse import unquote

_TMP = Path(tempfile.mkdtemp(prefix="signalcraft-tests-"))
os.environ["ENVIRONMENT"] = "test"
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "mysql+pymysql://root:@127.0.0.1:3306/signalcraft_test?charset=utf8mb4")
if "test" not in os.environ["DATABASE_URL"].rsplit("/", 1)[-1]:
    raise RuntimeError("TEST_DATABASE_URL must name a database containing 'test'; the suite wipes it")
os.environ["CELERY_TASK_ALWAYS_EAGER"] = "true"
os.environ["SIMULATION_MAILBOX_PATH"] = str(_TMP / "mailbox")
os.environ["LOCAL_STORAGE_PATH"] = str(_TMP / "storage")
os.environ["COMMUNICATION_MODE"] = "simulation"
os.environ["SYSTEM_EMAIL_PROVIDER"] = "simulation"
os.environ["RATE_LIMIT_ENABLED"] = "true"
os.environ["RATE_LIMIT_AUTH_PER_MINUTE"] = "1000"
os.environ["LOG_LEVEL"] = "WARNING"
os.environ["ANTHROPIC_API_KEY"] = ""  # AI agents use the offline responder in tests
os.environ["EMAIL_DNS_CHECKS_ENABLED"] = "false"  # no real DNS; domain tests switch it on with a mocked resolver

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.database import engine  # noqa: E402
from app.core.rate_limit import reset_rate_limits  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base  # noqa: E402

BACKEND_DIR = Path(__file__).resolve().parents[1]
PASSWORD = "Sup3rSecretPass"
SEEDED_TABLES = {"roles", "permissions", "role_permissions", "alembic_version"}


def alembic_config(url: str) -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.attributes["database_url"] = url
    return cfg


@pytest.fixture(scope="session", autouse=True)
def _database():
    with engine.begin() as conn:
        conn.execute(text("SET FOREIGN_KEY_CHECKS=0"))
        Base.metadata.drop_all(conn)
        conn.execute(text("DROP TABLE IF EXISTS alembic_version"))
    command.upgrade(alembic_config(settings.DATABASE_URL), "head")
    yield
    engine.dispose()
    shutil.rmtree(_TMP, ignore_errors=True)


@pytest.fixture(autouse=True)
def _sms_enabled(monkeypatch):
    """SMS is "coming soon" in production (SMS_ENABLED=False); the suite tests it switched on by default.
    Tests of the kill switch set it back to False."""
    monkeypatch.setattr(settings, "SMS_ENABLED", True)


@pytest.fixture(autouse=True)
def _clean_state():
    yield
    with engine.begin() as conn:
        conn.execute(text("SET FOREIGN_KEY_CHECKS=0"))
        for table in reversed(Base.metadata.sorted_tables):
            if table.name not in SEEDED_TABLES:
                conn.execute(table.delete())
        conn.execute(text("SET FOREIGN_KEY_CHECKS=1"))
    shutil.rmtree(settings.SIMULATION_MAILBOX_PATH, ignore_errors=True)
    reset_rate_limits()


# ------------------------------------------------------------------ helpers

def mailbox(to: str | None = None) -> list[dict]:
    box = Path(settings.SIMULATION_MAILBOX_PATH)
    if not box.exists():
        return []
    items = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(box.glob("*.json"))]
    return [m for m in items if to is None or m["to"] == to.lower()]


def token_from_last_email(to: str, path: str) -> str:
    mails = mailbox(to)
    assert mails, f"no email sent to {to}"
    match = re.search(rf"{re.escape(path)}\?token=([^\s\"&<]+)", mails[-1]["text"])
    assert match, f"no {path} link in email"
    return unquote(match.group(1))


class Api:
    """A signed-in API client. Each instance has its own cookie jar."""

    def __init__(self):
        self.client = TestClient(app)
        self.token: str | None = None
        self.user: dict | None = None

    @property
    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def _call(self, method: str, url: str, **kw):
        headers = {**self.headers, **kw.pop("headers", {})}
        return self.client.request(method, f"/api/v1{url}", headers=headers, **kw)

    def get(self, url, **kw):
        return self._call("GET", url, **kw)

    def post(self, url, **kw):
        return self._call("POST", url, **kw)

    def put(self, url, **kw):
        return self._call("PUT", url, **kw)

    def patch(self, url, **kw):
        return self._call("PATCH", url, **kw)

    def delete(self, url, **kw):
        return self._call("DELETE", url, **kw)

    def register(self, email: str, name: str = "Test User", verify: bool = True, invitation_token: str | None = None):
        body = {"email": email, "password": PASSWORD, "full_name": name}
        if invitation_token:
            body["invitation_token"] = invitation_token
        r = self.post("/auth/register", json=body)
        assert r.status_code == 201, r.text
        self.token = r.json()["access_token"]
        self.user = r.json()["user"]
        if verify and not self.user["email_verified"]:
            token = token_from_last_email(email, "/verify-email")
            v = self.post("/auth/verify-email", json={"token": token})
            assert v.status_code == 200, v.text
            self.user = v.json()
        return self

    def login(self, email: str, password: str = PASSWORD):
        r = self.post("/auth/login", json={"email": email, "password": password})
        assert r.status_code == 200, r.text
        self.token = r.json()["access_token"]
        self.user = r.json()["user"]
        return self

    def create_org(self, name: str = "Acme Corp") -> dict:
        r = self.post("/organizations", json={"name": name})
        assert r.status_code == 201, r.text
        return r.json()

    def create_app(self, org_id: str, name: str = "Main App") -> dict:
        r = self.post("/applications", json={"organization_id": org_id, "name": name, "timezone": "Asia/Kolkata"})
        assert r.status_code == 201, r.text
        return r.json()


@pytest.fixture
def api_factory():
    return Api


@pytest.fixture
def owner():
    """A verified user who owns an organization with one application."""
    a = Api().register("owner@example.com", "Olivia Owner")
    a.org = a.create_org("Acme Corp")
    a.app = a.create_app(a.org["id"], "Acme Main")
    return a


def invite_and_join(owner: Api, email: str, role: str, application_ids: list[str] | None = None) -> Api:
    r = owner.post(f"/organizations/{owner.org['id']}/invitations",
                   json={"email": email, "role": role, "application_ids": application_ids or []})
    assert r.status_code == 201, r.text
    token = token_from_last_email(email, "/invite")
    return Api().register(email, email.split("@")[0].title(), invitation_token=token)


def make_pro(organization_id: str) -> None:
    """Put an organization on Pro for a month without charging the wallet (for tests that need
    more than Starter's limits)."""
    from datetime import timedelta

    from app.core.database import SessionLocal
    from app.models.billing import Subscription
    from app.services.billing import subscriptions
    from app.utils.time import utcnow

    with SessionLocal() as db:
        sub = subscriptions.get(db, organization_id) or Subscription(organization_id=organization_id)
        now = utcnow().replace(microsecond=0)
        sub.plan, sub.status, sub.scheduled_plan, sub.cancel_at_period_end = "pro", "active", None, False
        sub.current_period_start, sub.current_period_end = now, now + timedelta(days=30)
        db.add(sub)
        db.commit()
