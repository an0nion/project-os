-- Atomic increment RPC for bot_counters.
-- Avoids the read-modify-write race that occurs when two VM instances
-- (or two concurrent requests in one instance) call /api/counters at the
-- same time and both compute newValue = old + 1.

create or replace function increment_bot_counter(
  p_key   text,
  p_delta bigint,
  p_meta  jsonb
) returns bigint
language plpgsql
as $$
declare
  new_value bigint;
begin
  insert into bot_counters (key, value, meta, updated_at)
  values (p_key, p_delta, p_meta, now())
  on conflict (key) do update
    set value      = bot_counters.value + excluded.value,
        meta       = coalesce(excluded.meta, bot_counters.meta),
        updated_at = now()
  returning value into new_value;

  return new_value;
end;
$$;
