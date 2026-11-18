"""Choose the voice provider for a caller ID. Simulation unless the platform is explicitly live."""
from app.core.config import settings
from app.providers.voice.base import VoiceProvider
from app.providers.voice.simulation import SimulationVoiceProvider


def live_credentials_missing(provider: str) -> str | None:
    if provider == "twilio" and not (settings.TWILIO_ACCOUNT_SID and settings.TWILIO_AUTH_TOKEN):
        return "Twilio credentials are not configured on the platform"
    if provider == "exotel" and not (settings.EXOTEL_SID and settings.EXOTEL_API_KEY and settings.EXOTEL_API_TOKEN
                                     and settings.EXOTEL_APP_ID):
        return "Exotel credentials or call flow are not configured on the platform"
    if provider == "telnyx" and not (settings.TELNYX_API_KEY and settings.TELNYX_ACCOUNT_SID
                                     and settings.TELNYX_TEXML_APP_ID):
        return "Telnyx API key, account id or TeXML application are not configured on the platform"
    if provider not in ("twilio", "exotel", "telnyx"):
        return "Choose Telnyx, Exotel or Twilio as the caller ID's provider"
    return None


def provider_for(caller_provider: str | None) -> tuple[VoiceProvider, str]:
    if settings.COMMUNICATION_MODE != "live" or not caller_provider or caller_provider == "simulation":
        return SimulationVoiceProvider(), "simulation"
    if live_credentials_missing(caller_provider):
        return SimulationVoiceProvider(), "simulation"
    if caller_provider == "telnyx":
        from app.providers.voice.telnyx import TelnyxVoiceProvider

        return TelnyxVoiceProvider(settings.TELNYX_API_KEY, settings.TELNYX_ACCOUNT_SID,
                                   settings.TELNYX_TEXML_APP_ID), "telnyx"
    if caller_provider == "twilio":
        from app.providers.voice.twilio import TwilioVoiceProvider

        return TwilioVoiceProvider(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN), "twilio"
    from app.providers.voice.exotel import ExotelVoiceProvider

    return ExotelVoiceProvider(settings.EXOTEL_SID, settings.EXOTEL_API_KEY, settings.EXOTEL_API_TOKEN,
                               settings.EXOTEL_SUBDOMAIN, settings.EXOTEL_APP_ID), "exotel"
