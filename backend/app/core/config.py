"""Application settings loaded from environment variables."""
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

_INSECURE_DEFAULT = "change-me-in-production-please-use-a-long-random-value"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "Signalcraft"
    ENVIRONMENT: Literal["development", "test", "staging", "production"] = "development"
    API_V1_PREFIX: str = "/api/v1"
    FRONTEND_URL: str = "http://localhost:5173"
    BACKEND_PUBLIC_URL: str = "http://localhost:8000"

    DATABASE_URL: str = "mysql+pymysql://signalcraft:signalcraft@localhost:3306/signalcraft?charset=utf8mb4"
    DATABASE_ECHO: bool = False
    REDIS_URL: str = "redis://localhost:6379/0"

    SECRET_KEY: str = _INSECURE_DEFAULT
    # Key material for encrypting provider secrets at rest. Derived into a Fernet key.
    ENCRYPTION_KEY: str = _INSECURE_DEFAULT
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_TTL_MINUTES: int = 15
    REFRESH_TOKEN_TTL_DAYS: int = 30
    EMAIL_VERIFICATION_TTL_HOURS: int = 24
    PASSWORD_RESET_TTL_MINUTES: int = 60
    INVITATION_TTL_DAYS: int = 7
    REFRESH_COOKIE_NAME: str = "sc_refresh"
    COOKIE_SECURE: bool = False

    CORS_ORIGINS: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["http://localhost:5173"])

    # Celery. When eager, tasks run in-process (tests and docker-less local development).
    CELERY_TASK_ALWAYS_EAGER: bool = False

    # Communication. "simulation" never contacts a real provider.
    COMMUNICATION_MODE: Literal["simulation", "live"] = "simulation"
    SYSTEM_EMAIL_PROVIDER: Literal["simulation", "ses", "brevo"] = "simulation"
    SYSTEM_EMAIL_FROM_NAME: str = "Signalcraft"
    SYSTEM_EMAIL_FROM_ADDRESS: str = "no-reply@signalcraft.local"
    BREVO_API_KEY: str | None = None
    # Shared secret Brevo appends to webhook URLs (?token=...). Webhooks are rejected when unset.
    BREVO_WEBHOOK_TOKEN: str | None = None
    # Verify Amazon SNS signatures on SES notifications (never disable in production).
    SES_VERIFY_SNS_SIGNATURES: bool = True
    # Provider send rate for live campaigns (messages per second). SES sandbox default is 1, production ~14.
    EMAIL_RATE_PER_SECOND: float = 14.0

    # SMS providers (used only when COMMUNICATION_MODE=live)
    TWILIO_ACCOUNT_SID: str | None = None
    TWILIO_AUTH_TOKEN: str | None = None
    MSG91_AUTH_KEY: str | None = None
    MSG91_WEBHOOK_TOKEN: str | None = None
    SMS_RATE_PER_SECOND: float = 10.0
    # Voice providers (used only when COMMUNICATION_MODE=live). Twilio credentials are shared with SMS.
    EXOTEL_SID: str | None = None
    EXOTEL_API_KEY: str | None = None
    EXOTEL_API_TOKEN: str | None = None
    EXOTEL_SUBDOMAIN: str = "api.in.exotel.com"
    EXOTEL_APP_ID: str | None = None  # call flow with a Passthru/Greeting applet pointing at our script URL
    EXOTEL_WEBHOOK_TOKEN: str | None = None
    # Telnyx (TeXML). Account id is the Telnyx account UUID; the TeXML application holds the outbound voice profile.
    TELNYX_API_KEY: str | None = None
    TELNYX_ACCOUNT_SID: str | None = None
    TELNYX_TEXML_APP_ID: str | None = None
    TELNYX_PUBLIC_KEY: str | None = None  # base64 Ed25519 key from Keys & Credentials, for webhook signatures
    VOICE_CALLS_PER_SECOND: float = 2.0
    # Billing. Email is priced per accepted email; SMS per part and voice per minute (see above).
    EMAIL_PRICING: dict = {
        "IN": {"currency": "INR", "per_email": 0.05},
        "US": {"currency": "USD", "per_email": 0.0010},
        "default": {"currency": "USD", "per_email": 0.0010},
    }
    # Conversion between a channel's price currency and the wallet currency.
    FX_RATES: dict = {"USD_INR": 83.0}
    # Credit added once to new wallets while the platform is in simulation mode (not real money).
    TRIAL_CREDIT: dict = {"INR": 1000, "USD": 25}
    LOW_BALANCE_DEFAULT: dict = {"INR": 500, "USD": 10}
    # Live wallet top-ups: Stripe (USD wallets) and Razorpay (INR wallets). Hosted pages + signed webhooks.
    STRIPE_SECRET_KEY: str | None = None
    STRIPE_WEBHOOK_SECRET: str | None = None
    RAZORPAY_KEY_ID: str | None = None
    RAZORPAY_KEY_SECRET: str | None = None
    RAZORPAY_WEBHOOK_SECRET: str | None = None
    # Monitoring. /api/v1/metrics is disabled unless METRICS_TOKEN is set. Sentry is used if installed and set.
    METRICS_TOKEN: str | None = None
    SENTRY_DSN: str | None = None
    # Simulation-mode test top-ups only; live payments need a payment provider (Phase 8).
    TEST_TOPUP_MAX: dict = {"INR": 100000, "USD": 1000}
    VOICE_MAX_CONCURRENT_CALLS: int = 10
    # Price per started minute of an answered call, by country.
    VOICE_PRICING: dict = {
        "IN": {"currency": "INR", "per_minute": 0.60},
        "US": {"currency": "USD", "per_minute": 0.0140},
        "default": {"currency": "USD", "per_minute": 0.10},
    }
    # Price per SMS segment by country and category; platform admins will manage this in Phase 8.
    SMS_PRICING: dict = {
        "IN": {"currency": "INR", "promotional": 0.25, "transactional": 0.20, "service": 0.20},
        "US": {"currency": "USD", "promotional": 0.0110, "transactional": 0.0110, "service": 0.0110},
        "default": {"currency": "USD", "promotional": 0.08, "transactional": 0.08, "service": 0.08},
    }
    AWS_REGION: str = "ap-south-1"
    AWS_ACCESS_KEY_ID: str | None = None
    AWS_SECRET_ACCESS_KEY: str | None = None

    STORAGE_BACKEND: Literal["local", "s3"] = "local"
    LOCAL_STORAGE_PATH: str = "./var/storage"
    S3_BUCKET: str | None = None
    S3_ENDPOINT_URL: str | None = None

    SIMULATION_MAILBOX_PATH: str = "./var/mailbox"
    DEV_MAILBOX_ENABLED: bool = True

    RATE_LIMIT_ENABLED: bool = True
    RATE_LIMIT_AUTH_PER_MINUTE: int = 20
    RATE_LIMIT_REGISTER_PER_MINUTE: int = 10

    LOG_LEVEL: str = "INFO"
    LOG_JSON: bool = False

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("["):
                import json

                return json.loads(v)
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @model_validator(mode="after")
    def _production_guards(self):
        if self.ENVIRONMENT == "production":
            if self.SECRET_KEY == _INSECURE_DEFAULT or len(self.SECRET_KEY) < 32:
                raise ValueError("SECRET_KEY must be set to a strong value in production")
            if self.ENCRYPTION_KEY == _INSECURE_DEFAULT:
                raise ValueError("ENCRYPTION_KEY must be set in production")
            if self.DEV_MAILBOX_ENABLED:
                raise ValueError("DEV_MAILBOX_ENABLED must be false in production")
            if not self.COOKIE_SECURE:
                raise ValueError("COOKIE_SECURE must be true in production")
        return self

    @property
    def is_sqlite(self) -> bool:
        return self.DATABASE_URL.startswith("sqlite")

    @property
    def dev_mailbox_active(self) -> bool:
        return (
            self.DEV_MAILBOX_ENABLED
            and self.ENVIRONMENT != "production"
            and self.SYSTEM_EMAIL_PROVIDER == "simulation"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
