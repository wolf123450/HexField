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
<string>GameChat uses your camera for video calls.</string>
<key>NSMicrophoneUsageDescription</key>
<string>GameChat uses your microphone for voice chat.</string>
<key>NSScreenCaptureUsageDescription</key>
<string>GameChat uses screen capture for screen sharing.</string>
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
