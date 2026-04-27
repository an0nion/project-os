# AIOS Refactor — Merge Runbook

This runbook walks through landing the 10-unit critical-architecture refactor in the recommended order. Read top-to-bottom; merge PRs sequentially. Each unit is a single PR.

## Recommended merge order

```
0  →  4  →  5  →  1a  →  1b  →  1c  →  3  →  2  →  6  →  7
```

The `chore/refactor-docs` PR (this file + the in-flight section in `CLAUDE.md`) can land at any point — it's documentation only.

## Conflict map

Files touched by multiple units. When landing a later unit, expect to rebase against any earlier-landed unit listed:

| File | Units that touch it |
|------|---------------------|
| `slack/bot.js` | 1a (large refactor), 1b (small dedup wiring), 1c (calendar handler), 5 (cost-log callsites) |
| `app/api/inbox/route.js` | 1c (return id), 2 (validation), 7 (soft-delete filter) |
| `app/api/cron/daily/route.js` | 5 (cost-digest call), 6 (split into handlers) |
| `app/api/items/**`, `app/api/applications/**`, `app/api/projects/**` | 2 (validation), 7 (soft-delete) |
| `lib/multiModelClient.js` | 4 only (clean) |
| `middleware.js`, `app/api/login/route.js` | 3 only (clean) |

## Per-PR sections

For each PR: status, file scope, pre-merge checklist, rebase notes.

### Unit 0 — PR CI + lint script

- **Branch**: `worktree-agent-abf65c9fb3276cc14`
- **Status**: Verified (build skipped for env reason; lint + tests pass)
- **Scope**: `.github/workflows/ci.yml`, `package.json` (lint script), `.eslintrc.json`
- **Pre-merge**:
  - [ ] Add Supabase + secret env vars as GitHub Actions secrets so the CI build step succeeds (without these, the build fails at page-data collection)
  - [ ] Confirm `node --test "tests/**/*.test.mjs"` discovery works on the runner Node version
- **Rebase**: none (lands first)

### Unit 4 — Provider abstraction + quota race fix + circuit breaker

- **Branch**: `worktree-agent-a00744983e8f730b9`
- **Status**: WIP — agent rate-limited pre-verification. Migration renumbered 009 → 014 manually after push.
- **Scope**: `lib/providers/{anthropic,google,deepseek}.js`, `lib/circuitBreaker.js`, `lib/multiModelClient.js` (refactored), `lib/geminiQuota.js` (race fix), `app/api/counters/route.js` (atomic increment), migration `014_bot_counters_increment_rpc.sql`, tests for providers + breaker.
- **Pre-merge**:
  - [ ] `npm run build`
  - [ ] `node --test tests/`
  - [ ] `Skill: simplify`
  - [ ] Confirm circuit breaker scope caveat is in PR description (in-memory; cosmetic on Vercel serverless)
  - [ ] Migration syntax: `psql --set ON_ERROR_STOP=1 -f scripts/migrations/014_*.sql` against a scratch DB
- **Rebase**: against Unit 0 only

### Unit 5 — Unified cost logger

- **Branch**: `worktree-agent-a7d7988239088b794`
- **Status**: WIP — agent rate-limited. Worktree had cross-contamination with Unit 4 files; only Unit 5 files committed.
- **Scope**: `lib/costLog.js`, shims for `lib/costTracker.js` + `lib/vmCostLogger.js`, caller updates in `lib/router.js`, `slack/bot.js`, `app/api/chat/route.js`, `app/api/inbox/route.js`, `tests/costLog.test.mjs`
- **Pre-merge**:
  - [ ] `npm run build`
  - [ ] `node --test tests/`
  - [ ] `Skill: simplify`
  - [ ] Verify cost-log calls never throw on failure (best-effort invariant)
  - [ ] Confirm depend-on-Unit-3 fallback is in place (`COST_LOG_SECRET || APP_SECRET`)
- **Rebase**: against Unit 4 (touches `lib/multiModelClient.js`-adjacent code; minor)

### Unit 1a — Bot.js modular refactor

- **Branch**: `worktree-agent-adda4a10da693b0b1`
- **Status**: WIP — agent stalled (watchdog killed)
- **Scope**: `lib/botHelpers.js`, `lib/botIntents.js`, `lib/botModes/{reminder,learning,correction}.js`, `slack/bot.js` (slimmed), `tests/bot-flow.test.mjs` (de-duplicated), `tests/botHelpers.test.mjs`
- **Pre-merge**:
  - [ ] `npm run build`
  - [ ] `node --test tests/` — all 1290+ existing tests must still pass
  - [ ] `node -e "import('./slack/bot.js')"` static smoke (must not throw)
  - [ ] `Skill: simplify`
  - [ ] Confirm top-level error boundary is in `slack/bot.js` and clears `pending` state on error
  - [ ] `grep -n 'function buildSuccessMessage' tests/bot-flow.test.mjs` returns nothing
- **Rebase**: against Unit 5 (callsites in `slack/bot.js`)

### Unit 1b — Persistent deduplicator

- **Branch**: `worktree-agent-afe631e88e7df8b60`
- **Status**: Verified (1292/1292 tests, build skipped for env reason)
- **Scope**: `scripts/migrations/009_dedup_log.sql`, `lib/deduplicator.js` (DB-backed), `slack/bot.js` (one integration line), `tests/deduplicator.test.mjs`
- **Pre-merge**:
  - [ ] Run migration: `npm run migrate`
  - [ ] CI green (now possible with Unit 0 landed)
- **Rebase**: against Unit 1a (`slack/bot.js` integration line will move)

### Unit 1c — Transactional calendar + inbox flow

- **Branch**: `worktree-agent-a0826b1106b831498`
- **Status**: Verified (1291 tests pass, build skipped for env)
- **Scope**: `scripts/migrations/013_inbox_calendar_link.sql` (targets `items` table), `slack/bot.js` (`saveReminderTransactional` helper), `app/api/inbox/route.js` (returns id), `app/api/calendar/event/route.js` (accepts `inbox_id`), `tests/calendarFlow.test.mjs`
- **Pre-merge**:
  - [ ] Run migration
  - [ ] CI green
- **Rebase**: against Unit 1a (`slack/bot.js`) and Unit 1b (`slack/bot.js` dedup wiring)

### Unit 3 — Auth rework + session tokens

- **Branch**: `worktree-agent-a2ca345332d61deac`
- **Status**: WIP — agent rate-limited
- **Scope**: `scripts/migrations/010_session_tokens.sql`, `lib/auth.js`, `app/api/logout/route.js`, `middleware.js`, `app/api/login/route.js`, `app/api/sessions/route.js`, `app/api/costs/log/route.js` (uses new `COST_LOG_SECRET`), `.env.example` (adds `COST_LOG_SECRET`), `tests/auth.test.mjs`
- **Pre-merge**:
  - [ ] `npm run build`
  - [ ] `node --test tests/`
  - [ ] `Skill: simplify`
  - [ ] Run migration
  - [ ] Set `COST_LOG_SECRET` in production env (Vercel + Fly)
  - [ ] **Communicate**: existing logged-in users will be force-logged-out on deploy (acceptable for personal tool)
  - [ ] Curl smoke: `/api/login` → cookie value is hex string, NOT `APP_SECRET`; `/api/logout` deletes session row
- **Rebase**: minor — only `app/api/costs/log/route.js` overlaps with Unit 5

### Unit 2 — API foundation: errors + responses + schemas + structured logging + adoption

- **Branch**: `worktree-agent-a8295829d6b7cc080`
- **Status**: WIP — agent rate-limited. Largest single PR (~25 routes adopted)
- **Scope**: `lib/errors.js`, `lib/apiResponse.js`, `lib/schemas.js`, `lib/log.js`, `package.json` (zod), every `app/api/*/route.js` except `login` (Unit 3) and `cron/daily` (Unit 6)
- **Pre-merge**:
  - [ ] `npm install` (zod added)
  - [ ] `npm run build`
  - [ ] `node --test tests/`
  - [ ] `Skill: simplify`
  - [ ] Curl smoke: at least 3 routes — happy path returns `{ ok: true, data }`; bad input returns `{ ok: false, error: { code, message } }`
  - [ ] **Frontend impact check**: any client code reading `result.foo` directly (rather than `result.data.foo`) will break. Audit `app/page.jsx`, `app/project/[key]/`, `app/costs/`, `app/login/`, `app/test/`.
- **Rebase** (significant): Unit 1c (inbox route), Unit 3 (some routes that no longer exist on this branch), Unit 6 (cron/daily — out of scope but neighboring routes)

### Unit 6 — Cron split + observability

- **Branch**: `worktree-agent-a929647fac66bc782`
- **Status**: WIP — agent rate-limited
- **Scope**: `app/api/cron/_handlers/{deadline-nudges,cost-digest,morning-briefing,dedup-cleanup,calendar-backfill}.js`, `app/api/cron/run/[name]/route.js`, `app/api/cron/daily/route.js` (coordinator), `vercel.json` (unchanged or minor), `docs/architecture.md` (new), `tests/cronCoordinator.test.mjs`
- **Pre-merge**:
  - [ ] `npm run build`
  - [ ] `node --test tests/`
  - [ ] `Skill: simplify`
  - [ ] Curl: `/api/cron/daily` with `Authorization: Bearer $CRON_SECRET` returns `{ ok, results: { ... } }`; without auth returns 401
  - [ ] Optional admin endpoint `/api/cron/run/deadline-nudges` runs only that handler
  - [ ] If a handler stub is empty (Unit 1b's dedup-cleanup, Unit 1c's calendar-backfill), confirm it returns `{ summary: 'noop' }` not a crash
- **Rebase**: against Unit 5 (cost-digest calls into `lib/costLog.js`); maybe Unit 2 (cron/daily)

### Unit 7 — Soft-delete + audit-trail (with RLS prep)

- **Branch**: `worktree-agent-a2fb39c7e4ce08690`
- **Status**: WIP — agent rate-limited
- **Scope**: `scripts/migrations/011_soft_delete.sql`, `scripts/migrations/012_rls_policies.sql`, `lib/supabaseQuery.js`, several read routes filter `deleted_at IS NULL`, `tests/supabaseQuery.test.mjs`
- **Pre-merge**:
  - [ ] `npm run build`
  - [ ] `node --test tests/`
  - [ ] `Skill: simplify`
  - [ ] Run migrations 011 + 012 in that order
  - [ ] Verify trigger: insert app + child question, soft-delete the parent, verify the trigger propagates `deleted_at` to children
  - [ ] **Honest framing in PR**: this adds audit trail + soft-delete. RLS is structural prep only — `USING (true)` policies do not improve security today
- **Rebase** (significant): Unit 2 (read routes overlap heavily — same `app/api/items/**`, `app/api/applications/**`, etc.)

## Known issues addressed pre-merge

- ✓ Unit 4 migration `009_bot_counters_increment_rpc.sql` was renamed to `014_bot_counters_increment_rpc.sql` (Phase 1 of the reconciliation plan; force-with-leased to the WIP branch).
- ✓ Unit 5 worktree had untracked Unit 4 files (cross-contamination from worktree concurrency); only Unit 5 files were committed to the Unit 5 branch.
- ✓ Unit 7 migration tables were verified to use real names (`items`, `applications`, `questions`, `inbox_log`, `base_answers`).

## Outstanding pre-merge work the agents did NOT complete

7 of 10 WIP branches did not run:
- `npm run build`
- `node --test tests/`
- `Skill: simplify` review pass

These need to happen before each PR is merged. Either run them locally during review, or — when usage budget allows — dispatch an agent against each WIP branch to finish verification + simplify.

## Merge mechanics

For each PR (in order):

```bash
gh pr checkout <PR#>
git rebase main                       # if previous PRs landed
# resolve conflicts using the conflict map above
npm install                           # only if package.json changed (Unit 2: zod)
npm run build
node --test tests/
npm run migrate                       # if migration touched
git push --force-with-lease           # only if rebase changed history
gh pr merge <PR#> --squash --delete-branch
```

After all 10 unit PRs land:
1. Remove the "In-flight refactor" section from `CLAUDE.md`
2. Delete `docs/MERGE_RUNBOOK.md` (or move to `docs/archive/`)
3. Run `git worktree prune` to clean up local worktree dirs
4. Update `dev_task.md` to V5 reflecting the new architecture
