"""Two-factor authentication: TOTP (RFC 6238), setup, login challenge, lockout, recovery codes, disable,
organization enforcement and interaction with password reset and multi-tab refresh."""
import time

from sqlalchemy import select, update

from app.core import totp
from app.core.database import SessionLocal
from app.models import AuditLog, User
from tests.conftest import PASSWORD, Api, invite_and_join, make_pro, token_from_last_email

RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # base32 of "12345678901234567890"


def code_for(secret: str, user_email: str) -> str:
    """A valid code that is not a replay: forget the last accepted step first (tests run within one 30s step)."""
    with SessionLocal() as db:
        db.execute(update(User).where(User.email == user_email).values(mfa_last_step=None))
        db.commit()
    return totp.code_at(secret)


def enable_mfa(api: Api) -> tuple[str, list[str]]:
    setup = api.post("/users/me/mfa/setup")
    assert setup.status_code == 200, setup.text
    secret = setup.json()["secret"]
    r = api.post("/users/me/mfa/enable", json={"code": totp.code_at(secret)})
    assert r.status_code == 200, r.text
    return secret, r.json()["recovery_codes"]


def actions(email: str) -> list[str]:
    with SessionLocal() as db:
        uid = db.scalar(select(User.id).where(User.email == email))
        return list(db.scalars(select(AuditLog.action).where(AuditLog.actor_user_id == uid)
                               .order_by(AuditLog.created_at)))


def start_login(email: str) -> tuple[Api, str]:
    a = Api()
    r = a.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mfa_required"] is True and body["code"] == "MFA_REQUIRED" and "access_token" not in body
    assert not r.headers.get("set-cookie")  # no session (refresh cookie) before the second factor
    return a, body["mfa_token"]


# ---------------------------------------------------------------- RFC 6238 implementation

def test_totp_matches_rfc6238_vectors():
    key = b"12345678901234567890"
    for at, expected in ((59, "94287082"), (1111111109, "07081804"), (1111111111, "14050471"),
                         (1234567890, "89005924"), (2000000000, "69279037")):
        assert totp.hotp(key, int(at // 30), digits=8) == expected
        assert totp.code_at(RFC_SECRET, at) == expected[-6:]
    assert totp.verify(RFC_SECRET, "287082", at=59) == 1
    assert totp.verify(RFC_SECRET, "287082", at=59 + 30) == 1  # one step of clock drift is tolerated
    assert totp.verify(RFC_SECRET, "287082", at=59 + 90) is None
    assert totp.verify(RFC_SECRET, "287082", at=59, last_step=1) is None  # replay refused
    assert totp.verify(RFC_SECRET, "28708", at=59) is None and totp.verify(RFC_SECRET, "abcdef", at=59) is None
    uri = totp.provisioning_uri(RFC_SECRET, "a@b.com", "Signalcraft")
    assert uri.startswith("otpauth://totp/Signalcraft:a@b.com?") and f"secret={RFC_SECRET}" in uri
    assert len(totp.new_secret()) == 32


# ---------------------------------------------------------------- setup / enable

def test_setup_shows_qr_and_enable_needs_a_valid_code():
    a = Api().register("mfa1@example.com")
    assert a.get("/users/me/mfa").json()["enabled"] is False
    setup = a.post("/users/me/mfa/setup").json()
    assert setup["qr_data_uri"].startswith("data:image/svg+xml") and setup["otpauth_uri"].startswith("otpauth://")
    with SessionLocal() as db:  # the secret is encrypted at rest
        u = db.scalar(select(User).where(User.email == "mfa1@example.com"))
        assert u.mfa_pending_secret and setup["secret"] not in u.mfa_pending_secret and u.mfa_secret is None
    bad = a.post("/users/me/mfa/enable", json={"code": "000000" if totp.code_at(setup["secret"]) != "000000"
                                                 else "111111"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_MFA_CODE"
    r = a.post("/users/me/mfa/enable", json={"code": totp.code_at(setup["secret"])})
    assert r.status_code == 200
    codes = r.json()["recovery_codes"]
    assert len(codes) == 10 and len(set(codes)) == 10 and all(len(c) == 11 and c[5] == "-" for c in codes)
    st = a.get("/users/me/mfa").json()
    assert st["enabled"] is True and st["recovery_codes_remaining"] == 10
    assert a.get("/users/me").json()["mfa_enabled"] is True
    # Setting up again is refused while it's on; the current session survived enabling.
    assert a.post("/users/me/mfa/setup").json()["error"]["code"] == "MFA_ALREADY_ENABLED"
    assert {"user.mfa_setup_started", "user.mfa_setup_failed", "user.mfa_enabled"} <= set(actions("mfa1@example.com"))


def test_enabling_signs_out_other_sessions():
    a = Api().register("mfa2@example.com")
    other = Api().login("mfa2@example.com")
    enable_mfa(a)
    assert other.get("/users/me").status_code == 401
    assert a.get("/users/me").status_code == 200


# ---------------------------------------------------------------- login challenge

def test_login_requires_second_step_and_wrong_code_is_refused():
    a = Api().register("mfa3@example.com")
    secret, _ = enable_mfa(a)
    b, token = start_login("mfa3@example.com")
    wrong = b.post("/auth/login/mfa", json={"mfa_token": token, "code": "123456" if totp.code_at(secret) != "123456"
                                            else "654321"})
    assert wrong.status_code == 401 and wrong.json()["error"]["code"] == "INVALID_MFA_CODE"
    ok = b.post("/auth/login/mfa", json={"mfa_token": token, "code": code_for(secret, "mfa3@example.com")})
    assert ok.status_code == 200, ok.text
    b.token = ok.json()["access_token"]
    assert ok.json()["user"]["mfa_enabled"] is True
    assert b.get("/users/me").status_code == 200
    assert b.post("/auth/refresh").status_code == 200  # the refresh cookie was set by the second step
    log = actions("mfa3@example.com")
    assert {"user.mfa_challenge_issued", "user.mfa_failed", "user.mfa_verified", "user.login"} <= set(log)


def test_same_code_cannot_be_used_twice():
    a = Api().register("mfa4@example.com")
    secret, _ = enable_mfa(a)
    code = code_for(secret, "mfa4@example.com")
    b, token = start_login("mfa4@example.com")
    assert b.post("/auth/login/mfa", json={"mfa_token": token, "code": code}).status_code == 200
    c, token2 = start_login("mfa4@example.com")
    r = c.post("/auth/login/mfa", json={"mfa_token": token2, "code": code})
    assert r.status_code == 401 and r.json()["error"]["code"] == "INVALID_MFA_CODE"


def test_tampered_or_foreign_challenge_token_is_refused():
    a = Api().register("mfa5@example.com")
    secret, _ = enable_mfa(a)
    b, token = start_login("mfa5@example.com")
    code = code_for(secret, "mfa5@example.com")
    r = b.post("/auth/login/mfa", json={"mfa_token": token[:-3] + "abc", "code": code})
    assert r.status_code == 401 and r.json()["error"]["code"] == "MFA_CHALLENGE_EXPIRED"
    # An access token is not a challenge token.
    r = b.post("/auth/login/mfa", json={"mfa_token": a.token, "code": code})
    assert r.json()["error"]["code"] == "MFA_CHALLENGE_EXPIRED"


def test_lockout_after_repeated_failures():
    a = Api().register("mfa6@example.com")
    secret, _ = enable_mfa(a)
    b, token = start_login("mfa6@example.com")
    good = code_for(secret, "mfa6@example.com")
    bad = "000000" if good != "000000" else "111111"
    for _ in range(5):
        assert b.post("/auth/login/mfa", json={"mfa_token": token, "code": bad}).status_code == 401
    r = b.post("/auth/login/mfa", json={"mfa_token": token, "code": good})
    assert r.status_code == 429 and r.json()["error"]["code"] == "MFA_LOCKED"
    assert "user.mfa_locked" in actions("mfa6@example.com")
    # After the lock expires the right code works again.
    with SessionLocal() as db:
        db.execute(update(User).where(User.email == "mfa6@example.com").values(mfa_locked_until=None))
        db.commit()
    assert b.post("/auth/login/mfa", json={"mfa_token": token, "code": good}).status_code == 200


def test_recovery_code_works_once_and_regeneration_replaces_them():
    a = Api().register("mfa7@example.com")
    _, codes = enable_mfa(a)
    b, token = start_login("mfa7@example.com")
    r = b.post("/auth/login/mfa", json={"mfa_token": token, "code": codes[0].upper().replace("-", " ")})
    assert r.status_code == 200, r.text  # case and separators don't matter
    c, token2 = start_login("mfa7@example.com")
    again = c.post("/auth/login/mfa", json={"mfa_token": token2, "code": codes[0]})
    assert again.status_code == 401
    assert a.get("/users/me/mfa").json()["recovery_codes_remaining"] == 9
    assert "user.mfa_recovery_code_used" in actions("mfa7@example.com")
    assert a.post("/users/me/mfa/recovery-codes", json={"password": "wrong-password1"}).status_code == 400
    new = a.post("/users/me/mfa/recovery-codes", json={"password": PASSWORD})
    assert new.status_code == 200
    new_codes = new.json()["recovery_codes"]
    assert c.post("/auth/login/mfa", json={"mfa_token": token2, "code": codes[1]}).status_code == 401
    assert c.post("/auth/login/mfa", json={"mfa_token": token2, "code": new_codes[0]}).status_code == 200


def test_disable_requires_password_and_code():
    a = Api().register("mfa8@example.com")
    secret, _ = enable_mfa(a)
    r = a.post("/users/me/mfa/disable", json={"password": "wrong-password1", "code": totp.code_at(secret)})
    assert r.status_code == 400 and r.json()["error"]["code"] == "INVALID_PASSWORD"
    r = a.post("/users/me/mfa/disable", json={"password": PASSWORD, "code": "999999"
                                              if totp.code_at(secret) != "999999" else "888888"})
    assert r.status_code == 401
    r = a.post("/users/me/mfa/disable", json={"password": PASSWORD, "code": code_for(secret, "mfa8@example.com")})
    assert r.status_code == 200
    assert a.get("/users/me/mfa").json()["enabled"] is False
    Api().login("mfa8@example.com")  # back to a single step
    assert "user.mfa_disabled" in actions("mfa8@example.com")


# ---------------------------------------------------------------- password reset and refresh

def test_password_reset_does_not_bypass_mfa():
    a = Api().register("mfa9@example.com")
    secret, _ = enable_mfa(a)
    _, old_token = start_login("mfa9@example.com")
    Api().post("/auth/forgot-password", json={"email": "mfa9@example.com"})
    token = token_from_last_email("mfa9@example.com", "/reset-password")
    new_pw = "BrandNewPass99"
    assert Api().post("/auth/reset-password", json={"token": token, "new_password": new_pw}).status_code == 200
    r = Api().post("/auth/login", json={"email": "mfa9@example.com", "password": new_pw})
    assert r.json()["mfa_required"] is True
    # A challenge issued before the reset no longer works.
    r = Api().post("/auth/login/mfa", json={"mfa_token": old_token, "code": code_for(secret, "mfa9@example.com")})
    assert r.json()["error"]["code"] == "MFA_CHALLENGE_EXPIRED"


def test_two_tab_refresh_still_works_after_mfa_login():
    a = Api().register("mfa10@example.com")
    secret, _ = enable_mfa(a)
    b, token = start_login("mfa10@example.com")
    b.token = b.post("/auth/login/mfa", json={"mfa_token": token,
                                              "code": code_for(secret, "mfa10@example.com")}).json()["access_token"]
    tab_b = b.token
    b.token = b.post("/auth/refresh").json()["access_token"]  # tab A rotates the shared cookie
    b.token = tab_b
    assert b.get("/users/me").json()["error"]["code"] == "TOKEN_EXPIRED"
    r = b.post("/auth/refresh")  # no second factor needed to refresh an existing session
    assert r.status_code == 200
    b.token = r.json()["access_token"]
    assert b.get("/users/me").status_code == 200


# ---------------------------------------------------------------- organization enforcement

def test_org_requirement_gates_admin_actions_until_setup(owner):
    org_id = owner.org["id"]
    make_pro(org_id)  # room for more than Starter's three members
    r = owner.patch(f"/organizations/{org_id}", json={"require_mfa_admins": True})
    assert r.status_code == 422 and r.json()["error"]["code"] == "MFA_REQUIRED_FOR_SELF"
    enable_mfa(owner)
    admin = invite_and_join(owner, "admin@example.com", "admin")
    member = invite_and_join(owner, "cm@example.com", "campaign_manager", [owner.app["id"]])
    r = owner.patch(f"/organizations/{org_id}", json={"require_mfa_admins": True})
    assert r.status_code == 200 and r.json()["require_mfa_admins"] is True
    assert "organization.mfa_requirement_changed" in actions("owner@example.com")

    me = admin.get("/users/me").json()
    assert me["mfa_setup_required"] is True
    org = admin.get(f"/organizations/{org_id}").json()
    assert org["mfa_setup_required"] is True and "members.invite" not in org["permissions"]
    r = admin.post(f"/organizations/{org_id}/invitations", json={"email": "x@example.com", "role": "viewer",
                                                                  "application_ids": [owner.app["id"]]})
    assert r.status_code == 403 and r.json()["error"]["code"] == "MFA_SETUP_REQUIRED"
    # Day-to-day work still works, and other roles are unaffected.
    assert admin.get(f"/apps/{owner.app['id']}/contacts").status_code == 200
    assert member.get("/users/me").json()["mfa_setup_required"] is False

    enable_mfa(admin)
    assert admin.get("/users/me").json()["mfa_setup_required"] is False
    r = admin.post(f"/organizations/{org_id}/invitations", json={"email": "x@example.com", "role": "viewer",
                                                                  "application_ids": [owner.app["id"]]})
    assert r.status_code == 201, r.text
    # While the requirement is on, owners/admins can't switch 2FA off.
    secret = None
    with SessionLocal() as db:
        from app.core.crypto import decrypt_str

        secret = decrypt_str(db.scalar(select(User.mfa_secret).where(User.email == "admin@example.com")))
    r = admin.post("/users/me/mfa/disable", json={"password": PASSWORD, "code": code_for(secret, "admin@example.com")})
    assert r.status_code == 403 and r.json()["error"]["code"] == "MFA_REQUIRED_BY_ORGANIZATION"


def test_platform_admin_is_encouraged():
    a = Api().register("staff@example.com")
    with SessionLocal() as db:
        db.execute(update(User).where(User.email == "staff@example.com")
                   .values(is_platform_admin=True, platform_role="super_admin"))
        db.commit()
    assert a.get("/users/me").json()["mfa_recommended"] is True
    enable_mfa(a)
    assert a.get("/users/me").json()["mfa_recommended"] is False


def test_challenge_expires():
    a = Api().register("mfa11@example.com")
    secret, _ = enable_mfa(a)
    import jwt

    from app.core.config import settings
    payload = jwt.decode(start_login("mfa11@example.com")[1], settings.SECRET_KEY,
                         algorithms=[settings.JWT_ALGORITHM])
    payload["exp"] = int(time.time()) - 5
    expired = jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    r = Api().post("/auth/login/mfa", json={"mfa_token": expired, "code": code_for(secret, "mfa11@example.com")})
    assert r.status_code == 401 and r.json()["error"]["code"] == "MFA_CHALLENGE_EXPIRED"
