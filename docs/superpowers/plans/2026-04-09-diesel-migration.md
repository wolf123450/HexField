# Client App — Diesel ORM Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the HexField Tauri app's entire database layer from raw `rusqlite` SQL strings to **Diesel 2 ORM** with compile-time schema checking, typed queries, and model structs. This eliminates ~600 lines of hand-written SQL scattered across `db_commands.rs`, `sync_commands.rs`, and `archive_commands.rs`, replacing them with Diesel's typed query builder.

**Scope:** All SQL in `src-tauri/` — 40+ Tauri commands, sync, archive, and mutation side effects. FTS5 is the one exception that requires `diesel::sql_query()` (Diesel has no FTS5 support).

**Strategy:** Incremental migration — Diesel and rusqlite can coexist because Diesel's `SqliteConnection` wraps the same `libsqlite3-sys` underneath. We swap module by module, verifying compilation + tests after each task. The migration is complete when `rusqlite` can be removed from `Cargo.toml` (or kept only as a transitive dependency of `diesel`).

**Pre-requisites:** None. This plan can be executed independently.

---

## Current Inventory

### Row Structs (`src-tauri/src/db/types.rs`) — 12 structs

| Struct | Fields | Special |
|--------|--------|---------|
| `MessageRow` | 11 | `verified: bool` ↔ i64 |
| `MutationRow` | 10 | `#[serde(rename = "type")] mutation_type`, `verified: bool` ↔ i64 |
| `ServerRow` | 9 | Missing `history_starts_at` (exists in DB since migration 008) |
| `ChannelRow` | 7 | `#[serde(rename = "type")] channel_type` |
| `MemberRow` | 14 | Legacy `avatar_data_url`/`banner_data_url` + `avatar_hash`/`banner_hash` |
| `EmojiRow` | 6 | |
| `DeviceRow` | 8 | `revoked: bool` ↔ i64 |
| `InviteCodeRow` | 7 | |
| `ModLogRow` | 8 | |
| `BanRow` | 6 | |
| `ChannelAclRow` | 5 | `private_channel: bool` ↔ i64 |
| `JoinRequestRow` | 8 | |

### Commands by Module

| Module | Commands | SQL Complexity |
|--------|----------|----------------|
| `db_commands.rs` | 40+ | Full CRUD, cursor pagination, FTS5, side effects |
| `sync_commands.rs` | 6 | Dynamic IN queries, UNION, batch INSERT OR IGNORE |
| `archive_commands.rs` | 3 | Multi-table SELECT/INSERT, history filters |

### Key Patterns to Convert

| Pattern | rusqlite | Diesel |
|---------|----------|--------|
| INSERT OR REPLACE | `"INSERT OR REPLACE INTO..."` | `diesel::replace_into(table).values(&row).execute(&mut conn)` |
| INSERT OR IGNORE | `"INSERT OR IGNORE INTO..."` | `diesel::insert_or_ignore_into(table).values(&row).execute(&mut conn)` |
| ON CONFLICT DO UPDATE | inline SQL | `diesel::insert_into(table).values(&row).on_conflict(pk).do_update().set(&changeset).execute(&mut conn)` |
| Cursor pagination | `WHERE logical_ts < ? ORDER BY logical_ts DESC LIMIT ?` | `.filter(messages::logical_ts.lt(&cursor)).order(messages::logical_ts.desc()).limit(n)` |
| FTS5 queries | `"SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?"` | `diesel::sql_query("SELECT ...")` (no Diesel FTS5 support) |
| Bool ↔ i64 | Manual `as i64` / `!= 0` | Diesel SQLite handles `Bool` ↔ INTEGER automatically |
| Dynamic IN | Runtime placeholder string building | `.filter(column.eq_any(&id_vec))` |
| JOINs | Hand-written `INNER JOIN` | `.inner_join(table_b.on(table_b::col.eq(table_a::col)))` |

### Traps

1. **Serde renames vs Diesel column names:** `MutationRow.mutation_type` has `#[serde(rename = "type")]` because `type` is a reserved word in Rust. Diesel's `table!` macro uses raw SQL column names. The struct field can be named `mutation_type` with `#[diesel(column_name = type)]` to map correctly.
2. **Bool columns:** Diesel's SQLite backend maps `Bool` ↔ `INTEGER` automatically — no manual conversion needed. Remove all `as i64` and `!= 0` conversions.
3. **FTS5 virtual table:** `messages_fts` cannot be declared in `schema.rs` — use `diesel::sql_query()` for `db_search_messages`.
4. **FTS5 triggers:** The content-sync triggers (migration 007) are DDL — they stay in migration SQL unchanged.
5. **`history_starts_at`:** Column exists in DB (migration 008) but `ServerRow` doesn't include it. Add it during this migration.
6. **Dynamic IN queries in sync:** `sync_get_messages` builds `WHERE id IN (?,?,?...)` at runtime. Diesel provides `.filter(id.eq_any(&vec))` which generates the same SQL.

---

## File Structure Changes

| File | Action | Description |
|------|--------|-------------|
| `src-tauri/Cargo.toml` | Modify | Add `diesel`, `diesel_migrations`; keep `rusqlite` temporarily |
| `src-tauri/diesel.toml` | Create | Diesel CLI config |
| `src-tauri/src/schema.rs` | Create | `table!` macros for all 13 tables (excludes FTS5) |
| `src-tauri/src/models.rs` | Create | Queryable/Insertable/AsChangeset structs |
| `src-tauri/src/db/mod.rs` | Modify | Switch to `diesel::SqliteConnection`, `diesel_migrations` |
| `src-tauri/src/db/types.rs` | Modify | Add Diesel derives, remove manual bool conversion |
| `src-tauri/src/db/migrations.rs` | Remove | Replaced by `diesel_migrations::embed_migrations!()` |
| `src-tauri/src/commands/db_commands.rs` | Modify | Replace raw SQL with Diesel query builder |
| `src-tauri/src/commands/sync_commands.rs` | Modify | Replace raw SQL with Diesel query builder |
| `src-tauri/src/commands/archive_commands.rs` | Modify | Replace raw SQL with Diesel query builder |
| `src-tauri/src/lib.rs` | Modify | `AppState.db: Mutex<diesel::SqliteConnection>` |

---

### Task 1: Add Diesel Dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/diesel.toml`

- [ ] **Step 1: Add Diesel to `Cargo.toml`**

Add to `[dependencies]`:
```toml
diesel = { version = "2", features = ["sqlite"] }
diesel_migrations = "2"
```

Keep `rusqlite` and `rusqlite_migration` temporarily — they'll be removed in the final task. Diesel's SQLite backend uses its own bundled `libsqlite3-sys`, which may conflict with rusqlite's bundled feature. If there's a link conflict:
- Remove `features = ["bundled"]` from `rusqlite` and add `features = ["bundled"]` to diesel's sqlite feature set: `diesel = { version = "2", features = ["sqlite", "sqlite-bundled"] }`.
- Or keep rusqlite bundled and make diesel use the system sqlite: this is less portable.
- **Recommended:** Use diesel's bundled SQLite (`"sqlite-bundled"`) and remove rusqlite's bundled flag. They both depend on `libsqlite3-sys` — if the versions are compatible, Cargo deduplicates.

Check with: `cd src-tauri && cargo check`

If there's a `libsqlite3-sys` version conflict, pin both to use the same version by checking what diesel 2.x requires and matching rusqlite's `libsqlite3-sys` version. The easiest solution is usually to let one crate use the other's bundled build.

- [ ] **Step 2: Create `src-tauri/diesel.toml`**

```toml
[print_schema]
file = "src/schema.rs"
```

- [ ] **Step 3: Verify & commit**

```bash
cd src-tauri && cargo check
git add Cargo.toml diesel.toml
git commit -m "chore: add Diesel 2 + diesel_migrations dependencies"
```

---

### Task 2: Write `schema.rs` — Diesel Table Definitions

**Files:**
- Create: `src-tauri/src/schema.rs`

This file declares every table and column using `diesel::table!`. It must match the SQL schema produced by all 11 migrations. The FTS5 virtual table (`messages_fts`) is excluded — Diesel cannot represent virtual tables.

- [ ] **Step 1: Write `src-tauri/src/schema.rs`**

```rust
// Auto-generated from migration SQL. Maintain manually or regenerate with `diesel print-schema`.

diesel::table! {
    servers (id) {
        id -> Text,
        name -> Text,
        creator_id -> Text,
        created_at -> Text,
        icon -> Nullable<Text>,
        join_code -> Nullable<Text>,
        description -> Nullable<Text>,
        access_mode -> Text,
        history_starts_at -> Nullable<Text>,
        avatar_hash -> Nullable<Text>,
    }
}

diesel::table! {
    channels (id) {
        id -> Text,
        server_id -> Text,
        name -> Text,
        #[sql_name = "type"]
        channel_type -> Text,
        position -> Integer,
        topic -> Nullable<Text>,
        created_at -> Text,
    }
}

diesel::table! {
    messages (id) {
        id -> Text,
        server_id -> Text,
        channel_id -> Text,
        sender_id -> Text,
        content -> Nullable<Text>,
        logical_ts -> Text,
        created_at -> Text,
        content_type -> Text,
        reply_to_id -> Nullable<Text>,
        attachment_hash -> Nullable<Text>,
        verified -> Bool,
    }
}

// Note: messages_fts is an FTS5 virtual table — NOT declared here.
// Use `diesel::sql_query()` for FTS5 queries.

diesel::table! {
    mutations (id) {
        id -> Text,
        server_id -> Text,
        channel_id -> Text,
        target_message_id -> Text,
        #[sql_name = "type"]
        mutation_type -> Text,
        sender_id -> Text,
        content -> Nullable<Text>,
        logical_ts -> Text,
        created_at -> Text,
        verified -> Bool,
    }
}

diesel::table! {
    members (id) {
        id -> Integer,
        server_id -> Text,
        user_id -> Text,
        display_name -> Text,
        roles -> Text,
        joined_at -> Text,
        public_key -> Nullable<Text>,
        avatar_data_url -> Nullable<Text>,
        bio -> Nullable<Text>,
        banner_color -> Nullable<Text>,
        banner_data_url -> Nullable<Text>,
        avatar_hash -> Nullable<Text>,
        banner_hash -> Nullable<Text>,
        status -> Nullable<Text>,
    }
}

diesel::table! {
    custom_emoji (id) {
        id -> Text,
        server_id -> Text,
        name -> Text,
        creator_id -> Text,
        created_at -> Text,
        content_type -> Text,
    }
}

diesel::table! {
    key_store (key_name) {
        key_name -> Text,
        key_data -> Text,
    }
}

diesel::table! {
    devices (device_id) {
        device_id -> Text,
        user_id -> Text,
        device_name -> Text,
        public_sign_key -> Text,
        attestation_signature -> Nullable<Text>,
        attested_by -> Nullable<Text>,
        created_at -> Text,
        revoked -> Bool,
    }
}

diesel::table! {
    channel_permission_overrides (id) {
        id -> Integer,
        channel_id -> Text,
        role_name -> Text,
        permissions_json -> Text,
    }
}

diesel::table! {
    invite_codes (code) {
        code -> Text,
        server_id -> Text,
        creator_id -> Text,
        max_uses -> Nullable<Integer>,
        use_count -> Integer,
        expires_at -> Nullable<Text>,
        created_at -> Text,
    }
}

diesel::table! {
    mod_log (id) {
        id -> Text,
        server_id -> Text,
        action -> Text,
        actor_id -> Text,
        target_id -> Nullable<Text>,
        reason -> Nullable<Text>,
        details -> Nullable<Text>,
        created_at -> Text,
    }
}

diesel::table! {
    bans (id) {
        id -> Text,
        server_id -> Text,
        user_id -> Text,
        reason -> Nullable<Text>,
        expires_at -> Nullable<Text>,
        created_at -> Text,
    }
}

diesel::table! {
    channel_acls (id) {
        id -> Integer,
        server_id -> Text,
        channel_id -> Text,
        user_id -> Text,
        private_channel -> Bool,
    }
}

diesel::table! {
    join_requests (id) {
        id -> Text,
        server_id -> Text,
        user_id -> Text,
        display_name -> Text,
        public_key -> Nullable<Text>,
        message -> Nullable<Text>,
        status -> Text,
        created_at -> Text,
    }
}

// ───── Relationships ─────

diesel::joinable!(channels -> servers (server_id));
diesel::joinable!(messages -> channels (channel_id));
diesel::joinable!(mutations -> channels (channel_id));
diesel::joinable!(custom_emoji -> servers (server_id));
diesel::joinable!(invite_codes -> servers (server_id));
diesel::joinable!(mod_log -> servers (server_id));
diesel::joinable!(bans -> servers (server_id));
diesel::joinable!(join_requests -> servers (server_id));

diesel::allow_tables_to_appear_in_same_query!(
    servers, channels, messages, mutations, members, custom_emoji,
    key_store, devices, channel_permission_overrides, invite_codes,
    mod_log, bans, channel_acls, join_requests,
);
```

**Important notes:**
- `#[sql_name = "type"]` maps the Rust field `channel_type` / `mutation_type` to the SQL column named `type`. This replaces the manual serde rename approach.
- `Bool` type handles the INTEGER ↔ bool conversion automatically in Diesel's SQLite backend.
- `members` uses `id -> Integer` as primary key (auto-increment rowid). The composite unique constraint `(server_id, user_id)` is enforced by SQL, not Diesel schema.

- [ ] **Step 2: Add `mod schema;` to `src-tauri/src/lib.rs`** (or `main.rs` depending on module structure)

- [ ] **Step 3: Verify & commit**

```bash
cd src-tauri && cargo check
git commit -m "feat: add Diesel schema.rs with table definitions for all 13 tables"
```

---

### Task 3: Write `models.rs` — Diesel Model Structs

**Files:**
- Create: `src-tauri/src/models.rs`

These structs replace the current `db/types.rs` structs for database operations. The existing `types.rs` structs can be kept for serde serialization to the frontend (they have `#[serde(rename)]` attributes). Or we can merge them — one struct with both Diesel and Serde derives.

**Recommended approach:** Add Diesel derives directly to the existing `types.rs` structs where possible. Where the shapes differ (e.g. Insertable vs Queryable), create separate Insertable structs in `models.rs`.

- [ ] **Step 1: Create `src-tauri/src/models.rs` with Insertable/AsChangeset structs**

```rust
use diesel::prelude::*;
use crate::schema::*;

// ───── Messages ─────

#[derive(Insertable)]
#[diesel(table_name = messages)]
pub struct NewMessage<'a> {
    pub id: &'a str,
    pub server_id: &'a str,
    pub channel_id: &'a str,
    pub sender_id: &'a str,
    pub content: Option<&'a str>,
    pub logical_ts: &'a str,
    pub created_at: &'a str,
    pub content_type: &'a str,
    pub reply_to_id: Option<&'a str>,
    pub attachment_hash: Option<&'a str>,
    pub verified: bool,
}

// ───── Mutations ─────

#[derive(Insertable)]
#[diesel(table_name = mutations)]
pub struct NewMutation<'a> {
    pub id: &'a str,
    pub server_id: &'a str,
    pub channel_id: &'a str,
    pub target_message_id: &'a str,
    #[diesel(column_name = "type")]
    pub mutation_type: &'a str,
    pub sender_id: &'a str,
    pub content: Option<&'a str>,
    pub logical_ts: &'a str,
    pub created_at: &'a str,
    pub verified: bool,
}

// ───── Servers ─────

#[derive(Insertable, AsChangeset)]
#[diesel(table_name = servers)]
pub struct NewServer<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub creator_id: &'a str,
    pub created_at: &'a str,
    pub icon: Option<&'a str>,
    pub join_code: Option<&'a str>,
    pub description: Option<&'a str>,
    pub access_mode: &'a str,
    pub history_starts_at: Option<&'a str>,
    pub avatar_hash: Option<&'a str>,
}

// ───── Channels ─────

#[derive(Insertable, AsChangeset)]
#[diesel(table_name = channels)]
pub struct NewChannel<'a> {
    pub id: &'a str,
    pub server_id: &'a str,
    pub name: &'a str,
    #[diesel(column_name = "type")]
    pub channel_type: &'a str,
    pub position: i32,
    pub topic: Option<&'a str>,
    pub created_at: &'a str,
}

// ───── Members ─────

#[derive(Insertable, AsChangeset)]
#[diesel(table_name = members)]
pub struct NewMember<'a> {
    pub server_id: &'a str,
    pub user_id: &'a str,
    pub display_name: &'a str,
    pub roles: &'a str,
    pub joined_at: &'a str,
    pub public_key: Option<&'a str>,
    pub avatar_data_url: Option<&'a str>,
    pub bio: Option<&'a str>,
    pub banner_color: Option<&'a str>,
    pub banner_data_url: Option<&'a str>,
    pub avatar_hash: Option<&'a str>,
    pub banner_hash: Option<&'a str>,
    pub status: Option<&'a str>,
}

// ───── Custom Emoji ─────

#[derive(Insertable)]
#[diesel(table_name = custom_emoji)]
pub struct NewEmoji<'a> {
    pub id: &'a str,
    pub server_id: &'a str,
    pub name: &'a str,
    pub creator_id: &'a str,
    pub created_at: &'a str,
    pub content_type: &'a str,
}

// ───── Key Store ─────

#[derive(Insertable, AsChangeset)]
#[diesel(table_name = key_store)]
pub struct NewKey<'a> {
    pub key_name: &'a str,
    pub key_data: &'a str,
}

// ───── Devices ─────

#[derive(Insertable, AsChangeset)]
#[diesel(table_name = devices)]
pub struct NewDevice<'a> {
    pub device_id: &'a str,
    pub user_id: &'a str,
    pub device_name: &'a str,
    pub public_sign_key: &'a str,
    pub attestation_signature: Option<&'a str>,
    pub attested_by: Option<&'a str>,
    pub created_at: &'a str,
    pub revoked: bool,
}

// ───── Invite Codes ─────

#[derive(Insertable)]
#[diesel(table_name = invite_codes)]
pub struct NewInviteCode<'a> {
    pub code: &'a str,
    pub server_id: &'a str,
    pub creator_id: &'a str,
    pub max_uses: Option<i32>,
    pub use_count: i32,
    pub expires_at: Option<&'a str>,
    pub created_at: &'a str,
}

// ───── Mod Log ─────

#[derive(Insertable)]
#[diesel(table_name = mod_log)]
pub struct NewModLogEntry<'a> {
    pub id: &'a str,
    pub server_id: &'a str,
    pub action: &'a str,
    pub actor_id: &'a str,
    pub target_id: Option<&'a str>,
    pub reason: Option<&'a str>,
    pub details: Option<&'a str>,
    pub created_at: &'a str,
}

// ───── Bans ─────

#[derive(Insertable)]
#[diesel(table_name = bans)]
pub struct NewBan<'a> {
    pub id: &'a str,
    pub server_id: &'a str,
    pub user_id: &'a str,
    pub reason: Option<&'a str>,
    pub expires_at: Option<&'a str>,
    pub created_at: &'a str,
}

// ───── Channel ACLs ─────

#[derive(Insertable, AsChangeset)]
#[diesel(table_name = channel_acls)]
pub struct NewChannelAcl<'a> {
    pub server_id: &'a str,
    pub channel_id: &'a str,
    pub user_id: &'a str,
    pub private_channel: bool,
}

// ───── Join Requests ─────

#[derive(Insertable)]
#[diesel(table_name = join_requests)]
pub struct NewJoinRequest<'a> {
    pub id: &'a str,
    pub server_id: &'a str,
    pub user_id: &'a str,
    pub display_name: &'a str,
    pub public_key: Option<&'a str>,
    pub message: Option<&'a str>,
    pub status: &'a str,
    pub created_at: &'a str,
}
```

- [ ] **Step 2: Add Diesel derives to existing `types.rs` structs**

For each struct in `types.rs`, add `Queryable` and `Selectable` derives:

```rust
// Example for MessageRow:
use diesel::prelude::*;
use crate::schema::messages;

#[derive(Queryable, Selectable, Serialize, Deserialize, Clone, Debug)]
#[diesel(table_name = messages)]
pub struct MessageRow {
    pub id: String,
    pub server_id: String,
    pub channel_id: String,
    pub sender_id: String,
    pub content: Option<String>,
    pub logical_ts: String,
    pub created_at: String,
    pub content_type: String,
    pub reply_to_id: Option<String>,
    pub attachment_hash: Option<String>,
    pub verified: bool, // Diesel handles Bool <-> INTEGER automatically
}
```

Key changes per struct:
- **Add:** `#[derive(Queryable, Selectable)]` and `#[diesel(table_name = <table>)]`
- **Remove:** All manual `bool` ↔ `i64` conversion code from commands (Diesel handles it)
- **MutationRow/ChannelRow:** Add `#[diesel(column_name = "type")]` on the `mutation_type`/`channel_type` field. Keep `#[serde(rename = "type")]` for frontend serialization.
- **ServerRow:** Add `history_starts_at: Option<String>` field (was missing, column exists since migration 008)
- **MemberRow:** Change `id` from elided to explicit `i32` (auto-increment primary key)

- [ ] **Step 3: Verify & commit**

```bash
cd src-tauri && cargo check
git commit -m "feat: add Diesel models.rs and Queryable/Selectable derives to types.rs"
```

---

### Task 4: Switch DB Connection + Migration System

**Files:**
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Delete: `src-tauri/src/db/migrations.rs` (after confirming all migrations work via Diesel)

- [ ] **Step 1: Update `db/mod.rs` to use Diesel**

Replace the current `open()` function:

```rust
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use std::path::PathBuf;

pub mod types;

pub const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

pub fn open(app_dir: &str) -> SqliteConnection {
    let db_path = if let Ok(dir) = std::env::var("HEXFIELD_DATA_DIR") {
        PathBuf::from(dir).join("hexfield.db")
    } else {
        PathBuf::from(app_dir).join("hexfield.db")
    };

    let db_url = db_path.to_string_lossy().to_string();
    let mut conn = SqliteConnection::establish(&db_url)
        .unwrap_or_else(|e| panic!("Cannot open database {}: {}", db_url, e));

    // PRAGMAs — must be set via sql_query since Diesel doesn't have PRAGMA API
    diesel::sql_query("PRAGMA journal_mode=WAL").execute(&mut conn).ok();
    diesel::sql_query("PRAGMA foreign_keys=ON").execute(&mut conn).ok();

    // Run pending migrations
    conn.run_pending_migrations(MIGRATIONS)
        .expect("Failed to run database migrations");

    conn
}
```

**Diesel migration file format:** Diesel expects migrations in `migrations/<timestamp>_<name>/up.sql` and `down.sql`. We need to reorganize the existing 11 migration SQL files into this structure:

```
src-tauri/migrations/
  00000000000000_diesel_initial_setup/
    up.sql    # SELECT 1;
    down.sql  # SELECT 1;
  2024-01-01-000001_initial/
    up.sql    # Content of current 001_initial.sql
    down.sql  # DROP TABLE statements
  2024-01-01-000002_member_avatar/
    up.sql    # Content of current 002_member_avatar.sql
    down.sql  # ALTER TABLE DROP COLUMN (SQLite limitation: may need table rebuild)
  ... (one directory per migration)
```

**Important:** Diesel's `embed_migrations!()` macro reads from the `migrations/` directory relative to `Cargo.toml`. The existing flat `.sql` files must be reorganized into the directory-per-migration structure.

**Migration reorganization steps:**
1. Create the Diesel directory structure
2. Copy each existing `.sql` file into its corresponding `up.sql`
3. Write minimal `down.sql` files (for dev use — production never rolls back)
4. Remove the old flat `.sql` files
5. Delete `src-tauri/src/db/migrations.rs` (the `rusqlite_migration` runner)

- [ ] **Step 2: Update `lib.rs` AppState**

Change:
```rust
pub db: Mutex<rusqlite::Connection>,
```
To:
```rust
pub db: Mutex<diesel::SqliteConnection>,
```

Update `run()` or `init()` to call the new `db::open()`.

- [ ] **Step 3: Verify compilation**

At this point many commands will fail to compile because they still use `rusqlite` APIs on the connection. That's expected — subsequent tasks will convert them.

Temporarily comment out failing commands or add `#[allow(dead_code)]` stubs. The goal is to verify that the Diesel connection opens, migrations run, and the app starts.

```bash
cd src-tauri && cargo check  # Fix errors iteratively
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: switch DB connection from rusqlite to Diesel SqliteConnection"
```

---

### Task 5: Convert Message Commands

**Files:**
- Modify: `src-tauri/src/commands/db_commands.rs`

Convert the 5 message commands from raw SQL to Diesel query builder.

- [ ] **Step 1: Convert `db_load_messages` (cursor pagination)**

Before (rusqlite):
```rust
let sql = "SELECT id, server_id, channel_id, sender_id, content, logical_ts, created_at, content_type, reply_to_id, attachment_hash, verified FROM messages WHERE server_id = ? AND channel_id = ? AND logical_ts < ? ORDER BY logical_ts DESC LIMIT ?";
```

After (Diesel):
```rust
use diesel::prelude::*;
use crate::schema::messages;

let conn = &mut *state.db.lock().map_err(|e| e.to_string())?;
let results = messages::table
    .filter(messages::server_id.eq(&server_id))
    .filter(messages::channel_id.eq(&channel_id))
    .filter(messages::logical_ts.lt(&cursor))
    .order(messages::logical_ts.desc())
    .limit(limit)
    .select(MessageRow::as_select())
    .load(conn)
    .map_err(|e| e.to_string())?;
```

- [ ] **Step 2: Convert `db_load_messages_around` and `db_load_messages_after`**

Same pattern — replace raw SQL with `.filter()` chains. `db_load_messages_around` loads N/2 before and N/2 after a target message's `logical_ts`. Use two queries:
```rust
// Before target
let before = messages::table
    .filter(messages::server_id.eq(&server_id))
    .filter(messages::channel_id.eq(&channel_id))
    .filter(messages::logical_ts.le(&target_ts))
    .order(messages::logical_ts.desc())
    .limit(half_limit)
    .select(MessageRow::as_select())
    .load(conn)?;
// After target
let after = messages::table
    .filter(messages::server_id.eq(&server_id))
    .filter(messages::channel_id.eq(&channel_id))
    .filter(messages::logical_ts.gt(&target_ts))
    .order(messages::logical_ts.asc())
    .limit(half_limit)
    .select(MessageRow::as_select())
    .load(conn)?;
```

- [ ] **Step 3: Convert `db_save_message` (INSERT OR REPLACE)**

```rust
use crate::models::NewMessage;

diesel::replace_into(messages::table)
    .values(&NewMessage {
        id: &msg.id,
        server_id: &msg.server_id,
        channel_id: &msg.channel_id,
        sender_id: &msg.sender_id,
        content: msg.content.as_deref(),
        logical_ts: &msg.logical_ts,
        created_at: &msg.created_at,
        content_type: &msg.content_type,
        reply_to_id: msg.reply_to_id.as_deref(),
        attachment_hash: msg.attachment_hash.as_deref(),
        verified: msg.verified,
    })
    .execute(conn)
    .map_err(|e| e.to_string())?;
```

- [ ] **Step 4: Convert `db_search_messages` (FTS5 — escape hatch)**

FTS5 remains as `diesel::sql_query()`:

```rust
use diesel::sql_query;
use diesel::sql_types::Text;

#[derive(QueryableByName)]
struct FtsResult {
    #[diesel(sql_type = Text)]
    id: String,
}

let sanitized = sanitize_fts_query(&query);
let fts_ids: Vec<FtsResult> = sql_query(
    "SELECT rowid, id FROM messages WHERE id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)"
)
    // Note: FTS5 integration with Diesel requires careful query construction.
    // Alternative: query messages_fts for matching rowids, then use Diesel to load full MessageRows.
    ...
```

**Better approach:** Two-step query:
1. `sql_query("SELECT id FROM messages_fts WHERE messages_fts MATCH ?1 LIMIT ?2")` → get matching IDs
2. `messages::table.filter(messages::id.eq_any(&ids)).load(conn)` → get full rows via Diesel

- [ ] **Step 5: Remove manual bool conversion code for `verified` field**

Diesel's SQLite backend handles `Bool ↔ INTEGER` automatically. Remove all:
```rust
// Remove: row.get::<_, i64>(idx)? != 0
// Remove: msg.verified as i64
```

- [ ] **Step 6: Verify & commit**

```bash
cd src-tauri && cargo check && cargo test
git commit -m "feat: convert message commands to Diesel query builder"
```

---

### Task 6: Convert Mutation Commands + Side Effects

**Files:**
- Modify: `src-tauri/src/commands/db_commands.rs`

This is the most complex conversion because `apply_mutation_side_effects` contains 13 mutation types with inline SQL.

- [ ] **Step 1: Convert `db_save_mutation` (INSERT OR IGNORE)**

```rust
use crate::models::NewMutation;

diesel::insert_or_ignore_into(mutations::table)
    .values(&NewMutation {
        id: &m.id,
        server_id: &m.server_id,
        channel_id: &m.channel_id,
        target_message_id: &m.target_message_id,
        mutation_type: &m.mutation_type,
        sender_id: &m.sender_id,
        content: m.content.as_deref(),
        logical_ts: &m.logical_ts,
        created_at: &m.created_at,
        verified: m.verified,
    })
    .execute(conn)
    .map_err(|e| e.to_string())?;
```

- [ ] **Step 2: Convert `db_load_mutations`**

```rust
let results = mutations::table
    .filter(mutations::server_id.eq(&server_id))
    .filter(mutations::channel_id.eq(&channel_id))
    .filter(mutations::target_message_id.eq_any(&message_ids))
    .order(mutations::logical_ts.asc())
    .select(MutationRow::as_select())
    .load(conn)
    .map_err(|e| e.to_string())?;
```

- [ ] **Step 3: Convert `apply_mutation_side_effects` — 13 mutation types**

Each mutation type has inline SQL. Convert one by one:

| Mutation Type | SQL Operation | Diesel Equivalent |
|--------------|---------------|-------------------|
| `delete` | `UPDATE messages SET content = NULL WHERE id = ?` | `diesel::update(messages::table.find(&target_id)).set(messages::content.eq::<Option<&str>>(None))` |
| `edit` | `UPDATE messages SET content = ? WHERE id = ? AND logical_ts < ?` | `diesel::update(messages::table.filter(messages::id.eq(&target_id).and(messages::logical_ts.lt(&ts)))).set(messages::content.eq(&new_content))` |
| `server_update` | `UPDATE servers SET name = ?, description = ?, icon = ?, access_mode = ?` | `diesel::update(servers::table.find(&server_id)).set(&server_changeset)` |
| `role_assign` | `UPDATE members SET roles = ? WHERE server_id = ? AND user_id = ?` | `diesel::update(members::table.filter(...)).set(members::roles.eq(&new_roles))` |
| `role_revoke` | Same as role_assign | Same |
| `device_attest` | `INSERT OR REPLACE INTO devices...` | `diesel::replace_into(devices::table).values(&new_device)` |
| `device_revoke` | `UPDATE devices SET revoked = 1 WHERE device_id = ?` | `diesel::update(devices::table.find(&device_id)).set(devices::revoked.eq(true))` |
| `server_rebaseline` | `DELETE FROM messages WHERE ...` + `DELETE FROM mutations WHERE ...` + `UPDATE servers SET history_starts_at = ?` | Three Diesel operations |
| `member_join` | `INSERT OR REPLACE INTO members...` | `diesel::replace_into(members::table).values(&new_member)` |
| `member_profile_update` | `UPDATE members SET display_name = ?, avatar_hash = ?, ...` | `diesel::update(members::table.filter(...)).set(&member_changeset)` |
| `channel_create` | `INSERT OR IGNORE INTO channels...` | `diesel::insert_or_ignore_into(channels::table).values(&new_channel)` |
| `channel_update` | `UPDATE channels SET name = ?, topic = ?, position = ?` | `diesel::update(channels::table.find(&channel_id)).set(&channel_changeset)` |
| `channel_delete` | `DELETE FROM channels WHERE id = ?` | `diesel::delete(channels::table.find(&channel_id))` |
| `emoji_add` | `INSERT OR REPLACE INTO custom_emoji...` | `diesel::replace_into(custom_emoji::table).values(&new_emoji)` |
| `emoji_remove` | `DELETE FROM custom_emoji WHERE id = ?` | `diesel::delete(custom_emoji::table.find(&emoji_id))` |

- [ ] **Step 4: Verify & commit**

```bash
cd src-tauri && cargo check && cargo test
git commit -m "feat: convert mutation commands + side effects to Diesel"
```

---

### Task 7: Convert Server, Channel, Member, Key Commands

**Files:**
- Modify: `src-tauri/src/commands/db_commands.rs`

- [ ] **Step 1: Convert server commands**

- `db_load_servers`: `servers::table.select(ServerRow::as_select()).load(conn)`
- `db_save_server`: `diesel::replace_into(servers::table).values(&new_server).execute(conn)`

- [ ] **Step 2: Convert channel commands**

- `db_load_channels`: `channels::table.filter(channels::server_id.eq(&sid)).order(channels::position.asc()).select(ChannelRow::as_select()).load(conn)`
- `db_save_channel`: `diesel::replace_into(channels::table).values(&new_channel).execute(conn)`
- `db_delete_channel`: `diesel::delete(channels::table.find(&channel_id)).execute(conn)`

- [ ] **Step 3: Convert member commands**

- `db_load_members`: `members::table.filter(members::server_id.eq(&sid)).select(MemberRow::as_select()).load(conn)`
- `db_upsert_member`: `diesel::replace_into(members::table).values(&new_member).execute(conn)`

- [ ] **Step 4: Convert key commands**

- `db_save_key`: `diesel::replace_into(key_store::table).values(&NewKey { key_name, key_data }).execute(conn)`
- `db_load_key`: `key_store::table.find(&key_name).select(key_store::key_data).first::<String>(conn).optional()`

- [ ] **Step 5: Verify & commit**

```bash
cd src-tauri && cargo check && cargo test
git commit -m "feat: convert server/channel/member/key commands to Diesel"
```

---

### Task 8: Convert Remaining Commands (Emoji, Devices, Invites, Bans, ACLs, Join Requests, Mod Log)

**Files:**
- Modify: `src-tauri/src/commands/db_commands.rs`

- [ ] **Step 1: Convert emoji commands**

- `db_load_emoji`: `.filter(custom_emoji::server_id.eq(&sid)).load(conn)`
- `db_save_emoji`: `diesel::replace_into(custom_emoji::table).values(&new_emoji).execute(conn)` + file write (unchanged)

- [ ] **Step 2: Convert device commands**

- `db_load_devices`: `.filter(devices::user_id.eq(&uid)).load(conn)`
- `db_save_device`: `diesel::replace_into(devices::table).values(&new_device).execute(conn)`
- `db_revoke_device`: `diesel::update(devices::table.find(&device_id)).set(devices::revoked.eq(true)).execute(conn)`

- [ ] **Step 3: Convert invite commands**

- `db_save_invite_code`: `diesel::replace_into(invite_codes::table).values(&new_invite).execute(conn)`
- `db_load_invite_codes`: `.filter(invite_codes::server_id.eq(&sid)).load(conn)`
- `db_increment_invite_use_count`: `diesel::update(invite_codes::table.find(&code)).set(invite_codes::use_count.eq(invite_codes::use_count + 1)).execute(conn)`
- `db_delete_invite_code`: `diesel::delete(invite_codes::table.find(&code)).execute(conn)`

- [ ] **Step 4: Convert ban commands**

- `db_save_ban`: `diesel::replace_into(bans::table).values(&new_ban).execute(conn)`
- `db_load_bans`: `.filter(bans::server_id.eq(&sid)).load(conn)`
- `db_delete_ban`: `diesel::delete(bans::table.filter(bans::server_id.eq(&sid).and(bans::user_id.eq(&uid)))).execute(conn)`
- `db_is_banned`: `.filter(...).count().get_result::<i64>(conn) > 0` (also check expiry)
- `db_prune_expired_bans`: `diesel::delete(bans::table.filter(bans::expires_at.lt(&now))).execute(conn)`

- [ ] **Step 5: Convert channel ACL commands**

- `db_load_channel_acls`: JOIN query — use `.inner_join(channels::table.on(...))` or two queries
- `db_upsert_channel_acl`: `diesel::insert_into(channel_acls::table).values(&new_acl).on_conflict((channel_acls::server_id, channel_acls::channel_id, channel_acls::user_id)).do_update().set(channel_acls::private_channel.eq(&private)).execute(conn)`

**Note:** `channel_acls` PK is `id` (auto-increment), but the unique constraint is `(server_id, channel_id, user_id)`. Use `.on_conflict()` on the composite unique columns, not the PK.

- [ ] **Step 6: Convert join request commands**

- `db_save_join_request`: `diesel::insert_or_ignore_into(join_requests::table).values(&new_jr).execute(conn)`
- `db_load_join_requests`: `.filter(join_requests::server_id.eq(&sid)).load(conn)`
- `db_update_join_request_status`: `diesel::update(join_requests::table.find(&id)).set(join_requests::status.eq(&status)).execute(conn)`

- [ ] **Step 7: Convert mod log commands**

- `db_save_mod_log_entry`: `diesel::insert_into(mod_log::table).values(&new_entry).execute(conn)`
- `db_load_mod_log`: `.filter(mod_log::server_id.eq(&sid)).order(mod_log::created_at.desc()).limit(limit).load(conn)`
- `db_prune_mod_log`: Two-phase: (1) `diesel::delete(mod_log::table.filter(mod_log::created_at.lt(&cutoff_date)))`, (2) count rows → if over cap, delete oldest excess

- [ ] **Step 8: Verify & commit**

```bash
cd src-tauri && cargo check && cargo test
git commit -m "feat: convert remaining DB commands to Diesel query builder"
```

---

### Task 9: Convert Sync Commands

**Files:**
- Modify: `src-tauri/src/commands/sync_commands.rs`

- [ ] **Step 1: Convert `load_items` (SELECT id with optional history filter)**

```rust
use crate::schema::{messages, mutations, servers};

fn load_items(conn: &mut SqliteConnection, server_id: &str, channel_id: &str, table_name: &str) -> Result<Vec<String>, String> {
    // Get history_starts_at
    let history_starts_at: Option<String> = servers::table
        .find(server_id)
        .select(servers::history_starts_at)
        .first(conn)
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();

    let skip_filter = channel_id == "__server__";

    match table_name {
        "messages" => {
            let mut query = messages::table
                .filter(messages::server_id.eq(server_id))
                .filter(messages::channel_id.eq(channel_id))
                .select(messages::id)
                .into_boxed();

            if !skip_filter {
                if let Some(ref starts_at) = history_starts_at {
                    query = query.filter(messages::logical_ts.ge(starts_at));
                }
            }

            query.load(conn).map_err(|e| e.to_string())
        }
        "mutations" => {
            // Similar pattern for mutations table
            let mut query = mutations::table
                .filter(mutations::server_id.eq(server_id))
                .filter(mutations::channel_id.eq(channel_id))
                .select(mutations::id)
                .into_boxed();

            if !skip_filter {
                if let Some(ref starts_at) = history_starts_at {
                    query = query.filter(mutations::logical_ts.ge(starts_at));
                }
            }

            query.load(conn).map_err(|e| e.to_string())
        }
        _ => Err(format!("Unknown table: {}", table_name)),
    }
}
```

- [ ] **Step 2: Convert `sync_get_messages` / `sync_get_mutations` (dynamic IN)**

```rust
// Before: runtime placeholder building "WHERE id IN (?,?,?...)"
// After:
let rows = messages::table
    .filter(messages::server_id.eq(&server_id))
    .filter(messages::id.eq_any(&ids))
    .select(MessageRow::as_select())
    .load(conn)
    .map_err(|e| e.to_string())?;
```

**Note:** Diesel's `.eq_any()` generates `IN (?, ?, ...)` with bound parameters. For very large ID lists (>999, SQLite's `SQLITE_MAX_VARIABLE_NUMBER`), chunk the IDs into batches of 900 and union the results.

- [ ] **Step 3: Convert `sync_save_messages` / `sync_save_mutations` (batch INSERT OR IGNORE)**

```rust
for msg in &messages {
    diesel::insert_or_ignore_into(messages::table)
        .values(&NewMessage { /* ... from msg ... */ })
        .execute(conn)
        .map_err(|e| e.to_string())?;
}
```

**Note:** Diesel SQLite doesn't support batch `insert_or_ignore_into` with a `Vec`. Loop through individually. For performance, wrap in a single transaction.

- [ ] **Step 4: Convert `sync_list_channels` (UNION query)**

The current query does `SELECT DISTINCT channel_id FROM messages WHERE server_id = ? UNION SELECT DISTINCT channel_id FROM mutations WHERE server_id = ?`.

Diesel doesn't have a `UNION` API. Options:
1. Two queries + merge + dedup in Rust
2. `diesel::sql_query()` escape hatch

**Recommended:** Two queries + dedup:
```rust
let mut channels: Vec<String> = messages::table
    .filter(messages::server_id.eq(&server_id))
    .select(messages::channel_id)
    .distinct()
    .load(conn)
    .map_err(|e| e.to_string())?;

let mut mutation_channels: Vec<String> = mutations::table
    .filter(mutations::server_id.eq(&server_id))
    .select(mutations::channel_id)
    .distinct()
    .load(conn)
    .map_err(|e| e.to_string())?;

channels.append(&mut mutation_channels);
channels.sort_unstable();
channels.dedup();
```

- [ ] **Step 5: Verify & commit**

```bash
cd src-tauri && cargo check && cargo test
git commit -m "feat: convert sync commands to Diesel query builder"
```

---

### Task 10: Convert Archive Commands

**Files:**
- Modify: `src-tauri/src/commands/archive_commands.rs`

- [ ] **Step 1: Convert `db_export_archive`**

Replace multi-table SELECT queries with Diesel queries. Each table load becomes:
```rust
let msgs = messages::table.filter(messages::server_id.eq(&sid)).select(MessageRow::as_select()).load(conn)?;
let muts = mutations::table.filter(mutations::server_id.eq(&sid)).select(MutationRow::as_select()).load(conn)?;
// etc.
```

Apply `history_starts_at` filter where needed (same as sync).

- [ ] **Step 2: Convert `db_import_archive`**

Replace batch INSERT OR REPLACE / INSERT OR IGNORE with Diesel equivalents:
```rust
// Servers: INSERT OR REPLACE
diesel::replace_into(servers::table).values(&new_server).execute(conn)?;
// Messages: INSERT OR IGNORE
diesel::insert_or_ignore_into(messages::table).values(&new_message).execute(conn)?;
```

- [ ] **Step 3: Convert `db_save_rebaseline`**

```rust
diesel::update(servers::table.find(&server_id))
    .set(servers::history_starts_at.eq(&timestamp))
    .execute(conn)
    .map_err(|e| e.to_string())?;
```

- [ ] **Step 4: Verify & commit**

```bash
cd src-tauri && cargo check && cargo test
git commit -m "feat: convert archive commands to Diesel query builder"
```

---

### Task 11: Clean Up — Remove rusqlite, Final Verification

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Delete: `src-tauri/src/db/migrations.rs`
- Remove old flat migration SQL files (now in Diesel directory structure)

- [ ] **Step 1: Remove `rusqlite` and `rusqlite_migration` from `Cargo.toml`**

```toml
# Remove these lines:
# rusqlite = { version = "0.32", features = ["bundled"] }
# rusqlite_migration = "..."
```

**Note:** If any code still uses `rusqlite` types (e.g. `rusqlite::Error`), fix those first.

- [ ] **Step 2: Delete `src-tauri/src/db/migrations.rs`**

This file contained the `rusqlite_migration::Migrations::new(...)` runner. It's replaced by `embed_migrations!()` in `db/mod.rs`.

- [ ] **Step 3: Clean up old migration files**

Remove the flat SQL files that have been reorganized into Diesel's directory structure. Keep the `migrations/` directory with the new Diesel format.

- [ ] **Step 4: Full verification**

```bash
cd src-tauri && cargo check && cargo test
cd .. && npm run build
npm run dev:tauri  # Visual smoke test: create server, send messages, react, search
```

- [ ] **Step 5: Run all tests**

```bash
cd src-tauri && cargo test
cd .. && npm run test
```

- [ ] **Step 6: Commit**

```bash
git commit -m "chore: remove rusqlite dependency, complete Diesel migration"
```

---

### Task 12: Update TODO.md + CLAUDE.md

- [ ] **Step 1: Update `docs/TODO.md`** with Diesel migration checkboxes
- [ ] **Step 2: Update `CLAUDE.md`** — change rusqlite references to Diesel in:
  - Project Structure section
  - Build Commands section
  - Rust/Tauri Standards section (update borrow checker patterns for Diesel)
  - Known Pitfalls (remove rusqlite-specific pitfalls, add any new Diesel ones)
  - Key Architectural Decisions
- [ ] **Step 3: Commit**

```bash
git commit -m "docs: update TODO.md and CLAUDE.md for Diesel migration"
```

---

## Notes

### Migration Coexistence Strategy

During the migration (Tasks 1-10), both `rusqlite` and `diesel` dependencies coexist. This works because:
1. Diesel's SQLite backend uses `libsqlite3-sys` — the same C library that rusqlite wraps
2. Cargo deduplicates `libsqlite3-sys` if versions are compatible
3. The `Mutex<Connection>` in AppState switches from `rusqlite::Connection` to `diesel::SqliteConnection` in Task 4
4. Commands are converted module by module — each commit is independently compilable and testable

If `libsqlite3-sys` version conflicts arise, see Task 1 for resolution strategies.

### FTS5 Limitations

Diesel has no FTS5 support. The following remain as `diesel::sql_query()`:
- `db_search_messages` — FTS5 MATCH query
- FTS5 content-sync triggers — DDL in migration SQL, not touched by Diesel

This is a permanent limitation, not a temporary compromise. The FTS5 queries are isolated to one command.

### Performance Considerations

- Diesel's query builder generates the same SQL as hand-written queries — no performance overhead
- `.eq_any()` with large vectors: chunk at 900 to stay under SQLite's variable limit
- Batch inserts in sync: loop + single transaction (Diesel SQLite doesn't support multi-row INSERT OR IGNORE)
- `select(Model::as_select())` uses `SELECT *` equivalent — same column set as before

### Testing Strategy

- Existing `cargo test` tests should pass after each task (if they used the public command API)
- Tests that directly call `rusqlite::Connection` methods need updating to use Diesel's `SqliteConnection`
- The `test_conn()` helper becomes:
  ```rust
  #[cfg(test)]
  fn test_conn() -> diesel::SqliteConnection {
      let mut conn = diesel::SqliteConnection::establish(":memory:").unwrap();
      conn.run_pending_migrations(crate::db::MIGRATIONS).unwrap();
      conn
  }
  ```

### Rollback Plan

If Diesel proves problematic mid-migration:
1. Revert to the commit before Task 4 (AppState switch)
2. All code before that point compiles with rusqlite
3. The Diesel schema/models files can remain for future reference

### Estimated Scope

| Area | Lines of Raw SQL Removed | Diesel Lines Added |
|------|--------------------------|-------------------|
| Message commands | ~80 | ~60 |
| Mutation commands + side effects | ~200 | ~150 |
| Server/Channel/Member/Key | ~60 | ~45 |
| Emoji/Device/Invite/Ban/ACL/JoinReq/ModLog | ~150 | ~120 |
| Sync commands | ~80 | ~70 |
| Archive commands | ~60 | ~50 |
| Schema + Models (new) | 0 | ~350 |
| **Total** | **~630 removed** | **~845 added** |

Net increase of ~215 lines, but all SQL is now compile-time checked and centralized in `schema.rs` + `models.rs`.
