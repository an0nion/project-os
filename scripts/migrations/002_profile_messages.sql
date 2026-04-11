-- Project-level chat messages and user profile.

create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  project_key text not null,
  role        text not null check (role in ('user', 'assistant', 'system')),
  content     text not null,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_messages_project on messages(project_key, created_at);

create table if not exists profile (
  id         uuid primary key default gen_random_uuid(),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into profile (data) values ('{}') on conflict do nothing;

alter table messages disable row level security;
alter table profile  disable row level security;
