# HexField

**Privacy-first chat — no server required.**

HexField looks like Discord but works like BitTorrent. Your messages never touch a central server — peers connect directly, encrypt everything with libsodium, and sync history through a set-reconciliation protocol. Use it on a LAN with no configuration, scan a QR code to add someone across the internet, or optionally point it at a self-hosted rendezvous server for smoother NAT traversal.

---

## Features

- **Fully P2P** — works on a LAN with zero configuration; QR code pairing reaches anyone on the internet
- **End-to-end encrypted** — all messages encrypted with libsodium (XSalsa20-Poly1305); keys never leave your device
- **Discord-like UX** — servers, channels, roles, reactions, custom emoji, member list
- **Voice & video calls** — WebRTC audio/video; screen sharing on desktop
- **Offline-first** — history stored locally in SQLite; syncs automatically when peers reconnect
- **File attachments** — inline images up to 100 KB; larger files shared P2P (content-addressed)
- **Reactions & custom emoji** — full Unicode reactions + upload your own server emoji
- **Multi-device** — link extra devices via QR code; history reconciles across all of them
- **Roles & moderation** — owner/admin/moderator/member roles; kick, ban, admin-mute
- **Responsive** — desktop (Windows/macOS/Linux) and mobile-ready layout
- **Opt-in rendezvous server** — self-host for invite links and smoother internet connections

---

## How networking works

HexField tries connection methods in this order, from fastest to most flexible:

1. **LAN / mDNS** — peers on the same Wi-Fi or Ethernet discover each other automatically; no setup needed.
2. **QR code / deep link** — share a `hexfield://` link or scan a QR code to exchange identity and connection hints over any side channel (text, email, etc.).
3. **Peer-relay** — a mutual peer relays WebRTC handshake messages to bridge two new peers; no server involved.
4. **Rendezvous server** — configure a server in Settings → Network for smoother NAT traversal and shareable invite links.

---

## Download

Pre-built installers are published on the [Releases](../../releases) page:

| Platform | File |
|----------|------|
| Windows | `HexField_x.y.z_x64-setup.exe` (NSIS) or `.msi` |
| macOS (Apple Silicon) | `HexField_x.y.z_aarch64.dmg` |
| macOS (Intel) | `HexField_x.y.z_x64.dmg` |
| Linux | `HexField_x.y.z_amd64.AppImage` |

The app auto-updates in the background when a new version is published.

---

## Building from source

### Prerequisites

| Tool | Required version |
|------|-----------------|
| [Node.js](https://nodejs.org/) | 20 LTS or later |
| [Rust](https://rustup.rs/) | stable (1.78+) |
| On Linux: WebKit2GTK dev packages | see below |

**Linux system deps (Debian/Ubuntu):**

```bash
sudo apt-get install \
  libwebkit2gtk-4.1-dev \
  libjavascriptcoregtk-4.1-dev \
  libsoup-3.0-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev pkg-config libssl-dev
```

### Clone and run

```bash
git clone https://github.com/wolf123450/hexfield
cd hexfield
npm install

# Development (hot-reload frontend + Tauri window)
npm run dev:tauri

# Type-check + production build
npm run build

# Run tests
npm run test              # Vitest frontend
cd src-tauri && cargo test  # Rust unit tests
```

### Build a release binary

```bash
npm run tauri build
# Installers written to src-tauri/target/release/bundle/
```

---

## Running two instances locally (for testing)

The dev script accepts a profile name that creates an isolated data directory:

```bash
# Terminal 1
npm run dev:tauri

# Terminal 2
npm run dev:tauri -- alice
```

---

## Architecture overview

```
HexField
├── src/                     Vue 3 + TypeScript frontend
│   ├── stores/              Pinia stores (identity, servers, channels, messages, …)
│   ├── components/          UI components (layout, chat, modals, settings)
│   ├── services/            crypto, WebRTC, signaling, sync, audio
│   └── utils/               composables and helpers
└── src-tauri/               Rust backend
    ├── src/
    │   ├── commands/        Tauri IPC commands (db, signals, LAN, sync, …)
    │   ├── db/              SQLite open + migrations
    │   └── lan.rs           mDNS discovery + local WS signal server
    └── migrations/          SQL schema migrations
```

**Key choices:**
- **Tauri v2** — native shell; ~10 MB binary vs 100 MB Electron
- **libsodium-wrappers (WASM)** — all crypto runs in the JS runtime; private keys never cross the IPC boundary
- **rusqlite** — embedded SQLite; no external database process
- **Negentropy** — efficient set-reconciliation for syncing message history between peers
- **UUID v7** — time-sortable IDs for messages and users, enabling efficient range queries
- **Hybrid Logical Clock** — consistent message ordering without clock synchronisation

---

## Privacy model

- **No accounts, no phone numbers** — identity is an Ed25519/X25519 keypair generated locally on first launch
- **No telemetry** — HexField makes no outbound connections except to peers you explicitly join and an optional rendezvous server you configure
- **No message storage on servers** — even with a rendezvous server configured, message content is never sent to it; it relays only WebRTC handshake signals
- **Private keys never leave the app** — all signing and encryption happens in the JavaScript runtime; the Rust backend never sees plaintext messages or private keys

---

## Contributing

Pull requests are welcome. Please:

1. Run `npm run build` (frontend) and `cargo check` (Rust) before submitting — the CI job enforces this.
2. Add tests for non-trivial logic.
3. Keep components, commands, and store actions focused enough that their intent is obvious from their name alone.

See [docs/](docs/) for architecture notes and per-feature specs.

---

## License

[MIT](LICENSE)
