# Spec 01 — Project Setup

> Parent: [Architecture Plan](../architecture-plan.md)

---

## 1. Skeleton Copy & Rename

```bash
xcopy /E /I d:\Projects\tauri-app-skeleton d:\Projects\HexField
```

| File | Change |
|------|--------|
| `src/appConfig.ts` | `APP_NAME = 'HexField'`, `STORAGE_PREFIX = 'hexfield_'` |
| `src-tauri/Cargo.toml` | `name = "hexfield"`, update description |
| `src-tauri/tauri.conf.json` | `productName = "HexField"`, `identifier = "com.hexfield.app"`, window 1280×800 |
| `index.html` | `<title>HexField</title>` |
| `package.json` | `name = "hexfield"` |

Files to delete from skeleton:
- `src/stores/notesStore.ts`
- `src/components/NoteItem.vue`
- `src/components/Sidebar.vue`

---

## 2. npm Dependencies

```json
{
  "dependencies": {
    "libsodium-wrappers":       "^0.7.15",
    "@types/libsodium-wrappers": "^0.7.15",
    "@tanstack/virtual-core":   "^3.0.0",
    "date-fns":                 "^3.6.0",
    "uuid":                     "^10.0.0",
    "@types/uuid":              "^10.0.0",
    "qrcode":                   "^1.5.4"
  }
}
```

> **Phase 2 note**: When implementing passphrase-wrapped key storage, swap `libsodium-wrappers` → `libsodium-wrappers-sumo`. The standard build does not include Argon2id.

---

## 3. Cargo Dependencies

```toml
[dependencies]
# Storage
rusqlite           = { version = "0.32", features = ["bundled"] }
rusqlite_migration = "1.3"

# Async runtime + networking
tokio              = { version = "1", features = ["rt-multi-thread", "macros", "net", "time", "sync"] }
tokio-tungstenite  = { version = "0.29", features = ["native-tls"] }
futures-util       = "0.3"
reqwest            = { version = "0.12", features = ["json", "native-tls"] }

# Identity
uuid               = { version = "1", features = ["v4", "v7"] }
ed25519-dalek      = { version = "2", features = ["serde"] }
rand               = "0.8"

# P2P sync
negentropy         = "0.5"
blake3             = "1"

# LAN discovery
mdns-sd            = "0.18"

# TURN relay (webrtc-rs project — NOT the separate `turn-rs` crate)
turn               = "0.8"

# Serde
serde              = { version = "1", features = ["derive"] }
serde_json         = "1"
log                = "0.4"

# Tauri plugins
tauri              = { version = "2", features = ["devtools"] }
tauri-plugin-log   = "2"
tauri-plugin-fs    = "2"
tauri-plugin-dialog = "2"
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
tauri-plugin-notification = "2"
tauri-plugin-deep-link = "2"   # hexfield:// protocol handler

[target.'cfg(target_os = "windows")'.dependencies]
windows            = { version = "0.58", features = ["Win32_Graphics_Gdi", "Win32_UI_WindowsAndMessaging"] }
```

> **Why rusqlite over sqlx**: Bundled SQLite ships in the binary with no external runtime dependency. `Mutex<Connection>` is simpler than sqlx async for chat-volume throughput. `rusqlite_migration` handles embedded SQL migration files cleanly.

---

## 4. CSP (`tauri.conf.json`)

```
"csp": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws: https: ipc://localhost http://ipc.localhost http://localhost:*; media-src 'self' blob:; img-src 'self' data: blob:; font-src 'self' data:"
```

Key additions over skeleton default:
- `wss: ws:` — WebSocket for signaling
- `wasm-unsafe-eval` — required for libsodium WASM initialisation
- `media-src blob:` — WebRTC `MediaStream` sources

---

## 5. macOS Info.plist

Add to `tauri.conf.json` under `bundle > macOS > info_plist` (or a custom `Info.plist` template):

```xml
<key>NSCameraUsageDescription</key>
<string>HexField uses your camera for video calls.</string>
<key>NSMicrophoneUsageDescription</key>
<string>HexField uses your microphone for voice chat.</string>
<key>NSScreenCaptureUsageDescription</key>
<string>HexField uses screen capture for screen sharing.</string>
```

Without these, `getUserMedia()` and `getDisplayMedia()` will silently fail on macOS.

---

## 6. Deep Link Registration

Register `hexfield://` protocol in `tauri.conf.json`:

```json
"plugins": {
  "deep-link": {
    "mobile": [],
    "desktop": { "schemes": ["hexfield"] }
  }
}
```

Listen in `main.ts`:
```typescript
import { onOpenUrl } from '@tauri-apps/plugin-deep-link'
onOpenUrl((urls) => router.push(parseHexFieldUrl(urls[0])))
```

Supported URL patterns:
- `hexfield://join/{inviteCode}` — join a server
- `hexfield://pair/{linkToken}` — device pairing
- `hexfield://archive/{archiveId}` — import server archive
