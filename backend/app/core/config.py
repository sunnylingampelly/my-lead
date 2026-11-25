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
    # A rotated refresh token is accepted once more within this many seconds if its successor was never used
    # (a reload aborted the refresh response). Outside it, or once the successor is used, reuse = theft.
    REFRESH_REUSE_GRACE_SECONDS: int = 30
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

    # SMS goes through Amazon SNS (used only when COMMUNICATION_MODE=live), with the AWS_* credentials
    # below. Delivery receipts are read from SNS delivery status logs in CloudWatch; replies (STOP)
    # arrive from an SNS topic at /api/v1/webhooks/sms/sns. AWS_ACCOUNT_ID skips an STS lookup.
    AWS_ACCOUNT_ID: str | None = None
    SNS_SMS_RECEIPTS_ENABLED: bool = True
    SMS_RATE_PER_SECOND: float = 10.0
    # Voice providers (used only when COMMUNICATION_MODE=live).
    TWILIO_ACCOUNT_SID: str | None = None
    TWILIO_AUTH_TOKEN: str | None = None
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
        # AED rows across the *_PRICING settings are the USD prices x 3.6725, rounded.
        # OWNER: review the AED margins before launch.
        "AE": {"currency": "AED", "per_email": 0.004},
        "default": {"currency": "USD", "per_email": 0.0010},
    }
    # Conversion between a channel's price currency and the wallet currency. Pairs without a direct rate
    # (e.g. INR to AED) are converted through USD. AED is pegged at 3.6725 per USD.
    FX_RATES: dict = {"USD_INR": 83.0, "USD_AED": 3.6725}
    # Credit added once to new wallets while the platform is in simulation mode (not real money).
    TRIAL_CREDIT: dict = {"INR": 1000, "USD": 25, "AED": 90}
    LOW_BALANCE_DEFAULT: dict = {"INR": 500, "USD": 10, "AED": 35}
    # Kill switches for UAE SMS and calls. The rules are built, but both stay off at launch: AWS has paused
    # UAE sender-ID registration, and UAE marketing calls must come from the customer's own licensed number.
    SMS_UAE_ENABLED: bool = False
    # Global SMS switch. SMS is "coming soon" in every market: while False, every SMS write/action endpoint is
    # refused (SMS_COMING_SOON), automation SMS steps can't be added and the engine skips SMS sends.
    SMS_ENABLED: bool = False
    VOICE_UAE_ENABLED: bool = False
    # Opt-out text appended to promotional UAE SMS (English, or Arabic when the message is Arabic).
    SMS_UAE_OPT_OUT_EN: str = "To opt out reply STOP"
    SMS_UAE_OPT_OUT_AR: str = "لإلغاء الاشتراك أرسل STOP"
    # Live wallet top-ups: Stripe (USD wallets) and Razorpay (INR and AED wallets; AED uses Razorpay
    # international payments, which must be activated on the Razorpay account). Hosted pages + signed webhooks.
    STRIPE_SECRET_KEY: str | None = None
    STRIPE_WEBHOOK_SECRET: str | None = None
    RAZORPAY_KEY_ID: str | None = None
    RAZORPAY_KEY_SECRET: str | None = None
    RAZORPAY_WEBHOOK_SECRET: str | None = None
    # GST tax invoices for wallet top-ups (the platform is the seller). Prices exclude GST: an INR top-up of X
    # is charged X + GST_RATE% and credits X to the wallet. INR top-ups are refused until SELLER_GSTIN and
    # SELLER_STATE_CODE are set. USD (export) invoices are zero-rated under the LUT in SELLER_LUT_NUMBER.
    SELLER_LEGAL_NAME: str = "Signalcraft"
    SELLER_GSTIN: str | None = None
    SELLER_ADDRESS: str = ""
    SELLER_STATE_CODE: str | None = None  # two-digit GST state code, e.g. "29" (Karnataka)
    SELLER_PAN: str | None = None
    SELLER_LUT_NUMBER: str | None = None  # ARN of the Letter of Undertaking for zero-rated exports
    INVOICE_SAC_CODE: str = "998431"  # confirm the SAC with your chartered accountant
    GST_RATE: float = 18.0
    # Invoice numbers are PREFIX/YY-YY/NNNNNN, sequential per Indian financial year (GST allows 16 characters).
    INVOICE_NUMBER_PREFIX: str = "SC"
    # Sender domain authentication (DNS checks shown on the senders page and in campaign readiness).
    EMAIL_DNS_CHECKS_ENABLED: bool = True
    EMAIL_SPF_INCLUDE: str = "amazonses.com"  # e.g. amazonses.com (SES) or spf.brevo.com (Brevo)
    EMAIL_DKIM_SELECTORS: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["signalcraft"])
    # When set, DKIM is a CNAME from {selector}._domainkey.{domain} to this target ({selector} and {domain}
    # are filled in). When unset, a TXT record with a DKIM key at the selector passes.
    EMAIL_DKIM_CNAME_TARGET: str | None = None
    EMAIL_DNS_TIMEOUT_SECONDS: float = 3.0
    # Monitoring. /api/v1/metrics is disabled unless METRICS_TOKEN is set. Sentry is used if installed and set.
    METRICS_TOKEN: str | None = None
    SENTRY_DSN: str | None = None
    # Release tag for error reports (e.g. a git SHA or version). Defaults to the app version.
    SENTRY_RELEASE: str | None = None
    SENTRY_TRACES_SAMPLE_RATE: float = 0.0
    # Where scripts/backup_db.py writes backups; the admin System settings show the newest one.
    BACKUP_DIR: str | None = None
    # Simulation-mode test top-ups only; live payments need a payment provider (Phase 8).
    TEST_TOPUP_MAX: dict = {"INR": 100000, "USD": 1000, "AED": 3700}
    # Real (Stripe / Razorpay) top-ups: smallest and largest amount per checkout, in the wallet currency.
    TOPUP_MIN: dict = {"INR": 500, "AED": 50, "USD": 10}
    TOPUP_MAX: dict = {"INR": 500000, "AED": 37000, "USD": 10000}
    VOICE_MAX_CONCURRENT_CALLS: int = 10
    # Price per started minute of an answered call, by country.
    # Recorded / text-to-speech calls (approved 2026-11 price list; UAE voice is off at launch).
    VOICE_PRICING: dict = {
        "IN": {"currency": "INR", "per_minute": 2.50},
        "US": {"currency": "USD", "per_minute": 0.07},
        "AE": {"currency": "AED", "per_minute": 3.50},
        "default": {"currency": "USD", "per_minute": 0.10},
    }
    # AI calling agents: price per started minute of an answered AI-agent call (replaces VOICE_PRICING for
    # those calls; usage discounts apply at settlement). Estimates assume AI_CALL_EXPECTED_MINUTES per answer.
    VOICE_AI_PRICING: dict = {
        "IN": {"currency": "INR", "per_minute": 25.0},
        "US": {"currency": "USD", "per_minute": 0.40},
        "AE": {"currency": "AED", "per_minute": 4.75},
        "default": {"currency": "USD", "per_minute": 0.45},
    }
    AI_CALL_EXPECTED_MINUTES: int = 2
    # Claude for AI calling agents. Without a key, test chats and simulated calls use an offline responder.
    ANTHROPIC_API_KEY: str | None = None
    AI_AGENT_MODEL: str = "claude-opus-5-5"
    AI_AGENT_EFFORT: str = "low"  # effort for live conversation turns (latency matters on a phone call)
    # Website chatbots (live chat). Each AI reply is charged per reply by the app's default country (usage
    # discounts apply); human live chat and simulated replies (no ANTHROPIC_API_KEY) are free.
    CHAT_AI_MODEL: str = "claude-opus-5-5"
    CHAT_AI_EFFORT: str = "low"
    CHAT_AI_PRICING: dict = {
        "IN": {"currency": "INR", "per_reply": 4.0},
        "US": {"currency": "USD", "per_reply": 0.06},
        "AE": {"currency": "AED", "per_reply": 0.22},
        "default": {"currency": "USD", "per_reply": 0.06},
    }
    # Knowledge up to this size goes whole into the (cached) system prompt; above it, the best chunks are
    # retrieved per question with MariaDB FULLTEXT search.
    CHAT_KNOWLEDGE_INLINE_CHARS: int = 150_000
    CHAT_KNOWLEDGE_MAX_CHARS: int = 2_000_000  # per bot, all sources
    CHAT_FETCH_MAX_BYTES: int = 3_000_000
    CHAT_CRAWL_MAX_PAGES: int = 25
    CHAT_UPLOAD_MAX_BYTES: int = 10_000_000
    # AI Team (the in-app AI Assistant, AI agents and the automation "AI step") runs on OpenAI's Responses API.
    # Without OPENAI_API_KEY everything works in a deterministic, clearly labelled simulation mode. The website
    # chatbot and AI calling agents stay on Claude (above). Fair-use daily limits per plan are in billing/plans.py.
    OPENAI_API_KEY: str | None = None
    OPENAI_MODEL: str = "gpt-6.2-astra"
    OPENAI_MODEL_FAST: str | None = "gpt-6-luna"  # cheap classification/extraction (automation AI step)
    OPENAI_TIMEOUT_SECONDS: float = 60.0
    AI_AGENT_MAX_STEPS: int = 8
    # Metered AI Team billing: provider cost from the tokens each call used (USD per 1M tokens; cached input is
    # billed at the cached rate), times AI_MARKUP, at least AI_MIN_CHARGE per assistant message / agent run /
    # workflow AI step, converted to the wallet currency, then the plan's usage discount (Pro: 20% off).
    # Unknown models are priced like the most expensive one listed.
    OPENAI_PRICING: dict = {
        "gpt-6.2-astra": {"input": 8.00, "cached": 0.40, "output": 40.00},
        "gpt-6-luna": {"input": 0.10, "cached": 0.01, "output": 0.50},
    }
    AI_MARKUP: float = 3.0
    AI_MIN_CHARGE: dict = {"INR": 1.0, "AED": 0.05, "USD": 0.01}
    # Typical charges shown on pricing pages (a simple question on the fast model; a typical agent run).
    AI_TYPICAL_CHARGE: dict = {"assistant_message": {"INR": 3.0, "AED": 0.15, "USD": 0.04},
                               "agent_run": {"INR": 10.0, "AED": 0.45, "USD": 0.12}}
    AI_AGENT_RUN_TIMEOUT_SECONDS: int = 120
    # Slack app ("Add to Slack", OAuth v2). Without SLACK_CLIENT_ID/SECRET a simulated Slack connection logs
    # messages to /dev/slack instead. The signing secret verifies interactivity requests (Approve / Reject).
    SLACK_CLIENT_ID: str | None = None
    SLACK_CLIENT_SECRET: str | None = None
    SLACK_SIGNING_SECRET: str | None = None
    # Days a released number rests before it goes back to the pool, and the grace period for unpaid rent.
    NUMBER_QUARANTINE_DAYS: int = 7
    NUMBER_RENEWAL_GRACE_DAYS: int = 7
    # Price per SMS segment by country and category; platform admins will manage this in Phase 8.
    # AE: the international USD 0.08 rate x 3.6725 (UAE termination costs far more than US 10DLC).
    # OWNER: review the AED margins before launch.
    SMS_PRICING: dict = {
        "IN": {"currency": "INR", "promotional": 0.25, "transactional": 0.20, "service": 0.20},
        "US": {"currency": "USD", "promotional": 0.0110, "transactional": 0.0110, "service": 0.0110},
        "AE": {"currency": "AED", "promotional": 0.29, "transactional": 0.29, "service": 0.29},
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
    # Cloudflare Turnstile for lead forms (optional; forms opt in once both keys are set).
    TURNSTILE_SITE_KEY: str | None = None
    TURNSTILE_SECRET_KEY: str | None = None

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

    @field_validator("EMAIL_DKIM_SELECTORS", mode="before")
    @classmethod
    def _split_selectors(cls, v):
        if isinstance(v, str):
            return [s.strip() for s in v.split(",") if s.strip()]
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
