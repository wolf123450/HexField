CREATE TABLE IF NOT EXISTS servers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  icon_url     TEXT,
  owner_id     TEXT NOT NULL,
  invite_code  TEXT,
  created_at   TEXT NOT NULL,
  raw_json     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'text',
  position     INTEGER NOT NULL DEFAULT 0,
  topic        TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  server_id       TEXT NOT NULL,
  author_id       TEXT NOT NULL,
  content         TEXT,
  content_type    TEXT NOT NULL DEFAULT 'text',
  reply_to_id     TEXT,
  created_at      TEXT NOT NULL,
  logical_ts      TEXT NOT NULL,
  verified        INTEGER NOT NULL DEFAULT 0,
  raw_attachments TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, logical_ts DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content=messages, content_rowid=rowid
);

CREATE TABLE IF NOT EXISTS mutations (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  author_id       TEXT NOT NULL,
  new_content     TEXT,
  emoji_id        TEXT,
  logical_ts      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  verified        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mutations_channel ON mutations(channel_id, logical_ts DESC);
CREATE INDEX IF NOT EXISTS idx_mutations_target  ON mutations(target_id);

CREATE TABLE IF NOT EXISTS members (
  user_id          TEXT NOT NULL,
  server_id        TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  display_name     TEXT NOT NULL,
  roles            TEXT,
  joined_at        TEXT NOT NULL,
  public_sign_key  TEXT NOT NULL,
  public_dh_key    TEXT NOT NULL,
  online_status    TEXT NOT NULL DEFAULT 'offline',
  PRIMARY KEY (user_id, server_id)
);

CREATE TABLE IF NOT EXISTS custom_emoji (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  uploaded_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS key_store (
  key_id       TEXT PRIMARY KEY,
  key_type     TEXT NOT NULL,
  key_data     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id        TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  public_sign_key  TEXT NOT NULL,
  public_dh_key    TEXT NOT NULL,
  attested_by      TEXT,
  attestation_sig  TEXT,
  revoked          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS channel_permission_overrides (
  channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  role_name    TEXT NOT NULL,
  permission   TEXT NOT NULL,
  effect       TEXT NOT NULL,
  PRIMARY KEY (channel_id, role_name, permission)
);
