-- Persistent key-value counters for the bot (e.g. Gemini daily quota).

create table if not exists bot_counters (
  key        text primary key,
  value      bigint not null default 0,
  meta       jsonb,
  updated_at timestamptz not null default now()
);

alter table bot_counters disable row level security;
