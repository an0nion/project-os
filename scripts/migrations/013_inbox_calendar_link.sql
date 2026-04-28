-- Link inbox items (rows in `items`) to their Google Calendar event id.
-- Enables the transactional inbox→calendar flow:
--   1. /api/inbox creates the items row (no calendar_event_id yet).
--   2. /api/calendar/event creates the Google Calendar event and writes
--      its id back into items.calendar_event_id.
--   3. A backfill cron (added in Unit 6) retries items rows whose
--      calendar_event_id is still NULL, eliminating orphan calendar events.
--
-- Idempotent: re-running this migration is a no-op.

ALTER TABLE items ADD COLUMN IF NOT EXISTS calendar_event_id TEXT;
CREATE INDEX IF NOT EXISTS idx_items_calendar_event_id
  ON items (calendar_event_id)
  WHERE calendar_event_id IS NOT NULL;
