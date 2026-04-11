-- Migration tracking table — bootstrapped first before any other migrations.
create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now(),
  checksum   text
);
