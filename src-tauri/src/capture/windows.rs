//! Windows screen capture via Windows Graphics Capture (WGC).
//!
//! Uses the `windows-capture` crate which wraps the WinRT
//! Windows.Graphics.Capture API. Delivers frames at compositor
//! refresh rate (~60fps) with GPU-resident textures.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use tauri::Emitter;
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor as WcMonitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window as WcWindow;

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
                let device_name = m.device_name().unwrap_or_default();
                let width = m.width().unwrap_or(0);
                let height = m.height().unwrap_or(0);
                let name = if raw_name.is_empty() {
                    format!("Display {}", i + 1)
                } else {
                    Self::sanitize_monitor_name(&raw_name, i)
                };
                ScreenSourceInfo {
                    id: format!("monitor:{device_name}"),
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
            .map(|(_i, w)| {
                let title = w.title().unwrap_or_default();
                let hwnd = w.as_raw_hwnd() as usize;
                let width = w.width().unwrap_or(0) as u32;
                let height = w.height().unwrap_or(0) as u32;
                ScreenSourceInfo {
                    id: format!("window:{hwnd}"),
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
        let (source_type, source_key) = config
            .source_id
            .split_once(':')
            .ok_or("invalid source_id format")?;

        let flags = WgcFlags {
            video_track: config.video_track,
            video_track_high: config.video_track_high,
            frame_duration: Duration::from_millis(1000 / config.fps.max(1) as u64),
            bitrate_kbps: config.bitrate_kbps,
            bitrate_kbps_high: config.bitrate_kbps_high,
            screen_active: config.screen_active,
            force_keyframe: config.force_keyframe,
            app: config.app,
            preview_dir: config.preview_dir,
            use_new_pipeline: config.use_new_pipeline,
            rt: tokio::runtime::Handle::current(),
        };

        match source_type {
            "monitor" => {
                let monitors = WcMonitor::enumerate().map_err(|e| e.to_string())?;
                let monitor = monitors
                    .into_iter()
                    .find(|m| m.device_name().unwrap_or_default() == source_key)
                    .ok_or_else(|| format!("monitor not found: {source_key}"))?;

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
                let hwnd_val: usize = source_key.parse()
                    .map_err(|e: std::num::ParseIntError| e.to_string())?;
                let window = WcWindow::from_raw_hwnd(hwnd_val as *mut std::ffi::c_void);
                if !window.is_valid() {
                    return Err(format!("window not found: HWND {hwnd_val}"));
                }

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
    video_track_high: Option<Arc<TrackLocalStaticSample>>,
    frame_duration: Duration,
    bitrate_kbps: u32,
    bitrate_kbps_high: u32,
    screen_active: Arc<AtomicBool>,
    force_keyframe: Arc<AtomicBool>,
    app: tauri::AppHandle,
    preview_dir: Option<std::path::PathBuf>,
    use_new_pipeline: bool,
    rt: tokio::runtime::Handle,
}

struct WgcHandler {
    video_track: Arc<TrackLocalStaticSample>,
    video_track_high: Option<Arc<TrackLocalStaticSample>>,
    encoder: Option<openh264::encoder::Encoder>,
    frame_count: u64,
    frame_duration: Duration,
    bitrate_kbps: u32,
    bitrate_kbps_high: u32,
    screen_active: Arc<AtomicBool>,
    force_keyframe: Arc<AtomicBool>,
    app: tauri::AppHandle,
    preview_dir: Option<std::path::PathBuf>,
    use_new_pipeline: bool,
    rt: tokio::runtime::Handle,
}

impl GraphicsCaptureApiHandler for WgcHandler {
    type Flags = WgcFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let flags = ctx.flags;
        Ok(Self {
            video_track: flags.video_track,
            video_track_high: flags.video_track_high,
            encoder: None,
            frame_count: 0,
            frame_duration: flags.frame_duration,
            bitrate_kbps: flags.bitrate_kbps,
            bitrate_kbps_high: flags.bitrate_kbps_high,
            screen_active: flags.screen_active,
            force_keyframe: flags.force_keyframe,
            app: flags.app,
            preview_dir: flags.preview_dir,
            use_new_pipeline: flags.use_new_pipeline,
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

        self.frame_count += 1;

        if self.frame_count == 1 {
            log::info!("[media] WGC first frame arrived: {}x{}", frame.width(), frame.height());
        }

        let t_start = std::time::Instant::now();

        let orig_w = frame.width() as u32;
        let orig_h = frame.height() as u32;

        let mut buf = frame.buffer()?;
        let raw = buf.as_raw_buffer();

        // Downscale + BGRA→RGBA in a single pass. For 3840×2160 → 1280×720
        // this reads the source once and writes a 3.6 MB output buffer with
        // channels already swapped, avoiding a 33 MB copy + separate swap.
        const MAX_W: u32 = 1280;
        let (w, h, mut rgba, already_swapped) = if orig_w > MAX_W {
            let scale = MAX_W as f64 / orig_w as f64;
            let new_h = (orig_h as f64 * scale) as u32;
            // Ensure even dimensions for H.264
            let new_w = (MAX_W & !1) as usize;
            let new_h = (new_h & !1) as usize;
            let src_stride = orig_w as usize * 4;

            // Fast nearest-neighbor downscale + BGRA→RGBA swap in a single
            // pass. Avoids two separate iterations over the pixel data.
            let mut out = vec![0u8; new_w * new_h * 4];
            let x_ratio = orig_w as f64 / new_w as f64;
            let y_ratio = orig_h as f64 / new_h as f64;
            for y in 0..new_h {
                let src_y = (y as f64 * y_ratio) as usize;
                let src_row = src_y * src_stride;
                let dst_row = y * new_w * 4;
                for x in 0..new_w {
                    let src_x = (x as f64 * x_ratio) as usize;
                    let si = src_row + src_x * 4;
                    let di = dst_row + x * 4;
                    // BGRA → RGBA: swap B↔R during copy
                    out[di] = raw[si + 2];     // R ← B
                    out[di + 1] = raw[si + 1]; // G ← G
                    out[di + 2] = raw[si];     // B ← R
                    out[di + 3] = raw[si + 3]; // A ← A
                }
            }
            drop(buf);
            (new_w, new_h, out, true)
        } else {
            let data = raw.to_vec();
            drop(buf);
            (orig_w as usize, orig_h as usize, data, false)
        };

        // Swap B↔R only if not already done during downscale
        if !already_swapped {
            for pixel in rgba.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
        }
        let t_after_swap = t_start.elapsed();

        // Init encoder on first frame (when we know the resolution)
        if self.encoder.is_none() {
            let fps_f = 1.0 / self.frame_duration.as_secs_f32();
            let mut enc_cfg = openh264::encoder::EncoderConfig::new()
                .max_frame_rate(openh264::encoder::FrameRate::from_hz(fps_f));
            if self.bitrate_kbps > 0 {
                enc_cfg = enc_cfg
                    .bitrate(openh264::encoder::BitRate::from_bps(
                        self.bitrate_kbps * 1000,
                    ))
                    .rate_control_mode(openh264::encoder::RateControlMode::Bitrate);
            }
            self.encoder = Some(openh264::encoder::Encoder::with_api_config(
                openh264::OpenH264API::from_source(),
                enc_cfg,
            )?);
        }

        let enc = self.encoder.as_mut().unwrap();

        // If a new peer connected, force an IDR keyframe so they can start
        // decoding immediately instead of waiting for the next periodic IDR.
        if self.force_keyframe.swap(false, Ordering::AcqRel) {
            enc.force_intra_frame();
        }

        let src = openh264::formats::RgbaSliceU8::new(&rgba, (w, h));
        let yuv = openh264::formats::YUVBuffer::from_rgb_source(src);
        let t_after_yuv = t_start.elapsed();

        match enc.encode(&yuv) {
            Ok(bitstream) => {
                let t_after_encode = t_start.elapsed();
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
                let t_after_send = t_start.elapsed();

                // Log timing: first frame + every 300th (~10s at 30fps)
                if self.frame_count == 1 || self.frame_count % 300 == 0 {
                    let total = t_start.elapsed();
                    log::info!(
                        "[media] capture frame #{}: swap={:.1}ms yuv={:.1}ms enc={:.1}ms send={:.1}ms total={:.1}ms ({}x{})",
                        self.frame_count,
                        t_after_swap.as_secs_f64() * 1000.0,
                        t_after_yuv.as_secs_f64() * 1000.0,
                        t_after_encode.as_secs_f64() * 1000.0,
                        t_after_send.as_secs_f64() * 1000.0,
                        total.as_secs_f64() * 1000.0,
                        w, h,
                    );
                }
            }
            Err(e) => {
                log::warn!("[media] H.264 encode error: {e}");
            }
        }

        // Local preview JPEG (every 2nd frame)
        if self.frame_count % 2 == 0 {
            if let Some(ref dir) = self.preview_dir {
                let preview_path = dir.join("self.jpg");
                if let Some(rgba_img) = image::RgbaImage::from_raw(w as u32, h as u32, rgba) {
                    let preview_w = 640u32.min(w as u32);
                    let preview_h = preview_w * h as u32 / (w as u32).max(1);
                    let resized = image::imageops::resize(
                        &rgba_img,
                        preview_w,
                        preview_h,
                        image::imageops::FilterType::Nearest,
                    );
                    let _ = crate::media_manager::MediaManager::write_jpeg_frame(
                        resized.as_raw(),
                        preview_w,
                        preview_h,
                        &preview_path,
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

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        log::debug!(
            "[media] WGC capture closed after {} frames",
            self.frame_count
        );
        Ok(())
    }
}
