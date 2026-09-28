use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use negentropy::{Id, Negentropy, NegentropyStorageVector};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::AppState;
use crate::db::types::{MessageRow, MutationRow};

// ── Wire types ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct SyncDiff {
    pub have_ids: Vec<String>,
    pub need_ids: Vec<String>,
}

/// Validated table identifier — only "messages" or "mutations" are accepted.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncTable {
    Messages,
    Mutations,
}

// ── UUID v7 helpers ───────────────────────────────────────────────────────────

/// Parse a UUID v7 string into a 32-byte negentropy `Id` (zero-padded) and a
/// u64 millisecond timestamp extracted from the first 6 bytes.
fn uuid_to_neg_id(id_str: &str) -> Result<(u64, Id), String> {
    let uuid = Uuid::parse_str(id_str).map_err(|e| format!("bad UUID {id_str}: {e}"))?;
    let b = uuid.as_bytes();

    // UUID v7: first 6 bytes are the 48-bit Unix-ms timestamp (big-endian)
    let ts_ms = ((b[0] as u64) << 40)
        | ((b[1] as u64) << 32)
        | ((b[2] as u64) << 24)
        | ((b[3] as u64) << 16)
        | ((b[4] as u64) << 8)
        | (b[5] as u64);

    // Pad 16-byte UUID to 32 bytes (zero-fill upper half)
    let mut id_bytes = [0u8; 32];
    id_bytes[..16].copy_from_slice(b);
    Ok((ts_ms, Id::from_byte_array(id_bytes)))
}

/// Convert a negentropy `Id` back to a UUID string (read first 16 bytes only).
fn neg_id_to_uuid(id: &Id) -> String {
    let bytes = id.as_bytes(); // &[u8; 32]
    let mut uuid_bytes = [0u8; 16];
    uuid_bytes.copy_from_slice(&bytes[..16]);
    Uuid::from_bytes(uuid_bytes).to_string()
}

// ── Storage builder ───────────────────────────────────────────────────────────

/// Build a sealed `NegentropyStorageVector` from (timestamp, id) pairs.
/// `seal()` sorts items internally so insertion order does not matter.
fn build_storage(items: Vec<(u64, Id)>) -> Result<NegentropyStorageVector, String> {
    let mut storage = NegentropyStorageVector::with_capacity(items.len());
    for (ts, id) in items {
        storage.insert(ts, id).map_err(|e| e.to_string())?;
    }
    storage.seal().map_err(|e| e.to_string())?;
    Ok(storage)
}

// ── Sync scope (which server a row belongs to) ───────────────────────────────

/// Pseudo channel ID that holds server-level mutations (members, channels, emoji…).
const SERVER_CHANNEL: &str = "__server__";

/// Server-level mutation types whose `target_id` is the server ID.
const SERVER_TARGET_TYPES: [&str; 3] = ["server_update", "access_mode_update", "server_rebaseline"];

/// The server a server-level (`__server__`) mutation belongs to, derived from
/// the row alone so that both peers always agree on it (a DB lookup would
/// differ once one peer has applied a `channel_delete` / `emoji_remove`).
/// Returns `None` for rows that cannot be attributed; those never sync.
fn server_mutation_server_id(
    mutation_type: &str,
    target_id: &str,
    new_content: Option<&str>,
) -> Option<String> {
    if SERVER_TARGET_TYPES.contains(&mutation_type) || mutation_type.starts_with("governance_") {
        return (!target_id.is_empty()).then(|| target_id.to_string());
    }
    let value: serde_json::Value = serde_json::from_str(new_content?).ok()?;
    value
        .get("serverId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Server ID of a regular channel, or `None` if we don't have the channel.
fn channel_server_id(conn: &rusqlite::Connection, channel_id: &str) -> Result<Option<String>, String> {
    match conn.query_row("SELECT server_id FROM channels WHERE id = ?1", [channel_id], |r| r.get(0)) {
        Ok(id) => Ok(Some(id)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Validate a (server, channel) sync scope: the server ID must be non-empty and
/// a regular channel must belong to that server. The frontend has already
/// checked that the peer shares the server; this makes sure a frame can't
/// name a channel of some other server under it.
fn check_scope(conn: &rusqlite::Connection, server_id: &str, channel_id: &str) -> Result<(), String> {
    if server_id.is_empty() || channel_id.is_empty() {
        return Err("sync scope: empty server or channel ID".into());
    }
    if channel_id == SERVER_CHANNEL {
        return Ok(());
    }
    match channel_server_id(conn, channel_id)? {
        Some(sid) if sid == server_id => Ok(()),
        _ => Err(format!("sync scope: channel {channel_id} is not in server {server_id}")),
    }
}

/// True when a mutation row belongs to the (server, channel) scope.
/// Callers must have run `check_scope` for regular channels.
fn mutation_in_scope(m: &MutationRow, server_id: &str, channel_id: &str) -> bool {
    if m.channel_id != channel_id {
        return false;
    }
    if channel_id != SERVER_CHANNEL {
        return true;
    }
    server_mutation_server_id(&m.mutation_type, &m.target_id, m.new_content.as_deref()).as_deref()
        == Some(server_id)
}

/// Load (timestamp, id) pairs for the given channel + table from SQLite,
/// scoped to `server_id` (see `check_scope` / `server_mutation_server_id`).
/// Messages before the server's `history_starts_at` are excluded so re-baselined
/// servers don't gossip pre-baseline history to new peers.
fn load_items(
    conn: &rusqlite::Connection,
    server_id: &str,
    channel_id: &str,
    table: &SyncTable,
) -> Result<Vec<(u64, Id)>, String> {
    check_scope(conn, server_id, channel_id)?;

    if channel_id == SERVER_CHANNEL {
        return load_server_mutation_items(conn, server_id, table);
    }

    // Look up history_starts_at for this channel's server (may be NULL).
    let history_starts_at: Option<String> = {
        conn.query_row(
            "SELECT s.history_starts_at FROM servers s
             JOIN channels c ON c.server_id = s.id
             WHERE c.id = ?1",
            [channel_id],
            |r| r.get(0),
        )
        .unwrap_or(None)
    };

    let ids: Vec<String> = match (&table, &history_starts_at) {
        (SyncTable::Messages, Some(hist)) => {
            let sql = "SELECT id FROM messages WHERE channel_id = ?1 AND logical_ts >= ?2 ORDER BY logical_ts ASC";
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![channel_id, hist], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        }
        (SyncTable::Mutations, Some(hist)) => {
            let sql = "SELECT id FROM mutations WHERE channel_id = ?1 AND logical_ts >= ?2 ORDER BY logical_ts ASC";
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![channel_id, hist], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        }
        _ => {
            let sql = match table {
                SyncTable::Messages  => "SELECT id FROM messages WHERE channel_id = ?1 ORDER BY logical_ts ASC",
                SyncTable::Mutations => "SELECT id FROM mutations WHERE channel_id = ?1 ORDER BY logical_ts ASC",
            };
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([channel_id], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        }
    };

    ids.iter()
        .map(|s| uuid_to_neg_id(s))
        .collect::<Result<Vec<_>, _>>()
}

/// Server-wide pass: only the `__server__` mutations that belong to `server_id`.
/// These always sync regardless of rebaseline so new joiners see all members.
fn load_server_mutation_items(
    conn: &rusqlite::Connection,
    server_id: &str,
    table: &SyncTable,
) -> Result<Vec<(u64, Id)>, String> {
    if !matches!(table, SyncTable::Mutations) {
        return Err("sync scope: the server-wide pass only syncs mutations".into());
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, type, target_id, new_content FROM mutations
             WHERE channel_id = ?1 ORDER BY logical_ts ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([SERVER_CHANNEL], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    rows.iter()
        .filter(|(_, m_type, target_id, new_content)| {
            server_mutation_server_id(m_type, target_id, new_content.as_deref()).as_deref() == Some(server_id)
        })
        .map(|(id, _, _, _)| uuid_to_neg_id(id))
        .collect::<Result<Vec<_>, _>>()
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Initiator side: build our negentropy storage and produce the initial message.
/// Returns a base64-encoded bytes blob to send to the remote peer.
#[tauri::command]
pub fn sync_initiate(
    state: State<AppState>,
    server_id: String,
    channel_id: String,
    table: SyncTable,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let items = load_items(&conn, &server_id, &channel_id, &table)?;
    let storage = build_storage(items)?;
    let mut neg = Negentropy::owned(storage, 0).map_err(|e| e.to_string())?;
    let msg = neg.initiate().map_err(|e| e.to_string())?;
    Ok(BASE64.encode(msg))
}

/// Responder side: given the initiator's message, produce a reply.
/// Returns a base64-encoded reply to send back to the initiator.
#[tauri::command]
pub fn sync_respond(
    state: State<AppState>,
    server_id: String,
    channel_id: String,
    table: SyncTable,
    msg: String,
) -> Result<String, String> {
    let raw = BASE64.decode(msg).map_err(|e| e.to_string())?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let items = load_items(&conn, &server_id, &channel_id, &table)?;
    let storage = build_storage(items)?;
    let mut neg = Negentropy::owned(storage, 0).map_err(|e| e.to_string())?;
    let reply = neg.reconcile(&raw).map_err(|e| e.to_string())?;
    Ok(BASE64.encode(reply))
}

/// Initiator side: process the responder's reply message.
/// Returns which IDs we have (to push to peer) and which we need (to pull from peer).
/// With frame_size_limit=0 this always converges in one round so next_msg is always None.
#[tauri::command]
pub fn sync_process_response(
    state: State<AppState>,
    server_id: String,
    channel_id: String,
    table: SyncTable,
    msg: String,
) -> Result<SyncDiff, String> {
    let raw = BASE64.decode(msg).map_err(|e| e.to_string())?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let items = load_items(&conn, &server_id, &channel_id, &table)?;
    let storage = build_storage(items)?;
    let mut neg = Negentropy::owned(storage, 0).map_err(|e| e.to_string())?;
    neg.set_initiator();

    let mut have_neg_ids: Vec<Id> = Vec::new();
    let mut need_neg_ids: Vec<Id> = Vec::new();
    neg.reconcile_with_ids(&raw, &mut have_neg_ids, &mut need_neg_ids)
        .map_err(|e| e.to_string())?;

    Ok(SyncDiff {
        have_ids: have_neg_ids.iter().map(neg_id_to_uuid).collect(),
        need_ids: need_neg_ids.iter().map(neg_id_to_uuid).collect(),
    })
}

/// Fetch full message rows for the given IDs (used to push content to peer).
/// Only rows of `channel_id` in `server_id` are returned, whatever IDs the
/// peer asked for, so a `sync_want` can't pull another server's history.
#[tauri::command]
pub fn sync_get_messages(
    state: State<AppState>,
    server_id: String,
    channel_id: String,
    ids: Vec<String>,
) -> Result<Vec<MessageRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    get_messages_scoped(&conn, &server_id, &channel_id, &ids)
}

fn get_messages_scoped(
    conn: &rusqlite::Connection,
    server_id: &str,
    channel_id: &str,
    ids: &[String],
) -> Result<Vec<MessageRow>, String> {
    check_scope(conn, server_id, channel_id)?;
    if channel_id == SERVER_CHANNEL {
        return Ok(vec![]);
    }
    let mut rows = load_messages_by_id(conn, ids)?;
    rows.retain(|m| m.channel_id == channel_id && m.server_id == server_id);
    Ok(rows)
}

fn load_messages_by_id(conn: &rusqlite::Connection, ids: &[String]) -> Result<Vec<MessageRow>, String> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders = ids.iter().enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, channel_id, server_id, author_id, content, content_type,
         reply_to_id, created_at, logical_ts, verified, raw_attachments
         FROM messages WHERE id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok(MessageRow {
                id:              row.get(0)?,
                channel_id:      row.get(1)?,
                server_id:       row.get(2)?,
                author_id:       row.get(3)?,
                content:         row.get(4)?,
                content_type:    row.get(5)?,
                reply_to_id:     row.get(6)?,
                created_at:      row.get(7)?,
                logical_ts:      row.get(8)?,
                verified:        row.get::<_, i64>(9)? != 0,
                raw_attachments: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Fetch full mutation rows for the given IDs, limited to the
/// (`server_id`, `channel_id`) scope like `sync_get_messages`.
#[tauri::command]
pub fn sync_get_mutations(
    state: State<AppState>,
    server_id: String,
    channel_id: String,
    ids: Vec<String>,
) -> Result<Vec<MutationRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    get_mutations_scoped(&conn, &server_id, &channel_id, &ids)
}

fn get_mutations_scoped(
    conn: &rusqlite::Connection,
    server_id: &str,
    channel_id: &str,
    ids: &[String],
) -> Result<Vec<MutationRow>, String> {
    check_scope(conn, server_id, channel_id)?;
    let mut rows = load_mutations_by_id(conn, ids)?;
    rows.retain(|m| mutation_in_scope(m, server_id, channel_id));
    Ok(rows)
}

fn load_mutations_by_id(conn: &rusqlite::Connection, ids: &[String]) -> Result<Vec<MutationRow>, String> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders = ids.iter().enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, type, target_id, channel_id, author_id, new_content,
         emoji_id, logical_ts, created_at, verified, sig
         FROM mutations WHERE id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok(MutationRow {
                id:             row.get(0)?,
                mutation_type:  row.get(1)?,
                target_id:      row.get(2)?,
                channel_id:     row.get(3)?,
                author_id:      row.get(4)?,
                new_content:    row.get(5)?,
                emoji_id:       row.get(6)?,
                logical_ts:     row.get(7)?,
                created_at:     row.get(8)?,
                verified:       row.get::<_, i64>(9)? != 0,
                sig:            row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Batch-save incoming message rows from a peer (INSERT OR IGNORE — never overwrite local edits).
/// Silently skips rows that violate FK constraints (e.g. channel not yet synced).
#[tauri::command]
pub fn sync_save_messages(
    state: State<AppState>,
    messages: Vec<MessageRow>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    for msg in &messages {
        match conn.execute(
            "INSERT OR IGNORE INTO messages
             (id, channel_id, server_id, author_id, content, content_type,
              reply_to_id, created_at, logical_ts, verified, raw_attachments)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![
                msg.id, msg.channel_id, msg.server_id, msg.author_id,
                msg.content, msg.content_type, msg.reply_to_id,
                msg.created_at, msg.logical_ts, msg.verified as i64, msg.raw_attachments
            ],
        ) {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ffi::ErrorCode::ConstraintViolation =>
            {
                // FK constraint — channel/server not created yet; skip silently.
                // The next sync round will pick up the missing messages.
                log::debug!("sync_save_messages: skipping msg {} (FK constraint)", msg.id);
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// Batch-save incoming mutation rows from a peer (INSERT OR IGNORE).
#[tauri::command]
pub fn sync_save_mutations(
    state: State<AppState>,
    mutations: Vec<MutationRow>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    for m in &mutations {
        conn.execute(
            "INSERT OR IGNORE INTO mutations
             (id, type, target_id, channel_id, author_id, new_content,
              emoji_id, logical_ts, created_at, verified, sig)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![
                m.id, m.mutation_type, m.target_id, m.channel_id, m.author_id,
                m.new_content, m.emoji_id, m.logical_ts, m.created_at, m.verified as i64,
                m.sig
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A channel to reconcile, with the server it belongs to.
#[derive(Serialize)]
pub struct SyncChannel {
    pub channel_id: String,
    pub server_id: String,
}

/// Most servers a single `sync_list_channels` call may name.
const MAX_SYNC_SERVERS: usize = 500;

/// List the channels of the given servers (the ones this peer shares with us).
/// Used by the sync service to know which channels to reconcile with a peer.
#[tauri::command]
pub fn sync_list_channels(
    state: State<AppState>,
    server_ids: Vec<String>,
) -> Result<Vec<SyncChannel>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    list_channels(&conn, &server_ids)
}

fn list_channels(conn: &rusqlite::Connection, server_ids: &[String]) -> Result<Vec<SyncChannel>, String> {
    if server_ids.is_empty() {
        return Ok(vec![]);
    }
    if server_ids.len() > MAX_SYNC_SERVERS {
        return Err(format!("sync_list_channels: at most {MAX_SYNC_SERVERS} servers"));
    }
    if server_ids.iter().any(|s| s.is_empty()) {
        return Err("sync_list_channels: empty server ID".into());
    }
    let placeholders = (1..=server_ids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, server_id FROM channels WHERE server_id IN ({placeholders}) ORDER BY server_id, position"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(server_ids.iter()), |r| {
            Ok(SyncChannel { channel_id: r.get(0)?, server_id: r.get(1)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Receive-side gate: keep only the pushed messages that belong to the frame's
/// (`server_id`, `channel_id`) scope. Rows for another channel or server, or for
/// a channel we don't have in that server, are dropped.
#[tauri::command]
pub fn sync_scope_messages(
    state: State<AppState>,
    server_id: String,
    channel_id: String,
    messages: Vec<MessageRow>,
) -> Result<Vec<MessageRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    scope_messages(&conn, &server_id, &channel_id, messages)
}

fn scope_messages(
    conn: &rusqlite::Connection,
    server_id: &str,
    channel_id: &str,
    mut messages: Vec<MessageRow>,
) -> Result<Vec<MessageRow>, String> {
    if channel_id == SERVER_CHANNEL || check_scope(conn, server_id, channel_id).is_err() {
        return Ok(vec![]);
    }
    messages.retain(|m| m.channel_id == channel_id && m.server_id == server_id);
    Ok(messages)
}

/// Receive-side gate for pushed mutations; see `sync_scope_messages`.
/// `__server__` rows are kept only when they belong to `server_id`.
#[tauri::command]
pub fn sync_scope_mutations(
    state: State<AppState>,
    server_id: String,
    channel_id: String,
    mutations: Vec<MutationRow>,
) -> Result<Vec<MutationRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    scope_mutations(&conn, &server_id, &channel_id, mutations)
}

fn scope_mutations(
    conn: &rusqlite::Connection,
    server_id: &str,
    channel_id: &str,
    mut mutations: Vec<MutationRow>,
) -> Result<Vec<MutationRow>, String> {
    if check_scope(conn, server_id, channel_id).is_err() {
        return Ok(vec![]);
    }
    mutations.retain(|m| mutation_in_scope(m, server_id, channel_id));
    Ok(mutations)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let mut conn = Connection::open_in_memory().expect("in-memory DB");
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        migrations::run(&mut conn);
        conn
    }

    fn uid(n: u32) -> String {
        format!("0190a000-0000-7000-8000-{n:012}")
    }

    /// Servers A and B, channel ca in A and cb in B.
    fn seed(conn: &Connection) {
        for s in ["srv-a", "srv-b"] {
            conn.execute(
                "INSERT INTO servers (id, name, owner_id, created_at, raw_json) VALUES (?1, ?1, 'owner', '2025-01-01', '{}')",
                [s],
            ).unwrap();
        }
        for (c, s) in [("ca", "srv-a"), ("cb", "srv-b")] {
            conn.execute(
                "INSERT INTO channels (id, server_id, name, created_at) VALUES (?1, ?2, ?1, '2025-01-01')",
                [c, s],
            ).unwrap();
        }
    }

    fn message(id: &str, channel_id: &str, server_id: &str) -> MessageRow {
        MessageRow {
            id: id.into(),
            channel_id: channel_id.into(),
            server_id: server_id.into(),
            author_id: "alice".into(),
            content: Some("hi".into()),
            content_type: "text".into(),
            reply_to_id: None,
            created_at: "2025-01-01".into(),
            logical_ts: format!("1-{id}"),
            verified: true,
            raw_attachments: None,
        }
    }

    fn mutation(id: &str, m_type: &str, target_id: &str, channel_id: &str, new_content: Option<&str>) -> MutationRow {
        MutationRow {
            id: id.into(),
            mutation_type: m_type.into(),
            target_id: target_id.into(),
            channel_id: channel_id.into(),
            author_id: "alice".into(),
            new_content: new_content.map(str::to_string),
            emoji_id: None,
            logical_ts: format!("1-{id}"),
            created_at: "2025-01-01".into(),
            verified: true,
            sig: None,
        }
    }

    fn insert_message(conn: &Connection, m: &MessageRow) {
        conn.execute(
            "INSERT INTO messages (id, channel_id, server_id, author_id, content, content_type,
             created_at, logical_ts, verified) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1)",
            rusqlite::params![m.id, m.channel_id, m.server_id, m.author_id, m.content,
                              m.content_type, m.created_at, m.logical_ts],
        ).unwrap();
    }

    fn insert_mutation(conn: &Connection, m: &MutationRow) {
        conn.execute(
            "INSERT INTO mutations (id, type, target_id, channel_id, author_id, new_content,
             logical_ts, created_at, verified) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1)",
            rusqlite::params![m.id, m.mutation_type, m.target_id, m.channel_id, m.author_id,
                              m.new_content, m.logical_ts, m.created_at],
        ).unwrap();
    }

    fn ids_of<T>(rows: &[T], id: impl Fn(&T) -> &str) -> Vec<String> {
        rows.iter().map(|r| id(r).to_string()).collect()
    }

    #[test]
    fn server_mutation_attribution_by_type() {
        let a = Some("srv-a".to_string());
        assert_eq!(server_mutation_server_id("server_update", "srv-a", Some(r#"{"name":"x"}"#)), a);
        assert_eq!(server_mutation_server_id("access_mode_update", "srv-a", None), a);
        // server_rebaseline's new_content is a bare timestamp, not JSON
        assert_eq!(server_mutation_server_id("server_rebaseline", "srv-a", Some("2025-01-01T00:00:00Z")), a);
        assert_eq!(server_mutation_server_id("governance_motion_create", "srv-a", Some("{}")), a);
        assert_eq!(server_mutation_server_id("member_join", "bob", Some(r#"{"serverId":"srv-a","userId":"bob"}"#)), a);
        assert_eq!(server_mutation_server_id("channel_create", "ca", Some(r#"{"id":"ca","serverId":"srv-a"}"#)), a);
        assert_eq!(server_mutation_server_id("channel_delete", "ca", Some(r#"{"serverId":"srv-a"}"#)), a);
        assert_eq!(server_mutation_server_id("emoji_remove", "e1", Some(r#"{"serverId":"srv-a"}"#)), a);
        // Unattributable rows never sync
        assert_eq!(server_mutation_server_id("channel_delete", "ca", None), None);
        assert_eq!(server_mutation_server_id("member_join", "bob", Some("not json")), None);
        assert_eq!(server_mutation_server_id("member_join", "bob", Some(r#"{"serverId":""}"#)), None);
        assert_eq!(server_mutation_server_id("server_update", "", None), None);
    }

    #[test]
    fn server_pass_loads_only_that_servers_mutations() {
        let conn = test_conn();
        seed(&conn);
        insert_mutation(&conn, &mutation(&uid(1), "member_join", "bob", SERVER_CHANNEL, Some(r#"{"serverId":"srv-a"}"#)));
        insert_mutation(&conn, &mutation(&uid(2), "server_update", "srv-b", SERVER_CHANNEL, Some("{}")));
        insert_mutation(&conn, &mutation(&uid(3), "channel_delete", "cz", SERVER_CHANNEL, None));

        let a = load_items(&conn, "srv-a", SERVER_CHANNEL, &SyncTable::Mutations).unwrap();
        assert_eq!(a.iter().map(|(_, id)| neg_id_to_uuid(id)).collect::<Vec<_>>(), vec![uid(1)]);
        let b = load_items(&conn, "srv-b", SERVER_CHANNEL, &SyncTable::Mutations).unwrap();
        assert_eq!(b.iter().map(|(_, id)| neg_id_to_uuid(id)).collect::<Vec<_>>(), vec![uid(2)]);
        assert!(load_items(&conn, "srv-a", SERVER_CHANNEL, &SyncTable::Messages).is_err());
    }

    #[test]
    fn channel_pass_rejects_channel_of_another_server() {
        let conn = test_conn();
        seed(&conn);
        insert_message(&conn, &message(&uid(1), "cb", "srv-b"));
        assert!(load_items(&conn, "srv-a", "cb", &SyncTable::Messages).is_err());
        assert!(load_items(&conn, "srv-a", "missing", &SyncTable::Messages).is_err());
        assert!(load_items(&conn, "", "cb", &SyncTable::Messages).is_err());
        assert_eq!(load_items(&conn, "srv-b", "cb", &SyncTable::Messages).unwrap().len(), 1);
    }

    #[test]
    fn get_messages_never_serves_ids_outside_the_scope() {
        let conn = test_conn();
        seed(&conn);
        insert_message(&conn, &message(&uid(1), "ca", "srv-a"));
        insert_message(&conn, &message(&uid(2), "cb", "srv-b"));
        let ids = vec![uid(1), uid(2)];

        // A want for channel ca that also names B's message only gets ca's row
        let rows = get_messages_scoped(&conn, "srv-a", "ca", &ids).unwrap();
        assert_eq!(ids_of(&rows, |m| &m.id), vec![uid(1)]);
        // A frame naming B's channel under server A is refused outright
        assert!(get_messages_scoped(&conn, "srv-a", "cb", &ids).is_err());
        assert!(get_messages_scoped(&conn, "srv-a", SERVER_CHANNEL, &ids).unwrap().is_empty());
    }

    #[test]
    fn get_mutations_scopes_server_and_channel_rows() {
        let conn = test_conn();
        seed(&conn);
        insert_mutation(&conn, &mutation(&uid(1), "member_join", "bob", SERVER_CHANNEL, Some(r#"{"serverId":"srv-a"}"#)));
        insert_mutation(&conn, &mutation(&uid(2), "member_join", "eve", SERVER_CHANNEL, Some(r#"{"serverId":"srv-b"}"#)));
        insert_mutation(&conn, &mutation(&uid(3), "reaction_add", "m1", "ca", None));
        insert_mutation(&conn, &mutation(&uid(4), "reaction_add", "m2", "cb", None));
        let ids: Vec<String> = (1..=4).map(uid).collect();

        let server_rows = get_mutations_scoped(&conn, "srv-a", SERVER_CHANNEL, &ids).unwrap();
        assert_eq!(ids_of(&server_rows, |m| &m.id), vec![uid(1)]);
        let channel_rows = get_mutations_scoped(&conn, "srv-a", "ca", &ids).unwrap();
        assert_eq!(ids_of(&channel_rows, |m| &m.id), vec![uid(3)]);
        assert!(get_mutations_scoped(&conn, "srv-a", "cb", &ids).is_err());
    }

    #[test]
    fn list_channels_only_returns_the_given_servers() {
        let conn = test_conn();
        seed(&conn);
        let rows = list_channels(&conn, &["srv-a".to_string()]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].channel_id.as_str(), rows[0].server_id.as_str()), ("ca", "srv-a"));
        assert!(list_channels(&conn, &[]).unwrap().is_empty());
        assert!(list_channels(&conn, &[String::new()]).is_err());
        let too_many: Vec<String> = (0..=MAX_SYNC_SERVERS).map(|i| format!("s{i}")).collect();
        assert!(list_channels(&conn, &too_many).is_err());
    }

    #[test]
    fn scope_messages_drops_foreign_rows() {
        let conn = test_conn();
        seed(&conn);
        let pushed = vec![
            message(&uid(1), "ca", "srv-a"),
            message(&uid(2), "cb", "srv-b"),
            message(&uid(3), "ca", "srv-b"), // row claims another server
        ];
        let kept = scope_messages(&conn, "srv-a", "ca", pushed.clone()).unwrap();
        assert_eq!(ids_of(&kept, |m| &m.id), vec![uid(1)]);
        // Frame claims channel cb is in server A
        assert!(scope_messages(&conn, "srv-a", "cb", pushed.clone()).unwrap().is_empty());
        assert!(scope_messages(&conn, "srv-a", SERVER_CHANNEL, pushed).unwrap().is_empty());
    }

    #[test]
    fn scope_mutations_drops_foreign_rows() {
        let conn = test_conn();
        seed(&conn);
        let pushed = vec![
            mutation(&uid(1), "channel_create", "cn", SERVER_CHANNEL, Some(r#"{"id":"cn","serverId":"srv-a"}"#)),
            mutation(&uid(2), "server_update", "srv-b", SERVER_CHANNEL, Some("{}")),
            mutation(&uid(3), "reaction_add", "m1", "ca", None),
        ];
        let kept = scope_mutations(&conn, "srv-a", SERVER_CHANNEL, pushed.clone()).unwrap();
        assert_eq!(ids_of(&kept, |m| &m.id), vec![uid(1)]);
        let kept = scope_mutations(&conn, "srv-a", "ca", pushed.clone()).unwrap();
        assert_eq!(ids_of(&kept, |m| &m.id), vec![uid(3)]);
        assert!(scope_mutations(&conn, "srv-b", "ca", pushed).unwrap().is_empty());
    }
}
