"""Consent and suppression rules shared by the contact form, the API and imports.

Principles:
* Consent is never assumed. Every channel starts as not consented.
* An unsubscribe is never reversed by an import. Only an explicit, evidenced re-opt-in can.
* Marketing SMS and calls to jurisdictions that require written consent (the US under TCPA)
  must carry a description of the evidence.
* Suppression is keyed by a hash of the identifier, so it outlives contact deletion.
"""
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.errors import ValidationFailed
from app.models import ConsentRecord, Contact, ContactActivity, SuppressionEntry
from app.services.regions import profile_for, requires_written_consent
from app.services.tenancy import AppContext
from app.utils.contact_normalize import identifier_hash, mask_email, mask_phone
from app.utils.time import utcnow

CHANNELS = ("email", "sms", "voice")
CHANNEL_LABEL = {"email": "Email", "sms": "SMS", "voice": "Voice"}


def jurisdiction(contact: Contact, channel: str) -> str | None:
    if channel in ("sms", "voice"):
        return contact.phone_country or contact.country
    return contact.country or contact.phone_country


def record_activity(db: Session, ctx: AppContext, contact_id: str, type_: str, description: str,
                    meta: dict | None = None, actor_id: str | None = None) -> None:
    db.add(ContactActivity(organization_id=ctx.organization_id, application_id=ctx.application_id,
                           contact_id=contact_id, type=type_, description=description[:255], meta=meta or {},
                           actor_user_id=actor_id))


def _identifier(contact: Contact, channel: str) -> tuple[str | None, str | None]:
    if channel == "email":
        return (contact.email_hash, mask_email(contact.email)) if contact.email else (None, None)
    return (contact.phone_hash, mask_phone(contact.phone)) if contact.phone else (None, None)


def suppress(db: Session, ctx: AppContext, channel: str, value_hash: str, masked: str, reason: str,
             source: str | None, note: str | None = None, actor_id: str | None = None) -> bool:
    db.flush()  # make entries added earlier in this transaction visible to the check below
    exists = db.scalar(select(SuppressionEntry.id).where(
        SuppressionEntry.application_id == ctx.application_id, SuppressionEntry.channel == channel,
        SuppressionEntry.value_hash == value_hash))
    if exists:
        return False
    db.add(SuppressionEntry(organization_id=ctx.organization_id, application_id=ctx.application_id, channel=channel,
                            value_hash=value_hash, value_masked=masked, reason=reason, source=source, note=note,
                            created_by_id=actor_id))
    return True


def grant(db: Session, ctx: AppContext, contact: Contact, channel: str, *, method: str, source: str | None,
          evidence: str | None, consent_reference: str | None = None, actor_id: str | None = None,
          ip: str | None = None, import_id: str | None = None) -> bool:
    """Grant consent. Returns False when it must be refused silently (an import must not
    re-subscribe someone who unsubscribed). Raises for missing required evidence."""
    unsub_attr = f"{channel}_unsubscribed_at"
    if channel == "email" and not contact.email or channel != "email" and not contact.phone:
        return False
    h, _ = _identifier(contact, channel)
    if method == "import":
        # Imports never override an unsubscribe, including one recorded before the contact was deleted.
        if getattr(contact, unsub_attr) is not None or _unsubscribe_suppressed(db, ctx, channel, h):
            return False
    jur = jurisdiction(contact, channel)
    if not (source or "").strip():
        raise ValidationFailed("Describe where this consent was collected", code="CONSENT_SOURCE_REQUIRED")
    if requires_written_consent(channel, jur) and not (evidence or "").strip():
        raise ValidationFailed(
            f"{profile_for(jur).name} numbers need documented written consent for marketing "
            f"{CHANNEL_LABEL[channel]}. Describe the evidence (for example a signed web form and its date).",
            code="WRITTEN_CONSENT_REQUIRED",
        )
    already = getattr(contact, f"{channel}_consent") and getattr(contact, unsub_attr) is None
    if already and not _unsubscribe_suppressed(db, ctx, channel, h):
        return True  # already consented; nothing to record
    setattr(contact, f"{channel}_consent", True)
    # An explicit, recorded re-opt-in lifts an earlier unsubscribe (never bounces or complaints).
    if getattr(contact, unsub_attr) is not None:
        setattr(contact, unsub_attr, None)
        if contact.status == "unsubscribed" and not all_unsubscribed(contact):
            contact.status = "active"
    if h:
        db.execute(delete(SuppressionEntry).where(
            SuppressionEntry.application_id == ctx.application_id, SuppressionEntry.channel == channel,
            SuppressionEntry.value_hash == h, SuppressionEntry.reason == "unsubscribed"))
    db.add(ConsentRecord(organization_id=ctx.organization_id, application_id=ctx.application_id,
                         contact_id=contact.id, channel=channel, status="granted", method=method,
                         source=(source or "").strip()[:255] or None, evidence=(evidence or "").strip() or None,
                         consent_reference=consent_reference, jurisdiction=jur, ip_address=ip,
                         recorded_by_id=actor_id, import_id=import_id))
    record_activity(db, ctx, contact.id, "consent_granted", f"{CHANNEL_LABEL[channel]} consent granted",
                    {"channel": channel, "method": method}, actor_id)
    return True


def revoke(db: Session, ctx: AppContext, contact: Contact, channel: str, *, method: str, source: str | None,
           actor_id: str | None = None, ip: str | None = None) -> None:
    """Withdraw consent (unsubscribe). Always honoured and always suppresses the identifier."""
    setattr(contact, f"{channel}_consent", False)
    if getattr(contact, f"{channel}_unsubscribed_at") is None:
        setattr(contact, f"{channel}_unsubscribed_at", utcnow())
    h, masked = _identifier(contact, channel)
    if h:
        suppress(db, ctx, channel, h, masked, "unsubscribed", source or method, actor_id=actor_id)
    if all_unsubscribed(contact):
        contact.status = "unsubscribed"
    db.add(ConsentRecord(organization_id=ctx.organization_id, application_id=ctx.application_id,
                         contact_id=contact.id, channel=channel, status="revoked", method=method,
                         source=(source or "").strip()[:255] or None, jurisdiction=jurisdiction(contact, channel),
                         ip_address=ip, recorded_by_id=actor_id))
    record_activity(db, ctx, contact.id, "consent_revoked", f"Unsubscribed from {CHANNEL_LABEL[channel]}",
                    {"channel": channel, "method": method}, actor_id)


def _unsubscribe_suppressed(db: Session, ctx: AppContext, channel: str, value_hash: str | None) -> bool:
    if not value_hash:
        return False
    return db.scalar(select(SuppressionEntry.id).where(
        SuppressionEntry.application_id == ctx.application_id, SuppressionEntry.channel == channel,
        SuppressionEntry.value_hash == value_hash, SuppressionEntry.reason == "unsubscribed")) is not None


def all_unsubscribed(contact: Contact) -> bool:
    present = [c for c in CHANNELS if (contact.email if c == "email" else contact.phone)]
    return bool(present) and all(getattr(contact, f"{c}_unsubscribed_at") is not None for c in present)


def suppressed_channels(db: Session, ctx: AppContext, contact: Contact) -> dict[str, str]:
    """channel -> reason for every suppression matching this contact."""
    hashes = [h for h in (contact.email_hash, contact.phone_hash) if h]
    if not hashes:
        return {}
    out = {}
    for e in db.scalars(select(SuppressionEntry).where(SuppressionEntry.application_id == ctx.application_id,
                                                       SuppressionEntry.value_hash.in_(hashes))):
        if (e.channel == "email" and e.value_hash == contact.email_hash) or \
                (e.channel != "email" and e.value_hash == contact.phone_hash):
            out[e.channel] = e.reason
    return out


def eligibility(db: Session, ctx: AppContext, contact: Contact) -> dict[str, dict]:
    """Human-readable reachability per channel, mirroring query.eligibility_condition."""
    supp = suppressed_channels(db, ctx, contact)
    out = {}
    for ch in CHANNELS:
        reasons = []
        if ch == "email" and not contact.email:
            reasons.append("No email address")
        if ch != "email" and not contact.phone:
            reasons.append("No phone number")
        if ch == "sms" and contact.phone_type == "landline":
            reasons.append("Landline numbers cannot receive SMS")
        if getattr(contact, f"{ch}_unsubscribed_at"):
            reasons.append("Unsubscribed")
        elif not getattr(contact, f"{ch}_consent"):
            reasons.append("No marketing consent")
        if ch in supp:
            if supp[ch] != "unsubscribed":
                reasons.append(f"Suppressed ({supp[ch]})")
            elif not getattr(contact, f"{ch}_unsubscribed_at"):
                reasons.append("Previously unsubscribed")
        if contact.status == "blocked" or (ch == "email" and contact.status == "bounced"):
            reasons.append(f"Contact is {contact.status}")
        out[ch] = {"eligible": not reasons, "reasons": reasons}
    return out


def hash_for(contact_email: str | None, contact_phone: str | None) -> tuple[str | None, str | None]:
    return (identifier_hash(contact_email) if contact_email else None,
            identifier_hash(contact_phone) if contact_phone else None)
