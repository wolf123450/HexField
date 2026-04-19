# HexField — Architecture Plan

> **Stack**: Tauri v2 · Vue 3.5 · TypeScript strict · Pinia 3 · Vite 6
> **Source skeleton**: `d:/Projects/tauri-app-skeleton`
> **Date drafted**: 2026-03-30

---

## Vision & Architecture Philosophy

HexField is a privacy-first, server-optional chat application combining the feature richness of Discord with a decentralized P2P architecture. The primary design goal is that **the app works completely without any central server**. A rendezvous server is a convenience enhancement, not a requirement.

### Core principles

- **Peers communicate directly** — WebRTC data channels for messages, audio, video, and file transfers
- **Server-optional** — a rendezvous server (self-hostable) can be configured for smoother signaling; without one the app falls back to QR code pairing, LAN discovery, and peer-relay signaling
- **All message history** is stored locally in each client's SQLite database and reconciled P2P via set reconciliation (Negentropy)
- **Encryption** — messages encrypted with libsodium; WebRTC audio/video encrypted by DTLS/SRTP automatically

### Connection modes (in priority order)

1. **LAN / mDNS** — peers on the same local network discover each other automatically via DNS-SD
2. **Direct QR code** — a QR code or `hexfield://` link encodes a peer's identity and connection hints; share via any side channel
3. **Peer-relay signaling** — a mutual peer relays WebRTC offer/answer to bridge new connections; no central server involved
4. **Optional rendezvous server** — if configured, provides smooth signaling, presence, and invite link resolution

```
┌──────────────────────────────────────────────────────────────┐
│                      Tauri Desktop App                       │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Vue 3 Frontend (Pinia, libsodium WASM, TanStack)    │    │
│  └──────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Rust Backend (SQLite, mDNS, WS actor, screen cap)   │    │
│  └──────────────────────────────────────────────────────┘    │
└──┬──────────────────────┬───────────────────┬────────────────┘
   │ mDNS (LAN)           │ WebRTC (P2P)      │ WS (optional)
   ▼                      ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐
│  LAN Peers   │   │ Internet     │   │  Rendezvous Server   │
│  (auto-disc) │   │ Peers        │   │  (optional, self-    │
└──────────────┘   │ (STUN/TURN   │   │  hostable)           │
                   │  for NAT)    │   └──────────────────────┘
                   └──────────────┘
```

---

## Specs

Detailed specifications for each feature area:

| # | Spec | Contents |
|---|------|----------|
| 01 | [Project Setup](specs/01-project-setup.md) | npm deps, Cargo deps, CSP, Info.plist, deep-link |
| 02 | [Data Model](specs/02-data-model.md) | TypeScript types, SQLite schema, file system layout |
| 03 | [Stores](specs/03-stores.md) | Pinia store definitions for all 9 stores |
| 04 | [UI Architecture](specs/04-ui-architecture.md) | 4-column layout, component tree, virtual scroll, router |
| 05 | [Backend Commands](specs/05-backend-commands.md) | Rust Tauri commands, AppState, mutation side effects |
| 06 | [Networking](specs/06-networking.md) | QR code, mDNS, peer-relay, rendezvous, device linking, NAT, WebRTC |
| 07 | [Message Sync](specs/07-message-sync.md) | Negentropy, sync protocol, mutations sync, HLC, storage limits |
| 08 | [Encryption](specs/08-encryption.md) | libsodium, cryptoService, group messaging, key storage tiers |
| 09 | [Voice & Screen Share](specs/09-voice-screen.md) | WebRTC audio, audioService, screen capture per platform |
| 10 | [Emoji System](specs/10-emoji.md) | Upload, gossip distribution, picker, reaction bar |
| 11 | [Permissions & Roles](specs/11-permissions.md) | Built-in roles, permission flags, signed role events, server manifest |
| 12 | [Attachments](specs/12-attachments.md) | Phase 1 inline, Phase 5b content-addressed P2P gossip |
| 13 | [Matrix Compatibility](specs/13-matrix.md) | NetworkProvider interface, MatrixProvider, stretch goal |

**Work tracking**: [TODO.md](TODO.md)

---

## Implementation Phases

See [TODO.md](TODO.md) for full task lists with checkboxes.

| Phase | Goal |
|-------|------|
| **1** | Foundation — skeleton rename, layout shell, identity, SQLite |
| **2** | Servers & Channels — create/join servers, channels, member list |
| **3** | Text Chat & Encryption — WebRTC data channels, E2E crypto, live messaging |
| **3b** | Message Sync — Negentropy reconciliation, offline history |
| **4** | Reactions & Emoji — reaction UI, custom emoji upload + gossip |
| **4b** | Device Linking — multi-device attestation + encryption |
| **5** | Voice & Screen Share — WebRTC audio, VAD, screen capture |
| **5b** | P2P File Attachments — BLAKE3 content-addressed torrent-style transfers |
| **5c** | NAT Relay — STUN/TURN/peer-relay with dynamic ICE config |
| **6** | Polish & Hardening — notifications, search, key security, storage limits |
| **★** | Matrix Compatibility — stretch goal, dual-mode NetworkProvider |

---

## Key Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | **Server-optional P2P** | QR code + mDNS + peer-relay as primary; rendezvous server is optional convenience |
| Rendezvous server | **Optional, separate repo** (`hexfield-server`) | Self-hostable; graceful degradation when unavailable |
| Screen capture (macOS) | **Native `getDisplayMedia()`** | WKWebView doesn't support chromeMediaSourceId; macOS 12.3+ shows its own picker |
| Screen capture (Windows) | **`getDisplayMedia()` everywhere** | Win32 source enumeration (EnumWindows + PrintWindow + BitBlt) investigated and dropped — complex for marginal UX gain; system-native picker (Windows 10/11) is adequate |
| Screen capture (macOS < 12.3) | **Rust-side `CGDisplayStream` fallback (Phase 6)** | Only implement if `getDisplayMedia()` proves insufficient in testing |
| Emoji storage | **Files on disk, metadata in SQLite** | Avoids multi-MB SQLite blob reads; lazy-load images on demand |
| Attachments (Phase 1) | **Inline base64 ≤100KB, external URLs** | Simple, no extra infrastructure |
| Attachments (Phase 5b+) | **BLAKE3 content-addressed P2P gossip** | Torrent-style; any peer who has the file can serve it |
| Device linking | **Signed attestation chain, QR code pairing** | No central authority; attestations gossiped like other events |
| Roles enforcement | **Client-side validation of signed role events** | Soft enforcement; forgery impossible, ignoring is possible but harmless |
| Message crypto | **libsodium-wrappers (WASM)** | Keys + plaintext stay in JS runtime; no IPC boundary for sensitive data |
| Phase 2 crypto | **libsodium-wrappers-sumo** for Argon2id KDF | Standard build omits Argon2id; swap npm dep when implementing passphrase-wrap |
| WebRTC | **Browser native API** | Tauri WebView has full Chromium WebRTC; Rust crates are for SFUs |
| SQL | **rusqlite (bundled)** | No external runtime dep; simpler than sqlx async for chat volume |
| Virtual scroll | **TanStack Virtual** (`@tanstack/virtual-core`) | Headless, actively maintained; benchmark 82.9 vs vue-virtual-scroller 35.5 |
| Unicode emoji | **Custom minimal JSON ~80KB** | Full emoji libraries are 1MB+; 1000 common emoji is sufficient for MVP |
| Matrix | **Stretch goal, `NetworkProvider` interface** | Design for it but don't implement until native mode is stable |
| Message sync | **Negentropy (primary) → custom range-based → Merkle/time-buckets** | Purpose-built for ordered P2P event set reconciliation |
| Message ordering | **Hybrid Logical Clock (HLC)** | Consistent ordering without clock synchronisation |
| Message ID format | **UUID v7** | Time-sortable; simplifies range queries and Negentropy partitioning |
| Identity userId | **UUID v7** | Consistent with message IDs |
| Edits / deletes | **Separate mutations table, own UUID v7 IDs** | Syncs via second Negentropy pass; separates immutable message log from mutable state |
| Server settings changes | **`server_update` mutations** | Same sync mechanism as messages; no separate event table needed |
| Channel/role/device events | **Typed mutations** (`channel_create`, `role_assign`, `device_attest`, etc.) | Unified table, single server-level Negentropy pass |
| Delete content erasure | **NULL content + delete attachment files** | Good-faith local erasure; message row kept for sync correctness |
| Deleted message UI | **Hidden by default; optional placeholder in Settings > Privacy** | Clean disappearance by default; power users can see tombstones |
| Edit conflicts | **Last-write-wins by HLC `logical_ts`** | Simple, deterministic, consistent across all peers |
| NAT traversal | **STUN → peer relay → TURN (peer or rendezvous)** | Progressive fallback; no forced dependency on any single relay |
| TURN crate | **`turn` (webrtc-rs project)** | Active; `turn-rs` is a separate unmaintained crate — do not confuse them |
| Protocol handler | **`tauri-plugin-deep-link`** for `hexfield://` | Clickable invite links, device pairing, archive imports |
| Storage limit | **5 GB default, 10 GB max, user configurable** | Auto-pruning (attachments first, then content); server admin can archive + re-baseline |
| Feature flags | **Local behaviour only** | Feature flags must never change the wire protocol or inter-client message format. They control local-only behaviour (pipeline selection, UI, encoding parameters). Clients must gracefully handle unknown capabilities from peers — e.g. ignore unrecognised fields, fall back when a quality tier isn't available |

---

## Superpowers — Feature Extensions & Infrastructure

These are extended feature specifications and infrastructure improvements beyond the core Phase 1–8 roadmap. Full specifications and detailed implementation plans live in [`docs/superpowers/`](superpowers/).

### Infrastructure & Migration Plans

| Plan | Feature Area | File |
|------|--------------|------|
| Client App Diesel ORM | Migrate src-tauri from raw `rusqlite` to Diesel 2 ORM | [`docs/superpowers/plans/2026-04-09-diesel-migration.md`](superpowers/plans/2026-04-09-diesel-migration.md) |
| Rendezvous Server | Full `hexfield-server` implementation (auth, discovery, relay, TURN) | [`docs/superpowers/plans/2026-04-09-rendezvous-server.md`](superpowers/plans/2026-04-09-rendezvous-server.md) |
| UPnP Port Forwarding | Auto-forward LAN port, discover public IP, embed endpoints in invites | [`docs/superpowers/plans/2026-04-09-upnp-public-endpoint.md`](superpowers/plans/2026-04-09-upnp-public-endpoint.md) |
| Image Asset Protocol | Replace data URLs with asset protocol, optimize image serving | [`docs/superpowers/plans/2026-04-10-image-asset-protocol.md`](superpowers/plans/2026-04-10-image-asset-protocol.md) |

### Feature Enhancement Specs

| Spec | Feature Area | File |
|------|--------------|------|
| Moderation & Access Control | Kick, ban, voice mute, ACL, personal block, audit logs, closed servers | [`docs/superpowers/specs/2026-04-04-moderation-and-access-control.md`](superpowers/specs/2026-04-04-moderation-and-access-control.md) |
