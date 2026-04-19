//! Screen capture abstraction layer.
//!
//! Each platform provides a `ScreenCapturer` implementation:
//! - Windows: WGC via `windows-capture` crate (`windows.rs`)
//! - Linux/macOS: stub that returns "not supported" (`stub.rs`)

#[cfg(target_os = "windows")]
mod windows;
#[cfg(not(target_os = "windows"))]
mod stub;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

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

/// Downscale algorithm for screen capture frames.
#[derive(Clone, Copy, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownscaleMethod {
    Nearest,
    #[default]
    Bilinear,
    Bicubic,
    Lanczos3,
}

/// Parameters for starting a capture session.
#[allow(dead_code)]
pub struct CaptureConfig {
    pub source_id: String,
    pub video_track: Arc<TrackLocalStaticSample>,
    /// Second track for high-quality tier (1080p). None = single-track mode.
    pub video_track_high: Option<Arc<TrackLocalStaticSample>>,
    pub app: tauri::AppHandle,
    pub fps: u32,
    /// Target bitrate in kbps (0 = codec default).
    pub bitrate_kbps: u32,
    /// Target bitrate for high-quality tier (0 = codec default).
    pub bitrate_kbps_high: u32,
    pub screen_active: Arc<AtomicBool>,
    /// Set to true by `ensure_tracks_for_peer` when a new peer connects
    /// so the encoder emits an IDR keyframe on the next frame.
    pub force_keyframe: Arc<AtomicBool>,
    pub preview_dir: Option<std::path::PathBuf>,
    /// When true, use the new fused-YUV + simulcast pipeline.
    pub use_new_pipeline: bool,
    /// When true, encode preview JPEG to memory and send as base64 data URL
    /// in the event payload instead of writing to disk.
    pub inline_preview: bool,
    /// Downscale algorithm used when the source is larger than the target.
    pub downscale_method: DownscaleMethod,
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
    {
        Box::new(windows::WgcCapturer::new())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Box::new(stub::StubCapturer)
    }
}
