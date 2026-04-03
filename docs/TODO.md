# GameChat — Implementation TODO

> Detailed specs for each area live in [`docs/specs/`](specs/).
> Architecture overview and key decisions: [`docs/architecture-plan.md`](architecture-plan.md).

---

## Phase 1 — Foundation

**Goal**: Runnable skeleton with identity, layout shell, and SQLite wired up.

- [ ] Copy `tauri-app-skeleton` → `GameChat/`, rename all references
  - [ ] `src/appConfig.ts` — `APP_NAME`, `STORAGE_PREFIX`
  - [ ] `src-tauri/Cargo.toml` — crate name + description
  - [ ] `src-tauri/tauri.conf.json` — `productName`, `identifier`, window size 1280×800
  - [ ] `index.html` title, `package.json` name
  - [ ] Delete `notesStore.ts`, `NoteItem.vue`, `Sidebar.vue`
- [ ] Install new npm dependencies (`@tanstack/virtual-core`, `libsodium-wrappers`, `date-fns`, `uuid`, `qrcode`)
- [ ] Add new Cargo dependencies (`rusqlite`, `rusqlite_migration`, `tokio`, `tokio-tungstenite`, `negentropy`, `blake3`, `mdns-sd`, `tauri-plugin-deep-link`, etc.)
- [ ] Update CSP in `tauri.conf.json` (add `wss:`, `wasm-unsafe-eval`, `media-src blob:`)
- [ ] Add `vue-router` + `src/router/index.ts`
- [ ] Build 4-column layout shell (`ServerRail`, `ChannelSidebar`, `MainPane`, `MemberList` CSS grid)
- [ ] `identityStore` — generate Ed25519/X25519 keypair on first launch, persist to SQLite
- [ ] `cryptoService.init()` — WASM init, load or generate keys
- [ ] SQLite init: `rusqlite_migration` setup, embed `001_initial.sql`
- [ ] Run migration on startup; verify tables exist
- [ ] Extend Settings modal: Profile, Voice, Privacy, Notifications tabs (stubs ok)
- [ ] Privacy tab: deletion behaviour explanation text

---

## Phase 2 — Servers & Channels

**Goal**: Create/join servers, manage channels, member list, messages in SQLite.

- [ ] `serversStore` — create, join (via invite code), leave, list
- [ ] `channelsStore` — create, reorder, delete, set active
- [ ] Server creation UI flow (name, icon upload)
- [ ] Invite link generation (`InviteModal.vue`) + join flow
- [ ] Channel management UI (create, rename, delete)
- [ ] `messagesStore` — SQLite-backed, windowed 100-message cache, cursor pagination
- [ ] `MemberList.vue` — right panel, collapsible, online status
- [ ] Server manifest generation + signing on server create
- [ ] QR code generation for invites (`qrcode` npm package → SVG display)
- [ ] `tauri-plugin-deep-link` — register `gamechat://` handler, route to join flow

---

## Phase 3 — Text Chat & Encryption

**Goal**: Live P2P text chat with E2E encryption over WebRTC data channels.

- [x] WS signaling connection lifecycle (`signalingService.ts` + Rust WS actor)
  - [x] `signal_connect` / `signal_disconnect` / `signal_send` Tauri commands
  - [x] Frontend `listen('signal_message', ...)` wired to `networkStore`
- [x] WebRTC peer connection setup (`webrtcService.ts`)
  - [x] `createOffer`, `handleOffer`, `handleAnswer`, `handleIceCandidate`
  - [x] Data channel open → wired to `networkStore` dispatch → `messagesStore`
- [x] Message encryption/decryption via `cryptoService`
  - [x] `encryptMessage` (X25519 ECDH + XSalsa20-Poly1305 + Ed25519 sig)
  - [x] `decryptMessage` (verify sig → decrypt → store plaintext)
- [x] `sendMessage` flow: UUID v7 → optimistic display → encrypt → broadcast → db save
- [x] Receive message flow: decrypt → verify → db save → reactive display
- [x] Typing indicators (`typing_start` / `typing_stop` events over data channels)
- [x] File attachments Phase 1: inline base64 ≤100KB, external URL display
- [x] Image auto-downscale via Canvas API before embedding

---

## Phase 3b — Message Sync

**Goal**: Automatic history reconciliation when peers connect/reconnect.

- [x] Evaluate `negentropy` Rust crate API fit against SQLite schema
  - [x] Suitable: integrated into Rust backend; UUID v7 zero-padded to 32-byte `Id`, timestamp from first 6 bytes
  - [x] `sync_initiate` / `sync_respond` / `sync_process_response` Tauri commands
  - [x] `sync_get_messages` / `sync_get_mutations` / `sync_save_messages` / `sync_save_mutations` / `sync_list_channels`
- [x] Per-channel sync session protocol over WebRTC data channel (`syncService.ts`)
  - [x] Pass 1: reconcile `messages` table per channel
  - [x] Pass 2: reconcile `mutations` table per channel
  - [x] Pass 3 (per-server, on connect): reconcile `mutations` where `channel_id = '__server__'`
- [x] `src/utils/hlc.ts` utility — `generateHLC`, `advanceHLC`, `compareHLC`; `advanceHLC` called on message receive
- [x] Offline message queue: messages written to SQLite while offline → included in next negentropy sync automatically
- [ ] Test: two clients diverge offline, exchange messages, reconnect → verify full consistent history

---

## Phase 4 — Reactions & Emoji

**Goal**: Emoji reactions on messages, custom server emoji.

- [x] Reaction UI — pill display on `MessageBubble.vue`, optimistic add/remove
- [x] `db_save_mutation` for `reaction_add` / `reaction_remove`
- [x] Reactions materialized in `messagesStore` from mutations log
- [x] Built-in Unicode emoji picker (`emoji-data.json` ~80KB, 1000 common emoji)
- [x] `EmojiPicker.vue` — Teleport to body, tabs (Recent | Server emoji | Unicode categories)
- [x] Custom emoji upload flow (validate → Canvas resize to 128×128 → disk write via Rust)
- [x] `emojiStore` — lazy-load metadata, `get_emoji_image` on demand
- [x] P2P emoji gossip: `emoji_sync` metadata broadcast on reconnect, `emoji_image_request` lazy fetch
- [x] Max 20 distinct reactions per message
- [x] Quick-react bar: track per-user reaction usage counts in `emojiStore`; show top 3 most-used emoji as instant-access buttons in the hover action bar alongside the full-picker button

---

## Phase 4b — Device Linking

**Goal**: Link additional devices under the same identity without a central authority.

- [x] Device keypair generation at first launch (separate from identity keypair)
- [x] `devices` SQLite table + `db_save_device` / `db_load_devices` Tauri commands
- [x] "Link new device" UI: generate QR code with `linkToken` (5-minute expiry)
- [x] `device_link_request` / `device_link_confirm` P2P protocol
- [x] Attestation signing: Device A signs Device B's public keys
- [x] Attest gossip: broadcast `device_attest` mutation to all known servers/contacts
- [x] Multi-device encryption: encrypt messages to ALL attested devices of each recipient
- [x] Device revocation flow: signed `device_revoke` mutation → peers stop encrypting to it

---

## Phase 5 — Voice & Screen Share

**Goal**: Real-time voice chat and screen sharing over WebRTC.

- [x] `voiceStore` — join/leave voice channel, local stream, session state
- [x] `audioService.ts` — attach/detach remote streams, VAD (AnalyserNode RMS polling), mute/deafen
- [x] `webrtcService` — add audio track to existing peer connections on join
- [x] `VoiceBar.vue` — bottom strip in channel sidebar (not fixed overlay), shown while in voice session
- [x] `VoicePeerTile.vue` — speaking ring animation, video/screen share frame
- [x] Mute / deafen controls with keyboard shortcut support (Ctrl+Shift+M / Ctrl+Shift+D)
- [ ] Screen share — Windows path:
  - [x] `get_screen_sources` Rust command stub (returns empty; Win32 enumeration deferred to Phase 6)
  - [ ] **Investigate `chromeMediaSourceId` in WebView2 first** — if it works, use custom picker; if not, fall back to `getDisplayMedia()` everywhere
  - [ ] `ScreenSharePicker.vue` modal (if custom picker path works)
- [x] Screen share — macOS path:
  - [x] `getDisplayMedia()` via WKWebView (macOS 12.3+)
  - [x] Add `NSScreenCaptureUsageDescription` to Info.plist
  - [ ] Plan Rust `CGDisplayStream` fallback (Phase 6) for macOS < 12.3
- [x] `addScreenShareTrack` — `replaceTrack()` on existing peer connections
- [x] Mesh voice limit: warn UI at >8 participants; note SFU as future work
- [x] Apply browser-native noise suppression / echo cancellation constraints on `getUserMedia` (spec §12)
- [x] Voice loopback (hear own voice) toggle in VoiceBar and Settings > Voice (spec §10)
- [x] Voice participants shown in ChannelSidebar under their channel with speaking ring (spec §11)
- [x] `VoiceContentPane.vue` — screen share live video in content pane, per-sharer show/hide (spec §13)
- [x] `voiceStore.screenStreams` map — store remote video tracks keyed by userId (spec §13)
- [x] `UserProfileModal.vue` — click avatar to open profile; own profile editable; per-peer volume slider (spec §15)
- [ ] Video quality + bitrate settings in Settings > Voice & Video (spec §14)

---

## Phase 5b — P2P File Attachments

**Goal**: Large file transfers without a server, using content-addressed gossip.

- [ ] BLAKE3 content-addressed storage: `$APPDATA/gamechat/attachments/{hash[0:2]}/{hash}.bin`
- [ ] Chunked download over WebRTC data channels (chunk size 256KB)
- [ ] `attachment_want` / `attachment_have` gossip protocol
- [ ] Partial download tracking (`.part` bitfield file)
- [ ] Chunk integrity verification against content hash
- [ ] Seeding: serve chunks from local cache to requesting peers
- [ ] Retention setting (default 30 days) — wired to auto-pruning
- [ ] Phase 1 inline base64 path remains active for ≤100KB

---

## Phase 5c — NAT Relay

**Goal**: Connect peers behind symmetric NAT without requiring a central server.

- [ ] NAT type detection at startup (dual-STUN comparison → `detectNATType()`)
- [ ] Relay capability advertisement in gossip/presence messages
- [ ] `buildICEConfig(userId)` — dynamic ICE config using known relay peers
- [ ] Evaluate `turn` crate (webrtc-rs) for client-side TURN listener
- [ ] Rendezvous server TURN endpoint (if server configured)
- [ ] Settings > Voice: manual TURN server entry
- [ ] Test: symmetric NAT simulation (two clients behind carrier-grade NAT), verify relay fallback

---

## Phase 6 — Polish & Hardening

**Goal**: Production-ready: notifications, search, key security, pruning, storage limits.

- [ ] OS notifications via `tauri-plugin-notification` (mentions, DMs)
- [ ] Unread badges on `ServerIcon` and `ChannelItem`
- [ ] Mention highlights (`@username` parsing in messages)
- [ ] Message search — SQLite FTS5 (only indexes non-null content)
- [ ] Passphrase-wrapped key storage (Phase 2 crypto tier: Argon2id → requires `libsodium-wrappers-sumo`)
- [ ] OS keychain integration (Phase 3 crypto tier: `keyring` crate)
- [ ] Storage limit enforcement (5 GB default, 10 GB max, user-configurable)
  - [ ] Background pruning: attachment files (oldest first), then message content
  - [ ] Storage usage display in Settings > Privacy
- [ ] Server admin archive / re-baseline
  - [ ] Archive bundle export (signed, compressed snapshot)
  - [ ] `server_rebaseline` mutation with `historyStartsAt` + `gamechat://archive/...` deep link
  - [ ] Archive import flow (import prompt on deep-link click)
- [ ] macOS Rust-side screen capture fallback (`CGDisplayStream`) for macOS < 12.3
- [ ] Linux Wayland screen share via XDG Desktop Portal
- [ ] Auto-update flow (already in skeleton — verify works end-to-end)
- [ ] Key export / import / device revocation UI in Settings > Privacy
- [ ] Privacy settings: show-deleted-placeholder toggle, confirm-before-delete toggle

---

## Stretch — Matrix Compatibility

- [ ] Abstract networking behind `NetworkProvider` interface
- [ ] `NativeP2PProvider` (current implementation)
- [ ] `MatrixProvider` — `matrix-js-sdk`, map rooms → Channels, spaces → Servers
- [ ] Settings toggle to switch providers
- [ ] Preserve Vue UI layer unchanged across both providers
