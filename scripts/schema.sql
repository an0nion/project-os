-- ============================================================
-- Project OS — Supabase PostgreSQL schema
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- ── Applications ────────────────────────────────────────────
create table if not exists applications (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  org          text not null default '',
  url          text,
  deadline     timestamptz,
  status       text not null default 'backlog'
                 check (status in ('backlog', 'drafting', 'review', 'submitted')),
  project_key  text not null default 'research_apps',
  scrape_method text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── Questions (per application) ─────────────────────────────
create table if not exists questions (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  text           text not null,
  category       text not null default 'other',
  answer         text not null default '',
  status         text not null default 'pending'
                   check (status in ('pending', 'drafted', 'reviewed', 'final')),
  base_answer_id uuid,               -- FK added below after base_answers table
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── Base answers (shared templates reused across applications) ──
create table if not exists base_answers (
  id         uuid primary key default gen_random_uuid(),
  category   text not null unique,
  content    text not null,
  version    int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Add FK from questions to base_answers
alter table questions
  add constraint fk_questions_base_answer
  foreign key (base_answer_id) references base_answers(id) on delete set null;

-- ── Chat message history ─────────────────────────────────────
create table if not exists chat_messages (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  question_id    uuid references questions(id)    on delete cascade,
  role           text not null check (role in ('user', 'assistant', 'system')),
  content        text not null,
  created_at     timestamptz not null default now()
);

-- ── Web Push subscriptions ───────────────────────────────────
create table if not exists push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  endpoint     text not null unique,
  subscription jsonb not null,
  created_at   timestamptz not null default now()
);

-- ── Inbox log (audit trail for all captured items) ───────────
create table if not exists inbox_log (
  id         uuid primary key default gen_random_uuid(),
  source     text not null default 'unknown',  -- 'slack' | 'web' | 'pwa' | 'bookmarklet'
  url        text,
  text       text,
  project    text not null,
  summary    text,
  created_at timestamptz not null default now()
);

create index if not exists idx_inbox_log_created on inbox_log(created_at desc);

-- ── Indexes ──────────────────────────────────────────────────
create index if not exists idx_apps_project_deadline   on applications(project_key, deadline);
create index if not exists idx_apps_status             on applications(status);
create index if not exists idx_questions_app           on questions(application_id);
create index if not exists idx_questions_category      on questions(category);
create index if not exists idx_chat_app                on chat_messages(application_id, created_at);
create index if not exists idx_chat_question           on chat_messages(question_id);

-- ── Auto-update updated_at trigger ───────────────────────────
create or replace function update_timestamp()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_applications_updated
  before update on applications
  for each row execute function update_timestamp();

create trigger trg_questions_updated
  before update on questions
  for each row execute function update_timestamp();

create trigger trg_base_answers_updated
  before update on base_answers
  for each row execute function update_timestamp();

-- ── Project-level chat messages ─────────────────────────────────────────────
create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  project_key text not null,
  role        text not null check (role in ('user', 'assistant', 'system')),
  content     text not null,
  metadata    jsonb,          -- tier, model, provider, cached, usage
  created_at  timestamptz not null default now()
);
create index if not exists idx_messages_project on messages(project_key, created_at);

-- ── User profile ─────────────────────────────────────────────────────────────
create table if not exists profile (
  id         uuid primary key default gen_random_uuid(),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
-- Seed an empty profile row so getProfile() always returns something
insert into profile (data) values ('{}') on conflict do nothing;

-- ── Cost log ─────────────────────────────────────────────────────────────────
create table if not exists cost_log (
  id            uuid primary key default gen_random_uuid(),
  model         text not null,
  provider      text not null,
  tier          int not null,
  input_tokens  int default 0,
  output_tokens int default 0,
  cost_usd      numeric(10,6) default 0,
  cached        boolean default false,
  project_key   text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_cost_log_created on cost_log(created_at desc);
create index if not exists idx_cost_log_project on cost_log(project_key, created_at);

-- ── Batch jobs ────────────────────────────────────────────────────────────────
create table if not exists batch_jobs (
  id          uuid primary key default gen_random_uuid(),
  batch_id    text not null unique,
  status      text not null default 'in_progress',
  job_count   int default 0,
  project_key text,
  metadata    jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_batch_jobs_updated
  before update on batch_jobs
  for each row execute function update_timestamp();

-- ── Disable Row Level Security (single-user app — RLS would return empty queries) ──
-- If you ever add multi-user auth, re-enable RLS and add policies instead.
alter table applications       disable row level security;
alter table questions          disable row level security;
alter table base_answers       disable row level security;
alter table chat_messages      disable row level security;
alter table push_subscriptions disable row level security;
alter table inbox_log          disable row level security;
alter table messages           disable row level security;
alter table profile            disable row level security;
alter table cost_log           disable row level security;
alter table batch_jobs         disable row level security;

-- ── Seed: default base answer categories (empty, user fills these in) ──
insert into base_answers (category, content) values
  ('research_interests',   ''),
  ('research_statement',   ''),
  ('motivation',           ''),
  ('background',           ''),
  ('diversity_statement',  ''),
  ('technical_skills',     ''),
  ('future_directions',    '')
on conflict (category) do nothing;
