//! Standalone benchmark: Old pipeline vs New pipeline for screen share encoding.
//!
//! Run with: cargo bench --bench pipeline_bench
//!
//! This benchmark is a separate binary target that does NOT link the full Tauri
//! app, avoiding the aws-lc-rs / ring DLL conflict that crashes `cargo test --lib`.

use std::time::{Duration, Instant};

// ─── Conversion functions (copied from capture/windows.rs to avoid linking main lib) ───

fn bgra_to_yuv420_bt709(bgra: &[u8], w: usize, h: usize) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let mut y_plane = vec![0u8; w * h];
    let mut u_plane = vec![0u8; (w / 2) * (h / 2)];
    let mut v_plane = vec![0u8; (w / 2) * (h / 2)];
    let half_w = w / 2;

    for row in 0..h {
        let y_row = row * w;
        let bgra_row = row * w * 4;
        for col in 0..w {
            let si = bgra_row + col * 4;
            let b = bgra[si] as f32;
            let g = bgra[si + 1] as f32;
            let r = bgra[si + 2] as f32;

            y_plane[y_row + col] =
                (0.2126 * r + 0.7152 * g + 0.0722 * b).clamp(0.0, 255.0) as u8;

            if row % 2 == 0 && col % 2 == 0 {
                let ci = (row / 2) * half_w + (col / 2);
                u_plane[ci] =
                    (-0.1146 * r - 0.3854 * g + 0.5000 * b + 128.0).clamp(0.0, 255.0) as u8;
                v_plane[ci] =
                    (0.5000 * r - 0.4542 * g - 0.0458 * b + 128.0).clamp(0.0, 255.0) as u8;
            }
        }
    }
    (y_plane, u_plane, v_plane)
}

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
    let half_w = dst_w / 2;
    let x_ratio = src_w as f64 / dst_w as f64;
    let y_ratio = src_h as f64 / dst_h as f64;
    let src_stride = src_w * 4;

    for row in 0..dst_h {
        let src_y = (row as f64 * y_ratio) as usize;
        let src_row_off = src_y * src_stride;
        let y_row = row * dst_w;
        for col in 0..dst_w {
            let src_x = (col as f64 * x_ratio) as usize;
            let si = src_row_off + src_x * 4;
            let b = bgra[si] as f32;
            let g = bgra[si + 1] as f32;
            let r = bgra[si + 2] as f32;

            y_plane[y_row + col] =
                (0.2126 * r + 0.7152 * g + 0.0722 * b).clamp(0.0, 255.0) as u8;

            if row % 2 == 0 && col % 2 == 0 {
                let ci = (row / 2) * half_w + (col / 2);
                u_plane[ci] =
                    (-0.1146 * r - 0.3854 * g + 0.5000 * b + 128.0).clamp(0.0, 255.0) as u8;
                v_plane[ci] =
                    (0.5000 * r - 0.4542 * g - 0.0458 * b + 128.0).clamp(0.0, 255.0) as u8;
            }
        }
    }
    (y_plane, u_plane, v_plane)
}

/// Generate a realistic BGRA test frame (gradient simulating screen content).
fn make_test_bgra(w: usize, h: usize) -> Vec<u8> {
    let mut buf = vec![0u8; w * h * 4];
    for row in 0..h {
        for col in 0..w {
            let px = (row * w + col) * 4;
            buf[px] = ((col * 200 / w) + 55) as u8;         // B
            buf[px + 1] = ((row * 200 / h) + 55) as u8;     // G
            buf[px + 2] = (((col + row) * 128 / (w + h)) + 64) as u8; // R
            buf[px + 3] = 255;                                // A
        }
    }
    buf
}

/// Run a closure N times and return (min, avg, max) durations.
fn bench_n(n: usize, mut f: impl FnMut()) -> (Duration, Duration, Duration) {
    let mut times = Vec::with_capacity(n);
    // Warmup
    f();
    for _ in 0..n {
        let t = Instant::now();
        f();
        times.push(t.elapsed());
    }
    let min = *times.iter().min().unwrap();
    let max = *times.iter().max().unwrap();
    let avg = times.iter().sum::<Duration>() / n as u32;
    (min, avg, max)
}

fn main() {
    let iterations = 20;

    println!("╔══════════════════════════════════════════════════════════════╗");
    println!("║   Screen Share Pipeline Benchmark — Old vs New             ║");
    println!("╚══════════════════════════════════════════════════════════════╝");
    println!();

    // ── Test at 3840×2160 → 1280×720 (4K downscale to 720p) ──────────────────

    let src_w = 3840usize;
    let src_h = 2160usize;
    let dst_w = 1280usize;
    let dst_h = 720usize;

    println!("Source: {src_w}×{src_h} → Target: {dst_w}×{dst_h}  ({iterations} iterations each)");
    println!("─────────────────────────────────────────────────────────────────");

    let bgra_4k = make_test_bgra(src_w, src_h);

    // ── Old pipeline: downscale+swap BGRA→RGBA, then YUVBuffer, then encode ──
    println!("\n[OLD PIPELINE] BGRA→RGBA downscale+swap → YUVBuffer::from_rgb_source → H.264 encode");

    // Step 1: Downscale + BGRA→RGBA swap (fused, matching old pipeline code)
    let (min, avg, max) = bench_n(iterations, || {
        let x_ratio = src_w as f64 / dst_w as f64;
        let y_ratio = src_h as f64 / dst_h as f64;
        let src_stride = src_w * 4;
        let mut out = vec![0u8; dst_w * dst_h * 4];
        for y in 0..dst_h {
            let src_y = (y as f64 * y_ratio) as usize;
            let src_row = src_y * src_stride;
            let dst_row = y * dst_w * 4;
            for x in 0..dst_w {
                let src_x = (x as f64 * x_ratio) as usize;
                let si = src_row + src_x * 4;
                let di = dst_row + x * 4;
                out[di] = bgra_4k[si + 2];     // R ← B
                out[di + 1] = bgra_4k[si + 1]; // G ← G
                out[di + 2] = bgra_4k[si];     // B ← R
                out[di + 3] = bgra_4k[si + 3]; // A ← A
            }
        }
        std::hint::black_box(&out);
    });
    println!("  swap+downscale:  min={:.2}ms  avg={:.2}ms  max={:.2}ms",
        min.as_secs_f64() * 1000.0, avg.as_secs_f64() * 1000.0, max.as_secs_f64() * 1000.0);

    // Prepare RGBA for YUV conversion
    let rgba_720p = {
        let x_ratio = src_w as f64 / dst_w as f64;
        let y_ratio = src_h as f64 / dst_h as f64;
        let src_stride = src_w * 4;
        let mut out = vec![0u8; dst_w * dst_h * 4];
        for y in 0..dst_h {
            let src_y = (y as f64 * y_ratio) as usize;
            let src_row = src_y * src_stride;
            let dst_row = y * dst_w * 4;
            for x in 0..dst_w {
                let src_x = (x as f64 * x_ratio) as usize;
                let si = src_row + src_x * 4;
                let di = dst_row + x * 4;
                out[di] = bgra_4k[si + 2];
                out[di + 1] = bgra_4k[si + 1];
                out[di + 2] = bgra_4k[si];
                out[di + 3] = bgra_4k[si + 3];
            }
        }
        out
    };

    // Step 2: YUVBuffer::from_rgb_source (openh264's BT.601 conversion)
    let (min, avg, max) = bench_n(iterations, || {
        let src = openh264::formats::RgbaSliceU8::new(&rgba_720p, (dst_w, dst_h));
        let yuv = openh264::formats::YUVBuffer::from_rgb_source(src);
        std::hint::black_box(&yuv);
    });
    println!("  yuv (BT.601):    min={:.2}ms  avg={:.2}ms  max={:.2}ms",
        min.as_secs_f64() * 1000.0, avg.as_secs_f64() * 1000.0, max.as_secs_f64() * 1000.0);

    // Step 3: H.264 encode (old path uses YUVBuffer)
    {
        let src = openh264::formats::RgbaSliceU8::new(&rgba_720p, (dst_w, dst_h));
        let yuv = openh264::formats::YUVBuffer::from_rgb_source(src);
        let enc_cfg = openh264::encoder::EncoderConfig::new()
            .max_frame_rate(openh264::encoder::FrameRate::from_hz(60.0))
            .bitrate(openh264::encoder::BitRate::from_bps(4_000_000))
            .rate_control_mode(openh264::encoder::RateControlMode::Bitrate);
        let mut encoder = openh264::encoder::Encoder::with_api_config(
            openh264::OpenH264API::from_source(),
            enc_cfg,
        ).unwrap();
        // Warmup encoder with a few frames
        for _ in 0..3 {
            let _ = encoder.encode(&yuv).unwrap();
        }
        let (min, avg, max) = bench_n(iterations, || {
            let bs = encoder.encode(&yuv).unwrap();
            std::hint::black_box(bs.to_vec());
        });
        println!("  encode (H.264):  min={:.2}ms  avg={:.2}ms  max={:.2}ms",
            min.as_secs_f64() * 1000.0, avg.as_secs_f64() * 1000.0, max.as_secs_f64() * 1000.0);
    }

    // ── New pipeline: fused BGRA→YUV420 BT.709 downscale → YUVSlices → encode ──
    println!("\n[NEW PIPELINE] Fused BGRA→YUV420 BT.709 downscale → YUVSlices → H.264 encode");

    // Step 1: Fused BGRA→YUV420 + downscale (single pass)
    let (min, avg, max) = bench_n(iterations, || {
        let (y, u, v) = bgra_to_yuv420_bt709_downscale(&bgra_4k, src_w, src_h, dst_w, dst_h);
        std::hint::black_box((&y, &u, &v));
    });
    println!("  convert (fused): min={:.2}ms  avg={:.2}ms  max={:.2}ms",
        min.as_secs_f64() * 1000.0, avg.as_secs_f64() * 1000.0, max.as_secs_f64() * 1000.0);

    // Step 3: H.264 encode (new path uses YUVSlices — zero copy)
    {
        let (y, u, v) = bgra_to_yuv420_bt709_downscale(&bgra_4k, src_w, src_h, dst_w, dst_h);
        let enc_cfg = openh264::encoder::EncoderConfig::new()
            .max_frame_rate(openh264::encoder::FrameRate::from_hz(60.0))
            .bitrate(openh264::encoder::BitRate::from_bps(4_000_000))
            .rate_control_mode(openh264::encoder::RateControlMode::Bitrate);
        let mut encoder = openh264::encoder::Encoder::with_api_config(
            openh264::OpenH264API::from_source(),
            enc_cfg,
        ).unwrap();
        let slices = openh264::formats::YUVSlices::new(
            (&y, &u, &v), (dst_w, dst_h), (dst_w, dst_w / 2, dst_w / 2),
        );
        // Warmup
        for _ in 0..3 {
            let _ = encoder.encode(&slices).unwrap();
        }
        let (min, avg, max) = bench_n(iterations, || {
            let bs = encoder.encode(&slices).unwrap();
            std::hint::black_box(bs.to_vec());
        });
        println!("  encode (H.264):  min={:.2}ms  avg={:.2}ms  max={:.2}ms",
            min.as_secs_f64() * 1000.0, avg.as_secs_f64() * 1000.0, max.as_secs_f64() * 1000.0);
    }

    // ── Combined totals ──────────────────────────────────────────────────────
    println!("\n[COMBINED TOTALS] Full pipeline (convert + encode, {iterations} iterations)");

    // Old: swap+downscale → YUV → encode
    {
        let enc_cfg = openh264::encoder::EncoderConfig::new()
            .max_frame_rate(openh264::encoder::FrameRate::from_hz(60.0))
            .bitrate(openh264::encoder::BitRate::from_bps(4_000_000))
            .rate_control_mode(openh264::encoder::RateControlMode::Bitrate);
        let mut encoder = openh264::encoder::Encoder::with_api_config(
            openh264::OpenH264API::from_source(),
            enc_cfg,
        ).unwrap();
        // Warmup
        for _ in 0..3 {
            let src = openh264::formats::RgbaSliceU8::new(&rgba_720p, (dst_w, dst_h));
            let yuv = openh264::formats::YUVBuffer::from_rgb_source(src);
            let _ = encoder.encode(&yuv).unwrap();
        }
        let (min, avg, max) = bench_n(iterations, || {
            // Fused downscale+swap
            let x_ratio = src_w as f64 / dst_w as f64;
            let y_ratio = src_h as f64 / dst_h as f64;
            let src_stride = src_w * 4;
            let mut rgba = vec![0u8; dst_w * dst_h * 4];
            for y in 0..dst_h {
                let src_y = (y as f64 * y_ratio) as usize;
                let src_row = src_y * src_stride;
                let dst_row = y * dst_w * 4;
                for x in 0..dst_w {
                    let src_x = (x as f64 * x_ratio) as usize;
                    let si = src_row + src_x * 4;
                    let di = dst_row + x * 4;
                    rgba[di] = bgra_4k[si + 2];
                    rgba[di + 1] = bgra_4k[si + 1];
                    rgba[di + 2] = bgra_4k[si];
                    rgba[di + 3] = bgra_4k[si + 3];
                }
            }
            let src = openh264::formats::RgbaSliceU8::new(&rgba, (dst_w, dst_h));
            let yuv = openh264::formats::YUVBuffer::from_rgb_source(src);
            let bs = encoder.encode(&yuv).unwrap();
            std::hint::black_box(bs.to_vec());
        });
        println!("  OLD total:       min={:.2}ms  avg={:.2}ms  max={:.2}ms",
            min.as_secs_f64() * 1000.0, avg.as_secs_f64() * 1000.0, max.as_secs_f64() * 1000.0);
    }

    // New: fused downscale+convert → YUVSlices → encode
    {
        let enc_cfg = openh264::encoder::EncoderConfig::new()
            .max_frame_rate(openh264::encoder::FrameRate::from_hz(60.0))
            .bitrate(openh264::encoder::BitRate::from_bps(4_000_000))
            .rate_control_mode(openh264::encoder::RateControlMode::Bitrate);
        let mut encoder = openh264::encoder::Encoder::with_api_config(
            openh264::OpenH264API::from_source(),
            enc_cfg,
        ).unwrap();
        // Warmup
        for _ in 0..3 {
            let (y, u, v) = bgra_to_yuv420_bt709_downscale(&bgra_4k, src_w, src_h, dst_w, dst_h);
            let slices = openh264::formats::YUVSlices::new(
                (&y, &u, &v), (dst_w, dst_h), (dst_w, dst_w / 2, dst_w / 2),
            );
            let _ = encoder.encode(&slices).unwrap();
        }
        let (min, avg, max) = bench_n(iterations, || {
            let (y, u, v) = bgra_to_yuv420_bt709_downscale(&bgra_4k, src_w, src_h, dst_w, dst_h);
            let slices = openh264::formats::YUVSlices::new(
                (&y, &u, &v), (dst_w, dst_h), (dst_w, dst_w / 2, dst_w / 2),
            );
            let bs = encoder.encode(&slices).unwrap();
            std::hint::black_box(bs.to_vec());
        });
        println!("  NEW total:       min={:.2}ms  avg={:.2}ms  max={:.2}ms",
            min.as_secs_f64() * 1000.0, avg.as_secs_f64() * 1000.0, max.as_secs_f64() * 1000.0);
    }

    // ── Also test 1920×1080 → 1080p (no downscale) ──────────────────────────
    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    let hd_w = 1920usize;
    let hd_h = 1080usize;
    println!("Source: {hd_w}×{hd_h} → Target: {hd_w}×{hd_h} (no downscale, {iterations} iterations)");
    println!("─────────────────────────────────────────────────────────────────");

    let bgra_1080 = make_test_bgra(hd_w, hd_h);

    // Old: swap only (no downscale) → YUV → encode
    {
        let mut rgba = bgra_1080.clone();
        for pixel in rgba.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }

        let enc_cfg = openh264::encoder::EncoderConfig::new()
            .max_frame_rate(openh264::encoder::FrameRate::from_hz(60.0))
            .bitrate(openh264::encoder::BitRate::from_bps(6_000_000))
            .rate_control_mode(openh264::encoder::RateControlMode::Bitrate);
        let mut encoder = openh264::encoder::Encoder::with_api_config(
            openh264::OpenH264API::from_source(),
            enc_cfg,
        ).unwrap();
        let src = openh264::formats::RgbaSliceU8::new(&rgba, (hd_w, hd_h));
        let yuv = openh264::formats::YUVBuffer::from_rgb_source(src);
        for _ in 0..3 { let _ = encoder.encode(&yuv).unwrap(); }

        let (min, avg, max) = bench_n(iterations, || {
            let mut rgba2 = bgra_1080.clone();
            for pixel in rgba2.chunks_exact_mut(4) { pixel.swap(0, 2); }
            let src = openh264::formats::RgbaSliceU8::new(&rgba2, (hd_w, hd_h));
            let yuv = openh264::formats::YUVBuffer::from_rgb_source(src);
            let bs = encoder.encode(&yuv).unwrap();
            std::hint::black_box(bs.to_vec());
        });
        println!("  OLD total:       min={:.2}ms  avg={:.2}ms  max={:.2}ms",
            min.as_secs_f64() * 1000.0, avg.as_secs_f64() * 1000.0, max.as_secs_f64() * 1000.0);
    }

    // New: fused convert (no downscale) → YUVSlices → encode
    {
        let enc_cfg = openh264::encoder::EncoderConfig::new()
            .max_frame_rate(openh264::encoder::FrameRate::from_hz(60.0))
            .bitrate(openh264::encoder::BitRate::from_bps(6_000_000))
            .rate_control_mode(openh264::encoder::RateControlMode::Bitrate);
        let mut encoder = openh264::encoder::Encoder::with_api_config(
            openh264::OpenH264API::from_source(),
            enc_cfg,
        ).unwrap();
        for _ in 0..3 {
            let (y, u, v) = bgra_to_yuv420_bt709(&bgra_1080, hd_w, hd_h);
            let slices = openh264::formats::YUVSlices::new(
                (&y, &u, &v), (hd_w, hd_h), (hd_w, hd_w / 2, hd_w / 2),
            );
            let _ = encoder.encode(&slices).unwrap();
        }
        let (min, avg, max) = bench_n(iterations, || {
            let (y, u, v) = bgra_to_yuv420_bt709(&bgra_1080, hd_w, hd_h);
            let slices = openh264::formats::YUVSlices::new(
                (&y, &u, &v), (hd_w, hd_h), (hd_w, hd_w / 2, hd_w / 2),
            );
            let bs = encoder.encode(&slices).unwrap();
            std::hint::black_box(bs.to_vec());
        });
        println!("  NEW total:       min={:.2}ms  avg={:.2}ms  max={:.2}ms",
            min.as_secs_f64() * 1000.0, avg.as_secs_f64() * 1000.0, max.as_secs_f64() * 1000.0);
    }

    println!("\n╔══════════════════════════════════════════════════════════════╗");
    println!("║   Benchmark complete                                       ║");
    println!("╚══════════════════════════════════════════════════════════════╝");
}
