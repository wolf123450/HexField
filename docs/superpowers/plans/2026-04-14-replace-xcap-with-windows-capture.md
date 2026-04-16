# Replace xcap with windows-capture (WGC) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `xcap` screen capture crate (~2 FPS at 4K via GDI BitBlt) with `windows-capture` (~56 FPS at 4K via Windows Graphics Capture API) on Windows, and gracefully indicate "screen share not yet supported" on Linux/macOS — behind a `ScreenCapturer` trait so per-platform backends slot in cleanly.

**Architecture:** Extract all screen capture logic from `media_manager.rs` into a `capture/` module behind a `ScreenCapturer` trait. The trait has three methods: `enumerate()`, `start()`, `stop()`. The Windows implementation uses `windows-capture` WGC. Non-Windows platforms get a `StubCapturer` that returns "not supported" errors. `media_manager.rs` owns a `Box<dyn ScreenCapturer>` and delegates — it no longer knows anything about platform-specific capture APIs.

**Tech Stack:** `windows-capture` v2.0.0 (WGC GraphicsCaptureApiHandler, Windows-only), `openh264` (H.264 encoding, unchanged), `webrtc` (track delivery, unchanged), Tauri v2 IPC

---

## File Inventory

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/Cargo.toml` | Modify | Remove `xcap`, make `windows-capture` non-optional (Windows-only) |
| `src-tauri/src/capture/mod.rs` | Create | `ScreenCapturer` trait, `ScreenSourceInfo`/`ScreenSourceList` types, `create()` factory fn |
| `src-tauri/src/capture/windows.rs` | Create | `WgcCapturer` — WGC enumerate + capture via `GraphicsCaptureApiHandler` |
| `src-tauri/src/capture/stub.rs` | Create | `StubCapturer` — returns "not supported" errors (Linux/macOS placeholder) |
| `src-tauri/src/media_manager.rs` | Modify | Remove all `xcap` code; hold `Box<dyn ScreenCapturer>`; delegate enumerate/start/stop |
| `src-tauri/src/commands/media_commands.rs` | Modify | Update `enumerate_screens` return type; add `media_screen_share_supported` command |
| `src-tauri/src/lib.rs` | Modify | Register new command, add `mod capture` |
| `src/services/webrtcService.ts` | Modify | Add `isScreenShareSupported()` IPC call |
| `src/stores/voiceStore.ts` | Modify | Check platform support before opening source picker |
| `src/components/chat/VoiceBar.vue` | Modify | Hide share button on unsupported platforms |
| `src-tauri/src/bin/bench_capture.rs` | Modify | Remove xcap benchmarks, keep only windows-capture |

---

### Task 1: Update Cargo.toml — remove xcap, promote windows-capture

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Remove xcap dependency and make windows-capture non-optional**

In `Cargo.toml`, remove:
```toml
# Screen/window capture (cross-platform: DXGI, CoreGraphics, XCB)
xcap               = "0.9"
```

And change the Windows-only dependency from optional to required:
```toml
[target.'cfg(target_os = "windows")'.dependencies]
windows            = { version = "0.62.2", features = ["Win32_Graphics_Gdi", "Win32_UI_WindowsAndMessaging", "Win32_UI_Shell", "Win32_System_Registry"] }
windows-capture    = "2.0.0"
```

Also remove the `bench-capture` feature flag (no longer needed since `windows-capture` is always present on Windows):
```toml
[features]
e2e-testing = ["tauri-plugin-playwright"]
```

- [ ] **Step 2: Verify compilation on Windows**

Run: `cd src-tauri && cargo check`
Expected: Errors in `media_manager.rs` and `bench_capture.rs` about `xcap` not being found. This is expected — we'll fix those in the next tasks.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml
git commit -m "chore: remove xcap, promote windows-capture to required dep (Windows)"
```

---

### Task 2: Create capture/mod.rs — trait + types + factory

**Files:**
- Create: `src-tauri/src/capture/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod capture;`)

- [ ] **Step 1: Create the capture module with trait and types**

Create `src-tauri/src/capture/mod.rs`:

```rust
//! Screen capture abstraction layer.
//!
//! Each platform provides a `ScreenCapturer` implementation:
//! - Windows: WGC via `windows-capture` crate (`windows.rs`)
//! - Linux/macOS: stub that returns "not supported" (`stub.rs`)

#[cfg(target_os = "windows")]
mod windows;
#[cfg(not(target_os = "windows"))]
mod stub;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

/// Information about a capturable screen source (monitor or window).
#[derive(Clone, Debug, serde::Serialize)]
pub struct ScreenSourceInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// "monitor" or "window"
    pub source_type: String,
    /// Base64 JPEG thumbnail for the picker UI (None if unavailable).
    pub thumbnail: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ScreenSourceList {
    pub monitors: Vec<ScreenSourceInfo>,
    pub windows: Vec<ScreenSourceInfo>,
}

/// Parameters for starting a capture session.
pub struct CaptureConfig {
    pub source_id: String,
    pub video_track: Arc<TrackLocalStaticSample>,
    pub app: tauri::AppHandle,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub screen_active: Arc<AtomicBool>,
    pub preview_dir: Option<std::path::PathBuf>,
}

/// Platform-independent screen capture interface.
///
/// Each platform implements this trait. `media_manager.rs` holds a
/// `Box<dyn ScreenCapturer>` and delegates all capture operations.
pub trait ScreenCapturer: Send + Sync {
    /// Whether screen capture is available on this platform at all.
    fn is_supported(&self) -> bool;

    /// List available monitors and windows.
    fn enumerate(&self) -> Result<ScreenSourceList, String>;

    /// Start capturing. Blocks the calling thread until `screen_active` is set
    /// to false or an error occurs. Frames are encoded to H.264 and written to
    /// `config.video_track`.
    fn start(&self, config: CaptureConfig) -> Result<(), String>;
}

/// Create the platform-appropriate capturer.
pub fn create() -> Box<dyn ScreenCapturer> {
    #[cfg(target_os = "windows")]
    { Box::new(windows::WgcCapturer::new()) }

    #[cfg(not(target_os = "windows"))]
    { Box::new(stub::StubCapturer) }
}
```

- [ ] **Step 2: Add `mod capture;` to lib.rs**

In `src-tauri/src/lib.rs`, add near the other `mod` declarations:
```rust
mod capture;
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/capture/mod.rs src-tauri/src/lib.rs
git commit -m "feat: add ScreenCapturer trait + capture module skeleton"
```

---

### Task 3: Create capture/stub.rs — unsupported platform placeholder

**Files:**
- Create: `src-tauri/src/capture/stub.rs`

- [ ] **Step 1: Write the stub capturer**

Create `src-tauri/src/capture/stub.rs`:

```rust
//! Stub screen capturer for platforms where screen sharing is not yet implemented.

use super::{CaptureConfig, ScreenCapturer, ScreenSourceList};

pub struct StubCapturer;

impl ScreenCapturer for StubCapturer {
    fn is_supported(&self) -> bool {
        false
    }

    fn enumerate(&self) -> Result<ScreenSourceList, String> {
        Err("Screen sharing is not yet supported on this platform".to_string())
    }

    fn start(&self, _config: CaptureConfig) -> Result<(), String> {
        Err("Screen sharing is not yet supported on this platform".to_string())
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/capture/stub.rs
git commit -m "feat: add StubCapturer for Linux/macOS"
```

---

### Task 4: Create capture/windows.rs — WGC implementation

**Files:**
- Create: `src-tauri/src/capture/windows.rs`

This is the core file. It implements `ScreenCapturer` using `windows-capture` WGC.

- [ ] **Step 1: Write the WGC capturer with enumerate + start**

Create `src-tauri/src/capture/windows.rs`:

```rust
//! Windows screen capture via Windows Graphics Capture (WGC).
//!
//! Uses the `windows-capture` crate which wraps the WinRT
//! Windows.Graphics.Capture API. Delivers frames at compositor
//! refresh rate (~60fps) with GPU-resident textures.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use tauri::Emitter;
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor as WcMonitor;
use windows_capture::window::Window as WcWindow;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

use super::{CaptureConfig, ScreenCapturer, ScreenSourceInfo, ScreenSourceList};

pub struct WgcCapturer;

impl WgcCapturer {
    pub fn new() -> Self {
        Self
    }

    /// Sanitize Windows monitor name: "\\.\DISPLAY2" → "Display 2"
    fn sanitize_monitor_name(raw: &str, index: usize) -> String {
        let stripped = raw
            .trim_start_matches("\\\\")
            .trim_start_matches('.')
            .trim_start_matches('\\');

        if let Some(num_start) = stripped.find(|c: char| c.is_ascii_digit()) {
            let prefix = &stripped[..num_start];
            let number = &stripped[num_start..];
            let mut title = String::new();
            for (i, c) in prefix.chars().enumerate() {
                if i == 0 {
                    title.extend(c.to_uppercase());
                } else {
                    title.extend(c.to_lowercase());
                }
            }
            format!("{title} {number}")
        } else if stripped.is_empty() {
            format!("Display {}", index + 1)
        } else {
            stripped.to_string()
        }
    }
}

impl ScreenCapturer for WgcCapturer {
    fn is_supported(&self) -> bool {
        true
    }

    fn enumerate(&self) -> Result<ScreenSourceList, String> {
        let monitors: Vec<ScreenSourceInfo> = WcMonitor::enumerate()
            .map_err(|e| format!("monitor enumerate: {e}"))?
            .into_iter()
            .enumerate()
            .map(|(i, m)| {
                let raw_name = m.name().unwrap_or_default();
                let width = m.width().unwrap_or(0);
                let height = m.height().unwrap_or(0);
                let name = if raw_name.is_empty() {
                    format!("Display {}", i + 1)
                } else {
                    Self::sanitize_monitor_name(&raw_name, i)
                };
                ScreenSourceInfo {
                    id: format!("monitor:{i}"),
                    name,
                    width,
                    height,
                    source_type: "monitor".to_string(),
                    thumbnail: None,
                }
            })
            .collect();

        let windows: Vec<ScreenSourceInfo> = WcWindow::enumerate()
            .map_err(|e| format!("window enumerate: {e}"))?
            .into_iter()
            .filter(|w| !w.title().unwrap_or_default().is_empty())
            .enumerate()
            .map(|(i, w)| {
                let title = w.title().unwrap_or_default();
                let width = w.width().unwrap_or(0);
                let height = w.height().unwrap_or(0);
                ScreenSourceInfo {
                    id: format!("window:{i}"),
                    name: title,
                    width,
                    height,
                    source_type: "window".to_string(),
                    thumbnail: None,
                }
            })
            .collect();

        Ok(ScreenSourceList { monitors, windows })
    }

    fn start(&self, config: CaptureConfig) -> Result<(), String> {
        let (source_type, index_str) = config.source_id
            .split_once(':')
            .ok_or("invalid source_id format")?;
        let index: usize = index_str
            .parse()
            .map_err(|e: std::num::ParseIntError| e.to_string())?;

        let flags = WgcFlags {
            video_track: config.video_track,
            frame_duration: Duration::from_millis(1000 / config.fps.max(1) as u64),
            screen_active: config.screen_active,
            app: config.app,
            preview_dir: config.preview_dir,
            rt: tokio::runtime::Handle::current(),
        };

        match source_type {
            "monitor" => {
                let monitors = WcMonitor::enumerate().map_err(|e| e.to_string())?;
                let monitor = monitors.into_iter().nth(index)
                    .ok_or("monitor index out of range")?;

                let settings = Settings::new(
                    monitor,
                    CursorCaptureSettings::WithoutCursor,
                    DrawBorderSettings::WithoutBorder,
                    SecondaryWindowSettings::Default,
                    MinimumUpdateIntervalSettings::Default,
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    flags,
                );

                WgcHandler::start(settings).map_err(|e| e.to_string())
            }
            "window" => {
                let windows = WcWindow::enumerate().map_err(|e| e.to_string())?;
                let win_list: Vec<_> = windows.into_iter()
                    .filter(|w| !w.title().unwrap_or_default().is_empty())
                    .collect();
                let window = win_list.into_iter().nth(index)
                    .ok_or("window index out of range")?;

                let settings = Settings::new(
                    window,
                    CursorCaptureSettings::WithoutCursor,
                    DrawBorderSettings::WithoutBorder,
                    SecondaryWindowSettings::Default,
                    MinimumUpdateIntervalSettings::Default,
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    flags,
                );

                WgcHandler::start(settings).map_err(|e| e.to_string())
            }
            _ => Err(format!("unsupported source type: {source_type}")),
        }
    }
}

// ── WGC callback handler ────────────────────────────────────────────────────

struct WgcFlags {
    video_track: Arc<TrackLocalStaticSample>,
    frame_duration: Duration,
    screen_active: Arc<AtomicBool>,
    app: tauri::AppHandle,
    preview_dir: Option<std::path::PathBuf>,
    rt: tokio::runtime::Handle,
}

struct WgcHandler {
    video_track: Arc<TrackLocalStaticSample>,
    encoder: Option<openh264::encoder::Encoder>,
    frame_count: u64,
    frame_duration: Duration,
    screen_active: Arc<AtomicBool>,
    app: tauri::AppHandle,
    preview_dir: Option<std::path::PathBuf>,
    rt: tokio::runtime::Handle,
}

impl GraphicsCaptureApiHandler for WgcHandler {
    type Flags = WgcFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let flags = ctx.flags;
        Ok(Self {
            video_track: flags.video_track,
            encoder: None,
            frame_count: 0,
            frame_duration: flags.frame_duration,
            screen_active: flags.screen_active,
            app: flags.app,
            preview_dir: flags.preview_dir,
            rt: flags.rt,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if !self.screen_active.load(Ordering::Acquire) {
            capture_control.stop();
            return Ok(());
        }

        let w = frame.width() as usize;
        let h = frame.height() as usize;

        let mut buf = frame.buffer()?;
        let raw = buf.as_raw_buffer();

        // WGC delivers BGRA; openh264 expects RGBA. Copy + swap B/R.
        let mut rgba = raw.to_vec();
        drop(buf);
        for pixel in rgba.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }

        // Init encoder on first frame
        if self.encoder.is_none() {
            let fps_f = 1.0 / self.frame_duration.as_secs_f32();
            let config = openh264::encoder::EncoderConfig::new()
                .max_frame_rate(openh264::encoder::FrameRate::from_hz(fps_f));
            self.encoder = Some(
                openh264::encoder::Encoder::with_api_config(
                    openh264::OpenH264API::from_source(),
                    config,
                )?
            );
        }

        let enc = self.encoder.as_mut().unwrap();
        let src = openh264::formats::RgbaSliceU8::new(&rgba, (w, h));
        let yuv = openh264::formats::YUVBuffer::from_rgb_source(src);

        match enc.encode(&yuv) {
            Ok(bitstream) => {
                let h264_data = bitstream.to_vec();
                if !h264_data.is_empty() {
                    let vt = self.video_track.clone();
                    let dur = self.frame_duration;
                    let _ = self.rt.block_on(async {
                        vt.write_sample(&Sample {
                            data: Bytes::from(h264_data),
                            duration: dur,
                            ..Default::default()
                        })
                        .await
                    });
                }
            }
            Err(e) => {
                log::warn!("[media] H.264 encode error: {e}");
            }
        }

        // Local preview JPEG (every 5th frame, downscaled)
        if self.frame_count % 5 == 0 {
            if let Some(ref dir) = self.preview_dir {
                let preview_path = dir.join("self.jpg");
                if let Some(rgba_img) = image::RgbaImage::from_raw(w as u32, h as u32, rgba) {
                    use image::imageops::FilterType;
                    let preview_w = 640u32.min(w as u32);
                    let preview_h = preview_w * h as u32 / (w as u32).max(1);
                    let resized = image::imageops::resize(
                        &rgba_img, preview_w, preview_h, FilterType::Triangle,
                    );
                    let _ = crate::media_manager::MediaManager::write_jpeg_frame(
                        resized.as_raw(), preview_w, preview_h, &preview_path,
                    );
                    let _ = self.app.emit(
                        "media_video_frame",
                        serde_json::json!({
                            "userId": "self",
                            "frameNumber": self.frame_count,
                            "path": preview_path.to_string_lossy(),
                        }),
                    );
                }
            }
        }

        self.frame_count += 1;
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        log::debug!("[media] WGC capture closed after {} frames", self.frame_count);
        Ok(())
    }
}
```

- [ ] **Step 2: Verify it compiles in isolation**

Run: `cd src-tauri && cargo check`
Expected: May have errors in `media_manager.rs` (still referencing xcap) — that's fine, it's fixed in Task 5.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/capture/windows.rs
git commit -m "feat: WGC ScreenCapturer implementation (28x faster than xcap)"
```

---

### Task 5: Refactor media_manager.rs — delegate to ScreenCapturer trait

**Files:**
- Modify: `src-tauri/src/media_manager.rs`

Remove all `xcap` code from `media_manager.rs`. Replace with a `Box<dyn ScreenCapturer>` field that's initialized via `capture::create()`. The manager delegates `enumerate_screens()` and `start_screen_share()` to the capturer.

- [ ] **Step 1: Add capturer field to MediaManager**

In the `MediaManager` struct definition, add:
```rust
capturer: Box<dyn crate::capture::ScreenCapturer>,
```

In `MediaManager::new()`, initialize it:
```rust
capturer: crate::capture::create(),
```

- [ ] **Step 2: Replace enumerate_screens()**

Replace the entire `enumerate_screens` method (and remove `capture_thumbnail_monitor`, `sanitize_monitor_name` — they moved to `capture/windows.rs`). The new method:

```rust
pub fn enumerate_screens(&self) -> Result<crate::capture::ScreenSourceList, String> {
    self.capturer.enumerate()
}
```

Also remove `ScreenSourceInfo` and `ScreenSourceList` structs from `media_manager.rs` — they now live in `capture/mod.rs`.

- [ ] **Step 3: Replace start_screen_share()**

Replace the entire body of `start_screen_share`. The key difference: instead of an inline `spawn_blocking` with xcap polling, we spawn a blocking task that calls `self.capturer.start()`:

```rust
pub async fn start_screen_share(
    &self,
    source_id: &str,
    video_track: Arc<TrackLocalStaticSample>,
    app: tauri::AppHandle,
    fps: u32,
    bitrate_kbps: u32,
) -> Result<(), String> {
    if !self.capturer.is_supported() {
        return Err("Screen sharing is not yet supported on this platform".to_string());
    }

    if self.screen_active.load(Ordering::Acquire) {
        return Err("screen share already active".into());
    }

    *self.video_track.lock().await = Some(video_track.clone());
    self.screen_active.store(true, Ordering::Release);

    let screen_active = self.screen_active.clone();
    let source_id_owned = source_id.to_string();
    let app_clone = app.clone();
    let preview_dir = Self::frame_output_dir(&app).ok();

    // Build a new capturer for the blocking task (trait object is Send+Sync)
    let capturer = crate::capture::create();
    let config = crate::capture::CaptureConfig {
        source_id: source_id_owned.clone(),
        video_track,
        app: app_clone.clone(),
        fps,
        bitrate_kbps,
        screen_active,
        preview_dir,
    };

    let task = tokio::task::spawn_blocking(move || {
        if let Err(e) = capturer.start(config) {
            log::error!("[media] screen capture failed: {e}");
            let _ = app_clone.emit(
                "media_screen_share_error",
                serde_json::json!({ "error": e }),
            );
        }
    });

    *self.screen_task.lock().await = Some(task);

    let _ = app.emit(
        "media_screen_share_started",
        serde_json::json!({ "sourceId": source_id_owned }),
    );

    Ok(())
}
```

- [ ] **Step 4: Add is_screen_share_supported() method**

```rust
pub fn is_screen_share_supported(&self) -> bool {
    self.capturer.is_supported()
}
```

- [ ] **Step 5: Remove all remaining xcap code**

Delete from `media_manager.rs`:
- The `ScreenSourceInfo` and `ScreenSourceList` structs (moved to `capture/mod.rs`)
- The `capture_thumbnail_monitor` helper
- The `sanitize_monitor_name` helper
- The `Source` enum (`Source::Monitor`, `Source::WindowById`)
- The `rgba_to_thumbnail_b64` helper (move to `capture/mod.rs` if needed later, or delete)
- All `xcap::*` references

- [ ] **Step 6: Update media_commands.rs**

In `src-tauri/src/commands/media_commands.rs`:

Update `media_enumerate_screens` — the return type now uses `capture::ScreenSourceList`:
```rust
use crate::capture::ScreenSourceList;

#[tauri::command]
pub async fn media_enumerate_screens(
    state: State<'_, AppState>,
) -> Result<ScreenSourceList, String> {
    state.media_manager.enumerate_screens()
}
```

Add the new command:
```rust
/// Check if screen sharing is supported on the current platform.
#[tauri::command]
pub async fn media_screen_share_supported(
    state: State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.media_manager.is_screen_share_supported())
}
```

- [ ] **Step 7: Register the new command in lib.rs**

Add `media_screen_share_supported` to the `invoke_handler![]` list.

- [ ] **Step 8: Verify full Rust compilation**

Run: `cd src-tauri && cargo check`
Expected: Clean compilation, no xcap references remain.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/media_manager.rs src-tauri/src/commands/media_commands.rs src-tauri/src/lib.rs
git commit -m "refactor: media_manager delegates to ScreenCapturer trait, xcap removed"
```

---

### Task 6: Frontend — gate screen share on platform support

**Files:**
- Modify: `src/services/webrtcService.ts`
- Modify: `src/stores/voiceStore.ts`
- Modify: `src/components/chat/VoiceBar.vue`

- [ ] **Step 1: Add frontend IPC wrapper**

In `src/services/webrtcService.ts`, add a method to the `WebRTCService` class:
```typescript
async isScreenShareSupported(): Promise<boolean> {
    return await invoke<boolean>('media_screen_share_supported')
}
```

- [ ] **Step 2: Add screenShareSupported ref to voiceStore**

In `src/stores/voiceStore.ts`, add a ref and check function:
```typescript
const screenShareSupported = ref<boolean>(true) // assume true until checked

async function checkScreenShareSupport(): Promise<void> {
    screenShareSupported.value = await webrtcService.isScreenShareSupported()
}
```

Export both from the store's return object.

- [ ] **Step 3: Gate startScreenShare**

In `src/stores/voiceStore.ts`, update `startScreenShare()` to bail early:
```typescript
async function startScreenShare(): Promise<void> {
    if (!screenShareSupported.value) {
        const { useUIStore } = await import('./uiStore')
        useUIStore().showNotification('Screen sharing is not yet supported on this platform', 'warning')
        return
    }

    // ... rest unchanged
}
```

- [ ] **Step 4: Hide share button on unsupported platforms**

In `src/components/chat/VoiceBar.vue`, change the share button's `v-if`:
```vue
<button
  v-if="!isMobile && voiceStore.screenShareSupported"
```

Call `voiceStore.checkScreenShareSupport()` from the VoiceBar's setup or from the `joinVoiceChannel` flow so it's checked once on startup.

- [ ] **Step 5: Verify frontend compilation**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
git add src/services/webrtcService.ts src/stores/voiceStore.ts src/components/chat/VoiceBar.vue
git commit -m "feat: hide screen share UI on unsupported platforms"
```

---

### Task 7: Update bench_capture.rs

**Files:**
- Modify: `src-tauri/src/bin/bench_capture.rs`

- [ ] **Step 1: Remove xcap benchmarks, keep only WGC**

Rewrite `bench_capture.rs`:
- Remove `bench_xcap_screenshot()` and `bench_xcap_video_recorder()`
- Keep `bench_windows_capture_wgc()` and `bench_windows_capture_dxgi()`
- Remove `#[cfg(feature = "bench-capture")]` guards (windows-capture is now always available on Windows)
- Add `#[cfg(not(target_os = "windows"))]` to print "benchmark only available on Windows" on other platforms

- [ ] **Step 2: Verify build and run**

Run: `cd src-tauri && cargo run --bin bench_capture`
Expected: WGC benchmark runs successfully.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/bin/bench_capture.rs
git commit -m "chore: update bench_capture for windows-capture only"
```

---

### Task 8: Full build verification + smoke test

- [ ] **Step 1: Search for any remaining xcap references**

Run: `grep -r "xcap" src-tauri/src/`
Expected: No matches.

- [ ] **Step 2: Full build**

Run:
```bash
cd src-tauri && cargo check
npm run build
```
Expected: Both pass cleanly.

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev:tauri`

1. Create/join a server, join a voice channel
2. Click "Share screen" — source picker should appear with monitors listed (no thumbnails for now)
3. Select a monitor — screen share should start, own preview visible in VoiceContentPane
4. Stop sharing — verify clean stop

- [ ] **Step 4: Two-instance test**

Run alice + bob dev instances. Alice shares screen, verify Bob receives video frames.

---

## Notes

- **Thumbnails**: WGC doesn't provide a simple "capture one still frame" API. The source picker now shows monitors/windows by name + resolution only. Thumbnails can be added later by starting a brief WGC session to grab one frame.
- **Color format**: WGC uses BGRA8 natively. We convert to RGBA for openh264 with an in-place B/R swap (~5ms at 4K — negligible vs the 17ms frame budget).
- **Future backends**: To add Linux (PipeWire) or macOS (ScreenCaptureKit), create `capture/linux.rs` or `capture/macos.rs` implementing `ScreenCapturer`, and update the `#[cfg]` gates in `capture/mod.rs`.
- **Camera input**: A future `CameraCapturer` could implement the same trait if the data flow fits (continuous fixed-FPS stream). If it turns out cameras need a different interface (e.g., format negotiation), it would get its own trait — that's fine, the module structure accommodates it either way.

In `src/components/chat/VoiceBar.vue`, change the share button visibility:
```vue
<button
  v-if="!isMobile && voiceStore.screenShareSupported"
  ...
```

Call `voiceStore.checkScreenShareSupport()` in the VoiceBar's `onMounted` or in the voice session join flow.

- [ ] **Step 6: Verify compilation**

Run:
```bash
cd src-tauri && cargo check
npm run build
```
Expected: Both pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/media_commands.rs src-tauri/src/lib.rs src/services/webrtcService.ts src/stores/voiceStore.ts src/components/chat/VoiceBar.vue
git commit -m "feat: gate screen share UI on platform support (Windows only for now)"
```

---

### Task 5: Handle BGRA → RGBA color format

**Files:**
- Already handled in Task 3 (the `on_frame_arrived` handler swaps B/R channels)

This is a callout rather than a separate task. The `windows-capture` WGC API delivers frames in **BGRA8** format (matching DirectX convention). The openh264 encoder expects **RGBA**. The handler in Task 3 includes this conversion:

```rust
// WGC delivers BGRA; openh264 expects RGBA. Swap bytes [0] and [2].
for pixel in rgba.chunks_exact_mut(4) {
    pixel.swap(0, 2);
}
```

At 4K (33MB/frame), this in-place swap takes ~5ms — well within the ~17ms frame budget at 60fps. If profiling shows it's a bottleneck later, it could be SIMD-optimized, but it's unlikely to matter.

---

### Task 6: Update bench_capture.rs

**Files:**
- Modify: `src-tauri/src/bin/bench_capture.rs`

- [ ] **Step 1: Remove xcap benchmarks, keep only WGC**

Rewrite `bench_capture.rs` to only use `windows-capture` (since `xcap` is removed):
- Remove `bench_xcap_screenshot()` and `bench_xcap_video_recorder()`
- Keep `bench_windows_capture_wgc()` and `bench_windows_capture_dxgi()`
- Remove `#[cfg(feature = "bench-capture")]` guards (windows-capture is now always available on Windows)
- Add `#[cfg(not(target_os = "windows"))]` to make the binary print "benchmark only available on Windows" on other platforms

- [ ] **Step 2: Verify it builds and runs**

Run:
```bash
cd src-tauri && cargo run --bin bench_capture
```
Expected: WGC benchmark runs, DXGI may fail gracefully.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/bin/bench_capture.rs
git commit -m "chore: update bench_capture for windows-capture only"
```

---

### Task 7: Clean up dead code and verify full build

**Files:**
- Modify: `src-tauri/src/media_manager.rs` (remove any leftover xcap references)
- Verify: full `cargo check` + `npm run build`

- [ ] **Step 1: Search for any remaining xcap references**

Run: `grep -r "xcap" src-tauri/src/`
Expected: No matches (only `bench_capture.rs` should have been cleaned in Task 6).

- [ ] **Step 2: Remove the `capture_thumbnail_monitor` helper if still present**

If not already removed in Task 2, delete the `capture_thumbnail_monitor` function and any `xcap`-specific thumbnail code.

- [ ] **Step 3: Remove the window-by-ID re-enumeration pattern**

The old `start_screen_share` had a `Source::WindowById(u32)` enum that re-enumerated windows each frame via `xcap::Window::all()`. This is no longer needed — WGC streams directly from the window handle.

Delete the `Source` enum and its associated code.

- [ ] **Step 4: Full build verification**

Run:
```bash
cd src-tauri && cargo check
cd src-tauri && cargo check --bin bench_capture
npm run build
```
Expected: All pass with no warnings about unused imports or dead code.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove all xcap dead code, verify clean build"
```

---

### Task 8: Manual smoke test

- [ ] **Step 1: Start dev environment**

Run: `npm run dev:tauri`

- [ ] **Step 2: Test screen share flow**

1. Create/join a server, join a voice channel
2. Click "Share screen" button in the VoiceBar
3. Source picker should appear showing monitors (without thumbnails — that's expected with WGC)
4. Select a monitor
5. Screen share should start — verify your own preview appears in the VoiceContentPane
6. Stop sharing — verify it stops cleanly

- [ ] **Step 3: Test two-instance flow**

Run alice + bob dev instances:
```bash
npm run dev:tauri -- alice
npm run dev:tauri -- bob
```

1. Both join the same voice channel
2. Alice shares screen
3. Bob should see Alice's screen frames in VoiceContentPane
4. Alice stops sharing — Bob's view should update

- [ ] **Step 4: Verify performance improvement**

During screen share, check the frame delivery rate. With WGC at 4K, you should see smooth updates (~15-30fps depending on desktop activity) vs the previous ~2fps with xcap.

---

## Notes

- **Thumbnails**: WGC doesn't provide a simple "capture one still frame" API like xcap did. The source picker now shows monitors/windows by name + resolution only, without preview thumbnails. If thumbnails are wanted later, we can start a brief WGC capture session to grab one frame, then stop.
- **Window capture**: WGC window capture works by window handle, not by re-enumerating each frame. The window content streams directly from the compositor — much more efficient and reliable than xcap's approach.
- **Linux/macOS**: These platforms show a notification when the user tries to share their screen. The share button is hidden entirely via the `screenShareSupported` ref. Future work can add PipeWire (Linux) or ScreenCaptureKit (macOS) support.
- **Color format**: WGC uses BGRA8 natively. We convert to RGBA for openh264. This is a ~5ms operation at 4K — negligible compared to the encoding/transmission cost.
