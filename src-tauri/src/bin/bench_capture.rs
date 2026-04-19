//! Screen capture benchmark: measures windows-capture (WGC + DXGI) performance.
//!
//! Run (Windows only):
//!   cd src-tauri && cargo run --bin bench_capture

use std::time::Duration;
#[cfg(target_os = "windows")]
use std::time::Instant;

const FRAMES: usize = 100;

fn main() {
    println!("╔══════════════════════════════════════════════════════════════╗");
    println!("║           Screen Capture Benchmark  ({FRAMES} frames)            ║");
    println!("╚══════════════════════════════════════════════════════════════╝\n");

    #[cfg(target_os = "windows")]
    {
        bench_windows_capture_wgc();
        bench_windows_capture_dxgi();
    }

    #[cfg(not(target_os = "windows"))]
    {
        println!("Screen capture benchmarks are only available on Windows.");
        println!("This platform does not yet have a capture backend.");
    }

    println!("Done.");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
struct BenchResult {
    name: String,
    total: Duration,
    frame_times: Vec<Duration>,
    frame_size: Option<(u32, u32)>,
    bytes_per_frame: Option<usize>,
}

#[cfg(target_os = "windows")]
impl BenchResult {
    fn print(&self) {
        println!("── {} ──", self.name);
        if let Some((w, h)) = self.frame_size {
            println!("  Resolution:  {w}x{h}");
        }
        if let Some(b) = self.bytes_per_frame {
            println!("  Bytes/frame: {} ({:.1} MB)", b, b as f64 / 1_048_576.0);
        }
        let n = self.frame_times.len();
        if n == 0 {
            println!("  No frames captured!\n");
            return;
        }
        let total = self.total;
        let fps = n as f64 / total.as_secs_f64();
        let mut sorted = self.frame_times.clone();
        sorted.sort();
        let avg = total / n as u32;
        let p50 = sorted[n / 2];
        let p95 = sorted[(n as f64 * 0.95) as usize];
        let p99 = sorted[(n as f64 * 0.99).min((n - 1) as f64) as usize];
        let min = sorted[0];
        let max = sorted[n - 1];

        println!("  Frames:      {n}");
        println!("  Total:       {total:?}");
        println!("  FPS:         {fps:.1}");
        println!("  Avg:         {avg:?}");
        println!("  P50:         {p50:?}");
        println!("  P95:         {p95:?}");
        println!("  P99:         {p99:?}");
        println!("  Min:         {min:?}");
        println!("  Max:         {max:?}");
        println!();
    }
}

// ── windows-capture: WGC via GraphicsCaptureApiHandler ──────────────────────

#[cfg(target_os = "windows")]
fn bench_windows_capture_wgc() {
    use std::sync::{Arc, Mutex};
    use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };

    struct WgcBench {
        times: Arc<Mutex<Vec<Duration>>>,
        frame_size: Arc<Mutex<Option<(u32, u32)>>>,
        bytes: Arc<Mutex<Option<usize>>>,
        last: Instant,
        count: usize,
    }

    impl GraphicsCaptureApiHandler for WgcBench {
        type Flags = (
            Arc<Mutex<Vec<Duration>>>,
            Arc<Mutex<Option<(u32, u32)>>>,
            Arc<Mutex<Option<usize>>>,
        );
        type Error = Box<dyn std::error::Error + Send + Sync>;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            Ok(Self {
                times: ctx.flags.0,
                frame_size: ctx.flags.1,
                bytes: ctx.flags.2,
                last: Instant::now(),
                count: 0,
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            capture_control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            let now = Instant::now();
            self.times.lock().unwrap().push(now - self.last);
            self.last = now;

            if self.count == 0 {
                *self.frame_size.lock().unwrap() = Some((frame.width(), frame.height()));
                if let Ok(mut buf) = frame.buffer() {
                    *self.bytes.lock().unwrap() = Some(buf.as_raw_buffer().len());
                }
            }

            self.count += 1;
            if self.count >= FRAMES {
                capture_control.stop();
            }
            Ok(())
        }

        fn on_closed(&mut self) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    let monitor = Monitor::primary().expect("primary monitor");
    println!("WGC target: {} ({}x{})",
        monitor.name().unwrap_or_default(),
        monitor.width().unwrap_or(0),
        monitor.height().unwrap_or(0),
    );

    let times: Arc<Mutex<Vec<Duration>>> = Arc::new(Mutex::new(Vec::with_capacity(FRAMES)));
    let frame_size: Arc<Mutex<Option<(u32, u32)>>> = Arc::new(Mutex::new(None));
    let bytes: Arc<Mutex<Option<usize>>> = Arc::new(Mutex::new(None));

    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        (times.clone(), frame_size.clone(), bytes.clone()),
    );

    let start = Instant::now();
    WgcBench::start(settings).expect("WGC capture failed");
    let total = start.elapsed();

    let times = Arc::try_unwrap(times).unwrap().into_inner().unwrap();
    let fs = Arc::try_unwrap(frame_size).unwrap().into_inner().unwrap();
    let b = Arc::try_unwrap(bytes).unwrap().into_inner().unwrap();

    BenchResult {
        name: "windows-capture WGC (Graphics Capture API — streaming)".into(),
        total,
        frame_times: times,
        frame_size: fs,
        bytes_per_frame: b,
    }.print();
}

// ── windows-capture: DXGI Desktop Duplication API ───────────────────────────

#[cfg(target_os = "windows")]
fn bench_windows_capture_dxgi() {
    use windows_capture::dxgi_duplication_api::DxgiDuplicationApi;
    use windows_capture::monitor::Monitor;

    let monitor = Monitor::primary().expect("primary monitor");
    let mut dup = match DxgiDuplicationApi::new(monitor) {
        Ok(d) => d,
        Err(e) => {
            println!("── windows-capture DXGI (Desktop Duplication — polling) ──");
            println!("  Init failed: {e}");
            println!("  (DXGI Duplication may not support this monitor config)\n");
            return;
        }
    };

    let mut times = Vec::with_capacity(FRAMES);
    let mut frame_size = None;
    let mut bytes = None;
    let start = Instant::now();

    // DXGI Duplication only returns frames when the desktop content changes.
    // We poll with a short timeout to measure raw throughput.
    for _ in 0..FRAMES {
        let t = Instant::now();
        match dup.acquire_next_frame(100) {
            Ok(mut frame) => {
                let elapsed = t.elapsed();
                if frame_size.is_none() {
                    if let Ok(mut buf) = frame.buffer() {
                        bytes = Some(buf.as_raw_buffer().len());
                    }
                    let m = Monitor::primary().unwrap();
                    frame_size = Some((m.width().unwrap_or(0), m.height().unwrap_or(0)));
                }
                times.push(elapsed);
            }
            Err(_) => {
                // Timeout — no desktop change, try again
                continue;
            }
        }
    }

    BenchResult {
        name: "windows-capture DXGI (Desktop Duplication — polling)".into(),
        total: start.elapsed(),
        frame_times: times,
        frame_size,
        bytes_per_frame: bytes,
    }.print();
}
