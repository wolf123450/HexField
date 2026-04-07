CREATE TABLE IF NOT EXISTS bans (
  server_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  banned_by   TEXT NOT NULL,
  reason      TEXT,
  banned_at   TEXT NOT NULL,
  expires_at  TEXT,
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_bans_server ON bans(server_id);
