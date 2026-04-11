-- Generic Kanban items table for all non-application projects.

create table if not exists items (
  id          uuid primary key default gen_random_uuid(),
  project_key text not null,
  title       text not null,
  subtitle    text,
  status      text not null default 'backlog',
  due_date    timestamptz,
  url         text,
  notes       text,
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_items_project on items(project_key, status, position);
create trigger trg_items_updated
  before update on items
  for each row execute function update_timestamp();

alter table items disable row level security;
