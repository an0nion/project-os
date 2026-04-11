-- Google Calendar OAuth token storage (single-user, keyed as 'bot').

create table if not exists calendar_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null unique,
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_calendar_tokens_updated
  before update on calendar_tokens
  for each row execute function update_timestamp();

alter table calendar_tokens disable row level security;
