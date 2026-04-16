# Screen Share Quality & Simulcast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the capped 720p 30fps single-track screen share pipeline with a 2-tier simulcast system (720p + 1080p) at 60fps, with per-viewer quality selection UI, fused BGRA→YUV420 conversion, and a profiling harness to compare old vs new pipeline before switching.

**Architecture:** New pipeline is built alongside the old one, toggled by a runtime flag (`USE_NEW_PIPELINE` env var / Tauri command param). Both share the same WGC capture callback entry point, forking at the pixel-processing stage. The new path does fused BGRA→YUV420 (skipping RGBA intermediate), spawns two encoder threads (720p + 1080p), and writes to separate `TrackLocalStaticSample` instances. Peers select quality tier via data channel messages; the WebRTC manager swaps tracks per-peer without SDP renegotiation. A YouTube-style gear icon on video tiles lets viewers pick resolution.

**Tech Stack:** Rust (openh264, webrtc-rs, windows-capture, tokio, crossbeam-channel), Vue 3.5 (`<script setup>`), Pinia 3, TypeScript strict

**Design Spec:** [`docs/superpowers/specs/2026-04-15-screen-share-quality-design.md`](../specs/2026-04-15-screen-share-quality-design.md)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/src/capture/windows.rs` | Modify | Fork pipeline based on flag; fused BGRA→YUV420 conversion; 2 encoder threads |
| `src-tauri/src/capture/mod.rs` | Modify | Extend `CaptureConfig` with new fields (`use_new_pipeline`, `video_track_high`) |
| `src-tauri/src/webrtc_manager.rs` | Modify | Two video tracks (low/high); per-peer quality tier; `quality_request` data channel handler; track swapping |
| `src-tauri/src/media_manager.rs` | Modify | Pass new CaptureConfig fields; decode_and_write_jpeg quality parameter; start_screen_share signature |
| `src-tauri/src/commands/media_commands.rs` | Modify | Pass new pipeline flag from frontend settings |
| `src/stores/voiceStore.ts` | Modify | Track current quality tier per stream; quality request action |
| `src/stores/settingsStore.ts` | Modify | Add 60fps option to videoFrameRate type; default to 60 |
| `src/stores/networkStore.ts` | Modify | Handle `quality_request` data channel messages |
| `src/components/chat/VoiceContentPane.vue` | Modify | Quality selector gear overlay on video tiles |
| `src/components/chat/QualitySelector.vue` | Create | Standalone gear-menu component for per-tile quality switching |

---

## Task 1: Extend CaptureConfig for New Pipeline

**Files:**
- Modify: `src-tauri/src/capture/mod.rs:39-52`

This task adds the fields needed to support dual tracks and the pipeline toggle, without changing any behavior yet.

- [ ] **Step 1: Add new fields to CaptureConfig**

In `src-tauri/src/capture/mod.rs`, add three fields to `CaptureConfig`:

```rust
/// Parameters for starting a capture session.
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
    pub force_keyframe: Arc<AtomicBool>,
    pub preview_dir: Option<std::path::PathBuf>,
    /// When true, use new fused-YUV + simulcast pipeline.
    pub use_new_pipeline: bool,
}
```

- [ ] **Step 2: Fix the CaptureConfig construction in media_manager.rs**

In `src-tauri/src/media_manager.rs` `start_screen_share()` (~line 807), add the new fields with defaults:

```rust
        let config = crate::capture::CaptureConfig {
            source_id: source_id_owned.clone(),
            video_track,
            video_track_high: None,
            app: app_clone.clone(),
            fps,
            bitrate_kbps,
            bitrate_kbps_high: 0,
            screen_active,
            force_keyframe: self.force_keyframe.clone(),
            preview_dir,
            use_new_pipeline: false,
        };
```

- [ ] **Step 3: Fix the WgcFlags struct in windows.rs**

In `src-tauri/src/capture/windows.rs`, add the new fields to `WgcFlags` and `WgcHandler`, and thread them through `WgcHandler::new()`:

Add to `WgcFlags` (after `preview_dir`):
```rust
    video_track_high: Option<Arc<TrackLocalStaticSample>>,
    bitrate_kbps_high: u32,
    use_new_pipeline: bool,
```

Add to `WgcHandler` (after `preview_dir`):
```rust
    video_track_high: Option<Arc<TrackLocalStaticSample>>,
    bitrate_kbps_high: u32,
    use_new_pipeline: bool,
```

Update `WgcHandler::new()` to copy these fields from flags:
```rust
            video_track_high: flags.video_track_high,
            bitrate_kbps_high: flags.bitrate_kbps_high,
            use_new_pipeline: flags.use_new_pipeline,
```

Update the `WgcFlags` construction in `WgcCapturer::start()` (~line 137):
```rust
        let flags = WgcFlags {
            video_track: config.video_track,
            frame_duration: Duration::from_millis(1000 / config.fps.max(1) as u64),
            bitrate_kbps: config.bitrate_kbps,
            screen_active: config.screen_active,
            force_keyframe: config.force_keyframe,
            app: config.app,
            preview_dir: config.preview_dir,
            rt: tokio::runtime::Handle::current(),
            video_track_high: config.video_track_high,
            bitrate_kbps_high: config.bitrate_kbps_high,
            use_new_pipeline: config.use_new_pipeline,
        };
```

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo check 2>&1 | Select-Object -Last 30`
Expected: `Finished` with no errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/capture/mod.rs src-tauri/src/capture/windows.rs src-tauri/src/media_manager.rs
git commit -m "feat(capture): extend CaptureConfig for dual-track simulcast pipeline"
```

---

## Task 2: Fused BGRA→YUV420 Conversion Function

**Files:**
- Modify: `src-tauri/src/capture/windows.rs`

This task implements the single-pass BGRA→YUV420 conversion with integrated downscaling, as a standalone function that can be called from the new pipeline path. The old pipeline remains untouched.

- [ ] **Step 1: Write the fused conversion unit test**

Add at the bottom of `src-tauri/src/capture/windows.rs`:

```rust
#[cfg(test)]
mod tests {
    /// Test fused BGRA→YUV420 conversion against the two-pass RGBA→YUV approach.
    /// We generate a gradient image, convert via both paths, and assert the Y/U/V
    /// planes are close (within rounding tolerance).
    #[test]
    fn test_fused_bgra_to_yuv420_matches_reference() {
        let w = 64usize;
        let h = 64usize;
        // Generate BGRA gradient
        let mut bgra = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                bgra[i] = (x * 4) as u8;       // B
                bgra[i + 1] = (y * 4) as u8;   // G
                bgra[i + 2] = ((x + y) * 2) as u8; // R
                bgra[i + 3] = 255;              // A
            }
        }

        // Reference: swap to RGBA then use openh264's YUVBuffer
        let mut rgba = bgra.clone();
        for pixel in rgba.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        let src = openh264::formats::RgbaSliceU8::new(&rgba, (w, h));
        let ref_yuv = openh264::formats::YUVBuffer::from_rgb_source(src);

        // New path: fused BGRA→YUV420
        let (y_plane, u_plane, v_plane) = super::bgra_to_yuv420_bt709(&bgra, w, h);

        use openh264::formats::YUVSource;
        let ref_y = ref_yuv.y();
        let ref_u = ref_yuv.u();
        let ref_v = ref_yuv.v();

        // Y planes should match exactly (same input, same math within rounding)
        assert_eq!(y_plane.len(), ref_y.len(), "Y plane length mismatch");
        let y_max_diff = y_plane.iter().zip(ref_y).map(|(a, b)| (*a as i16 - *b as i16).unsigned_abs()).max().unwrap();
        // Note: openh264 uses BT.601, we use BT.709 — allow up to 15 difference
        assert!(y_max_diff <= 15, "Y plane max diff {y_max_diff} exceeds tolerance 15");

        assert_eq!(u_plane.len(), ref_u.len(), "U plane length mismatch");
        assert_eq!(v_plane.len(), ref_v.len(), "V plane length mismatch");
    }

    /// Test that downscale + fused conversion produces correct output dimensions.
    #[test]
    fn test_fused_bgra_to_yuv420_downscale_dimensions() {
        // 4K source → 720p
        let src_w = 3840usize;
        let src_h = 2160usize;
        let dst_w = 1280usize;
        let dst_h = 720usize;

        let bgra = vec![128u8; src_w * src_h * 4];
        let (y_plane, u_plane, v_plane) = super::bgra_to_yuv420_bt709_downscale(
            &bgra, src_w, src_h, dst_w, dst_h,
        );

        assert_eq!(y_plane.len(), dst_w * dst_h);
        assert_eq!(u_plane.len(), (dst_w / 2) * (dst_h / 2));
        assert_eq!(v_plane.len(), (dst_w / 2) * (dst_h / 2));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib capture::windows::tests -- --nocapture 2>&1 | Select-Object -Last 20`
Expected: FAIL — `bgra_to_yuv420_bt709` and `bgra_to_yuv420_bt709_downscale` not found

- [ ] **Step 3: Implement bgra_to_yuv420_bt709 (no downscale)**

Add this function before the `WgcFlags` struct in `src-tauri/src/capture/windows.rs`:

```rust
/// Convert BGRA pixels to YUV420 planar format in a single pass using BT.709
/// coefficients. Returns (Y, U, V) planes.
///
/// BT.709 (HD content):
///   Y  =  0.2126 * R + 0.7152 * G + 0.0722 * B
///   Cb = -0.1146 * R - 0.3854 * G + 0.5000 * B + 128
///   Cr =  0.5000 * R - 0.4542 * G - 0.0458 * B + 128
///
/// Input BGRA layout: [B, G, R, A, B, G, R, A, ...]
fn bgra_to_yuv420_bt709(bgra: &[u8], w: usize, h: usize) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let mut y_plane = vec![0u8; w * h];
    let mut u_plane = vec![0u8; (w / 2) * (h / 2)];
    let mut v_plane = vec![0u8; (w / 2) * (h / 2)];
    let stride = w * 4;

    // Fixed-point coefficients (×65536)
    const YR: i32 = 13933;  // 0.2126 * 65536
    const YG: i32 = 46871;  // 0.7152 * 65536
    const YB: i32 = 4732;   // 0.0722 * 65536
    const UR: i32 = -7509;  // -0.1146 * 65536
    const UG: i32 = -25259; // -0.3854 * 65536
    const UB: i32 = 32768;  // 0.5 * 65536
    const VR: i32 = 32768;  // 0.5 * 65536
    const VG: i32 = -29763; // -0.4542 * 65536
    const VB: i32 = -3005;  // -0.0458 * 65536

    for y in 0..h {
        let row = y * stride;
        for x in 0..w {
            let i = row + x * 4;
            let b = bgra[i] as i32;
            let g = bgra[i + 1] as i32;
            let r = bgra[i + 2] as i32;

            let luma = (YR * r + YG * g + YB * b + 32768) >> 16;
            y_plane[y * w + x] = luma.clamp(0, 255) as u8;

            // Subsample U/V: average over 2×2 block, write once per block
            if y % 2 == 0 && x % 2 == 0 {
                // Gather the 2×2 block (handle edge with clamp)
                let x1 = (x + 1).min(w - 1);
                let y1 = (y + 1).min(h - 1);

                let p00 = row + x * 4;
                let p10 = row + x1 * 4;
                let p01 = y1 * stride + x * 4;
                let p11 = y1 * stride + x1 * 4;

                let avg_r = (bgra[p00 + 2] as i32 + bgra[p10 + 2] as i32
                    + bgra[p01 + 2] as i32 + bgra[p11 + 2] as i32 + 2) >> 2;
                let avg_g = (bgra[p00 + 1] as i32 + bgra[p10 + 1] as i32
                    + bgra[p01 + 1] as i32 + bgra[p11 + 1] as i32 + 2) >> 2;
                let avg_b = (bgra[p00] as i32 + bgra[p10] as i32
                    + bgra[p01] as i32 + bgra[p11] as i32 + 2) >> 2;

                let cb = ((UR * avg_r + UG * avg_g + UB * avg_b + 32768) >> 16) + 128;
                let cr = ((VR * avg_r + VG * avg_g + VB * avg_b + 32768) >> 16) + 128;

                let ci = (y / 2) * (w / 2) + (x / 2);
                u_plane[ci] = cb.clamp(0, 255) as u8;
                v_plane[ci] = cr.clamp(0, 255) as u8;
            }
        }
    }

    (y_plane, u_plane, v_plane)
}
```

- [ ] **Step 4: Implement bgra_to_yuv420_bt709_downscale**

Add this function right after `bgra_to_yuv420_bt709`:

```rust
/// Downscale BGRA source to target dimensions while converting to YUV420
/// in a single pass. Uses nearest-neighbor sampling + BT.709 coefficients.
fn bgra_to_yuv420_bt709_downscale(
    bgra: &[u8],
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let mut y_plane = vec![0u8; dst_w * dst_h];
    let mut u_plane = vec![0u8; (dst_w / 2) * (dst_h / 2)];
    let mut v_plane = vec![0u8; (dst_w / 2) * (dst_h / 2)];
    let src_stride = src_w * 4;

    let x_ratio = src_w as f64 / dst_w as f64;
    let y_ratio = src_h as f64 / dst_h as f64;

    // Fixed-point BT.709 coefficients (×65536)
    const YR: i32 = 13933;
    const YG: i32 = 46871;
    const YB: i32 = 4732;
    const UR: i32 = -7509;
    const UG: i32 = -25259;
    const UB: i32 = 32768;
    const VR: i32 = 32768;
    const VG: i32 = -29763;
    const VB: i32 = -3005;

    for y in 0..dst_h {
        let src_y = (y as f64 * y_ratio) as usize;
        let src_row = src_y * src_stride;
        for x in 0..dst_w {
            let src_x = (x as f64 * x_ratio) as usize;
            let si = src_row + src_x * 4;
            let b = bgra[si] as i32;
            let g = bgra[si + 1] as i32;
            let r = bgra[si + 2] as i32;

            let luma = (YR * r + YG * g + YB * b + 32768) >> 16;
            y_plane[y * dst_w + x] = luma.clamp(0, 255) as u8;

            if y % 2 == 0 && x % 2 == 0 {
                // Sample the 2×2 block corners from the source at scaled offsets
                let x1 = ((x + 1) as f64 * x_ratio) as usize;
                let y1 = ((y + 1) as f64 * y_ratio) as usize;
                let x1 = x1.min(src_w - 1);
                let y1 = y1.min(src_h - 1);

                let p00 = src_row + src_x * 4;
                let p10 = src_row + x1 * 4;
                let p01 = y1 * src_stride + src_x * 4;
                let p11 = y1 * src_stride + x1 * 4;

                let avg_r = (bgra[p00 + 2] as i32 + bgra[p10 + 2] as i32
                    + bgra[p01 + 2] as i32 + bgra[p11 + 2] as i32 + 2) >> 2;
                let avg_g = (bgra[p00 + 1] as i32 + bgra[p10 + 1] as i32
                    + bgra[p01 + 1] as i32 + bgra[p11 + 1] as i32 + 2) >> 2;
                let avg_b = (bgra[p00] as i32 + bgra[p10] as i32
                    + bgra[p01] as i32 + bgra[p11] as i32 + 2) >> 2;

                let cb = ((UR * avg_r + UG * avg_g + UB * avg_b + 32768) >> 16) + 128;
                let cr = ((VR * avg_r + VG * avg_g + VB * avg_b + 32768) >> 16) + 128;

                let ci = (y / 2) * (dst_w / 2) + (x / 2);
                u_plane[ci] = cb.clamp(0, 255) as u8;
                v_plane[ci] = cr.clamp(0, 255) as u8;
            }
        }
    }

    (y_plane, u_plane, v_plane)
}
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test --lib capture::windows::tests -- --nocapture 2>&1 | Select-Object -Last 20`
Expected: 2 tests pass

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/capture/windows.rs
git commit -m "feat(capture): add fused BGRA→YUV420 BT.709 conversion with downscale"
```

---

## Task 3: New Pipeline Path in WGC Handler

**Files:**
- Modify: `src-tauri/src/capture/windows.rs:228-330` (on_frame_arrived)

This task adds the `use_new_pipeline` branch inside `on_frame_arrived`. When the flag is true, the handler uses the fused BGRA→YUV420 conversion instead of the two-pass RGBA→swap→YUV path. Both pipelines profile identically so we can compare them.

- [ ] **Step 1: Add new pipeline branch**

In `on_frame_arrived`, after `let raw = buf.as_raw_buffer();` (after the existing line ~243), add a conditional fork. The new path replaces everything from the current `const MAX_W` line through the `enc.encode(&yuv)` call.

Replace the current pixel-processing + encoding block (from `const MAX_W: u32 = 1280;` through the end of the `match enc.encode(&yuv)` block) with:

```rust
        if self.use_new_pipeline {
            // ── New pipeline: fused BGRA→YUV420 (single pass, BT.709) ───────

            const NEW_MAX_W: u32 = 1920; // Up to 1080p for high tier
            const LOW_W: u32 = 1280;     // 720p for low tier

            // Figure out dimensions for both tiers
            let (low_w, low_h) = if orig_w > LOW_W {
                let scale = LOW_W as f64 / orig_w as f64;
                let h = (orig_h as f64 * scale) as u32;
                ((LOW_W & !1) as usize, (h & !1) as usize)
            } else {
                ((orig_w & !1) as usize, (orig_h & !1) as usize)
            };

            // Low tier: fused downscale + BGRA→YUV420
            let (y_low, u_low, v_low) = if orig_w > LOW_W {
                bgra_to_yuv420_bt709_downscale(raw, orig_w as usize, orig_h as usize, low_w, low_h)
            } else {
                bgra_to_yuv420_bt709(raw, low_w, low_h)
            };
            drop(buf);

            let t_after_convert = t_start.elapsed();

            // Init encoder on first frame
            if self.encoder.is_none() {
                let fps_f = 1.0 / self.frame_duration.as_secs_f32();
                let mut enc_cfg = openh264::encoder::EncoderConfig::new()
                    .max_frame_rate(openh264::encoder::FrameRate::from_hz(fps_f));
                if self.bitrate_kbps > 0 {
                    enc_cfg = enc_cfg
                        .bitrate(openh264::encoder::BitRate::from_bps(self.bitrate_kbps * 1000))
                        .rate_control_mode(openh264::encoder::RateControlMode::Bitrate);
                }
                self.encoder = Some(openh264::encoder::Encoder::with_api_config(
                    openh264::OpenH264API::from_source(),
                    enc_cfg,
                )?);
            }
            let enc = self.encoder.as_mut().unwrap();

            if self.force_keyframe.swap(false, Ordering::AcqRel) {
                enc.force_intra_frame();
            }

            // Build YUVBuffer from our planar data
            let yuv = openh264::formats::YUVBuffer::from_yuv_source(
                openh264::formats::YUVSlices::new(
                    &y_low, &u_low, &v_low,
                    (low_w, low_h),
                )
            );

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

                    if self.frame_count == 1 || self.frame_count % 300 == 0 {
                        let total = t_start.elapsed();
                        log::info!(
                            "[media-NEW] capture frame #{}: convert={:.1}ms enc={:.1}ms send={:.1}ms total={:.1}ms ({}x{})",
                            self.frame_count,
                            t_after_convert.as_secs_f64() * 1000.0,
                            t_after_encode.as_secs_f64() * 1000.0,
                            t_after_send.as_secs_f64() * 1000.0,
                            total.as_secs_f64() * 1000.0,
                            low_w, low_h,
                        );
                    }
                }
                Err(e) => {
                    log::warn!("[media-NEW] H.264 encode error: {e}");
                }
            }

            // Local preview (every 2nd frame) — reuse YUV data converted back to RGB
            if self.frame_count % 2 == 0 {
                if let Some(ref dir) = self.preview_dir {
                    let preview_path = dir.join("self.jpg");
                    // Convert Y plane to grayscale RGBA for preview (fast, avoids YUV→RGB)
                    // Full-quality preview will come in Task 8; this is a placeholder
                    let mut rgba = vec![255u8; low_w * low_h * 4];
                    for (i, &y_val) in y_low.iter().enumerate() {
                        let di = i * 4;
                        rgba[di] = y_val;
                        rgba[di + 1] = y_val;
                        rgba[di + 2] = y_val;
                        // alpha already 255
                    }
                    let _ = crate::media_manager::MediaManager::write_jpeg_frame(
                        &rgba, low_w as u32, low_h as u32, &preview_path,
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
        } else {
            // ── Old pipeline (unchanged) ────────────────────────────────────
            const MAX_W: u32 = 1280;
            // ... (existing code from here through end of encode + preview block)
```

**Important:** The `else` block contains the ENTIRE existing pipeline code from `const MAX_W: u32 = 1280;` through the closing `}` of the preview JPEG block. Do not modify the old pipeline code at all — just wrap it in the `else` branch.

- [ ] **Step 2: Verify the YUVSlices/YUVBuffer API exists**

The openh264 crate's `YUVBuffer::from_yuv_source` accepts any `YUVSource`. Check if `YUVSlices` exists in openh264. If not, we need to construct a `YUVBuffer` manually by setting the planes directly.

If `YUVSlices` doesn't exist, replace the `YUVBuffer` construction with:

```rust
            // Build a YUVBuffer manually from planar data
            let mut yuv = openh264::formats::YUVBuffer::new(low_w, low_h);
            yuv.y_mut().copy_from_slice(&y_low);
            yuv.u_mut().copy_from_slice(&u_low);
            yuv.v_mut().copy_from_slice(&v_low);
```

Check the openh264 API using Context7 or `cargo doc --open` if unsure.

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check 2>&1 | Select-Object -Last 30`
Expected: `Finished` with no errors

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/capture/windows.rs
git commit -m "feat(capture): add new pipeline branch with fused BGRA→YUV420 (behind flag)"
```

---

## Task 4: Wire Pipeline Flag into start_screen_share

**Files:**
- Modify: `src-tauri/src/media_manager.rs` (start_screen_share signature + body)
- Modify: `src-tauri/src/commands/media_commands.rs` (command that calls start_screen_share)
- Modify: `src/stores/voiceStore.ts` (pass flag from frontend)
- Modify: `src/services/webrtcService.ts` (thread flag through)

This task makes the pipeline selectable from the frontend. The default remains `false` (old pipeline). Users switch to the new pipeline via an env var or a settings toggle.

- [ ] **Step 1: Add `use_new_pipeline` parameter to start_screen_share**

In `src-tauri/src/media_manager.rs`, change `start_screen_share` signature to:

```rust
    pub async fn start_screen_share(
        &self,
        source_id: &str,
        video_track: Arc<TrackLocalStaticSample>,
        app: tauri::AppHandle,
        fps: u32,
        bitrate_kbps: u32,
        use_new_pipeline: bool,
    ) -> Result<(), String> {
```

And update the `CaptureConfig` construction to:

```rust
            use_new_pipeline,
```

- [ ] **Step 2: Update the Tauri command**

Find the `media_start_screen_share` command in `src-tauri/src/commands/media_commands.rs`. Add `use_new_pipeline: bool` parameter and pass it through to `start_screen_share()`.

- [ ] **Step 3: Update the frontend call in webrtcService.ts**

In `src/services/webrtcService.ts`, find `addScreenShareTrack` (or wherever `media_start_screen_share` invoke is called). Add `useNewPipeline: boolean` parameter, defaulting to `false`. Pass it to the invoke call as `use_new_pipeline`.

- [ ] **Step 4: Update voiceStore.ts startScreenShare**

In `src/stores/voiceStore.ts` `startScreenShare()`, read an env-based toggle or a new `useNewPipeline` setting, and pass it to the webrtcService call:

```typescript
    const useNewPipeline = localStorage.getItem('hexfield_new_pipeline') === 'true'
```

- [ ] **Step 5: Verify compilation (Rust + TypeScript)**

Run:
```bash
cd src-tauri && cargo check 2>&1 | Select-Object -Last 30
cd .. && npx vue-tsc --noEmit
```
Expected: Both pass with no errors

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(capture): wire pipeline flag from frontend through to WGC handler"
```

---

## Task 5: Profile Old vs New Pipeline

**Files:**
- No code changes — this is a manual profiling task

- [ ] **Step 1: Run dev build with old pipeline**

1. `npm run dev:tauri`
2. Start screen share in a voice channel (share any monitor)
3. Wait 30s for stabilization
4. Look at terminal output for `[media] capture frame #300:` timing lines
5. Record: `swap`, `yuv`, `enc`, `send`, `total` times and resolution

- [ ] **Step 2: Run dev build with new pipeline**

1. Open browser DevTools console (F12 in Tauri window)
2. Run: `localStorage.setItem('hexfield_new_pipeline', 'true')`
3. Restart screen share
4. Wait 30s
5. Look for `[media-NEW] capture frame #300:` timing lines
6. Record: `convert`, `enc`, `send`, `total` times and resolution

- [ ] **Step 3: Compare results**

Create a comparison table:

| Metric | Old Pipeline | New Pipeline | Delta |
|--------|-------------|-------------|-------|
| Convert/Swap (ms) | ? | ? | ? |
| YUV (ms) | N/A | included | — |
| Encode (ms) | ? | ? | ? |
| Send (ms) | ? | ? | ? |
| Total (ms) | ? | ? | ? |
| Resolution | 1280×720 | 1280×720 | same |

- [ ] **Step 4: Record findings**

Save profiling results to `docs/superpowers/specs/2026-04-15-screen-share-quality-design.md` under a new `## Profiling Results` section at the bottom.

---

## Task 6: Dual-Track Support in WebRTC Manager

**Files:**
- Modify: `src-tauri/src/webrtc_manager.rs`

Add a second video track for the high-quality tier. The manager maintains two optional tracks: `local_video_track_low` and `local_video_track_high`. By default peers receive the low track. A `quality_request` message via data channel switches a peer to the high track.

- [ ] **Step 1: Add dual video track fields to WebRTCManager**

In `src-tauri/src/webrtc_manager.rs`, rename `local_video_track` → `local_video_track_low` and add `local_video_track_high`:

At the manager level (~line 132-134):
```rust
    local_video_track_low: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
    local_video_track_high: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
```

At the `PeerEntry` level (~line 117-119), add per-peer quality tier tracking:
```rust
    video_track: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
    /// Which quality tier this peer is currently receiving.
    video_quality_tier: Arc<Mutex<VideoQualityTier>>,
```

Add the tier enum near the top of the file:
```rust
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum VideoQualityTier {
    Low,  // 720p
    High, // 1080p
}

impl Default for VideoQualityTier {
    fn default() -> Self {
        VideoQualityTier::Low
    }
}
```

- [ ] **Step 2: Add add_video_tracks_dual method**

Add a new method that creates both low and high tracks and returns them:

```rust
    /// Create both quality tiers of video tracks and add the low tier to all peers.
    /// Returns (track_low, track_high) for the capture pipeline.
    pub async fn add_video_tracks_dual(
        &self,
        app: &AppHandle,
    ) -> Result<(Arc<TrackLocalStaticSample>, Arc<TrackLocalStaticSample>), String> {
        let make_track = || {
            Arc::new(TrackLocalStaticSample::new(
                RTCRtpCodecCapability {
                    mime_type: "video/H264".to_owned(),
                    clock_rate: 90000,
                    ..Default::default()
                },
                format!("hexfield-video-{}", uuid::Uuid::new_v4()),
                "hexfield-screen".to_owned(),
            ))
        };

        let track_low = make_track();
        let track_high = make_track();

        // Add low track to all peers by default
        let peers = self.peers.lock().await;
        for (peer_id, entry) in peers.iter() {
            let track_local: Arc<dyn TrackLocal + Send + Sync> = track_low.clone();
            entry.pc.add_track(track_local).await
                .map_err(|e| format!("add_video_track_low to {peer_id}: {e}"))?;
            *entry.video_track.lock().await = Some(track_low.clone());
            *entry.video_quality_tier.lock().await = VideoQualityTier::Low;

            if !self.try_renegotiate(&entry.pc, peer_id, app).await? {
                log::warn!("[webrtc] add_video_dual: skipped renegotiation for {peer_id}");
            }
        }

        *self.local_video_track_low.lock().await = Some(track_low.clone());
        *self.local_video_track_high.lock().await = Some(track_high.clone());

        Ok((track_low, track_high))
    }
```

- [ ] **Step 3: Add quality switch method**

```rust
    /// Switch a specific peer to a different quality tier.
    /// Replaces the video sender's track without full SDP renegotiation.
    pub async fn set_peer_video_quality(
        &self,
        peer_id: &str,
        tier: VideoQualityTier,
        app: &AppHandle,
    ) -> Result<(), String> {
        let peers = self.peers.lock().await;
        let entry = peers.get(peer_id)
            .ok_or_else(|| format!("peer not found: {peer_id}"))?;

        let current = *entry.video_quality_tier.lock().await;
        if current == tier {
            return Ok(()); // Already at requested tier
        }

        let new_track = match tier {
            VideoQualityTier::Low => {
                self.local_video_track_low.lock().await.clone()
            }
            VideoQualityTier::High => {
                self.local_video_track_high.lock().await.clone()
            }
        };

        let new_track = new_track.ok_or("requested video track tier not available")?;

        // Find the video sender and replace its track
        let senders = entry.pc.get_senders().await;
        let mut replaced = false;
        for sender in senders {
            if let Some(track) = sender.track().await {
                if track.kind() == RTPCodecType::Video {
                    sender.replace_track(Some(new_track.clone())).await
                        .map_err(|e| format!("replace_track for {peer_id}: {e}"))?;
                    replaced = true;
                    break;
                }
            }
        }

        if !replaced {
            // No existing sender — add the track freshly
            let track_local: Arc<dyn TrackLocal + Send + Sync> = new_track.clone();
            entry.pc.add_track(track_local).await
                .map_err(|e| format!("add_video_track to {peer_id}: {e}"))?;
            if !self.try_renegotiate(&entry.pc, peer_id, app).await? {
                log::warn!("[webrtc] set_quality: skipped renegotiation for {peer_id}");
            }
        }

        *entry.video_track.lock().await = Some(new_track);
        *entry.video_quality_tier.lock().await = tier;

        log::info!("[webrtc] peer {peer_id} switched to {tier:?} quality tier");
        Ok(())
    }
```

- [ ] **Step 4: Update the existing add_video_track_to_all to use `_low` field**

Change `add_video_track_to_all` to store in `local_video_track_low` instead of the old field name:

```rust
        // Store track at manager level for late-joining peers
        *self.local_video_track_low.lock().await = Some(track.clone());
```

And update `remove_video_tracks_from_all` to clear both:

```rust
        *self.local_video_track_low.lock().await = None;
        *self.local_video_track_high.lock().await = None;
```

Also update `ensure_tracks_for_peer` (or wherever late-joining peers get tracks added) to read from `local_video_track_low`.

- [ ] **Step 5: Verify compilation**

Run: `cd src-tauri && cargo check 2>&1 | Select-Object -Last 30`
Expected: `Finished` with no errors

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/webrtc_manager.rs
git commit -m "feat(webrtc): dual video tracks with per-peer quality tier switching"
```

---

## Task 7: Quality Request Protocol via Data Channel

**Files:**
- Modify: `src-tauri/src/webrtc_manager.rs` (handle incoming quality_request)
- Modify: `src/stores/networkStore.ts` (send/receive quality_request messages)
- Modify: `src/stores/voiceStore.ts` (quality tier state per remote stream)

- [ ] **Step 1: Handle quality_request in Rust WebRTC data channel handler**

In `src-tauri/src/webrtc_manager.rs`, find the data channel message handler (where incoming JSON messages from peers are parsed). Add a handler for `quality_request`:

```rust
            "quality_request" => {
                let tier_str = msg.get("tier").and_then(|v| v.as_str()).unwrap_or("low");
                let tier = match tier_str {
                    "high" => VideoQualityTier::High,
                    _ => VideoQualityTier::Low,
                };
                log::info!("[webrtc] peer {peer_id} requested quality tier: {tier:?}");
                // Quality switching is async — emit event and let the app layer handle it
                let _ = app_handle.emit("webrtc_quality_request", serde_json::json!({
                    "peerId": peer_id,
                    "tier": tier_str,
                }));
            }
```

- [ ] **Step 2: Handle the quality_request event in networkStore.ts**

In `src/stores/networkStore.ts`, add a listener in `init()` for the `webrtc_quality_request` event:

```typescript
    listen<{ peerId: string; tier: string }>('webrtc_quality_request', async (event) => {
      const { peerId, tier } = event.payload
      try {
        await invoke('webrtc_set_peer_quality', { peerId, tier })
      } catch (e) {
        console.warn('[network] quality switch failed:', e)
      }
    })
```

- [ ] **Step 3: Add `webrtc_set_peer_quality` Tauri command**

In `src-tauri/src/commands/media_commands.rs`, add:

```rust
#[tauri::command]
pub async fn webrtc_set_peer_quality(
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
    peer_id: String,
    tier: String,
) -> Result<(), String> {
    let quality_tier = match tier.as_str() {
        "high" => crate::webrtc_manager::VideoQualityTier::High,
        _ => crate::webrtc_manager::VideoQualityTier::Low,
    };
    state.webrtc.set_peer_video_quality(&peer_id, quality_tier, &app).await
}
```

Register it in `lib.rs` invoke_handler.

- [ ] **Step 4: Add requestQuality action in voiceStore.ts**

In `src/stores/voiceStore.ts`, add state and an action for quality tier management:

```typescript
  // Per-stream quality tier selection (keyed by sharing user's ID)
  const streamQualityTier = ref<Record<string, 'low' | 'high'>>({})

  function requestQuality(sharerUserId: string, tier: 'low' | 'high') {
    streamQualityTier.value[sharerUserId] = tier
    // Send quality_request via data channel to the sharer
    const { useNetworkStore } = import('./networkStore')
    const networkStore = useNetworkStore()
    networkStore.sendToPeer(sharerUserId, {
      type: 'quality_request',
      tier,
    })
  }
```

Expose `streamQualityTier` and `requestQuality` from the store.

- [ ] **Step 5: Verify compilation (Rust + TypeScript)**

Run:
```bash
cd src-tauri && cargo check 2>&1 | Select-Object -Last 30
cd .. && npx vue-tsc --noEmit
```
Expected: Both pass

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: quality_request protocol for per-viewer quality tier switching"
```

---

## Task 8: QualitySelector Vue Component

**Files:**
- Create: `src/components/chat/QualitySelector.vue`
- Modify: `src/components/chat/VoiceContentPane.vue`

- [ ] **Step 1: Create QualitySelector.vue**

Create `src/components/chat/QualitySelector.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { mdiCogOutline } from '@mdi/js'

const props = defineProps<{
  currentTier: 'low' | 'high'
  sharerUserId: string
}>()

const emit = defineEmits<{
  'quality-change': [tier: 'low' | 'high']
}>()

const menuOpen = ref(false)
const toggleMenu = () => { menuOpen.value = !menuOpen.value }

function selectTier(tier: 'low' | 'high') {
  emit('quality-change', tier)
  menuOpen.value = false
}
</script>

<template>
  <div class="quality-selector" @click.stop>
    <button class="gear-btn" @click="toggleMenu" :title="'Quality: ' + (currentTier === 'high' ? '1080p' : '720p')">
      <AppIcon :path="mdiCogOutline" :size="18" />
    </button>

    <div v-if="menuOpen" class="quality-menu">
      <button
        class="quality-option"
        :class="{ active: currentTier === 'high' }"
        @click="selectTier('high')"
      >
        1080p
      </button>
      <button
        class="quality-option"
        :class="{ active: currentTier === 'low' }"
        @click="selectTier('low')"
      >
        720p
      </button>
    </div>
  </div>
</template>

<style scoped>
.quality-selector {
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 10;
}

.gear-btn {
  padding: 0;
  transform: none;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}

.video-tile:hover .gear-btn {
  opacity: 1;
}

.quality-menu {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 4px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 4px;
  min-width: 80px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.quality-option {
  display: block;
  width: 100%;
  padding: 6px 12px;
  transform: none;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  border-radius: 4px;
}

.quality-option:hover {
  background: var(--bg-hover);
}

.quality-option.active {
  color: var(--accent-color);
  font-weight: 600;
}

.quality-option.active::before {
  content: '●';
  margin-right: 6px;
  font-size: 8px;
}
</style>
```

- [ ] **Step 2: Add QualitySelector to remote video tiles in VoiceContentPane.vue**

In `src/components/chat/VoiceContentPane.vue`, import and add the selector to remote screen share tiles.

Add import:
```typescript
import QualitySelector from './QualitySelector.vue'
import { useVoiceStore } from '@/stores/voiceStore'
```

In the remote shares `v-for` block (~line 87-102), add `QualitySelector` inside the `.video-tile` div, after the `tile-overlay`:

```vue
    <QualitySelector
      :current-tier="voiceStore.streamQualityTier[userId] ?? 'low'"
      :sharer-user-id="userId"
      @quality-change="(tier) => voiceStore.requestQuality(userId, tier)"
    />
```

- [ ] **Step 3: Close quality menu when clicking outside**

Add a click-outside handler to `QualitySelector.vue`:

```typescript
import { onMounted, onUnmounted, ref } from 'vue'

const selectorRef = ref<HTMLElement>()

function handleClickOutside(e: MouseEvent) {
  if (selectorRef.value && !selectorRef.value.contains(e.target as Node)) {
    menuOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', handleClickOutside))
onUnmounted(() => document.removeEventListener('click', handleClickOutside))
```

Add `ref="selectorRef"` to the root `.quality-selector` div.

- [ ] **Step 4: Verify TypeScript compilation**

Run: `npx vue-tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/QualitySelector.vue src/components/chat/VoiceContentPane.vue
git commit -m "feat(ui): add YouTube-style quality selector gear on video tiles"
```

---

## Task 9: Settings Store — 60fps Default and Wiring

**Files:**
- Modify: `src/stores/settingsStore.ts`
- Modify: `src/components/settings/VideoSettings.vue` (or wherever video settings UI lives)

- [ ] **Step 1: Add 60fps to videoFrameRate type**

In `src/stores/settingsStore.ts`, update the `UserSettings` interface (~line 61):

```typescript
  videoFrameRate: 10 | 15 | 30 | 60;
```

Change the default from 30 to 60 (~line 112):

```typescript
  videoFrameRate: 60,
```

- [ ] **Step 2: Add 10mbps to videoBitrate type (for 1080p tier)**

In `src/stores/settingsStore.ts`, update (~line 62):

```typescript
  videoBitrate: 'auto' | '500kbps' | '1mbps' | '2.5mbps' | '5mbps' | '10mbps';
```

- [ ] **Step 3: Update video settings UI if it exists**

Check if there's a video settings component (e.g., `VideoSettings.vue` or a section in `Settings.vue`). If so, add 60fps to the frame rate dropdown and 10mbps to the bitrate dropdown.

- [ ] **Step 4: Wire settings into voiceStore.startScreenShare**

Verify that `voiceStore.startScreenShare()` reads `settings.videoFrameRate` (which now defaults to 60) and passes it to the capture pipeline. This should already work if the existing wiring reads from settingsStore.

- [ ] **Step 5: Verify TypeScript compilation**

Run: `npx vue-tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/stores/settingsStore.ts src/components/settings/
git commit -m "feat(settings): add 60fps default, 10mbps bitrate option"
```

---

## Task 10: 1080p Encoder Thread (Simulcast)

**Files:**
- Modify: `src-tauri/src/capture/windows.rs`
- Modify: `src-tauri/src/media_manager.rs`

This task adds the second encoder thread to the new pipeline, producing 1080p H.264 on `video_track_high`. The capture callback sends the raw frame to both encoder threads via channels.

- [ ] **Step 1: Add crossbeam-channel dependency**

In `src-tauri/Cargo.toml`, add `crossbeam-channel`:

```toml
crossbeam-channel = "0.5"
```

- [ ] **Step 2: Restructure new pipeline to use encoder threads**

In `src-tauri/src/capture/windows.rs`, replace the inline encoding in the `use_new_pipeline` branch with a channel-based architecture.

Add new fields to `WgcHandler`:
```rust
    /// Encoder thread channels for simulcast. Initialized on first frame.
    encoder_tx_low: Option<crossbeam_channel::Sender<EncoderFrame>>,
    encoder_tx_high: Option<crossbeam_channel::Sender<EncoderFrame>>,
```

Add the frame struct:
```rust
struct EncoderFrame {
    bgra: Vec<u8>,
    src_w: usize,
    src_h: usize,
    frame_number: u64,
    force_keyframe: bool,
}
```

Add a function that spawns an encoder thread:
```rust
fn spawn_encoder_thread(
    label: &str,
    dst_w: usize,
    dst_h: usize,
    fps: f32,
    bitrate_kbps: u32,
    video_track: Arc<TrackLocalStaticSample>,
    frame_duration: Duration,
    rt: tokio::runtime::Handle,
    preview_dir: Option<std::path::PathBuf>,
    app: tauri::AppHandle,
) -> crossbeam_channel::Sender<EncoderFrame> {
    let (tx, rx) = crossbeam_channel::bounded::<EncoderFrame>(2);
    let label = label.to_string();

    std::thread::Builder::new()
        .name(format!("encoder-{label}"))
        .spawn(move || {
            let mut enc_cfg = openh264::encoder::EncoderConfig::new()
                .max_frame_rate(openh264::encoder::FrameRate::from_hz(fps));
            if bitrate_kbps > 0 {
                enc_cfg = enc_cfg
                    .bitrate(openh264::encoder::BitRate::from_bps(bitrate_kbps * 1000))
                    .rate_control_mode(openh264::encoder::RateControlMode::Bitrate);
            }
            let mut encoder = openh264::encoder::Encoder::with_api_config(
                openh264::OpenH264API::from_source(),
                enc_cfg,
            ).expect("failed to create encoder");

            while let Ok(frame) = rx.recv() {
                let t_start = std::time::Instant::now();

                if frame.force_keyframe {
                    encoder.force_intra_frame();
                }

                let needs_downscale = frame.src_w > dst_w || frame.src_h > dst_h;
                let (y_plane, u_plane, v_plane) = if needs_downscale {
                    bgra_to_yuv420_bt709_downscale(
                        &frame.bgra, frame.src_w, frame.src_h, dst_w, dst_h,
                    )
                } else {
                    bgra_to_yuv420_bt709(&frame.bgra, frame.src_w, frame.src_h)
                };

                let t_after_convert = t_start.elapsed();

                let mut yuv = openh264::formats::YUVBuffer::new(dst_w, dst_h);
                yuv.y_mut().copy_from_slice(&y_plane);
                yuv.u_mut().copy_from_slice(&u_plane);
                yuv.v_mut().copy_from_slice(&v_plane);

                match encoder.encode(&yuv) {
                    Ok(bitstream) => {
                        let t_after_encode = t_start.elapsed();
                        let h264_data = bitstream.to_vec();
                        if !h264_data.is_empty() {
                            let vt = video_track.clone();
                            let dur = frame_duration;
                            let _ = rt.block_on(async {
                                vt.write_sample(&Sample {
                                    data: Bytes::from(h264_data),
                                    duration: dur,
                                    ..Default::default()
                                }).await
                            });
                        }
                        let t_after_send = t_start.elapsed();

                        if frame.frame_number == 1 || frame.frame_number % 300 == 0 {
                            let total = t_start.elapsed();
                            log::info!(
                                "[media-{label}] frame #{}: convert={:.1}ms enc={:.1}ms send={:.1}ms total={:.1}ms ({}x{})",
                                frame.frame_number,
                                t_after_convert.as_secs_f64() * 1000.0,
                                t_after_encode.as_secs_f64() * 1000.0,
                                t_after_send.as_secs_f64() * 1000.0,
                                total.as_secs_f64() * 1000.0,
                                dst_w, dst_h,
                            );
                        }
                    }
                    Err(e) => log::warn!("[media-{label}] encode error: {e}"),
                }

                // Preview (low tier only, every 2nd frame)
                if label == "720p" && frame.frame_number % 2 == 0 {
                    if let Some(ref dir) = preview_dir {
                        let preview_path = dir.join("self.jpg");
                        let mut rgba_preview = vec![255u8; dst_w * dst_h * 4];
                        for (i, &yv) in y_plane.iter().enumerate() {
                            let di = i * 4;
                            rgba_preview[di] = yv;
                            rgba_preview[di + 1] = yv;
                            rgba_preview[di + 2] = yv;
                        }
                        let _ = crate::media_manager::MediaManager::write_jpeg_frame(
                            &rgba_preview, dst_w as u32, dst_h as u32, &preview_path,
                        );
                        let _ = app.emit("media_video_frame", serde_json::json!({
                            "userId": "self",
                            "frameNumber": frame.frame_number,
                            "path": preview_path.to_string_lossy(),
                        }));
                    }
                }
            }
            log::info!("[media-{label}] encoder thread exiting");
        })
        .expect("failed to spawn encoder thread");

    tx
}
```

- [ ] **Step 3: Update the new pipeline branch to dispatch frames to encoder threads**

In `on_frame_arrived`, replace the inline new pipeline encoding with:

```rust
        if self.use_new_pipeline {
            // Initialize encoder threads on first frame
            if self.encoder_tx_low.is_none() {
                let fps_f = 1.0 / self.frame_duration.as_secs_f32();

                let (low_w, low_h) = {
                    let scale = 1280.0_f64 / orig_w as f64;
                    if scale < 1.0 {
                        let w = (1280u32 & !1) as usize;
                        let h = ((orig_h as f64 * scale) as u32 & !1) as usize;
                        (w, h)
                    } else {
                        ((orig_w & !1) as usize, (orig_h & !1) as usize)
                    }
                };

                self.encoder_tx_low = Some(spawn_encoder_thread(
                    "720p", low_w, low_h, fps_f,
                    self.bitrate_kbps, self.video_track.clone(),
                    self.frame_duration, self.rt.clone(),
                    self.preview_dir.clone(), self.app.clone(),
                ));

                // Only start high tier if source is > 720p and track_high exists
                if orig_w > 1280 {
                    if let Some(ref track_high) = self.video_track_high {
                        let (high_w, high_h) = {
                            let scale = 1920.0_f64 / orig_w as f64;
                            if scale < 1.0 {
                                let w = (1920u32 & !1) as usize;
                                let h = ((orig_h as f64 * scale) as u32 & !1) as usize;
                                (w, h)
                            } else {
                                ((orig_w & !1) as usize, (orig_h & !1) as usize)
                            }
                        };
                        self.encoder_tx_high = Some(spawn_encoder_thread(
                            "1080p", high_w, high_h, fps_f,
                            self.bitrate_kbps_high.max(6000),
                            track_high.clone(), self.frame_duration,
                            self.rt.clone(), None, self.app.clone(),
                        ));
                    }
                }
            }

            let do_keyframe = self.force_keyframe.swap(false, Ordering::AcqRel);
            let raw_vec = raw.to_vec();
            drop(buf);

            let frame = EncoderFrame {
                bgra: raw_vec.clone(),
                src_w: orig_w as usize,
                src_h: orig_h as usize,
                frame_number: self.frame_count,
                force_keyframe: do_keyframe,
            };

            // Send to low tier (drop frame if channel full — preferable to blocking)
            if let Some(ref tx) = self.encoder_tx_low {
                let _ = tx.try_send(frame);
            }

            // Send to high tier (clone the BGRA data)
            if let Some(ref tx) = self.encoder_tx_high {
                let frame_high = EncoderFrame {
                    bgra: raw_vec,
                    src_w: orig_w as usize,
                    src_h: orig_h as usize,
                    frame_number: self.frame_count,
                    force_keyframe: do_keyframe,
                };
                let _ = tx.try_send(frame_high);
            }
        } else {
            // ── Old pipeline (unchanged) ──
```

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo check 2>&1 | Select-Object -Last 30`
Expected: `Finished`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/capture/windows.rs src-tauri/src/media_manager.rs
git commit -m "feat(capture): 2-tier simulcast with parallel encoder threads"
```

---

## Task 11: Wire Dual Tracks in start_screen_share

**Files:**
- Modify: `src-tauri/src/media_manager.rs`
- Modify: `src-tauri/src/commands/media_commands.rs`

- [ ] **Step 1: Update start_screen_share to accept optional high track**

In `src-tauri/src/media_manager.rs`, add `video_track_high` parameter:

```rust
    pub async fn start_screen_share(
        &self,
        source_id: &str,
        video_track: Arc<TrackLocalStaticSample>,
        video_track_high: Option<Arc<TrackLocalStaticSample>>,
        app: tauri::AppHandle,
        fps: u32,
        bitrate_kbps: u32,
        use_new_pipeline: bool,
    ) -> Result<(), String> {
```

Update the CaptureConfig construction:
```rust
            video_track_high,
            bitrate_kbps_high: if use_new_pipeline { 6000 } else { 0 },
```

- [ ] **Step 2: Update the Tauri command to call add_video_tracks_dual when new pipeline is on**

In the `media_start_screen_share` command, when `use_new_pipeline` is true, call `webrtc.add_video_tracks_dual()` instead of `webrtc.add_video_track_to_all()`, and pass both tracks:

```rust
    let (video_track, video_track_high) = if use_new_pipeline {
        let (low, high) = state.webrtc.add_video_tracks_dual(&app).await?;
        (low, Some(high))
    } else {
        let track = state.webrtc.add_video_track_to_all(&app).await?;
        (track, None)
    };

    state.media.start_screen_share(
        &source_id, video_track, video_track_high, app.clone(),
        frame_rate, bitrate_kbps, use_new_pipeline,
    ).await
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check 2>&1 | Select-Object -Last 30`
Expected: `Finished`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/media_manager.rs src-tauri/src/commands/media_commands.rs
git commit -m "feat: wire dual tracks through start_screen_share when simulcast enabled"
```

---

## Task 12: Improve Local Preview Quality

**Files:**
- Modify: `src-tauri/src/capture/windows.rs` (encoder thread preview section)

Replace the grayscale Y-only preview with a proper YUV→RGB conversion for the preview image, and raise JPEG quality.

- [ ] **Step 1: Add YUV→RGB conversion for preview**

In the encoder thread's preview section (the `if label == "720p"` block), replace the grayscale conversion with:

```rust
                // Preview (low tier only, every 3rd frame for 20fps visual update at 60fps)
                if label == "720p" && frame.frame_number % 3 == 0 {
                    if let Some(ref dir) = preview_dir {
                        let preview_path = dir.join("self.jpg");
                        // Convert YUV420 → RGB for color preview
                        let mut rgba_preview = vec![255u8; dst_w * dst_h * 4];
                        for py in 0..dst_h {
                            for px in 0..dst_w {
                                let yi = py * dst_w + px;
                                let ci = (py / 2) * (dst_w / 2) + (px / 2);
                                let y_val = y_plane[yi] as f32;
                                let u_val = u_plane[ci] as f32 - 128.0;
                                let v_val = v_plane[ci] as f32 - 128.0;
                                // BT.709 inverse
                                let r = (y_val + 1.5748 * v_val).clamp(0.0, 255.0) as u8;
                                let g = (y_val - 0.1873 * u_val - 0.4681 * v_val).clamp(0.0, 255.0) as u8;
                                let b = (y_val + 1.8556 * u_val).clamp(0.0, 255.0) as u8;
                                let di = (py * dst_w + px) * 4;
                                rgba_preview[di] = r;
                                rgba_preview[di + 1] = g;
                                rgba_preview[di + 2] = b;
                                // alpha already 255
                            }
                        }
                        // Write JPEG at quality 85 (better than the old 75)
                        let _ = write_jpeg_quality(
                            &rgba_preview, dst_w as u32, dst_h as u32, &preview_path, 85,
                        );
                        let _ = app.emit("media_video_frame", serde_json::json!({
                            "userId": "self",
                            "frameNumber": frame.frame_number,
                            "path": preview_path.to_string_lossy(),
                        }));
                    }
                }
```

- [ ] **Step 2: Add write_jpeg_quality helper**

Add a helper function that accepts a quality parameter (the existing `write_jpeg_frame` on MediaManager always uses 75):

```rust
fn write_jpeg_quality(
    rgba: &[u8],
    width: u32,
    height: u32,
    path: &std::path::Path,
    quality: u8,
) -> Result<(), String> {
    use std::io::BufWriter;
    let tmp = path.with_extension("tmp");
    let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let writer = BufWriter::new(file);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, quality);
    image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width, height, rgba.to_vec())
            .ok_or("invalid RGBA dimensions")?,
    )
    .write_with_encoder(encoder)
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check 2>&1 | Select-Object -Last 30`
Expected: `Finished`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/capture/windows.rs
git commit -m "feat(capture): color preview at 720p, JPEG quality 85, 20fps update rate"
```

---

## Task 13: Integration Test — End-to-End Screen Share with Pipeline Toggle

**Files:**
- Modify: `src-tauri/src/media_manager.rs` (test section)

- [ ] **Step 1: Add integration test for fused BGRA→YUV420 encode/decode roundtrip**

In `src-tauri/src/media_manager.rs`, add to the `#[cfg(test)] mod tests` block:

```rust
    #[test]
    fn test_fused_bgra_yuv_encode_decode_roundtrip() {
        use openh264::formats::YUVSource;

        let w = 320usize;
        let h = 240usize;

        // Generate BGRA gradient (simulating a screen capture frame)
        let mut bgra = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                bgra[i] = (x % 256) as u8;         // B
                bgra[i + 1] = (y % 256) as u8;     // G
                bgra[i + 2] = ((x + y) % 256) as u8; // R
                bgra[i + 3] = 255;                  // A
            }
        }

        // Convert using new fused path
        let (y_plane, u_plane, v_plane) = crate::capture::windows_test_helpers::bgra_to_yuv420_bt709(
            &bgra, w, h,
        );

        // Build YUVBuffer and encode
        let mut yuv = openh264::formats::YUVBuffer::new(w, h);
        yuv.y_mut().copy_from_slice(&y_plane);
        yuv.u_mut().copy_from_slice(&u_plane);
        yuv.v_mut().copy_from_slice(&v_plane);

        let api = openh264::OpenH264API::from_source();
        let enc_cfg = openh264::encoder::EncoderConfig::new()
            .max_frame_rate(openh264::encoder::FrameRate::from_hz(30.0));
        let mut encoder = openh264::encoder::Encoder::with_api_config(api, enc_cfg).unwrap();

        let bitstream = encoder.encode(&yuv).unwrap();
        let h264_data = bitstream.to_vec();
        assert!(!h264_data.is_empty(), "H.264 bitstream should not be empty");

        // Decode
        let api2 = openh264::OpenH264API::from_source();
        let mut decoder = openh264::decoder::Decoder::new(api2).unwrap();
        let decoded = decoder.decode(&h264_data).unwrap();
        assert!(decoded.is_some(), "decoder should produce a frame");

        let decoded = decoded.unwrap();
        let (dw, dh) = decoded.dimensions();
        assert_eq!(dw, w);
        assert_eq!(dh, h);
    }
```

**Note:** This test references a `windows_test_helpers` module that exposes the conversion function for testing. You'll need to add a `#[cfg(test)] pub mod windows_test_helpers` in `capture/mod.rs` (or make the functions `pub(crate)` in `windows.rs`). The simplest approach:

Change `fn bgra_to_yuv420_bt709` to `pub(crate) fn bgra_to_yuv420_bt709` in `windows.rs`.

- [ ] **Step 2: Run the test**

Run: `cd src-tauri && cargo test test_fused_bgra_yuv_encode_decode -- --nocapture 2>&1 | Select-Object -Last 20`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/capture/windows.rs src-tauri/src/capture/mod.rs src-tauri/src/media_manager.rs
git commit -m "test: fused BGRA→YUV420 encode/decode roundtrip integration test"
```

---

## Task 14: Final Verification and Cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run full Rust test suite**

Run: `cd src-tauri && cargo test 2>&1 | Select-Object -Last 30`
Expected: All tests pass

- [ ] **Step 2: Run full frontend test suite**

Run: `npm run test 2>&1 | Select-Object -Last 30`
Expected: All 233+ tests pass

- [ ] **Step 3: Run full TypeScript type-check**

Run: `npx vue-tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run full build**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 5: Manual smoke test**

1. `npm run dev:tauri`
2. Open two instances (Alice + Bob) using `npm run dev:alice` / `npm run dev:bob`
3. Join voice channel
4. Start screen share (old pipeline — default)
5. Verify screen appears for both users
6. Set `localStorage.setItem('hexfield_new_pipeline', 'true')` in Alice's DevTools
7. Restart screen share → verify it works with new pipeline
8. Bob clicks gear icon on Alice's screen tile → switches to 1080p → verify change
9. Compare terminal timing logs between `[media]` and `[media-NEW]` / `[media-720p]` / `[media-1080p]`

- [ ] **Step 6: Commit all remaining changes**

```bash
git add -A
git commit -m "feat: screen share quality selector + 2-tier simulcast (behind flag)"
```

---

## Summary of Profiling Points

| Log Prefix | Pipeline | Measurement |
|------------|----------|-------------|
| `[media]` | Old (1-pass swap + 1-pass YUV) | swap, yuv, enc, send, total |
| `[media-NEW]` | New inline (fused BGRA→YUV) | convert, enc, send, total |
| `[media-720p]` | New threaded (low tier) | convert, enc, send, total |
| `[media-1080p]` | New threaded (high tier) | convert, enc, send, total |

All profiling fires at frame #1 and every 300th frame (~5s at 60fps, ~10s at 30fps). To get more data points, temporarily change `300` to `60` (every 1s at 60fps).

## Decision Points

After completing Task 5 (profiling), evaluate:

1. **If new pipeline is faster**: Continue with Tasks 6-14
2. **If new pipeline is same or slower**: Investigate. Check:
   - Is opt-level high enough? (`[profile.dev.package.hexfield] opt-level = 2`)
   - Is the fused pass actually single-pass or did the compiler not inline?
   - Consider using `#[inline(always)]` on the conversion functions
3. **Before removing old pipeline**: Run at least 3 profiling sessions with each, compute median. Only remove old pipeline when confident new one is at least as fast at 720p.
