CREATE TABLE IF NOT EXISTS join_requests (
  id               TEXT PRIMARY KEY,
  server_id        TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  public_sign_key  TEXT NOT NULL,
  public_dh_key    TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS join_requests_server ON join_requests(server_id, status);

-- Add access_mode column to servers table (default 'open')
ALTER TABLE servers ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'open';
