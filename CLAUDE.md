# HexField — Claude Code Instructions

## Maintaining This File

**This file is a living document.** If you encounter an error or unexpected behavior while following instructions in this file — e.g., an API has changed, a pattern no longer compiles, a path has moved, or an assumption is wrong — **fix the CLAUDE.md entry immediately** after identifying the correct information. Do not leave stale instructions for the next session to trip over.

When updating:
- Fix the specific instruction that was wrong
- If a new pitfall is discovered, add it to the **Known Pitfalls** table
- If project structure changes (new files, renamed dirs), update the **Project Structure** tree
- If a phase is completed, update the **Phase Status** table
- Keep entries concise — this file is loaded into every conversation's context

## Project Overview

HexField is a privacy-first, server-optional P2P chat app (Tauri v2 + Vue 3.5 + Pinia 3 + TypeScript strict + rusqlite). Think Discord UX, but fully decentralized — no central server required.

## Project Structure

```
src/                          # Vue frontend
  App.vue                     # Root: mounts layout, modals, settings
  main.ts                     # Vue + Pinia + Router bootstrap
  appConfig.ts                # APP_NAME, STORAGE_PREFIX, constants
  types/core.ts               # ALL shared TypeScript interfaces (Message, Server, Channel, etc.)
  router/index.ts             # Vue Router: "/" → MainLayout, "/join/:code" → JoinView
  stores/                     # Pinia stores (Setup Store pattern)
    identityStore.ts           # Ed25519/X25519 keypair, userId, displayName
    serversStore.ts            # CRUD servers, members, role mutations
    channelsStore.ts           # CRUD channels per server
    messagesStore.ts           # Messages + mutations + reactions + HLC
    voiceStore.ts              # Voice session state (Phase 5)
    networkStore.ts            # Peer connections, signaling (Phase 3)
    emojiStore.ts              # Custom emoji metadata (Phase 4)
    uiStore.ts                 # Sidebar, modals, notifications, context menu
    settingsStore.ts           # User preferences persistence
  services/
    cryptoService.ts           # libsodium WASM — ALL crypto ops; private keys held here only
  components/
    layout/                    # 4-column grid: ServerRail, ChannelSidebar, MainPane, MemberList
    chat/                      # MessageHistory, MessageBubble, MessageInput, TypingIndicator
    modals/                    # ServerCreateModal, InviteModal, JoinModal
    settings/                  # Settings tabs: Profile, Voice, Privacy, Notifications
  utils/                       # Composables and helpers
  styles/global.css            # CSS custom properties (--bg-primary, --accent-color, etc.)

src-tauri/                    # Rust backend
  src/
    lib.rs                     # AppState, plugin init, invoke_handler registration
    main.rs                    # Entry point
    db/
      mod.rs                   # open() — creates/opens SQLite file
      migrations.rs            # rusqlite_migration runner, includes 001_initial.sql
      types.rs                 # Serde row structs (MessageRow, ChannelRow, etc.)
    commands/
      mod.rs                   # pub use
      db_commands.rs           # ALL Tauri commands (db_*, get_*)
  migrations/
    001_initial.sql            # Schema: servers, channels, messages, mutations, members, etc.
  Cargo.toml                   # Rust dependencies
  tauri.conf.json              # Tauri config, CSP, window settings, plugins
  Info.plist                   # macOS privacy descriptions (camera, mic, screen)

docs/                         # Planning (source of truth for scope and progress)
  architecture-plan.md         # Vision, stack, key decisions log
  TODO.md                      # Phase-by-phase checkbox list — UPDATE WHEN TASKS COMPLETE
  specs/01..13                 # Deep specs per feature area
```

---

## Documentation & Planning

All planning lives in [`docs/`](docs/):

| File | Purpose |
|------|---------|
| [`docs/architecture-plan.md`](docs/architecture-plan.md) | Vision, stack, key decisions log, spec index |
| [`docs/TODO.md`](docs/TODO.md) | Phase-by-phase task checklist — **the source of truth for progress** |
| [`docs/specs/01-13`](docs/specs/) | Deep specifications per feature area (see mapping below) |

### Spec-to-code mapping

Use this to know which spec to read before touching an area:

| Spec | Governs |
|------|---------|
| `01-project-setup` | `Cargo.toml`, `package.json`, `tauri.conf.json`, deps, CSP |
| `02-data-model` | `types/core.ts`, `db/types.rs`, `001_initial.sql`, filesystem layout |
| `03-stores` | All 9 Pinia stores in `src/stores/` |
| `04-ui-architecture` | Layout components, router, virtual scroll, CSS grid |
| `05-backend-commands` | `db_commands.rs`, `AppState`, mutation side-effects |
| `06-networking` | `networkStore`, signaling, mDNS, peer-relay, WebRTC, device linking, NAT |
| `07-message-sync` | Negentropy, sync protocol, HLC, offline queue |
| `08-encryption` | `cryptoService.ts`, group messaging, key storage tiers |
| `09-voice-screen` | `voiceStore`, audio/video, screen capture per platform |
| `10-emoji` | `emojiStore`, picker, custom emoji upload + gossip |
| `11-permissions` | Roles, permission flags, signed role events, server manifest |
| `12-attachments` | Phase 1 inline, Phase 5b content-addressed P2P gossip |
| `13-matrix` | NetworkProvider interface, stretch goal |

**Always read the relevant spec before touching a feature area.** Update `TODO.md` checkboxes when phase tasks are completed.

---

## Context7 — Library Documentation Lookup

**Use the Context7 MCP server to fetch current documentation** whenever working with any library, framework, or API in this project. Do not rely on training data — these APIs evolve rapidly.

### When to use Context7

- **Planning phase**: Before starting any new phase, look up the primary libraries involved to verify API assumptions
- **New library integration**: Any time a new dependency is being used for the first time (e.g., `negentropy`, `mdns-sd`, `tokio-tungstenite`)
- **API uncertainty**: When unsure about the correct API for Tauri v2 plugins, Vue 3.5 composition API, Pinia 3, TanStack Virtual, libsodium-wrappers, rusqlite, etc.
- **Version-specific behavior**: When behavior may differ between versions (Tauri v1 vs v2 is a common trap)
- **Debugging library errors**: When encountering unexpected behavior from a dependency

### How to use

1. Call `resolve-library-id` with the library name and the question
2. Pick the best match by name, description, and snippet count
3. Call `query-docs` with the selected library ID and the full question
4. Use the fetched docs to inform implementation

### Key libraries in this project

| Library | Notes |
|---------|-------|
| Tauri v2 | API differs significantly from v1 — always verify plugin APIs |
| Vue 3.5 | Composition API only; `<script setup>` syntax |
| Pinia 3 | Setup Store pattern; `defineStore('id', () => { ... })` |
| TanStack Vue Virtual | `useVirtualizer` returns a `Ref` — use `.value` for method calls in script, auto-unwrapped in templates |
| libsodium-wrappers | WASM build; `await _sodium.ready` before use |
| rusqlite | Sync API; `query_map` borrows `stmt` — collect before block exit |
| rusqlite_migration | `Migrations::new(vec![M::up(...)])` |
| tokio-tungstenite | WebSocket client for signaling (Phase 3) |
| qrcode | `QRCode.toString(data, { type: 'svg' })` for SVG output |

---

## Development Loop

Follow this loop for every change:

1. **Check docs** — read `TODO.md` and the relevant spec(s) before writing any code
2. **Look up library APIs** — use Context7 for any library API you're about to use, especially if it's the first time in this project or you're unsure of the exact signature
3. **Branch** — always work on a feature branch; `main` has push protection and requires a PR:
   ```bash
   git checkout -b feat/your-feature-name
   ```
4. **Verify baseline** — confirm the app builds cleanly before making changes:
   ```bash
   npm run build          # Frontend: vue-tsc --noEmit && vite build
   cd src-tauri && cargo check   # Rust: type-check without full compile
   ```
4. **Implement** — make the smallest correct change that moves a TODO item forward
5. **Verify** — run `npm run build` and `cargo check` to confirm no regressions; for UI changes, run `npm run dev:tauri` and visually confirm
6. **Fix & repeat** — if there are errors, diagnose the root cause and fix; never silence errors with workarounds
7. **Test** — write tests alongside the implementation (see Testing section); run `npm run test` and `cd src-tauri && cargo test`
8. **Commit** — commit with a clear message describing intent; update the relevant `TODO.md` checkboxes

---

## Build Commands

```bash
# Frontend type-check + Vite production build (fastest full check)
npm run build

# Frontend type-check only
npx vue-tsc --noEmit

# Rust type-check (no full compile — faster than cargo build)
cd src-tauri && cargo check

# Full dev run (Tauri + hot-reload frontend)
npm run dev:tauri

# Frontend tests
npm run test              # single run
npm run test:watch        # watch mode

# Rust tests
cd src-tauri && cargo test
```

---

## Tauri IPC Contract

The frontend calls Rust commands via `invoke('command_name', { paramObject })`. The param object field names must match the **serde-deserialized** names on the Rust struct — which may differ from the Rust field name due to `#[serde(rename)]`.

### Serde rename traps

Two structs have `#[serde(rename = "type")]` attributes:

| Rust struct | Rust field | Serde wire name | SQL column |
|-------------|-----------|-----------------|------------|
| `MutationRow` | `mutation_type` | `type` | `type` |
| `ChannelRow` | `channel_type` | `type` | `type` |

The frontend must send `{ type: "text" }`, **not** `{ channel_type: "text" }`. The Rust code uses `mutation_type` / `channel_type` internally because `type` is a reserved keyword in Rust.

### Boolean fields

SQLite stores booleans as `INTEGER` (0/1). Rust `types.rs` uses `bool`. The command layer converts: `row.get::<_, i64>(n)? != 0` on read, `field as i64` on write. The frontend sends/receives native `boolean`.

### General rule

When writing a new `invoke` call, cross-reference three places:
1. The Rust struct in `src-tauri/src/db/types.rs` (check for `#[serde(rename)]`)
2. The SQL column names in `src-tauri/migrations/001_initial.sql`
3. The TypeScript interface in `src/types/core.ts`

---

## Rust / Tauri Standards

### General
- Target `edition = "2021"` idioms: use `?` for error propagation, avoid `.unwrap()` in production paths
- All Tauri commands return `Result<T, String>` — convert errors with `.map_err(|e| e.to_string())`
- Keep `AppState` minimal: `Mutex<rusqlite::Connection>` + async channel senders only; never store derived data
- Use `rusqlite_migration` for all schema changes — add new `M::up(...)` entries, never alter existing ones

### Borrow checker patterns
- **`query_map` + `if/else` blocks**: collect `stmt.query_map(...)` results into a local `let rows = ...;` **before** the block ends. The borrow on `stmt` must be released before the enclosing scope exits. Pattern:
  ```rust
  let rows = if condition {
      let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
      let rows = stmt.query_map(params, mapper)
          .map_err(|e| e.to_string())?
          .collect::<Result<Vec<_>, _>>()
          .map_err(|e| e.to_string())?;
      rows  // explicit binding, not a trailing expression
  } else { ... };
  ```
- **Mutex guards**: never hold across `.await` — drop before any async call

### Commands
- Name commands `db_<verb>_<noun>` for DB operations, `<noun>_<verb>` for everything else
- Validate inputs at the command boundary; trust nothing from the frontend
- Side effects (mutation application, file writes) belong in command handlers, not in frontend stores
- Register every new command in `lib.rs` `invoke_handler![]`

### Async
- Tauri commands are sync by default — use `async fn` only when calling `.await` inside the command
- WebSocket actor runs in its own `tokio::spawn` task; communicate via `mpsc` channels stored in `AppState`

### Error handling
- No `panic!` in release paths — use `Result` throughout
- Log errors with `log::error!` before returning `Err(...)` from commands
- Never use `.unwrap()` or `.expect()` on data from the network or SQLite

---

## Vue 3 / TypeScript Standards

### Composition API
- Use `<script setup>` exclusively — no Options API, no `defineComponent` wrapper
- Keep component logic focused: if a `<script setup>` block exceeds ~120 lines, extract a composable
- Composables live in `src/utils/` (generic) or inline in the component file if single-use

### Pinia stores
- All stores use the **Setup Store** pattern: `defineStore('id', () => { ... })`
- Store state is the single source of truth — components derive display values with `computed`, never duplicate state
- Async store actions handle their own error reporting via `uiStore.showNotification()`
- **Circular dependency avoidance**: never `import` a store at the top level of another store file. Use dynamic `await import()` inside actions:
  ```ts
  async function sendMessage(channelId: string, content: string) {
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()
    // ... use identityStore.userId
  }
  ```
  Components can import any store freely — the restriction only applies to store-to-store imports.

### TanStack Vue Virtual
- `useVirtualizer()` accepts a `MaybeRef<Options>` — wrap the options object in `computed()` so reactive properties (like `count`) trigger re-renders:
  ```ts
  const virtualizer = useVirtualizer(computed(() => ({
    count: allMessages.value.length,
    getScrollElement: () => scrollContainer.value,
    estimateSize: () => 60,
  })))
  ```
- `useVirtualizer` returns a `Ref<Virtualizer>` — use `.value` for method calls in `<script>`, but templates auto-unwrap

### TypeScript
- `strict: true` with `noUnusedLocals` and `noUnusedParameters` — the build (`vue-tsc --noEmit`) treats these as errors
- No `any` except when bridging Tauri `invoke` raw rows — type with `any[]`, map immediately to typed interfaces
- Type all Tauri command inputs/outputs matching the `*Row` struct in `src-tauri/src/db/types.rs`
- Prefix intentionally unused parameters with `_` (e.g., `_iconFile?: File`)
- Prefer `interface` for object shapes; `type` for unions/aliases

### Components
- Single responsibility: layout components own grid/sizing; feature components own behaviour
- Use `Teleport to="body"` for modals and overlays — never nest them inside a scrolling container
- Prefer computed props for derived display values; avoid side-effectful watchers
- Use `v-if` for conditional rendering of heavy components (not `v-show`), except for elements that toggle very frequently

### Icons
- **Never write inline `<svg>` elements in components.** Always use the `<AppIcon>` component with a path from `@mdi/js`.
- `AppIcon` is globally registered — no import needed in `<script setup>`.
- Import the path constant: `import { mdiEmoticonPlus } from '@mdi/js'` then use `<AppIcon :path="mdiEmoticonPlus" :size="20" />`.
- Browse available icons at https://pictogrammers.com/library/mdi/ — the export name is the camelCase version of the icon name (e.g. `emoticon-plus` → `mdiEmoticonPlus`).
- Icon buttons that override the global `button` reset **must** set `padding: 0` and `transform: none` in their scoped CSS to prevent the global `button` rule from shrinking the icon or adding a hover translateY.

### CSS
- Use CSS custom properties from `styles/global.css` (`--bg-primary`, `--text-secondary`, `--accent-color`, `--spacing-md`, etc.)
- Always `<style scoped>` — only `global.css` is unscoped
- Use `:deep()` sparingly and only for third-party component overrides

### Naming
- Files: PascalCase for components (`ServerRail.vue`), camelCase for services/utils (`cryptoService.ts`)
- Events: kebab-case (`emit('channel-selected', id)`)
- Store refs: noun only (`channels`, `activeServerId`); actions: verb + noun (`loadChannels`, `createServer`)

---

## Testing

### Frontend — Vitest + @vue/test-utils
- Test file convention: `src/<path>/__tests__/<filename>.test.ts`
- Mock the Tauri IPC bridge in every store test:
  ```ts
  import { vi } from 'vitest'
  vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
  ```
- Component tests: mount with `createTestingPinia()` from `@pinia/testing` (install if missing: `npm i -D @pinia/testing`)
- Cover: happy path, empty/null inputs, error paths
- Write tests alongside implementation, not as a separate pass after the fact

### Rust — `cargo test`
- Unit-test pure helper functions in the same file under `#[cfg(test)]`
- DB command tests use an in-memory SQLite connection:
  ```rust
  #[cfg(test)]
  fn test_conn() -> rusqlite::Connection {
      let mut conn = rusqlite::Connection::open_in_memory().unwrap();
      crate::db::migrations::run(&mut conn);
      conn
  }
  ```
- Never write tests that depend on filesystem paths or network

### Priority test targets
- `cryptoService`: encrypt → decrypt round-trip; signature verify; bad key rejection
- `identityStore`: first-launch key generation, key reload from existing DB
- `messagesStore`: `sendMessage` optimistic flow, `getMessagesWithMutations` reaction/edit folding, HLC ordering
- `channelsStore`: create, rename, delete; position ordering
- `db_load_messages` / `db_save_message`: cursor pagination boundary conditions
- `db_save_mutation`: side-effects (delete nulls content, edit respects HLC last-write-wins)

---

## Security

- **Private keys never leave `cryptoService`** — do not store them in Pinia state, do not pass them to Rust
- Validate and sanitise all user-supplied strings before inserting into SQLite — use parameterised queries exclusively, never string interpolation
- CSP is locked in `tauri.conf.json` — do not loosen it without a documented reason and comment in the config
- No `eval()` or dynamic `import()` of untrusted strings in the frontend
- Audit all `v-html` usage — only allow it for trusted generated content (e.g., QR code SVG from `qrcode` library)

---

## Code Quality

- **No dead code** — remove unused imports, variables, and functions immediately; `vue-tsc` with `noUnusedLocals`/`noUnusedParameters` enforces this
- **No TODO comments in committed code** — track work items in `docs/TODO.md` instead
- **No speculative abstractions** — build for the current phase only; refactor when the pattern actually recurs
- Keep components, commands, and store actions focused enough that their intent is obvious from their name alone
- Prefer explicit over implicit: spell out field names in struct initialisers, avoid positional destructuring of tuples in complex functions
- When fixing a bug, understand the root cause first — don't apply workarounds that may mask deeper issues

---

## Known Pitfalls

Issues that have already been encountered and fixed. **Do not re-introduce these.**

| Pitfall | Fix |
|---------|-----|
| `ResizeObserver loop completed with undelivered notifications` shown as fatal startup error | This is a benign Chromium/WebView2 noise; `window.onerror` and `unhandledrejection` handlers in `main.ts` now filter it out with `msg.includes('ResizeObserver loop')` |
| `libsodium-wrappers` ESM build references non-existent `libsodium.mjs` | Aliased to CJS build in `vite.config.ts` resolve.alias |
| `macOS.infoPlist` in `tauri.conf.json` rejects inline JSON objects | Must be a file path string or empty object; see `src-tauri/Info.plist` |
| `useVirtualizer` options passed as plain object with computed fields | Wrap entire options in `computed(() => ({ ... }))` |
| `useVirtualizer` returns `Ref` — calling methods without `.value` in script | Use `virtualizer.value.scrollToIndex(...)` in `<script>`, bare `virtualizer.scrollToIndex()` in `<template>` |
| `rusqlite` `query_map` borrow outlives `stmt` in `if/else` | Collect into local `let rows = ...; rows` before block exit |
| `MutationRow.mutation_type` / `ChannelRow.channel_type` have `#[serde(rename = "type")]` | Frontend must send `{ type: ... }` not `{ mutation_type: ... }` |
| Global `button, .btn` rule sets `padding: var(--spacing-sm) var(--spacing-md)` | Icon-only buttons need `padding: 0; transform: none` in scoped CSS, otherwise the padding consumes almost the entire fixed width and the icon renders at 2-3px | 
| `fetchMembers` reads `display_name` from the `members` table, which goes stale after name changes | `fetchMembers` now hydrates own record from `identityStore` (name + avatar) after loading. The `members` table has `avatar_data_url` column (migration 002) — peer avatars are persisted when received via gossip and survive restarts |
| Members DB had no avatar column — peer avatars wiped on every server switch or app restart | Fixed: `002_member_avatar.sql` adds `avatar_data_url TEXT` to members; `db_upsert_member`/`db_load_members` include the column; `upsertMember` persists it on gossip |
| Members DB had no bio/banner columns — peer bios lost on every restart | Fixed: `009_member_profile_fields.sql` adds `bio`, `banner_color`, `banner_data_url` to members; `updateMemberProfile` now calls `db_upsert_member` to persist; `fetchMembers` reads from DB rows directly |
| `isAdmin` checks used `roles.includes('admin')` but server creator (pre-change) had role `'owner'` | All `isAdmin` checks now use `.some(r => r === 'admin' \|\| r === 'owner')` |
| Voice participant rows in `ChannelSidebar` used text-initials `<div>` instead of `<AvatarImage>` | Always use `<AvatarImage>` for avatar display; text-initials divs won't react to avatar changes |
| User avatar GIF limit was 512 KB; should be 20 MB | `MAX_GIF_BYTES` in `UserProfileModal.vue` corrected to `20 * 1024 * 1024` |
| Server icon upload code was duplicated in `ServerRail.vue` and `ChannelSidebar.vue` | Both removed; icon changes now go through `ServerSettingsModal.vue`; context menus show "Server Settings" → `uiStore.openServerSettings(serverId)` |
| Members appear 'online' by default on fresh load even when offline | `fetchMembers` now sets remote members to `'offline'`; own status read from `localStorage.getItem('hexfield_own_status')` |
| Status mirroring: B changes to 'busy', A's status in B's view becomes 'busy' after ~10s | `hexfield_own_status` localStorage key was not user-scoped; two instances on same machine shared it. All reads/writes now use `hexfield_own_status_${userId}` |
| mDNS causes both peers to dial each other simultaneously; stale `register_peer` cleanup emptied `lan_peers` | Added `PEER_GENERATION: AtomicU64` to `lan.rs`; `LanPeers` is now `HashMap<String, (u64, UnboundedSender<Value>)>`; cleanup only removes if `gen` still matches |
| `gossipOwnDevice/Membership/Presence/Profile/ServerAvatars` called without `.catch()` in `onConnected` callback | Any async failure (e.g. import mock mismatch in tests) produces an unhandled rejection that poisons the test run; all five gossip calls now have `.catch(e => console.warn(...))` |
| Ubuntu 24.04 (and Debian) `libwebkit2gtk-4.1-0` does **not** compile WebRTC in — `RTCPeerConnection` is `undefined` regardless of the `enable-webrtc` GObject setting | The setting (`webkit_settings_set_enable_webrtc`) exists as API stub since WebKit 2.38, but the WebRTC implementation is not compiled in. `with_webview`+`reload()` workaround is ineffective. **Fix**: `networkStore.init()` checks `webrtcService.isAvailable()` and shows a user-facing warning. For real WebRTC: use Arch/Fedora/openSUSE (which compile WebRTC in), or distribute as Flatpak (GNOME runtime includes full WebKitGTK). |
| VS Code snap leaks `GIO_MODULE_DIR` pointing to snap-compiled GIO modules whose RPATH includes `/snap/core20/current/lib/…` — `WebKitNetworkProcess: symbol lookup error: __libc_pthread_init` | **Root cause**: `GIO_MODULE_DIR=/home/cday/snap/code/common/.cache/gio-modules` (snap VS Code). Fix in `scripts/dev-tauri.mjs`: delete `GIO_MODULE_DIR`, `GTK_PATH`, `GTK_EXE_PREFIX`, `GTK_IM_MODULE_FILE`, `GSETTINGS_SCHEMA_DIR`, `LOCPATH` from the env object before spawning the Tauri process on Linux. |
| Rust WebRTC relay in `networkStore.ts` omits `from` field in relayed signals — all peers silently drop every offer/answer/ICE | The relay listeners added in `feat/webrtc-rs` sent `{ type: 'signal_offer', to, sdp }` without `from`. `handleSignalMessage` guards `if (!from) return`, so all signals were dropped. Fix: add `from: localUserId` to every `sendSignal()` call in the three `webrtc_offer/answer/ice` relay listeners. |
| `tauri-pilot` CLI and plugin are **Linux-only** — `cargo install tauri-pilot-cli` fails on Windows/macOS | `tauri-pilot` uses Unix sockets and WebKitGTK APIs. The Rust plugin compiles only when `target_os = "linux"` (hard-gated in `Cargo.toml`); the CLI uses `uid()` and other Unix syscalls that won't compile elsewhere. macOS/Windows support is planned upstream. |
| `playwright:default` in `capabilities/default.json` causes build failure on non-e2e builds | Tauri validates all capability permissions at build time against currently-compiled plugins. `playwright:default` only exists when `tauri-plugin-playwright` is compiled in via `--features e2e-testing`. Since the plugin communicates over TCP (not Tauri IPC), no capability entry is needed at all — do NOT add `playwright:default` to any capabilities file. |
| `signJson`/`verifyJsonSignature` sorted only top-level keys — nested object keys got reordered by serde_json relay, breaking signatures | `serde_json` without `preserve_order` uses `BTreeMap` (alphabetical keys). Signal payloads with nested objects (e.g. `signal_ice` → `candidate: { candidate, sdpMid, sdpMLineIndex }`) had nested keys reordered in transit through the Rust WS/LAN relay. Fix: added `deepSortObj()` helper that recursively sorts ALL object keys before canonicalization. Both `signJson` and `verifyJsonSignature` now use `canonicalJson()` which deep-sorts. |
| Tauri v2 asset protocol configured as `"core:asset:allow"` capability | `"core:asset:allow"` is **not** a valid Tauri v2 capability identifier — the build script rejects it. The correct approach: (1) add `"assetProtocol": { "enable": true, "scope": ["$APPDATA/**"] }` under `app.security` in `tauri.conf.json`; (2) add `"protocol-asset"` to the `tauri` dependency features in `Cargo.toml`. No capability entry needed. |
| `webrtc_manager.rs` `handle_offer` inserted peer entry AFTER `set_local_description`, causing "no peer entry" for ICE candidates arriving during SDP negotiation | The offerer starts trickling ICE candidates the moment `set_local_description` is called. Those `signal_ice` messages arrive on the callee while `handle_offer` is still awaiting. Fix: insert `PeerEntry { pc: pc.clone(), dc: dc_slot }` into `self.peers` immediately after `wire_callbacks`, before any SDP awaits. |
| `_pushItems` in syncService sent all messages/mutations in a single `sync_push`, exceeding the ~65 KB SCTP max message size | Fixed: byte-size-based chunking (`SCTP_SAFE_BYTES = 60_000`) — batches accumulate until the next item would exceed the limit, then a new frame starts. Single messages whose `content` is a data URL longer than `SCTP_SAFE_BYTES` have the content replaced with `'[image: too large to sync inline]'` before sending, breaking the endless negentropy retry loop. Inline attachment cap in `MessageInput.vue` lowered from 100 KB to 40 KB (40 KB binary → ~53 KB base64 → safely under 60 KB with JSON overhead). |
| On join, `startSync` fires when the data channel opens (before `joinFromManifest`), so the host pushes messages that fail with `FOREIGN KEY constraint failed` (server/channels not in joiner's DB yet) | Fixed: `JoinView.vue` calls `networkStore.resyncPeer(invite.userId)` after `joinFromManifest` + `loadChannels` to recover the missed messages. |
| Rate limit of 15 msg/s blocked legitimate sync traffic during initial negentropy + push burst | `RATE_LIMIT` raised to 100 in `networkStore.ts`. |

---

## Key Architectural Decisions

See [`docs/architecture-plan.md`](docs/architecture-plan.md) for the full log. Quick reference:

- **P2P first** — no central server required; rendezvous server is optional convenience
- **libsodium-wrappers (WASM)** for all crypto — keys stay in JS, never cross IPC boundary
- **rusqlite (bundled)** for SQLite — sync API, `Mutex<Connection>` in `AppState`
- **TanStack Virtual** for message list — headless, handles 100k+ rows
- **Negentropy** for message sync set-reconciliation (Phase 3b)
- **UUID v7** for all IDs — time-sortable, simplifies range queries and Negentropy partitioning
- **HLC (Hybrid Logical Clock)** for message ordering — `logical_ts` string format `{wallMs}-{seq:06}`
- **WebRTC browser-native API** — Tauri WebView has full Chromium WebRTC; Rust crates are for SFUs, not clients

---

## Phase Status

Check [`docs/TODO.md`](docs/TODO.md) for detailed task-level progress.

| Phase | Status |
|-------|--------|
| 1 — Foundation | Complete |
| 2 — Servers & Channels UI | Complete |
| 3 — Text Chat & Encryption | Complete |
| 3b — Message Sync | Complete |
| 4 — Reactions & Emoji | Complete |
| 4b — Device Linking | Complete |
| 5 — Voice & Screen Share | Complete |
| 5b — P2P File Attachments | Pending |
| 5c — NAT Relay | Pending |
| 6 — Polish & Hardening | Pending |
| Stretch — Matrix Compatibility | Pending |
