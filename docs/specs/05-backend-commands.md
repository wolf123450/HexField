# Spec 05 — Backend Rust Commands

> Parent: [Architecture Plan](../architecture-plan.md)

---

## 1. File Structure

```
src-tauri/src/
  lib.rs                  ← AppState, plugin registration, generate_handler! list
  db/
    mod.rs
    migrations.rs         ← rusqlite_migration setup, embed SQL files
    messages.rs
    mutations.rs
    servers.rs
    keys.rs
    devices.rs
  commands/
    db_commands.rs        ← #[tauri::command] wrappers
    system_commands.rs    ← screen sources, file paths
    net_commands.rs       ← signal_connect/disconnect/send WS actor
```

---

## 2. AppState

```rust
pub struct AppState {
    pub db:        Mutex<rusqlite::Connection>,
    pub signal_tx: Mutex<Option<tokio::sync::mpsc::Sender<serde_json::Value>>>,
}
```

---

## 3. Database Commands

```rust
// ── Messages ──────────────────────────────────────────────────────────────────
db_load_messages(channel_id: String, before_id: Option<String>, limit: Option<u32>)
    -> Vec<MessageRow>

db_save_message(msg: MessageRow) -> ()

// ── Mutations (edits, deletes, reactions, server events) ─────────────────────
// Replaces the old db_delete_message — all state changes go through mutations.
// db_save_mutation also applies side effects:
//   - 'delete':       NULLs messages.content + raw_attachments, deletes attachment files
//   - 'edit':         last-write-wins by logical_ts — updates messages.content
//   - 'server_update': applies JSON patch to cached server row
//   - 'channel_*':    creates/updates/deletes channel rows
db_save_mutation(mutation: MutationRow) -> ()

db_load_mutations(channel_id: String, after_ts: Option<String>) -> Vec<MutationRow>

// ── Servers & Channels ────────────────────────────────────────────────────────
db_load_servers() -> Vec<ServerRow>
db_save_server(server: ServerRow) -> ()
db_load_channels(server_id: String) -> Vec<ChannelRow>
db_save_channel(channel: ChannelRow) -> ()

// ── Keys ─────────────────────────────────────────────────────────────────────
// Phase 1: raw base64. Phase 2: passphrase-wrapped. Phase 3: delegate to OS keychain.
db_save_key(key_id: String, key_type: String, key_data: String) -> ()
db_load_key(key_id: String) -> Option<String>

// ── Members ───────────────────────────────────────────────────────────────────
db_load_members(server_id: String) -> Vec<MemberRow>
db_upsert_member(member: MemberRow) -> ()

// ── Emoji ─────────────────────────────────────────────────────────────────────
db_load_emoji(server_id: String) -> Vec<EmojiRow>
db_save_emoji(emoji: EmojiRow, image_bytes: Vec<u8>) -> ()
// Writes image to $APPDATA/gamechat/emoji/{serverId}/{emojiId}.webp, saves metadata row

get_emoji_image(emoji_id: String, server_id: String) -> Vec<u8>
// Reads file from disk; frontend converts to data: URI for <img> src

// ── Devices ───────────────────────────────────────────────────────────────────
db_load_devices(user_id: String) -> Vec<DeviceRow>
db_save_device(device: DeviceRow) -> ()
db_revoke_device(device_id: String) -> ()
```

---

## 4. System Commands

```rust
// Screen capture source enumeration
get_screen_sources() -> Vec<ScreenSource>
// Windows: EnumWindows (visible windows) + EnumDisplayMonitors (screens)
//   Thumbnails: PrintWindow + BitBlt → 256×144 PNG
//   Source IDs: "window:HWND_VALUE" | "screen:MONITOR_INDEX"
//   ⚠ chromeMediaSourceId support in WebView2 is UNVERIFIED — test at Phase 5
// macOS: returns empty vec (getDisplayMedia() native picker used instead)
// Linux X11: same as Windows pattern

// File system
get_app_data_path() -> String
show_save_file_dialog(filename: String) -> Option<String>
show_open_file_dialog(filters: Vec<DialogFilter>) -> Option<String>
```

---

## 5. Network Commands — WS Actor

```rust
signal_connect(state, app_handle, server_url: String, auth_token: String) -> ()
// Spawns a Tokio task (WS actor):
//   - Connects to rendezvous WS
//   - Loop:
//       incoming WS message → app_handle.emit("signal_message", payload)
//       incoming mpsc channel → send over WS
//       disconnect detected → app_handle.emit("signal_state", "disconnected") + reconnect
//                             reconnect uses exponential backoff: 1s → 2s → 4s → ... → 60s max

signal_disconnect(state) -> ()
signal_send(state, payload: serde_json::Value) -> ()
```

Frontend event listeners:

```typescript
await listen<SignalEnvelope>('signal_message', (e) =>
  networkStore.handleIncomingSignal(e.payload))
await listen<string>('signal_state', (e) =>
  networkStore.signalingState = e.payload as any)
```

---

## 6. MutationRow Side Effects (db_save_mutation detail)

When `db_save_mutation` is called, the Rust handler must apply side effects atomically:

| Mutation type | Side effect |
|--------------|-------------|
| `delete` | 1. `UPDATE messages SET content = NULL, raw_attachments = NULL WHERE id = target_id`<br>2. Parse old `raw_attachments` → delete each file from disk<br>3. `DELETE FROM messages_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = target_id)` |
| `edit` | `UPDATE messages SET content = new_content WHERE id = target_id AND logical_ts < mutation.logical_ts` (last-write-wins) |
| `reaction_add` / `reaction_remove` | No SQLite side effect — mutations table is the source of truth; reactions are materialised in the frontend |
| `server_update` | Parse `new_content` as JSON → apply fields to `servers` row |
| `channel_create` | Insert new row into `channels` |
| `channel_update` | Update `channels` row |
| `channel_delete` | Delete `channels` row (CASCADE deletes messages) |
| `role_assign` | Update `members.roles` JSON array |
| `role_revoke` | Remove role from `members.roles` JSON array |
| `device_attest` | Insert into `devices` |
| `device_revoke` | `UPDATE devices SET revoked = 1 WHERE device_id = target_id` |

All side effects are wrapped in a single SQLite transaction with the mutation INSERT.
