-- Persistent deduplication log for the Slack bot.
-- Survives bot restarts so replayed Slack events within the TTL window
-- aren't reprocessed. The cleanup of expired rows is handled by Unit 6
-- (cron/dedup-cleanup) — this migration only creates storage.

CREATE TABLE IF NOT EXISTS dedup_log (
  message_hash TEXT PRIMARY KEY,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dedup_log_expires_at ON dedup_log (expires_at);

ALTER TABLE dedup_log DISABLE ROW LEVEL SECURITY;
