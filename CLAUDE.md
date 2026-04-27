# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**project-os / AIOS** — a personal AI productivity OS. A Next.js 14 web app (deployed on Vercel) plus a long-running Slack DM bot (deployed separately on a VM via Fly.io), backed by Supabase Postgres. Acts as a single inbox that AI-classifies messages into "projects" (school, work, learning_tech, baking, etc.), extracts deadlines, drafts application answers, and pushes nudges via Slack / Web Push / Telegram. Codebase is ESM JavaScript only — no TypeScript.

## In-flight refactor (10 PRs)

A critical-architecture refactor is mid-merge. Until those PRs land, the codebase state is split between `main` (current) and 10 feature branches. See `docs/MERGE_RUNBOOK.md` for the merge order, per-PR status, conflict map, and rebase guidance.

New modules being introduced (will exist on `main` after the relevant PR lands):

- `lib/providers/{anthropic,google,deepseek}.js` + `lib/circuitBreaker.js` (Unit 4)
- `lib/costLog.js` (Unit 5; replaces `lib/costTracker.js` + `lib/vmCostLogger.js`, which become re-export shims)
- `lib/botHelpers.js`, `lib/botIntents.js`, `lib/botModes/{reminder,learning,correction}.js` (Unit 1a — extracts `slack/bot.js` from 1.2k LOC monolith)
- `lib/auth.js` + `app/api/logout/` + `session_tokens` table (Unit 3 — replaces "session cookie literally is APP_SECRET" pattern)
- `lib/errors.js`, `lib/apiResponse.js`, `lib/schemas.js`, `lib/log.js` + zod adoption across ~25 routes (Unit 2)
- `app/api/cron/_handlers/` + `app/api/cron/run/[name]/` (Unit 6 — splits the bundled daily cron)
- `lib/supabaseQuery.js` + `deleted_at` columns (Unit 7 — soft-delete; RLS policies are permissive prep, not a security change today)
- New tables: `dedup_log` (1b), `session_tokens` (3); column adds: `items.calendar_event_id` (1c), `deleted_at` on five tables (7)

When working on this repo during the merge phase: always check whether the area you're touching has an in-flight PR before making changes — see the conflict map in `docs/MERGE_RUNBOOK.md`. This whole "In-flight refactor" section is removable once all 10 PRs land.

## Commands

```bash
npm run dev        # Next.js dev server (port 3000)
npm run build      # Next.js production build
npm run start      # Next.js production server
npm run slack      # Run the Slack Socket Mode bot (long-running; meant for the VM)
npm run migrate    # Apply pending SQL migrations to Supabase (needs SUPABASE_DB_URL)
npm run vapid      # Generate Web Push VAPID keys
npm run icons      # Generate PWA icons
```

Tests use the Node built-in test runner (no Jest/Vitest):

```bash
node --test tests/                      # all tests
node --test tests/bot-flow.test.mjs     # single file
node --test --test-name-pattern='<name>' tests/bot-flow.test.mjs   # single test
```

There is no lint script defined despite `eslint` being a devDependency — running `npx next lint` works.

## Architecture

### Two deployment targets, one repo

- **Vercel** runs the Next.js app (`app/`) — UI, API routes under `app/api/`, and a single daily cron at `/api/cron/daily` (Hobby plan = 1 cron slot, so the daily job bundles deadline nudges + cost digest + morning briefing). `vercel.json` extends `maxDuration` to 60s for `/api/scrape` and `/api/chat`.
- **Fly.io VM** runs the Slack bot (`slack/bot.js`, `npm run slack`) in Socket Mode. Deployed via `.github/workflows/fly-deploy.yml` on push to `main`. The bot needs to be a separate process because Socket Mode requires a persistent WebSocket — it can't run on serverless.

The two halves talk through Supabase (shared DB) and via internal HTTPS calls (e.g. `lib/vmCostLogger.js` → `/api/costs` to log spend from the VM into the same Postgres the dashboard reads).

### The tier-routed multi-model AI layer

This is the central design. Every AI call goes through it. See `dev_task.md` for the full memo.

- **`lib/models.js`** — registry of models with cost, context window, tier, provider.
- **`lib/multiModelClient.js`** — `callModel(modelKey, params)` and `callModelWithFallback(primary, fallback, params)`. Unifies Google Gemini, DeepSeek, and Anthropic behind one interface (no aggregator/OpenRouter — direct API calls). Anthropic calls use prompt caching.
- **`lib/tierClassifier.js`** — pure regex classifier, zero AI calls. Returns `{ tier, primaryModel, fallbackModel, maxTokens, reason }` for a message + context. Tiers:
  - **0** = code-only (toggle, list, calendar). No AI.
  - **1** = Gemini Flash free tier → DeepSeek fallback. Routing, classification, short commands.
  - **2** = DeepSeek primary → Sonnet fallback. Default workhorse.
  - **3** = Opus primary → Sonnet fallback. Sticky once entered. Triggered by explicit escalation, deep-research topics, or pushback after 2+ messages.
- **`lib/router.js`** — message → project classifier. Three-pass: (0) document heuristic for long pasted academic text → `school`, (1) keyword match against `lib/projects.js`, (2) Gemini Flash with DeepSeek fallback. Cost is logged via `lib/costTracker.js`.
- **`lib/geminiQuota.js`** — tracks the 1000 req/day Gemini free tier; the fallback chain consults this.
- **`lib/costTracker.js`** + `lib/vmCostLogger.js`** — every model call logs to `cost_log` (Supabase). `app/costs/` is the dashboard.

When adding any new AI feature: classify the call's tier first, route through `callModelWithFallback`, and log cost. Don't introduce ad-hoc `fetch` calls to provider APIs.

### Projects as a first-class concept

`lib/projects.js` is the **single source of truth** for projects (key, label, keywords, description, system_prompt). The router prompt, the keyword pre-pass, the dashboard tiles, the chat system prompt, and the Slack bot's intent classifier all read from this list. Project keys are persisted in the DB — never rename a `key` once it ships; only add new ones.

### Slack bot (`slack/bot.js`, ~1.2k LOC)

Single-file because Bolt has heavy side effects on import (the test suite duplicates pure helpers rather than importing them — see the comment at the top of `tests/bot-flow.test.mjs`; if refactoring, extract into `lib/botHelpers.js`). Key behaviours:

- AI-only intent classification per fresh message (no keyword shortcuts at the bot layer).
- `lib/deduplicator.js` prevents repeated processing of the same Slack event.
- `lib/pendingStore.js` holds deferred items (e.g. waiting on a clarifying reply).
- `lib/conversationManager.js` compresses history before AI calls.
- Timeline parsing uses DeepSeek with `chrono-node` fallback; timezone is hardcoded `Australia/Melbourne`.
- Calendar integration is gated by `CALENDAR_ENABLED=true` env var; off by default.

### Database & migrations

Supabase (Postgres). Migrations live in `scripts/migrations/NNN_description.sql` and are applied by `scripts/migrate.js`, which tracks applied versions in `schema_migrations` (idempotent — safe to re-run). Migrations run sequentially and stop on first failure. New schema changes: add a new numbered file, never edit applied ones. `lib/supabase.js` exposes `supabaseAdmin()` (service-role, server-side only) and the anon client.

### Scraper (`scraper/`)

Used to extract questions from application/fellowship URLs. Strategy chain in `scraper/strategies/`: `cacheFetch` → `directFetch` → `playwrightFetch` (uses `@sparticuz/chromium` so it can run on Vercel) → `aiExtract` (LLM falls back to extracting from page text). `parser/questionParser.js` then structures the result.

## Conventions

- ESM only (`"type": "module"`). Use `import`, not `require`. Test files use `.mjs`.
- All AI calls go through `lib/multiModelClient.js`. Don't hit provider APIs directly.
- All cost-incurring calls log via `logCost` (web) or `logCostViaApi` (VM/bot).
- Project keys in `lib/projects.js` are immutable identifiers; don't rename.
- `dev_task.md` and `project.md` are the long-form design memos — consult them before changing the model-routing or cost-tracking layers.

## Environment

`.env.example` is the canonical list. Web app needs Anthropic / Google AI / DeepSeek / Supabase / VAPID / Google Calendar OAuth keys. The Slack bot additionally needs `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_USER_ID`, and `TAVILY_API_KEY` for web search. `SUPABASE_DB_URL` is only needed locally for `npm run migrate`.
