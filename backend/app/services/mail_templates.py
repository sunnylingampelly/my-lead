"""Templates for platform (system) emails. All interpolated values are HTML-escaped."""
from dataclasses import dataclass
from html import escape

from app.core.config import settings


@dataclass(frozen=True)
class RenderedEmail:
    subject: str
    html: str
    text: str


def _layout(title: str, body_html: str, cta_label: str, cta_url: str, footer: str) -> str:
    return f"""<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#f4f5f7;font-family:Inter,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;border:1px solid #e5e7eb">
<tr><td style="padding:32px 36px">
<div style="font-weight:700;font-size:18px;margin-bottom:24px">{escape(settings.APP_NAME)}</div>
<h1 style="font-size:20px;margin:0 0 12px">{escape(title)}</h1>
{body_html}
<p style="margin:28px 0"><a href="{escape(cta_url, quote=True)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">{escape(cta_label)}</a></p>
<p style="font-size:12px;color:#64748b;word-break:break-all">If the button does not work, open this link: {escape(cta_url)}</p>
<p style="font-size:12px;color:#64748b;margin-top:24px">{escape(footer)}</p>
</td></tr></table></td></tr></table></body></html>"""


def verification_email(full_name: str, url: str) -> RenderedEmail:
    hours = settings.EMAIL_VERIFICATION_TTL_HOURS
    return RenderedEmail(
        subject=f"Verify your email for {settings.APP_NAME}",
        html=_layout(
            "Confirm your email address",
            f"<p>Hi {escape(full_name)}, please confirm your email address to finish setting up your account.</p>",
            "Verify email",
            url,
            f"This link expires in {hours} hours. If you did not create an account you can ignore this email.",
        ),
        text=f"Hi {full_name},\n\nConfirm your email address: {url}\n\nThis link expires in {hours} hours.",
    )


def password_reset_email(full_name: str, url: str) -> RenderedEmail:
    mins = settings.PASSWORD_RESET_TTL_MINUTES
    return RenderedEmail(
        subject=f"Reset your {settings.APP_NAME} password",
        html=_layout(
            "Reset your password",
            f"<p>Hi {escape(full_name)}, we received a request to reset your password.</p>",
            "Choose a new password",
            url,
            f"This link expires in {mins} minutes. If you did not request a reset, no action is needed.",
        ),
        text=f"Hi {full_name},\n\nReset your password: {url}\n\nThis link expires in {mins} minutes.",
    )


def invitation_email(org_name: str, inviter_name: str, role_label: str, url: str) -> RenderedEmail:
    return RenderedEmail(
        subject=f"{inviter_name} invited you to {org_name} on {settings.APP_NAME}",
        html=_layout(
            f"Join {org_name}",
            f"<p>{escape(inviter_name)} invited you to join <strong>{escape(org_name)}</strong> "
            f"as <strong>{escape(role_label)}</strong>.</p>",
            "Accept invitation",
            url,
            f"This invitation expires in {settings.INVITATION_TTL_DAYS} days.",
        ),
        text=f"{inviter_name} invited you to join {org_name} as {role_label}.\n\nAccept: {url}",
    )
