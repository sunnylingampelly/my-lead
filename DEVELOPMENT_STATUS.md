# Development status

Last updated: 2026-11-18

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | Auth, organizations, applications, RBAC, invitations, audit log, app shell | **Complete** |
| 2. Audience | Contacts, custom fields, CSV/XLSX import, lists, tags, segments, consent, suppression, India/US regional rules | **Complete** |
| 3. Email | Providers, senders, templates, editor, campaigns, scheduling, send engine, webhooks, reports | **Complete** |
| 4. SMS | Providers, DLT (India), 10DLC (US), templates, campaigns, delivery reports | **Complete** |
| 5. Voice | Providers, audio library, TTS, campaigns, calling windows, callbacks | **Complete** |
| 6. Automation | React Flow builder, workflow engine | **Complete** |
| 7. Billing and analytics | Wallet ledger (INR/USD), credits, usage, analytics | **Complete** |
| 8. Hardening | Platform admin, payments, monitoring, Docker deployment | **Complete**, except running Docker (not available on the dev machine) |
| 9. CRM | Companies, pipelines, deals, board, tasks, notes, timeline, lead scoring, assignment, SLA, reports, automation | **Complete (v1)** |

Verification: 148 backend tests (pytest) and the browser end-to-end tests (Playwright, including CRM) pass
against the running app.

## India and United States support

The platform treats India and the US as first-class markets. Other countries get the
strictest defaults.

| Area | India | United States |
| --- | --- | --- |
| Phone numbers | 10-digit mobiles, `0`-prefixed and `91`-prefixed forms parsed to E.164; shown as +91 98765 43210 | (415) 555-2671 style parsed to E.164; shown in national format to US users |
| Timezones | Asia/Kolkata | Derived from state, or area code when there is no state |
| Dates in imports | DD/MM/YYYY | MM/DD/YYYY |
| Numbers | Lakh/crore grouping (5,00,000) | Western grouping (500,000) |
| Default quiet hours | 21:00–09:00 IST | 21:00–08:00 recipient local time (TCPA) |
| SMS/voice consent | Source required; DLT consent reference field | Written consent evidence required (TCPA) |
| Email | — | Business postal address tracked (CAN-SPAM) |
| Compliance tab | TRAI TCCCPR DLT, DPDP Act 2023 | TCPA, CAN-SPAM, A2P 10DLC, Do Not Call |
| Addresses | 36 states and UTs, PIN code | 50 states + DC + PR, ZIP code |

Regional rules live in `backend/app/services/regions.py`. They are product defaults, not legal
advice, and the UI says so.

## Super admin and platform staff

* **Two platform roles**, separate from organization roles: **Super admin** (full control) and
  **Support** (sees everything in the admin console, opens read-only sessions, changes nothing).
  The role is read from the database on every request.
* **Staff management** under Platform admin → Platform staff: super admins add existing accounts as
  staff, change roles and remove staff. Nobody can change their own role, and the platform always
  keeps at least one active super admin.
* **First super admin on a new server:** `python -m app.cli create-superadmin you@example.com "Name"`
  (prompts for a password and creates a verified account). `grant-admin`, `grant-support` and
  `revoke-admin` manage existing accounts. Staff with no organization of their own land in the console.
* **Read-only support access:** from an organization's details, staff open its workspace for 15
  minutes to 4 hours with a reason. They see exactly what the customer sees, with every change and
  export disabled, under a banner they can end at any time. The session is written to the
  customer's audit log and their owners and admins are notified. Removing a staff member ends their
  sessions.

## Phase 9: CRM (what works)

* **Companies:** India fields (GSTIN with checksum, PAN derived from GSTIN, GST treatment, state),
  domain normalised from the website, duplicate warnings on domain, GSTIN, phone and name (409 with
  matches; "create anyway"), linked contacts, owner, open deal value.
* **Pipelines and deals:** a default sales pipeline and lost reasons per application; several
  pipelines with ordered stages, probability and "rotting" days per stage. Deals have amount
  (INR/USD), close date, owner, contact, company, extra people with roles and a probability
  override. Kanban board with count, total and weighted total per stage and drag to move; Lost
  requires a reason; won marks the contact a customer; stage history with time in each stage.
* **Work:** tasks (type, priority, due date, assignee, reminders 15 minutes before due), notes with
  `@mentions` that notify teammates, logged calls, meetings, WhatsApp and visits. One timeline per
  contact, deal or company merges CRM work with the campaign email, SMS and call history.
* **Leads:** owner, lifecycle stage and scores on every contact. Rule-based scoring: fit rules on
  contact and company fields plus engagement points for opens, clicks, SMS replies, answered
  calls, notes and activities within a rolling window, graded A1–C3 with a "hot" threshold.
  Round-robin assignment rules (by source, location, lifecycle or segment, with per-person caps)
  and a first-response SLA that flags and notifies on breach.
* **Reports:** weighted forecast by close month (commit / best case / won), win/loss with lost
  reasons and sales cycle, stage conversion, and a leaderboard.
* **Automation:** triggers for deal created, moved, won, lost and going cold, hot score reached,
  SLA missed and owner assigned; a "CRM action" step that creates deals or tasks, assigns owners,
  moves deals and sets lifecycle stages.
* **Permissions:** `crm.read`, `crm.write`, `crm.manage` (pipelines, rules, settings).
* Background work (assignment, SLA, rotting, reminders, scoring every 10 minutes) runs every minute
  from Celery Beat or the local scheduler. Next for CRM: IndiaMART/JustDial/Meta lead capture,
  WhatsApp, duplicate merge, goals/quotas.

## Phase 8: Hardening (what works)

* **Platform admin** (`/admin`, for users with the platform admin flag, checked against the
  database on every request): platform overview, organizations (search, details, suspend and
  reactivate with a reason, wallet credit, refund or adjustment with idempotency), users (suspend
  signs them out everywhere; you cannot suspend yourself), webhook events (filter, inspect, retry)
  and effective settings that show which providers are configured without revealing secrets. All
  actions are audited. Grant access with `python -m app.cli grant-admin <email>`.
* **Live payments:** Stripe Checkout for USD wallets and Razorpay Payment Links for INR wallets.
  Card details stay on the provider's page. The wallet is credited only from a verified webhook
  (Stripe-Signature with a time window; X-Razorpay-Signature), once per payment, and only when the
  amount and currency match what was requested. Returning from the payment page shows its status.
  In simulation mode, payments are off and test credit is used instead.
* **Monitoring:** `/api/v1/health` checks the database, queue and storage; `/api/v1/metrics` serves
  Prometheus metrics behind a bearer token; optional Sentry reporting without personal data.
* **Deployment:** `docker-compose.prod.yml` (MySQL, Redis, migrate, API, worker, one scheduler,
  nginx frontend) and `docs/DEPLOYMENT.md` (settings, webhook URLs, monitoring, backups, scaling).
  All migrations compile to MySQL DDL and every index fits MySQL's key-size limit; migrations can be
  generated offline for review.

## Phase 7: Billing and analytics (what works)

* **Wallet:** one per organization, in INR for Indian organizations and USD otherwise. The ledger
  is append-only (trial credit, test credit, usage, adjustments) with the running balance on every
  entry; each entry has an idempotency key, so retries never double-charge.
* **Holds:** launching an email, SMS or voice campaign places a hold for its estimated cost and
  fails clearly if the available balance (balance minus holds) cannot cover it. The readiness
  checklist shows "Enough credit" before you send. Holds are released when the campaign ends.
* **Usage:** charged from the channel records (accepted emails, SMS cost per part, voice per
  started minute of connected calls) by a settlement job that charges only the difference since
  last time. Automation steps are charged the same way; when the wallet is empty, people wait on
  the send step instead of skipping it. Usage in another currency is converted at the platform
  rate and the original amount is kept on the entry.
* **Alerts:** owners and admins are notified when the balance drops below an adjustable threshold
  (at most once a day).
* **Billing pages:** organization wallet (balance, available, held, month spend by channel and by
  application, daily usage, prices, full ledger with CSV export) and the same wallet seen from
  one application. In simulation mode, new wallets get a clearly labelled trial credit and owners
  can add test credit; neither is real money.
* **Analytics:** per application, across email, SMS, voice, automation and spend, for 7, 30 or 90
  days or a custom range of up to a year, bucketed by the application's local day. Channel
  trend, a table view, funnels per channel, spend per day, journeys and top campaigns (automation
  steps marked), with CSV export. Chart colours pass the colour-blind palette checks in light and
  dark themes.

## Phase 6: Automation (what works)

* **Builder:** a React Flow canvas with a step palette (click to add after the selected step or
  drag onto the canvas), drag-to-connect, a settings panel per step, autosave, live problem
  badges on steps, a minimap, light and dark themes, and four starters (blank, welcome series,
  win back, A/B test).
* **Triggers:** contact created, added to a list, tag added, or enters a segment. Imports and bulk
  actions count. Triggers are detected by scanning since a per-workflow cursor; enrollment is
  unique per workflow, contact and event, so nobody is enrolled twice. Contacts enter once unless
  re-entry is allowed, and never run the same workflow twice at the same time.
* **Steps:** send email (from a template and verified sender), send SMS (with DLT/10DLC checks),
  voice call (with calling windows and press-9), wait, condition (contact rules, tags and lists, or
  how they responded to an earlier step: delivered, opened, clicked, answered), A/B split, add or
  remove tags and lists, and end. Graphs are data only: no step can run code.
* **Same rules as campaigns:** each send step owns a hidden campaign whose content is frozen at
  publish and sent through the channel's own engine, so consent, suppression, quiet hours, DLT,
  TCPA, tracking and opt-outs behave identically. A step waiting for quiet hours or a retry holds
  the person on that step. Each person receives a step's message at most once.
* **Publishing:** validation checks shape (one trigger, everything connected, no loops, one link
  per output) and settings (references exist, senders verified, channel compliance). Edits change
  a draft; people follow the published version until changes are published. Anyone on a removed
  step leaves with a clear reason. Pause holds people in place; archive ends all journeys.
* **Results:** per-step counts on the canvas (passed, here now, yes/no or A/B split), message
  results per send step, and an enrollments list with each person's step-by-step history and a
  way to remove someone from the journey.

## Phase 5: Voice (what works)

* **Caller IDs:** India 140-series numbers for promotional calls and 160-series numbers for
  service and transactional calls (TRAI), US local and toll-free numbers. Format is validated;
  each number must be confirmed as owned and registered before use, with name and time recorded.
* **Audio library:** MP3 and WAV uploads (checked by content, up to 5 MB and 2 minutes, length
  read on the server, stored through the storage abstraction and served only by signed URLs),
  and text-to-speech messages in English (India and US), Hindi, Tamil, Telugu and Spanish with
  personalisation fields. Messages can be heard in the browser before use.
* **Call script:** an introduction naming the business, the message, and an optional
  "press 9 to stop these calls" prompt (in Hindi or Spanish when the message is). The wizard shows
  the script step by step and plays it.
* **Compliance checks before calling:** confirmed caller ID; DLT entity registration and the
  right number series for the call type (India); business identification and a press-9 opt-out
  for US prerecorded marketing calls (TCPA); valid fields; consent to calls in the caller ID's
  country; provider credentials in live mode.
* **Calling windows:** promotional calls only 09:00–21:00 in India and 08:00–21:00 in the US, in
  each person's time zone, intersected with the application's quiet hours. Calls outside the
  window wait; nothing is dropped.
* **Engine:** recipients materialised once, calls claimed before dialling, never re-dialled when
  the outcome is unknown, eligibility re-checked per attempt, busy and unanswered calls retried
  up to three attempts with a chosen delay, live calls limited per campaign.
* **Outcomes:** answered, voicemail (answering machine), no answer, busy, failed. Pressing 9
  removes consent to calls and suppresses the number at once. Cost per started minute of
  connected calls (₹ for India, $ for the US) with a maximum estimate before starting.
* **Callbacks:** Twilio status callbacks verified with `X-Twilio-Signature`; keypress and script
  URLs bound to one call by signed tokens; Exotel status callbacks with a shared token; a signed
  simulation hook. Stored raw, deduplicated and processed in the background.
* **Reports:** answer rate, voicemail, not reached, opt-outs, talk time, billable minutes, cost,
  an outcomes breakdown, a timeline of finished calls, retries waiting, and a filterable call list.
* **Simulation:** calls go to a local call log at `/dev/calls`. Numbers ending 0000 don't answer,
  2222 are busy, 3333 reach voicemail, 9999 answer and press 9, 1111 are rejected.

## Phase 4: SMS (what works)

* **Registration:** India TRAI DLT Principal Entity (ID, entity name, portal) and US A2P 10DLC
  brand, campaign and optional Twilio Messaging Service. A team member confirms them; the name
  and time are recorded, and changing any ID clears the confirmation.
* **Sender IDs:** Indian headers (6 digits for promotional, 6 letters for service and
  transactional) and US 10DLC numbers, toll-free numbers and short codes, validated by format.
  Each must be confirmed as registered before use. One default sender per application.
* **Templates:** reusable text with the DLT template ID and the exact registered text. A live
  check shows whether the message matches the `{#var#}` pattern.
* **Composer:** live GSM-7 / Unicode detection and segment counter (same rules on the server),
  a one-click fix for curly quotes and dashes that force Unicode, personalisation fields, and a
  phone mock-up preview.
* **Compliance checks before sending:** confirmed sender; DLT registration, matching DLT
  template and header type for the category (India); 10DLC registration and STOP opt-out text
  for promotional texts (US, appended automatically unless the message mentions STOP); valid
  fields; reachable audience in the sender's country; provider credentials in live mode.
  Indian variable values are capped at 30 characters.
* **Quiet hours:** promotional texts inside the quiet window in the recipient's time zone (or the
  application's) are deferred to the end of the window, never dropped. The report shows how many
  are waiting and when they go out.
* **Sending engine:** same guarantees as email: recipients materialised once, claimed before the
  provider call, at-most-once on interruption, eligibility re-checked per message (consent,
  suppression, landline, country), transient errors retried with backoff. Due scheduled and
  deferred campaigns are picked up by Celery Beat or the local scheduler thread.
* **Cost:** per-part prices by country and category (₹ for India, $ for the US), an estimate
  before sending and actual cost from accepted parts afterwards.
* **Provider: Amazon SNS** for both countries. India sends with the DLT header as sender ID plus
  the DLT entity and template IDs; the US sends from a registered origination number (10DLC,
  toll-free or short code). Throttling and 5xx errors are retried; other rejections are final.
* **Receipts and replies:** delivery receipts are read every minute from SNS delivery status logs
  in CloudWatch (success and failure groups). Replies arrive from an SNS topic (two-way SMS in AWS
  End User Messaging) at `/webhooks/sms/sns`, verified by SNS signature. A signed simulation hook
  covers development. All stored raw, deduplicated and processed in the background.
  STOP, UNSUBSCRIBE and similar keywords revoke SMS consent and suppress the number (even for
  unknown numbers); START restores consent only for people who opted out, recording the reply as
  evidence. An "opted out" delivery failure revokes consent; invalid-number failures suppress the number.
* **Reports:** recipients, sent, delivery rate, undelivered and failed, parts and cost, a
  sent/delivered timeline, failure reasons and a filterable recipient list.
* **Simulation:** texts go to a local outbox viewable at `/dev/sms`. Numbers ending 0000 are
  undelivered and 1111 are rejected. Replies can be simulated from the Replies page.

## Phase 3: Email (what works)

* **Senders:** From addresses are confirmed by a link emailed to them before use; default sender;
  free-mail domain warning; SPF, DKIM and DMARC guidance.
* **Content:** drag-and-drop editor (GrapesJS newsletter preset, loaded only on the content
  step), HTML editor with live preview, plain-text editor, four starter layouts, template library.
* **Personalisation:** `{{field}}` and `{{field | default: "x"}}` over contact and custom fields.
  Nothing is evaluated, values are HTML-escaped, unknown fields block sending.
* **Wizard:** Setup → Content → Audience → Review with autosave, inbox preview, personalised
  preview for any contact on desktop or mobile, test sends, and a readiness checklist.
* **Audience:** segments, lists or everyone reachable, with a live estimate and a breakdown of
  who is excluded (no email, unsubscribed, bounced, suppressed, no consent).
* **Compliance:** automatic footer with sender name, postal address and unsubscribe link;
  List-Unsubscribe and one-click (RFC 8058) headers; US apps cannot send without a postal
  address (CAN-SPAM); consent and suppression re-checked for each person at send time.
* **Sending engine:** recipients materialised once (unique per campaign and contact), batched,
  rate-limited for live providers, transient errors retried with exponential backoff, permanent
  errors never retried, interrupted sends never re-sent (no duplicates), pause, resume, cancel,
  schedule in any timezone (Celery Beat, or a local scheduler thread without Docker).
* **Tracking:** signed open pixel, click redirects only to links frozen at launch (no open
  redirect), unsubscribe page and one-click endpoint. Opens are labelled approximate.
* **Webhooks:** SES via SNS with signature and certificate-host verification, Brevo with a shared
  secret, all stored raw, deduplicated and processed asynchronously; events arriving out of order
  never move a bounced or complained message backwards. Hard bounces and complaints suppress the
  address automatically.
* **Reports:** sent (provider accepted) kept separate from delivered; delivery, bounce, open,
  click, click-to-open, unsubscribe and complaint rates with explicit denominators; engagement
  timeline, funnel, top links, exclusions and a filterable recipient list.
* **Simulation:** nothing leaves the machine. Delivery receipts are simulated (addresses
  containing "bounce", "complaint" or "reject" trigger those outcomes); opens and clicks are real
  when messages are viewed in the development mailbox.

## User experience

* **Themes:** light, dark and system, switchable from the top bar, the profile menu, the sign-in
  screens or Shift+D. The choice persists and applies before first paint, so there is no flash.
  All status colours use semantic tokens that adapt to the theme.
* **Navigation:** collapsible sidebar ([ key, remembered per browser) with tooltips and
  shortcut hints. One navigation definition drives the sidebar, palette and shortcuts.
* **Command palette (Ctrl+K):** actions (add contact, import, new segment, invite, new app,
  toggle theme), every page, live contact search by name, email or phone, app and organization
  switching, and recently used commands.
* **Keyboard shortcuts:** G then D/A/C/S/L/I/E/T to jump, / to focus page search, ? for the
  shortcut sheet. Ignored while typing or when a dialog is open.
* **Notification centre:** bell with unread count for import results, teammates joining, role
  changes, access grants and removals. Notifications are per user and disappear if the user
  leaves the organization.
* **Contacts table:** quick-view side panel on row click (Ctrl-click opens the full profile),
  column chooser, comfortable or compact density, both remembered.
* **Forms:** show or hide password, Caps Lock warning, live strength meter matching the server
  policy.
* **Feedback:** top progress bar for in-flight requests, page transitions, skeleton loaders,
  richer empty states, and a friendly error page instead of a crash screen.
* **Accessibility:** skip-to-content link, visible focus rings, labelled icon buttons, reduced
  motion respected.

## Phase 2: what works

**Contacts**
* Create, edit and delete contacts. Phone numbers are validated and stored in E.164 with
  country, type (mobile or landline) and a derived local timezone.
* Duplicate prevention per application by email, phone, or either, chosen in settings and locked
  once contacts exist. Contacts without an email or phone never collide.
* Search, sort, filters (status, reachability, tag, list, country), pagination and bulk tag,
  list, delete and export, including "select all matching".
* Contact profile with Overview (reachability per channel and why), Activity, Campaign history
  (empty until campaigns exist), Attributes and Consent history tabs.

**Consent and suppression**
* Consent is never assumed. Granting it needs a source, and US SMS or voice needs written evidence.
* Unsubscribing records the withdrawal and adds a hash-based suppression entry. That entry
  outlives contact deletion, so erased-then-re-imported people stay blocked.
* Imports never re-subscribe anyone. Only an explicit, recorded re-opt-in lifts an unsubscribe.
* Manual suppression list with lookup. Unsubscribe and complaint entries cannot be removed by hand.

**Import wizard (CSV and XLSX)**
* Six steps: upload, column mapping with auto-suggestions, full-file validation, configuration,
  background processing with live progress, and a downloadable report of rows not imported.
* Handles spreadsheet numeric phones, BOMs, semicolon CSVs and Windows-1252 files.
* Restart-safe: each source row is recorded once, so a crashed or redelivered job resumes
  without duplicates. A test simulates a worker crash mid-import to prove it.
* 5,000 rows import in about 5 seconds.

**Segments, lists, tags, custom fields**
* Visual builder with nested AND/OR groups, 15 operators, custom fields, tags, lists and
  channel reachability. Live preview count, reachable counts and sample.
* Rules are validated JSON compiled to parameterised SQLAlchemy. Unknown fields, wrong
  operators and foreign tag ids are rejected.
* Static lists with membership management. Tags with colours and counts.
* Typed custom fields: text, number, date, yes/no and select. Deleting one that a segment uses is blocked.

**Dashboard and overview**
* KPI cards, a 30-day growth chart with a table view, channel reachability, country mix and
  recent imports, all from database records.

**Security and isolation**
* Every audience route resolves the application context. Tests confirm another organization
  gets 404 on contacts, exports, segments, tags, imports and overview, and another
  application in the same organization sees nothing.
* Export needs the `audience.export` permission, is audited, and neutralises spreadsheet formula injection.
* Raw values of failed import rows are cleared after 30 days by a scheduled job.

## Known gaps

* **MySQL only.** SQLite support was removed. Development and the test suite run on MariaDB 10.4
  (XAMPP); production targets MySQL 8. All migrations upgrade and downgrade cleanly on MariaDB.
  Docker and Celery with Redis have not been run yet; development uses local background threads.
* Flag emoji render as letters (IN, US) on Windows.
* End-to-end tests still run one browser at a time (`workers: 1`); this can be raised now that
  SQLite is gone.
* Contact "last activity" stays empty until campaigns record engagement.
* Notifications, platform admin and the Brevo/SES live checks are still outstanding from Phase 1.
* The Amazon SNS SMS adapter follows AWS's documented API but has not been run against a live
  account. Live use needs: SNS SMS out of the sandbox, a registered DLT entity, headers and templates
  (India), a registered origination number (US), delivery status logging enabled in SNS, and an
  SNS topic for two-way SMS subscribed to `/api/v1/webhooks/sms/sns`.
* SMS prices are platform configuration (`SMS_PRICING`); per-organization pricing and wallet
  deductions arrive with billing in Phase 7.
* Toll-free verification and short-code approval are recorded only through the sender
  confirmation, not tracked as separate statuses.
* The Twilio and Exotel voice adapters have not been run against the live services. Exotel plays
  content through a call flow configured in its dashboard (`EXOTEL_APP_ID`) that fetches our
  per-call script URL; confirm this set-up with your Exotel account.
* Telnyx is supported as a voice provider through its TeXML API (set `TELNYX_API_KEY`,
  `TELNYX_ACCOUNT_SID`, `TELNYX_TEXML_APP_ID` and, for signed callbacks, `TELNYX_PUBLIC_KEY`).
  Numbers already on the Telnyx account can be picked when adding a caller ID. It has been tested
  with mocked requests and signatures, not yet against the live service.
* Stripe and Razorpay are integrated but untested against the live services; use their test keys
  first. Prices and the conversion rate are
  platform settings (`EMAIL_PRICING`, `SMS_PRICING`, `VOICE_PRICING`, `FX_RATES`).
* Analytics uses the time zone's current UTC offset for day boundaries, so days spanning a US
  daylight-saving change are off by an hour.
* Automation segment triggers re-evaluate the segment on every scan (up to 5,000 contacts per
  scan); very large segments will need incremental membership tracking.
* Text-to-speech is spoken by the provider at call time; the in-app preview uses the browser's
  voice, which sounds different.
* National Do Not Call registry checks (US DNC, India NCPR/DND) are not automated; consent records
  are the gate today.

## Next steps

1. Run `docker-compose.prod.yml` on a staging server with MySQL and Redis, and repeat the
   end-to-end suite against it.
2. Connect real provider accounts one at a time in test mode (Brevo or SES, Amazon SNS, Twilio, Telnyx,
   Stripe, Razorpay), then switch `COMMUNICATION_MODE=live`.
3. National Do Not Call checks (US DNC, India DND/NCPR), incremental segment membership for very
   large segments, and daylight-saving-aware analytics.
