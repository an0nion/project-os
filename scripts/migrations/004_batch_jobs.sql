-- Anthropic batch job tracking.

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

alter table batch_jobs disable row level security;
