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

/// Load a symmetric window of messages centred on `near_id`:
/// up to `half_limit` messages before + the target itself + up to `half_limit` after.
/// Returns all rows in ascending `logical_ts` order; the target is near the middle.
#[tauri::command]
pub fn db_load_messages_around(
    state: State<AppState>,
    channel_id: String,
    near_id: String,
    half_limit: Option<u32>,
) -> Result<Vec<MessageRow>, String> {
    let conn  = state.db.lock().map_err(|e| e.to_string())?;
    let half  = half_limit.unwrap_or(50) as i64;

    // Resolve target logical_ts
    let target_ts: String = match conn.query_row(
        "SELECT logical_ts FROM messages WHERE id = ?1",
        [&near_id],
        |r| r.get(0),
    ) {
        Ok(ts) => ts,
        Err(_) => return Ok(vec![]),
    };

    // Messages strictly before target, most-recent-first (we'll reverse)
    let before_sql = "SELECT id, channel_id, server_id, author_id, content, content_type,
                      reply_to_id, created_at, logical_ts, verified, raw_attachments
                      FROM messages WHERE channel_id = ?1 AND logical_ts < ?2
                      ORDER BY logical_ts DESC LIMIT ?3";
    let mut before_stmt = conn.prepare(before_sql).map_err(|e| e.to_string())?;
    let mut before: Vec<MessageRow> = before_stmt.query_map(
        rusqlite::params![&channel_id, &target_ts, half],
        row_to_message,
    ).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    before.reverse();

    // Target message itself
    let target: Option<MessageRow> = conn.query_row(
        "SELECT id, channel_id, server_id, author_id, content, content_type,
         reply_to_id, created_at, logical_ts, verified, raw_attachments
         FROM messages WHERE id = ?1",
        [&near_id],
        row_to_message,
    ).ok();

    // Messages strictly after target, oldest-first
    let after_sql = "SELECT id, channel_id, server_id, author_id, content, content_type,
                     reply_to_id, created_at, logical_ts, verified, raw_attachments
                     FROM messages WHERE channel_id = ?1 AND logical_ts > ?2
                     ORDER BY logical_ts ASC LIMIT ?3";
    let mut after_stmt = conn.prepare(after_sql).map_err(|e| e.to_string())?;
    let after: Vec<MessageRow> = after_stmt.query_map(
        rusqlite::params![&channel_id, &target_ts, half],
        row_to_message,
    ).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;

    let mut result = before;
    if let Some(t) = target { result.push(t); }
    result.extend(after);
    Ok(result)
}

/// Load messages strictly newer than `after_id`, oldest-first.
/// Used by the bottom-sentinel infinite-scroll when viewing a historical window.
#[tauri::command]
pub fn db_load_messages_after(
    state: State<AppState>,
    channel_id: String,
    after_id: String,
    limit: Option<u32>,
) -> Result<Vec<MessageRow>, String> {
    let conn  = state.db.lock().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(100) as i64;

    let sql = "SELECT id, channel_id, server_id, author_id, content, content_type,
               reply_to_id, created_at, logical_ts, verified, raw_attachments
               FROM messages
               WHERE channel_id = ?1
                 AND logical_ts > (SELECT logical_ts FROM messages WHERE id = ?2)
               ORDER BY logical_ts ASC LIMIT ?3";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(
        rusqlite::params![&channel_id, &after_id, limit],
        row_to_message,
    ).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
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

fn apply_mutation_side_effects(
    conn: &rusqlite::Connection,
    mutation: &MutationRow,
) -> Result<(), String> {
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
                                [&serde_json::to_string(&roles).map_err(|e| e.to_string())?, &mutation.target_id, server_id],
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
                            [&serde_json::to_string(&roles).map_err(|e| e.to_string())?, &mutation.target_id, server_id],
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
        "server_rebaseline" => {
            if let Some(hist_ts) = &mutation.new_content {
                conn.execute(
                    "UPDATE servers SET history_starts_at = ?1 WHERE id = ?2",
                    [hist_ts, &mutation.target_id],
                ).map_err(|e| e.to_string())?;
                let raw: Option<String> = conn.query_row(
                    "SELECT raw_json FROM servers WHERE id = ?1",
                    [&mutation.target_id],
                    |r| r.get(0),
                ).ok();
                if let Some(raw) = raw {
                    if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&raw) {
                        val["historyStartsAt"] = serde_json::Value::String(hist_ts.clone());
                        if let Ok(updated) = serde_json::to_string(&val) {
                            let _ = conn.execute(
                                "UPDATE servers SET raw_json = ?1 WHERE id = ?2",
                                [&updated, &mutation.target_id],
                            );
                        }
                    }
                }
            }
        }
        "member_join" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(new_content) {
                    let user_id = payload.get("userId").and_then(|v| v.as_str()).unwrap_or("");
                    let server_id = payload.get("serverId").and_then(|v| v.as_str()).unwrap_or("");
                    let display_name = payload.get("displayName").and_then(|v| v.as_str()).unwrap_or("");
                    let public_sign_key = payload.get("publicSignKey").and_then(|v| v.as_str()).unwrap_or("");
                    let public_dh_key = payload.get("publicDHKey").and_then(|v| v.as_str()).unwrap_or("");
                    let roles = payload.get("roles").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
                    let joined_at = payload.get("joinedAt").and_then(|v| v.as_str()).unwrap_or(&mutation.created_at);

                    conn.execute(
                        "INSERT OR IGNORE INTO members
                         (user_id, server_id, display_name, roles, joined_at,
                          public_sign_key, public_dh_key, online_status)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,'offline')",
                        rusqlite::params![user_id, server_id, display_name, roles, joined_at,
                                          public_sign_key, public_dh_key],
                    ).map_err(|e| e.to_string())?;
                }
            }
        }
        "member_profile_update" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(patch) = serde_json::from_str::<serde_json::Value>(new_content) {
                    let server_id = patch.get("serverId").and_then(|v| v.as_str()).unwrap_or("");
                    let target_id = &mutation.target_id;

                    if let Some(name) = patch.get("displayName").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE members SET display_name = ?1 WHERE user_id = ?2 AND server_id = ?3",
                            [name, target_id, server_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(hash) = patch.get("avatarHash").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE members SET avatar_hash = ?1 WHERE user_id = ?2 AND server_id = ?3",
                            [hash, target_id, server_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(bio) = patch.get("bio").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE members SET bio = ?1 WHERE user_id = ?2 AND server_id = ?3",
                            [bio, target_id, server_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(hash) = patch.get("bannerHash").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE members SET banner_hash = ?1 WHERE user_id = ?2 AND server_id = ?3",
                            [hash, target_id, server_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(color) = patch.get("bannerColor").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE members SET banner_color = ?1 WHERE user_id = ?2 AND server_id = ?3",
                            [color, target_id, server_id],
                        ).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        "channel_create" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(ch) = serde_json::from_str::<serde_json::Value>(new_content) {
                    let id = ch.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let server_id = ch.get("serverId").and_then(|v| v.as_str()).unwrap_or("");
                    let name = ch.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let ch_type = ch.get("type").and_then(|v| v.as_str()).unwrap_or("text");
                    let position = ch.get("position").and_then(|v| v.as_i64()).unwrap_or(0);
                    let topic = ch.get("topic").and_then(|v| v.as_str());

                    conn.execute(
                        "INSERT OR IGNORE INTO channels (id, server_id, name, type, position, topic, created_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7)",
                        rusqlite::params![id, server_id, name, ch_type, position, topic, mutation.created_at],
                    ).map_err(|e| e.to_string())?;
                }
            }
        }
        "channel_update" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(patch) = serde_json::from_str::<serde_json::Value>(new_content) {
                    if let Some(name) = patch.get("name").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE channels SET name = ?1 WHERE id = ?2",
                            [name, &mutation.target_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(topic) = patch.get("topic").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE channels SET topic = ?1 WHERE id = ?2",
                            [topic, &mutation.target_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(position) = patch.get("position").and_then(|v| v.as_i64()) {
                        conn.execute(
                            "UPDATE channels SET position = ?1 WHERE id = ?2",
                            rusqlite::params![position, mutation.target_id],
                        ).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        "channel_delete" => {
            conn.execute(
                "DELETE FROM channels WHERE id = ?1",
                [&mutation.target_id],
            ).map_err(|e| e.to_string())?;
        }
        "emoji_add" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(emoji) = serde_json::from_str::<serde_json::Value>(new_content) {
                    let id = emoji.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let server_id = emoji.get("serverId").and_then(|v| v.as_str()).unwrap_or("");
                    let name = emoji.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let file_path = emoji.get("filePath").and_then(|v| v.as_str()).unwrap_or("");
                    let uploaded_by = emoji.get("uploadedBy").and_then(|v| v.as_str()).unwrap_or("");

                    conn.execute(
                        "INSERT OR IGNORE INTO custom_emoji (id, server_id, name, file_path, uploaded_by, created_at)
                         VALUES (?1,?2,?3,?4,?5,?6)",
                        rusqlite::params![id, server_id, name, file_path, uploaded_by, mutation.created_at],
                    ).map_err(|e| e.to_string())?;
                }
            }
        }
        "emoji_remove" => {
            conn.execute(
                "DELETE FROM custom_emoji WHERE id = ?1",
                [&mutation.target_id],
            ).map_err(|e| e.to_string())?;
        }
        _ => {}
    }
    Ok(())
}

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
    apply_mutation_side_effects(&conn, &mutation)?;

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
        "SELECT id, name, description, icon_url, owner_id, invite_code, created_at, raw_json, avatar_hash FROM servers"
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
            avatar_hash: row.get(8)?,
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
         (id, name, description, icon_url, owner_id, invite_code, created_at, raw_json, avatar_hash)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        rusqlite::params![
            server.id, server.name, server.description, server.icon_url,
            server.owner_id, server.invite_code, server.created_at, server.raw_json,
            server.avatar_hash
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_load_channels(state: State<AppState>, server_id: String) -> Result<Vec<ChannelRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, server_id, name, type, position, topic, created_at
         FROM channels WHERE server_id = ?1 ORDER BY position ASC, created_at ASC"
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
         public_sign_key, public_dh_key, online_status,
         bio, banner_color, avatar_hash, banner_hash
         FROM members WHERE server_id = ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&server_id], |row| {
        Ok(MemberRow {
            user_id:          row.get(0)?,
            server_id:        row.get(1)?,
            display_name:     row.get(2)?,
            roles:            row.get(3)?,
            joined_at:        row.get(4)?,
            public_sign_key:  row.get(5)?,
            public_dh_key:    row.get(6)?,
            online_status:    row.get(7)?,
            bio:              row.get(8)?,
            banner_color:     row.get(9)?,
            avatar_hash:      row.get(10)?,
            banner_hash:      row.get(11)?,
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
         (user_id, server_id, display_name, roles, joined_at, public_sign_key, public_dh_key, online_status, bio, banner_color, avatar_hash, banner_hash)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        rusqlite::params![
            member.user_id, member.server_id, member.display_name, member.roles,
            member.joined_at, member.public_sign_key, member.public_dh_key, member.online_status,
            member.bio, member.banner_color,
            member.avatar_hash, member.banner_hash,
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

#[tauri::command]
pub fn get_emoji_image_path(
    app_handle: tauri::AppHandle,
    emoji_id: String,
    server_id: String,
) -> Result<String, String> {
    use tauri::Manager;
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let file_path = app_dir
        .join("emoji")
        .join(&server_id)
        .join(format!("{}.webp", emoji_id));
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn store_emoji_image(
    app_handle: tauri::AppHandle,
    emoji_id: String,
    server_id: String,
    image_bytes: Vec<u8>,
) -> Result<(), String> {
    use tauri::Manager;
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let emoji_dir = app_dir.join("emoji").join(&server_id);
    std::fs::create_dir_all(&emoji_dir).map_err(|e| e.to_string())?;
    let file_path = emoji_dir.join(format!("{}.webp", emoji_id));
    std::fs::write(file_path, &image_bytes).map_err(|e| e.to_string())
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

// ── Invite codes ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_save_invite_code(state: State<AppState>, code: InviteCodeRow) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO invite_codes
         (code, server_id, created_by, max_uses, use_count, expires_at, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![
            code.code, code.server_id, code.created_by,
            code.max_uses, code.use_count, code.expires_at, code.created_at,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_load_invite_codes(state: State<AppState>, server_id: String) -> Result<Vec<InviteCodeRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT code, server_id, created_by, max_uses, use_count, expires_at, created_at
         FROM invite_codes WHERE server_id = ?1 ORDER BY created_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&server_id], |row| {
        Ok(InviteCodeRow {
            code:       row.get(0)?,
            server_id:  row.get(1)?,
            created_by: row.get(2)?,
            max_uses:   row.get(3)?,
            use_count:  row.get(4)?,
            expires_at: row.get(5)?,
            created_at: row.get(6)?,
        })
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Atomically increment use_count for the given invite code and return the new count.
/// Returns an error if the code does not exist.
#[tauri::command]
pub fn db_increment_invite_use_count(state: State<AppState>, code: String) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE invite_codes SET use_count = use_count + 1 WHERE code = ?1",
        [&code],
    ).map_err(|e| e.to_string())?;
    let new_count: i64 = conn.query_row(
        "SELECT use_count FROM invite_codes WHERE code = ?1",
        [&code],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    Ok(new_count)
}

#[tauri::command]
pub fn db_delete_invite_code(state: State<AppState>, code: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM invite_codes WHERE code = ?1", [&code])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Moderation audit log ──────────────────────────────────────────────────────

#[tauri::command]
pub fn db_save_mod_log_entry(state: State<AppState>, entry: ModLogRow) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO mod_log
         (id, server_id, action, target_id, issued_by, reason, detail, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![
            entry.id, entry.server_id, entry.action, entry.target_id,
            entry.issued_by, entry.reason, entry.detail, entry.created_at,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_load_mod_log(
    state: State<AppState>,
    server_id: String,
    limit: Option<u32>,
) -> Result<Vec<ModLogRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(200) as i64;
    let mut stmt = conn.prepare(
        "SELECT id, server_id, action, target_id, issued_by, reason, detail, created_at
         FROM mod_log WHERE server_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params![server_id, limit], |row| {
        Ok(ModLogRow {
            id:         row.get(0)?,
            server_id:  row.get(1)?,
            action:     row.get(2)?,
            target_id:  row.get(3)?,
            issued_by:  row.get(4)?,
            reason:     row.get(5)?,
            detail:     row.get(6)?,
            created_at: row.get(7)?,
        })
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

// ── Search ────────────────────────────────────────────────────────────────────

/// Full-text search over message content using the FTS5 index.
/// `server_id` is required; `channel_id` optionally restricts results to one channel.
/// Returns up to `limit` rows (default 50), ordered newest-first.
#[tauri::command]
pub fn db_search_messages(
    state: State<AppState>,
    server_id: String,
    query: String,
    channel_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<MessageRow>, String> {
    let conn  = state.db.lock().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(50) as i64;

    // Escape special FTS5 characters to avoid query parse errors from user input.
    // We wrap the sanitised query in double-quotes for a phrase search unless the
    // user has explicitly typed FTS5 syntax (contains " or *).
    let fts_query = if query.contains('"') || query.contains('*') {
        query.clone()
    } else {
        format!("\"{}\"", query.replace('"', "\"\""))
    };

    let rows = if let Some(cid) = channel_id {
        let sql = "SELECT m.id, m.channel_id, m.server_id, m.author_id, m.content, m.content_type,
                   m.reply_to_id, m.created_at, m.logical_ts, m.verified, m.raw_attachments
                   FROM messages m
                   WHERE m.server_id = ?1
                     AND m.channel_id = ?2
                     AND m.content IS NOT NULL
                     AND m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?3)
                   ORDER BY m.logical_ts DESC
                   LIMIT ?4";
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                rusqlite::params![server_id, cid, fts_query, limit],
                row_to_message,
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    } else {
        let sql = "SELECT m.id, m.channel_id, m.server_id, m.author_id, m.content, m.content_type,
                   m.reply_to_id, m.created_at, m.logical_ts, m.verified, m.raw_attachments
                   FROM messages m
                   WHERE m.server_id = ?1
                     AND m.content IS NOT NULL
                     AND m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?2)
                   ORDER BY m.logical_ts DESC
                   LIMIT ?3";
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                rusqlite::params![server_id, fts_query, limit],
                row_to_message,
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };

    Ok(rows)
}

// ── System ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_save_ban(state: State<AppState>, ban: BanRow) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO bans (server_id, user_id, banned_by, reason, banned_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            ban.server_id, ban.user_id, ban.banned_by,
            ban.reason, ban.banned_at, ban.expires_at,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_load_bans(state: State<AppState>, server_id: String) -> Result<Vec<BanRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT server_id, user_id, banned_by, reason, banned_at, expires_at
         FROM bans WHERE server_id = ?1 ORDER BY banned_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params![server_id], |row| {
        Ok(BanRow {
            server_id:  row.get(0)?,
            user_id:    row.get(1)?,
            banned_by:  row.get(2)?,
            reason:     row.get(3)?,
            banned_at:  row.get(4)?,
            expires_at: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn db_delete_ban(state: State<AppState>, server_id: String, user_id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM bans WHERE server_id = ?1 AND user_id = ?2",
        rusqlite::params![server_id, user_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_is_banned(state: State<AppState>, server_id: String, user_id: String) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = chrono_now_iso();
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM bans WHERE server_id = ?1 AND user_id = ?2
         AND (expires_at IS NULL OR expires_at > ?3)",
        rusqlite::params![server_id, user_id, now],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    Ok(count > 0)
}

// ── Channel ACLs ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_load_channel_acls(state: State<AppState>, server_id: String) -> Result<Vec<ChannelAclRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT ca.channel_id, ca.allowed_roles, ca.allowed_users, ca.denied_users, ca.private_channel
         FROM channel_acls ca
         INNER JOIN channels c ON c.id = ca.channel_id
         WHERE c.server_id = ?1",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params![server_id], |row| {
        Ok(ChannelAclRow {
            channel_id:      row.get(0)?,
            allowed_roles:   row.get(1)?,
            allowed_users:   row.get(2)?,
            denied_users:    row.get(3)?,
            private_channel: row.get::<_, i64>(4)? != 0,
        })
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn db_upsert_channel_acl(state: State<AppState>, acl: ChannelAclRow) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO channel_acls (channel_id, allowed_roles, allowed_users, denied_users, private_channel)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(channel_id) DO UPDATE SET
           allowed_roles   = excluded.allowed_roles,
           allowed_users   = excluded.allowed_users,
           denied_users    = excluded.denied_users,
           private_channel = excluded.private_channel",
        rusqlite::params![
            acl.channel_id,
            acl.allowed_roles,
            acl.allowed_users,
            acl.denied_users,
            acl.private_channel as i64,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Join Requests ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn db_save_join_request(state: State<AppState>, req: JoinRequestRow) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO join_requests (id, server_id, user_id, display_name, public_sign_key, public_dh_key, requested_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO NOTHING",
        rusqlite::params![
            req.id, req.server_id, req.user_id, req.display_name,
            req.public_sign_key, req.public_dh_key, req.requested_at, req.status,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_load_join_requests(state: State<AppState>, server_id: String) -> Result<Vec<JoinRequestRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, server_id, user_id, display_name, public_sign_key, public_dh_key, requested_at, status
         FROM join_requests WHERE server_id = ?1 ORDER BY requested_at ASC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params![server_id], |row| {
        Ok(JoinRequestRow {
            id:              row.get(0)?,
            server_id:       row.get(1)?,
            user_id:         row.get(2)?,
            display_name:    row.get(3)?,
            public_sign_key: row.get(4)?,
            public_dh_key:   row.get(5)?,
            requested_at:    row.get(6)?,
            status:          row.get(7)?,
        })
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn db_update_join_request_status(
    state: State<AppState>,
    request_id: String,
    status: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE join_requests SET status = ?1 WHERE id = ?2",
        rusqlite::params![status, request_id],
    ).map_err(|e| e.to_string())?;
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

/// Returns an empty list on non-Windows targets.
/// On Windows, a real implementation using EnumWindows / EnumDisplayMonitors
/// would be wired here in a future phase. The frontend falls back to
/// `getDisplayMedia()` when the list is empty.
#[tauri::command]
pub fn get_screen_sources() -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![])
}

/// Opens the browser developer tools panel for the requesting webview window.
/// Requires the `devtools` Cargo feature (already enabled in Cargo.toml).
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

// ── Background maintenance ────────────────────────────────────────────────────

/// Prune bans whose `expires_at` timestamp (ISO-8601 string) is in the past.
/// Called once on startup; no-ops if the column is NULL (permanent bans).
#[tauri::command]
pub fn db_prune_expired_bans(state: State<AppState>) -> Result<usize, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = chrono_now_iso();
    let count = conn.execute(
        "DELETE FROM bans WHERE expires_at IS NOT NULL AND expires_at < ?1",
        rusqlite::params![now],
    ).map_err(|e| e.to_string())?;
    Ok(count)
}

/// Prune old `mod_log` entries. Keeps rows from the last `retain_days` days
/// (default 90) and also enforces a `row_cap` soft cap (default 10000):
/// after the age prune, if more than `row_cap` rows remain, the oldest are deleted.
#[tauri::command]
pub fn db_prune_mod_log(
    state: State<AppState>,
    retain_days: Option<u32>,
    row_cap: Option<u32>,
) -> Result<usize, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let days = retain_days.unwrap_or(90) as i64;
    let cap  = row_cap.unwrap_or(10_000);

    // Age-based prune: delete rows older than `retain_days`
    let now_ms = {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    };
    let cutoff_ms = now_ms - (days * 86_400 * 1_000);
    let age_deleted = conn.execute(
        "DELETE FROM mod_log WHERE CAST(created_at AS INTEGER) < ?1",
        rusqlite::params![cutoff_ms],
    ).map_err(|e| e.to_string())?;

    // Row-cap prune: if still over the cap, delete the oldest rows
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM mod_log", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let cap_deleted = if total > cap as i64 {
        let excess = total - cap as i64;
        conn.execute(
            "DELETE FROM mod_log WHERE id IN (SELECT id FROM mod_log ORDER BY created_at ASC LIMIT ?1)",
            rusqlite::params![excess],
        ).map_err(|e| e.to_string())?
    } else {
        0
    };

    Ok(age_deleted + cap_deleted)
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

/// Returns a minimal ISO-8601 UTC timestamp (seconds resolution) for ban expiry comparisons.
fn chrono_now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Format as YYYY-MM-DDTHH:MM:SSZ
    let s = secs;
    let sec   = s % 60;
    let min_t = s / 60;
    let min   = min_t % 60;
    let hr_t  = min_t / 60;
    let hr    = hr_t % 24;
    let days  = hr_t / 24;
    // Simple date arithmetic — accurate for ~100 years
    let mut year: u64 = 1970;
    let mut days_left = days;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: u64 = if leap { 366 } else { 365 };
        if days_left < yd { break; }
        days_left -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_days: [u64; 12] = if leap {
        [31,29,28,31,30,31,30,31,31,30,31,30]
    } else {
        [31,28,28,31,30,31,30,31,31,30,31,30]
    };
    let mut month: u64 = 1;
    for md in &month_days {
        if days_left < *md { break; }
        days_left -= md;
        month += 1;
    }
    let day = days_left + 1;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, hr, min, sec)
}

// ── Governance: tally helper ──────────────────────────────────────────────────

/// Deterministic governance outcome calculation.
/// - Quorum: ≥40% of eligible voters participated
/// - Majority: >50% of non-abstaining votes are approve
/// - Reject veto: ≥30% of participants cast a reject vote → always fails
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct GovernanceOutcome {
    pub passed: bool,
    pub fail_reason: Option<String>,
}

pub fn compute_governance_outcome(
    eligible: i64,
    approve_votes: i64,
    reject_votes: i64,
    abstain_votes: i64,
) -> GovernanceOutcome {
    let participants = approve_votes + reject_votes + abstain_votes;
    let quorum_ok = (participants as f64) / (eligible.max(1) as f64) >= 0.40;
    let non_abstain = (approve_votes + reject_votes).max(1);
    let majority_ok = (approve_votes as f64) / (non_abstain as f64) > 0.50;
    let reject_veto = (reject_votes as f64) / (participants.max(1) as f64) >= 0.30;

    let passed = quorum_ok && majority_ok && !reject_veto;
    let fail_reason = if !quorum_ok {
        Some("quorum".to_string())
    } else if reject_veto {
        Some("reject_veto".to_string())
    } else if !majority_ok {
        Some("majority".to_string())
    } else {
        None
    };
    GovernanceOutcome { passed, fail_reason }
}

// ── Governance: row mappers ───────────────────────────────────────────────────

fn row_to_governance_motion(row: &rusqlite::Row) -> rusqlite::Result<GovernanceMotionRow> {
    Ok(GovernanceMotionRow {
        id:                          row.get(0)?,
        server_id:                   row.get(1)?,
        motion_type:                 row.get(2)?,
        state:                       row.get(3)?,
        is_binding:                  row.get::<_, i64>(4)? != 0,
        seat_count:                  row.get(5)?,
        proposer_user_id:            row.get(6)?,
        eligibility_snapshot_json:   row.get(7)?,
        discussion_open_at:          row.get(8)?,
        vote_open_at:                row.get(9)?,
        vote_close_at:               row.get(10)?,
        ruleset_json:                row.get(11)?,
        created_at:                  row.get(12)?,
        updated_at:                  row.get(13)?,
    })
}

fn row_to_governance_candidate(row: &rusqlite::Row) -> rusqlite::Result<GovernanceCandidateRow> {
    Ok(GovernanceCandidateRow {
        motion_id:            row.get(0)?,
        candidate_user_id:    row.get(1)?,
        source:               row.get(2)?,
        nominated_by_user_id: row.get(3)?,
        seconded_by_user_id:  row.get(4)?,
        status:               row.get(5)?,
        created_at:           row.get(6)?,
        updated_at:           row.get(7)?,
    })
}

fn row_to_governance_ballot(row: &rusqlite::Row) -> rusqlite::Result<GovernanceBallotRow> {
    Ok(GovernanceBallotRow {
        motion_id:                   row.get(0)?,
        voter_user_id:               row.get(1)?,
        approved_candidate_ids_json: row.get(2)?,
        reject_vote:                 row.get::<_, i64>(3)? != 0,
        abstain_vote:                row.get::<_, i64>(4)? != 0,
        revision:                    row.get(5)?,
        updated_at:                  row.get(6)?,
    })
}

fn row_to_governance_post(row: &rusqlite::Row) -> rusqlite::Result<GovernancePostRow> {
    Ok(GovernancePostRow {
        id:             row.get(0)?,
        motion_id:      row.get(1)?,
        parent_post_id: row.get(2)?,
        author_user_id: row.get(3)?,
        content:        row.get(4)?,
        created_at:     row.get(5)?,
        edited_at:      row.get(6)?,
        deleted_at:     row.get(7)?,
    })
}

// ── Governance: DB commands ───────────────────────────────────────────────────

#[tauri::command]
pub fn db_save_governance_motion(
    state: State<AppState>,
    motion: GovernanceMotionRow,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO governance_motions
         (id, server_id, type, state, is_binding, seat_count, proposer_user_id,
          eligibility_snapshot_json, discussion_open_at, vote_open_at, vote_close_at,
          ruleset_json, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        rusqlite::params![
            motion.id, motion.server_id, motion.motion_type, motion.state,
            motion.is_binding as i64, motion.seat_count, motion.proposer_user_id,
            motion.eligibility_snapshot_json, motion.discussion_open_at,
            motion.vote_open_at, motion.vote_close_at, motion.ruleset_json,
            motion.created_at, motion.updated_at
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_load_governance_motions(
    state: State<AppState>,
    server_id: String,
    state_filter: Option<String>,
) -> Result<Vec<GovernanceMotionRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let rows = if let Some(s) = state_filter {
        let mut stmt = conn.prepare(
            "SELECT id, server_id, type, state, is_binding, seat_count, proposer_user_id,
             eligibility_snapshot_json, discussion_open_at, vote_open_at, vote_close_at,
             ruleset_json, created_at, updated_at
             FROM governance_motions WHERE server_id = ?1 AND state = ?2
             ORDER BY updated_at DESC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![server_id, s], row_to_governance_motion)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, server_id, type, state, is_binding, seat_count, proposer_user_id,
             eligibility_snapshot_json, discussion_open_at, vote_open_at, vote_close_at,
             ruleset_json, created_at, updated_at
             FROM governance_motions WHERE server_id = ?1
             ORDER BY updated_at DESC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![server_id], row_to_governance_motion)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    Ok(rows)
}

#[tauri::command]
pub fn db_save_governance_candidate(
    state: State<AppState>,
    candidate: GovernanceCandidateRow,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO governance_candidates
         (motion_id, candidate_user_id, source, nominated_by_user_id, seconded_by_user_id,
          status, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![
            candidate.motion_id, candidate.candidate_user_id, candidate.source,
            candidate.nominated_by_user_id, candidate.seconded_by_user_id,
            candidate.status, candidate.created_at, candidate.updated_at
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_load_governance_candidates(
    state: State<AppState>,
    motion_id: String,
) -> Result<Vec<GovernanceCandidateRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT motion_id, candidate_user_id, source, nominated_by_user_id, seconded_by_user_id,
         status, created_at, updated_at
         FROM governance_candidates WHERE motion_id = ?1 ORDER BY created_at ASC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&motion_id], row_to_governance_candidate)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn db_save_governance_ballot(
    state: State<AppState>,
    ballot: GovernanceBallotRow,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO governance_ballots
         (motion_id, voter_user_id, approved_candidate_ids_json, reject_vote, abstain_vote,
          revision, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![
            ballot.motion_id, ballot.voter_user_id, ballot.approved_candidate_ids_json,
            ballot.reject_vote as i64, ballot.abstain_vote as i64,
            ballot.revision, ballot.updated_at
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_load_governance_ballots(
    state: State<AppState>,
    motion_id: String,
) -> Result<Vec<GovernanceBallotRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT motion_id, voter_user_id, approved_candidate_ids_json, reject_vote, abstain_vote,
         revision, updated_at
         FROM governance_ballots WHERE motion_id = ?1 ORDER BY updated_at ASC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&motion_id], row_to_governance_ballot)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn db_save_governance_post(
    state: State<AppState>,
    post: GovernancePostRow,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO governance_posts
         (id, motion_id, parent_post_id, author_user_id, content, created_at, edited_at, deleted_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![
            post.id, post.motion_id, post.parent_post_id, post.author_user_id,
            post.content, post.created_at, post.edited_at, post.deleted_at
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_load_governance_posts(
    state: State<AppState>,
    motion_id: String,
) -> Result<Vec<GovernancePostRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, motion_id, parent_post_id, author_user_id, content, created_at, edited_at, deleted_at
         FROM governance_posts WHERE motion_id = ?1 AND deleted_at IS NULL
         ORDER BY created_at ASC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&motion_id], row_to_governance_post)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Compute the governance outcome for a closed motion.
/// Returns `GovernanceOutcome` with pass/fail and reason.
#[tauri::command]
pub fn db_tally_governance_motion(
    state: State<AppState>,
    motion_id: String,
    eligible_count: i64,
) -> Result<GovernanceOutcome, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let approve: i64 = conn.query_row(
        "SELECT COUNT(*) FROM governance_ballots WHERE motion_id=?1 AND reject_vote=0 AND abstain_vote=0",
        [&motion_id],
        |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    let reject: i64 = conn.query_row(
        "SELECT COUNT(*) FROM governance_ballots WHERE motion_id=?1 AND reject_vote=1",
        [&motion_id],
        |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    let abstain: i64 = conn.query_row(
        "SELECT COUNT(*) FROM governance_ballots WHERE motion_id=?1 AND abstain_vote=1 AND reject_vote=0",
        [&motion_id],
        |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    Ok(compute_governance_outcome(eligible_count, approve, reject, abstain))
}

// ── Governance: runoff detection ───────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub struct RankedCandidate {
    pub candidate_id: String,
    pub approvals:    i64,
}

#[derive(Debug)]
#[allow(dead_code)]
pub struct RunoffSpec {
    pub parent_motion_id: String,
    pub seat_count:       i64,
    pub candidate_ids:    Vec<String>,
}

/// Build a runoff spec when tied candidates straddle the seat-count boundary.
/// Returns None if the provided list has fewer than 2 candidates.
#[allow(dead_code)]
pub fn build_runoff_from_boundary_tie(
    parent_motion_id: &str,
    remaining_seats: i64,
    tied: &[RankedCandidate],
) -> Option<RunoffSpec> {
    if tied.len() < 2 {
        return None;
    }
    Some(RunoffSpec {
        parent_motion_id: parent_motion_id.to_string(),
        seat_count:       remaining_seats,
        candidate_ids:    tied.iter().map(|c| c.candidate_id.clone()).collect(),
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::db::{migrations, types::*};
    use rusqlite::Connection;
    use super::{compute_governance_outcome, build_runoff_from_boundary_tie, RankedCandidate};

    /// Create an isolated in-memory DB with all migrations applied.
    fn test_conn() -> Connection {
        let mut conn = Connection::open_in_memory().expect("in-memory DB");
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        migrations::run(&mut conn);
        conn
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn save_mutation(conn: &Connection, id: &str, mut_type: &str, target_id: &str, channel_id: &str,
                     author_id: &str, emoji_id: Option<&str>, logical_ts: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO mutations
             (id, type, target_id, channel_id, author_id, new_content, emoji_id,
              logical_ts, created_at, verified)
             VALUES (?1,?2,?3,?4,?5,NULL,?6,?7,'2025-01-01',1)",
            rusqlite::params![id, mut_type, target_id, channel_id, author_id, emoji_id, logical_ts],
        ).unwrap();
    }

    fn save_message(conn: &Connection, msg: &MessageRow) {
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
        ).unwrap();
    }

    fn load_message(conn: &Connection, id: &str) -> Option<MessageRow> {
        conn.query_row(
            "SELECT id, channel_id, server_id, author_id, content, content_type,
             reply_to_id, created_at, logical_ts, verified, raw_attachments
             FROM messages WHERE id = ?1",
            [id],
            |row| Ok(MessageRow {
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
            }),
        ).ok()
    }


    fn save_device(conn: &Connection, d: &DeviceRow) {
        conn.execute(
            "INSERT OR REPLACE INTO devices
             (device_id, user_id, public_sign_key, public_dh_key,
              attested_by, attestation_sig, revoked, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                d.device_id, d.user_id, d.public_sign_key, d.public_dh_key,
                d.attested_by, d.attestation_sig, d.revoked as i64, d.created_at
            ],
        ).unwrap();
    }

    fn load_device(conn: &Connection, device_id: &str) -> Option<DeviceRow> {
        conn.query_row(
            "SELECT device_id, user_id, public_sign_key, public_dh_key,
             attested_by, attestation_sig, revoked, created_at
             FROM devices WHERE device_id = ?1",
            [device_id],
            |row| Ok(DeviceRow {
                device_id:       row.get(0)?,
                user_id:         row.get(1)?,
                public_sign_key: row.get(2)?,
                public_dh_key:   row.get(3)?,
                attested_by:     row.get(4)?,
                attestation_sig: row.get(5)?,
                revoked:         row.get::<_, i64>(6)? != 0,
                created_at:      row.get(7)?,
            }),
        ).ok()
    }

    fn upsert_member(conn: &Connection, m: &MemberRow) {
        conn.execute(
            "INSERT OR REPLACE INTO members
             (user_id, server_id, display_name, roles, joined_at,
              public_sign_key, public_dh_key, online_status,
              bio, banner_color, avatar_hash, banner_hash)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            rusqlite::params![
                m.user_id, m.server_id, m.display_name, m.roles,
                m.joined_at, m.public_sign_key, m.public_dh_key, m.online_status,
                m.bio, m.banner_color,
                m.avatar_hash, m.banner_hash,
            ],
        ).unwrap();
    }

    fn load_member(conn: &Connection, user_id: &str, server_id: &str) -> Option<MemberRow> {
        conn.query_row(
            "SELECT user_id, server_id, display_name, roles, joined_at,
             public_sign_key, public_dh_key, online_status,
             bio, banner_color, avatar_hash, banner_hash
             FROM members WHERE user_id = ?1 AND server_id = ?2",
            [user_id, server_id],
            |row| Ok(MemberRow {
                user_id:         row.get(0)?,
                server_id:       row.get(1)?,
                display_name:    row.get(2)?,
                roles:           row.get(3)?,
                joined_at:       row.get(4)?,
                public_sign_key: row.get(5)?,
                public_dh_key:   row.get(6)?,
                online_status:   row.get(7)?,
                bio:             row.get(8)?,
                banner_color:    row.get(9)?,
                avatar_hash:     row.get(10)?,
                banner_hash:     row.get(11)?,
            }),
        ).ok()
    }

    /// Insert the server + channel rows required by FK constraints on messages.
    fn seed_server_and_channel(conn: &Connection, server_id: &str, channel_id: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO servers (id, name, owner_id, created_at, raw_json)
             VALUES (?1, 'Test Server', 'owner', '2025-01-01', '{}')",
            [server_id],
        ).unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO channels (id, server_id, name, type, position, created_at)
             VALUES (?1, ?2, 'general', 'text', 0, '2025-01-01')",
            [channel_id, server_id],
        ).unwrap();
    }

    /// Insert a server row required by FK constraints on members.
    fn seed_server(conn: &Connection, server_id: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO servers (id, name, owner_id, created_at, raw_json)
             VALUES (?1, 'Test Server', 'owner', '2025-01-01', '{}')",
            [server_id],
        ).unwrap();
    }

    fn make_message(id: &str, channel_id: &str, logical_ts: &str) -> MessageRow {
        MessageRow {
            id:              id.to_string(),
            channel_id:      channel_id.to_string(),
            server_id:       "srv-1".to_string(),
            author_id:       "alice".to_string(),
            content:         Some("hello".to_string()),
            content_type:    "text".to_string(),
            reply_to_id:     None,
            created_at:      "2025-01-01T00:00:00Z".to_string(),
            logical_ts:      logical_ts.to_string(),
            verified:        true,
            raw_attachments: None,
        }
    }

    #[test]
    fn governance_tables_exist_after_migration() {
        let mut conn = Connection::open_in_memory().expect("in-memory DB");
        migrations::run(&mut conn);

        let names: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'governance_%' ORDER BY name",
                )
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };

        assert!(names.contains(&"governance_motions".to_string()));
        assert!(names.contains(&"governance_candidates".to_string()));
        assert!(names.contains(&"governance_ballots".to_string()));
        assert!(names.contains(&"governance_posts".to_string()));

        let motion_columns: Vec<String> = {
            let mut stmt = conn
                .prepare("PRAGMA table_info(governance_motions)")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert!(
            motion_columns.contains(&"type".to_string()),
            "governance_motions must expose wire/schema column named 'type'"
        );

        let has_motion_state_index: bool = {
            let mut stmt = conn
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_governance_motions_server_state' LIMIT 1",
                )
                .unwrap();
            stmt.query_row([], |_r| Ok(())).is_ok()
        };
        assert!(
            has_motion_state_index,
            "required index idx_governance_motions_server_state is missing"
        );

        let candidate_fk_count: usize = {
            let mut stmt = conn
                .prepare("PRAGMA foreign_key_list(governance_candidates)")
                .unwrap();
            stmt.query_map([], |_r| Ok(()))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .len()
        };
        assert!(
            candidate_fk_count > 0,
            "governance_candidates must include at least one foreign key"
        );

        let ballot_fk_count: usize = {
            let mut stmt = conn
                .prepare("PRAGMA foreign_key_list(governance_ballots)")
                .unwrap();
            stmt.query_map([], |_r| Ok(()))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .len()
        };
        assert!(
            ballot_fk_count > 0,
            "governance_ballots must include at least one foreign key"
        );
    }

    // ── Governance tally tests ────────────────────────────────────────────────

    #[test]
    fn tally_passes_with_quorum_majority_and_no_reject_veto() {
        // 50 eligible, 16 approve, 8 reject, 6 abstain → 30/50=60% quorum, 16/24=67% majority, 8/30=27% reject
        let result = compute_governance_outcome(50, 16, 8, 6);
        assert!(result.passed, "expected pass but got: {:?}", result.fail_reason);
    }

    #[test]
    fn tally_fails_when_reject_veto_hits_30_percent_participants() {
        // 50 eligible, 18 approve, 15 reject, 2 abstain → 35/50=70% quorum, 15/35=43% reject
        let result = compute_governance_outcome(50, 18, 15, 2);
        assert!(!result.passed);
        assert_eq!(result.fail_reason.as_deref(), Some("reject_veto"));
    }

    #[test]
    fn tally_fails_when_quorum_not_met() {
        // 100 eligible, only 10 vote → 10% < 40%
        let result = compute_governance_outcome(100, 6, 2, 2);
        assert!(!result.passed);
        assert_eq!(result.fail_reason.as_deref(), Some("quorum"));
    }

    #[test]
    fn tally_fails_when_majority_not_met() {
        // 10 eligible, 5 approve, 6 reject (quorum ok, reject_veto: 6/11 = 55% >= 30% → reject_veto wins)
        // so test a case where majority fails but reject is under 30%:
        // 20 eligible, 10 approve, 5 reject, 5 abstain → 20/20 quorum, 5/15=33% reject → veto
        // Need: quorum ok, reject < 30%, approve <= 50%
        // 20 eligible, 5 approve, 5 reject, 5 abstain → 15/20=75% quorum, 5/10=50% reject → veto
        // 20 eligible, 10 approve, 2 reject, 9 abstain → 21/20>100% quorum, 2/12=17% reject, 10/12=83% approve → PASS
        // Let's do: 20 eligible, 4 approve, 2 reject, 10 abstain → 16/20=80% quorum, 2/6=33% reject → veto
        // Need reject < 30% and approve <= non-abstain/2:
        // 20 eligible, 5 approve, 1 reject, 10 abstain → 16/20=80%, 1/6=17% reject, 5/6=83% approve → PASS
        // 20 eligible, 3 approve, 1 reject, 12 abstain → 16/20=80%, 1/4=25% reject, 3/4=75% approve → PASS
        // To fail majority: approve must be <= non_abstain/2
        // 20 eligible, 3 approve, 4 reject, 9 abstain → 16/20=80%, 4/16=25% reject(ok), 3/7=43% approve < 50%
        let result = compute_governance_outcome(20, 3, 4, 9);
        assert!(!result.passed);
        assert_eq!(result.fail_reason.as_deref(), Some("majority"));
    }

    #[test]
    fn tally_round_trip_via_db_save_load_ballot() {
        let conn = test_conn();
        // Use the standard seed helper so FK constraints are satisfied
        seed_server_and_channel(&conn, "srv-1", "ch-1");
        // Insert a parent governance_motion (FK parent of governance_ballots)
        conn.execute(
            "INSERT INTO governance_motions (id, server_id, type, state, is_binding, seat_count, proposer_user_id, ruleset_json, created_at, updated_at)
             VALUES ('m1','srv-1','non_binding_poll','voting',0,1,'alice','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO governance_ballots (motion_id, voter_user_id, approved_candidate_ids_json, reject_vote, abstain_vote, revision, updated_at)
             VALUES ('m1','alice','[]',0,0,1,'2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM governance_ballots WHERE motion_id='m1'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_save_and_load_message_round_trip() {
        let conn = test_conn();
        seed_server_and_channel(&conn, "srv-1", "ch-1");
        let msg = make_message("msg-1", "ch-1", "1000000000000-000000");
        save_message(&conn, &msg);

        let loaded = load_message(&conn, "msg-1").expect("message not found");
        assert_eq!(loaded.id,           msg.id);
        assert_eq!(loaded.channel_id,   msg.channel_id);
        assert_eq!(loaded.content,      msg.content);
        assert_eq!(loaded.content_type, msg.content_type);
        assert_eq!(loaded.verified,     true);
    }

    #[test]
    fn test_load_messages_empty_channel_returns_empty() {
        let conn = test_conn();
        let mut stmt = conn.prepare(
            "SELECT id FROM messages WHERE channel_id = 'ghost-channel' ORDER BY logical_ts DESC LIMIT 100"
        ).unwrap();
        let rows: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap()
            .collect::<Result<_, _>>().unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn test_cursor_pagination_excludes_messages_at_or_after_cursor() {
        let conn = test_conn();
        seed_server_and_channel(&conn, "srv-1", "ch-1");
        save_message(&conn, &make_message("msg-1", "ch-1", "1000000000000-000000"));
        save_message(&conn, &make_message("msg-2", "ch-1", "1000000000000-000001"));
        save_message(&conn, &make_message("msg-3", "ch-1", "1000000000000-000002"));

        let sql = "SELECT id FROM messages
                   WHERE channel_id = 'ch-1'
                   AND logical_ts < (SELECT logical_ts FROM messages WHERE id = ?1)
                   ORDER BY logical_ts DESC LIMIT 100";
        let mut stmt = conn.prepare(sql).unwrap();
        let ids: Vec<String> = stmt.query_map(["msg-3"], |r| r.get(0)).unwrap()
            .collect::<Result<_, _>>().unwrap();

        assert_eq!(ids.len(), 2);
        assert!(!ids.contains(&"msg-3".to_string()));
    }

    // ── db_save_mutation side effects ─────────────────────────────────────────

    #[test]
    fn test_delete_mutation_nulls_message_content() {
        let conn = test_conn();
        seed_server_and_channel(&conn, "srv-1", "ch-1");
        save_message(&conn, &make_message("msg-del", "ch-1", "1000000000000-000000"));

        conn.execute(
            "UPDATE messages SET content = NULL, raw_attachments = NULL WHERE id = ?1",
            ["msg-del"],
        ).unwrap();

        let loaded = load_message(&conn, "msg-del").expect("message not found");
        assert!(loaded.content.is_none(), "content should be NULL after delete");
    }

    #[test]
    fn test_edit_mutation_updates_content_when_newer() {
        let conn = test_conn();
        seed_server_and_channel(&conn, "srv-1", "ch-1");
        save_message(&conn, &make_message("msg-edit", "ch-1", "1000000000000-000000"));

        // Edit at ts=1 > message's ts=0 — should apply
        conn.execute(
            "UPDATE messages SET content = ?1 WHERE id = ?2 AND logical_ts < ?3",
            ("updated content", "msg-edit", "1000000000000-000001"),
        ).unwrap();

        let loaded = load_message(&conn, "msg-edit").expect("message not found");
        assert_eq!(loaded.content.as_deref(), Some("updated content"));
    }

    #[test]
    fn test_edit_mutation_does_not_apply_when_message_has_newer_logical_ts() {
        let conn = test_conn();
        seed_server_and_channel(&conn, "srv-1", "ch-1");
        // Message at ts=5
        save_message(&conn, &make_message("msg-edit2", "ch-1", "1000000000000-000005"));

        // Stale edit at ts=3 — WHERE clause fails, no update
        conn.execute(
            "UPDATE messages SET content = ?1 WHERE id = ?2 AND logical_ts < ?3",
            ("stale edit", "msg-edit2", "1000000000000-000003"),
        ).unwrap();

        let loaded = load_message(&conn, "msg-edit2").expect("message not found");
        assert_eq!(loaded.content.as_deref(), Some("hello"), "stale edit must not win");
    }

    // ── db_upsert_member ──────────────────────────────────────────────────────

    #[test]
    fn test_upsert_member_inserts_then_updates_without_duplication() {
        let conn = test_conn();
        seed_server(&conn, "srv-1");

        let member = MemberRow {
            user_id:         "user-bob".to_string(),
            server_id:       "srv-1".to_string(),
            display_name:    "Bob".to_string(),
            roles:           Some("[\"member\"]".to_string()),
            joined_at:       "2025-01-01T00:00:00Z".to_string(),
            public_sign_key: "sign-pub".to_string(),
            public_dh_key:   "dh-pub".to_string(),
            online_status:   "online".to_string(),
            bio:             None,
            banner_color:    None,
            avatar_hash:     None,
            banner_hash:     None,
        };
        upsert_member(&conn, &member);

        let m1 = load_member(&conn, "user-bob", "srv-1").expect("first insert");
        assert_eq!(m1.display_name, "Bob");

        let updated = MemberRow { display_name: "Bobby".to_string(), ..member };
        upsert_member(&conn, &updated);

        let m2 = load_member(&conn, "user-bob", "srv-1").expect("after update");
        assert_eq!(m2.display_name, "Bobby");

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM members WHERE user_id = 'user-bob' AND server_id = 'srv-1'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 1, "upsert must not create duplicate rows");
    }

    // ── db_save_device / db_load_devices ──────────────────────────────────────

    #[test]
    fn test_device_revoked_false_round_trips_as_false() {
        let conn = test_conn();
        let device = DeviceRow {
            device_id:       "dev-1".to_string(),
            user_id:         "alice".to_string(),
            public_sign_key: "spk".to_string(),
            public_dh_key:   "dhpk".to_string(),
            attested_by:     None,
            attestation_sig: None,
            revoked:         false,
            created_at:      "2025-01-01".to_string(),
        };
        save_device(&conn, &device);

        let loaded = load_device(&conn, "dev-1").expect("device not found");
        assert_eq!(loaded.revoked, false);
    }

    #[test]
    fn test_device_revoked_true_round_trips_as_true() {
        let conn = test_conn();
        let device = DeviceRow {
            device_id:       "dev-2".to_string(),
            user_id:         "alice".to_string(),
            public_sign_key: "spk2".to_string(),
            public_dh_key:   "dhpk2".to_string(),
            attested_by:     None,
            attestation_sig: None,
            revoked:         true,
            created_at:      "2025-01-01".to_string(),
        };
        save_device(&conn, &device);

        let loaded = load_device(&conn, "dev-2").expect("device not found");
        assert_eq!(loaded.revoked, true);
    }

    #[test]
    fn test_two_devices_for_same_user_both_loadable() {
        let conn = test_conn();
        for i in 1..=2_u32 {
            save_device(&conn, &DeviceRow {
                device_id:       format!("dev-{i}"),
                user_id:         "alice".to_string(),
                public_sign_key: format!("spk-{i}"),
                public_dh_key:   format!("dhpk-{i}"),
                attested_by:     None,
                attestation_sig: None,
                revoked:         false,
                created_at:      "2025-01-01".to_string(),
            });
        }

        let mut stmt = conn.prepare(
            "SELECT device_id FROM devices WHERE user_id = 'alice'"
        ).unwrap();
        let ids: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap()
            .collect::<Result<_, _>>().unwrap();
        assert_eq!(ids.len(), 2);
    }

    // ── reaction_add idempotency ──────────────────────────────────────────────

    #[test]
    fn test_reaction_add_insert_or_ignore_is_idempotent() {
        let conn = test_conn();
        seed_server_and_channel(&conn, "srv-1", "ch-1");
        save_message(&conn, &make_message("msg-r1", "ch-1", "1000000000000-000000"));

        // Insert same mutation ID twice — second must be ignored
        save_mutation(&conn, "mut-r1", "reaction_add", "msg-r1", "ch-1", "user-bob", Some("👍"), "1000000000001-000000");
        save_mutation(&conn, "mut-r1", "reaction_add", "msg-r1", "ch-1", "user-bob", Some("👍"), "1000000000001-000000");

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM mutations WHERE id = 'mut-r1'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 1, "INSERT OR IGNORE must prevent duplicate mutation rows");
    }

    // ── reaction_remove after reaction_add ────────────────────────────────────

    #[test]
    fn test_reaction_add_and_remove_both_stored_for_frontend_fold() {
        let conn = test_conn();
        seed_server_and_channel(&conn, "srv-1", "ch-1");
        save_message(&conn, &make_message("msg-r2", "ch-1", "1000000000000-000000"));

        save_mutation(&conn, "mut-add", "reaction_add",    "msg-r2", "ch-1", "user-bob", Some("👍"), "1000000000001-000000");
        save_mutation(&conn, "mut-rem", "reaction_remove", "msg-r2", "ch-1", "user-bob", Some("👍"), "1000000000002-000000");

        // Both mutations must be present — frontend's computeReactions folds them to 0
        let add_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM mutations WHERE target_id = 'msg-r2' AND type = 'reaction_add'",
            [], |r| r.get(0),
        ).unwrap();
        let rem_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM mutations WHERE target_id = 'msg-r2' AND type = 'reaction_remove'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(add_count, 1);
        assert_eq!(rem_count, 1);
    }

    // ── db_upsert_member: preserves all fields on display_name-only update ────

    #[test]
    fn test_upsert_member_preserves_fields_when_updating_display_name_only() {
        let conn = test_conn();
        seed_server(&conn, "srv-1");

        let original = MemberRow {
            user_id:         "user-carol".to_string(),
            server_id:       "srv-1".to_string(),
            display_name:    "Carol".to_string(),
            roles:           Some("[\"admin\",\"member\"]".to_string()),
            joined_at:       "2025-03-15T10:00:00Z".to_string(),
            public_sign_key: "original-sign-key".to_string(),
            public_dh_key:   "original-dh-key".to_string(),
            online_status:   "online".to_string(),
            bio:             None,
            banner_color:    None,
            avatar_hash:     None,
            banner_hash:     None,
        };
        upsert_member(&conn, &original);

        // Second upsert changes only display_name
        let updated = MemberRow { display_name: "Carol Updated".to_string(), ..original.clone() };
        upsert_member(&conn, &updated);

        let loaded = load_member(&conn, "user-carol", "srv-1").expect("member must still exist");
        assert_eq!(loaded.display_name,    "Carol Updated");
        assert_eq!(loaded.roles,           original.roles,           "roles must be preserved");
        assert_eq!(loaded.public_sign_key, original.public_sign_key, "sign key must be preserved");
        assert_eq!(loaded.public_dh_key,   original.public_dh_key,   "dh key must be preserved");
        assert_eq!(loaded.joined_at,       original.joined_at,       "joined_at must be preserved");
    }

    // ── FTS5 search ───────────────────────────────────────────────────────────

    fn search_messages_in(
        conn: &Connection,
        server_id: &str,
        query: &str,
        channel_id: Option<&str>,
    ) -> Vec<MessageRow> {
        // Reproduce the same sanitisation as the Tauri command
        let fts_query = if query.contains('"') || query.contains('*') {
            query.to_string()
        } else {
            format!("\"{}\"", query.replace('"', "\"\""))
        };

        let rows: Vec<MessageRow> = if let Some(cid) = channel_id {
            let sql = "SELECT m.id, m.channel_id, m.server_id, m.author_id, m.content, m.content_type,
                       m.reply_to_id, m.created_at, m.logical_ts, m.verified, m.raw_attachments
                       FROM messages m
                       WHERE m.server_id = ?1
                         AND m.channel_id = ?2
                         AND m.content IS NOT NULL
                         AND m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?3)
                       ORDER BY m.logical_ts DESC LIMIT 50";
            let mut stmt = conn.prepare(sql).unwrap();
            stmt.query_map(rusqlite::params![server_id, cid, fts_query], |row| {
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
            }).unwrap().collect::<Result<Vec<_>, _>>().unwrap()
        } else {
            let sql = "SELECT m.id, m.channel_id, m.server_id, m.author_id, m.content, m.content_type,
                       m.reply_to_id, m.created_at, m.logical_ts, m.verified, m.raw_attachments
                       FROM messages m
                       WHERE m.server_id = ?1
                         AND m.content IS NOT NULL
                         AND m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?2)
                       ORDER BY m.logical_ts DESC LIMIT 50";
            let mut stmt = conn.prepare(sql).unwrap();
            stmt.query_map(rusqlite::params![server_id, fts_query], |row| {
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
            }).unwrap().collect::<Result<Vec<_>, _>>().unwrap()
        };
        rows
    }

    fn insert_message_with_content(conn: &Connection, id: &str, channel_id: &str, server_id: &str, content: Option<&str>) {
        save_message(conn, &MessageRow {
            id:              id.to_string(),
            channel_id:      channel_id.to_string(),
            server_id:       server_id.to_string(),
            author_id:       "author-1".to_string(),
            content:         content.map(str::to_string),
            content_type:    "text".to_string(),
            reply_to_id:     None,
            created_at:      "1000".to_string(),
            logical_ts:      format!("{}-000001", id),
            verified:        true,
            raw_attachments: None,
        });
    }

    #[test]
    fn fts5_exact_match_returns_message() {
        let conn = test_conn();
        seed_server_and_channel(&conn, "srv-1", "ch-1");
        insert_message_with_content(&conn, "msg-1", "ch-1", "srv-1", Some("Hello world, this is a test message"));
        insert_message_with_content(&conn, "msg-2", "ch-1", "srv-1", Some("An unrelated message about cats"));

        let results = search_messages_in(&conn, "srv-1", "Hello world", None);
        assert_eq!(results.len(), 1, "exact phrase should match exactly one message");
        assert_eq!(results[0].id, "msg-1");
    }

    #[test]
    fn fts5_partial_word_match() {
        let conn = test_conn();
        seed_server_and_channel(&conn, "srv-1", "ch-1");
        insert_message_with_content(&conn, "msg-a", "ch-1", "srv-1", Some("The quick brown fox jumps"));
        insert_message_with_content(&conn, "msg-b", "ch-1", "srv-1", Some("Foxes are clever animals"));

        // FTS5 phrase search is word-boundary; "fox" alone won't match "Foxes" unless trailing *
        // Use wildcard syntax for prefix match
        let results = search_messages_in(&conn, "srv-1", "fox*", None);
        assert!(results.len() >= 1, "wildcard prefix should match at least one message");
    }

    #[test]
    fn fts5_no_results_for_absent_term() {
        let conn = test_conn();
        seed_server_and_channel(&conn, "srv-1", "ch-1");
        insert_message_with_content(&conn, "msg-x", "ch-1", "srv-1", Some("Hello everyone"));

        let results = search_messages_in(&conn, "srv-1", "xyzzy_nonexistent", None);
        assert!(results.is_empty(), "absent term should return no results");
    }

    #[test]
    fn fts5_excludes_null_content_deleted_rows() {
        let conn = test_conn();
        seed_server_and_channel(&conn, "srv-1", "ch-1");
        // Insert a message that was later deleted (content set to NULL)
        insert_message_with_content(&conn, "msg-del", "ch-1", "srv-1", Some("This message will be deleted"));
        conn.execute("UPDATE messages SET content = NULL WHERE id = 'msg-del'", []).unwrap();
        // The FTS index update trigger should fire on the UPDATE
        let results = search_messages_in(&conn, "srv-1", "deleted", None);
        assert!(results.is_empty(), "deleted messages (content IS NULL) must not appear in search results");
    }

    #[test]
    fn fts5_channel_scope_filter() {
        let conn = test_conn();
        seed_server(&conn, "srv-1");
        conn.execute("INSERT OR IGNORE INTO channels (id, server_id, name, type, position, created_at) VALUES ('ch-a','srv-1','general','text',0,'1000')", []).unwrap();
        conn.execute("INSERT OR IGNORE INTO channels (id, server_id, name, type, position, created_at) VALUES ('ch-b','srv-1','random','text',1,'1000')", []).unwrap();
        insert_message_with_content(&conn, "m-gen", "ch-a", "srv-1", Some("Unique phrase in general"));
        insert_message_with_content(&conn, "m-rand", "ch-b", "srv-1", Some("Unique phrase in random"));

        // Search all channels — should find both
        let all = search_messages_in(&conn, "srv-1", "Unique phrase", None);
        assert_eq!(all.len(), 2);

        // Scope to ch-a only — should find one
        let scoped = search_messages_in(&conn, "srv-1", "Unique phrase", Some("ch-a"));
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].id, "m-gen");
    }

    // ── apply_mutation_side_effects: new mutation types ───────────────────────

    use super::apply_mutation_side_effects;

    #[test]
    fn test_member_join_side_effect() {
        let conn = test_conn();
        let sid = "srv-join";
        seed_server(&conn, sid);
        let mutation = MutationRow {
            id: "m1".into(),
            mutation_type: "member_join".into(),
            target_id: "user42".into(),
            channel_id: "__server__".into(),
            author_id: "user42".into(),
            new_content: Some(format!(
                r#"{{"userId":"user42","serverId":"{}","displayName":"Alice","publicSignKey":"pk1","publicDHKey":"dk1","roles":["member"],"joinedAt":"2024-01-01T00:00:00Z"}}"#,
                sid
            )),
            emoji_id: None,
            logical_ts: "1000-000000".into(),
            created_at: "2024-01-01T00:00:00Z".into(),
            verified: true,
        };
        apply_mutation_side_effects(&conn, &mutation).unwrap();

        let display_name: String = conn.query_row(
            "SELECT display_name FROM members WHERE user_id = 'user42' AND server_id = ?1",
            [sid], |r| r.get(0),
        ).unwrap();
        assert_eq!(display_name, "Alice");
    }

    #[test]
    fn test_member_profile_update_side_effect() {
        let conn = test_conn();
        let sid = "srv-prof";
        seed_server(&conn, sid);
        // Pre-insert a member
        upsert_member(&conn, &MemberRow {
            user_id: "u1".into(),
            server_id: sid.into(),
            display_name: "Old".into(),
            roles: Some("[]".into()),
            joined_at: "2024-01-01T00:00:00Z".into(),
            public_sign_key: "pk".into(),
            public_dh_key: "dk".into(),
            online_status: "offline".into(),
            bio: None,
            banner_color: None,
            avatar_hash: None,
            banner_hash: None,
        });

        let mutation = MutationRow {
            id: "m2".into(),
            mutation_type: "member_profile_update".into(),
            target_id: "u1".into(),
            channel_id: "__server__".into(),
            author_id: "u1".into(),
            new_content: Some(format!(
                r#"{{"serverId":"{}","displayName":"New","avatarHash":"abc123"}}"#,
                sid
            )),
            emoji_id: None,
            logical_ts: "2000-000000".into(),
            created_at: "2024-06-01T00:00:00Z".into(),
            verified: true,
        };
        apply_mutation_side_effects(&conn, &mutation).unwrap();

        let (name, hash): (String, Option<String>) = conn.query_row(
            "SELECT display_name, avatar_hash FROM members WHERE user_id = 'u1' AND server_id = ?1",
            [sid], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(name, "New");
        assert_eq!(hash, Some("abc123".into()));
    }

    #[test]
    fn test_channel_create_side_effect() {
        let conn = test_conn();
        let sid = "srv-chcr";
        seed_server(&conn, sid);
        let mutation = MutationRow {
            id: "m3".into(),
            mutation_type: "channel_create".into(),
            target_id: "ch1".into(),
            channel_id: "__server__".into(),
            author_id: "u1".into(),
            new_content: Some(format!(
                r#"{{"id":"ch1","serverId":"{}","name":"general","type":"text","position":0}}"#,
                sid
            )),
            emoji_id: None,
            logical_ts: "1000-000000".into(),
            created_at: "2024-01-01T00:00:00Z".into(),
            verified: true,
        };
        apply_mutation_side_effects(&conn, &mutation).unwrap();

        let name: String = conn.query_row(
            "SELECT name FROM channels WHERE id = 'ch1'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(name, "general");
    }

    #[test]
    fn test_channel_delete_side_effect() {
        let conn = test_conn();
        let sid = "srv-chdel";
        let cid = "ch-del";
        seed_server_and_channel(&conn, sid, cid);
        let mutation = MutationRow {
            id: "m4".into(),
            mutation_type: "channel_delete".into(),
            target_id: cid.into(),
            channel_id: "__server__".into(),
            author_id: "u1".into(),
            new_content: None,
            emoji_id: None,
            logical_ts: "3000-000000".into(),
            created_at: "2024-01-01T00:00:00Z".into(),
            verified: true,
        };
        apply_mutation_side_effects(&conn, &mutation).unwrap();

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM channels WHERE id = ?1", [cid], |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 0);
    }

    // ── Runoff detection ──────────────────────────────────────────────────────

    #[test]
    fn creates_runoff_when_boundary_tie_detected() {
        let tied = vec![
            RankedCandidate { candidate_id: "c".into(), approvals: 13 },
            RankedCandidate { candidate_id: "d".into(), approvals: 13 },
        ];
        let runoff = build_runoff_from_boundary_tie("motion-1", 1, &tied).unwrap();
        assert_eq!(runoff.parent_motion_id, "motion-1");
        assert_eq!(runoff.seat_count, 1);
        assert_eq!(runoff.candidate_ids, vec!["c", "d"]);
    }

    #[test]
    fn no_runoff_when_fewer_than_two_candidates() {
        let tied = vec![
            RankedCandidate { candidate_id: "a".into(), approvals: 10 },
        ];
        let result = build_runoff_from_boundary_tie("motion-2", 1, &tied);
        assert!(result.is_none());
    }
}

