CREATE TABLE users (
    user_id          TEXT PRIMARY KEY NOT NULL,
    display_name     TEXT NOT NULL,
    public_sign_key  TEXT NOT NULL,
    public_dh_key    TEXT NOT NULL DEFAULT '',
    avatar_hash      TEXT,
    bio              TEXT NOT NULL DEFAULT '',
    discoverability  TEXT NOT NULL DEFAULT 'public',
    last_seen_at     TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE servers (
    server_id     TEXT PRIMARY KEY NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    icon_hash     TEXT,
    owner_id      TEXT NOT NULL REFERENCES users(user_id),
    visibility    TEXT NOT NULL DEFAULT 'unlisted',
    member_count  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE server_members (
    server_id    TEXT NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(user_id),
    role         TEXT NOT NULL DEFAULT 'member',
    joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, user_id)
);

CREATE TABLE invites (
    code          TEXT PRIMARY KEY NOT NULL,
    server_id     TEXT NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
    server_name   TEXT NOT NULL,
    creator_id    TEXT NOT NULL REFERENCES users(user_id),
    endpoints     TEXT NOT NULL DEFAULT '[]',
    max_uses      INTEGER,
    use_count     INTEGER NOT NULL DEFAULT 0,
    expires_at    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rate_limit_bans (
    ip_addr     TEXT PRIMARY KEY NOT NULL,
    reason      TEXT,
    banned_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT
);

CREATE INDEX idx_servers_visibility ON servers(visibility);
CREATE INDEX idx_servers_owner ON servers(owner_id);
CREATE INDEX idx_server_members_user ON server_members(user_id);
CREATE INDEX idx_invites_server ON invites(server_id);
CREATE INDEX idx_users_discoverability ON users(discoverability);
