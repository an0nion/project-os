-- Row-Level Security policies — RLS-readiness for future multi-user.
--
-- Permissive policies — single-user assumption. Tighten when multi-user is
-- introduced. This migration enables RLS on user-data tables and adds
-- USING (true) WITH CHECK (true) policies so the existing single-user app
-- continues to work unchanged. No security improvement today; this is purely
-- structural prep so a future migration can swap policies for owner-scoped
-- ones (e.g. USING (user_id = auth.uid())) without re-architecting routes.
--
-- Idempotent: safe to re-run.

-- Helper: enable RLS + add four permissive policies for a table.
do $$
declare
  tbl text;
  tables text[] := array['items', 'applications', 'questions', 'inbox_log', 'base_answers'];
begin
  foreach tbl in array tables loop
    execute format('alter table %I enable row level security', tbl);

    -- SELECT
    if not exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = tbl
         and policyname = tbl || '_select_all'
    ) then
      execute format(
        'create policy %I on %I for select using (true)',
        tbl || '_select_all', tbl
      );
    end if;

    -- INSERT
    if not exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = tbl
         and policyname = tbl || '_insert_all'
    ) then
      execute format(
        'create policy %I on %I for insert with check (true)',
        tbl || '_insert_all', tbl
      );
    end if;

    -- UPDATE
    if not exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = tbl
         and policyname = tbl || '_update_all'
    ) then
      execute format(
        'create policy %I on %I for update using (true) with check (true)',
        tbl || '_update_all', tbl
      );
    end if;

    -- DELETE
    if not exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = tbl
         and policyname = tbl || '_delete_all'
    ) then
      execute format(
        'create policy %I on %I for delete using (true)',
        tbl || '_delete_all', tbl
      );
    end if;
  end loop;
end $$;
