-- Initial schema: applications, questions, base_answers, chat_messages, push_subscriptions, inbox_log.

create or replace function update_timestamp()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists applications (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  org           text not null default '',
  url           text,
  deadline      timestamptz,
  status        text not null default 'backlog'
                  check (status in ('backlog', 'drafting', 'review', 'submitted')),
  project_key   text not null default 'research_apps',
  scrape_method text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists base_answers (
  id         uuid primary key default gen_random_uuid(),
  category   text not null unique,
  content    text not null,
  version    int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists questions (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  text           text not null,
  category       text not null default 'other',
  answer         text not null default '',
  status         text not null default 'pending'
                   check (status in ('pending', 'drafted', 'reviewed', 'final')),
  base_answer_id uuid references base_answers(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists chat_messages (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  question_id    uuid references questions(id) on delete cascade,
  role           text not null check (role in ('user', 'assistant', 'system')),
  content        text not null,
  created_at     timestamptz not null default now()
);

create table if not exists push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  endpoint     text not null unique,
  subscription jsonb not null,
  created_at   timestamptz not null default now()
);

create table if not exists inbox_log (
  id                uuid primary key default gen_random_uuid(),
  source            text not null default 'unknown',
  url               text,
  text              text,
  project           text not null,
  summary           text,
  model_project     text,
  model_confidence  float,
  final_project     text,
  corrected_project text,
  correction_note   text,
  is_correction     boolean default false,
  created_at        timestamptz not null default now()
);

create index if not exists idx_inbox_log_created   on inbox_log(created_at desc);
create index if not exists idx_apps_project_deadline on applications(project_key, deadline);
create index if not exists idx_apps_status           on applications(status);
create index if not exists idx_questions_app         on questions(application_id);
create index if not exists idx_questions_category    on questions(category);
create index if not exists idx_chat_app              on chat_messages(application_id, created_at);
create index if not exists idx_chat_question         on chat_messages(question_id);

create trigger trg_applications_updated
  before update on applications
  for each row execute function update_timestamp();

create trigger trg_questions_updated
  before update on questions
  for each row execute function update_timestamp();

create trigger trg_base_answers_updated
  before update on base_answers
  for each row execute function update_timestamp();

alter table applications       disable row level security;
alter table questions          disable row level security;
alter table base_answers       disable row level security;
alter table chat_messages      disable row level security;
alter table push_subscriptions disable row level security;
alter table inbox_log          disable row level security;

insert into base_answers (category, content) values
  ('research_interests',  ''),
  ('research_statement',  ''),
  ('motivation',          ''),
  ('background',          ''),
  ('diversity_statement', ''),
  ('technical_skills',    ''),
  ('future_directions',   '')
on conflict (category) do nothing;
