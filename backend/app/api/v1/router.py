from fastapi import APIRouter

from app.api.v1 import (
    admin,
    analytics,
    applications,
    audience,
    auth,
    automation,
    billing,
    chat,
    crm,
    email,
    forms,
    health,
    invitations,
    notifications,
    organizations,
    public_chat,
    public_email,
    public_forms,
    public_sms,
    public_voice,
    sms,
    users,
    voice,
)
from app.core.config import settings

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(organizations.router)
api_router.include_router(invitations.router)
api_router.include_router(applications.router)
api_router.include_router(audience.router)
api_router.include_router(crm.router)
api_router.include_router(forms.router)
api_router.include_router(public_forms.router)
api_router.include_router(notifications.router)
api_router.include_router(email.router)
api_router.include_router(public_email.router)
api_router.include_router(sms.router)
api_router.include_router(public_sms.router)
api_router.include_router(voice.router)
api_router.include_router(automation.router)
api_router.include_router(billing.router)
api_router.include_router(analytics.router)
api_router.include_router(admin.router)
api_router.include_router(admin.public)
api_router.include_router(public_voice.router)
api_router.include_router(chat.router)
api_router.include_router(public_chat.router)

if settings.dev_mailbox_active:
    from app.api.v1 import dev

    api_router.include_router(dev.router)
