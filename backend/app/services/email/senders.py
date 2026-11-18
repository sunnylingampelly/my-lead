"""Sender identities. An address must prove it can receive mail before campaigns can use it."""
from urllib.parse import quote

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.permissions import Perm
from app.core.security import generate_token, hash_token
from app.models.email import EmailCampaign, EmailSender
from app.schemas.email import SenderCreate, SenderOut, SenderUpdate
from app.services import audit_service
from app.services.mail_templates import RenderedEmail, _layout
from app.services.notifications import enqueue_system_email
from app.services.tenancy import AppContext
from app.utils.time import utcnow

FREE_MAIL = {"gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "aol.com", "icloud.com",
             "rediffmail.com", "yahoo.co.in", "proton.me", "protonmail.com"}


def to_out(s: EmailSender) -> SenderOut:
    out = SenderOut.model_validate(s)
    out.domain = s.from_email.split("@", 1)[1]
    return out


def _get(db: Session, ctx: AppContext, sender_id: str) -> EmailSender:
    s = db.scalar(select(EmailSender).where(EmailSender.id == sender_id,
                                            EmailSender.application_id == ctx.application_id))
    if s is None:
        raise NotFound("Sender not found")
    return s


def list_senders(db: Session, ctx: AppContext) -> list[SenderOut]:
    ctx.require(Perm.CAMPAIGNS_READ)
    rows = db.scalars(select(EmailSender).where(EmailSender.application_id == ctx.application_id)
                      .order_by(EmailSender.is_default.desc(), EmailSender.created_at))
    return [to_out(s) for s in rows]


def _send_verification(db: Session, ctx: AppContext, s: EmailSender) -> None:
    token = generate_token()
    s.verification_token_hash = hash_token(token)
    s.verification_sent_at = utcnow()
    db.commit()
    url = f"{settings.FRONTEND_URL}/verify-sender?token={quote(token)}"
    email = RenderedEmail(
        subject=f"Confirm {s.from_email} as a sender for {ctx.application.name}",
        html=_layout("Confirm this sender address",
                     f"<p>{ctx.user.full_name} wants to send campaigns from <strong>{s.from_email}</strong> "
                     f"in {ctx.application.name}.</p>", "Confirm sender", url,
                     "If you did not expect this, ignore this email and the address will not be used."),
        text=f"Confirm {s.from_email} as a sender for {ctx.application.name}: {url}",
    )
    enqueue_system_email("sender_verification", s.from_email, s.from_name, email)


def create_sender(db: Session, ctx: AppContext, data: SenderCreate) -> SenderOut:
    ctx.require(Perm.SETTINGS_WRITE)
    if db.scalar(select(EmailSender.id).where(EmailSender.application_id == ctx.application_id,
                                              EmailSender.from_email == data.from_email)):
        raise Conflict("This sender already exists", code="DUPLICATE_SENDER")
    has_default = db.scalar(select(EmailSender.id).where(EmailSender.application_id == ctx.application_id,
                                                         EmailSender.is_default.is_(True)))
    s = EmailSender(organization_id=ctx.organization_id, application_id=ctx.application_id,
                    from_name=data.from_name.strip(), from_email=data.from_email, reply_to=data.reply_to,
                    is_default=not has_default, created_by_id=ctx.user.id)
    db.add(s)
    db.flush()
    audit_service.record(db, "email_sender.created", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="email_sender", target_id=s.id,
                         summary=s.from_email)
    _send_verification(db, ctx, s)
    return to_out(s)


def resend_verification(db: Session, ctx: AppContext, sender_id: str) -> SenderOut:
    ctx.require(Perm.SETTINGS_WRITE)
    s = _get(db, ctx, sender_id)
    if s.status == "verified":
        raise Conflict("This sender is already verified")
    _send_verification(db, ctx, s)
    return to_out(s)


def update_sender(db: Session, ctx: AppContext, sender_id: str, data: SenderUpdate) -> SenderOut:
    ctx.require(Perm.SETTINGS_WRITE)
    s = _get(db, ctx, sender_id)
    if data.from_name is not None:
        s.from_name = data.from_name.strip()
    if "reply_to" in data.model_fields_set:
        s.reply_to = data.reply_to
    if data.is_default:
        db.execute(update(EmailSender).where(EmailSender.application_id == ctx.application_id)
                   .values(is_default=False))
        s.is_default = True
    return to_out(s)


def delete_sender(db: Session, ctx: AppContext, sender_id: str) -> None:
    ctx.require(Perm.SETTINGS_WRITE)
    s = _get(db, ctx, sender_id)
    busy = db.scalar(select(EmailCampaign.id).where(EmailCampaign.sender_id == s.id,
                                                    EmailCampaign.status.in_(("scheduled", "queued", "sending",
                                                                              "paused"))))
    if busy:
        raise Conflict("This sender is used by a scheduled or active campaign", code="IN_USE")
    db.delete(s)
    audit_service.record(db, "email_sender.deleted", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="email_sender", target_id=sender_id,
                         summary=s.from_email)


def verify(db: Session, token: str) -> EmailSender:
    s = db.scalar(select(EmailSender).where(EmailSender.verification_token_hash == hash_token(token)))
    if s is None:
        raise ValidationFailed("This confirmation link is invalid or was replaced by a newer one",
                               code="INVALID_TOKEN")
    s.status = "verified"
    s.verified_at = utcnow()
    s.verification_token_hash = None
    return s


def deliverability_tips(from_email: str) -> list[str]:
    domain = from_email.split("@", 1)[1]
    tips = []
    if domain in FREE_MAIL:
        tips.append(f"{domain} addresses fail DMARC when sent through a third-party service and usually land in "
                    "spam. Use an address on your own domain.")
    return tips
