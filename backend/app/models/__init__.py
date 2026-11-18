"""Import every model so Alembic and metadata.create_all see them."""
from app.models.application import Application, ApplicationMember, ApplicationSettings
from app.models.audience import (
    ConsentRecord,
    Contact,
    ContactActivity,
    ContactAttributeDefinition,
    ContactList,
    ContactListMember,
    ContactTag,
    Import,
    ImportRow,
    Segment,
    SuppressionEntry,
    Tag,
)
from app.models.audit import AuditLog
from app.models.automation import Workflow, WorkflowRun, WorkflowStep
from app.models.base import Base
from app.models.billing import UsageSettlement, Wallet, WalletHold, WalletTransaction
from app.models.email import EmailCampaign, EmailEvent, EmailMessage, EmailSender, EmailTemplate, WebhookEvent
from app.models.notification import Notification
from app.models.organization import Invitation, Organization, OrganizationMember, Permission, Role, RolePermission
from app.models.payment import Payment
from app.models.sms import SmsCampaign, SmsDltConfiguration, SmsEvent, SmsInbound, SmsMessage, SmsSender, SmsTemplate
from app.models.support import SupportGrant
from app.models.user import EmailVerification, PasswordReset, User, UserSession
from app.models.voice import VoiceAudio, VoiceCall, VoiceCallerId, VoiceCampaign, VoiceEvent

__all__ = [
    "SupportGrant",
    "Payment",
    "UsageSettlement",
    "Wallet",
    "WalletHold",
    "WalletTransaction",
    "Workflow",
    "WorkflowRun",
    "WorkflowStep",
    "VoiceAudio",
    "VoiceCall",
    "VoiceCallerId",
    "VoiceCampaign",
    "VoiceEvent",
    "SmsCampaign",
    "SmsDltConfiguration",
    "SmsEvent",
    "SmsInbound",
    "SmsMessage",
    "SmsSender",
    "SmsTemplate",
    "EmailCampaign",
    "EmailEvent",
    "EmailMessage",
    "EmailSender",
    "EmailTemplate",
    "WebhookEvent",
    "Notification",
    "ConsentRecord",
    "Contact",
    "ContactActivity",
    "ContactAttributeDefinition",
    "ContactList",
    "ContactListMember",
    "ContactTag",
    "Import",
    "ImportRow",
    "Segment",
    "SuppressionEntry",
    "Tag",
    "Application",
    "ApplicationMember",
    "ApplicationSettings",
    "AuditLog",
    "Base",
    "EmailVerification",
    "Invitation",
    "Organization",
    "OrganizationMember",
    "PasswordReset",
    "Permission",
    "Role",
    "RolePermission",
    "User",
    "UserSession",
]
