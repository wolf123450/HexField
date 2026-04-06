# WebRTC-rs Replacement Plan — Phase 1 (Data Channels)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser `RTCPeerConnection` in `webrtcService.ts` with a Rust implementation backed by the `webrtc` crate (v0.14). Phase 1 covers data channels only — peer messaging, sync, and LAN discovery. Voice/screen-share tracks remain in the JS side and are deferred to Phase 2.

**Architecture:** A new `WebRTCManager` struct in `src-tauri/src/webrtc_manager.rs` owns a map of live `RTCPeerConnection` objects (one per remote peer), drives async tokio tasks for each peer, and communicates back to the frontend via `app.emit()` Tauri events. Rust commands replace the JS `RTCPeerConnection` constructor calls. The existing `webrtcService.ts` is rewritten as a thin IPC wrapper that preserves the same public API surface so callers in `networkStore.ts` and elsewhere need minimal changes.

Signaling still flows through the existing WS/LAN paths in `networkStore.ts` — Rust produces offer/answer/ICE events that the frontend relays, and the frontend passes incoming signal payloads into Rust commands. This keeps the network topology unchanged.

**Phase 2 (deferred):** voice/screen tracks, `addAudioTrack`, `removeAudioTracks`, `addScreenShareTrack`, `removeScreenShareTrack`.

**Tech Stack:** Rust async (`tokio`), `webrtc = "0.14"` crate, `serde_json`, Tauri v2 `app.emit()` / `invoke()`, TypeScript strict.

**Spec:** `docs/specs/06-networking.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src-tauri/Cargo.toml` | Modify | Add `webrtc = "0.14"` dependency |
| `src-tauri/src/webrtc_manager.rs` | Create | `WebRTCManager` struct: peer map, ICE/DTLS/SCTP state machines, tokio drive tasks |
| `src-tauri/src/commands/webrtc_commands.rs` | Create | Tauri commands: `webrtc_init`, `webrtc_create_offer`, `webrtc_handle_offer`, `webrtc_handle_answer`, `webrtc_add_ice`, `webrtc_send`, `webrtc_close_peer`, `webrtc_destroy_all`, `webrtc_get_connected_peers` |
| `src-tauri/src/commands/mod.rs` | Modify | Add `pub mod webrtc_commands` + re-export with `pub use webrtc_commands::*` |
| `src-tauri/src/lib.rs` | Modify | Add `mod webrtc_manager`, `pub webrtc_manager: Arc<webrtc_manager::WebRTCManager>` to `AppState`, register 9 new commands in `invoke_handler![]` |
| `src/services/webrtcService.ts` | Rewrite | Thin IPC wrapper: `invoke()` for outgoing calls, `listen()` for incoming Tauri events; preserves existing public API |
| `src/stores/networkStore.ts` | Modify | Signal routing: instead of calling `webrtcService.handleOffer/handleAnswer/handleIceCandidate`, call `invoke('webrtc_handle_offer', ...)` etc.; subscribe to `webrtc_offer`/`webrtc_answer`/`webrtc_ice` Tauri events to relay outgoing signals |

---

## Event Contract

These Tauri events flow **Rust → frontend** via `app.emit()`:

| Event name | Payload | When |
|---|---|---|
| `webrtc_offer` | `{ to: string, sdp: string }` | After Rust calls `create_offer()` + `set_local_description()`; TS relays via signaling |
| `webrtc_answer` | `{ to: string, sdp: string }` | After Rust calls `create_answer()` in response to incoming offer; TS relays via signaling |
| `webrtc_ice` | `{ to: string, candidate: string, sdpMid: string \| null, sdpMLineIndex: number \| null }` | Each trickle ICE candidate generated locally; TS relays via signaling |
| `webrtc_connected` | `{ userId: string }` | Data channel `onopen` fires |
| `webrtc_disconnected` | `{ userId: string }` | Peer connection closed/failed |
| `webrtc_data` | `{ from: string, payload: string }` | Message received on data channel |

---

## Task 1: Add `webrtc` dependency to Cargo.toml

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the dependency** — open `src-tauri/Cargo.toml` and add the following under `[dependencies]`:

```toml
webrtc = "0.14"
```

Add it after the existing `tokio` entry if present, keeping the block alphabetical.

- [ ] **Step 2: Verify cargo check passes** — this will trigger a substantial download and compile of 200+ crates on first run; expect 2–5 minutes:

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error" | head -20
```

Expected: no `^error` lines (warnings about unused deps are OK at this stage).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml Cargo.lock
git commit -m "chore(deps): add webrtc = 0.14 rust crate"
```

---

## Task 2: Create `webrtc_manager.rs` — structs and peer factory

**Files:**
- Create: `src-tauri/src/webrtc_manager.rs`

- [ ] **Step 1: Write the module** — create `src-tauri/src/webrtc_manager.rs` with:

```rust
//! WebRTCManager — owns one RTCPeerConnection per remote peer.
//!
//! Lifecycle:
//!   1. set_local_user_id()   — called once from webrtc_init command
//!   2. create_offer()        — caller side; emits webrtc_offer event
//!   3. handle_offer()        — callee side; emits webrtc_answer event
//!   4. handle_answer()       — caller receives answer
//!   5. add_ice_candidate()   — both sides; called as signal_ice arrives
//!   6. send()                — send arbitrary bytes over data channel
//!   7. close_peer() / destroy_all()

use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

// ── Event payload types ────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
struct OfferEvent { to: String, sdp: String }

#[derive(Clone, serde::Serialize)]
struct AnswerEvent { to: String, sdp: String }

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct IceEvent {
    to: String,
    candidate: String,
    sdp_mid: Option<String>,
    sdp_mline_index: Option<u16>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectedEvent { user_id: String }

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DisconnectedEvent { user_id: String }

#[derive(Clone, serde::Serialize)]
struct DataEvent { from: String, payload: String }

// ── Per-peer state ─────────────────────────────────────────────────────────

struct PeerEntry {
    pc: Arc<RTCPeerConnection>,
    /// The negotiated data channel; None until `onopen` fires.
    dc: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
}

// ── Manager ───────────────────────────────────────────────────────────────

pub struct WebRTCManager {
    local_user_id: Arc<std::sync::Mutex<String>>,
    peers: Arc<Mutex<HashMap<String, PeerEntry>>>,
}

impl WebRTCManager {
    pub fn new() -> Self {
        WebRTCManager {
            local_user_id: Arc::new(std::sync::Mutex::new(String::new())),
            peers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn set_local_user_id(&self, id: String) {
        *self.local_user_id.lock().unwrap() = id;
    }

    pub fn local_user_id(&self) -> String {
        self.local_user_id.lock().unwrap().clone()
    }

    // ── Internal: build a new RTCPeerConnection ────────────────────────

    async fn build_pc() -> Result<Arc<RTCPeerConnection>, String> {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs().map_err(|e| e.to_string())?;
        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut media_engine)
            .map_err(|e| e.to_string())?;
        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build();
        let config = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_owned()],
                ..Default::default()
            }],
            bundle_policy: webrtc::peer_connection::policy::bundle_policy::RTCBundlePolicy::MaxBundle,
            ..Default::default()
        };
        api.new_peer_connection(config).await.map(Arc::new).map_err(|e| e.to_string())
    }

    // ── Internal: wire standard callbacks on a fresh PC ──────────────

    fn wire_callbacks(
        pc: Arc<RTCPeerConnection>,
        peer_id: String,
        dc_slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
        app: AppHandle,
    ) {
        // ICE candidate → relay through frontend to remote peer
        let app_ice = app.clone();
        let pid_ice = peer_id.clone();
        pc.on_ice_candidate(Box::new(move |c| {
            let app2 = app_ice.clone();
            let pid2 = pid_ice.clone();
            Box::pin(async move {
                if let Some(candidate) = c {
                    if let Ok(init) = candidate.to_json() {
                        let _ = app2.emit("webrtc_ice", IceEvent {
                            to: pid2,
                            candidate: init.candidate,
                            sdp_mid: init.sdp_mid,
                            sdp_mline_index: init.sdp_mline_index,
                        });
                    }
                }
            })
        }));

        // Connection state → emit disconnect when terminal
        let app_state = app.clone();
        let pid_state = peer_id.clone();
        pc.on_peer_connection_state_change(Box::new(move |s| {
            let app2 = app_state.clone();
            let pid2 = pid_state.clone();
            Box::pin(async move {
                if matches!(s, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Disconnected | RTCPeerConnectionState::Closed) {
                    let _ = app2.emit("webrtc_disconnected", DisconnectedEvent { user_id: pid2 });
                }
            })
        }));

        // Callee side: remote peer opened a data channel for us
        let app_dc = app.clone();
        let pid_dc = peer_id.clone();
        let dc_slot2 = dc_slot.clone();
        pc.on_data_channel(Box::new(move |d| {
            let app2 = app_dc.clone();
            let pid2 = pid_dc.clone();
            let slot = dc_slot2.clone();
            Box::pin(async move {
                WebRTCManager::wire_data_channel(d, pid2, slot, app2);
            })
        }));
    }

    // ── Internal: wire onopen + onmessage on a data channel ──────────

    fn wire_data_channel(
        dc: Arc<RTCDataChannel>,
        peer_id: String,
        slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
        app: AppHandle,
    ) {
        // onopen — store in slot, emit connected
        let slot_open = slot.clone();
        let dc_open = dc.clone();
        let pid_open = peer_id.clone();
        let app_open = app.clone();
        dc.on_open(Box::new(move || {
            let slot2 = slot_open.clone();
            let dc2 = dc_open.clone();
            let pid2 = pid_open.clone();
            let app2 = app_open.clone();
            Box::pin(async move {
                *slot2.lock().await = Some(dc2);
                let _ = app2.emit("webrtc_connected", ConnectedEvent { user_id: pid2 });
            })
        }));

        // onmessage — emit data event to frontend
        let pid_msg = peer_id.clone();
        let app_msg = app.clone();
        dc.on_message(Box::new(move |msg: DataChannelMessage| {
            let pid2 = pid_msg.clone();
            let app2 = app_msg.clone();
            Box::pin(async move {
                if let Ok(text) = String::from_utf8(msg.data.to_vec()) {
                    let _ = app2.emit("webrtc_data", DataEvent { from: pid2, payload: text });
                }
            })
        }));
    }

    // ── Public API ────────────────────────────────────────────────────

    /// Caller side: create offer and emit `webrtc_offer` event.
    pub async fn create_offer(&self, peer_id: &str, app: &AppHandle) -> Result<(), String> {
        let pc = Self::build_pc().await?;
        let dc_slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(Mutex::new(None));
        Self::wire_callbacks(pc.clone(), peer_id.to_string(), dc_slot.clone(), app.clone());

        // Caller creates the data channel; callee receives it via on_data_channel
        let dc = pc.create_data_channel("hexfield", None).await.map_err(|e| e.to_string())?;
        Self::wire_data_channel(dc, peer_id.to_string(), dc_slot.clone(), app.clone());

        let offer = pc.create_offer(None).await.map_err(|e| e.to_string())?;
        pc.set_local_description(offer.clone()).await.map_err(|e| e.to_string())?;

        self.peers.lock().await.insert(peer_id.to_string(), PeerEntry { pc, dc: dc_slot });
        app.emit("webrtc_offer", OfferEvent { to: peer_id.to_string(), sdp: offer.sdp })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Callee side: consume an offer, emit `webrtc_answer` event.
    pub async fn handle_offer(&self, from: &str, sdp: String, app: &AppHandle) -> Result<(), String> {
        let pc = Self::build_pc().await?;
        let dc_slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(Mutex::new(None));
        Self::wire_callbacks(pc.clone(), from.to_string(), dc_slot.clone(), app.clone());

        let offer = RTCSessionDescription::offer(sdp).map_err(|e| e.to_string())?;
        pc.set_remote_description(offer).await.map_err(|e| e.to_string())?;
        let answer = pc.create_answer(None).await.map_err(|e| e.to_string())?;
        pc.set_local_description(answer.clone()).await.map_err(|e| e.to_string())?;

        self.peers.lock().await.insert(from.to_string(), PeerEntry { pc, dc: dc_slot });
        app.emit("webrtc_answer", AnswerEvent { to: from.to_string(), sdp: answer.sdp })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Caller side: receive answer from callee.
    pub async fn handle_answer(&self, from: &str, sdp: String) -> Result<(), String> {
        let peers = self.peers.lock().await;
        let entry = peers.get(from).ok_or_else(|| format!("no peer entry for {from}"))?;
        let answer = RTCSessionDescription::answer(sdp).map_err(|e| e.to_string())?;
        entry.pc.set_remote_description(answer).await.map_err(|e| e.to_string())
    }

    /// Both sides: add a remote ICE candidate.
    pub async fn add_ice_candidate(&self, from: &str, candidate: RTCIceCandidateInit) -> Result<(), String> {
        let peers = self.peers.lock().await;
        let entry = peers.get(from).ok_or_else(|| format!("no peer entry for {from}"))?;
        entry.pc.add_ice_candidate(candidate).await.map_err(|e| e.to_string())
    }

    /// Send a UTF-8 string to a connected peer's data channel.
    pub async fn send(&self, peer_id: &str, data: String) -> Result<bool, String> {
        let peers = self.peers.lock().await;
        let entry = match peers.get(peer_id) {
            Some(e) => e,
            None => return Ok(false),
        };
        let dc_guard = entry.dc.lock().await;
        let dc = match dc_guard.as_ref() {
            Some(d) => d.clone(),
            None => return Ok(false),
        };
        drop(dc_guard);
        drop(peers);
        dc.send_text(data).await.map(|_| true).map_err(|e| e.to_string())
    }

    /// Close a single peer connection and remove it from the map.
    pub async fn close_peer(&self, peer_id: &str) -> Result<(), String> {
        let entry = self.peers.lock().await.remove(peer_id);
        if let Some(e) = entry {
            e.pc.close().await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Close all peer connections.
    pub async fn destroy_all(&self) -> Result<(), String> {
        let mut peers = self.peers.lock().await;
        let mut errors: Vec<String> = vec![];
        for (_, entry) in peers.drain() {
            if let Err(e) = entry.pc.close().await {
                errors.push(e.to_string());
            }
        }
        if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
    }

    /// Returns user IDs of peers whose data channel is open.
    pub async fn get_connected_peers(&self) -> Vec<String> {
        let peers = self.peers.lock().await;
        let mut out = vec![];
        for (id, entry) in peers.iter() {
            if entry.dc.lock().await.is_some() {
                out.push(id.clone());
            }
        }
        out
    }
}
```

- [ ] **Step 2: Verify** — the module won't be compiled yet (not in `lib.rs`), but validate syntax:

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error" | head -20
```

Expected: same as before (module not linked yet — no new errors).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/webrtc_manager.rs
git commit -m "feat(webrtc): add WebRTCManager struct with peer lifecycle"
```

---

## Task 3: Register module and add to AppState in `lib.rs`

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `mod webrtc_manager`** — in `lib.rs`, after the existing `mod lan;` line, add:

```rust
mod webrtc_manager;
```

And add the import for re-use in setup:

```rust
use std::sync::Arc;
```

(If `Arc` is already imported, skip.)

- [ ] **Step 2: Add `webrtc_manager` field to `AppState`** — find the `pub struct AppState` block and add the new field after `local_user_id`:

Old (last few lines of struct):
```rust
    /// Local userId, set when `lan_start` is called. Desktop only.
    #[cfg(not(mobile))]
    pub local_user_id: Arc<Mutex<String>>,
}
```

New:
```rust
    /// Local userId, set when `lan_start` is called. Desktop only.
    #[cfg(not(mobile))]
    pub local_user_id: Arc<Mutex<String>>,
    /// Rust-native WebRTC peer connections (data channels; Phase 1).
    pub webrtc_manager: Arc<webrtc_manager::WebRTCManager>,
}
```

- [ ] **Step 3: Initialise the field in `setup()`** — inside the `app.manage(AppState { ... })` block, add:

```rust
                webrtc_manager: Arc::new(webrtc_manager::WebRTCManager::new()),
```

- [ ] **Step 4: Verify cargo check passes** — the module is now linked:

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error" | head -20
```

Expected: zero `^error` lines.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(webrtc): wire WebRTCManager into AppState"
```

---

## Task 4: Create `webrtc_commands.rs` and register it

**Files:**
- Create: `src-tauri/src/commands/webrtc_commands.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create the commands file**:

```rust
//! Tauri commands for Rust-native WebRTC data-channel management.

use tauri::{AppHandle, State};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;

use crate::AppState;

/// Register the local user ID with the WebRTC manager.
/// Must be called once before any peer operations (at network init time).
#[tauri::command]
pub async fn webrtc_init(
    local_user_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.set_local_user_id(local_user_id);
    Ok(())
}

/// Initiate a connection to `peer_id`. Emits `webrtc_offer` event when ready.
#[tauri::command]
pub async fn webrtc_create_offer(
    peer_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.create_offer(&peer_id, &app).await
}

/// Accept an incoming offer from `from`. Emits `webrtc_answer` event.
#[tauri::command]
pub async fn webrtc_handle_offer(
    from: String,
    sdp: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.handle_offer(&from, sdp, &app).await
}

/// Process an answer received from `from` (must have an existing peer entry).
#[tauri::command]
pub async fn webrtc_handle_answer(
    from: String,
    sdp: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.handle_answer(&from, sdp).await
}

/// Add a remote ICE candidate for peer `from`.
///
/// `candidate`       — the candidate string (e.g. "candidate:…")
/// `sdp_mid`         — optional media stream id
/// `sdp_mline_index` — optional mline index
#[tauri::command]
pub async fn webrtc_add_ice(
    from: String,
    candidate: String,
    sdp_mid: Option<String>,
    sdp_mline_index: Option<u16>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.add_ice_candidate(
        &from,
        RTCIceCandidateInit {
            candidate,
            sdp_mid,
            sdp_mline_index,
            username_fragment: None,
        },
    ).await
}

/// Send UTF-8 `data` to `peer_id` over the data channel. Returns false if the peer
/// has no open data channel yet.
#[tauri::command]
pub async fn webrtc_send(
    peer_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state.webrtc_manager.send(&peer_id, data).await
}

/// Close and remove the peer connection for `peer_id`.
#[tauri::command]
pub async fn webrtc_close_peer(
    peer_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.close_peer(&peer_id).await
}

/// Close all open peer connections.
#[tauri::command]
pub async fn webrtc_destroy_all(state: State<'_, AppState>) -> Result<(), String> {
    state.webrtc_manager.destroy_all().await
}

/// Returns a list of peer IDs whose data channel is currently open.
#[tauri::command]
pub async fn webrtc_get_connected_peers(
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    Ok(state.webrtc_manager.get_connected_peers().await)
}
```

- [ ] **Step 2: Register the module in `commands/mod.rs`** — add alongside the other `pub mod` entries:

```rust
pub mod webrtc_commands;
```

And add the wildcard re-export at the top of `lib.rs` alongside the others:

```rust
use commands::webrtc_commands::*;
```

- [ ] **Step 3: Register the commands in `lib.rs` invoke_handler** — at the end of the sync-related block, add the new commands:

```rust
            // WebRTC (Rust-native data channels)
            webrtc_init,
            webrtc_create_offer,
            webrtc_handle_offer,
            webrtc_handle_answer,
            webrtc_add_ice,
            webrtc_send,
            webrtc_close_peer,
            webrtc_destroy_all,
            webrtc_get_connected_peers,
```

- [ ] **Step 4: Verify cargo check passes**:

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error" | head -20
```

Expected: zero `^error` lines.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/webrtc_commands.rs \
        src-tauri/src/commands/mod.rs \
        src-tauri/src/lib.rs
git commit -m "feat(webrtc): add webrtc_commands and register in invoke_handler"
```

---

## Task 5: Rewrite `webrtcService.ts` as Tauri IPC wrapper

**Files:**
- Rewrite: `src/services/webrtcService.ts`

The goal is to **preserve the exact same public API** as the current file (same method signatures, same types in/out) so that call sites in `networkStore.ts` and `voiceStore.ts` need zero changes for Phase 1 (data-only). Voice methods become no-ops in Phase 1.

- [ ] **Step 1: Read the current file's full API surface** before replacing — confirm the following public methods exist and note their signatures:
  - `static isAvailable(): boolean`
  - `init(localUserId, onDataMessage, onPeerConnected, onPeerDisconnected, onRemoteTrack)`
  - `createOffer(userId: string): Promise<void>`
  - `handleOffer(userId: string, sdp: string): Promise<void>`
  - `handleAnswer(userId: string, sdp: string): Promise<void>`
  - `handleIceCandidate(userId: string, candidate: RTCIceCandidateInit): Promise<void>`
  - `sendToPeer(userId: string, data: string): boolean`
  - `broadcast(data: string): void`
  - `destroyPeer(userId: string): void`
  - `destroyAll(): void`
  - `getConnectedPeers(): string[]`
  - `addAudioTrack(track, stream): void` — Phase 2 stub
  - `removeAudioTracks(): void` — Phase 2 stub
  - `addScreenShareTrack(track, kbps): void` — Phase 2 stub
  - `removeScreenShareTrack(): void` — Phase 2 stub

- [ ] **Step 2: Replace the file contents** with the following IPC wrapper:

```ts
/**
 * webrtcService.ts — Tauri IPC wrapper for the Rust WebRTC manager.
 *
 * The public API mirrors the old browser-RTCPeerConnection implementation
 * so existing call sites (networkStore, voiceStore) need no changes for Phase 1.
 *
 * Phase 2 (voice/screen tracks) will be implemented when the Rust manager
 * supports media tracks; the stub methods below will be filled in then.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

type DataMessageHandler = (from: string, data: string) => void
type PeerConnectedHandler = (userId: string) => void
type PeerDisconnectedHandler = (userId: string) => void
type RemoteTrackHandler = (userId: string, track: MediaStreamTrack, stream: MediaStream) => void

interface WebRtcOfferEvent   { to: string; sdp: string }
interface WebRtcAnswerEvent  { to: string; sdp: string }
interface WebRtcIceEvent     { to: string; candidate: string; sdpMid: string | null; sdpMlineIndex: number | null }
interface WebRtcDataEvent    { from: string; payload: string }
interface WebRtcConnEvent    { userId: string }

export class WebRTCService {
  private _localUserId = ''
  private _onDataMessage: DataMessageHandler | null = null
  private _onPeerConnected: PeerConnectedHandler | null = null
  private _onPeerDisconnected: PeerDisconnectedHandler | null = null
  private _unlisteners: UnlistenFn[] = []
  /** Cache of connected peer IDs (kept in sync via events). */
  private _connected = new Set<string>()

  /** Rust WebRTC is always available — the whole point of this rewrite. */
  static isAvailable(): boolean { return true }

  async init(
    localUserId: string,
    onDataMessage: DataMessageHandler,
    onPeerConnected: PeerConnectedHandler,
    onPeerDisconnected: PeerDisconnectedHandler,
    _onRemoteTrack: RemoteTrackHandler,
  ): Promise<void> {
    this._localUserId = localUserId
    this._onDataMessage = onDataMessage
    this._onPeerConnected = onPeerConnected
    this._onPeerDisconnected = onPeerDisconnected

    // Remove any stale listeners from a previous init call
    for (const fn of this._unlisteners) fn()
    this._unlisteners = []

    await invoke('webrtc_init', { localUserId })

    // webrtc_offer / webrtc_answer / webrtc_ice — relay outgoing signals via networkStore
    // These events are consumed by networkStore.ts (see Task 6).

    // webrtc_connected — peer data channel open
    this._unlisteners.push(await listen<WebRtcConnEvent>('webrtc_connected', ({ payload }) => {
      this._connected.add(payload.userId)
      this._onPeerConnected?.(payload.userId)
    }))

    // webrtc_disconnected — peer gone
    this._unlisteners.push(await listen<WebRtcConnEvent>('webrtc_disconnected', ({ payload }) => {
      this._connected.delete(payload.userId)
      this._onPeerDisconnected?.(payload.userId)
    }))

    // webrtc_data — incoming message from peer
    this._unlisteners.push(await listen<WebRtcDataEvent>('webrtc_data', ({ payload }) => {
      this._onDataMessage?.(payload.from, payload.payload)
    }))
  }

  async createOffer(userId: string): Promise<void> {
    await invoke('webrtc_create_offer', { peerId: userId })
  }

  async handleOffer(userId: string, sdp: string): Promise<void> {
    await invoke('webrtc_handle_offer', { from: userId, sdp })
  }

  async handleAnswer(userId: string, sdp: string): Promise<void> {
    await invoke('webrtc_handle_answer', { from: userId, sdp })
  }

  async handleIceCandidate(userId: string, candidate: RTCIceCandidateInit): Promise<void> {
    await invoke('webrtc_add_ice', {
      from: userId,
      candidate: candidate.candidate ?? '',
      sdpMid: candidate.sdpMid ?? null,
      sdpMlineIndex: candidate.sdpMLineIndex ?? null,
    })
  }

  /** Send data to a single peer. Returns false if the peer is not yet connected. */
  sendToPeer(userId: string, data: string): boolean {
    // Fire-and-forget; sync return value from cache
    if (!this._connected.has(userId)) return false
    invoke<boolean>('webrtc_send', { peerId: userId, data }).catch(e =>
      console.warn('[webrtc] send failed:', e)
    )
    return true
  }

  broadcast(data: string): void {
    for (const id of this._connected) {
      invoke('webrtc_send', { peerId: id, data }).catch(e =>
        console.warn('[webrtc] broadcast to', id, 'failed:', e)
      )
    }
  }

  destroyPeer(userId: string): void {
    this._connected.delete(userId)
    invoke('webrtc_close_peer', { peerId: userId }).catch(e =>
      console.warn('[webrtc] close_peer failed:', e)
    )
  }

  destroyAll(): void {
    this._connected.clear()
    invoke('webrtc_destroy_all').catch(e => console.warn('[webrtc] destroy_all failed:', e))
  }

  getConnectedPeers(): string[] {
    return Array.from(this._connected)
  }

  // ── Phase 2 stubs (voice / screen share) ─────────────────────────────────
  // These are no-ops until Rust media track support is implemented.

  addAudioTrack(_track: MediaStreamTrack, _stream: MediaStream): void {
    console.warn('[webrtc] addAudioTrack: not yet implemented in Rust backend (Phase 2)')
  }

  removeAudioTracks(): void {
    console.warn('[webrtc] removeAudioTracks: not yet implemented in Rust backend (Phase 2)')
  }

  addScreenShareTrack(_track: MediaStreamTrack, _kbps: number): void {
    console.warn('[webrtc] addScreenShareTrack: not yet implemented in Rust backend (Phase 2)')
  }

  removeScreenShareTrack(): void {
    console.warn('[webrtc] removeScreenShareTrack: not yet implemented in Rust backend (Phase 2)')
  }
}

export const webrtcService = new WebRTCService()
```

- [ ] **Step 3: Verify TypeScript build passes**:

```bash
npm run build 2>&1 | grep -E "error TS" | head -20
```

Expected: zero `error TS` lines. (There may be errors from `networkStore.ts` changes not yet made — proceed to Task 6 to resolve.)

- [ ] **Step 4: Commit**

```bash
git add src/services/webrtcService.ts
git commit -m "feat(webrtc): rewrite webrtcService.ts as Tauri IPC wrapper"
```

---

## Task 6: Update `networkStore.ts` signal routing

**Files:**
- Modify: `src/stores/networkStore.ts`

The three existing `signal_offer` / `signal_answer` / `signal_ice` cases in the `handleSignalMessage` switch currently call `webrtcService.handleOffer(...)` etc. directly. Now, **Rust emits** `webrtc_offer` / `webrtc_answer` / `webrtc_ice` events that the frontend must relay via signaling. The incoming `signal_*` cases must go through `invoke()` instead.

Additionally, the store must subscribe to `webrtc_offer` / `webrtc_answer` / `webrtc_ice` Tauri events and forward them to the signaling layer.

- [ ] **Step 1: Update the three incoming signaling cases** — find this block in `networkStore.ts`:

```ts
      case 'signal_offer':
        webrtcService.handleOffer(from, payload.sdp as string).catch(e => console.warn('[webrtc] signal_offer unhandled:', e))
        break
      case 'signal_answer':
        webrtcService.handleAnswer(from, payload.sdp as string).catch(e => console.warn('[webrtc] signal_answer unhandled:', e))
        break
      case 'signal_ice':
        webrtcService.handleIceCandidate(from, payload.candidate as RTCIceCandidateInit).catch(e => console.warn('[webrtc] signal_ice unhandled:', e))
        break
```

Replace with:

```ts
      case 'signal_offer':
        webrtcService.handleOffer(from, payload.sdp as string).catch(e => console.warn('[webrtc] signal_offer unhandled:', e))
        break
      case 'signal_answer':
        webrtcService.handleAnswer(from, payload.sdp as string).catch(e => console.warn('[webrtc] signal_answer unhandled:', e))
        break
      case 'signal_ice':
        webrtcService.handleIceCandidate(from, payload.candidate as RTCIceCandidateInit).catch(e => console.warn('[webrtc] signal_ice unhandled:', e))
        break
```

**Note:** These cases already call `webrtcService.handleOffer/handleAnswer/handleIceCandidate` which now `invoke()` the Rust commands — so the signal routing cases themselves do **not** change. Only the outgoing direction (Rust→TS→signaling) needs new listeners.

- [ ] **Step 2: Subscribe to outbound signal events from Rust** — find the function in `networkStore.ts` that sets up signaling listeners (look for where `listen('signal_message', ...)` or equivalent WS event handling is wired). In the same init/setup block, add listeners for the three Rust-originated events:

```ts
import { listen } from '@tauri-apps/api/event'

// Subscribe in the network init function, alongside existing signal listeners:
listen<{ to: string; sdp: string }>('webrtc_offer', ({ payload }) => {
  sendSignal(payload.to, { type: 'signal_offer', sdp: payload.sdp })
}).catch(e => console.warn('[webrtc] webrtc_offer listen failed:', e))

listen<{ to: string; sdp: string }>('webrtc_answer', ({ payload }) => {
  sendSignal(payload.to, { type: 'signal_answer', sdp: payload.sdp })
}).catch(e => console.warn('[webrtc] webrtc_answer listen failed:', e))

listen<{ to: string; candidate: string; sdpMid: string | null; sdpMlineIndex: number | null }>('webrtc_ice', ({ payload }) => {
  sendSignal(payload.to, {
    type: 'signal_ice',
    candidate: { candidate: payload.candidate, sdpMid: payload.sdpMid, sdpMLineIndex: payload.sdpMlineIndex },
  })
}).catch(e => console.warn('[webrtc] webrtc_ice listen failed:', e))
```

Where `sendSignal(to, message)` is the existing function/method that sends a signal via WS or LAN to the named peer. Inspect the existing code to find the correct function name and call signature.

- [ ] **Step 3: Verify TypeScript build passes**:

```bash
npm run build 2>&1 | grep -E "error TS" | head -20
```

Expected: zero `error TS` lines.

- [ ] **Step 4: Commit**

```bash
git add src/stores/networkStore.ts
git commit -m "feat(webrtc): update networkStore to relay Rust webrtc_offer/answer/ice events"
```

---

## Task 7: Remove Ubuntu WebRTC unavailability alert

**Files:**
- Modify: `src/stores/networkStore.ts`

Now that `WebRTCService.isAvailable()` always returns `true`, the alert that was added to warn Ubuntu users is no longer needed.

- [ ] **Step 1: Find and remove the `isAvailable()` check** — search for the call to `WebRTCService.isAvailable()` in `networkStore.ts` (added in the previous session). It should look roughly like:

```ts
if (!WebRTCService.isAvailable()) {
  uiStore.showAlert('WebRTC not available', '...')
  return
}
```

Remove this block entirely.

- [ ] **Step 2: Verify `WebRTCService` import is still used** — after removing the check, ensure the import of `WebRTCService` is still present if the singleton `webrtcService` is used, or update the import accordingly. Remove the `static isAvailable()` call — the method can remain on the class as a no-op or be removed. For now, remove the call site only (leave the method in case callers elsewhere rely on it).

- [ ] **Step 3: Full build verification**:

```bash
npm run build 2>&1 | grep -E "error TS" | head -20
cd src-tauri && cargo check 2>&1 | grep -E "^error" | head -20
```

Expected: both commands produce zero error lines.

- [ ] **Step 4: Commit**

```bash
git add src/stores/networkStore.ts
git commit -m "feat(webrtc): remove Ubuntu WebRTC unavailability alert (Rust always available)"
```

---

## Task 8: End-to-end smoke test + final cleanup

**Files:**
- Verify only (no new code unless a bug surfaces)

- [ ] **Step 1: Run full build pipeline**:

```bash
npm run build
cd src-tauri && cargo check
```

Both must produce zero errors.

- [ ] **Step 2: Check for dead imports** — ensure `noUnusedLocals` passes (it's part of `npm run build` via `vue-tsc --noEmit`). Fix any unused import errors.

- [ ] **Step 3: Manual smoke test** (if dev environment is available):
  - Start two instances of the app side by side
  - Create a server on instance A, invite instance B via LAN or invite code
  - Send a message from A → B and B → A
  - Confirm messages arrive in both directions
  - Open browser devtools console; confirm no `RTCPeerConnection is not available` errors

- [ ] **Step 4: Update TODO.md** — mark the webrtc-rs replacement Phase 1 task as complete if one exists, or add a note under Phase 5c/6 that Rust data channels are live.

- [ ] **Step 5: Commit**

```bash
git add docs/TODO.md
git commit -m "chore: mark webrtc-rs Phase 1 (data channels) complete"
```

---

## Phase 2 Outline (deferred — do not implement now)

When voice/screen share support is needed:

- Extend `PeerEntry` in `webrtc_manager.rs` with audio/video `RTCRtpSender` slots
- Implement `webrtc_add_audio_track` / `webrtc_remove_audio_tracks` Rust commands
- Implement `webrtc_add_screen_track` / `webrtc_remove_screen_track` Rust commands
- Fill in the stub methods in `webrtcService.ts`
- The `_onRemoteTrack` callback (currently unused in Phase 1) will need to be wired through a `webrtc_remote_track` Tauri event
