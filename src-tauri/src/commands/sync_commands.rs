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

/// Load (timestamp, id) pairs for the given channel + table from SQLite.
fn load_items(
    conn: &rusqlite::Connection,
    channel_id: &str,
    table: &SyncTable,
) -> Result<Vec<(u64, Id)>, String> {
    let sql = match table {
        SyncTable::Messages =>
            "SELECT id FROM messages WHERE channel_id = ?1 ORDER BY logical_ts ASC",
        SyncTable::Mutations =>
            "SELECT id FROM mutations WHERE channel_id = ?1 ORDER BY logical_ts ASC",
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map([channel_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    ids.iter()
        .map(|s| uuid_to_neg_id(s))
        .collect::<Result<Vec<_>, _>>()
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Initiator side: build our negentropy storage and produce the initial message.
/// Returns a base64-encoded bytes blob to send to the remote peer.
#[tauri::command]
pub fn sync_initiate(
    state: State<AppState>,
    channel_id: String,
    table: SyncTable,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let items = load_items(&conn, &channel_id, &table)?;
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
    channel_id: String,
    table: SyncTable,
    msg: String,
) -> Result<String, String> {
    let raw = BASE64.decode(msg).map_err(|e| e.to_string())?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let items = load_items(&conn, &channel_id, &table)?;
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
    channel_id: String,
    table: SyncTable,
    msg: String,
) -> Result<SyncDiff, String> {
    let raw = BASE64.decode(msg).map_err(|e| e.to_string())?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let items = load_items(&conn, &channel_id, &table)?;
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
#[tauri::command]
pub fn sync_get_messages(
    state: State<AppState>,
    ids: Vec<String>,
) -> Result<Vec<MessageRow>, String> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
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

/// Fetch full mutation rows for the given IDs.
#[tauri::command]
pub fn sync_get_mutations(
    state: State<AppState>,
    ids: Vec<String>,
) -> Result<Vec<MutationRow>, String> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let placeholders = ids.iter().enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, type, target_id, channel_id, author_id, new_content,
         emoji_id, logical_ts, created_at, verified
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
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Batch-save incoming message rows from a peer (INSERT OR IGNORE — never overwrite local edits).
#[tauri::command]
pub fn sync_save_messages(
    state: State<AppState>,
    messages: Vec<MessageRow>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    for msg in &messages {
        conn.execute(
            "INSERT OR IGNORE INTO messages
             (id, channel_id, server_id, author_id, content, content_type,
              reply_to_id, created_at, logical_ts, verified, raw_attachments)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![
                msg.id, msg.channel_id, msg.server_id, msg.author_id,
                msg.content, msg.content_type, msg.reply_to_id,
                msg.created_at, msg.logical_ts, msg.verified as i64, msg.raw_attachments
            ],
        )
        .map_err(|e| e.to_string())?;
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
              emoji_id, logical_ts, created_at, verified)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            rusqlite::params![
                m.id, m.mutation_type, m.target_id, m.channel_id, m.author_id,
                m.new_content, m.emoji_id, m.logical_ts, m.created_at, m.verified as i64
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// List all distinct channel IDs present in the local messages + mutations tables.
/// Used by the sync service to know which channels to reconcile with a peer.
#[tauri::command]
pub fn sync_list_channels(state: State<AppState>) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT channel_id FROM messages
             UNION
             SELECT DISTINCT channel_id FROM mutations
             WHERE channel_id != '__server__'",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ids)
}
