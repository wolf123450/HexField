CREATE TABLE IF NOT EXISTS channel_acls (
  channel_id      TEXT PRIMARY KEY,
  allowed_roles   TEXT NOT NULL DEFAULT '[]',
  allowed_users   TEXT NOT NULL DEFAULT '[]',
  denied_users    TEXT NOT NULL DEFAULT '[]',
  private_channel INTEGER NOT NULL DEFAULT 0
);
