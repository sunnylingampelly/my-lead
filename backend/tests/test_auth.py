from app.core.rate_limit import reset_rate_limits
from tests.conftest import PASSWORD, Api, mailbox, token_from_last_email


def test_register_sends_verification_and_verifies():
    a = Api()
    r = a.post("/auth/register", json={"email": "New@Example.com", "password": PASSWORD, "full_name": " Nia "})
    assert r.status_code == 201
    body = r.json()
    assert body["user"]["email"] == "new@example.com"
    assert body["user"]["full_name"] == "Nia"
    assert body["user"]["email_verified"] is False
    assert "password_hash" not in body["user"]
    a.token = body["access_token"]
    # Refresh token is only in an httpOnly cookie, never in the body.
    assert "refresh_token" not in body
    assert "sc_refresh" in r.headers["set-cookie"] and "HttpOnly" in r.headers["set-cookie"]

    token = token_from_last_email("new@example.com", "/verify-email")
    v = a.post("/auth/verify-email", json={"token": token})
    assert v.status_code == 200 and v.json()["email_verified"] is True
    # Single use.
    again = a.post("/auth/verify-email", json={"token": token})
    assert again.status_code == 422 and again.json()["error"]["code"] == "INVALID_TOKEN"


def test_resend_verification_invalidates_previous_link():
    a = Api().register("r@example.com", verify=False)
    first = token_from_last_email("r@example.com", "/verify-email")
    assert a.post("/auth/resend-verification").status_code == 200
    second = token_from_last_email("r@example.com", "/verify-email")
    assert first != second
    assert a.post("/auth/verify-email", json={"token": first}).status_code == 422
    assert a.post("/auth/verify-email", json={"token": second}).status_code == 200


def test_duplicate_email_and_weak_password_rejected():
    Api().register("dup@example.com")
    r = Api().post("/auth/register", json={"email": "DUP@example.com", "password": PASSWORD, "full_name": "X"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "EMAIL_TAKEN"
    weak = Api().post("/auth/register", json={"email": "w@example.com", "password": "short", "full_name": "X"})
    assert weak.status_code == 422 and weak.json()["error"]["code"] == "VALIDATION_ERROR"


def test_login_success_and_failures_share_message():
    Api().register("login@example.com")
    a = Api().login("login@example.com")
    assert a.get("/users/me").json()["email"] == "login@example.com"
    bad_pw = Api().post("/auth/login", json={"email": "login@example.com", "password": "WrongPass123"})
    no_user = Api().post("/auth/login", json={"email": "nobody@example.com", "password": "WrongPass123"})
    assert bad_pw.status_code == no_user.status_code == 401
    assert bad_pw.json()["error"]["message"] == no_user.json()["error"]["message"]


def test_protected_endpoints_require_valid_token():
    a = Api()
    assert a.get("/users/me").status_code == 401
    a.token = "not-a-jwt"
    assert a.get("/users/me").json()["error"]["code"] == "INVALID_TOKEN"


def test_refresh_rotates_and_detects_reuse():
    a = Api().register("rot@example.com")
    old_cookie = a.client.cookies.get("sc_refresh")
    r = a.post("/auth/refresh")
    assert r.status_code == 200
    new_cookie = a.client.cookies.get("sc_refresh")
    assert new_cookie and new_cookie != old_cookie
    a.token = r.json()["access_token"]
    assert a.get("/users/me").status_code == 200

    # An attacker replays the old (rotated) token: the whole session family is revoked.
    attacker = Api()
    attacker.client.cookies.set("sc_refresh", old_cookie, path="/api/v1/auth")
    assert attacker.post("/auth/refresh").status_code == 401
    assert a.get("/users/me").json()["error"]["code"] == "SESSION_REVOKED"
    assert a.post("/auth/refresh").status_code == 401


def test_rotation_by_another_tab_asks_to_refresh_not_sign_out():
    """Two tabs share the refresh cookie. When one rotates it, the other tab's access token reports
    TOKEN_EXPIRED (the client refreshes with the shared cookie) instead of SESSION_REVOKED (sign-out)."""
    a = Api().register("tabs@example.com")
    tab_b_token = a.token
    a.token = a.post("/auth/refresh").json()["access_token"]  # tab A rotates the shared cookie
    tab_a_token = a.token
    a.token = tab_b_token
    assert a.get("/users/me").json()["error"]["code"] == "TOKEN_EXPIRED"
    r = a.post("/auth/refresh")  # tab B refreshes with the shared, current cookie
    assert r.status_code == 200
    a.token = r.json()["access_token"]
    assert a.get("/users/me").status_code == 200
    # After logout, an older rotated token still can't get back in: the refresh it triggers fails.
    assert a.post("/auth/logout").status_code == 200
    a.token = tab_a_token
    assert a.get("/users/me").status_code == 401
    assert a.post("/auth/refresh").status_code == 401


def test_lost_refresh_response_is_forgiven_once_but_reuse_after_use_is_theft(monkeypatch):
    """A reload can abort a refresh after the server rotated the token: the browser still holds the old one.
    Within the grace window, while the successor was never used, the old token works once more. Once the
    successor has been used (or the window passed), presenting the old token is treated as theft."""
    from datetime import timedelta

    from sqlalchemy import select, update

    from app.core.database import SessionLocal
    from app.models import UserSession
    from app.utils.time import utcnow

    a = Api().register("lost@example.com")
    old = a.client.cookies.get("sc_refresh")
    assert a.post("/auth/refresh").status_code == 200  # rotated; pretend the browser never saw the reply
    lost = Api()
    lost.client.cookies.set("sc_refresh", old, path="/api/v1/auth")
    r = lost.post("/auth/refresh")
    assert r.status_code == 200, r.text  # forgiven: the successor was never used
    lost.token = r.json()["access_token"]
    assert lost.get("/users/me").status_code == 200
    # The undelivered successor (the cookie `a` received) is retired, so only one live token remains.
    assert a.post("/auth/refresh").status_code == 401

    # Now the old token again: its new successor has been used, so this is theft and the family is revoked.
    thief = Api()
    thief.client.cookies.set("sc_refresh", old, path="/api/v1/auth")
    assert thief.post("/auth/refresh").status_code == 401
    assert lost.get("/users/me").json()["error"]["code"] == "SESSION_REVOKED"

    # Outside the grace window an unused successor doesn't help either.
    b = Api().register("late@example.com")
    old_b = b.client.cookies.get("sc_refresh")
    assert b.post("/auth/refresh").status_code == 200
    with SessionLocal() as db:
        s = db.scalar(select(UserSession).where(UserSession.revoked_reason == "rotated",
                                                UserSession.user.has(email="late@example.com")))
        db.execute(update(UserSession).where(UserSession.id == s.id).values(revoked_at=utcnow() - timedelta(minutes=5)))
        db.commit()
    late = Api()
    late.client.cookies.set("sc_refresh", old_b, path="/api/v1/auth")
    assert late.post("/auth/refresh").status_code == 401


def test_logout_revokes_access_and_refresh():
    a = Api().register("out@example.com")
    assert a.post("/auth/logout").status_code == 200
    assert a.get("/users/me").status_code == 401
    assert a.post("/auth/refresh").status_code == 401


def test_password_reset_flow_revokes_sessions():
    a = Api().register("reset@example.com")
    r = Api().post("/auth/forgot-password", json={"email": "reset@example.com"})
    assert r.status_code == 202
    token = token_from_last_email("reset@example.com", "/reset-password")
    new_pw = "BrandNewPass99"
    done = Api().post("/auth/reset-password", json={"token": token, "new_password": new_pw})
    assert done.status_code == 200
    assert a.get("/users/me").status_code == 401  # old session revoked
    assert Api().post("/auth/login", json={"email": "reset@example.com", "password": PASSWORD}).status_code == 401
    Api().login("reset@example.com", new_pw)
    # Token cannot be reused.
    assert Api().post("/auth/reset-password", json={"token": token, "new_password": "Another123x"}).status_code == 422


def test_forgot_password_does_not_reveal_accounts():
    r = Api().post("/auth/forgot-password", json={"email": "ghost@example.com"})
    assert r.status_code == 202
    assert mailbox("ghost@example.com") == []


def test_change_password_keeps_current_session_only():
    a = Api().register("chg@example.com")
    other = Api().login("chg@example.com")
    wrong = a.post("/users/me/password", json={"current_password": "nope12345678", "new_password": "Changed12345"})
    assert wrong.status_code == 400
    ok = a.post("/users/me/password", json={"current_password": PASSWORD, "new_password": "Changed12345"})
    assert ok.status_code == 200
    assert a.get("/users/me").status_code == 200
    assert other.get("/users/me").status_code == 401


def test_sessions_list_and_revoke():
    a = Api().register("sess@example.com")
    b = Api().login("sess@example.com")
    sessions = a.get("/users/me/sessions").json()
    assert len(sessions) == 2 and sum(s["current"] for s in sessions) == 1
    other = next(s for s in sessions if not s["current"])
    assert a.delete(f"/users/me/sessions/{other['id']}").status_code == 204
    assert b.get("/users/me").status_code == 401


def test_profile_update_validates_timezone():
    a = Api().register("prof@example.com")
    assert a.patch("/users/me", json={"full_name": "Pat", "timezone": "Asia/Kolkata"}).json()["full_name"] == "Pat"
    assert a.patch("/users/me", json={"timezone": "Mars/Base"}).status_code == 422


def test_login_rate_limited(monkeypatch):
    from app.core import config

    monkeypatch.setattr(config.settings, "RATE_LIMIT_AUTH_PER_MINUTE", 3)
    reset_rate_limits()
    c = Api()
    codes = [c.post("/auth/login", json={"email": "x@example.com", "password": "whatever123"}).status_code
             for _ in range(5)]
    assert codes[:3] == [401, 401, 401]
    assert codes[3] == 429
