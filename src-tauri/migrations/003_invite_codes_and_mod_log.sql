CREATE TABLE IF NOT EXISTS invite_codes (
  code        TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  max_uses    INTEGER,               -- NULL = unlimited
  use_count   INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,                  -- ISO-8601 or NULL
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_server ON invite_codes(server_id);

CREATE TABLE IF NOT EXISTS mod_log (
  id          TEXT PRIMARY KEY,      -- UUID v7
  server_id   TEXT NOT NULL,
  action      TEXT NOT NULL,         -- mutation type string
  target_id   TEXT NOT NULL,         -- userId or channelId
  issued_by   TEXT NOT NULL,         -- admin userId
  reason      TEXT,                  -- optional human-readable reason
  detail      TEXT,                  -- JSON: extra context (e.g. channel name, expiry)
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mod_log_server ON mod_log(server_id, created_at DESC);
