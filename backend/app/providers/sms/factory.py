"""Choose the SMS provider for a sender. Simulation unless the platform is explicitly live."""
from app.core.config import settings
from app.providers.sms.base import SmsProvider
from app.providers.sms.simulation import SimulationSmsProvider


def live_credentials_missing(provider: str) -> str | None:
    """Return a message when live sending through `provider` cannot work, else None."""
    if provider == "twilio" and not (settings.TWILIO_ACCOUNT_SID and settings.TWILIO_AUTH_TOKEN):
        return "Twilio credentials are not configured on the platform"
    if provider == "msg91" and not settings.MSG91_AUTH_KEY:
        return "MSG91 auth key is not configured on the platform"
    if provider not in ("twilio", "msg91"):
        return "Choose MSG91 (India) or Twilio (US) as the sender's provider"
    return None


def provider_for(sender_provider: str | None) -> tuple[SmsProvider, str]:
    # Simulation mode is a global safety switch: no message reaches a carrier.
    if settings.COMMUNICATION_MODE != "live" or not sender_provider or sender_provider == "simulation":
        return SimulationSmsProvider(), "simulation"
    if live_credentials_missing(sender_provider):
        return SimulationSmsProvider(), "simulation"
    if sender_provider == "twilio":
        from app.providers.sms.twilio import TwilioSmsProvider

        return TwilioSmsProvider(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN), "twilio"
    from app.providers.sms.msg91 import Msg91SmsProvider

    return Msg91SmsProvider(settings.MSG91_AUTH_KEY), "msg91"
