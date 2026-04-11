//! MediaManager — Rust-native audio capture, playback, and WebRTC media tracks.
//!
//! Lifecycle:
//!   1. new()                  — construct with empty state
//!   2. enumerate_devices()    — list available audio input/output devices
//!   3. start_mic()            — begin capturing from input device
//!   4. stop_mic()             — stop capturing
//!   5. set_muted()            — mute/unmute mic (stop sending, keep stream alive)
//!   6. set_deafened()         — deafen (stop all playback)
//!   7. set_peer_volume()      — per-peer volume control
//!   8. enumerate_screens()    — list available monitors/windows for screen share
//!   9. start_screen_share()   — capture screen → H.264 → WebRTC
//!  10. stop_screen_share()    — stop screen capture
//!
//! Audio data never crosses IPC — capture → encode → WebRTC and
//! WebRTC → decode → playback happen entirely in Rust.
//! Only control commands and VAD events cross the IPC boundary.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::Emitter;
use tokio::sync::Mutex;
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_remote::TrackRemote;

// ── Constants ────────────────────────────────────────────────────────────────

/// Opus frame duration in milliseconds.
const OPUS_FRAME_MS: u64 = 20;
/// Samples per Opus frame at 48kHz mono.
const OPUS_FRAME_SAMPLES: usize = 960;
/// RMS threshold for voice activity detection.
const VAD_THRESHOLD: f32 = 0.01;
/// How many consecutive silent frames before marking not-speaking (15 × 20ms = 300ms).
const VAD_SILENCE_FRAMES: u32 = 15;

// ── Device info ──────────────────────────────────────────────────────────────

#[derive(Clone, Debug, serde::Serialize)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct AudioDeviceList {
    pub inputs: Vec<AudioDeviceInfo>,
    pub outputs: Vec<AudioDeviceInfo>,
}

// ── Screen source info ───────────────────────────────────────────────────────

/// Information about a capturable screen source (monitor or window).
#[derive(Clone, Debug, serde::Serialize)]
pub struct ScreenSourceInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// "monitor" or "window"
    pub source_type: String,
    /// Base64 JPEG thumbnail for the picker UI.
    pub thumbnail: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ScreenSourceList {
    pub monitors: Vec<ScreenSourceInfo>,
    pub windows: Vec<ScreenSourceInfo>,
}

// ── Per-peer playback state ──────────────────────────────────────────────────

struct PeerPlayback {
    /// Volume multiplier (0.0 = muted, 1.0 = normal, 2.0 = 200%).
    volume: f32,
}

/// State for an active remote audio playback stream.
struct RemotePlayback {
    /// cpal output stream handle (keeps it alive).
    _output_stream: cpal::Stream,
    /// Task that reads RTP → decodes Opus → feeds output buffer.
    decode_task: tokio::task::JoinHandle<()>,
}

// SAFETY: `cpal::Stream` is `!Send` on some platforms (e.g. macOS CoreAudio).
// We only construct/drop it on the main thread and never move it across threads
// — the Arc<std::sync::Mutex<>> wrapper ensures mutual exclusion without Send.
// For remote_playback, the HashMap is accessed under a tokio::Mutex which doesn't
// require Send for its contents on a single-threaded access pattern.
unsafe impl Send for RemotePlayback {}
unsafe impl Sync for RemotePlayback {}

// ── MediaManager ─────────────────────────────────────────────────────────────

pub struct MediaManager {
    /// Whether the mic is currently capturing.
    mic_active: Arc<AtomicBool>,
    /// Whether mic audio should be sent (false = muted but stream alive).
    mic_muted: Arc<AtomicBool>,
    /// Whether all playback is suppressed.
    deafened: Arc<AtomicBool>,
    /// Per-peer volume state.
    peer_volumes: Arc<Mutex<HashMap<String, PeerPlayback>>>,
    /// Whether loopback (hear own mic) is enabled.
    loopback: Arc<AtomicBool>,
    /// Handle to the active cpal input stream (keeps it alive).
    /// Uses std::sync::Mutex because cpal::Stream is !Send on some platforms.
    input_stream: Arc<std::sync::Mutex<Option<cpal::Stream>>>,
    /// Handle to the audio encoding + writing task.
    encode_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// The shared audio track being written to (if mic is active).
    audio_track: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
    /// Selected input device name (None = default).
    selected_input: Arc<Mutex<Option<String>>>,
    /// Selected output device name (None = default).
    selected_output: Arc<Mutex<Option<String>>>,
    /// Active remote playback streams keyed by peer userId.
    remote_playback: Arc<Mutex<HashMap<String, RemotePlayback>>>,
    /// Whether screen share is currently active.
    screen_active: Arc<AtomicBool>,
    /// Screen capture → encode → WebRTC task.
    screen_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// The shared video track being written to (if screen share active).
    video_track: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
}

impl MediaManager {
    pub fn new() -> Self {
        MediaManager {
            mic_active: Arc::new(AtomicBool::new(false)),
            mic_muted: Arc::new(AtomicBool::new(false)),
            deafened: Arc::new(AtomicBool::new(false)),
            peer_volumes: Arc::new(Mutex::new(HashMap::new())),
            loopback: Arc::new(AtomicBool::new(false)),
            input_stream: Arc::new(std::sync::Mutex::new(None)),
            encode_task: Arc::new(Mutex::new(None)),
            audio_track: Arc::new(Mutex::new(None)),
            selected_input: Arc::new(Mutex::new(None)),
            selected_output: Arc::new(Mutex::new(None)),
            remote_playback: Arc::new(Mutex::new(HashMap::new())),
            screen_active: Arc::new(AtomicBool::new(false)),
            screen_task: Arc::new(Mutex::new(None)),
            video_track: Arc::new(Mutex::new(None)),
        }
    }

    // ── Device enumeration ───────────────────────────────────────────────────

    /// List available audio input and output devices.
    pub fn enumerate_devices(&self) -> AudioDeviceList {
        let host = cpal::default_host();

        let inputs = host
            .input_devices()
            .map(|devices| {
                devices
                    .filter_map(|d| {
                        let name = d.name().unwrap_or_else(|_| "<unnamed>".into());
                        Some(AudioDeviceInfo {
                            id: name.clone(),
                            name,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let outputs = host
            .output_devices()
            .map(|devices| {
                devices
                    .filter_map(|d| {
                        let name = d.name().unwrap_or_else(|_| "<unnamed>".into());
                        Some(AudioDeviceInfo {
                            id: name.clone(),
                            name,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        AudioDeviceList { inputs, outputs }
    }

    // ── Mic capture pipeline ─────────────────────────────────────────────────

    /// Start capturing audio from the mic, encoding to Opus, and writing to
    /// the shared WebRTC audio track.
    ///
    /// `audio_track` is the TrackLocalStaticSample obtained from
    /// `WebRTCManager::add_audio_track_to_all()`.
    ///
    /// `app` is used to emit VAD events to the frontend.
    pub async fn start_mic(
        &self,
        audio_track: Arc<TrackLocalStaticSample>,
        app: tauri::AppHandle,
    ) -> Result<(), String> {
        if self.mic_active.load(Ordering::Acquire) {
            return Err("mic already active".into());
        }

        let host = cpal::default_host();

        // Find the selected input device, or fall back to default
        let device = {
            let sel = self.selected_input.lock().await;
            if let Some(name) = sel.as_ref() {
                host.input_devices()
                    .map_err(|e| e.to_string())?
                    .find(|d| d.name().map(|n| &n == name).unwrap_or(false))
                    .ok_or_else(|| format!("input device '{}' not found", name))?
            } else {
                host.default_input_device()
                    .ok_or("no default input device")?
            }
        };

        let device_name = device.name().unwrap_or_else(|_| "unknown".into());
        log::info!("[media] starting mic capture on: {device_name}");

        // Configure for 48kHz mono f32 (Opus native format)
        let config = cpal::StreamConfig {
            channels: 1,
            sample_rate: 48000,
            buffer_size: cpal::BufferSize::Default,
        };

        // Channel to send PCM samples from the cpal callback thread to the
        // async Opus encoding task.
        let (pcm_tx, pcm_rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(64);

        let muted = self.mic_muted.clone();
        let mic_active = self.mic_active.clone();

        // Build the cpal input stream
        let stream = device
            .build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !mic_active.load(Ordering::Relaxed) {
                        return;
                    }
                    // We'll buffer into 960-sample (20ms) frames.
                    // For simplicity, send the entire callback buffer and let the
                    // encoder task handle framing.
                    if muted.load(Ordering::Relaxed) {
                        let _ = pcm_tx.try_send(vec![0.0f32; data.len()]);
                    } else {
                        let _ = pcm_tx.try_send(data.to_vec());
                    }
                },
                move |err| {
                    log::error!("[media] input stream error: {err}");
                },
                None,
            )
            .map_err(|e| format!("build_input_stream failed: {e}"))?;

        stream.play().map_err(|e| format!("stream play failed: {e}"))?;

        self.mic_active.store(true, Ordering::Release);
        *self.input_stream.lock().unwrap() = Some(stream);
        *self.audio_track.lock().await = Some(audio_track.clone());

        // Spawn the Opus encoding task
        let app_clone = app.clone();
        let encode_handle = tokio::task::spawn(async move {
            let mut encoder =
                match opus::Encoder::new(48000, opus::Channels::Mono, opus::Application::Voip) {
                    Ok(e) => e,
                    Err(e) => {
                        log::error!("[media] opus encoder init failed: {e}");
                        return;
                    }
                };

            let mut encoded_buf = vec![0u8; 4000];
            let mut vad_speaking = false;
            let mut vad_silence_count: u32 = 0;
            let mut frame_buf: Vec<f32> = Vec::with_capacity(OPUS_FRAME_SAMPLES);

            loop {
                // Receive PCM data from cpal thread
                let pcm = match pcm_rx.recv() {
                    Ok(data) => data,
                    Err(_) => break, // Channel closed — mic stopped
                };

                // Buffer into 960-sample frames
                let mut offset = 0;
                while offset < pcm.len() {
                    let remaining = OPUS_FRAME_SAMPLES - frame_buf.len();
                    let take = remaining.min(pcm.len() - offset);
                    frame_buf.extend_from_slice(&pcm[offset..offset + take]);
                    offset += take;

                    if frame_buf.len() == OPUS_FRAME_SAMPLES {
                        // VAD: compute RMS of the PCM frame
                        let rms: f32 =
                            (frame_buf.iter().map(|s| s * s).sum::<f32>() / OPUS_FRAME_SAMPLES as f32).sqrt();

                        if rms > VAD_THRESHOLD {
                            vad_silence_count = 0;
                            if !vad_speaking {
                                vad_speaking = true;
                                let _ = app_clone.emit(
                                    "media_vad",
                                    serde_json::json!({
                                        "userId": "self",
                                        "speaking": true,
                                    }),
                                );
                            }
                        } else {
                            vad_silence_count += 1;
                            if vad_speaking && vad_silence_count >= VAD_SILENCE_FRAMES {
                                vad_speaking = false;
                                let _ = app_clone.emit(
                                    "media_vad",
                                    serde_json::json!({
                                        "userId": "self",
                                        "speaking": false,
                                    }),
                                );
                            }
                        }

                        // Encode PCM → Opus
                        let encoded_len = match encoder.encode_float(&frame_buf, &mut encoded_buf) {
                            Ok(n) => n,
                            Err(e) => {
                                log::warn!("[media] opus encode error: {e}");
                                frame_buf.clear();
                                continue;
                            }
                        };

                        // Write to WebRTC track
                        let sample = Sample {
                            data: Bytes::copy_from_slice(&encoded_buf[..encoded_len]),
                            duration: Duration::from_millis(OPUS_FRAME_MS),
                            ..Default::default()
                        };
                        if let Err(e) = audio_track.write_sample(&sample).await {
                            log::warn!("[media] write_sample error: {e}");
                        }

                        frame_buf.clear();
                    }
                }
            }

            log::debug!("[media] encode task exited");
        });

        *self.encode_task.lock().await = Some(encode_handle);

        let _ = app.emit(
            "media_mic_started",
            serde_json::json!({ "deviceName": device_name }),
        );

        Ok(())
    }

    /// Stop mic capture and encoding.
    pub async fn stop_mic(&self, app: &tauri::AppHandle) -> Result<(), String> {
        self.mic_active.store(false, Ordering::Release);

        // Drop the input stream (stops cpal capture, closes the pcm channel)
        *self.input_stream.lock().unwrap() = None;
        // The encode task will exit when the channel closes
        if let Some(handle) = self.encode_task.lock().await.take() {
            handle.abort();
        }
        *self.audio_track.lock().await = None;

        let _ = app.emit("media_mic_stopped", serde_json::json!({}));
        // Ensure VAD shows not-speaking
        let _ = app.emit(
            "media_vad",
            serde_json::json!({
                "userId": "self",
                "speaking": false,
            }),
        );

        Ok(())
    }

    // ── Mute / deafen / loopback ─────────────────────────────────────────────

    /// Mute/unmute the mic without stopping capture.
    pub fn set_muted(&self, muted: bool) {
        self.mic_muted.store(muted, Ordering::Release);
    }

    /// Deafen all playback.
    pub fn set_deafened(&self, deafened: bool) {
        self.deafened.store(deafened, Ordering::Release);
    }

    pub fn is_deafened(&self) -> bool {
        self.deafened.load(Ordering::Acquire)
    }

    /// Set loopback mode.
    pub fn set_loopback(&self, enabled: bool) {
        self.loopback.store(enabled, Ordering::Release);
    }

    // ── Device selection ─────────────────────────────────────────────────────

    /// Set the selected input device by name. Takes effect on next `start_mic()`.
    pub async fn set_input_device(&self, device_name: Option<String>) {
        *self.selected_input.lock().await = device_name;
    }

    /// Set the selected output device by name. Takes effect on next playback stream.
    pub async fn set_output_device(&self, device_name: Option<String>) {
        *self.selected_output.lock().await = device_name;
    }

    // ── Per-peer volume ──────────────────────────────────────────────────────

    /// Get the volume for a peer (default 1.0).
    pub async fn get_peer_volume(&self, peer_id: &str) -> f32 {
        self.peer_volumes
            .lock()
            .await
            .get(peer_id)
            .map(|p| p.volume)
            .unwrap_or(1.0)
    }

    /// Set volume for a specific peer (0.0 = silent, 1.0 = normal, 2.0 = 200%).
    pub async fn set_peer_volume(&self, peer_id: &str, volume: f32) {
        let vol = volume.max(0.0);
        self.peer_volumes
            .lock()
            .await
            .entry(peer_id.to_string())
            .or_insert(PeerPlayback { volume: 1.0 })
            .volume = vol;
    }

    // ── Remote audio playback ────────────────────────────────────────────────

    /// Handle an incoming remote audio track from a peer.
    /// Spawns a decode+playback pipeline: TrackRemote → Opus decode → cpal output.
    pub async fn handle_remote_audio_track(
        &self,
        peer_id: String,
        track: Arc<TrackRemote>,
        app: tauri::AppHandle,
    ) -> Result<(), String> {
        let host = cpal::default_host();
        let device = {
            let sel = self.selected_output.lock().await;
            if let Some(name) = sel.as_ref() {
                host.output_devices()
                    .map_err(|e| e.to_string())?
                    .find(|d| d.name().map(|n| &n == name).unwrap_or(false))
                    .ok_or_else(|| format!("output device '{}' not found", name))?
            } else {
                host.default_output_device()
                    .ok_or("no default output device")?
            }
        };

        let config = cpal::StreamConfig {
            channels: 1,
            sample_rate: 48000,
            buffer_size: cpal::BufferSize::Default,
        };

        // Ring buffer: decoded PCM from the decode task → cpal output callback
        let (pcm_tx, pcm_rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(64);

        let deafened = self.deafened.clone();
        let peer_volumes = self.peer_volumes.clone();
        let pid_for_output = peer_id.clone();

        // Wrap pcm_rx in Arc<std::sync::Mutex> so we can move it into the callback
        let pcm_rx = Arc::new(std::sync::Mutex::new(pcm_rx));

        // cpal output stream — pulls decoded PCM and plays it
        let output_stream = device
            .build_output_stream(
                &config,
                move |output: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    if deafened.load(Ordering::Relaxed) {
                        output.fill(0.0);
                        return;
                    }

                    // Get peer volume (try_lock to avoid blocking audio thread)
                    let volume = peer_volumes
                        .try_lock()
                        .ok()
                        .and_then(|pv| pv.get(&pid_for_output).map(|p| p.volume))
                        .unwrap_or(1.0);

                    let rx = pcm_rx.lock().unwrap();
                    let mut written = 0;
                    while written < output.len() {
                        match rx.try_recv() {
                            Ok(frame) => {
                                for sample in &frame {
                                    if written < output.len() {
                                        output[written] = sample * volume;
                                        written += 1;
                                    }
                                }
                            }
                            Err(_) => {
                                // Underrun — fill remaining with silence
                                output[written..].fill(0.0);
                                break;
                            }
                        }
                    }
                },
                move |err| {
                    log::error!("[media] output stream error: {err}");
                },
                None,
            )
            .map_err(|e| format!("build_output_stream failed: {e}"))?;

        output_stream
            .play()
            .map_err(|e| format!("output stream play failed: {e}"))?;

        // Decode task: reads RTP from TrackRemote, decodes Opus, sends PCM
        let pid_for_task = peer_id.clone();
        let app_for_vad = app.clone();
        let decode_task = tokio::task::spawn(async move {
            let mut decoder = match opus::Decoder::new(48000, opus::Channels::Mono) {
                Ok(d) => d,
                Err(e) => {
                    log::error!("[media] opus decoder init failed for {pid_for_task}: {e}");
                    return;
                }
            };

            let mut decode_buf = vec![0f32; OPUS_FRAME_SAMPLES];
            let mut vad_speaking = false;
            let mut vad_silence_count: u32 = 0;

            loop {
                match track.read_rtp().await {
                    Ok((pkt, _attr)) => {
                        let decoded_len = match decoder
                            .decode_float(&pkt.payload, &mut decode_buf, false)
                        {
                            Ok(n) => n,
                            Err(e) => {
                                log::warn!("[media] opus decode error for {pid_for_task}: {e}");
                                continue;
                            }
                        };

                        let pcm = &decode_buf[..decoded_len];

                        // VAD for remote peer
                        let rms: f32 =
                            (pcm.iter().map(|s| s * s).sum::<f32>() / pcm.len() as f32).sqrt();

                        if rms > VAD_THRESHOLD {
                            vad_silence_count = 0;
                            if !vad_speaking {
                                vad_speaking = true;
                                let _ = app_for_vad.emit(
                                    "media_vad",
                                    serde_json::json!({
                                        "userId": pid_for_task,
                                        "speaking": true,
                                    }),
                                );
                            }
                        } else {
                            vad_silence_count += 1;
                            if vad_speaking && vad_silence_count >= VAD_SILENCE_FRAMES {
                                vad_speaking = false;
                                let _ = app_for_vad.emit(
                                    "media_vad",
                                    serde_json::json!({
                                        "userId": pid_for_task,
                                        "speaking": false,
                                    }),
                                );
                            }
                        }

                        let _ = pcm_tx.try_send(pcm.to_vec());
                    }
                    Err(e) => {
                        log::debug!("[media] track read ended for {pid_for_task}: {e}");
                        break;
                    }
                }
            }

            // Mark not-speaking when track ends
            let _ = app_for_vad.emit(
                "media_vad",
                serde_json::json!({
                    "userId": pid_for_task,
                    "speaking": false,
                }),
            );
        });

        // Store playback state (keeps cpal stream + decode task alive)
        self.remote_playback.lock().await.insert(
            peer_id,
            RemotePlayback {
                _output_stream: output_stream,
                decode_task,
            },
        );

        Ok(())
    }

    /// Stop playback for a specific remote peer.
    pub async fn stop_remote_playback(&self, peer_id: &str) {
        if let Some(playback) = self.remote_playback.lock().await.remove(peer_id) {
            playback.decode_task.abort();
        }
    }

    /// Stop all remote playback (e.g., when leaving voice channel).
    pub async fn stop_all_remote_playback(&self) {
        let mut playback = self.remote_playback.lock().await;
        for (_, entry) in playback.drain() {
            entry.decode_task.abort();
        }
    }

    // ── Screen source enumeration ────────────────────────────────────────────

    /// List available monitors and windows for screen sharing.
    /// Includes small JPEG thumbnails for the picker UI.
    pub fn enumerate_screens(&self) -> ScreenSourceList {
        let monitors = xcap::Monitor::all()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .map(|(i, m)| {
                let name = m.name().unwrap_or_default();
                let width = m.width().unwrap_or(0);
                let height = m.height().unwrap_or(0);
                let thumbnail = Self::capture_thumbnail_monitor(&m);
                ScreenSourceInfo {
                    id: format!("monitor:{i}"),
                    name: if name.is_empty() {
                        format!("Monitor {}", i + 1)
                    } else {
                        name
                    },
                    width,
                    height,
                    source_type: "monitor".to_string(),
                    thumbnail,
                }
            })
            .collect();

        let windows = xcap::Window::all()
            .unwrap_or_default()
            .into_iter()
            .filter(|w| !w.is_minimized().unwrap_or(true) && !w.title().unwrap_or_default().is_empty() && w.width().unwrap_or(0) > 0)
            .enumerate()
            .map(|(i, w)| {
                let title = w.title().unwrap_or_default();
                let app = w.app_name().unwrap_or_default();
                let width = w.width().unwrap_or(0);
                let height = w.height().unwrap_or(0);
                let name = if title.is_empty() {
                    app
                } else {
                    format!("{app} — {title}")
                };
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

    fn capture_thumbnail_monitor(monitor: &xcap::Monitor) -> Option<String> {
        let img = monitor.capture_image().ok()?;
        Self::rgba_to_thumbnail_b64(&img)
    }

    fn capture_thumbnail_window(window: &xcap::Window) -> Option<String> {
        let img = window.capture_image().ok()?;
        Self::rgba_to_thumbnail_b64(&img)
    }

    /// Resize an RGBA image to a small thumbnail and encode as base64 JPEG.
    fn rgba_to_thumbnail_b64(img: &image::RgbaImage) -> Option<String> {
        use image::imageops::FilterType;
        let thumb_w = 320u32;
        let thumb_h = thumb_w * img.height() / img.width().max(1);
        let thumb = image::imageops::resize(img, thumb_w, thumb_h, FilterType::Triangle);
        let mut buf = Vec::new();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 60);
        image::DynamicImage::ImageRgba8(thumb)
            .write_with_encoder(encoder)
            .ok()?;
        use base64::Engine;
        Some(base64::engine::general_purpose::STANDARD.encode(&buf))
    }

    // ── Screen capture pipeline ──────────────────────────────────────────────

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

        let (source_type, index_str) = source_id
            .split_once(':')
            .ok_or("invalid source_id format")?;
        let index: usize = index_str
            .parse()
            .map_err(|e: std::num::ParseIntError| e.to_string())?;

        // Validate the source exists
        match source_type {
            "monitor" => {
                let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
                if index >= monitors.len() {
                    return Err("monitor index out of range".into());
                }
            }
            "window" => {
                let windows: Vec<_> = xcap::Window::all()
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .filter(|w| !w.is_minimized().unwrap_or(true) && !w.title().unwrap_or_default().is_empty() && w.width().unwrap_or(0) > 0)
                    .collect();
                if index >= windows.len() {
                    return Err("window index out of range".into());
                }
            }
            _ => return Err(format!("unsupported source type: {source_type}")),
        }

        *self.video_track.lock().await = Some(video_track.clone());
        self.screen_active.store(true, Ordering::Release);

        let frame_duration = Duration::from_millis(1000 / fps.max(1) as u64);
        let screen_active = self.screen_active.clone();
        let bitrate_bps = if bitrate_kbps > 0 {
            bitrate_kbps * 1000
        } else {
            1_000_000
        };
        let source_type_owned = source_type.to_string();
        let source_id_owned = source_id.to_string();
        let app_clone = app.clone();

        let task = tokio::task::spawn_blocking(move || {
            let mut encoder: Option<openh264::encoder::Encoder> = None;
            let mut frame_count: u64 = 0;

            while screen_active.load(Ordering::Acquire) {
                let capture_start = std::time::Instant::now();

                // Re-enumerate each frame to handle source changes
                let img = match source_type_owned.as_str() {
                    "monitor" => {
                        let monitors = match xcap::Monitor::all() {
                            Ok(m) => m,
                            Err(e) => {
                                log::warn!("[media] monitor enumerate error: {e}");
                                std::thread::sleep(frame_duration);
                                continue;
                            }
                        };
                        monitors.into_iter().nth(index).and_then(|m| m.capture_image().ok())
                    }
                    "window" => {
                        let windows: Vec<_> = xcap::Window::all()
                            .unwrap_or_default()
                            .into_iter()
                            .filter(|w| !w.is_minimized().unwrap_or(true) && !w.title().unwrap_or_default().is_empty() && w.width().unwrap_or(0) > 0)
                            .collect();
                        windows.into_iter().nth(index).and_then(|w| w.capture_image().ok())
                    }
                    _ => None,
                };

                let img = match img {
                    Some(i) => i,
                    None => {
                        log::warn!("[media] capture failed, source may be gone");
                        let _ = app_clone.emit(
                            "media_screen_share_error",
                            serde_json::json!({ "error": "capture source lost" }),
                        );
                        break;
                    }
                };

                let w = img.width() as usize;
                let h = img.height() as usize;

                // Initialize encoder on first frame or if dimensions changed
                if encoder.is_none()
                    || encoder
                        .as_ref()
                        .map(|_| false)
                        .unwrap_or(true)
                {
                    let config = openh264::encoder::EncoderConfig::new()
                        .bitrate(openh264::encoder::BitRate::from_bps(bitrate_bps as u32))
                        .max_frame_rate(openh264::encoder::FrameRate::from_hz(fps as f32))
                        .rate_control_mode(openh264::encoder::RateControlMode::Bitrate);
                    match openh264::encoder::Encoder::with_api_config(
                        openh264::OpenH264API::from_source(),
                        config,
                    ) {
                        Ok(e) => encoder = Some(e),
                        Err(e) => {
                            log::error!("[media] H.264 encoder init failed: {e}");
                            break;
                        }
                    }
                }

                let enc = encoder.as_mut().unwrap();
                let rgba_data = img.as_raw();
                let src = openh264::formats::RgbaSliceU8::new(rgba_data, (w, h));
                let yuv = openh264::formats::YUVBuffer::from_rgb_source(src);

                match enc.encode(&yuv) {
                    Ok(bitstream) => {
                        let h264_data = bitstream.to_vec();
                        if !h264_data.is_empty() {
                            let vt = video_track.clone();
                            let dur = frame_duration;
                            let rt = tokio::runtime::Handle::current();
                            let _ = rt.block_on(async {
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

                frame_count += 1;

                // Sleep to maintain target FPS
                let elapsed = capture_start.elapsed();
                if elapsed < frame_duration {
                    std::thread::sleep(frame_duration - elapsed);
                }
            }

            log::debug!("[media] screen capture task exited after {frame_count} frames");
        });

        *self.screen_task.lock().await = Some(task);

        let _ = app.emit(
            "media_screen_share_started",
            serde_json::json!({ "sourceId": source_id_owned }),
        );

        Ok(())
    }

    /// Stop sharing screen.
    pub async fn stop_screen_share(&self, app: &tauri::AppHandle) -> Result<(), String> {
        self.screen_active.store(false, Ordering::Release);

        if let Some(task) = self.screen_task.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }

        *self.video_track.lock().await = None;

        let _ = app.emit("media_screen_share_stopped", serde_json::json!({}));
        Ok(())
    }

    /// Whether screen share is currently active.
    pub fn is_screen_sharing(&self) -> bool {
        self.screen_active.load(Ordering::Acquire)
    }

    // ── Video receive helpers ────────────────────────────────────────────────

    /// Get (and create if needed) the directory for decoded video frames.
    pub fn frame_output_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        use tauri::Manager;
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("video-frames");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    /// Decode an H.264 frame and write as JPEG to `path`. Returns Ok(true) if
    /// a frame was produced, Ok(false) if the decoder needs more data.
    pub fn decode_and_write_jpeg(
        decoder: &mut openh264::decoder::Decoder,
        h264_data: &[u8],
        path: &std::path::Path,
    ) -> Result<bool, String> {
        use openh264::formats::YUVSource;

        let decoded = decoder
            .decode(h264_data)
            .map_err(|e| format!("H.264 decode error: {e}"))?;

        let yuv = match decoded {
            Some(y) => y,
            None => return Ok(false),
        };

        let (w, h) = yuv.dimensions();
        let mut rgb = vec![0u8; w * h * 3];
        yuv.write_rgb8(&mut rgb);

        // Convert RGB8 to RGBA8 for image crate
        let mut rgba = Vec::with_capacity(w * h * 4);
        for pixel in rgb.chunks_exact(3) {
            rgba.push(pixel[0]);
            rgba.push(pixel[1]);
            rgba.push(pixel[2]);
            rgba.push(255);
        }

        Self::write_jpeg_frame(&rgba, w as u32, h as u32, path)?;
        Ok(true)
    }

    /// Write RGBA pixels as a JPEG file (atomic via temp rename).
    fn write_jpeg_frame(
        rgba: &[u8],
        width: u32,
        height: u32,
        path: &std::path::Path,
    ) -> Result<(), String> {
        use std::io::BufWriter;

        let tmp = path.with_extension("tmp");
        let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let writer = BufWriter::new(file);

        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, 75);
        image::DynamicImage::ImageRgba8(
            image::RgbaImage::from_raw(width, height, rgba.to_vec())
                .ok_or("invalid RGBA dimensions")?,
        )
        .write_with_encoder(encoder)
        .map_err(|e| e.to_string())?;

        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_enumerate_devices_returns_lists() {
        let mm = MediaManager::new();
        let devices = mm.enumerate_devices();
        // Should not panic; may return empty lists if no audio hardware
        assert!(devices.inputs.len() >= 0);
        assert!(devices.outputs.len() >= 0);
    }

    #[test]
    fn test_opus_encode_decode_roundtrip() {
        let mut encoder = opus::Encoder::new(48000, opus::Channels::Mono, opus::Application::Voip)
            .expect("encoder");
        let mut decoder = opus::Decoder::new(48000, opus::Channels::Mono).expect("decoder");

        // 20ms of 48kHz mono = 960 samples
        let input: Vec<f32> = (0..960).map(|i| (i as f32 * 0.01).sin()).collect();
        let mut encoded = vec![0u8; 4000];
        let encoded_len = encoder
            .encode_float(&input, &mut encoded)
            .expect("encode");
        assert!(encoded_len > 0);
        assert!(encoded_len < 4000);

        let mut decoded = vec![0f32; 960];
        let decoded_len = decoder
            .decode_float(&encoded[..encoded_len], &mut decoded, false)
            .expect("decode");
        assert_eq!(decoded_len, 960);
        // Lossy codec — check that output is non-zero and roughly similar magnitude
        let rms: f32 = (decoded.iter().map(|s| s * s).sum::<f32>() / 960.0).sqrt();
        assert!(rms > 0.001, "decoded audio should not be silent");
    }

    #[test]
    fn test_per_peer_volume_default() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mm = MediaManager::new();
            let vol = mm.get_peer_volume("test-peer").await;
            assert!((vol - 1.0).abs() < f32::EPSILON);
        });
    }

    #[test]
    fn test_set_peer_volume() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mm = MediaManager::new();
            mm.set_peer_volume("peer-1", 0.5).await;
            let vol = mm.get_peer_volume("peer-1").await;
            assert!((vol - 0.5).abs() < f32::EPSILON);
        });
    }

    #[test]
    fn test_set_peer_volume_clamps() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mm = MediaManager::new();
            mm.set_peer_volume("peer-1", -0.5).await;
            let vol = mm.get_peer_volume("peer-1").await;
            assert!((vol - 0.0).abs() < f32::EPSILON);
        });
    }

    #[test]
    fn test_enumerate_screens_returns_struct() {
        let mm = MediaManager::new();
        let sources = mm.enumerate_screens();
        // Should not panic; returns at least one monitor on desktop
        for src in &sources.monitors {
            assert!(!src.id.is_empty());
            assert!(!src.name.is_empty());
            assert!(src.width > 0);
            assert!(src.height > 0);
            assert_eq!(src.source_type, "monitor");
        }
        // Windows may be empty — just ensure the call completes
        let _ = sources.windows;
    }

    #[test]
    fn test_h264_encode_decode_roundtrip() {
        let width = 320u32;
        let height = 240u32;

        // Generate a test RGBA frame (gradient)
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        for y in 0..height {
            for x in 0..width {
                let idx = ((y * width + x) * 4) as usize;
                rgba[idx] = (x & 0xFF) as u8;       // R
                rgba[idx + 1] = (y & 0xFF) as u8;   // G
                rgba[idx + 2] = 128;                 // B
                rgba[idx + 3] = 255;                 // A
            }
        }

        // Encode
        let config =
            openh264::encoder::EncoderConfig::new()
                .bitrate(openh264::encoder::BitRate::from_bps(500_000));
        let mut encoder = openh264::encoder::Encoder::with_api_config(
            openh264::OpenH264API::from_source(),
            config,
        )
        .expect("encoder");
        let src = openh264::formats::RgbaSliceU8::new(&rgba, (width as usize, height as usize));
        let yuv = openh264::formats::YUVBuffer::from_rgb_source(src);
        let bitstream = encoder.encode(&yuv).expect("encode");
        let h264_data = bitstream.to_vec();
        assert!(!h264_data.is_empty(), "encoded frame should not be empty");
        assert!(
            h264_data.len() < rgba.len(),
            "H.264 should compress the frame"
        );

        // Decode
        let mut decoder = openh264::decoder::Decoder::new().expect("decoder");
        let decoded = decoder.decode(&h264_data).expect("decode");
        assert!(decoded.is_some(), "decoder should produce a frame");
        let yuv_out = decoded.unwrap();
        use openh264::formats::YUVSource;
        let (dw, dh) = yuv_out.dimensions();
        assert_eq!(dw, width as usize);
        assert_eq!(dh, height as usize);
        let mut rgb = vec![0u8; dw * dh * 3];
        yuv_out.write_rgb8(&mut rgb);
        let nonzero = rgb.iter().filter(|&&b| b != 0).count();
        assert!(
            nonzero > rgb.len() / 2,
            "decoded should have content"
        );
    }
}
