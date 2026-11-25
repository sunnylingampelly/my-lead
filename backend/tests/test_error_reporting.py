"""Sentry events never carry credentials, cookies or auth request bodies."""
import sentry_sdk

from app.core import error_reporting
from app.core.error_reporting import FILTERED, scrub_event


def test_scrubs_credentials_and_auth_bodies():
    event = {
        "request": {
            "url": "https://api.example.com/api/v1/auth/login",
            "headers": {"Authorization": "Bearer abc", "Cookie": "sc_refresh=xyz", "User-Agent": "UA"},
            "cookies": {"sc_refresh": "xyz"},
            "query_string": "token=secret123&page=2",
            "data": {"email": "a@b.com", "password": "hunter2"},
        },
        "user": {"id": "u1", "email": "a@b.com", "ip_address": "1.2.3.4"},
    }
    out = scrub_event(event)
    req = out["request"]
    assert req["headers"]["Authorization"] == FILTERED and req["headers"]["Cookie"] == FILTERED
    assert req["headers"]["User-Agent"] == "UA"
    assert "cookies" not in req and "data" not in req
    assert req["query_string"] == f"token={FILTERED}&page=2"
    assert out["user"] == {"id": "u1"}


def test_header_list_form_and_init(monkeypatch):
    out = scrub_event({"request": {"headers": [["authorization", "Bearer x"], ["accept", "json"]]}})
    assert out["request"]["headers"] == [["authorization", FILTERED], ["accept", "json"]]
    seen = {}
    monkeypatch.setattr(error_reporting.settings, "SENTRY_DSN", "https://key@o0.ingest.sentry.io/1")
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: seen.update(kw))
    monkeypatch.setattr(sentry_sdk, "set_tag", lambda *a: None)
    assert error_reporting.init_error_reporting() is True
    assert seen["send_default_pii"] is False and seen["max_request_body_size"] == "never"
    assert seen["environment"] == "test" and seen["release"] and seen["before_send"] is scrub_event
