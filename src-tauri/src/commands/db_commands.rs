use tauri::State;
use crate::AppState;
use crate::db::types::*;

// ── Messages ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_load_messages(
    state: State<AppState>,
    channel_id: String,
    before_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<MessageRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(100) as i64;

    let rows = if let Some(bid) = before_id {
        let sql = "SELECT id, channel_id, server_id, author_id, content, content_type,
                   reply_to_id, created_at, logical_ts, verified, raw_attachments
                   FROM messages
                   WHERE channel_id = ?1 AND logical_ts < (SELECT logical_ts FROM messages WHERE id = ?2)
                   ORDER BY logical_ts DESC LIMIT ?3";
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&channel_id, &bid, &limit.to_string()], row_to_message)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    } else {
        let sql = "SELECT id, channel_id, server_id, author_id, content, content_type,
                   reply_to_id, created_at, logical_ts, verified, raw_attachments
                   FROM messages WHERE channel_id = ?1 ORDER BY logical_ts DESC LIMIT ?2";
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&channel_id, &limit.to_string()], row_to_message)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };

    Ok(rows)
}

fn row_to_message(row: &rusqlite::Row) -> rusqlite::Result<MessageRow> {
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
}

#[tauri::command]
pub fn db_save_message(state: State<AppState>, msg: MessageRow) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO messages
         (id, channel_id, server_id, author_id, content, content_type,
          reply_to_id, created_at, logical_ts, verified, raw_attachments)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        rusqlite::params![
            msg.id, msg.channel_id, msg.server_id, msg.author_id,
            msg.content, msg.content_type, msg.reply_to_id,
            msg.created_at, msg.logical_ts, msg.verified as i64, msg.raw_attachments
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Mutations ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_save_mutation(state: State<AppState>, mutation: MutationRow) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT OR IGNORE INTO mutations
         (id, type, target_id, channel_id, author_id, new_content, emoji_id, logical_ts, created_at, verified)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        rusqlite::params![
            mutation.id, mutation.mutation_type, mutation.target_id,
            mutation.channel_id, mutation.author_id, mutation.new_content,
            mutation.emoji_id, mutation.logical_ts, mutation.created_at,
            mutation.verified as i64
        ],
    ).map_err(|e| e.to_string())?;

    // Apply side effects
    match mutation.mutation_type.as_str() {
        "delete" => {
            conn.execute(
                "UPDATE messages SET content = NULL, raw_attachments = NULL WHERE id = ?1",
                [&mutation.target_id],
            ).map_err(|e| e.to_string())?;
        }
        "edit" => {
            if let Some(new_content) = &mutation.new_content {
                conn.execute(
                    "UPDATE messages SET content = ?1
                     WHERE id = ?2 AND logical_ts < ?3",
                    rusqlite::params![new_content, mutation.target_id, mutation.logical_ts],
                ).map_err(|e| e.to_string())?;
            }
        }
        "server_update" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(patch) = serde_json::from_str::<serde_json::Value>(new_content) {
                    if let Some(name) = patch.get("name").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE servers SET name = ?1 WHERE id = ?2",
                            [name, &mutation.target_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(desc) = patch.get("description").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE servers SET description = ?1 WHERE id = ?2",
                            [desc, &mutation.target_id],
                        ).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        "role_assign" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(new_content) {
                    if let Some(role) = payload.get("roleName").and_then(|v| v.as_str()) {
                        let server_id = payload.get("serverId").and_then(|v| v.as_str()).unwrap_or("");
                        // Append role to JSON array if not present
                        let current: Option<String> = conn.query_row(
                            "SELECT roles FROM members WHERE user_id = ?1 AND server_id = ?2",
                            [&mutation.target_id, server_id],
                            |r| r.get(0),
                        ).unwrap_or(None);
                        let mut roles: Vec<String> = current
                            .and_then(|s| serde_json::from_str(&s).ok())
                            .unwrap_or_default();
                        if !roles.contains(&role.to_string()) {
                            roles.push(role.to_string());
                            conn.execute(
                                "UPDATE members SET roles = ?1 WHERE user_id = ?2 AND server_id = ?3",
                                [&serde_json::to_string(&roles).unwrap(), &mutation.target_id, server_id],
                            ).map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
        }
        "role_revoke" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(new_content) {
                    if let Some(role) = payload.get("roleName").and_then(|v| v.as_str()) {
                        let server_id = payload.get("serverId").and_then(|v| v.as_str()).unwrap_or("");
                        let current: Option<String> = conn.query_row(
                            "SELECT roles FROM members WHERE user_id = ?1 AND server_id = ?2",
                            [&mutation.target_id, server_id],
                            |r| r.get(0),
                        ).unwrap_or(None);
                        let mut roles: Vec<String> = current
                            .and_then(|s| serde_json::from_str(&s).ok())
                            .unwrap_or_default();
                        roles.retain(|r| r != role);
                        conn.execute(
                            "UPDATE members SET roles = ?1 WHERE user_id = ?2 AND server_id = ?3",
                            [&serde_json::to_string(&roles).unwrap(), &mutation.target_id, server_id],
                        ).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        "device_attest" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(device) = serde_json::from_str::<serde_json::Value>(new_content) {
                    conn.execute(
                        "INSERT OR IGNORE INTO devices
                         (device_id, user_id, public_sign_key, public_dh_key,
                          attested_by, attestation_sig, revoked, created_at)
                         VALUES (?1,?2,?3,?4,?5,?6,0,?7)",
                        rusqlite::params![
                            device.get("deviceId").and_then(|v| v.as_str()).unwrap_or(""),
                            device.get("userId").and_then(|v| v.as_str()).unwrap_or(""),
                            device.get("publicSignKey").and_then(|v| v.as_str()).unwrap_or(""),
                            device.get("publicDHKey").and_then(|v| v.as_str()).unwrap_or(""),
                            device.get("attestedBy").and_then(|v| v.as_str()),
                            device.get("attestationSig").and_then(|v| v.as_str()),
                            mutation.created_at,
                        ],
                    ).map_err(|e| e.to_string())?;
                }
            }
        }
        "device_revoke" => {
            conn.execute(
                "UPDATE devices SET revoked = 1 WHERE device_id = ?1",
                [&mutation.target_id],
            ).map_err(|e| e.to_string())?;
        }
        _ => {}
    }

    Ok(())
}

#[tauri::command]
pub fn db_load_mutations(
    state: State<AppState>,
    channel_id: String,
    after_ts: Option<String>,
) -> Result<Vec<MutationRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let sql = if after_ts.is_some() {
        "SELECT id, type, target_id, channel_id, author_id, new_content, emoji_id,
         logical_ts, created_at, verified
         FROM mutations WHERE channel_id = ?1 AND logical_ts > ?2 ORDER BY logical_ts ASC"
    } else {
        "SELECT id, type, target_id, channel_id, author_id, new_content, emoji_id,
         logical_ts, created_at, verified
         FROM mutations WHERE channel_id = ?1 ORDER BY logical_ts ASC"
    };

    let after = after_ts.unwrap_or_default();
    let params: Vec<&dyn rusqlite::ToSql> = if after.is_empty() {
        vec![&channel_id]
    } else {
        vec![&channel_id, &after]
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok(MutationRow {
            id:              row.get(0)?,
            mutation_type:   row.get(1)?,
            target_id:       row.get(2)?,
            channel_id:      row.get(3)?,
            author_id:       row.get(4)?,
            new_content:     row.get(5)?,
            emoji_id:        row.get(6)?,
            logical_ts:      row.get(7)?,
            created_at:      row.get(8)?,
            verified:        row.get::<_, i64>(9)? != 0,
        })
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;

    Ok(rows)
}

// ── Servers & Channels ────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_load_servers(state: State<AppState>) -> Result<Vec<ServerRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, name, description, icon_url, owner_id, invite_code, created_at, raw_json FROM servers"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(ServerRow {
            id:          row.get(0)?,
            name:        row.get(1)?,
            description: row.get(2)?,
            icon_url:    row.get(3)?,
            owner_id:    row.get(4)?,
            invite_code: row.get(5)?,
            created_at:  row.get(6)?,
            raw_json:    row.get(7)?,
        })
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn db_save_server(state: State<AppState>, server: ServerRow) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO servers
         (id, name, description, icon_url, owner_id, invite_code, created_at, raw_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![
            server.id, server.name, server.description, server.icon_url,
            server.owner_id, server.invite_code, server.created_at, server.raw_json
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_load_channels(state: State<AppState>, server_id: String) -> Result<Vec<ChannelRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, server_id, name, type, position, topic, created_at
         FROM channels WHERE server_id = ?1 ORDER BY position ASC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&server_id], |row| {
        Ok(ChannelRow {
            id:           row.get(0)?,
            server_id:    row.get(1)?,
            name:         row.get(2)?,
            channel_type: row.get(3)?,
            position:     row.get(4)?,
            topic:        row.get(5)?,
            created_at:   row.get(6)?,
        })
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn db_save_channel(state: State<AppState>, channel: ChannelRow) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO channels (id, server_id, name, type, position, topic, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![
            channel.id, channel.server_id, channel.name, channel.channel_type,
            channel.position, channel.topic, channel.created_at
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Keys ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_save_key(
    state: State<AppState>,
    key_id: String,
    key_type: String,
    key_data: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = chrono_now();
    conn.execute(
        "INSERT OR REPLACE INTO key_store (key_id, key_type, key_data, created_at) VALUES (?1,?2,?3,?4)",
        [&key_id, &key_type, &key_data, &now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_load_key(state: State<AppState>, key_id: String) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let result = conn.query_row(
        "SELECT key_data FROM key_store WHERE key_id = ?1",
        [&key_id],
        |row| row.get(0),
    );
    match result {
        Ok(val) => Ok(Some(val)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// ── Members ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_load_members(state: State<AppState>, server_id: String) -> Result<Vec<MemberRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT user_id, server_id, display_name, roles, joined_at,
         public_sign_key, public_dh_key, online_status
         FROM members WHERE server_id = ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&server_id], |row| {
        Ok(MemberRow {
            user_id:        row.get(0)?,
            server_id:      row.get(1)?,
            display_name:   row.get(2)?,
            roles:          row.get(3)?,
            joined_at:      row.get(4)?,
            public_sign_key: row.get(5)?,
            public_dh_key:  row.get(6)?,
            online_status:  row.get(7)?,
        })
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn db_upsert_member(state: State<AppState>, member: MemberRow) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO members
         (user_id, server_id, display_name, roles, joined_at, public_sign_key, public_dh_key, online_status)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![
            member.user_id, member.server_id, member.display_name, member.roles,
            member.joined_at, member.public_sign_key, member.public_dh_key, member.online_status
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Emoji ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_load_emoji(state: State<AppState>, server_id: String) -> Result<Vec<EmojiRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, server_id, name, file_path, uploaded_by, created_at
         FROM custom_emoji WHERE server_id = ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&server_id], |row| {
        Ok(EmojiRow {
            id:          row.get(0)?,
            server_id:   row.get(1)?,
            name:        row.get(2)?,
            file_path:   row.get(3)?,
            uploaded_by: row.get(4)?,
            created_at:  row.get(5)?,
        })
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn db_save_emoji(
    state: State<AppState>,
    app_handle: tauri::AppHandle,
    emoji: EmojiRow,
    image_bytes: Vec<u8>,
) -> Result<(), String> {
    use tauri::Manager;
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let emoji_dir = app_dir.join("emoji").join(&emoji.server_id);
    std::fs::create_dir_all(&emoji_dir).map_err(|e| e.to_string())?;
    let file_path = emoji_dir.join(format!("{}.webp", emoji.id));
    std::fs::write(&file_path, &image_bytes).map_err(|e| e.to_string())?;

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO custom_emoji (id, server_id, name, file_path, uploaded_by, created_at)
         VALUES (?1,?2,?3,?4,?5,?6)",
        rusqlite::params![
            emoji.id, emoji.server_id, emoji.name,
            file_path.to_string_lossy().to_string(),
            emoji.uploaded_by, emoji.created_at
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_emoji_image(
    app_handle: tauri::AppHandle,
    emoji_id: String,
    server_id: String,
) -> Result<Vec<u8>, String> {
    use tauri::Manager;
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let file_path = app_dir.join("emoji").join(&server_id).join(format!("{}.webp", emoji_id));
    std::fs::read(file_path).map_err(|e| e.to_string())
}

// ── Devices ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_load_devices(state: State<AppState>, user_id: String) -> Result<Vec<DeviceRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT device_id, user_id, public_sign_key, public_dh_key,
         attested_by, attestation_sig, revoked, created_at
         FROM devices WHERE user_id = ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&user_id], |row| {
        Ok(DeviceRow {
            device_id:       row.get(0)?,
            user_id:         row.get(1)?,
            public_sign_key: row.get(2)?,
            public_dh_key:   row.get(3)?,
            attested_by:     row.get(4)?,
            attestation_sig: row.get(5)?,
            revoked:         row.get::<_, i64>(6)? != 0,
            created_at:      row.get(7)?,
        })
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn db_save_device(state: State<AppState>, device: DeviceRow) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO devices
         (device_id, user_id, public_sign_key, public_dh_key, attested_by, attestation_sig, revoked, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![
            device.device_id, device.user_id, device.public_sign_key,
            device.public_dh_key, device.attested_by, device.attestation_sig,
            device.revoked as i64, device.created_at
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_revoke_device(state: State<AppState>, device_id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE devices SET revoked = 1 WHERE device_id = ?1",
        [&device_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Channel delete ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_delete_channel(state: State<AppState>, channel_id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM channels WHERE id = ?1", [&channel_id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ── System ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_app_data_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    app_handle
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    // ISO 8601 approximation via ms timestamp
    format!("{}", ms)
}
