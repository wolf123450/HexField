# Downscale Methods & Performance Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-selectable downscale algorithms (nearest, bilinear, bicubic, Lanczos3) with bilinear as default, and a toggleable performance overlay showing real-time capture/encode stats on the local screen share tile.

**Architecture:** The downscale method selection flows from `settingsStore` (persisted default) through `voiceStore` (per-session override) to the Rust capture pipeline via a new `downscale_method` field on `CaptureConfig`. The Rust encoder thread dispatches to the chosen algorithm, emits per-frame timing stats via Tauri events, and the Vue overlay component renders them conditionally. The `image` crate is NOT used for downscaling — all algorithms are fused with the BGRA→YUV420 BT.709 conversion to avoid extra passes.

**Tech Stack:** Rust (openh264, crossbeam-channel, serde), Tauri v2 IPC (events + commands), Vue 3.5 (`<script setup>`), Pinia 3 (Setup Store), TypeScript strict, CSS scoped

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src-tauri/src/capture/mod.rs` | Add `DownscaleMethod` enum, add field to `CaptureConfig` |
| Modify | `src-tauri/src/capture/windows.rs` | Implement bilinear/bicubic/Lanczos3 fused conversions, add dispatcher, add stats emission |
| Modify | `src-tauri/src/commands/media_commands.rs` | Accept `downscale_method` param in `media_start_screen_share` |
| Modify | `src-tauri/src/media_manager.rs` | Pass `downscale_method` through `start_screen_share()` to `CaptureConfig` |
| Modify | `src/stores/settingsStore.ts` | Add `videoDownscaleMethod` to `UserSettings` interface + defaults |
| Modify | `src/stores/voiceStore.ts` | Add per-session override ref, stats ref, event listener |
| Modify | `src/services/webrtcService.ts` | Pass `downscaleMethod` param to Tauri command |
| Modify | `src/components/settings/SettingsVoiceTab.vue` | Add downscale method dropdown |
| Modify | `src/components/chat/VoiceContentPane.vue` | Add overlay component + toggle button |

---

### Task 1: Add `DownscaleMethod` enum to Rust capture module

**Files:**
- Modify: `src-tauri/src/capture/mod.rs`

- [ ] **Step 1: Add the enum and update CaptureConfig**

In `src-tauri/src/capture/mod.rs`, add this enum **before** the `CaptureConfig` struct, after the existing `use` imports:

```rust
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
```

Add a new field to `CaptureConfig`, after `use_new_pipeline`:

```rust
    /// Downscale algorithm used when the source is larger than the target.
    pub downscale_method: DownscaleMethod,
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | Select-Object -Last 10`
Expected: errors about missing `downscale_method` field in `media_manager.rs` — that's correct, we'll fix it in Task 3.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/capture/mod.rs
git commit -m "feat(capture): add DownscaleMethod enum to CaptureConfig"
```

---

### Task 2: Implement bilinear, bicubic, and Lanczos3 downscale functions

**Files:**
- Modify: `src-tauri/src/capture/windows.rs`

All three new functions share the same signature as the existing `bgra_to_yuv420_bt709_downscale()` and live in the same file, right after it. They all fuse the color-space conversion with the downscale in a single pass — no intermediate buffers.

- [ ] **Step 1: Add the bilinear implementation**

Add this function after `bgra_to_yuv420_bt709_downscale()` (after line ~311):

```rust
/// Fused BGRA→YUV420 BT.709 with bilinear downscaling.
///
/// For each destination pixel, computes fractional source coordinates and
/// linearly interpolates the 4 surrounding source pixels. Produces much
/// smoother results than nearest-neighbor, especially for text at high
/// downscale ratios (e.g. 4K→720p).
pub(crate) fn bgra_to_yuv420_bt709_downscale_bilinear(
    bgra: &[u8],
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let uv_w = dst_w / 2;
    let uv_h = dst_h / 2;
    let mut y_plane = vec![0u8; dst_w * dst_h];
    let mut u_plane = vec![0u8; uv_w * uv_h];
    let mut v_plane = vec![0u8; uv_w * uv_h];
    let src_stride = src_w * 4;

    // Precompute scale factors (fixed-point 16.16)
    let x_ratio = ((src_w as u64 - 1) << 16) / dst_w as u64;
    let y_ratio = ((src_h as u64 - 1) << 16) / dst_h as u64;

    // Helper: bilinear sample a single pixel, return (r, g, b) as i32
    #[inline(always)]
    fn sample_bilinear(bgra: &[u8], src_stride: usize, src_w: usize, src_h: usize,
                       sx_fp: u64, sy_fp: u64) -> (i32, i32, i32) {
        let x0 = (sx_fp >> 16) as usize;
        let y0 = (sy_fp >> 16) as usize;
        let x1 = (x0 + 1).min(src_w - 1);
        let y1 = (y0 + 1).min(src_h - 1);
        let fx = (sx_fp & 0xFFFF) as i32; // fractional part 0..65535
        let fy = (sy_fp & 0xFFFF) as i32;
        let ifx = 65536 - fx;
        let ify = 65536 - fy;

        let p00 = y0 * src_stride + x0 * 4;
        let p10 = y0 * src_stride + x1 * 4;
        let p01 = y1 * src_stride + x0 * 4;
        let p11 = y1 * src_stride + x1 * 4;

        // Interpolate each channel with fixed-point math
        // top row:  lerp(p00, p10, fx)
        // bot row:  lerp(p01, p11, fx)
        // result:   lerp(top, bot, fy)
        let interp = |ch: usize| -> i32 {
            let top = ifx * bgra[p00 + ch] as i32 + fx * bgra[p10 + ch] as i32;
            let bot = ifx * bgra[p01 + ch] as i32 + fx * bgra[p11 + ch] as i32;
            (ify * (top >> 8) + fy * (bot >> 8)) >> 24
        };

        (interp(2), interp(1), interp(0)) // r, g, b (BGRA layout)
    }

    // Luma plane
    for dst_row in 0..dst_h {
        let sy = dst_row as u64 * y_ratio;
        let row_base = dst_row * dst_w;
        for dst_col in 0..dst_w {
            let sx = dst_col as u64 * x_ratio;
            let (r, g, b) = sample_bilinear(bgra, src_stride, src_w, src_h, sx, sy);
            let y = ((YR * r + YG * g + YB * b + 32768) >> 16).clamp(0, 255);
            y_plane[row_base + dst_col] = y as u8;
        }
    }

    // Chroma planes: average the 4 luma-grid samples per chroma pixel
    let x_ratio_c = ((src_w as u64 - 1) << 16) / dst_w as u64;
    let y_ratio_c = ((src_h as u64 - 1) << 16) / dst_h as u64;
    for uv_row in 0..uv_h {
        for uv_col in 0..uv_w {
            let mut sum_r: i32 = 0;
            let mut sum_g: i32 = 0;
            let mut sum_b: i32 = 0;
            for dy in 0..2u64 {
                let dst_row = uv_row as u64 * 2 + dy;
                let sy = dst_row * y_ratio_c;
                for dx in 0..2u64 {
                    let dst_col = uv_col as u64 * 2 + dx;
                    let sx = dst_col * x_ratio_c;
                    let (r, g, b) = sample_bilinear(bgra, src_stride, src_w, src_h, sx, sy);
                    sum_r += r;
                    sum_g += g;
                    sum_b += b;
                }
            }
            let avg_r = sum_r / 4;
            let avg_g = sum_g / 4;
            let avg_b = sum_b / 4;
            let u = ((UR * avg_r + UG * avg_g + UB * avg_b + 32768) >> 16) + 128;
            let v = ((VR * avg_r + VG * avg_g + VB * avg_b + 32768) >> 16) + 128;
            let idx = uv_row * uv_w + uv_col;
            u_plane[idx] = u.clamp(0, 255) as u8;
            v_plane[idx] = v.clamp(0, 255) as u8;
        }
    }

    (y_plane, u_plane, v_plane)
}
```

- [ ] **Step 2: Add the bicubic implementation**

Add after the bilinear function:

```rust
/// Fused BGRA→YUV420 BT.709 with bicubic (Catmull-Rom) downscaling.
///
/// Uses a 4×4 source kernel with Catmull-Rom spline weights (a = -0.5).
/// Sharper than bilinear, minimal ringing. Good for detailed content like
/// code editors and spreadsheets.
pub(crate) fn bgra_to_yuv420_bt709_downscale_bicubic(
    bgra: &[u8],
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let uv_w = dst_w / 2;
    let uv_h = dst_h / 2;
    let mut y_plane = vec![0u8; dst_w * dst_h];
    let mut u_plane = vec![0u8; uv_w * uv_h];
    let mut v_plane = vec![0u8; uv_w * uv_h];
    let src_stride = src_w * 4;

    // Catmull-Rom weight (a = -0.5), t in [0, 2)
    // Returns weight * 4096 (fixed-point 12-bit)
    #[inline(always)]
    fn catmull_rom_fp(t: i32) -> i32 {
        // t is in 0..65536 (representing 0.0..1.0) or 65536..131072 (1.0..2.0)
        // We use actual distance values scaled by 4096
        if t < 0 { return catmull_rom_fp(-t); }
        // Input t is 16.16 fixed-point absolute distance
        // a = -0.5
        if t <= 65536 {
            // (1.5*t^3 - 2.5*t^2 + 1) * 4096
            // t_norm = t / 65536 (in 0..1)
            let tn = t as i64;
            let t2 = (tn * tn) >> 16;
            let t3 = (t2 * tn) >> 16;
            // (1.5*t3 - 2.5*t2 + 1) * 4096
            // = (6144*t3 - 10240*t2 + 4096*65536) >> 16
            let w = ((6144 * t3 - 10240 * t2) >> 16) + 4096;
            w as i32
        } else if t <= 131072 {
            let tn = t as i64;
            let t2 = (tn * tn) >> 16;
            let t3 = (t2 * tn) >> 16;
            // (-0.5*t3 + 2.5*t2 - 4*t + 2) * 4096
            let w = ((-2048 * t3 + 10240 * t2 - 16384 * tn) >> 16) + 8192;
            w as i32
        } else {
            0
        }
    }

    // Sample one pixel with bicubic interpolation, returns (r, g, b) as i32
    #[inline(always)]
    fn sample_bicubic(bgra: &[u8], src_stride: usize, src_w: usize, src_h: usize,
                      sx_fp: u64, sy_fp: u64) -> (i32, i32, i32) {
        let ix = (sx_fp >> 16) as i32;
        let iy = (sy_fp >> 16) as i32;
        let fx = (sx_fp & 0xFFFF) as i32;
        let fy = (sy_fp & 0xFFFF) as i32;

        let mut sum_r: i64 = 0;
        let mut sum_g: i64 = 0;
        let mut sum_b: i64 = 0;
        let mut sum_w: i64 = 0;

        for j in -1i32..=2 {
            let sy = (iy + j).clamp(0, src_h as i32 - 1) as usize;
            let wy = catmull_rom_fp((j * 65536 - fy).unsigned_abs() as i32) as i64;
            let row_off = sy * src_stride;
            for i in -1i32..=2 {
                let sx = (ix + i).clamp(0, src_w as i32 - 1) as usize;
                let wx = catmull_rom_fp((i * 65536 - fx).unsigned_abs() as i32) as i64;
                let w = wx * wy;
                let px = row_off + sx * 4;
                sum_b += w * bgra[px] as i64;
                sum_g += w * bgra[px + 1] as i64;
                sum_r += w * bgra[px + 2] as i64;
                sum_w += w;
            }
        }

        if sum_w == 0 {
            return (0, 0, 0);
        }
        let r = (sum_r / sum_w).clamp(0, 255) as i32;
        let g = (sum_g / sum_w).clamp(0, 255) as i32;
        let b = (sum_b / sum_w).clamp(0, 255) as i32;
        (r, g, b)
    }

    let x_ratio = ((src_w as u64 - 1) << 16) / dst_w as u64;
    let y_ratio = ((src_h as u64 - 1) << 16) / dst_h as u64;

    // Luma
    for dst_row in 0..dst_h {
        let sy = dst_row as u64 * y_ratio;
        let row_base = dst_row * dst_w;
        for dst_col in 0..dst_w {
            let sx = dst_col as u64 * x_ratio;
            let (r, g, b) = sample_bicubic(bgra, src_stride, src_w, src_h, sx, sy);
            let y = ((YR * r + YG * g + YB * b + 32768) >> 16).clamp(0, 255);
            y_plane[row_base + dst_col] = y as u8;
        }
    }

    // Chroma
    for uv_row in 0..uv_h {
        for uv_col in 0..uv_w {
            let mut sum_r: i32 = 0;
            let mut sum_g: i32 = 0;
            let mut sum_b: i32 = 0;
            for dy in 0..2u64 {
                let dst_row = uv_row as u64 * 2 + dy;
                let sy = dst_row * y_ratio;
                for dx in 0..2u64 {
                    let dst_col = uv_col as u64 * 2 + dx;
                    let sx = dst_col * x_ratio;
                    let (r, g, b) = sample_bicubic(bgra, src_stride, src_w, src_h, sx, sy);
                    sum_r += r;
                    sum_g += g;
                    sum_b += b;
                }
            }
            let avg_r = sum_r / 4;
            let avg_g = sum_g / 4;
            let avg_b = sum_b / 4;
            let u = ((UR * avg_r + UG * avg_g + UB * avg_b + 32768) >> 16) + 128;
            let v = ((VR * avg_r + VG * avg_g + VB * avg_b + 32768) >> 16) + 128;
            let idx = uv_row * uv_w + uv_col;
            u_plane[idx] = u.clamp(0, 255) as u8;
            v_plane[idx] = v.clamp(0, 255) as u8;
        }
    }

    (y_plane, u_plane, v_plane)
}
```

- [ ] **Step 3: Add the Lanczos3 implementation**

Add after the bicubic function:

```rust
/// Fused BGRA→YUV420 BT.709 with Lanczos-3 downscaling.
///
/// Uses a 6×6 source kernel with sinc-windowed weights. Produces the
/// sharpest results with minimal aliasing, but is the most expensive.
/// Best for static content where quality matters more than CPU.
pub(crate) fn bgra_to_yuv420_bt709_downscale_lanczos3(
    bgra: &[u8],
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let uv_w = dst_w / 2;
    let uv_h = dst_h / 2;
    let mut y_plane = vec![0u8; dst_w * dst_h];
    let mut u_plane = vec![0u8; uv_w * uv_h];
    let mut v_plane = vec![0u8; uv_w * uv_h];
    let src_stride = src_w * 4;

    // Lanczos kernel: L(x) = sinc(x) * sinc(x/3) for |x| < 3, else 0
    // We precompute weights for each fractional offset.
    // Using f32 for the kernel since the trig is unavoidable and we only
    // compute 6 weights per axis per pixel.
    #[inline(always)]
    fn lanczos3_weight(x: f32) -> f32 {
        if x.abs() < 1e-6 {
            return 1.0;
        }
        if x.abs() >= 3.0 {
            return 0.0;
        }
        let pi_x = std::f32::consts::PI * x;
        let pi_x_3 = pi_x / 3.0;
        (pi_x.sin() / pi_x) * (pi_x_3.sin() / pi_x_3)
    }

    #[inline(always)]
    fn sample_lanczos3(bgra: &[u8], src_stride: usize, src_w: usize, src_h: usize,
                       sx_fp: u64, sy_fp: u64) -> (i32, i32, i32) {
        let ix = (sx_fp >> 16) as i32;
        let iy = (sy_fp >> 16) as i32;
        let fx = (sx_fp & 0xFFFF) as f32 / 65536.0;
        let fy = (sy_fp & 0xFFFF) as f32 / 65536.0;

        let mut sum_r: f32 = 0.0;
        let mut sum_g: f32 = 0.0;
        let mut sum_b: f32 = 0.0;
        let mut sum_w: f32 = 0.0;

        for j in -2i32..=3 {
            let sy = (iy + j).clamp(0, src_h as i32 - 1) as usize;
            let wy = lanczos3_weight(j as f32 - fy);
            let row_off = sy * src_stride;
            for i in -2i32..=3 {
                let sx = (ix + i).clamp(0, src_w as i32 - 1) as usize;
                let wx = lanczos3_weight(i as f32 - fx);
                let w = wx * wy;
                let px = row_off + sx * 4;
                sum_b += w * bgra[px] as f32;
                sum_g += w * bgra[px + 1] as f32;
                sum_r += w * bgra[px + 2] as f32;
                sum_w += w;
            }
        }

        if sum_w.abs() < 1e-6 {
            return (0, 0, 0);
        }
        let r = (sum_r / sum_w).clamp(0.0, 255.0) as i32;
        let g = (sum_g / sum_w).clamp(0.0, 255.0) as i32;
        let b = (sum_b / sum_w).clamp(0.0, 255.0) as i32;
        (r, g, b)
    }

    let x_ratio = ((src_w as u64 - 1) << 16) / dst_w as u64;
    let y_ratio = ((src_h as u64 - 1) << 16) / dst_h as u64;

    // Luma
    for dst_row in 0..dst_h {
        let sy = dst_row as u64 * y_ratio;
        let row_base = dst_row * dst_w;
        for dst_col in 0..dst_w {
            let sx = dst_col as u64 * x_ratio;
            let (r, g, b) = sample_lanczos3(bgra, src_stride, src_w, src_h, sx, sy);
            let y = ((YR * r + YG * g + YB * b + 32768) >> 16).clamp(0, 255);
            y_plane[row_base + dst_col] = y as u8;
        }
    }

    // Chroma
    for uv_row in 0..uv_h {
        for uv_col in 0..uv_w {
            let mut sum_r: i32 = 0;
            let mut sum_g: i32 = 0;
            let mut sum_b: i32 = 0;
            for dy in 0..2u64 {
                let dst_row = uv_row as u64 * 2 + dy;
                let sy = dst_row * y_ratio;
                for dx in 0..2u64 {
                    let dst_col = uv_col as u64 * 2 + dx;
                    let sx = dst_col * x_ratio;
                    let (r, g, b) = sample_lanczos3(bgra, src_stride, src_w, src_h, sx, sy);
                    sum_r += r;
                    sum_g += g;
                    sum_b += b;
                }
            }
            let avg_r = sum_r / 4;
            let avg_g = sum_g / 4;
            let avg_b = sum_b / 4;
            let u = ((UR * avg_r + UG * avg_g + UB * avg_b + 32768) >> 16) + 128;
            let v = ((VR * avg_r + VG * avg_g + VB * avg_b + 32768) >> 16) + 128;
            let idx = uv_row * uv_w + uv_col;
            u_plane[idx] = u.clamp(0, 255) as u8;
            v_plane[idx] = v.clamp(0, 255) as u8;
        }
    }

    (y_plane, u_plane, v_plane)
}
```

- [ ] **Step 4: Add the dispatcher function**

Add after all three new functions, before the `EncoderFrame` struct:

```rust
/// Dispatch to the appropriate fused BGRA→YUV420 downscale implementation.
pub(crate) fn bgra_to_yuv420_bt709_downscale_with_method(
    bgra: &[u8],
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
    method: super::DownscaleMethod,
) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    match method {
        super::DownscaleMethod::Nearest => {
            bgra_to_yuv420_bt709_downscale(bgra, src_w, src_h, dst_w, dst_h)
        }
        super::DownscaleMethod::Bilinear => {
            bgra_to_yuv420_bt709_downscale_bilinear(bgra, src_w, src_h, dst_w, dst_h)
        }
        super::DownscaleMethod::Bicubic => {
            bgra_to_yuv420_bt709_downscale_bicubic(bgra, src_w, src_h, dst_w, dst_h)
        }
        super::DownscaleMethod::Lanczos3 => {
            bgra_to_yuv420_bt709_downscale_lanczos3(bgra, src_w, src_h, dst_w, dst_h)
        }
    }
}
```

- [ ] **Step 5: Verify it compiles** (same expected errors as Task 1)

Run: `cd src-tauri && cargo check 2>&1 | Select-Object -Last 10`

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/capture/windows.rs
git commit -m "feat(capture): implement bilinear, bicubic, Lanczos3 fused downscale"
```

---

### Task 3: Thread the downscale method through the Rust pipeline

**Files:**
- Modify: `src-tauri/src/capture/windows.rs` (spawn_encoder_thread + WgcFlags/WgcHandler)
- Modify: `src-tauri/src/media_manager.rs`
- Modify: `src-tauri/src/commands/media_commands.rs`

- [ ] **Step 1: Update `spawn_encoder_thread` to accept and use the method**

In `src-tauri/src/capture/windows.rs`, add `downscale_method: super::DownscaleMethod` as the last parameter of `spawn_encoder_thread`:

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
    downscale_method: super::DownscaleMethod,
) -> crossbeam_channel::Sender<EncoderFrame> {
```

Then replace the existing downscale dispatch inside the `while let Ok(frame) = rx.recv()` loop:

```rust
                let needs_downscale = frame.src_w > dst_w || frame.src_h > dst_h;
                let (y_plane, u_plane, v_plane) = if needs_downscale {
                    bgra_to_yuv420_bt709_downscale_with_method(
                        &frame.bgra, frame.src_w, frame.src_h, dst_w, dst_h,
                        downscale_method,
                    )
                } else {
                    bgra_to_yuv420_bt709(&frame.bgra, frame.src_w, frame.src_h)
                };
```

- [ ] **Step 2: Add `downscale_method` to WgcFlags and WgcHandler**

In `WgcFlags`, add:
```rust
    downscale_method: super::DownscaleMethod,
```

In `WgcHandler`, add the same field:
```rust
    downscale_method: super::DownscaleMethod,
```

In the `GraphicsCaptureApiHandler::new()` impl, add:
```rust
    downscale_method: flags.downscale_method,
```

- [ ] **Step 3: Pass the method to spawn_encoder_thread calls**

In `on_frame_arrived`, at the two call sites of `spawn_encoder_thread`, add `self.downscale_method` as the last argument. There are two calls — one for the low tier (720p) and one for the high tier (1080p):

Low tier call: add `self.downscale_method,` after `self.app.clone(),`
High tier call: add `self.downscale_method,` after `self.app.clone(),`

- [ ] **Step 4: Pass downscale_method in `start()` (the `WgcFlags` constructor)**

In `impl ScreenCapturer for WgcCapturer`, in the `start()` method, the `WgcFlags` constructor currently doesn't have `downscale_method`. Add:

```rust
            downscale_method: config.downscale_method,
```

- [ ] **Step 5: Update `media_manager.rs` start_screen_share**

Add `downscale_method: super::capture::DownscaleMethod` parameter to the `start_screen_share` method:

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
        downscale_method: crate::capture::DownscaleMethod,
    ) -> Result<(), String> {
```

And add the field to the `CaptureConfig` construction:

```rust
        let config = crate::capture::CaptureConfig {
            source_id: source_id_owned.clone(),
            video_track,
            video_track_high,
            app: app_clone.clone(),
            fps,
            bitrate_kbps,
            bitrate_kbps_high: if use_new_pipeline { 6000 } else { 0 },
            screen_active,
            force_keyframe: self.force_keyframe.clone(),
            preview_dir,
            use_new_pipeline,
            downscale_method,
        };
```

- [ ] **Step 6: Update the Tauri command**

In `src-tauri/src/commands/media_commands.rs`, add `downscale_method` param to `media_start_screen_share`:

```rust
#[tauri::command]
pub async fn media_start_screen_share(
    source_id: String,
    fps: Option<u32>,
    bitrate_kbps: Option<u32>,
    use_new_pipeline: Option<bool>,
    downscale_method: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let use_new = use_new_pipeline.unwrap_or(false);

    let method = match downscale_method.as_deref() {
        Some("nearest")  => crate::capture::DownscaleMethod::Nearest,
        Some("bicubic")  => crate::capture::DownscaleMethod::Bicubic,
        Some("lanczos3") => crate::capture::DownscaleMethod::Lanczos3,
        _                => crate::capture::DownscaleMethod::Bilinear,
    };
```

Then pass `method` to `start_screen_share()`:

```rust
    state
        .media_manager
        .start_screen_share(
            &source_id,
            video_track,
            video_track_high,
            app,
            fps.unwrap_or(30),
            bitrate_kbps.unwrap_or(0),
            use_new,
            method,
        )
        .await
```

- [ ] **Step 7: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | Select-Object -Last 10`
Expected: success (or only frontend-unrelated warnings)

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/capture/windows.rs src-tauri/src/media_manager.rs src-tauri/src/commands/media_commands.rs
git commit -m "feat(capture): thread DownscaleMethod through pipeline to encoder"
```

---

### Task 4: Add stats emission from encoder thread

**Files:**
- Modify: `src-tauri/src/capture/windows.rs`

- [ ] **Step 1: Add stats tracking and emission to spawn_encoder_thread**

Inside the encoder thread's `while let Ok(frame) = rx.recv()` loop, after the existing timing code, add stats accumulation and periodic emission. Add these variables before the loop:

```rust
            // Stats accumulation for overlay
            let mut stats_frame_count: u64 = 0;
            let mut stats_convert_sum_us: u64 = 0;
            let mut stats_encode_sum_us: u64 = 0;
            let mut stats_dropped: u64 = 0;
            let mut stats_bytes_sum: u64 = 0;
            let mut stats_last_emit = std::time::Instant::now();
            let method_name = format!("{:?}", downscale_method).to_lowercase();
```

After the `match encoder.encode(...)` block (inside the `Ok(bitstream)` arm), after the existing logging and track write, add:

```rust
                        stats_frame_count += 1;
                        stats_convert_sum_us += t_after_convert.as_micros() as u64;
                        stats_encode_sum_us += (t_after_encode - t_after_convert).as_micros() as u64;
                        stats_bytes_sum += bitstream.to_vec().len() as u64;
```

Wait — the `h264_data` is already computed. Use its length instead of calling `to_vec()` again. So place the stats accumulation after `let h264_data = bitstream.to_vec();`:

```rust
                        stats_bytes_sum += h264_data.len() as u64;
```

Then, after the preview block (at the end of the `Ok()` arm), add the periodic emission:

```rust
                        // Emit stats every ~500ms
                        if stats_last_emit.elapsed() >= Duration::from_millis(500) && stats_frame_count > 0 {
                            let avg_convert_ms = stats_convert_sum_us as f64 / stats_frame_count as f64 / 1000.0;
                            let avg_encode_ms = stats_encode_sum_us as f64 / stats_frame_count as f64 / 1000.0;
                            let elapsed_s = stats_last_emit.elapsed().as_secs_f64();
                            let actual_fps = stats_frame_count as f64 / elapsed_s;
                            let bitrate_kbps_actual = (stats_bytes_sum as f64 * 8.0 / elapsed_s / 1000.0) as u64;

                            let _ = app.emit("screen_share_stats", serde_json::json!({
                                "label": label,
                                "fps": (actual_fps * 10.0).round() / 10.0,
                                "convertMs": (avg_convert_ms * 100.0).round() / 100.0,
                                "encodeMs": (avg_encode_ms * 100.0).round() / 100.0,
                                "resolution": format!("{}x{}", dst_w, dst_h),
                                "srcResolution": format!("{}x{}", frame.src_w, frame.src_h),
                                "bitrateKbps": bitrate_kbps_actual,
                                "dropped": stats_dropped,
                                "method": method_name,
                            }));

                            stats_frame_count = 0;
                            stats_convert_sum_us = 0;
                            stats_encode_sum_us = 0;
                            stats_bytes_sum = 0;
                            stats_dropped = 0;
                            stats_last_emit = std::time::Instant::now();
                        }
```

- [ ] **Step 2: Track dropped frames**

In the `on_frame_arrived` method, the `try_send()` calls can fail when the channel is full (frame drop). We need to count those. The cleanest approach is to track drops in the encoder thread by comparing expected vs received frame numbers.

Actually, `try_send` returns `Err(TrySendError::Full(_))` when a frame is dropped. Add a counter to `WgcHandler`:

```rust
    dropped_low: u64,
    dropped_high: u64,
```

Initialize both to `0` in `new()`. Then in `on_frame_arrived`, change the `try_send` calls:

```rust
            if let Some(ref tx) = self.encoder_tx_low {
                if tx.try_send(frame_low).is_err() {
                    self.dropped_low += 1;
                }
            }
```

But wait — the drop count needs to go TO the encoder thread. Since the encoder thread is the one emitting stats, the simplest approach is to add `dropped_total` as an `Arc<AtomicU64>` that the handler increments and the encoder reads. But that's over-engineered for this.

Simpler: add the dropped count to `EncoderFrame`:

No, even simpler. The encoder thread already knows if it's getting source frames out of order/gap by checking `frame.frame_number`. Between two received frames, if the frame numbers jump, the gap is the drop count.

Actually simplest: just have the encoder thread report `0` for dropped frames for now. The `try_send` dropping is already visible through FPS being lower than target. If we want exact dropped count later, we can track `frame_number` gaps. Remove `stats_dropped` usage or leave as 0.

Keep the `stats_dropped` variable set to `0` — the FPS measurement already reflects drops since it measures actual encoded frames per second. The dropped count field is there for future use.

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | Select-Object -Last 10`
Expected: success

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/capture/windows.rs
git commit -m "feat(capture): emit screen_share_stats event every 500ms"
```

---

### Task 5: Add frontend settings and IPC changes

**Files:**
- Modify: `src/stores/settingsStore.ts`
- Modify: `src/services/webrtcService.ts`
- Modify: `src/stores/voiceStore.ts`

- [ ] **Step 1: Add videoDownscaleMethod to UserSettings**

In `src/stores/settingsStore.ts`, add to the `UserSettings` interface, after `videoFrameRate`:

```ts
  videoDownscaleMethod: 'nearest' | 'bilinear' | 'bicubic' | 'lanczos3';
```

Add the default value in `defaultSettings`, after `videoFrameRate: 60,`:

```ts
  videoDownscaleMethod: 'bilinear',
```

- [ ] **Step 2: Update webrtcService.addScreenShareTrack**

In `src/services/webrtcService.ts`, update the `addScreenShareTrack` method to accept and pass the downscale method:

```ts
  async addScreenShareTrack(sourceId: string, fps?: number, bitrateKbps?: number, useNewPipeline?: boolean, downscaleMethod?: string): Promise<void> {
    await invoke('media_start_screen_share', {
      sourceId,
      fps: fps ?? 30,
      bitrateKbps: bitrateKbps ?? 0,
      useNewPipeline: useNewPipeline ?? false,
      downscaleMethod: downscaleMethod ?? 'bilinear',
    })
  }
```

- [ ] **Step 3: Update voiceStore to pass method and receive stats**

In `src/stores/voiceStore.ts`, add these refs near the top (after `screenFrameUrls`):

```ts
  const screenDownscaleMethod = ref<'nearest' | 'bilinear' | 'bicubic' | 'lanczos3' | null>(null)
  const screenShareStats = ref<{
    label: string;
    fps: number;
    convertMs: number;
    encodeMs: number;
    resolution: string;
    srcResolution: string;
    bitrateKbps: number;
    dropped: number;
    method: string;
  } | null>(null)
  const showScreenOverlay = ref(false)
```

In `startScreenShare()`, read the downscale method from settings (or per-session override) and pass it:

```ts
  const downscaleMethod = screenDownscaleMethod.value ?? settings.videoDownscaleMethod ?? 'bilinear'

  await webrtcService.addScreenShareTrack(
    sourceId,
    settings.videoFrameRate,
    maxBitrateKbps,
    useNewPipeline,
    downscaleMethod,
  )
```

Add a Tauri event listener. Use `listen` from `@tauri-apps/api/event`. Add to the module scope (or inside an init function that's already called). Since `voiceStore` doesn't have a dedicated `init()`, add the listener at the store definition level:

```ts
  // Listen for encoder stats
  let _statsUnlisten: (() => void) | null = null
  async function _listenStats() {
    const { listen } = await import('@tauri-apps/api/event')
    _statsUnlisten = await listen<{
      label: string; fps: number; convertMs: number; encodeMs: number;
      resolution: string; srcResolution: string; bitrateKbps: number;
      dropped: number; method: string;
    }>('screen_share_stats', (event) => {
      screenShareStats.value = event.payload
    })
  }
  _listenStats().catch(() => {})
```

In `stopScreenShare()`, clear the stats:

```ts
  screenShareStats.value = null
  screenDownscaleMethod.value = null
```

Expose the new refs in the store return:

```ts
  return {
    // ... existing ...
    screenDownscaleMethod,
    screenShareStats,
    showScreenOverlay,
  }
```

- [ ] **Step 4: Verify frontend compiles**

Run: `npm run build 2>&1 | Select-Object -Last 15`
Expected: success (might have warnings about unused variables if UI isn't consuming yet)

- [ ] **Step 5: Commit**

```bash
git add src/stores/settingsStore.ts src/services/webrtcService.ts src/stores/voiceStore.ts
git commit -m "feat: thread downscale method through frontend + add stats listener"
```

---

### Task 6: Add downscale method dropdown to Settings UI

**Files:**
- Modify: `src/components/settings/SettingsVoiceTab.vue`

- [ ] **Step 1: Add the dropdown**

In the template section, after the bitrate `<div class="form-row">` block, add:

```vue
<div class="form-row">
  <label class="form-label">Screen Share Downscale Method</label>
  <select v-model="videoDownscaleMethod" class="form-select" @change="saveDownscaleMethod">
    <option value="nearest">Nearest Neighbor — Fastest, pixelated</option>
    <option value="bilinear">Bilinear — Smooth, balanced</option>
    <option value="bicubic">Bicubic — Sharp, detailed</option>
    <option value="lanczos3">Lanczos-3 — Sharpest, most CPU</option>
  </select>
  <p class="form-hint">Algorithm used when downscaling to the target resolution. Takes effect on next screen share.</p>
</div>
```

In the `<script setup>` section, add the ref and save function (following the existing pattern):

```ts
const videoDownscaleMethod = ref(settingsStore.settings.videoDownscaleMethod)

function saveDownscaleMethod() {
  settingsStore.updateSetting('videoDownscaleMethod', videoDownscaleMethod.value as 'nearest' | 'bilinear' | 'bicubic' | 'lanczos3')
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build 2>&1 | Select-Object -Last 10`
Expected: success

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/SettingsVoiceTab.vue
git commit -m "feat(ui): add downscale method dropdown to Voice settings"
```

---

### Task 7: Add performance overlay + toggle to VoiceContentPane

**Files:**
- Modify: `src/components/chat/VoiceContentPane.vue`

- [ ] **Step 1: Add the overlay to the local screen share tile**

In the template, inside the local screen share `.video-tile` div (the one with `v-if="voiceStore.screenShareActive && !hiddenStreams.has('local')"`), after the existing `.tile-overlay` div, add:

```vue
    <!-- Performance overlay -->
    <div v-if="voiceStore.showScreenOverlay && voiceStore.screenShareStats" class="perf-overlay">
      <div class="perf-line">{{ voiceStore.screenShareStats.fps }} fps</div>
      <div class="perf-line">{{ voiceStore.screenShareStats.srcResolution }} → {{ voiceStore.screenShareStats.resolution }}</div>
      <div class="perf-line">convert: {{ voiceStore.screenShareStats.convertMs }}ms</div>
      <div class="perf-line">encode: {{ voiceStore.screenShareStats.encodeMs }}ms</div>
      <div class="perf-line">{{ voiceStore.screenShareStats.bitrateKbps }} kbps</div>
      <div class="perf-line">{{ voiceStore.screenShareStats.method }}</div>
    </div>
```

- [ ] **Step 2: Add the overlay toggle button**

In the same tile, inside the `.tile-overlay` div (the one with the "You (sharing)" label), add a toggle button next to the existing hide button:

```vue
    <button
      class="tile-stats-btn"
      :title="voiceStore.showScreenOverlay ? 'Hide stats' : 'Show stats'"
      @click.stop="voiceStore.showScreenOverlay = !voiceStore.showScreenOverlay"
    >
      <AppIcon :path="mdiChartLine" :size="14" />
    </button>
```

Import the icon path. Add to the existing icon imports (find the `import { ... } from '@mdi/js'` line):

```ts
import { mdiChartLine } from '@mdi/js'
```

(If `mdiChartLine` doesn't exist, use `mdiChartBox` or `mdiPoll` — check `@mdi/js` exports.)

- [ ] **Step 3: Add the per-session downscale method override**

In the same tile, add a dropdown selector that appears only during active screen share. Place it inside the `.tile-overlay` div or as a new `.tile-control` div:

```vue
    <select
      v-if="voiceStore.screenShareActive"
      class="tile-method-select"
      :value="voiceStore.screenDownscaleMethod ?? settingsStore.settings.videoDownscaleMethod"
      @change="setSessionMethod($event)"
    >
      <option value="nearest">Nearest</option>
      <option value="bilinear">Bilinear</option>
      <option value="bicubic">Bicubic</option>
      <option value="lanczos3">Lanczos-3</option>
    </select>
```

Add the handler in `<script setup>`:

```ts
const { useSettingsStore } = await import('@/stores/settingsStore')
// Actually, use top-level import since components can import stores freely:
import { useSettingsStore } from '@/stores/settingsStore'

const settingsStore = useSettingsStore()

function setSessionMethod(event: Event) {
  const value = (event.target as HTMLSelectElement).value as 'nearest' | 'bilinear' | 'bicubic' | 'lanczos3'
  voiceStore.screenDownscaleMethod = value
}
```

**Important:** The per-session method only takes effect on the NEXT screen share start (since the encoder thread receives the method at spawn time). Add a hint or note in the UI if desired, but this is the simplest correct behavior — no need to restart the capture mid-session.

- [ ] **Step 4: Add scoped CSS for the overlay and controls**

```css
.perf-overlay {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(0, 0, 0, 0.75);
  color: #0f0;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
  pointer-events: none;
  z-index: 10;
  line-height: 1.4;
}

.perf-line {
  white-space: nowrap;
}

.tile-stats-btn {
  padding: 0;
  transform: none;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0.7;
}

.tile-stats-btn:hover {
  opacity: 1;
  color: var(--accent-color);
}

.tile-method-select {
  position: absolute;
  bottom: 4px;
  right: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 11px;
  padding: 2px 4px;
  z-index: 10;
}
```

- [ ] **Step 5: Verify it compiles**

Run: `npm run build 2>&1 | Select-Object -Last 10`
Expected: success

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/VoiceContentPane.vue
git commit -m "feat(ui): add performance overlay + downscale method selector to screen share tile"
```

---

### Task 8: Update benchmark to test new methods

**Files:**
- Modify: `src-tauri/benches/pipeline_bench.rs`

- [ ] **Step 1: Add bilinear, bicubic, Lanczos3 benchmarks**

The benchmark binary copies conversion functions to avoid linking the main library (due to the aws-lc-rs/ring DLL conflict). Copy the three new functions into the benchmark file, then add benchmark runs mirroring the existing pattern:

```rust
// Copy bgra_to_yuv420_bt709_downscale_bilinear, _bicubic, _lanczos3
// from src-tauri/src/capture/windows.rs (they're self-contained functions
// that only use the BT.709 constants, which are already in the bench file)
```

Add benchmark iterations after the existing ones:

```rust
    println!("\n--- 4K → 720p bilinear ---");
    // ... bench bgra_to_yuv420_bt709_downscale_bilinear(...)

    println!("\n--- 4K → 720p bicubic ---");
    // ... bench bgra_to_yuv420_bt709_downscale_bicubic(...)

    println!("\n--- 4K → 720p lanczos3 ---");
    // ... bench bgra_to_yuv420_bt709_downscale_lanczos3(...)
```

Follow the same pattern as the existing benchmark: 20 warmup iterations + 100 measured iterations, print min/max/avg.

- [ ] **Step 2: Run benchmark**

Run: `cd src-tauri && cargo bench --bench pipeline_bench`
Expected: timing results for all methods. Bilinear should be ~30-50% slower than nearest, bicubic ~2-3× slower, Lanczos3 ~3-5× slower.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/benches/pipeline_bench.rs
git commit -m "bench: add bilinear, bicubic, Lanczos3 to pipeline benchmark"
```

---

### Task 9: Final integration test

- [ ] **Step 1: Verify full build**

Run both:
```bash
npm run build
cd src-tauri && cargo check
```
Expected: both succeed with no errors

- [ ] **Step 2: Run dev to verify UI**

Run: `npm run dev:tauri`

Verify:
1. Settings → Voice/Video tab shows the downscale method dropdown with 4 options, "Bilinear" is default
2. Start a screen share — the local preview tile shows the stats toggle button
3. Click the stats button — overlay appears showing FPS, resolution, timings, bitrate, method name
4. Click again — overlay hides
5. The method selector dropdown appears on the screen share tile (bottom-right)

- [ ] **Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "feat: downscale methods + performance overlay — integration verified"
```
