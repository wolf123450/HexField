# WebRTC-rs Replacement Design

**Date:** 2026-04-05  
**Status:** Approved  
**Scope:** Replace Ubuntu-broken browser `RTCPeerConnection` with a Rust implementation using the `webrtc` crate (v0.14). Phase 1: data channels only (messaging, sync). Phase 2 (deferred): voice and screen-share media tracks.  
**Out of scope:** NAT relay (Phase 5c), TURN/STUN server hosting, voice/screen media track bridging (Phase 2).

---

## 1. Problem Statement

Ubuntu 24.04 ships `libwebkit2gtk-4.1-0` (2.50.4) without WebRTC compiled in. The `enable-webrtc` GObject property exists as a stub but is a no-op — even with GStreamer plugins installed, `RTCPeerConnection` is `undefined` in the WebView. The `ppa:escalion/ppa-webkit2gtk-experimental` PPA offers 2.48.1 which would be a downgrade from the installed 2.50.4 and is not a viable path.

**Confirmed via:** Python/GObject test with `webkit_settings_set_enable_webrtc(True)` set before any page load — `typeof RTCPeerConnection` remains `'undefined'`.

This means peer-to-peer messaging, sync, and LAN discovery are broken for the majority of Linux users (Ubuntu/Debian are the dominant distros).

**Solution:** Move all `RTCPeerConnection` management into the Rust backend using the `webrtc = "0.14"` crate. The frontend becomes a thin IPC shim. Tauri is always running, so Rust-native WebRTC is available on every supported OS with no distribution caveats.

---

## 2. Crate Selection Rationale

Two serious candidates were evaluated:

| Criterion | `webrtc` (0.14) | `str0m` (0.18) |
|---|---|---|
| Dependency count | ~204 | ~80 (default) / ~45 (`rust-crypto` feature) |
| Crypto backend | `ring` — **already in HexField's Cargo.lock** | `aws-lc-sys` (68 MB C build, default) or `ring` (with `rust-crypto` feature) |
| API style | Mirrors browser `RTCPeerConnection` spec 1:1 | Sans-IO: caller drives state machine tick |
| Frontend changes needed | Minimal — method names match existing `webrtcService.ts` | Substantial — full state machine driving in Rust |
| Maturity | Pion Go port; production users | Newer Rust-first crate; fewer production deployments |
| Voice/screen tracks | Yes (Phase 2) | Yes but more complex |

**Decision: `webrtc = "0.14"`** because it minimises TypeScript-side changes (the existing `webrtcService.ts` API maps directly) and reuses the `ring` crate already compiled into HexField.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Frontend (TypeScript)                              │
│                                                     │
│  networkStore.ts                                    │
│    ├── sends signals via WS/LAN (unchanged)         │
│    ├── forwards signal_offer/answer/ice → invoke()  │
│    └── listens for webrtc_offer/answer/ice events   │
│        → relays via sendSignal()                    │
│                                                     │
│  webrtcService.ts  (thin IPC wrapper)               │
│    ├── init()     → invoke('webrtc_init')           │
│    ├── createOffer()  → invoke('webrtc_create_offer')│
│    ├── handleOffer()  → invoke('webrtc_handle_offer')│
│    ├── handleAnswer() → invoke('webrtc_handle_answer')│
│    ├── handleIceCandidate() → invoke('webrtc_add_ice')│
│    ├── sendToPeer() → invoke('webrtc_send')         │
│    ├── broadcast() → invoke('webrtc_send') ×N       │
│    └── listen: webrtc_connected/disconnected/data   │
└──────────────────┬──────────────────────────────────┘
                   │  Tauri IPC (invoke / emit)
┌──────────────────▼──────────────────────────────────┐
│  Rust backend                                       │
│                                                     │
│  AppState.webrtc_manager: Arc<WebRTCManager>        │
│                                                     │
│  WebRTCManager                                      │
│    peers: Mutex<HashMap<userId, PeerEntry>>         │
│    ├── PeerEntry.pc: Arc<RTCPeerConnection>         │
│    └── PeerEntry.dc: Mutex<Option<Arc<RTCDataChannel>>>│
│                                                     │
│  webrtc_commands.rs  (9 Tauri commands)             │
│    webrtc_init, webrtc_create_offer,                │
│    webrtc_handle_offer, webrtc_handle_answer,       │
│    webrtc_add_ice, webrtc_send, webrtc_close_peer,  │
│    webrtc_destroy_all, webrtc_get_connected_peers   │
└─────────────────────────────────────────────────────┘
```

Signaling topology is **unchanged** — existing WS and LAN paths still carry offer/answer/ICE payloads, and `networkStore.ts` still routes them. The only change is that the signal payloads are now transported into and out of Rust commands instead of directly into browser `RTCPeerConnection`.

---

## 4. Data Flow

### 4.1 Caller side (A initiates to B)

```
A: networkStore.connectToPeer(B)
   → webrtcService.createOffer(B)
     → invoke('webrtc_create_offer', { peerId: B })
       [Rust: WebRTCManager.create_offer(B, app_handle)]
         → build RTCPeerConnection
         → create data channel "hexfield"
         → set_local_description(offer)
         → app.emit("webrtc_offer", { to: B, sdp })
   ← networkStore listens "webrtc_offer"
     → sendSignal(B, { type: "signal_offer", sdp })
       [via WS or LAN]

B: networkStore receives "signal_offer" from A
   → webrtcService.handleOffer(A, sdp)
     → invoke('webrtc_handle_offer', { from: A, sdp })
       [Rust: WebRTCManager.handle_offer(A, sdp, app)]
         → build RTCPeerConnection
         → set_remote_description(offer)
         → create_answer()
         → set_local_description(answer)
         → app.emit("webrtc_answer", { to: A, sdp })
   ← networkStore listens "webrtc_answer"
     → sendSignal(A, { type: "signal_answer", sdp })

A: networkStore receives "signal_answer" from B
   → webrtcService.handleAnswer(B, sdp)
     → invoke('webrtc_handle_answer', { from: B, sdp })
       [Rust: WebRTCManager.handle_answer(B, sdp)]
         → set_remote_description(answer)

[ICE trickle on both sides]
Both: Rust on_ice_candidate → app.emit("webrtc_ice", { to, candidate, … })
      networkStore → sendSignal(to, { type: "signal_ice", candidate })
Both: networkStore receives "signal_ice"
      → webrtcService.handleIceCandidate(from, candidate)
        → invoke('webrtc_add_ice', { from, candidate, sdpMid, sdpMlineIndex })

[Data channel opens on both sides]
Rust: on_open → app.emit("webrtc_connected", { userId })
TS:   webrtcService listens → _onPeerConnected(userId)
      → networkStore._onPeerConnected(userId) (existing callback)
```

### 4.2 Sending data

```
networkStore / syncService: webrtcService.sendToPeer(userId, payload)
  → if !_connected.has(userId): return false  (sync cache check)
  → invoke('webrtc_send', { peerId: userId, data: payload })
    [Rust: PeerEntry.dc.send_text(data)]

[On receiver side]
Rust: on_message → app.emit("webrtc_data", { from, payload })
TS:   webrtcService listens → _onDataMessage(from, payload)
      → networkStore._onDataMessage(from, payload) (existing callback, unchanged)
```

---

## 5. Tauri Event Contract

All events are emitted globally (`app.emit()`), not to a specific window — HexField is single-window.

| Event | Direction | Payload fields | Semantics |
|---|---|---|---|
| `webrtc_offer` | Rust → TS | `to: string`, `sdp: string` | Rust generated offer; TS must relay to `to` via signaling |
| `webrtc_answer` | Rust → TS | `to: string`, `sdp: string` | Rust generated answer; TS must relay |
| `webrtc_ice` | Rust → TS | `to: string`, `candidate: string`, `sdpMid: string\|null`, `sdpMlineIndex: number\|null` | ICE candidate for `to`; TS must relay |
| `webrtc_connected` | Rust → TS | `userId: string` | Data channel for `userId` is open |
| `webrtc_disconnected` | Rust → TS | `userId: string` | Peer connection closed/failed |
| `webrtc_data` | Rust → TS | `from: string`, `payload: string` | UTF-8 message received on data channel |

**Payload field naming:** `camelCase` for multi-word fields (`sdpMid`, `sdpMlineIndex`, `userId`); plain field names match Rust `#[serde(rename_all = "camelCase")]` on event structs.

---

## 6. Tauri Command Contract

All commands are `async` Rust functions. Parameters match the field names expected by `invoke()` on the TypeScript side.

| Command | Parameters | Return | Semantics |
|---|---|---|---|
| `webrtc_init` | `local_user_id: String` | `Result<(), String>` | Store local user ID in manager |
| `webrtc_create_offer` | `peer_id: String` | `Result<(), String>` | Build PC, create DC, emit `webrtc_offer` |
| `webrtc_handle_offer` | `from: String`, `sdp: String` | `Result<(), String>` | Build PC, set remote, emit `webrtc_answer` |
| `webrtc_handle_answer` | `from: String`, `sdp: String` | `Result<(), String>` | Set remote description on existing PC |
| `webrtc_add_ice` | `from: String`, `candidate: String`, `sdp_mid: Option<String>`, `sdp_mline_index: Option<u16>` | `Result<(), String>` | Add ICE candidate to existing PC |
| `webrtc_send` | `peer_id: String`, `data: String` | `Result<bool, String>` | Send on open DC; false if DC not open |
| `webrtc_close_peer` | `peer_id: String` | `Result<(), String>` | Close and remove peer entry |
| `webrtc_destroy_all` | — | `Result<(), String>` | Close all peer connections |
| `webrtc_get_connected_peers` | — | `Result<Vec<String>, String>` | IDs with open data channels |

**Serde rename note:** Tauri v2 deserialises `invoke()` parameters with `camelCase` → `snake_case` conversion automatically. `peer_id` is sent from TS as `peerId`, `sdp_mid` as `sdpMid`, etc.

---

## 7. `WebRTCManager` Internal Design

### 7.1 Per-peer state

```rust
struct PeerEntry {
    pc: Arc<RTCPeerConnection>,
    dc: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
}
```

`dc` starts as `None` and is populated when the data channel `onopen` fires. The `Option` is inside the `Mutex` so `send()` can simultaneously check and use the DC without a separate lock.

### 7.2 RTCPeerConnection configuration

```rust
RTCConfiguration {
    ice_servers: vec![RTCIceServer {
        urls: vec!["stun:stun.l.google.com:19302"],
        ..Default::default()
    }],
    bundle_policy: RTCBundlePolicy::MaxBundle,
    ..Default::default()
}
```

`MaxBundle` is required because the LAN/GStreamer signaling path rejects per-m-line ICE credentials. This matches the `bundlePolicy: 'max-bundle'` already in the browser-side constructor.

### 7.3 Tokio runtime

`webrtc = "0.14"` uses tokio internally. Tauri v2 ships its own tokio runtime; all `async fn` Tauri commands run on that runtime. No extra runtime setup is required — Tauri's `async fn` command support handles it.

### 7.4 Perfect negotiation (collision handling)

The current browser implementation uses a polite/impolite pattern based on `localUserId > remoteUserId` string comparison. In the Rust manager, collision is avoided structurally: **always the peer with the lexicographically lower user ID initiates (creates offer)**. The higher-ID peer only ever calls `handle_offer()`. The caller is responsible for ensuring this ordering at the `networkStore` level (unchanged from the existing JS convention).

### 7.5 Data channel label

The data channel is always created with `label = "hexfield"`. Both sides accept the channel regardless of label (the callee's `on_data_channel` callback fires for any label). This is identical to the current JS behaviour.

---

## 8. `webrtcService.ts` Wrapper Design

The rewritten service preserves the exact public API so that `networkStore.ts`, `voiceStore.ts`, and `syncService.ts` call sites require zero changes in Phase 1. Key design points:

### 8.1 `_connected` cache

The TypeScript service maintains a local `Set<string>` of connected peer IDs, kept in sync by `webrtc_connected` / `webrtc_disconnected` events. This allows `sendToPeer()` to return a synchronous `boolean` (matching the existing signature) without an async round-trip to Rust.

### 8.2 `sendToPeer` fire-and-forget

`invoke('webrtc_send')` returns `Promise<boolean>` but the public method signature is synchronous (`sendToPeer(userId, data): boolean`). The method checks the local `_connected` cache and fires `invoke()` without `await`, attaching only a `.catch()` for logging. This matches the semantics of the original implementation where `RTCDataChannel.send()` was also synchronous and unbuffered rejection was silent.

### 8.3 `init()` idempotent

Multiple calls to `init()` (e.g. on re-connect) first remove all existing `listen()` unlisten functions, then re-register. This prevents duplicate event handler accumulation.

### 8.4 Voice stubs

`addAudioTrack`, `removeAudioTracks`, `addScreenShareTrack`, `removeScreenShareTrack` are explicit no-ops with `console.warn` messages. Voice calls on Linux will silently not transmit audio in Phase 1; this is an acceptable regression since voice was already broken by the missing WebRTC.

---

## 9. `networkStore.ts` Changes

### 9.1 Incoming signal cases (no change)

The `signal_offer`, `signal_answer`, `signal_ice` cases already call `webrtcService.handleOffer/handleAnswer/handleIceCandidate` which now `invoke()` Rust commands. No code changes needed in these cases.

### 9.2 Outgoing signal relay (new)

In the network init function (where existing `listen()` calls are set up), add three new listeners:

```ts
listen<{ to: string; sdp: string }>('webrtc_offer', ({ payload }) =>
  sendSignal(payload.to, { type: 'signal_offer', sdp: payload.sdp })
)
listen<{ to: string; sdp: string }>('webrtc_answer', ({ payload }) =>
  sendSignal(payload.to, { type: 'signal_answer', sdp: payload.sdp })
)
listen<{ to: string; candidate: string; sdpMid: string|null; sdpMlineIndex: number|null }>(
  'webrtc_ice', ({ payload }) =>
    sendSignal(payload.to, {
      type: 'signal_ice',
      candidate: { candidate: payload.candidate, sdpMid: payload.sdpMid, sdpMLineIndex: payload.sdpMlineIndex },
    })
)
```

`sendSignal(to, message)` is the existing function in `networkStore.ts` that routes to WS or LAN depending on the peer's connection mode.

### 9.3 Remove unavailability alert

The `WebRTCService.isAvailable()` check and `uiStore.showAlert(...)` call added in the previous session must be removed. Rust WebRTC is always available.

---

## 10. AppState Change

```rust
pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub signal_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<serde_json::Value>>>>,
    #[cfg(not(mobile))]
    pub lan_peers: Arc<lan::LanPeers>,
    #[cfg(not(mobile))]
    pub lan_signal_port: Arc<AtomicU16>,
    #[cfg(not(mobile))]
    pub local_user_id: Arc<Mutex<String>>,
    // NEW:
    pub webrtc_manager: Arc<webrtc_manager::WebRTCManager>,
}
```

`webrtc_manager` is **not** `cfg(not(mobile))` — the plan is to support mobile WebRTC in a future phase using the same Rust manager. For now it is simply unused on mobile.

---

## 11. Cargo.toml Change

Add to `[dependencies]`:

```toml
webrtc = "0.14"
```

No `default-features = false` override is needed at this stage — the default feature set includes `openssl` for certificate generation. If build size becomes a concern later, features can be trimmed. The `ring` crypto backend is already in HexField's dependency graph (from `libsodium`/`tauri` transitive deps); `webrtc` 0.14 uses `ring` for DTLS, so there is no new crypto C dependency.

---

## 12. Files Changed

| File | Change |
|---|---|
| `src-tauri/Cargo.toml` | Add `webrtc = "0.14"` |
| `src-tauri/src/webrtc_manager.rs` | New — `WebRTCManager` struct |
| `src-tauri/src/commands/webrtc_commands.rs` | New — 9 Tauri commands |
| `src-tauri/src/commands/mod.rs` | Add `pub mod webrtc_commands` |
| `src-tauri/src/lib.rs` | Add `mod webrtc_manager`, field in `AppState`, init, command registrations |
| `src/services/webrtcService.ts` | Rewrite as IPC wrapper |
| `src/stores/networkStore.ts` | Add 3 outgoing event relays; remove unavailability alert |

---

## 13. Phase 2 Outline (deferred)

When voice/screen share is needed on Linux:

- Extend `PeerEntry` with `audio_senders: Vec<Arc<RTCRtpSender>>` and `video_sender: Option<Arc<RTCRtpSender>>`
- Add Rust commands: `webrtc_add_audio_track`, `webrtc_remove_audio_tracks`, `webrtc_add_screen_track`, `webrtc_remove_screen_track`
- These require capturing system audio/video in Rust (or bridging from the frontend's `getUserMedia` stream) — the capture mechanism is TBD and may require a separate spec
- Fill in the Phase 1 stubs in `webrtcService.ts`
- A `webrtc_remote_track` event will be needed to wire `_onRemoteTrack` through to the frontend

On macOS and Windows (where WebKitGTK is not the engine), browser WebRTC continues to work for voice in the interim — Phase 1 data-channel migration does not break voice on those platforms because the voice stubs are only called when the user actively joins a voice channel and fails gracefully with a console warning.
