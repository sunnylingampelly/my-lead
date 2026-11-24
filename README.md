# Signalcraft

A multi-tenant marketing automation platform. Businesses register, create organizations and
isolated applications, manage audiences, and run email, SMS and voice campaigns.

**Current state:** All eight phases are built: foundation, audience, email, SMS, voice, automation, billing and analytics, and hardening (platform admin, payments, monitoring, deployment files). See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) to run it on a server. India and the
United States are first-class markets: phone formats, timezones, date formats and regional
compliance rules (TRAI DLT, DPDP, TCPA, CAN-SPAM) are built in. See [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md)
for what works today and what comes next, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
design, ER diagram and API plan.

## Stack

* **Backend:** Python 3.12+, FastAPI, Pydantic v2, SQLAlchemy 2, Alembic, Celery, Redis, Argon2, JWT.
* **Database:** MySQL only: MySQL 8 in production; MariaDB 10.4+ (e.g. XAMPP) works for local development and tests.
* **Frontend:** React 19, TypeScript, Vite, Tailwind CSS, shadcn-style Radix components, TanStack Query,
  React Hook Form, Zod, Lucide, Recharts.
* **Tests:** pytest and Playwright.

## Run locally without Docker

Requires Python 3.12 or newer and Node 20 or newer.

### Backend (port 8010)

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements-dev.txt     # macOS/Linux: .venv/bin/pip
cp .env.example .env                                    # then set SECRET_KEY and ENCRYPTION_KEY
.venv/Scripts/alembic upgrade head
.venv/Scripts/python -m uvicorn main:app --host 127.0.0.1 --port 8010 --reload --reload-dir app --timeout-graceful-shutdown 3
```

With `CELERY_TASK_ALWAYS_EAGER=true` background tasks such as imports run on local background
threads, so Redis is not needed. Interrupted imports resume automatically when the server
restarts. Use `--reload-dir app` so the reloader ignores the virtualenv, and
`--timeout-graceful-shutdown 3` so reloads never hang on open keep-alive connections.
API docs are at http://127.0.0.1:8010/docs.

### Frontend (port 5173)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend, so the refresh
cookie stays same-origin. Set `VITE_PROXY_TARGET` to point at a different backend.

### Emails and texts in development

The platform starts in **simulation mode**. Nothing is sent to real people. Verification,
password reset, invitation and campaign emails are written to `backend/var/mailbox` and shown at
http://localhost:5173/dev/mailbox, which has buttons for every link in each email. Simulated SMS
are written to `backend/var/sms_outbox` and shown at http://localhost:5173/dev/sms. Simulated calls are
written to `backend/var/call_log` and shown at http://localhost:5173/dev/calls.

## Tests

```bash
# Backend: runs real Alembic migrations against the MySQL test database (TEST_DATABASE_URL,
# default signalcraft_test on 127.0.0.1); the suite wipes that database
cd backend && .venv/Scripts/python -m pytest
.venv/Scripts/ruff check app tests migrations

# Frontend type-check, lint and build
cd frontend && npm run typecheck && npm run lint && npm run build

# End-to-end: start the backend and frontend first (runs one browser at a time)
cd frontend && npx playwright install chromium && npm run test:e2e
```

To run the backend suite against MySQL, set `TEST_DATABASE_URL` to an empty MySQL database.

## Repository layout

```
backend/
  app/api/v1        HTTP routers
  app/core          config, security, errors, logging, permissions, rate limiting
  app/models        SQLAlchemy models
  app/schemas       Pydantic request and response models
  app/services      business logic and tenancy resolution
  app/providers     channel provider adapters (simulation, Brevo, SES, …)
  app/tasks         Celery tasks;  app/workers: Celery app
  migrations        Alembic migrations
  tests             pytest suite
frontend/
  src/api           HTTP client, typed endpoints, query hooks
  src/components    UI primitives and shared page components
  src/layouts       auth layout and application shell
  src/modules       feature pages (auth, organizations, applications, audience, dashboard, account, dev)
  src/routes        router and guards
  e2e               Playwright tests
docs/               architecture and design documents
infrastructure/     Docker files (not yet verified; Docker work is deferred)
```

## Configuration

All settings are environment variables, documented in [backend/.env.example](backend/.env.example).
Production refuses to start with default secrets, with the dev mailbox enabled, or without
secure cookies.

## Docker

Docker files exist in `infrastructure/docker` and `docker-compose.yml`, but they have not been
built or tested yet. Container work is deferred until the product modules are in place.
