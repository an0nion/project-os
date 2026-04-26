-- Soft-delete + audit-trail.
--
-- Purpose:
--   1. Add deleted_at columns to user-data tables so DELETEs become reversible
--      and audit history is preserved.
--   2. Replace ON DELETE CASCADE on questions.application_id with ON DELETE
--      SET NULL, plus a trigger that propagates soft-deletes from applications
--      to their child questions. Hard-deleting an application no longer silently
--      destroys the associated questions (audit trail).
--
-- Idempotent: safe to re-run.
-- Note: this repo has `inbox_log` (not `inbox`); we apply the column to that.

alter table items        add column if not exists deleted_at timestamptz;
alter table applications add column if not exists deleted_at timestamptz;
alter table questions    add column if not exists deleted_at timestamptz;
alter table inbox_log    add column if not exists deleted_at timestamptz;
alter table base_answers add column if not exists deleted_at timestamptz;

-- Helpful partial indexes — common case is filtering for non-deleted rows.
create index if not exists idx_items_not_deleted
  on items(project_key) where deleted_at is null;
create index if not exists idx_applications_not_deleted
  on applications(project_key) where deleted_at is null;
create index if not exists idx_questions_not_deleted
  on questions(application_id) where deleted_at is null;
create index if not exists idx_inbox_log_not_deleted
  on inbox_log(created_at desc) where deleted_at is null;

-- Replace CASCADE with SET NULL so hard-deleting an application orphans (rather
-- than destroys) child question rows. The propagation trigger below handles the
-- normal case (soft-delete) by cascading deleted_at to children.
alter table questions drop constraint if exists questions_application_id_fkey;
alter table questions
  add constraint questions_application_id_fkey
  foreign key (application_id) references applications(id) on delete set null;

create or replace function propagate_soft_delete_questions() returns trigger as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update questions
       set deleted_at = new.deleted_at
     where application_id = new.id
       and deleted_at is null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_propagate_soft_delete_questions on applications;
create trigger trg_propagate_soft_delete_questions
  after update of deleted_at on applications
  for each row execute function propagate_soft_delete_questions();
