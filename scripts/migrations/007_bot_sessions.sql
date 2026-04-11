-- Slack bot pending conversation state (survives PM2 restarts).
-- The state column holds the same object that was previously in the in-memory Map.

create table if not exists bot_sessions (
  user_id    text primary key,
  state      jsonb not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists idx_bot_sessions_expires on bot_sessions(expires_at);

alter table bot_sessions disable row level security;
