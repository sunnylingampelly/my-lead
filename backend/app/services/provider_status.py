"""Which delivery providers the platform can actually use, without revealing any secret.

Applications pick a provider per channel, but anything not configured on the platform (or any
provider at all while COMMUNICATION_MODE is not "live") silently falls back to simulation. The
settings UI uses this to disable options that cannot work and to say when nothing is really sent."""
from app.core.config import settings
from app.core.permissions import Perm
from app.services.tenancy import AppContext


def _has(*vals) -> bool:
    return all(bool(v) for v in vals)


def status(ctx: AppContext) -> dict:
    ctx.require(Perm.SETTINGS_READ)
    s = settings
    aws = _has(s.AWS_ACCESS_KEY_ID, s.AWS_SECRET_ACCESS_KEY)
    live = s.COMMUNICATION_MODE == "live"
    return {
        "communication_mode": s.COMMUNICATION_MODE,
        "simulation": not live,
        "providers": {
            "email": {"simulation": True, "ses": aws, "brevo": _has(s.BREVO_API_KEY)},
            "sms": {"simulation": True, "sns": aws and bool(s.AWS_REGION)},
            "voice": {"simulation": True,
                      "telnyx": _has(s.TELNYX_API_KEY, s.TELNYX_ACCOUNT_SID, s.TELNYX_TEXML_APP_ID),
                      "exotel": _has(s.EXOTEL_SID, s.EXOTEL_API_KEY, s.EXOTEL_API_TOKEN, s.EXOTEL_APP_ID),
                      "twilio": _has(s.TWILIO_ACCOUNT_SID, s.TWILIO_AUTH_TOKEN)},
        },
    }
