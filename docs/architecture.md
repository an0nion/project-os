# Architecture

## Vercel ↔ Fly contract

The AIOS deployment is split across two hosts. Each side owns a different runtime
shape and they communicate through a small, explicit contract.

### Responsibilities

- **Vercel**
  - Hosts the Next.js app (`app/`).
  - Runs the Vercel cron entry point at `/api/cron/daily` (Hobby plan: 1 slot,
    fanned out into per-handler modules under `app/api/cron/_handlers/`).
  - Hosts the dashboards (cost dashboard, project pages, etc.) and HTTP APIs
    (`/api/cost-log`, `/api/batch/submit`, `/api/cron/run/[name]`, etc.).
  - Stateless — every request reads/writes Supabase.

- **Fly.io**
  - Hosts the long-running Slack bot process (`slack/bot.js` invoked via
    `npm run slack`). It maintains the websocket connection to Slack and
    handles real-time events that don't fit a serverless model.

### Communication channels

1. **Shared Supabase database (both directions, source of truth).**
   Both Vercel and Fly read/write the same Postgres tables. Anything one side
   needs the other to "know" goes through Supabase, not direct calls.

2. **Fly bot → Vercel HTTP (one direction only).**
   The Slack bot calls Vercel HTTP endpoints for two things:
   - **Cost log:** every model call is POSTed to `/api/cost-log` for
     centralised aggregation (best-effort — see retry semantics below).
   - **Batch submit:** the bot can POST async batch drafts to
     `/api/batch/submit` for deferred processing.

3. **Vercel → Fly bot: not used.**
   There is no Vercel → bot channel. If Vercel needs to nudge the user, it
   talks to Slack directly via `chat.postMessage` (using `SLACK_BOT_TOKEN`),
   not via the bot process.

### What fails when each side is down

- **Vercel down:**
  - Daily cron does not run (deadline nudges, cost digest, morning briefing,
    dedup-cleanup, calendar-backfill all skipped for that day).
  - Dashboards unreachable.
  - Bot keeps running and serving Slack events; cost-log POSTs from the bot
    fail silently (see retry semantics) — bot does not crash.
  - Batch submit endpoint unreachable; bot drops the batch (best-effort).

- **Fly down:**
  - Slack bot is offline; users get no Slack-side AI replies.
  - Vercel cron still runs and can still DM the user via Slack Web API
    (`chat.postMessage` direct from cron handlers).
  - Supabase data is unaffected; bot resumes normally on restart.

- **Supabase down:**
  - Both sides degrade. Cron handlers return per-step errors via
    `Promise.allSettled` (one DB failure does not abort the rest of the job).
  - Bot writes/reads fail; user sees error responses in Slack.

### Retry semantics

- **Cost log (bot → Vercel):** best-effort fire-and-forget. If the POST
  fails, the bot logs a warning and continues. No automatic retry on the
  bot side — losing a cost-log row is acceptable; corrupting bot state is
  not.
- **Batch submit (bot → Vercel):** same best-effort semantics.
- **Daily cron handlers:** wrapped individually in `Promise.allSettled` by
  the coordinator. A failed handler does not block others, and its error
  message is included in the response + logged. For manual retry of a
  single handler, POST to `/api/cron/run/[name]` with the bearer
  `CRON_SECRET`.
- **No queue, no dead-letter.** With ~3 daily users and best-effort
  semantics, an idempotent retry endpoint is the simplest sufficient
  recovery mechanism.
