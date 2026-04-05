# Spec 09 — Voice & Screen Share

> Parent: [Architecture Plan](../architecture-plan.md)

---

## 1. Approach: Browser Native WebRTC

Tauri's Chromium/WKWebView has full WebRTC support: hardware codec acceleration (VP8/VP9, H.264, Opus), DTLS/SRTP built-in. No Rust WebRTC crate needed — those are appropriate for server-side SFUs, not desktop clients.

Screen capture is the only Rust involvement: enumerating sources and (on macOS < 12.3, Phase 6) frame capture.

---

## 2. Voice Channel Join Flow

```typescript
// voiceStore.joinVoiceChannel(channelId, serverId):

const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
voiceStore.localStream = stream
audioService.setLocalStream(stream)

// If rendezvous server configured:
const { peers } = await http.post(`/voice/${channelId}/join`)
// Otherwise: peers are the currently-connected WebRTC peers in this channel

for (const peerId of peers) await webrtcService.createOffer(peerId)
// Late-joiners send us offers; handled via webrtcService.handleOffer()

voiceStore.session = { channelId, serverId, joinedAt: new Date().toISOString(), peers: {} }
```

---

## 3. audioService — `src/utils/audioService.ts`

```typescript
class AudioService {
  // Remote streams
  attachRemoteStream(userId: string, stream: MediaStream): void
  // Create hidden <audio autoplay> in DOM, set srcObject, start VAD

  detachRemoteStream(userId: string): void

  // Controls
  setLocalMuted(muted: boolean): void       // track.enabled = !muted
  setDeafened(deafened: boolean): void      // all remoteAudios.muted = deafened
  setPeerVolume(userId: string, volume: number): void
  setInputDevice(deviceId: string): Promise<MediaStream>

  // Voice Activity Detection (VAD)
  startVAD(userId: string, stream: MediaStream): void
  // AnalyserNode polling at 100ms, RMS threshold > 0.01 = speaking
  // 200ms debounce before marking not-speaking
  // Calls voiceStore.setPeerSpeaking(userId, speaking)
}

export const audioService = new AudioService()
```

---

## 4. Screen Share

### Platform Decision Tree

```typescript
const isMacOS = navigator.platform.toLowerCase().includes('mac')

if (isMacOS) {
  // Primary: getDisplayMedia — works on macOS 12.3+
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
  } catch (e) {
    // Fallback: Rust CGDisplayStream (Phase 6 — see section 5)
    stream = await startRustCaptureStream()
  }
} else {
  // Windows / Linux: attempt custom picker via chromeMediaSourceId
  // ⚠ UNVERIFIED in WebView2 — test this at Phase 5; fall back to getDisplayMedia() if it fails
  try {
    const sources = await invoke<ScreenSource[]>('get_screen_sources')
    const selectedSource = await showScreenSharePicker(sources)
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // @ts-ignore — Chromium-specific
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: selectedSource.id,
          maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30,
        }
      }
    })
  } catch (e) {
    // Fallback: OS-native picker
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
  }
}

voiceStore.screenStream = stream
webrtcService.addScreenShareTrack(stream.getVideoTracks()[0])
signalingService.send({ type: 'screen_share_start', channelId: voiceStore.session!.channelId })
```

### Rust Screen Source Enumeration (`get_screen_sources`)

Windows implementation:
```rust
// EnumWindows → collect visible, non-minimised windows
// EnumDisplayMonitors → collect screens
// For each source: PrintWindow + BitBlt → 256×144 PNG thumbnail
// Source ID format: "window:HWND_VALUE" | "screen:MONITOR_INDEX"
```

macOS: returns empty `Vec` — `getDisplayMedia()` handles source selection natively.

### Track Injection

```typescript
// webrtcService.addScreenShareTrack(track):
for (const [userId, pc] of this.peers) {
  const sender = pc.getSenders().find(s => s.track?.kind === 'video')
  if (sender) sender.replaceTrack(track)       // replace existing video
  else pc.addTrack(track)                       // first video track
}
// On stop: replaceTrack(null) or removeTrack
```

---

## 5. macOS Rust-Side Capture Fallback (Phase 6, macOS < 12.3)

Only implement if `getDisplayMedia()` fails in testing on target macOS versions.

**Approach**:
1. Rust captures frames via `CGDisplayStream` (Core Graphics, available since macOS 10.8)
2. Encode frames as BGRA or MJPEG
3. Stream frames over a local WebSocket on `127.0.0.1:{random port}`
4. Frontend creates a `MediaStreamTrackGenerator` (Web Codecs API) and feeds frames in
5. Resulting track injected into WebRTC peer connections normally

**Rust crate**: `core-graphics` + manual `CGDisplayStreamCreateWithDispatchQueue` binding. Alternatively: `scap` crate (cross-platform capture, Phase 5c).

---

## 6. macOS Info.plist Requirements

Add to `tauri.conf.json` under `bundle > macOS > info_plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>HexField uses your camera for video calls.</string>
<key>NSMicrophoneUsageDescription</key>
<string>HexField uses your microphone for voice chat.</string>
<key>NSScreenCaptureUsageDescription</key>
<string>HexField uses screen capture for screen sharing.</string>
```

---

## 7. Linux Screen Share

- **X11**: `chromeMediaSourceId` supported same as Windows
- **Wayland**: requires `xdg-desktop-portal` package and `getDisplayMedia()` with `displaySurface` constraint
- Handle as known limitation in Phase 5; test on both

---

## 8. Mesh Scalability

Full P2P mesh of N participants = N×(N-1)/2 connections. Practical limit: ~8 concurrent voice users.

For larger rooms (future): SFU (Selective Forwarding Unit) on the rendezvous server. Signaling protocol in [spec 06-networking.md](06-networking.md) is SFU-compatible — only ICE negotiation changes. Explicit Phase 4+ enhancement.

---

## 9. UI Components

### VoiceBar.vue

Bottom strip, displayed when `voiceStore.session !== null`:

```
[🔇 Mute] [📹 Video] [🖥 Share] | 🟢 Alice  👤 Bob  👤 Charlie | [⛔ Disconnect]
```

- Speaking peers: animated ring on avatar
- Screen sharing peer: small preview thumbnail
- Self: own controls (mute/deafen/video toggle)

### ScreenSharePicker.vue (Windows custom path only)

- Grid of source thumbnails (256×144 PNG from Rust)
- Filter tabs: Windows / Screens
- Displayed when `get_screen_sources()` returns results and `chromeMediaSourceId` is confirmed working

---

## 10. Voice Loopback (Voice Feedback)

Allow users to hear their own mic output to verify audio settings without needing a second participant.

**Implementation:**
- `audioService.setLoopback(enabled: boolean)` — routes the local `MediaStream` track to a hidden `<audio>` element with a short delay (50ms via AudioContext delayNode) to break the feedback loop
- Toggle available in two places:
  - **VoiceBar controls**: small headphone-with-mic icon button (e.g., `mdiHeadset`) visible while in a voice session
  - **Settings > Voice tab**: persistent toggle "Hear my own voice" — useful for testing mic before joining a channel
- Must auto-disable when leaving voice channel

---

## 11. Voice Participants in Channel Sidebar

When users are connected to a voice channel, show them in the ChannelSidebar below the channel entry.

**Layout:**
```
VOICE CHANNELS
  🔊 General      🟢
    👤 Alice     (speaking ring when speaking)
    👤 Bob       🎤✗ (muted badge)
```

**Implementation:**
- `voiceStore.peers` map (already exists) — iterate for each connected voice channel
- Show local identity as first entry with `(You)` suffix
- Speaking indicator: 2px green border ring on the 24px avatar circle, animated with `pulse-ring` keyframes from `VoicePeerTile.vue`  
- Muted badge: small red `mdiMicrophoneOff` icon overlay (bottom-right corner of avatar)
- Avatar circle: initials from `serversStore.members[serverId][userId].displayName`

**Store requirements:**
- `voiceStore.peers` already tracks `audioEnabled`, `speaking` per peer
- Need to add local user's own entry to the sidebar display (not in `peers` which is remote-only)
- `voiceStore.session` provides `channelId` and `serverId`

---

## 12. Noise Suppression / Auto Levelling

Reduce background noise (fans, keyboard, ambient sound) before it is transmitted over WebRTC.

**Implementation options (in order of preference):**

1. **Browser built-in constraints (zero-cost):**
   ```typescript
   navigator.mediaDevices.getUserMedia({
     audio: {
       noiseSuppression: true,
       echoCancellation: true,
       autoGainControl: true,
       deviceId: selectedDeviceId,
     }
   })
   ```
   Already available in Chromium (WebView2/WKWebView). Apply these constraints in `voiceStore.joinVoiceChannel()`. This alone handles most background noise at no extra complexity cost.

2. **RNNoise / Krisp-style WebAssembly (Phase 6 enhancement):**
   If browser constraints are insufficient, pipe the mic stream through an AudioWorklet that runs `rnnoise-wasm` (open-source RNNoise compiled to WASM, ~80KB). The worklet outputs a processed stream used instead of the raw `getUserMedia` stream.
   - Library: `@jitsi/rnnoise-wasm` or compile from https://github.com/xiph/rnnoise
   - AudioWorklet registration via `audioContext.audioWorklet.addModule()`

**Settings toggle:** `Settings > Voice` — "Noise suppression" on/off (mapped to `settingsStore.settings.noiseSuppression: boolean`). When off, `getUserMedia` uses `noiseSuppression: false`.

---

## 13. Screen Share in Content Pane

When one or more peers are sharing their screen, display live video in the main content pane (`MainPane.vue`) instead of (or alongside) the chat.

### Layout modes

| Mode | Description |
|------|-------------|
| **Chat only** | No active screen shares |
| **Share focus** | One or more screens are active — content pane switches to `VoiceContentPane.vue` |
| **Grid view** | Multiple simultaneously active sharers shown in a grid |

### VoiceContentPane.vue

New component replacing `MainPane`'s inner content when `voiceStore.hasScreenShares` is true:

```
┌─────────────────────────────────────────────┐
│  [📺 Alice's screen]  [📺 Bob's screen]     │  ← grid of active sharers
│                                             │
│  [👁 hide]  [⛶ fullscreen]  [💬 chat]      │  ← per-tile controls
└─────────────────────────────────────────────┘
```

**Features:**
- Each active screen share renders in a `<video>` element with `srcObject = peer.screenStream`
- **Per-sharer hide toggle**: clicking a tile's hide button removes it from the grid (preference stored in `Set<userId>` reactive state, not persisted)
- **Non-video participant hide**: toggle to show only peers currently screen sharing (hides avatar tiles for non-sharing peers)
- **Focus tile**: clicking a tile expands it to fill the pane; sidebar hides tiles for others
- **Chat overlay**: a collapsible `MessageHistory` + `MessageInput` panel slides in from the right (like Discord's chat overlay during screen share)
- Local own screen share shows mirrored with a "Sharing" badge

**Store additions to `voiceStore`:**
```typescript
hasScreenShares: computed(() => 
  Object.values(peers.value).some(p => p.screenSharing) || !!screenStream.value
)
screenStreams: Map<userId, MediaStream>  // keyed by userId, populated by networkStore on remote track attach
```

**Track routing:** `networkStore.handleRemoteTrack()` already creates the `MediaStream`. Extend to:
- If the track is `kind === 'video'`, store in `voiceStore.screenStreams[userId]`
- When the peer's `screenSharing` flag is cleared, remove the entry

---

## 14. Video Quality & Bitrate Settings

Add to `Settings > Voice & Video` tab.

### New settings fields (`settingsStore`)

```typescript
interface VoiceVideoSettings {
  videoQuality: 'auto' | '360p' | '720p' | '1080p'
  videoBitrate:  'auto' | '500kbps' | '1mbps' | '2.5mbps' | '5mbps'
  frameRate: 10 | 15 | 30
}
```

### Enforcement

**On screen share start** (`voiceStore.startScreenShare()`):
```typescript
const constraints = buildVideoConstraints(settingsStore.settings.videoQuality, settingsStore.settings.frameRate)
// constraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
stream = await navigator.mediaDevices.getDisplayMedia({ video: constraints })
```

**RTCRtpSender bitrate cap** (after `addScreenShareTrack()`):
```typescript
const sender = pc.getSenders().find(s => s.track?.kind === 'video')
const params = sender.getParameters()
params.encodings[0].maxBitrate = parseBitrate(settingsStore.settings.videoBitrate) // bytes/s
await sender.setParameters(params)
```

---

## 15. User Profile Page

Clicking a user's avatar anywhere in the app (member list, sidebar, message header) opens a profile panel/modal.

### UserProfileModal.vue

**Content:**
- Avatar (initials circle, or future: uploaded photo)
- Display name + user ID (truncated)
- Server roles/badges (from `serversStore.members[serverId][userId]`)
- "View devices" — shows attested device list from `identityStore` (own profile only)
- "Adjust volume" slider (per-peer volume, stored in `voiceStore` / audioService)
- "Copy User ID" button

**Trigger points:**
- `self-avatar` in `ChannelSidebar` self-panel → own profile
- Member row in `MemberList.vue`
- Author avatar in `MessageBubble.vue`
- Voice peer tile in `VoicePeerTile.vue`

**State:** managed in `uiStore` — `openUserProfile(userId: string, serverId: string | null)`. When `userId === identityStore.userId`, show editable name/avatar; otherwise read-only with the volume control.

---

## 16. Custom User & Server Avatars (including Animated GIF)

### 16a. User Avatars
### Goal
Users can upload a static image or animated GIF as their avatar. The image is stored locally in SQLite and broadcast to peers so all users in a server see the custom avatar wherever avatars appear.

### Storage
- Key: `local_avatar_data` in the existing key-value store (`db_get_kv` / `db_set_kv`).
- Value: a base64 data URL (`data:image/png;base64,...` or `data:image/gif;base64,...`).
- Static images are canvas-downsampled to **128×128 px** before storage. GIFs are stored as-is with a hard cap of **512 KB** — larger uploads are rejected with a user-visible error.
- `identityStore.avatarDataUrl: ref<string | null>(null)` — loaded from `db_get_kv('local_avatar_data')` on startup.

### Upload flow (own profile in `UserProfileModal.vue`)
1. "Change Avatar" button opens a hidden `<input type="file" accept="image/*,.gif">`.
2. On selection, read as `ArrayBuffer` via `FileReader`.
3. If MIME type is `image/gif`: check byte size ≤ 512 KB → store as-is.
4. Otherwise: draw to an offscreen `<canvas>` sized 128×128 with `drawImage`, export as `image/png` at quality 0.92.
5. Call `identityStore.setAvatar(dataUrl)` which persists via `db_set_kv` and updates the reactive ref.
6. Broadcast a `profile_update` P2P mutation (see §16.4).

### Rendering avatars
Replace all existing "initials circle" avatar placeholders with a shared `<AvatarImage>` component:

```vue
<!-- src/components/AvatarImage.vue -->
<img v-if="src" :src="src" class="avatar-img" :class="{ gif: isGif, animate: alwaysAnimate }" />
<div v-else class="avatar-initials">{{ initials }}</div>
```

CSS rule to pause GIF animation by default and resume on hover or when `animate` class is set:

```css
.avatar-img.gif { animation-play-state: paused; }
.avatar-img.gif:hover,
.avatar-img.gif.animate { animation-play-state: running; }
```

> Note: Browsers don't expose CSS `animation-play-state` for GIF files natively. The actual technique is to swap between the data URL and a transparent pixel on `mouseenter`/`mouseleave` to freeze the GIF. The `<AvatarImage>` component should handle this via `@mouseenter`/`@mouseleave`.

**Locations that use `<AvatarImage>`:** `ChannelSidebar` self-panel, `MemberRow`, `MessageBubble`, `VoicePeerTile` peer tile avatar, `VoiceContentPane` self tile.

### P2P broadcast
Define a new mutation type `profile_update` (joins the existing mutation stream):

```ts
interface ProfileUpdatePayload {
  displayName?: string;
  avatarDataUrl?: string | null;
}
```

On receipt, call `serversStore.updateMemberProfile(serverId, userId, payload)` which updates `members.value[serverId][userId]` and triggers reactive re-renders everywhere the avatar is shown.

### 16b. Server Avatars

#### Goal
Each server has a configurable avatar image shown in `ServerRail` as the server icon. Currently the rail shows colored initials circles. Server avatars replace these with a user-uploaded image (static PNG/JPG) or short animated GIF.

#### Storage
- Key: `server_avatar_{serverId}` in the key-value store.
- Static images: canvas-downsampled to **64×64 px**, stored as PNG data URL.
- Animated GIFs: stored as-is, hard cap **256 KB**.
- `serversStore.servers[id].avatarDataUrl?: string` — loaded alongside server metadata on startup.

#### Upload flow
- Admin-only action via a new "Server Settings" modal (or extended invite/settings modal).
- File picker `accept="image/*,.gif"` → same Canvas downsample / GIF size-check as user avatars.
- Persisted via `db_set_kv` and replaces the initials circle in `ServerRail`.

#### Rendering in ServerRail
```vue
<img v-if="server.avatarDataUrl" :src="server.avatarDataUrl" class="server-icon-img" />
<span v-else class="server-initials">{{ getInitials(server.name) }}</span>
```

GIF animation: same hover-freeze technique as user avatars (swap `src` on `mouseenter`/`mouseleave`). GIF always animates when the server is the active server.

#### Broadcast
Server avatar is included in the existing `server_update` mutation broadcast as part of the server manifest. Peers receiving a `server_update` mutation with `avatarDataUrl` should store it locally and update `serversStore.servers[id].avatarDataUrl`.

---

## 17. User Presence & Status

### Status enum
```ts
type UserStatus = 'online' | 'idle' | 'dnd' | 'offline';
```

### Own status
- Persisted in `localStorage` under key `hexfield_own_status` (default `'online'`).
- **Already partially implemented** in `ChannelSidebar` — `ownStatus` ref, status dot, and context-menu picker were added in the Phase 5 UI polish pass.
- `setOwnStatus(s)` updates `ownStatus.value`, saves to localStorage, calls `serversStore.updateMemberStatus(serverId, userId, s)` for every joined server, and broadcasts a `presence_update` P2P message.

### Presence broadcast message
```ts
interface PresenceUpdate {
  type: 'presence_update';
  userId: string;
  status: UserStatus;
  timestamp: number; // ms since epoch
}
```

Sent over the existing data channel when status changes or when a new peer joins (so they receive current status immediately).

### Peer status display
- `ServerMember.status: UserStatus` field (add to `types/core.ts` and `serversStore`).
- `MemberRow.vue` renders a `.status-dot` (CSS already present) using the same colour scheme as the self-panel: online=`#3ba55d`, idle=`#faa61a`, dnd=`#ed4245`, offline=`#747f8d`.
- Status dot also shown on avatar in `VoicePeerTile`.

### Colorblind-friendly status indicator (accessibility)
Color alone is insufficient for users with red-green or blue-yellow color vision deficiencies. Each status must be distinguishable by **shape** as well as color.

Replace the plain circle dot with a small SVG icon per status. These map to well-established conventions (Discord-style) and are recognisable at 10–12 px:

| Status | Shape | Color |
|--------|-------|-------|
| `online` | Filled circle | `#3ba55d` |
| `idle` | Crescent / half-moon | `#faa61a` |
| `dnd` | Circle with horizontal bar (minus sign) | `#ed4245` |
| `offline` | Empty circle (hollow) | `#747f8d` |

**Implementation:** Create a tiny `<StatusBadge status="...">` component that renders the correct inline SVG at the requested size (default 10 px). Replace all `.status-dot` CSS-circle usages in `MemberRow`, `ChannelSidebar` self-panel, and `VoicePeerTile` with `<StatusBadge>`. The SVG paths are simple enough to inline (no icon library dependency needed for 4 shapes).

Also include a `title` attribute (e.g. `title="Online"`) on the badge element for screen-reader and tooltip support.

### Idle auto-detection (Phase 6 stretch)
Detect mouse/keyboard inactivity > 10 min → auto-set `idle`. Restore to `online` on activity. Implement as a composable `useIdleDetection()` registered globally in `App.vue`.

---

## 18. User Profile: Banners, Bio & Social Info

### Goal
Each user has an enriched profile card showing a banner, bio text, and (future) linked social handles. Users can view their own profile to edit it, and view others' profiles in read-only mode.

### Data model additions

```ts
// src/types/core.ts
interface ServerMember {
  // ... existing fields ...
  bio?: string;            // up to 200 characters
  bannerColor?: string;    // CSS gradient string or hex, e.g. "linear-gradient(135deg, #1a1a2e, #16213e)"
  bannerDataUrl?: string;  // optional uploaded image, base64, max 256×128 px, ≤256 KB
}
```

Store in the key-value table under keys `local_bio` and `local_banner_data`. Broadcast via `profile_update` mutation (same payload as §16.4 — extend `ProfileUpdatePayload` with `bio?` and `bannerDataUrl?`).

### `UserProfileModal.vue` layout

```
┌──────────────────────────────────────────────────┐
│  [Banner — gradient or image, 256×80 px strip]   │
│  [Avatar — 64px, overlaps bottom of banner]      │
│  Display Name          [Edit button if own]       │
│  @userId (truncated)                              │
│──────────────────────────────────────────────────│
│  Bio (up to 200 chars)                            │
│  ──────────────────────────────────────────────  │
│  [Voice Volume slider — if other user in voice]  │
│  [Block / Report — future]                       │
└──────────────────────────────────────────────────┘
```

### Banner
- **Own profile**: colour picker (6 preset gradients + custom hex) or image upload (≤ 256 KB, scaled to 512×200 px → stored at 256×100 px equivalent).
- **Others' profiles**: display their broadcast banner. Fall back to a gradient derived from the first byte of their userId for visual variety.
- No banner = default gradient from userId hash.

### Bio
- `<textarea maxlength="200">` in own-profile edit mode.
- Plain text only (no markdown). Displayed as a `<p>` on others' profiles.
- Shown in `MemberRow` tooltip (hover) as a truncated single line if set.

### Trigger & state
Same as §15 — `uiStore.openUserProfile(userId, serverId)`. The modal is already spec'd; these fields extend its content.

### P2P profile fetch
When a user clicks another user's profile and the profile data (bio, banner) has not yet been received via `profile_update` broadcast, send a `profile_request` P2P message to that peer. The recipient responds with a `profile_update` containing current profile data. This ensures profile data is available even for peers who haven't changed their profile during the current session.

