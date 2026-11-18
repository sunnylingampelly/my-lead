"""Resolve the provider used for platform (system) emails such as verification and invites."""
from app.core.config import settings
from app.providers.email.base import EmailProvider
from app.providers.email.simulation import SimulationEmailProvider


def get_system_email_provider() -> EmailProvider:
    # Simulation mode is a global safety switch: nothing leaves the machine.
    if settings.COMMUNICATION_MODE == "simulation" or settings.SYSTEM_EMAIL_PROVIDER == "simulation":
        return SimulationEmailProvider()
    if settings.SYSTEM_EMAIL_PROVIDER == "brevo":
        from app.providers.email.brevo import BrevoEmailProvider

        return BrevoEmailProvider(settings.BREVO_API_KEY or "")
    if settings.SYSTEM_EMAIL_PROVIDER == "ses":
        from app.providers.email.ses import SesEmailProvider

        return SesEmailProvider(settings.AWS_REGION, settings.AWS_ACCESS_KEY_ID, settings.AWS_SECRET_ACCESS_KEY)
    raise ValueError(f"Unknown system email provider {settings.SYSTEM_EMAIL_PROVIDER}")
