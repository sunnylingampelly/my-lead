"""Choose the SMS provider for a sender. Simulation unless the platform is explicitly live."""
from app.core.config import settings
from app.providers.sms.base import SmsProvider
from app.providers.sms.simulation import SimulationSmsProvider


def live_credentials_missing(provider: str) -> str | None:
    """Return a message when live sending through `provider` cannot work, else None."""
    if provider != "sns":
        return "Choose Amazon SNS as the sender's provider"
    from app.providers.sms.sns import credentials_available

    if not settings.AWS_REGION or not credentials_available(
            settings.AWS_REGION, settings.AWS_ACCESS_KEY_ID, settings.AWS_SECRET_ACCESS_KEY):
        return "AWS credentials for Amazon SNS are not configured on the platform"
    return None


def provider_for(sender_provider: str | None) -> tuple[SmsProvider, str]:
    # Simulation mode is a global safety switch: no message reaches a carrier.
    if settings.COMMUNICATION_MODE != "live" or not sender_provider or sender_provider == "simulation":
        return SimulationSmsProvider(), "simulation"
    if live_credentials_missing(sender_provider):
        return SimulationSmsProvider(), "simulation"
    from app.providers.sms.sns import SnsSmsProvider, sns_client

    return SnsSmsProvider(sns_client(settings.AWS_REGION, settings.AWS_ACCESS_KEY_ID,
                                     settings.AWS_SECRET_ACCESS_KEY)), "sns"
