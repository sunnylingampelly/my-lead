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
| SMS India and US (Amazon SNS) | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (or an IAM role), optional `AWS_ACCOUNT_ID` | Replies: SNS topic for two-way SMS subscribed to `/api/v1/webhooks/sms/sns`. Receipts: enable SNS delivery status logging; the app reads them from CloudWatch (needs `sns:Publish`, `logs:FilterLogEvents`, `sts:GetCallerIdentity`) |
| Voice (Telnyx) | `TELNYX_API_KEY`, `TELNYX_ACCOUNT_SID`, `TELNYX_TEXML_APP_ID`, `TELNYX_PUBLIC_KEY` | Set per call automatically |
| Voice (Exotel) | `EXOTEL_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_APP_ID`, `EXOTEL_WEBHOOK_TOKEN` | Set per call automatically |
| Payments USD (Stripe) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `/api/v1/webhooks/payments/stripe` with events `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` |
| Payments INR (Razorpay) | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | `/api/v1/webhooks/payments/razorpay` with events `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled` |

Every webhook is authenticated (signature or shared token), stored once and processed in the
background. Failed events can be inspected and retried under **Platform admin → Webhooks**.

Use each provider's test or sandbox keys first. The SMS, voice and payment adapters follow the
providers' published APIs but have not been exercised against the live services.

### AI Team: OpenAI

Set `OPENAI_API_KEY` to turn on the AI Assistant, AI agents and the automation AI step (they use
OpenAI's Responses API with function tools). `OPENAI_MODEL` defaults to `gpt-6.2-astra` (OpenAI's
current flagship) and `OPENAI_MODEL_FAST` (default `gpt-6-luna`) is used for the automation AI step's
classify/extract calls. Without a key everything runs in a labelled simulation mode. Requests are sent
with `store=false`. The website chatbot and AI calling agents keep using `ANTHROPIC_API_KEY`.

Fair-use limits are per organization per UTC day (Starter: 50 assistant messages and 100 agent runs;
Pro: 500 and 2,000), set in `backend/app/services/billing/plans.py`.

### AI Team: Slack

Agents post reports and approval requests (Approve / Reject / Open in Signalcraft) to Slack. Create
one Slack app for the platform; each customer organization installs it with "Add to Slack".

1. Go to https://api.slack.com/apps → **Create New App** → *From scratch*. Name it (e.g.
   "Signalcraft") and pick your own workspace for development.
2. **OAuth & Permissions**
   - *Redirect URLs*: add `<BACKEND_PUBLIC_URL>/api/v1/integrations/slack/oauth/callback`
     (HTTPS in production; the exact URL is also shown in the app under AI Team → Integrations).
   - *Bot Token Scopes*: `chat:write`, `chat:write.public`, `channels:read`, `groups:read`,
     `users:read`, `users:read.email`. (`users:read.email` lets an Approve click be matched to a
     Signalcraft user by email; without it every click is refused.)
3. **Interactivity & Shortcuts**: turn *Interactivity* on and set the *Request URL* to
   `<BACKEND_PUBLIC_URL>/api/v1/integrations/slack/interactivity`.
4. **Basic Information → App Credentials**: copy the *Client ID*, *Client Secret* and *Signing
   Secret* into `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET`, then restart
   the API and workers.
5. To let other workspaces install it: **Manage Distribution** → *Activate Public Distribution*
   (Slack reviews the app only if you list it in the Slack Marketplace, which is optional).
6. In Signalcraft: **AI Team → Integrations → Add to Slack**, approve the scopes, then pick channels
   on each agent. For private channels, invite the bot first (`/invite @Signalcraft`).

Every interactivity request is verified (v0 HMAC-SHA256 of the raw body with the signing secret,
rejected if the timestamp is more than five minutes off). The clicking Slack user is looked up with
`users.info` and must match an active member of the organization (by email) whose role can manage
AI agents; otherwise the click is refused with a message only they see. Bot tokens are encrypted at
rest with `ENCRYPTION_KEY`; disconnecting revokes the token (`auth.revoke`).

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
* Errors: set `SENTRY_DSN` (backend, `sentry-sdk[fastapi]` is in requirements) and optionally
  `VITE_SENTRY_DSN` at frontend build time. `send_default_pii` is off, request bodies are never sent,
  `Authorization`/cookie headers and token query parameters are scrubbed, and auth endpoint bodies are
  dropped. Events carry `environment` (`ENVIRONMENT`) and `release` (`SENTRY_RELEASE`, e.g. the git SHA).
  Without a DSN the browser never downloads the Sentry SDK.
* Logs are structured; set `LOG_JSON=true` for JSON lines. Passwords, tokens and provider secrets
  are never logged.

Suggested alerts: `/api/v1/health` failing; pending messages growing for 15 minutes; webhook events
with status `failed`; failed workflow runs; organizations with low balance (owners are already
notified in the app).

## 6. Operations

* **Backups:** `backend/scripts/backup_db.py` (see "Database backups" below) plus the storage volume
  or bucket. Test restores.
* **Upgrades:** pull, rebuild, `docker compose … up -d --build`. The `migrate` service applies new
  migrations before the API starts.
* **Scaling:** add `worker` replicas freely; keep one `scheduler`. Sends are idempotent and claimed
  per message, so concurrent workers do not double-send.
* **Offline SQL:** `alembic upgrade head --sql` produces the DDL for review; after applying it by
  hand, run `python -m app.cli sync-rbac` to create roles and permissions.

## 7. Database backups

`backend/scripts/backup_db.py` runs `mysqldump --single-transaction --routines --triggers` against the
database named in `DATABASE_URL`, gzips it to `<BACKUP_DIR>/signalcraft_YYYYmmdd_HHMM.sql.gz`
(default `backend/var/backups`) and prunes old files, keeping the newest backup of each of the last
`BACKUP_KEEP_DAILY` days (7) and of each of the last `BACKUP_KEEP_WEEKLY` ISO weeks (4). The password goes
through `MYSQL_PWD`, never the command line. `MYSQLDUMP_PATH` / `MYSQL_PATH` point at the client tools
(default: `PATH`, then `D:\xxmp\mysql\bin`). The admin area's **Settings** tab shows the newest backup and
flags it when it is older than 26 hours.

```bash
cd backend
python scripts/backup_db.py                         # dump + prune
python scripts/backup_db.py --prune-only --dry-run  # show what retention would delete
```

Restore always goes into a **new** database; an existing one is refused unless `--force` is given (it is
then dropped and recreated). `live` and the MySQL system schemas are always refused.

```bash
python scripts/restore_db.py --target signalcraft_restore_check                       # newest backup
python scripts/restore_db.py var/backups/signalcraft_20261124_0300.sql.gz --target signalcraft_copy
# Restore drill: restore, compare every table's exact row count with the source, drop the copy.
python scripts/restore_db.py --target signalcraft_restore_check --compare-with signalcraft --drop-after
```

Schedule it daily.

Windows (Task Scheduler, 03:00 every day; one line in an elevated prompt):

```bat
schtasks /Create /TN "Signalcraft DB backup" /SC DAILY /ST 03:00 /RU SYSTEM /TR "cmd /c cd /d D:\my-lead\backend && .venv\Scripts\python.exe scripts\backup_db.py >> var\backups\backup.log 2>&1"
```

Linux production (crontab of the deploy user, 02:30 every day):

```cron
30 2 * * * cd /srv/signalcraft/backend && ./.venv/bin/python scripts/backup_db.py >> /var/log/signalcraft-backup.log 2>&1
```

With Docker, run it inside the API container instead:
`docker compose -f docker-compose.prod.yml exec -T api python scripts/backup_db.py` (mount `BACKUP_DIR` on a
volume that is copied off the host). Run the restore drill at least monthly.
