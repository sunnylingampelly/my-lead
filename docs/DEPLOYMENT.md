# Deployment

This guide is for whoever runs Signalcraft on a server. It covers the production stack, required
settings, provider webhooks, the first administrator, and day-to-day operations.

> **Status.** The Docker files are written but have not yet been run end to end, because Docker
> and MySQL were not available on the development machine. The schema has been compiled to MySQL
> DDL (all migrations), and every index fits MySQL's key-size limit. Run the stack on a staging
> server before going live.

## 1. Services

| Service | Image | Role |
| --- | --- | --- |
| `mysql` | mysql 8.4 | Database |
| `redis` | redis 7.4 | Celery broker and results |
| `migrate` | backend | Runs `alembic upgrade head` once, then exits |
| `backend` | backend | FastAPI (uvicorn, 2 workers) |
| `worker` | backend | Celery worker for queues `default,email,campaigns,imports,webhooks` |
| `scheduler` | backend | Celery Beat. Run exactly one. |
| `frontend` | nginx | Built React app; proxies `/api/` to the backend |

Start it:

```bash
cp .env.example .env.production   # then fill it in (see below)
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml exec backend python -m app.cli create-superadmin you@example.com "Your Name"
```

Put TLS in front of the `frontend` service (a load balancer, Caddy or nginx with certificates).
Set `COOKIE_SECURE=true` once the site is served over HTTPS.

## 2. Required settings

| Setting | Notes |
| --- | --- |
| `SECRET_KEY`, `ENCRYPTION_KEY` | Long random values: `python -c "import secrets;print(secrets.token_urlsafe(48))"`. Never change `ENCRYPTION_KEY` after data exists. |
| `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD` | Database passwords |
| `FRONTEND_URL`, `CORS_ORIGINS` | The public site, e.g. `https://app.example.com` |
| `BACKEND_PUBLIC_URL` | The public URL providers call back. With the bundled nginx it is the same as `FRONTEND_URL`. |
| `COMMUNICATION_MODE` | `simulation` until providers are configured and tested. Switch to `live` deliberately. |
| `STORAGE_BACKEND` | `local` (the `backend_var` volume) or `s3` with `S3_BUCKET`, `S3_ENDPOINT_URL` and AWS credentials |

## 3. Providers and webhook URLs

Configure only what you use. Admins can see which providers are configured under
**Platform admin → Settings**; secret values are never shown.

| Purpose | Settings | Webhook URL to register with the provider |
| --- | --- | --- |
| Email (Brevo) | `BREVO_API_KEY`, `BREVO_WEBHOOK_TOKEN` | `/api/v1/webhooks/email/brevo?token=<BREVO_WEBHOOK_TOKEN>` |
| Email (Amazon SES) | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | SNS subscription to `/api/v1/webhooks/email/ses` |
| SMS India (MSG91) | `MSG91_AUTH_KEY`, `MSG91_WEBHOOK_TOKEN` | `/api/v1/webhooks/sms/msg91?token=…` and `/api/v1/webhooks/sms/msg91/inbound?token=…` |
| SMS US (Twilio) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Messaging service inbound: `/api/v1/webhooks/sms/twilio/inbound` (status callbacks are set per message) |
| Voice (Telnyx) | `TELNYX_API_KEY`, `TELNYX_ACCOUNT_SID`, `TELNYX_TEXML_APP_ID`, `TELNYX_PUBLIC_KEY` | Set per call automatically |
| Voice (Exotel) | `EXOTEL_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_APP_ID`, `EXOTEL_WEBHOOK_TOKEN` | Set per call automatically |
| Payments USD (Stripe) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `/api/v1/webhooks/payments/stripe` with events `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` |
| Payments INR (Razorpay) | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | `/api/v1/webhooks/payments/razorpay` with events `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled` |

Every webhook is authenticated (signature or shared token), stored once and processed in the
background. Failed events can be inspected and retried under **Platform admin → Webhooks**.

Use each provider's test or sandbox keys first. The SMS, voice and payment adapters follow the
providers' published APIs but have not been exercised against the live services.

## 4. Billing

Prices and the currency conversion rate are settings (`EMAIL_PRICING`, `SMS_PRICING`,
`VOICE_PRICING`, `FX_RATES`). In live mode wallets start empty: customers add credit through
Stripe or Razorpay, or an administrator credits them under **Platform admin → Organizations**.
The scheduler settles usage every minute; `python -m app.cli settle-usage` runs it by hand.

## 5. Monitoring

* `GET /api/v1/health/live`: process is up (no dependencies).
* `GET /api/v1/health`: database, queue and storage; returns 503 when degraded. Use it for readiness.
* `GET /api/v1/metrics`: Prometheus text format, enabled by setting `METRICS_TOKEN` and scraped
  with `Authorization: Bearer <METRICS_TOKEN>`. It includes HTTP request counts and latency by
  route group, campaigns by status, pending messages per channel, webhook events by status,
  workflow runs by status and open wallet holds. Request counters are per process.
* Errors: set `SENTRY_DSN` and install `sentry-sdk` to report unhandled errors. Request bodies and
  personal data are not sent.
* Logs are structured; set `LOG_JSON=true` for JSON lines. Passwords, tokens and provider secrets
  are never logged.

Suggested alerts: `/api/v1/health` failing; pending messages growing for 15 minutes; webhook events
with status `failed`; failed workflow runs; organizations with low balance (owners are already
notified in the app).

## 6. Operations

* **Backups:** back up the `mysql_data` volume (or use `mysqldump --single-transaction`) and the
  storage volume or bucket. Test restores.
* **Upgrades:** pull, rebuild, `docker compose … up -d --build`. The `migrate` service applies new
  migrations before the API starts.
* **Scaling:** add `worker` replicas freely; keep one `scheduler`. Sends are idempotent and claimed
  per message, so concurrent workers do not double-send.
* **Offline SQL:** `alembic upgrade head --sql` produces the DDL for review; after applying it by
  hand, run `python -m app.cli sync-rbac` to create roles and permissions.
