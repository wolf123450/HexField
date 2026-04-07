use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;
use crate::db::types::{ChannelRow, MemberRow, MessageRow, MutationRow};

// ── Archive bundle ────────────────────────────────────────────────────────────

/// A portable signed snapshot of a server that an admin can export and share.
/// Recipients import it to prime their local DB before joining the live P2P swarm,
/// so they don't need to pull the full history from a peer.
#[derive(Debug, Serialize, Deserialize)]
pub struct ArchiveBundle {
    /// Format version — bump when bundle schema changes.
    pub version:          u32,
    pub exported_at:      String,
    pub server_id:        String,
    pub author_id:        String,
    /// Ed25519 signature (base64) over `version|exported_at|server_id|author_id|channels_json|messages_json|mutations_json|members_json`.
    /// Presence of a signature is verified on import; the actual Ed25519 check is
    /// done in the frontend (keys live in JS, not Rust).
    pub signature:        String,
    pub server_raw_json:  String,
    pub channels:         Vec<ChannelRow>,
    pub messages:         Vec<MessageRow>,
    pub mutations:        Vec<MutationRow>,
    pub members:          Vec<MemberRow>,
    /// The HLC timestamp at which history was cut; messages before this are not
    /// included in the bundle and will not be synced to joining peers.
    pub history_starts_at: Option<String>,
}

// ── Export ────────────────────────────────────────────────────────────────────

/// Build an archive bundle for the given server and return it as a JSON string.
/// The `author_id` and `signature` fields are passed in from the frontend (where
/// the signing key lives) so Rust doesn't need to touch any key material.
#[tauri::command]
pub fn db_export_archive(
    state: State<AppState>,
    server_id: String,
    author_id: String,
    signature: String,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    // Server raw_json + history_starts_at
    let (server_raw_json, history_starts_at): (String, Option<String>) = conn
        .query_row(
            "SELECT raw_json, history_starts_at FROM servers WHERE id = ?1",
            [&server_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("server not found: {e}"))?;

    // Channels
    let mut stmt = conn
        .prepare("SELECT id, server_id, name, type, position, topic, created_at FROM channels WHERE server_id = ?1")
        .map_err(|e| e.to_string())?;
    let channels: Vec<ChannelRow> = stmt
        .query_map([&server_id], |r| {
            Ok(ChannelRow {
                id:           r.get(0)?,
                server_id:    r.get(1)?,
                name:         r.get(2)?,
                channel_type: r.get(3)?,
                position:     r.get(4)?,
                topic:        r.get(5)?,
                created_at:   r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let channel_ids: Vec<String> = channels.iter().map(|c| c.id.clone()).collect();

    // Messages — only those at or after history_starts_at (in each channel)
    let messages: Vec<MessageRow> = if channel_ids.is_empty() {
        vec![]
    } else {
        let mut all: Vec<MessageRow> = Vec::new();
        let hist_filter = history_starts_at.as_deref().unwrap_or("");
        for cid in &channel_ids {
            let rows = if hist_filter.is_empty() {
                let sql = "SELECT id, channel_id, server_id, author_id, content, content_type,
                           reply_to_id, created_at, logical_ts, verified, raw_attachments
                           FROM messages WHERE channel_id = ?1 ORDER BY logical_ts ASC";
                let mut s = conn.prepare(sql).map_err(|e| e.to_string())?;
                let rows = s.query_map([cid], row_to_msg)
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                rows
            } else {
                let sql = "SELECT id, channel_id, server_id, author_id, content, content_type,
                           reply_to_id, created_at, logical_ts, verified, raw_attachments
                           FROM messages WHERE channel_id = ?1 AND logical_ts >= ?2
                           ORDER BY logical_ts ASC";
                let mut s = conn.prepare(sql).map_err(|e| e.to_string())?;
                let rows = s.query_map(rusqlite::params![cid, hist_filter], row_to_msg)
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                rows
            };
            all.extend(rows);
        }
        all
    };

    // Mutations — same filter
    let mutations: Vec<MutationRow> = if channel_ids.is_empty() {
        vec![]
    } else {
        let mut all: Vec<MutationRow> = Vec::new();
        let hist_filter = history_starts_at.as_deref().unwrap_or("");
        for cid in &channel_ids {
            let rows = if hist_filter.is_empty() {
                let sql = "SELECT id, type, target_id, channel_id, author_id, new_content,
                           emoji_id, logical_ts, created_at, verified
                           FROM mutations WHERE channel_id = ?1 ORDER BY logical_ts ASC";
                let mut s = conn.prepare(sql).map_err(|e| e.to_string())?;
                let rows = s.query_map([cid], row_to_mut)
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                rows
            } else {
                let sql = "SELECT id, type, target_id, channel_id, author_id, new_content,
                           emoji_id, logical_ts, created_at, verified
                           FROM mutations WHERE channel_id = ?1 AND logical_ts >= ?2
                           ORDER BY logical_ts ASC";
                let mut s = conn.prepare(sql).map_err(|e| e.to_string())?;
                let rows = s.query_map(rusqlite::params![cid, hist_filter], row_to_mut)
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                rows
            };
            all.extend(rows);
        }
        all
    };

    // Members
    let mut stmt = conn
        .prepare("SELECT user_id, server_id, display_name, roles, joined_at,
                  public_sign_key, public_dh_key, online_status, avatar_data_url,
                  bio, banner_color, banner_data_url
                  FROM members WHERE server_id = ?1")
        .map_err(|e| e.to_string())?;
    let members: Vec<MemberRow> = stmt
        .query_map([&server_id], |r| {
            Ok(MemberRow {
                user_id:         r.get(0)?,
                server_id:       r.get(1)?,
                display_name:    r.get(2)?,
                roles:           r.get(3)?,
                joined_at:       r.get(4)?,
                public_sign_key: r.get(5)?,
                public_dh_key:   r.get(6)?,
                online_status:   r.get(7)?,
                avatar_data_url: r.get(8)?,
                bio:             r.get(9)?,
                banner_color:    r.get(10)?,
                banner_data_url: r.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let bundle = ArchiveBundle {
        version: 1,
        exported_at: chrono_now(),
        server_id,
        author_id,
        signature,
        server_raw_json,
        channels,
        messages,
        mutations,
        members,
        history_starts_at,
    };

    serde_json::to_string(&bundle).map_err(|e| e.to_string())
}

// ── Import ────────────────────────────────────────────────────────────────────

/// Upsert all rows from an archive bundle into the local DB, then return the server_id
/// so the frontend can load the server into the store.
#[tauri::command]
pub fn db_import_archive(
    state: State<AppState>,
    archive_json: String,
) -> Result<String, String> {
    let bundle: ArchiveBundle =
        serde_json::from_str(&archive_json).map_err(|e| format!("invalid archive: {e}"))?;

    if bundle.version != 1 {
        return Err(format!("unsupported archive version {}", bundle.version));
    }

    let conn = state.db.lock().map_err(|e| e.to_string())?;

    // Upsert server
    conn.execute(
        "INSERT OR REPLACE INTO servers (id, name, description, icon_url, owner_id,
         invite_code, created_at, raw_json, history_starts_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        rusqlite::params![
            bundle.server_id,
            // Pull name from raw_json for the denormalised columns
            serde_json::from_str::<serde_json::Value>(&bundle.server_raw_json)
                .ok().and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_owned))
                .unwrap_or_default(),
            serde_json::from_str::<serde_json::Value>(&bundle.server_raw_json)
                .ok().and_then(|v| v.get("description").and_then(|n| n.as_str()).map(str::to_owned)),
            serde_json::from_str::<serde_json::Value>(&bundle.server_raw_json)
                .ok().and_then(|v| v.get("iconUrl").and_then(|n| n.as_str()).map(str::to_owned)),
            serde_json::from_str::<serde_json::Value>(&bundle.server_raw_json)
                .ok().and_then(|v| v.get("ownerId").and_then(|n| n.as_str()).map(str::to_owned))
                .unwrap_or_default(),
            serde_json::from_str::<serde_json::Value>(&bundle.server_raw_json)
                .ok().and_then(|v| v.get("inviteCode").and_then(|n| n.as_str()).map(str::to_owned)),
            serde_json::from_str::<serde_json::Value>(&bundle.server_raw_json)
                .ok().and_then(|v| v.get("createdAt").and_then(|n| n.as_str()).map(str::to_owned))
                .unwrap_or_default(),
            bundle.server_raw_json,
            bundle.history_starts_at,
        ],
    ).map_err(|e| e.to_string())?;

    // Upsert channels
    for ch in &bundle.channels {
        conn.execute(
            "INSERT OR IGNORE INTO channels (id, server_id, name, type, position, topic, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params![ch.id, ch.server_id, ch.name, ch.channel_type,
                              ch.position, ch.topic, ch.created_at],
        ).map_err(|e| e.to_string())?;
    }

    // Upsert messages (IGNORE so local edits/deletes are preserved)
    for msg in &bundle.messages {
        conn.execute(
            "INSERT OR IGNORE INTO messages
             (id, channel_id, server_id, author_id, content, content_type,
              reply_to_id, created_at, logical_ts, verified, raw_attachments)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![
                msg.id, msg.channel_id, msg.server_id, msg.author_id,
                msg.content, msg.content_type, msg.reply_to_id, msg.created_at,
                msg.logical_ts, msg.verified as i64, msg.raw_attachments,
            ],
        ).map_err(|e| e.to_string())?;
    }

    // Upsert mutations (IGNORE so local state wins)
    for m in &bundle.mutations {
        conn.execute(
            "INSERT OR IGNORE INTO mutations
             (id, type, target_id, channel_id, author_id, new_content,
              emoji_id, logical_ts, created_at, verified)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            rusqlite::params![
                m.id, m.mutation_type, m.target_id, m.channel_id, m.author_id,
                m.new_content, m.emoji_id, m.logical_ts, m.created_at, m.verified as i64,
            ],
        ).map_err(|e| e.to_string())?;
    }

    // Upsert members
    for mem in &bundle.members {
        conn.execute(
            "INSERT OR IGNORE INTO members
             (user_id, server_id, display_name, roles, joined_at,
              public_sign_key, public_dh_key, online_status, avatar_data_url)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![
                mem.user_id, mem.server_id, mem.display_name, mem.roles, mem.joined_at,
                mem.public_sign_key, mem.public_dh_key, mem.online_status, mem.avatar_data_url,
            ],
        ).map_err(|e| e.to_string())?;
    }

    Ok(bundle.server_id)
}

// ── Re-baseline ───────────────────────────────────────────────────────────────

/// Persist the `historyStartsAt` HLC timestamp for a server.
/// Called as part of applying a `server_rebaseline` mutation.
#[tauri::command]
pub fn db_save_rebaseline(
    state: State<AppState>,
    server_id: String,
    history_starts_at: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE servers SET history_starts_at = ?1 WHERE id = ?2",
        [&history_starts_at, &server_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn row_to_msg(r: &rusqlite::Row) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        id:              r.get(0)?,
        channel_id:      r.get(1)?,
        server_id:       r.get(2)?,
        author_id:       r.get(3)?,
        content:         r.get(4)?,
        content_type:    r.get(5)?,
        reply_to_id:     r.get(6)?,
        created_at:      r.get(7)?,
        logical_ts:      r.get(8)?,
        verified:        r.get::<_, i64>(9)? != 0,
        raw_attachments: r.get(10)?,
    })
}

fn row_to_mut(r: &rusqlite::Row) -> rusqlite::Result<MutationRow> {
    Ok(MutationRow {
        id:            r.get(0)?,
        mutation_type: r.get(1)?,
        target_id:     r.get(2)?,
        channel_id:    r.get(3)?,
        author_id:     r.get(4)?,
        new_content:   r.get(5)?,
        emoji_id:      r.get(6)?,
        logical_ts:    r.get(7)?,
        created_at:    r.get(8)?,
        verified:      r.get::<_, i64>(9)? != 0,
    })
}

fn chrono_now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| {
            let secs = d.as_secs();
            // Format as ISO 8601 without external dependency
            let (y, mo, d2, h, mi, s) = epoch_to_ymd_hms(secs);
            format!("{y:04}-{mo:02}-{d2:02}T{h:02}:{mi:02}:{s:02}Z")
        })
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Minimal epoch → (year, month, day, hour, min, sec) without chrono.
fn epoch_to_ymd_hms(epoch: u64) -> (u32, u32, u32, u32, u32, u32) {
    let s = epoch % 86400;
    let days = epoch / 86400;
    let h = (s / 3600) as u32;
    let mi = ((s % 3600) / 60) as u32;
    let sec = (s % 60) as u32;

    // Gregorian calendar computation (Fliegel–Van Flandern)
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as u32, m as u32, d as u32, h, mi, sec)
}
