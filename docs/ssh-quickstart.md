# SSH & Deployment Quickstart

## VM Details

| Field    | Value                             |
|----------|-----------------------------------|
| Host     | `168.138.8.232` (Oracle Cloud, ap-melbourne-1) |
| User     | `ubuntu`                          |
| SSH Key  | `~/.ssh/oracle-bot` (in Cloud Shell) |
| App dir  | `~/project-os`                    |
| Process  | `project-os-bot` (PM2, id 0)     |

---

## Connect

**From Oracle Cloud Shell** (browser — go to cloud.oracle.com → Cloud Shell icon):

```bash
ssh -i ~/.ssh/oracle-bot ubuntu@168.138.8.232
```

**From local Windows machine** (PowerShell or WSL):

```bash
ssh -i C:/Users/valky/.ssh/oracle-bot ubuntu@168.138.8.232
```

> If you get `Permission denied (publickey)`, check `ls ~/.ssh/` — the key may be named differently.
> Oracle Linux instances use `opc` instead of `ubuntu`.

---

## Deploy after a git push

Run this single command once connected:

```bash
cd ~/project-os && git pull && pm2 restart project-os-bot && pm2 logs project-os-bot --lines 30
```

Expected tail of logs:

```
✅ Project OS bot running
[INFO]  socket-mode:SocketModeClient:0 Now connected to Slack
```

If you see repeated `Reconnecting to Slack...` without `Now connected`, the `SLACK_APP_TOKEN` or `SLACK_BOT_TOKEN` env var is wrong or expired.

---

## PM2 cheatsheet

```bash
pm2 list                              # show all processes + status
pm2 restart project-os-bot           # restart (picks up code changes)
pm2 stop    project-os-bot           # stop without removing
pm2 logs    project-os-bot --lines 50 # tail live logs
pm2 logs    project-os-bot --err      # errors only
pm2 monit                             # live CPU/mem dashboard (q to quit)
pm2 save                              # persist process list across reboots
pm2 startup                           # print command to auto-start PM2 on boot
```

---

## Environment variables

The `.env` file lives at `~/project-os/.env`. Edit with:

```bash
nano ~/project-os/.env
```

After changing env vars, restart the bot:

```bash
pm2 restart project-os-bot --update-env
```

Required vars for the bot to start:

| Variable               | Source                              |
|------------------------|-------------------------------------|
| `SLACK_BOT_TOKEN`      | Slack app → OAuth & Permissions     |
| `SLACK_APP_TOKEN`      | Slack app → App-Level Tokens (Socket Mode) |
| `SLACK_USER_ID`        | Your Slack user ID (Uxxxxxxxx)      |
| `APP_URL`              | Vercel deployment URL               |
| `APP_SECRET`           | Shared secret (must match Vercel)   |
| `ANTHROPIC_API_KEY`    | console.anthropic.com               |
| `GOOGLE_AI_API_KEY`    | aistudio.google.com                 |
| `DEEPSEEK_API_KEY`     | platform.deepseek.com               |
| `TAVILY_API_KEY`       | app.tavily.com                      |
| `CALENDAR_ENABLED`     | `true` once OAuth connected         |

---

## Logs location

```
~/.pm2/logs/project-os-bot-out.log    # stdout (normal activity)
~/.pm2/logs/project-os-bot-error.log  # stderr (errors, warnings)
```

Tail both live:

```bash
pm2 logs project-os-bot
```

---

## What needs manual action vs auto-deploy

| Change type                              | Action required           |
|------------------------------------------|---------------------------|
| Next.js API routes (`app/api/`)          | Auto-deploys on git push  |
| Vercel env vars                          | Set in Vercel dashboard   |
| Slack bot code (`slack/bot.js`)          | SSH → `git pull && pm2 restart project-os-bot` |
| New lib files imported by bot.js         | SSH → `git pull && pm2 restart project-os-bot` |
| Supabase schema (new table/column)       | Run DDL in Supabase SQL editor |
| `.env` changes on VM                    | SSH → edit `.env` → `pm2 restart --update-env` |

---

## Supabase schema changes

Open [Supabase SQL editor](https://supabase.com/dashboard) → your project → SQL editor.

Run the statements from `scripts/schema.sql`. All `CREATE TABLE IF NOT EXISTS` blocks are safe to re-run.

The `calendar_tokens` table (required for calendar OAuth):

```sql
create table if not exists calendar_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null unique,
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```

---

## Troubleshooting

**Bot isn't responding in Slack:**
```bash
pm2 list                        # check status is "online"
pm2 logs project-os-bot --lines 20  # look for connection errors
```

**`git pull` fails (conflict):**
```bash
git stash && git pull && git stash pop
```

**Bot crashes immediately after restart:**
```bash
pm2 logs project-os-bot --err --lines 50
# Common causes: syntax error in bot.js, missing env var, missing npm package
```

**New npm package not installed:**
```bash
cd ~/project-os && npm install
pm2 restart project-os-bot
```

**SLACK_APP_TOKEN expired (Socket Mode disconnects in a loop):**
- Go to api.slack.com → your app → App-Level Tokens
- Regenerate the `xapp-...` token
- Update `~/project-os/.env`
- `pm2 restart project-os-bot --update-env`
