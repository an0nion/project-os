-- Browser session tokens (replaces cookie-as-APP_SECRET pattern).
-- Each successful /api/login generates a random 32-byte hex token, stores it
-- here with an expiry, and sets it as an HttpOnly cookie. requireAuth()
-- validates incoming cookies against this table.

CREATE TABLE IF NOT EXISTS session_tokens (
  token       TEXT PRIMARY KEY,
  user_id     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_tokens_expires_at
  ON session_tokens (expires_at);

ALTER TABLE session_tokens DISABLE ROW LEVEL SECURITY;
