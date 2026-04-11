# Rust-Native Screen Share (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Testing approach:** TDD — write failing tests first, then implement. After every 2–3 tasks, run the E2E smoke tests (`npm run test:e2e` or manually via `scripts/e2e-integration.mjs`) to verify nothing regressed. E2E tests are not part of the automated CI suite, but they catch integration breakage that unit tests miss.
>
> **Prerequisite:** Phase A (Rust-Native Audio) must be completed first. Phase A provides: `on_track()` callback in `WebRTCManager`, `MediaManager` struct in `AppState`, Tauri event infrastructure, and the `add_audio_track_to_all()` / renegotiation pattern that Phase B replicates for video.

**Goal:** Replace the broken screen share (no-op stubs in `webrtcService.ts`) with a pure-Rust screen capture pipeline: `xcap` captures screen/window frames → VP8 encode → `TrackLocalStaticSample` → WebRTC → peer. Received video: `on_track()` → RTP reassembly → VP8 decode → JPEG encode → write to temp file → Tauri event notification → JS renders via `asset://` protocol. No raw pixel data crosses the Tauri IPC boundary — JS only sends control commands (start/stop/pick source) and receives lightweight frame-ready notifications.

**Architecture:** The existing `MediaManager` (created in Phase A) gains screen capture methods. `xcap` provides cross-platform screen/window enumeration and continuous frame streaming via `VideoRecorder`. Captured BGRA frames are VP8-encoded and written to a `TrackLocalStaticSample` (video). The `WebRTCManager` gains `add_video_track_to_all()` / `remove_video_tracks_from_all()` methods, mirroring the audio track pattern from Phase A but using VP8 codec capability. On the receive side, Phase A's `on_track()` callback already fires for video tracks — the RTP drain loop is replaced with a `SampleBuilder` that reassembles complete VP8 frames. Each decoded frame is JPEG-compressed and written to `$APPDATA/video-frames/{peerId}.jpg`. A lightweight Tauri event (`media_video_frame`) notifies the frontend, which updates an `<img>` element's `src` via `convertFileSrc()` with a cache-busting query parameter. This replaces the `<video :srcObject>` approach that relied on browser `MediaStream` objects.

**Tech Stack:** `xcap` (screen/window capture), `libvpx-sys` or `vpx-encode` (VP8 encode/decode), `image` (JPEG encoding), `webrtc` 0.17 (`TrackLocalStaticSample`, `TrackRemote`, `SampleBuilder`), Tauri v2 events + asset protocol.

---

## Architecture Diagram

```
SENDING SIDE (local user shares screen)
─────────────────────────────────────────

  ┌─────────────────────────────────┐
  │  Source Picker Modal (Vue)      │
  │  Shows monitors + windows      │
  │  User selects one               │
  └──────────┬──────────────────────┘
             │ invoke('media_start_screen_share', { sourceId, ... })
             ▼
  ┌─────────────────────────────────┐
  │  MediaManager (Rust)            │
  │  1. xcap::Monitor/Window        │
  │  2. video_recorder().start()    │
  │  3. frame_receiver loop         │
  └──────────┬──────────────────────┘
             │ BGRA frames (in-process)
             ▼
  ┌─────────────────────────────────┐
  │  VP8 Encoder (Rust)             │
  │  BGRA → I420 → VP8 bitstream   │
  │  Respects quality/fps/bitrate   │
  └──────────┬──────────────────────┘
             │ Vec<u8> VP8 encoded frame
             ▼
  ┌─────────────────────────────────┐
  │  TrackLocalStaticSample (VP8)   │
  │  write_sample(Sample { data })  │
  │  webrtc-rs handles RTP packet-  │
  │  ization and transport          │
  └─────────────────────────────────┘
             │ RTP over DTLS/SRTP
             ▼
         ┌───────┐
         │ Peer  │
         └───────┘

RECEIVING SIDE (remote user views share)
─────────────────────────────────────────

         ┌───────┐
         │ Peer  │
         └───┬───┘
             │ RTP packets (VP8)
             ▼
  ┌─────────────────────────────────┐
  │  on_track() + TrackRemote       │
  │  track.read_rtp() loop          │
  │  SampleBuilder reassembles      │
  │  complete VP8 frames            │
  └──────────┬──────────────────────┘
             │ Complete VP8 frame bytes
             ▼
  ┌─────────────────────────────────┐
  │  VP8 Decoder (Rust)             │
  │  VP8 bitstream → raw RGBA      │
  └──────────┬──────────────────────┘
             │ RGBA pixel buffer
             ▼
  ┌─────────────────────────────────┐
  │  JPEG Encoder (Rust)            │
  │  RGBA → quality 75 JPEG        │
  │  Write to $APPDATA/video-       │
  │  frames/{peerId}.jpg            │
  └──────────┬──────────────────────┘
             │ emit('media_video_frame', { userId, frameNum })
             ▼
  ┌─────────────────────────────────┐
  │  VoiceContentPane (Vue)         │
  │  convertFileSrc(path) →         │
  │  asset://localhost/...?v=N      │
  │  <img :src="frameUrl"> updates  │
  └─────────────────────────────────┘
```

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src-tauri/Cargo.toml` | Modify | Add `xcap`, `libvpx-sys` (or `vpx-encode`), `image` dependencies |
| `src-tauri/src/media_manager.rs` | Modify | Screen/window enumeration, capture pipeline, VP8 encode/decode, frame delivery |
| `src-tauri/src/webrtc_manager.rs` | Modify | Add `add_video_track_to_all()` / `remove_video_tracks_from_all()`, `video_track` field on `PeerEntry`, upgrade `on_track()` drain loop to use `SampleBuilder` + VP8 decode |
| `src-tauri/src/commands/media_commands.rs` | Modify | Add `media_start_screen_share`, `media_stop_screen_share`, `media_enumerate_screens` commands |
| `src-tauri/src/lib.rs` | Modify | Register new commands in `invoke_handler![]` |
| `src/services/webrtcService.ts` | Modify | Replace `addScreenShareTrack` / `removeScreenShareTrack` no-op stubs with `invoke()` calls |
| `src/stores/voiceStore.ts` | Modify | Replace `startScreenShare()` `getDisplayMedia()` with `invoke('media_start_screen_share')`, replace `stopScreenShare()` with `invoke('media_stop_screen_share')`, replace `MediaStream` refs with frame URL refs |
| `src/stores/networkStore.ts` | Modify | Handle `media_video_frame` events, remove `handleRemoteTrack` video branch |
| `src/components/chat/VoiceContentPane.vue` | Modify | Replace `<video :srcObject>` with `<img :src>` fed by asset:// frame URLs |
| `src/components/modals/SourcePickerModal.vue` | Create | Source picker: shows available monitors and windows with preview thumbnails |
| `src/stores/uiStore.ts` | Modify | Add `openSourcePicker()` / `closeSourcePicker()` modal state |

---

## Event Contract

New Tauri events (**Rust → frontend**):

| Event name | Payload | When |
|---|---|---|
| `media_video_frame` | `{ userId: string, frameNumber: number, path: string }` | A new decoded video frame is ready for display |
| `media_screen_share_started` | `{ sourceId: string, sourceName: string }` | Screen capture successfully started |
| `media_screen_share_stopped` | `{}` | Screen capture stopped |
| `media_screen_share_error` | `{ error: string }` | Screen capture error (source lost, permission denied, etc.) |

Existing events that gain new behavior:

| Event name | Change |
|---|---|
| `webrtc_track` (from Phase A) | Now also fires for `kind: "video"` tracks; frontend uses this to know a peer started screen sharing |
| `webrtc_offer` / `webrtc_answer` | Now also carries video transceiver SDP when screen share is active |

---

## Dependency Research Summary

### `xcap` (screen/window capture)
- **Monitor enumeration**: `Monitor::all()` → `Vec<Monitor>` with `name()`, `width()`, `height()`, `id()`
- **Window enumeration**: `Window::all()` → `Vec<Window>` with `title()`, `app_name()`, `is_minimized()`, `width()`, `height()`
- **Screenshots**: `monitor.capture_image()` / `window.capture_image()` → `RgbaImage` (for thumbnails)
- **Video recording**: `monitor.video_recorder()` → `(VideoRecorder, Receiver<Frame>)` where `Frame { width, height, raw: Vec<u8> }` contains BGRA/RGBA pixel data
- **Control**: `video_recorder.start()` / `video_recorder.stop()`
- **Platforms**: DXGI (Windows), CoreGraphics (macOS), XCB (Linux)
- **Note**: `Window::video_recorder()` may not exist on all platforms — check at implementation time. Fallback: poll `Window::capture_image()` at desired FPS.

### VP8 Codec (encode/decode)
- **Primary option**: `libvpx-sys` — FFI bindings to Google's libvpx. Requires building libvpx from source or having it installed (`apt install libvpx-dev` / `brew install libvpx`).
- **Alternative 1**: `vpx-encode` crate — higher-level safe wrapper (if available and maintained).
- **Alternative 2**: `openh264` crate — H.264 instead of VP8. Clean Rust API, Cisco-licensed, builds from source. H.264 is also registered by webrtc-rs `register_default_codecs()`. Could be used as fallback if VP8 tooling proves problematic.
- **Color space**: xcap outputs BGRA; VP8 expects I420 (YUV 4:2:0). Need to convert BGRA → I420 before encoding.
- **Encoding params**: Keyframe interval ~2s (at 30fps = every 60 frames), target bitrate from user settings, realtime encoding preset.

### `webrtc` 0.17 — Video Track
- **Send**: `TrackLocalStaticSample::new(RTCRtpCodecCapability { mime_type: "video/VP8", clock_rate: 90000, .. }, "video0", "hexfield-screen")` — clock_rate 90000 is standard for video in RTP.
- **Write**: `track.write_sample(&Sample { data: vp8_frame_bytes.into(), duration: frame_duration })`.
- **Receive**: `TrackRemote::read_rtp()` returns individual RTP packets. Use `SampleBuilder` from `webrtc::media::io::sample_builder` to reassemble into complete VP8 frames.

### `image` crate (JPEG encoding)
- Already a transitive dependency of `xcap` — no new dep needed, just use `image::codecs::jpeg::JpegEncoder`.
- `JpegEncoder::new_with_quality(&mut buf, 75)` then `.encode(&rgba_pixels, width, height, ColorType::Rgba8)`.
- At 720p quality 75: ~50-80KB per frame. At 30fps = 1.5-2.4 MB/s disk I/O — easily manageable.

### Frame delivery via Tauri asset protocol
- Asset protocol is already enabled in `tauri.conf.json` with scope `$APPDATA/**`.
- `convertFileSrc(absolutePath)` → `asset://localhost/...` (macOS/Linux) or `https://asset.localhost/...` (Windows).
- JS updates `<img>` src with `?v={frameNumber}` cache buster to force reload.
- **Advantages**: Zero base64 overhead, browser fetches file directly, works on all platforms.
- **Note**: `<img>` with JPEG src is more universally compatible than `<canvas>` for this use case. Canvas can be added later for zoom/pan features.

---

## Task 1: Add Screen Share Dependencies to Cargo.toml

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add xcap and VP8 dependencies**

Add these under `[dependencies]` in `src-tauri/Cargo.toml`:

```toml
# Screen/window capture (cross-platform: DXGI, CoreGraphics, XCB)
xcap                = "0.5"

# VP8 video codec (encode captured frames, decode received frames)
# If `libvpx-sys` fails to build, switch to `openh264` for H.264 instead.
libvpx-sys          = { version = "0.7", features = ["build"] }

# Image encoding/decoding (JPEG for frame delivery) — may already be a
# transitive dep of xcap, but pin explicitly for direct use
image               = "0.25"
```

**Important**: The `libvpx-sys` crate with `features = ["build"]` compiles libvpx from source. This requires CMake and a C compiler. On CI, ensure `cmake` is installed. If this proves problematic:
- **Windows**: May need Visual Studio C++ build tools
- **macOS**: `brew install cmake libvpx`
- **Linux**: `apt install cmake libvpx-dev nasm`
- **Fallback**: Switch to `openh264` crate (pure Rust + C build, no system deps)

- [ ] **Step 2: Verify it compiles**

```bash
cd src-tauri && cargo check
```

Expected: Clean compile. If `libvpx-sys` fails, try alternatives in this order:
1. Install system libvpx: `apt install libvpx-dev` / `brew install libvpx`
2. Switch to `openh264 = "0.6"` (H.264 instead of VP8)
3. Use raw `vpx-sys` with manual FFI

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml
git commit -m "deps: add xcap, libvpx-sys, image for screen share"
```

---

## Task 2: Screen/Window Source Enumeration

**Files:**
- Modify: `src-tauri/src/media_manager.rs`
- Modify: `src-tauri/src/commands/media_commands.rs`

Enumerate available monitors and windows for the source picker UI.

- [ ] **Step 1: Write the source enumeration test**

In `media_manager.rs`, add to `#[cfg(test)]` block:

```rust
#[test]
fn test_enumerate_screens_returns_struct() {
    let mm = MediaManager::new();
    let sources = mm.enumerate_screens();
    // Should not panic; returns at least one monitor on any desktop OS
    // (CI may have zero if headless — test just checks struct validity)
    for src in &sources.monitors {
        assert!(!src.id.is_empty());
        assert!(!src.name.is_empty());
        assert!(src.width > 0);
        assert!(src.height > 0);
    }
    // Windows may be empty — just ensure the call completes
    let _ = sources.windows;
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src-tauri && cargo test test_enumerate_screens_returns_struct
```

Expected: Compile error — `enumerate_screens`, `ScreenSourceList`, etc. don't exist yet.

- [ ] **Step 3: Implement the source enumeration types and method**

Add to `media_manager.rs`:

```rust
use xcap::{Monitor, Window};

/// Information about a capturable screen source
#[derive(Clone, Debug, serde::Serialize)]
pub struct ScreenSourceInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// "monitor" or "window"
    pub source_type: String,
    /// Base64 JPEG thumbnail (small, for the picker UI)
    pub thumbnail: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ScreenSourceList {
    pub monitors: Vec<ScreenSourceInfo>,
    pub windows: Vec<ScreenSourceInfo>,
}

impl MediaManager {
    /// List available monitors and windows for screen sharing.
    /// Includes small JPEG thumbnails for the picker UI.
    pub fn enumerate_screens(&self) -> ScreenSourceList {
        let monitors = Monitor::all()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .map(|(i, m)| {
                let name = m.name().unwrap_or_else(|_| format!("Monitor {}", i + 1));
                let width = m.width().unwrap_or(0);
                let height = m.height().unwrap_or(0);
                let thumbnail = Self::capture_thumbnail_monitor(&m);
                ScreenSourceInfo {
                    id: format!("monitor:{i}"),
                    name,
                    width,
                    height,
                    source_type: "monitor".to_string(),
                    thumbnail,
                }
            })
            .collect();

        let windows = Window::all()
            .unwrap_or_default()
            .into_iter()
            .filter(|w| !w.is_minimized().unwrap_or(true))
            .enumerate()
            .map(|(i, w)| {
                let title = w.title().unwrap_or_else(|_| "Untitled".to_string());
                let app = w.app_name().unwrap_or_else(|_| "Unknown".to_string());
                let width = w.width().unwrap_or(0);
                let height = w.height().unwrap_or(0);
                let name = if title.is_empty() { app.clone() } else { format!("{app} — {title}") };
                let thumbnail = Self::capture_thumbnail_window(&w);
                ScreenSourceInfo {
                    id: format!("window:{i}"),
                    name,
                    width,
                    height,
                    source_type: "window".to_string(),
                    thumbnail,
                }
            })
            .collect();

        ScreenSourceList { monitors, windows }
    }

    /// Capture a small JPEG thumbnail of a monitor for the picker UI.
    fn capture_thumbnail_monitor(monitor: &Monitor) -> Option<String> {
        let img = monitor.capture_image().ok()?;
        Self::rgba_to_thumbnail_b64(&img)
    }

    /// Capture a small JPEG thumbnail of a window for the picker UI.
    fn capture_thumbnail_window(window: &Window) -> Option<String> {
        let img = window.capture_image().ok()?;
        Self::rgba_to_thumbnail_b64(&img)
    }

    /// Resize an RGBA image to a small thumbnail and encode as base64 JPEG.
    fn rgba_to_thumbnail_b64(img: &image::RgbaImage) -> Option<String> {
        use image::imageops::FilterType;
        // Resize to max 320px wide, preserving aspect ratio
        let thumb = image::imageops::resize(
            img,
            320,
            (320 * img.height() / img.width().max(1)),
            FilterType::Triangle,
        );
        let mut buf = Vec::new();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 60);
        image::DynamicImage::ImageRgba8(thumb)
            .write_with_encoder(encoder)
            .ok()?;
        use base64::Engine;
        Some(base64::engine::general_purpose::STANDARD.encode(&buf))
    }
}
```

- [ ] **Step 4: Add the Tauri command**

In `src-tauri/src/commands/media_commands.rs`, add:

```rust
#[tauri::command]
pub async fn media_enumerate_screens(
    state: tauri::State<'_, AppState>,
) -> Result<ScreenSourceList, String> {
    Ok(state.media_manager.enumerate_screens())
}
```

Register in `lib.rs`'s `invoke_handler![]`.

- [ ] **Step 5: Run test + verify compile**

```bash
cd src-tauri && cargo test test_enumerate_screens_returns_struct
cd src-tauri && cargo check
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(media): screen/window source enumeration with thumbnails"
```

---

## Task 3: Add Video Track Management to WebRTCManager

**Files:**
- Modify: `src-tauri/src/webrtc_manager.rs`

Mirror the audio track pattern from Phase A for video. Add `video_track` field to `PeerEntry`, and `add_video_track_to_all()` / `remove_video_tracks_from_all()` methods.

- [ ] **Step 1: Add `video_track` field to `PeerEntry`**

```rust
struct PeerEntry {
    pc: Arc<RTCPeerConnection>,
    dc: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
    remote_desc_ready: Arc<AtomicBool>,
    being_replaced: Arc<AtomicBool>,
    /// Local audio track attached to this peer (Phase A)
    audio_track: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
    /// Local video track attached to this peer (screen share)
    video_track: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
}
```

Update all `PeerEntry` construction sites to include `video_track: Arc::new(Mutex::new(None))`.

- [ ] **Step 2: Implement `add_video_track_to_all()`**

```rust
/// Add a VP8 video track to all connected peers and trigger renegotiation.
/// Returns the shared `TrackLocalStaticSample` that the caller writes VP8 frames to.
pub async fn add_video_track_to_all(
    &self,
    app: &AppHandle,
) -> Result<Arc<TrackLocalStaticSample>, String> {
    use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;

    let video_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: "video/VP8".to_owned(),
            clock_rate: 90000,
            ..Default::default()
        },
        "video0".to_owned(),
        "hexfield-screen".to_owned(),
    ));

    let mut peers = self.peers.lock().await;
    for (peer_id, entry) in peers.iter_mut() {
        entry
            .pc
            .add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| format!("add_video_track failed for {peer_id}: {e}"))?;

        *entry.video_track.lock().await = Some(Arc::clone(&video_track));

        // Renegotiate with new video transceiver
        let offer = entry.pc.create_offer(None).await
            .map_err(|e| format!("video renegotiation create_offer failed for {peer_id}: {e}"))?;
        entry.pc.set_local_description(offer.clone()).await
            .map_err(|e| format!("video renegotiation set_local failed for {peer_id}: {e}"))?;

        let _ = app.emit("webrtc_offer", OfferEvent { to: peer_id.clone(), sdp: offer.sdp });
    }

    Ok(video_track)
}

/// Remove video tracks from all peers and trigger renegotiation.
pub async fn remove_video_tracks_from_all(&self, app: &AppHandle) -> Result<(), String> {
    let mut peers = self.peers.lock().await;
    for (peer_id, entry) in peers.iter_mut() {
        *entry.video_track.lock().await = None;

        let senders = entry.pc.get_senders().await;
        for sender in senders {
            if let Some(track) = sender.track().await {
                if track.kind() == webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Video {
                    entry.pc.remove_track(&sender).await
                        .map_err(|e| format!("remove_video_track failed for {peer_id}: {e}"))?;
                }
            }
        }

        let offer = entry.pc.create_offer(None).await
            .map_err(|e| format!("video renegotiation failed for {peer_id}: {e}"))?;
        entry.pc.set_local_description(offer.clone()).await
            .map_err(|e| format!("video set_local failed for {peer_id}: {e}"))?;
        let _ = app.emit("webrtc_offer", OfferEvent { to: peer_id.clone(), sdp: offer.sdp });
    }
    Ok(())
}
```

- [ ] **Step 3: Verify compile**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/webrtc_manager.rs
git commit -m "feat(webrtc): add/remove video tracks with SDP renegotiation"
```

---

## Task 4: VP8 Encode/Decode Helpers

**Files:**
- Create: `src-tauri/src/video_codec.rs` (or add to `media_manager.rs`)

Implement thin safe wrappers around `libvpx-sys` for VP8 encoding and decoding, plus BGRA → I420 color space conversion.

- [ ] **Step 1: Write the VP8 round-trip test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vp8_encode_decode_roundtrip() {
        let width = 320;
        let height = 240;

        // Generate a test BGRA frame (simple gradient)
        let mut bgra = vec![0u8; (width * height * 4) as usize];
        for y in 0..height {
            for x in 0..width {
                let idx = ((y * width + x) * 4) as usize;
                bgra[idx]     = (x & 0xFF) as u8;     // B
                bgra[idx + 1] = (y & 0xFF) as u8;     // G
                bgra[idx + 2] = 128;                   // R
                bgra[idx + 3] = 255;                   // A
            }
        }

        let mut encoder = Vp8Encoder::new(width, height, 500_000).expect("encoder");
        let encoded = encoder.encode_bgra(&bgra, true).expect("encode");
        assert!(!encoded.is_empty(), "encoded frame should not be empty");
        assert!(encoded.len() < bgra.len(), "VP8 should compress");

        let mut decoder = Vp8Decoder::new().expect("decoder");
        let decoded = decoder.decode(&encoded).expect("decode");
        assert_eq!(decoded.width, width);
        assert_eq!(decoded.height, height);
        assert_eq!(decoded.rgba.len(), (width * height * 4) as usize);
        // Lossy codec — just verify non-zero and correct size
        let nonzero = decoded.rgba.iter().filter(|&&b| b != 0).count();
        assert!(nonzero > decoded.rgba.len() / 2, "decoded should have content");
    }

    #[test]
    fn test_bgra_to_i420_dimensions() {
        let width = 4;
        let height = 4;
        let bgra = vec![128u8; (width * height * 4) as usize];
        let i420 = bgra_to_i420(&bgra, width, height);
        // I420: Y = w*h, U = w*h/4, V = w*h/4 = w*h * 1.5
        assert_eq!(i420.len(), (width * height * 3 / 2) as usize);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src-tauri && cargo test test_vp8_encode_decode_roundtrip
```

- [ ] **Step 3: Implement BGRA → I420 color space conversion**

```rust
/// Convert BGRA pixel buffer to I420 (YUV 4:2:0) for VP8 encoding.
/// Input: BGRA with width × height × 4 bytes.
/// Output: I420 with width × height × 3/2 bytes (Y plane + U plane + V plane).
pub fn bgra_to_i420(bgra: &[u8], width: u32, height: u32) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let mut y_plane = vec![0u8; w * h];
    let mut u_plane = vec![0u8; (w / 2) * (h / 2)];
    let mut v_plane = vec![0u8; (w / 2) * (h / 2)];

    for row in 0..h {
        for col in 0..w {
            let idx = (row * w + col) * 4;
            let b = bgra[idx] as f32;
            let g = bgra[idx + 1] as f32;
            let r = bgra[idx + 2] as f32;

            // BT.601 conversion
            let y = (0.299 * r + 0.587 * g + 0.114 * b).clamp(0.0, 255.0) as u8;
            y_plane[row * w + col] = y;

            // Subsample U and V at 2×2 blocks
            if row % 2 == 0 && col % 2 == 0 {
                let u = (-0.169 * r - 0.331 * g + 0.500 * b + 128.0).clamp(0.0, 255.0) as u8;
                let v = (0.500 * r - 0.419 * g - 0.081 * b + 128.0).clamp(0.0, 255.0) as u8;
                let uv_idx = (row / 2) * (w / 2) + col / 2;
                u_plane[uv_idx] = u;
                v_plane[uv_idx] = v;
            }
        }
    }

    let mut i420 = Vec::with_capacity(w * h * 3 / 2);
    i420.extend_from_slice(&y_plane);
    i420.extend_from_slice(&u_plane);
    i420.extend_from_slice(&v_plane);
    i420
}
```

- [ ] **Step 4: Implement VP8 Encoder and Decoder**

The exact implementation depends on which crate is used. If `libvpx-sys`:

```rust
pub struct Vp8Encoder {
    // libvpx context, configuration, etc.
    // Implementation depends on the chosen crate's API
}

impl Vp8Encoder {
    pub fn new(width: u32, height: u32, bitrate_bps: u32) -> Result<Self, String> {
        // Initialize libvpx encoder with VP8 codec
        // Set realtime encoding preset for low latency
        // Configure keyframe interval, error resilience
        todo!("Implement with chosen VP8 crate")
    }

    /// Encode a BGRA frame to VP8.
    /// `keyframe` forces a keyframe (intra frame) if true.
    pub fn encode_bgra(&mut self, bgra: &[u8], keyframe: bool) -> Result<Vec<u8>, String> {
        let i420 = bgra_to_i420(bgra, self.width, self.height);
        self.encode_i420(&i420, keyframe)
    }

    fn encode_i420(&mut self, i420: &[u8], keyframe: bool) -> Result<Vec<u8>, String> {
        todo!("Feed I420 data to libvpx encoder, retrieve compressed VP8 packet")
    }
}

pub struct Vp8Decoder {
    // libvpx decoder context
}

pub struct DecodedFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Vp8Decoder {
    pub fn new() -> Result<Self, String> {
        todo!("Initialize libvpx VP8 decoder")
    }

    /// Decode a VP8 frame to RGBA pixels.
    pub fn decode(&mut self, data: &[u8]) -> Result<DecodedFrame, String> {
        // Feed VP8 data to decoder
        // Get I420 output
        // Convert I420 → RGBA
        todo!("Decode VP8 + convert to RGBA")
    }
}
```

**Implementation note:** The exact `libvpx-sys` FFI calls are verbose — look up the libvpx C API: `vpx_codec_enc_init`, `vpx_codec_encode`, `vpx_codec_get_cx_data` for encoding; `vpx_codec_dec_init`, `vpx_codec_decode`, `vpx_codec_get_frame` for decoding. If this is too difficult, consider the `openh264` crate which has a cleaner Rust API:

```rust
// openh264 alternative (H.264 instead of VP8):
use openh264::encoder::{Encoder, EncoderConfig};
use openh264::decoder::Decoder;
```

If switching to H.264, update the `TrackLocalStaticSample` MIME type from `"video/VP8"` to `"video/H264"` in Task 3.

- [ ] **Step 5: Run tests**

```bash
cd src-tauri && cargo test test_vp8
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(media): VP8 encode/decode with BGRA↔I420 conversion"
```

---

## Task 5: Screen Capture Pipeline (xcap → VP8 → WebRTC)

**Files:**
- Modify: `src-tauri/src/media_manager.rs`
- Modify: `src-tauri/src/webrtc_manager.rs`

Wire xcap's video recorder to the VP8 encoder and WebRTC video track.

- [ ] **Step 1: Add screen capture state to MediaManager**

```rust
pub struct MediaManager {
    // ... existing audio fields from Phase A ...

    /// Active screen capture handle (keeps video_recorder alive)
    screen_recorder: Arc<Mutex<Option<xcap::VideoRecorder>>>,
    /// Screen capture → encode → WebRTC task
    screen_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// The shared video track being written to (if screen share active)
    video_track: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
    /// Whether screen share is currently active
    screen_active: Arc<AtomicBool>,
}
```

- [ ] **Step 2: Implement `start_screen_share()`**

```rust
impl MediaManager {
    /// Start sharing a screen or window.
    ///
    /// `source_id`: "monitor:0", "monitor:1", "window:3", etc.
    /// `video_track`: from WebRTCManager::add_video_track_to_all()
    /// `fps`: target frames per second
    /// `bitrate_kbps`: target bitrate (0 = auto)
    pub async fn start_screen_share(
        &self,
        source_id: &str,
        video_track: Arc<TrackLocalStaticSample>,
        app: tauri::AppHandle,
        fps: u32,
        bitrate_kbps: u32,
    ) -> Result<(), String> {
        if self.screen_active.load(Ordering::Acquire) {
            return Err("screen share already active".into());
        }

        // Parse source_id
        let (source_type, index) = source_id
            .split_once(':')
            .ok_or("invalid source_id format")?;
        let index: usize = index.parse().map_err(|e: std::num::ParseIntError| e.to_string())?;

        // Get the VideoRecorder for the selected source
        let (recorder, frame_rx) = match source_type {
            "monitor" => {
                let monitors = Monitor::all().map_err(|e| e.to_string())?;
                let monitor = monitors
                    .into_iter()
                    .nth(index)
                    .ok_or("monitor index out of range")?;
                monitor.video_recorder().map_err(|e| e.to_string())?
            }
            // Window video_recorder may not be available on all platforms;
            // fall back to polling capture_image() if needed
            _ => return Err(format!("unsupported source type: {source_type}")),
        };

        recorder.start().map_err(|e| e.to_string())?;
        *self.screen_recorder.lock().await = Some(recorder);
        *self.video_track.lock().await = Some(video_track.clone());
        self.screen_active.store(true, Ordering::Release);

        let frame_duration = std::time::Duration::from_millis(1000 / fps.max(1) as u64);
        let screen_active = self.screen_active.clone();
        let bitrate_bps = if bitrate_kbps > 0 {
            bitrate_kbps * 1000
        } else {
            1_000_000 // 1 Mbps default
        };

        // Spawn the capture → encode → write loop
        let task = tokio::task::spawn_blocking(move || {
            // Encoder will be initialized on first frame (to learn dimensions)
            let mut encoder: Option<Vp8Encoder> = None;
            let mut frame_count: u64 = 0;
            let keyframe_interval = fps.max(1) as u64 * 2; // Keyframe every 2 seconds

            while screen_active.load(Ordering::Acquire) {
                match frame_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                    Ok(frame) => {
                        let w = frame.width;
                        let h = frame.height;

                        // Initialize encoder on first frame or dimension change
                        if encoder.is_none() {
                            encoder = Some(
                                Vp8Encoder::new(w, h, bitrate_bps)
                                    .expect("VP8 encoder init"),
                            );
                        }

                        let enc = encoder.as_mut().unwrap();
                        let is_keyframe = frame_count % keyframe_interval == 0;

                        match enc.encode_bgra(&frame.raw, is_keyframe) {
                            Ok(vp8_data) => {
                                // Write to WebRTC track (blocking on tokio runtime)
                                let vt = video_track.clone();
                                let dur = frame_duration;
                                // Use a one-shot runtime to call the async write_sample
                                let rt = tokio::runtime::Handle::current();
                                let _ = rt.block_on(async {
                                    vt.write_sample(&webrtc::media::Sample {
                                        data: bytes::Bytes::from(vp8_data),
                                        duration: dur,
                                        ..Default::default()
                                    })
                                    .await
                                });
                            }
                            Err(e) => {
                                log::warn!("[media] VP8 encode error: {e}");
                            }
                        }

                        frame_count += 1;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        *self.screen_task.lock().await = Some(task);

        let _ = app.emit(
            "media_screen_share_started",
            serde_json::json!({ "sourceId": source_id }),
        );

        Ok(())
    }

    /// Stop sharing screen.
    pub async fn stop_screen_share(&self, app: &tauri::AppHandle) -> Result<(), String> {
        self.screen_active.store(false, Ordering::Release);

        if let Some(recorder) = self.screen_recorder.lock().await.take() {
            let _ = recorder.stop();
        }

        if let Some(task) = self.screen_task.lock().await.take() {
            // Give the task a moment to finish
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
        }

        *self.video_track.lock().await = None;

        let _ = app.emit("media_screen_share_stopped", serde_json::json!({}));
        Ok(())
    }
}
```

- [ ] **Step 3: Verify compile**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(media): screen capture pipeline (xcap → VP8 → WebRTC)"
```

---

## Task 6: Video Receive Pipeline (WebRTC → VP8 Decode → Frame Delivery)

**Files:**
- Modify: `src-tauri/src/webrtc_manager.rs`
- Modify: `src-tauri/src/media_manager.rs`

Replace the empty RTP drain loop in `on_track()` (from Phase A) with actual VP8 decoding and frame delivery.

- [ ] **Step 1: Add frame output directory setup**

In `media_manager.rs`:

```rust
impl MediaManager {
    /// Get (and create if needed) the directory for decoded video frames.
    pub fn frame_output_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("video-frames");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }
}
```

- [ ] **Step 2: Upgrade the `on_track()` video handler**

In `webrtc_manager.rs`, replace the RTP drain loop spawned in `on_track()` (Phase A Task 3) for video tracks:

```rust
// Inside the on_track callback, after identifying kind == "video":
if kind == "video" {
    let peer_id = pid2.clone();
    let app3 = app2.clone();

    tokio::spawn(async move {
        let frame_dir = match MediaManager::frame_output_dir(&app3) {
            Ok(d) => d,
            Err(e) => {
                log::error!("[webrtc] failed to get frame dir: {e}");
                return;
            }
        };
        let frame_path = frame_dir.join(format!("{peer_id}.jpg"));
        let mut decoder = match Vp8Decoder::new() {
            Ok(d) => d,
            Err(e) => {
                log::error!("[webrtc] VP8 decoder init failed: {e}");
                return;
            }
        };

        // SampleBuilder reassembles RTP packets into complete VP8 frames
        use webrtc::media::io::sample_builder::SampleBuilder;
        // VP8 depacketizer
        let depacketizer = Box::new(webrtc::rtp::codecs::vp8::Vp8Packet::default());
        let mut sample_builder = SampleBuilder::new(64, depacketizer, 90000);

        let mut frame_number: u64 = 0;

        loop {
            match track_clone.read_rtp().await {
                Ok((pkt, _attr)) => {
                    sample_builder.push(pkt);

                    while let Some(sample) = sample_builder.pop() {
                        match decoder.decode(&sample.data) {
                            Ok(decoded) => {
                                // Encode as JPEG and write to temp file
                                if let Err(e) = Self::write_jpeg_frame(
                                    &decoded.rgba,
                                    decoded.width,
                                    decoded.height,
                                    &frame_path,
                                ) {
                                    log::warn!("[webrtc] JPEG write error: {e}");
                                    continue;
                                }

                                frame_number += 1;
                                let _ = app3.emit(
                                    "media_video_frame",
                                    serde_json::json!({
                                        "userId": peer_id,
                                        "frameNumber": frame_number,
                                        "path": frame_path.to_string_lossy(),
                                    }),
                                );
                            }
                            Err(e) => {
                                log::debug!("[webrtc] VP8 decode error (transient): {e}");
                            }
                        }
                    }
                }
                Err(e) => {
                    log::debug!("[webrtc] video track read ended for {peer_id}: {e}");
                    break;
                }
            }
        }

        // Clean up frame file when track ends
        let _ = std::fs::remove_file(&frame_path);
        let _ = app3.emit(
            "media_video_frame_ended",
            serde_json::json!({ "userId": peer_id }),
        );
    });
}
```

- [ ] **Step 3: Implement `write_jpeg_frame` helper**

```rust
impl WebRTCManager {
    fn write_jpeg_frame(
        rgba: &[u8],
        width: u32,
        height: u32,
        path: &std::path::Path,
    ) -> Result<(), String> {
        use image::codecs::jpeg::JpegEncoder;
        use std::io::BufWriter;

        // Write to a temp file first, then rename (atomic on most OSes)
        let tmp = path.with_extension("tmp");
        let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut writer = BufWriter::new(file);

        let encoder = JpegEncoder::new_with_quality(&mut writer, 75);
        image::DynamicImage::ImageRgba8(
            image::RgbaImage::from_raw(width, height, rgba.to_vec())
                .ok_or("invalid RGBA dimensions")?,
        )
        .write_with_encoder(encoder)
        .map_err(|e| e.to_string())?;

        drop(writer);
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    }
}
```

- [ ] **Step 4: Verify compile**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(webrtc): video receive pipeline with VP8 decode + JPEG delivery"
```

---

## Task 7: Tauri Commands for Screen Share Control

**Files:**
- Modify: `src-tauri/src/commands/media_commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `media_start_screen_share` command**

```rust
#[tauri::command]
pub async fn media_start_screen_share(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    source_id: String,
    fps: Option<u32>,
    bitrate_kbps: Option<u32>,
) -> Result<(), String> {
    // First, add video track to all peers
    let video_track = state
        .webrtc_manager
        .add_video_track_to_all(&app)
        .await?;

    // Then start capture pipeline
    state
        .media_manager
        .start_screen_share(
            &source_id,
            video_track,
            app,
            fps.unwrap_or(30),
            bitrate_kbps.unwrap_or(0),
        )
        .await
}

#[tauri::command]
pub async fn media_stop_screen_share(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.media_manager.stop_screen_share(&app).await?;
    state.webrtc_manager.remove_video_tracks_from_all(&app).await
}
```

- [ ] **Step 2: Register commands in `lib.rs`**

Add `media_start_screen_share`, `media_stop_screen_share`, `media_enumerate_screens` to the `invoke_handler![]` list.

- [ ] **Step 3: Verify compile**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 4: E2E checkpoint — run smoke tests**

```bash
npm run build && cd src-tauri && cargo check
```

Verify no regressions. If available, run E2E smoke tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(media): Tauri commands for screen share start/stop/enumerate"
```

---

## Task 8: Source Picker Modal UI

**Files:**
- Create: `src/components/modals/SourcePickerModal.vue`
- Modify: `src/stores/uiStore.ts`

Build a custom source picker that replaces the browser's native `getDisplayMedia()` picker.

- [ ] **Step 1: Add modal state to uiStore**

In `uiStore.ts`:

```ts
const sourcePickerOpen = ref(false)
const sourcePickerResolve = ref<((sourceId: string | null) => void) | null>(null)

function openSourcePicker(): Promise<string | null> {
  return new Promise(resolve => {
    sourcePickerResolve.value = resolve
    sourcePickerOpen.value = true
  })
}

function closeSourcePicker(sourceId: string | null = null) {
  sourcePickerResolve.value?.(sourceId)
  sourcePickerResolve.value = null
  sourcePickerOpen.value = false
}
```

Export `sourcePickerOpen`, `openSourcePicker`, `closeSourcePicker`.

- [ ] **Step 2: Create SourcePickerModal.vue**

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useUIStore } from '@/stores/uiStore'
import { mdiMonitor, mdiApplicationOutline, mdiClose } from '@mdi/js'

interface ScreenSource {
  id: string
  name: string
  width: number
  height: number
  source_type: string
  thumbnail: string | null
}

interface ScreenSourceList {
  monitors: ScreenSource[]
  windows: ScreenSource[]
}

const uiStore = useUIStore()
const sources = ref<ScreenSourceList>({ monitors: [], windows: [] })
const loading = ref(true)
const activeTab = ref<'monitors' | 'windows'>('monitors')

onMounted(async () => {
  try {
    sources.value = await invoke<ScreenSourceList>('media_enumerate_screens')
  } catch (e) {
    console.error('[SourcePicker] enumerate failed:', e)
  } finally {
    loading.value = false
  }
})

function select(sourceId: string) {
  uiStore.closeSourcePicker(sourceId)
}

function cancel() {
  uiStore.closeSourcePicker(null)
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="cancel">
      <div class="source-picker">
        <div class="picker-header">
          <h2>Share Your Screen</h2>
          <button class="close-btn" @click="cancel">
            <AppIcon :path="mdiClose" :size="20" />
          </button>
        </div>

        <div class="tab-bar">
          <button
            :class="{ active: activeTab === 'monitors' }"
            @click="activeTab = 'monitors'"
          >
            <AppIcon :path="mdiMonitor" :size="16" />
            Screens ({{ sources.monitors.length }})
          </button>
          <button
            :class="{ active: activeTab === 'windows' }"
            @click="activeTab = 'windows'"
          >
            <AppIcon :path="mdiApplicationOutline" :size="16" />
            Windows ({{ sources.windows.length }})
          </button>
        </div>

        <div v-if="loading" class="loading">Detecting sources…</div>

        <div v-else class="source-grid">
          <div
            v-for="src in (activeTab === 'monitors' ? sources.monitors : sources.windows)"
            :key="src.id"
            class="source-card"
            @click="select(src.id)"
          >
            <div class="thumb-wrapper">
              <img
                v-if="src.thumbnail"
                :src="'data:image/jpeg;base64,' + src.thumbnail"
                :alt="src.name"
                class="thumb"
              />
              <div v-else class="thumb placeholder">
                <AppIcon :path="activeTab === 'monitors' ? mdiMonitor : mdiApplicationOutline" :size="48" />
              </div>
            </div>
            <div class="source-label">{{ src.name }}</div>
            <div class="source-dims">{{ src.width }}×{{ src.height }}</div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Styles use CSS custom properties from global.css */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.source-picker {
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  width: min(800px, 90vw);
  max-height: 80vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-md) var(--spacing-lg);
  border-bottom: 1px solid var(--border-color);
}

.picker-header h2 {
  margin: 0;
  font-size: 1.1rem;
  color: var(--text-primary);
}

.close-btn {
  padding: 0;
  transform: none;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.tab-bar {
  display: flex;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-lg);
  border-bottom: 1px solid var(--border-color);
}

.tab-bar button {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  transform: none;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.875rem;
}

.tab-bar button.active {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.loading {
  padding: var(--spacing-xl);
  text-align: center;
  color: var(--text-secondary);
}

.source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  overflow-y: auto;
}

.source-card {
  cursor: pointer;
  border-radius: var(--radius-md);
  border: 2px solid transparent;
  padding: var(--spacing-sm);
  transition: border-color 0.15s, background 0.15s;
}

.source-card:hover {
  border-color: var(--accent-color);
  background: var(--bg-tertiary);
}

.thumb-wrapper {
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-primary);
}

.thumb {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.thumb.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}

.source-label {
  margin-top: var(--spacing-xs);
  font-size: 0.8125rem;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-dims {
  font-size: 0.75rem;
  color: var(--text-tertiary);
}
</style>
```

- [ ] **Step 3: Wire modal in App.vue**

Add `<SourcePickerModal v-if="uiStore.sourcePickerOpen" />` alongside other modals.

- [ ] **Step 4: Verify frontend build**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ui): source picker modal for screen share"
```

---

## Task 9: Replace voiceStore Screen Share Methods

**Files:**
- Modify: `src/stores/voiceStore.ts`
- Modify: `src/services/webrtcService.ts`

- [ ] **Step 1: Replace `addScreenShareTrack` / `removeScreenShareTrack` stubs in webrtcService.ts**

```ts
async addScreenShareTrack(sourceId: string, fps?: number, bitrateKbps?: number): Promise<void> {
  await invoke('media_start_screen_share', {
    sourceId,
    fps: fps ?? 30,
    bitrateKbps: bitrateKbps ?? 0,
  })
}

async removeScreenShareTrack(): Promise<void> {
  await invoke('media_stop_screen_share')
}
```

Note: the method signatures change — `addScreenShareTrack` now takes `sourceId` (string) instead of `MediaStreamTrack`. All callers must be updated.

- [ ] **Step 2: Replace `startScreenShare()` in voiceStore.ts**

Replace the `getDisplayMedia()` flow with the source picker + Rust invocation:

```ts
async function startScreenShare(): Promise<void> {
  const { useUIStore } = await import('./uiStore')
  const uiStore = useUIStore()

  // Open source picker and wait for user selection
  const sourceId = await uiStore.openSourcePicker()
  if (!sourceId) return // User cancelled

  const { useSettingsStore } = await import('./settingsStore')
  const settings = useSettingsStore().settings

  const bitrateMap: Record<string, number | undefined> = {
    'auto': undefined, '500kbps': 500, '1mbps': 1000, '2.5mbps': 2500, '5mbps': 5000,
  }
  const maxBitrateKbps = bitrateMap[settings.videoBitrate]

  await webrtcService.addScreenShareTrack(
    sourceId,
    settings.videoFrameRate,
    maxBitrateKbps,
  )

  // screenStream is no longer a MediaStream — mark sharing as active via a flag
  screenShareActive.value = true

  const { useNetworkStore } = await import('./networkStore')
  useNetworkStore().broadcast({
    type:      'voice_screen_share_start',
    channelId: session.value?.channelId,
  })
}
```

- [ ] **Step 3: Replace `stopScreenShare()` in voiceStore.ts**

```ts
async function stopScreenShare(): Promise<void> {
  if (!screenShareActive.value) return
  await webrtcService.removeScreenShareTrack()
  screenShareActive.value = false

  const { useNetworkStore } = await import('./networkStore')
  useNetworkStore().broadcast({ type: 'voice_screen_share_stop' })
}
```

- [ ] **Step 4: Update state refs**

Replace `screenStream: ref<MediaStream | null>(null)` with `screenShareActive: ref<boolean>(false)`.

Update all references to `screenStream.value` → `screenShareActive.value`:
- `VoiceBar.vue`: `!!voiceStore.screenStream` → `voiceStore.screenShareActive`
- `VoiceContentPane.vue`: `screenStream` references (handled in Task 10)
- Computed `hasScreenShares`: update condition

- [ ] **Step 5: Verify frontend build**

```bash
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(voice): replace getDisplayMedia with Rust screen share"
```

---

## Task 10: Update VoiceContentPane to Render Frames via Asset Protocol

**Files:**
- Modify: `src/components/chat/VoiceContentPane.vue`
- Modify: `src/stores/voiceStore.ts`
- Modify: `src/stores/networkStore.ts`

Replace `<video :srcObject>` with `<img :src>` fed by asset:// URLs.

- [ ] **Step 1: Add frame URL reactive state to voiceStore**

```ts
// Instead of screenStreams: Record<string, MediaStream>
// Use frame URLs: Record<string, string> (asset:// URL per peer)
const screenFrameUrls = ref<Record<string, string>>({})
```

- [ ] **Step 2: Wire `media_video_frame` event listener in networkStore**

In `networkStore.ts`'s init or event setup:

```ts
import { convertFileSrc } from '@tauri-apps/api/core'

listen('media_video_frame', (event: { payload: { userId: string; frameNumber: number; path: string } }) => {
  const { userId, frameNumber, path } = event.payload
  const voiceStore = useVoiceStore()
  const url = convertFileSrc(path) + `?v=${frameNumber}`
  voiceStore.screenFrameUrls[userId] = url
  voiceStore.updatePeer(userId, { screenSharing: true })
})

listen('media_video_frame_ended', (event: { payload: { userId: string } }) => {
  const { userId } = event.payload
  const voiceStore = useVoiceStore()
  delete voiceStore.screenFrameUrls[userId]
  voiceStore.updatePeer(userId, { screenSharing: false })
})
```

- [ ] **Step 3: Update VoiceContentPane.vue to use `<img>` instead of `<video>`**

Replace:
```html
<video :srcObject="voiceStore.screenStreams[userId]" autoplay playsinline />
```

With:
```html
<img
  v-if="voiceStore.screenFrameUrls[userId]"
  :src="voiceStore.screenFrameUrls[userId]"
  :alt="'Screen share from ' + userId"
  class="screen-frame"
/>
```

Remove the `watchEffect` that synced MediaStream to video element srcObject.

For the local screen share tile, since the local user's own capture is happening entirely in Rust and they can see their own screen, either:
- Show a "You are sharing" placeholder tile
- OR: have the capture pipeline also write local frames to a file (adds CPU cost)

Recommended: show a placeholder with the source name + a small preview updated less frequently (e.g., one thumbnail every 5 seconds via a separate command).

- [ ] **Step 4: Remove `handleRemoteTrack` video branch from networkStore.ts**

The video branch in `handleRemoteTrack` set `voiceStore.screenStreams[userId] = stream`. This is now handled by the `media_video_frame` event listener. Remove the video branch, keeping only the structure for future extensibility.

- [ ] **Step 5: Clean up old MediaStream references**

Remove:
- `screenStreams: ref<Record<string, MediaStream>>({})` from voiceStore
- `screenStream: ref<MediaStream | null>(null)` from voiceStore (already replaced in Task 9)
- The `watchEffect` in VoiceContentPane that synced srcObject
- Any `track.onended` handlers for video tracks in networkStore

- [ ] **Step 6: Verify frontend build**

```bash
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(ui): render screen share frames via asset protocol"
```

---

## Task 11: E2E Integration Verification

**Files:** None (testing only)

- [ ] **Step 1: Build everything**

```bash
npm run build
cd src-tauri && cargo check
```

- [ ] **Step 2: Run unit tests**

```bash
npm run test
cd src-tauri && cargo test
```

Fix any failures.

- [ ] **Step 3: Run E2E smoke tests**

```bash
node scripts/e2e-integration.mjs
```

Or manually:
```bash
npm run dev:tauri
# In another terminal:
npm run dev:tauri -- bob
```

Verify:
1. App starts without errors
2. Two instances can connect (LAN/mDNS or rendezvous)
3. Screen share button opens the source picker modal
4. Selecting a source starts the share (check Rust logs for VP8 encoding)
5. The remote peer receives and displays video frames
6. Stopping the share removes the video tile

- [ ] **Step 4: Clean up any temp frame files**

Verify that `$APPDATA/video-frames/` is cleaned up when:
- A screen share ends (the sending side stops)
- A peer disconnects (stale frame files are removed)
- The app exits (cleanup in `destroy_all` or drop handler)

- [ ] **Step 5: Commit any fixes**

```bash
git add -A && git commit -m "test: verify screen share E2E integration"
```

---

## Known Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `libvpx-sys` build fails on CI/some platforms | Blocks VP8 encode/decode | Switch to `openh264` (H.264) which compiles from source with no system deps |
| xcap `Window::video_recorder()` missing on some platforms | Can't share individual windows | Fall back to polling `Window::capture_image()` at desired FPS |
| JPEG file I/O bottleneck at high FPS | Frame delivery lag | Reduce FPS, use tmpfs on Linux, RAM disk on Windows, or switch to in-memory delivery |
| `SampleBuilder` from webrtc-rs may have API changes | Won't compile | Pin dependency version, check webrtc-rs 0.17 docs |
| VP8 encode on single-core machines may lag | Choppy video | Use "realtime" encoding preset, reduce resolution, offer quality fallback |
| `convertFileSrc()` cache busting may not work if browser caches aggressively | Stale frames displayed | Use unique filenames per frame instead of overwriting (e.g., `{peer}_{n}.jpg`) with periodic cleanup |
| Color space conversion (BGRA → I420) is CPU-intensive at high res | High CPU for 1080p+ | Implement with SIMD intrinsics, or cap at 720p for real-time, or use `libyuv` bindings |

---

## Implementation Order Dependencies

```
Task 1 (deps) ─────────────────────────────────┐
                                                │
            ┌───────────────────────────────────┤
            ▼                                   ▼
Task 2 (enumeration)      Task 4 (VP8 codec)     Task 3 (video tracks)
            │                      │                      │
            │                      ▼                      │
            │          Task 5 (capture pipeline) ◄────────┘
            │                      │
            │                      ▼
            │          Task 6 (receive pipeline)
            │                      │
            ▼                      ▼
Task 8 (source picker UI) Task 7 (Tauri commands) ◄── E2E checkpoint
            │                      │
            ▼                      ▼
         Task 9 (voiceStore) ◄─────┘
                    │
                    ▼
         Task 10 (VoiceContentPane)
                    │
                    ▼
         Task 11 (E2E verification)
```

**Parallelizable pairs:**
- Tasks 2 + 3 + 4 (source enum, video tracks, VP8 codec — independent Rust work)
- Tasks 8 + 6 (picker UI + receive pipeline — different domains)
