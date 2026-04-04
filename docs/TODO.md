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
- [x] Custom user avatar upload (static + animated GIF) in own-profile view in `UserProfileModal` (spec §16a)
- [x] `<AvatarImage>` component — replaces initials circles everywhere; GIF frozen by default, animates on hover (spec §16a)
- [x] Broadcast avatar + profile changes to peers via `profile_update` P2P mutation (spec §16a)
- [x] Server avatar upload (admin only) in server settings; shown in `ServerRail` replacing initials circle (spec §16b)
- [x] Broadcast server avatar via `server_avatar_update` P2P message to connected peers (spec §16b)
- [x] User presence status broadcast (`presence_update` P2P message) on status change and peer join (spec §17)
- [x] `ServerMember.status` field + `MemberRow` status dot wired to live presence data (spec §17)
- [x] `<StatusBadge>` component — per-status SVG shape (circle/crescent/minus/hollow) + color for colorblind accessibility; replaces plain CSS dot everywhere (spec §17)
- [x] Profile bio text (≤200 chars) and auto-derived gradient banner in `UserProfileModal`; banner color/image picker deferred to Phase 6 polish (spec §18)
- [x] P2P `profile_request` / `profile_update` protocol to fetch remote user's full profile on demand (spec §18)

---

## Test Coverage — Retroactive (Phases 1–5)

> No tests were written during implementation. The items below represent the full test debt for shipped code.
> Convention: `src/<path>/__tests__/<file>.test.ts` for frontend; `#[cfg(test)]` blocks in the same Rust file.

### `cryptoService.ts`
- [x] `encryptMessage` → `decryptMessage` round-trip (X25519 ECDH + XSalsa20-Poly1305)
- [x] Ed25519 `signMessage` → `verifyMessage` round-trip
- [x] `decryptMessage` rejects tampered ciphertext (returns null / throws)
- [x] `decryptMessage` rejects mismatched signature
- [x] Key derivation is deterministic for the same seed

### `identityStore`
- [x] First launch: generates Ed25519/X25519 keypair and persists to DB
- [x] Subsequent launch: loads existing keys without generating new ones
- [x] `setAvatar` stores data URL and exposes it via `avatarDataUrl`

### `serversStore`
- [ ] `createServer` writes to DB and populates `servers` reactive map
- [x] `upsertMember` preserves existing `avatarDataUrl` when caller omits it
- [x] `upsertMember` silently rejects unknown `serverId`
- [x] `upsertMember` applies incoming `avatarDataUrl` when provided

### `channelsStore`
- [x] `createChannel` appears in `channels[serverId]` sorted by position
- [x] `renameChannel` updates DB and reactive state atomically
- [x] `deleteChannel` removes entry from map and DB

### `messagesStore`
- [x] `sendMessage` adds optimistic entry then DB-persisted entry with same `id`
- [x] `getMessagesWithMutations`: `edit` mutation applies last-write-wins (HLC order)
- [x] `getMessagesWithMutations`: `delete` mutation nulls `content`
- [x] `getMessagesWithMutations`: `reaction_add` / `reaction_remove` fold correctly
- [x] Cursor pagination: `loadMessages` returns correct window and advances cursor
- [x] `loadMessages` on empty channel returns empty array without error

### `hlc.ts`
- [x] `generateHLC` produces monotonically increasing values within the same millisecond
- [x] `compareHLC` orders by wall time first, then by sequence counter
- [x] `advanceHLC` advances past a remote HLC that is strictly ahead of local clock

### `devicesStore`
- [x] `receiveAttestedDevice` persists device with `revoked: false` (not integer `0`)
- [x] `revokeDevice` marks device `revoked: true` in DB and reactive state

### Rust — `db_save_message` / `db_load_messages`
- [x] Save a message then load it back: returned row is field-for-field identical
- [x] Cursor pagination: `before_ts` excludes messages at or after the cursor
- [x] Loading an empty channel returns an empty vec without error

### Rust — `db_save_mutation` side effects
- [x] `delete` mutation causes subsequent `db_load_messages` to return `content = NULL` for target
- [x] `edit` mutation: later HLC timestamp wins over an earlier one for the same `message_id`
- [x] `reaction_add` mutation is idempotent (same user + emoji stored once)
- [x] `reaction_remove` after `reaction_add` cancels it in the materialized view

### Rust — `db_upsert_member`
- [x] Insert new member then upsert with different `display_name` — row is updated, not duplicated
- [x] Upsert preserves all fields when updating only `display_name`

### Rust — `db_save_device` / `db_load_devices`
- [x] Save `revoked: false`, load back → `revoked` is `false` (bool, not `0`)
- [x] Save `revoked: true`, load back → `revoked` is `true`
- [x] Saving two devices for the same user; load returns both

---

## Phase 5b — P2P File Attachments

**Goal**: Large file transfers without a server, using content-addressed gossip.

- [x] BLAKE3 content-addressed storage: `$APPDATA/gamechat/attachments/{hash[0:2]}/{hash}.bin`
- [x] Chunked download over WebRTC data channels (chunk size 256KB)
- [x] `attachment_want` / `attachment_have` gossip protocol
- [x] Partial download tracking (`.part` bitfield file + `.bits` sidecar)
- [x] Chunk integrity verification against content hash
- [x] Seeding: serve chunks from local cache to requesting peers
- [x] Retention setting (default 30 days) — wired to auto-pruning
- [x] Phase 1 inline base64 path remains active for ≤100KB
- [x] `AttachmentPreview.vue`: image/video/audio/file + lightbox + progress bar + download button
- [x] **Tests**
  - [x] BLAKE3 hash is deterministic for same content
  - [x] Chunk reassembly produces byte-identical file to original
  - [x] Partial download resumes from correct chunk offset
  - [x] Chunk integrity: corrupted chunk is rejected and re-requested
  - [x] Retention pruning removes files older than configured threshold

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
- [ ] **Tests**
  - [ ] `detectNATType()` returns expected type for full-cone, port-restricted, and symmetric setups (mock STUN)
  - [ ] `buildICEConfig` includes relay candidates when NAT type is symmetric
  - [ ] Relay peer advertisement is included in gossip message schema

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
- [ ] **Edit & delete messages**
  - [ ] Permission model: own messages — edit + delete always allowed; others' messages — delete only for admins/owners; edit never allowed on others' messages
  - [ ] `sendEditMutation(messageId, channelId, serverId, newContent)` in `messagesStore` — wraps existing `applyMutation` + broadcast (data layer already handles HLC last-write-wins)
  - [ ] `sendDeleteMutation(messageId, channelId, serverId)` in `messagesStore` — same pattern as reactions
  - [ ] Hover action bar in `MessageBubble.vue`: show edit (pencil) icon for own messages; show delete (trash) icon for own messages + admin messages
  - [ ] Inline edit mode in `MessageBubble.vue`: clicking edit replaces content with a textarea pre-filled with current text; Enter to confirm, Escape to cancel; textarea auto-focuses and auto-sizes
  - [ ] Delete confirmation: plain `window.confirm` (no modal) — controlled by Privacy settings toggle added below
  - [ ] `getMessagesWithMutations` already folds `delete` → `content: null` and `edit` → latest `newContent`; ensure `isEdited` badge renders correctly in `MessageBubble.vue`
  - [ ] Deleted message placeholder: render `"[message deleted]"` in muted italic when `content === null` — controlled by Privacy settings toggle
  - [ ] Admin override: `isAdmin` check uses `roles.some(r => r === 'admin' || r === 'owner')` (already in codebase)
  - [ ] P2P propagation: no new network code needed — `mutation` broadcast already in `sendMutation` flow; negentropy sync propagates mutations to late-joining peers
- [ ] **Tests**
  - [ ] FTS5 message search: exact match, partial match, no results
  - [ ] FTS5 search excludes `content = NULL` (deleted) rows
  - [ ] Passphrase key wrap: wrapped key cannot be decrypted with wrong passphrase
  - [ ] Passphrase key wrap: correct passphrase recovers original keypair
  - [ ] Storage pruning: oldest attachments deleted first; messages pruned only after attachments
  - [ ] Storage usage calculation matches sum of attachment file sizes
  - [ ] Archive export produces a valid signed bundle; import restores server state
  - [ ] `server_rebaseline` mutation: messages before `historyStartsAt` are not synced to joining peers
  - [ ] OS notification fires on mention; does not fire when window is focused
  - [ ] Auto-update: version comparison correctly identifies when an update is available
  - [ ] `sendEditMutation`: optimistic edit reflected in `getMessagesWithMutations` immediately; HLC last-write-wins rejects older edit
  - [ ] `sendDeleteMutation`: message becomes `content: null` in reactive state and in DB
  - [ ] Permission guard: non-admin cannot delete another user's message (mutation rejected client-side)

---

## Phase 7 — Auto-Update & CI/CD

**Goal**: Official GitHub releases with signed auto-update. Code is already 95% done (`updateService.ts`, `SettingsHelpTab.vue`, `tauri-plugin-updater` wired). What remains is one-time repo/key setup and the release workflow.

> **Note**: `src/utils/updateService.ts` and `src/components/settings/SettingsHelpTab.vue` are already fully implemented. `autoCheckForUpdate()` just needs to be called from `App.vue` on startup, the pubkey placeholder in `tauri.conf.json` needs the real key, and the GitHub release pipeline needs creating.

### 7a — One-time key & repo setup (do once, offline)
- [ ] Create the GitHub repository (`GameChat` or chosen name) — public or private
- [ ] Generate Ed25519 update signing key pair: `npm run tauri -- signer generate -w tauri-update-key.key`
  - Outputs `.key` (private) and `.key.pub` (public) — **never commit the private key**
  - Add `.key` to `.gitignore` immediately
- [ ] Store private key as GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` (base64-encoded)
- [ ] Store passphrase (if set) as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- [ ] Add public key to `tauri.conf.json` under `plugins.updater.pubkey` (replace `REPLACE_WITH_YOUR_TAURI_SIGNING_PUBLIC_KEY`)
- [ ] Set `plugins.updater.endpoints` to `["https://github.com/YOUR_ORG/GameChat/releases/latest/download/latest.json"]`

### 7b — GitHub Actions release workflow
- [ ] Copy `.github/workflows/release.yml` from GlyphAstra — update app name, identifier, repo URL
- [ ] Matrix: `windows-latest`, `macos-latest` (x86_64 + aarch64), `ubuntu-22.04`
- [ ] `update-manifest` job: use `actions/github-script` to assemble `latest.json` from `.sig` sidecars and upload as release asset
- [ ] Copy `.github/workflows/ci.yml` from GlyphAstra — runs `npm run build` + `cargo check` on every PR
- [ ] Tag-based trigger: `git tag v0.1.0 && git push --tags` → release builds for all platforms
- [ ] Manual trigger (`workflow_dispatch`) → draft pre-release for testing

### 7c — Wire `autoCheckForUpdate()` into `App.vue`
- [ ] Import `autoCheckForUpdate` from `@/utils/updateService` in `App.vue`
- [ ] Call it once on `onMounted` (or after identity init completes) — it no-ops in DEV and non-Tauri
- [ ] Update `SettingsHelpTab.vue` repo URL from `YOUR_ORG/YOUR_REPO` to real repo URL

### 7d — Validate end-to-end
- [ ] Build a release binary (tag a test version), publish manually, confirm `latest.json` is correct
- [ ] Install the release build, run it — verify `autoCheckForUpdate()` fires and notification appears
- [ ] Click "Install update" → verify download, install, restart prompt

- [ ] **Tests**
  - [ ] `checkForUpdate()` returns `{ available: false }` when `import.meta.env.DEV` is true
  - [ ] `checkForUpdate()` returns `{ available: false }` when `!isTauri`
  - [ ] `autoCheckForUpdate()` shows notification when `checkForUpdate` returns `available: true` (mock)

---

## Phase 8 — Mobile (Android & iOS)

**Goal**: Run GameChat on Android and iOS using Tauri Mobile (same Rust backend, same Vue frontend with responsive layout). No separate codebase.

> **Tauri v2 mobile support**: Tauri 2 ships first-class Android and iOS targets via `tauri android` and `tauri ios` CLI commands. The Rust core (SQLite, crypto, networking) runs unchanged. WebRTC in the mobile WebView requires careful capability handling. This is a significant UX investment — the layout was designed for desktop and needs responsive adaptations.

### 8a — Environment & toolchain setup
- [ ] Install Android Studio + NDK; `ANDROID_HOME`, `NDK_HOME` env vars
- [ ] Install Xcode + iOS simulator (macOS only for iOS builds)
- [ ] Add Android targets: `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android`
- [ ] Add iOS targets: `rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim`
- [ ] `npm run tauri android init` — generates `src-tauri/gen/android/` project
- [ ] `npm run tauri ios init` — generates `src-tauri/gen/apple/` project
- [ ] Verify `npm run tauri android dev` runs in an emulator without crashing

### 8b — Responsive layout
- [ ] Add `useBreakpoint` composable in `src/utils/` — detects `mobile` (< 640px), `tablet` (640–1024px), `desktop` (> 1024px) via `window.matchMedia`
- [ ] `MainLayout.vue`: on mobile, replace 4-column CSS grid with a tab-bar / slide-panel navigation — ServerRail + ChannelSidebar collapse to a drawer, MemberList collapses to a sheet
- [ ] `ChannelSidebar.vue`: full-screen on mobile, slides in from left; back button returns to server rail
- [ ] `MemberList.vue`: bottom sheet on mobile (swipe up to expand)
- [ ] `MessageInput.vue`: floating above keyboard on iOS/Android (handle `visualViewport` resize)
- [ ] `MessageHistory.vue`: ensure virtual scroll works with mobile touch events; add pull-to-refresh (trigger `loadMessages` for older history)
- [ ] `TitleBar.vue`: hide custom title bar on mobile (OS provides its own chrome); use `tauri-plugin-status-bar` for Android status bar color
- [ ] All modals: use `position: fixed; inset: 0` full-screen on mobile instead of centered overlays
- [ ] Touch targets: all buttons ≥ 44×44px (WCAG 2.5.5); replace hover-only interactions with tap + long-press

### 8c — Mobile-specific capabilities & permissions
- [ ] Android `AndroidManifest.xml` (generated): add `INTERNET`, `RECORD_AUDIO`, `CAMERA`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`
- [ ] iOS `Info.plist` (already has mic/screen entries): add `NSCameraUsageDescription`, `NSMicrophoneUsageDescription` (already present in `Info.plist`)
- [ ] `tauri-plugin-microphone` or capability flags for voice chat on mobile
- [ ] Disable LAN mDNS discovery on mobile (mdns-sd uses UDP multicast; use relay/rendezvous instead)
- [ ] `tauri.conf.json`: add `android` and `ios` build config blocks with correct bundle identifiers

### 8d — WebRTC on mobile WebView
- [ ] Android: `WebRTC` works in Android WebView 75+ — verify `getUserMedia` for voice
- [ ] iOS: `getUserMedia` requires `WKWebView` with `allowsInlineMediaPlayback = true` (already set for macOS; verify iOS config)
- [ ] Screen share disabled on mobile (no `getDisplayMedia` equivalent); hide screen share UI when `isMobile`
- [ ] Test voice call between desktop and mobile peer

### 8e — CI/CD for mobile
- [ ] Add `android` job to `release.yml` — `ubuntu-22.04`, `tauri android build --apk`
- [ ] APK signing: `ANDROID_KEY_STORE`, `ANDROID_KEY_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` secrets
- [ ] iOS build: `macos-latest`, `tauri ios build` — requires Apple Developer account + provisioning profile secrets
- [ ] Upload APK/IPA as release assets alongside desktop installers

- [ ] **Tests**
  - [ ] `useBreakpoint` composable correctly identifies `mobile` / `tablet` / `desktop` at breakpoint boundaries (mock `matchMedia`)
  - [ ] `MainLayout.vue` renders drawer mode on mobile viewport (< 640px) and grid mode on desktop (> 1024px)
  - [ ] `MessageInput.vue` does not overflow viewport when virtual keyboard is visible (mock `visualViewport`)

---

- [ ] Abstract networking behind `NetworkProvider` interface
- [ ] `NativeP2PProvider` (current implementation)
- [ ] `MatrixProvider` — `matrix-js-sdk`, map rooms → Channels, spaces → Servers
- [ ] Settings toggle to switch providers
- [ ] Preserve Vue UI layer unchanged across both providers
- [ ] **Tests**
  - [ ] `NativeP2PProvider` and `MatrixProvider` satisfy the `NetworkProvider` interface contract
  - [ ] Switching providers: active channel messages remain visible and reactive
  - [ ] `MatrixProvider`: room → Channel mapping is bijective (no duplicates, no gaps)
