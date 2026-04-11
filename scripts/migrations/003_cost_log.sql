-- AI cost tracking table.

create table if not exists cost_log (
  id            uuid primary key default gen_random_uuid(),
  model         text not null,
  provider      text not null,
  tier          int not null,
  input_tokens  int default 0,
  output_tokens int default 0,
  cost_usd      numeric(10,8) default 0,
  cached        boolean default false,
  project_key   text,
  reason        text,
  latency_ms    int,
  created_at    timestamptz not null default now()
);
create index if not exists idx_cost_log_created on cost_log(created_at desc);
create index if not exists idx_cost_log_project on cost_log(project_key, created_at);

alter table cost_log disable row level security;
