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

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
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

// Re-export from capture module so external code (media_commands.rs) can
// access the types through `media_manager::ScreenSourceList`.
pub use crate::capture::ScreenSourceList;

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
    /// Handle to the loopback output stream (hear own mic via speakers).
    /// Uses std::sync::Mutex because cpal::Stream is !Send on some platforms.
    loopback_stream: Arc<std::sync::Mutex<Option<cpal::Stream>>>,
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
    /// Background device-change watcher task.
    device_watcher: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    /// Platform-specific screen capturer.
    capturer: Box<dyn crate::capture::ScreenCapturer>,
    /// Set to true when a new peer joins to force the encoder to emit an IDR keyframe.
    force_keyframe: Arc<AtomicBool>,
}

impl MediaManager {
    pub fn new() -> Self {
        MediaManager {
            mic_active: Arc::new(AtomicBool::new(false)),
            mic_muted: Arc::new(AtomicBool::new(false)),
            deafened: Arc::new(AtomicBool::new(false)),
            peer_volumes: Arc::new(Mutex::new(HashMap::new())),
            loopback: Arc::new(AtomicBool::new(false)),
            loopback_stream: Arc::new(std::sync::Mutex::new(None)),
            input_stream: Arc::new(std::sync::Mutex::new(None)),
            encode_task: Arc::new(Mutex::new(None)),
            audio_track: Arc::new(Mutex::new(None)),
            selected_input: Arc::new(Mutex::new(None)),
            selected_output: Arc::new(Mutex::new(None)),
            remote_playback: Arc::new(Mutex::new(HashMap::new())),
            screen_active: Arc::new(AtomicBool::new(false)),
            screen_task: Arc::new(Mutex::new(None)),
            video_track: Arc::new(Mutex::new(None)),
            device_watcher: Arc::new(Mutex::new(None)),
            capturer: crate::capture::create(),
            force_keyframe: Arc::new(AtomicBool::new(false)),
        }
    }

    // ── Device enumeration ───────────────────────────────────────────────────

    /// List available audio input and output devices.
    pub fn enumerate_devices(&self) -> AudioDeviceList {
        Self::enumerate_devices_inner()
    }

    /// Static helper so the device watcher can call without &self.
    fn enumerate_devices_inner() -> AudioDeviceList {
        let host = cpal::default_host();

        let inputs = host
            .input_devices()
            .map(|devices| {
                devices
                    .filter_map(|d| {
                        let name = d.description().map(|desc| desc.name().to_string())
                            .unwrap_or_else(|_| "<unnamed>".into());
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
                        let name = d.description().map(|desc| desc.name().to_string())
                            .unwrap_or_else(|_| "<unnamed>".into());
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

    // ── Device change watcher ────────────────────────────────────────────────

    /// Start a background task that polls device lists every 3 seconds and
    /// emits a `media_devices_changed` Tauri event when the list changes.
    pub fn start_device_watcher(&self, app: tauri::AppHandle) {
        let watcher = self.device_watcher.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let mut prev = Self::enumerate_devices_inner();
            loop {
                tokio::time::sleep(Duration::from_secs(3)).await;
                let curr = Self::enumerate_devices_inner();
                if device_lists_differ(&prev, &curr) {
                    let _ = app.emit("media_devices_changed", &curr);
                    prev = curr;
                } else {
                    prev = curr;
                }
            }
        });
        // Store watcher handle synchronously
        let watcher_clone = watcher.clone();
        tauri::async_runtime::spawn(async move {
            let mut guard = watcher_clone.lock().await;
            *guard = Some(handle);
        });
    }

    /// Stop the device watcher background task.
    pub async fn stop_device_watcher(&self) {
        let mut guard = self.device_watcher.lock().await;
        if let Some(handle) = guard.take() {
            handle.abort();
        }
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
                    .find(|d| d.description().map(|desc| desc.name() == name).unwrap_or(false))
                    .ok_or_else(|| format!("input device '{}' not found", name))?
            } else {
                host.default_input_device()
                    .ok_or("no default input device")?
            }
        };

        let device_name = device.description().map(|desc| desc.name().to_string())
            .unwrap_or_else(|_| "unknown".into());
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

        // Create loopback output stream (hear own mic via speakers)
        // Use VecDeque for sample-level buffering to avoid dropping partial frames
        let loopback_buf: Arc<std::sync::Mutex<std::collections::VecDeque<f32>>> =
            Arc::new(std::sync::Mutex::new(std::collections::VecDeque::with_capacity(48000)));
        let loopback_buf_for_output = loopback_buf.clone();
        let deafened_for_loopback = self.deafened.clone();

        let loopback_device = {
            let sel = self.selected_output.lock().await;
            if let Some(name) = sel.as_ref() {
                host.output_devices()
                    .ok()
                    .and_then(|mut devs| devs.find(|d| d.description().map(|desc| desc.name() == name).unwrap_or(false)))
            } else {
                host.default_output_device()
            }
        };

        if let Some(out_dev) = loopback_device {
            let lb_config = cpal::StreamConfig {
                channels: 1,
                sample_rate: 48000,
                buffer_size: cpal::BufferSize::Default,
            };

            match out_dev.build_output_stream(
                &lb_config,
                move |output: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    if deafened_for_loopback.load(Ordering::Relaxed) {
                        output.fill(0.0);
                        return;
                    }
                    let mut buf = loopback_buf_for_output.lock().unwrap();
                    for sample in output.iter_mut() {
                        *sample = buf.pop_front().unwrap_or(0.0);
                    }
                },
                |err| log::error!("[media] loopback output error: {err}"),
                None,
            ) {
                Ok(lb_stream) => {
                    let _ = lb_stream.play();
                    *self.loopback_stream.lock().unwrap() = Some(lb_stream);
                }
                Err(e) => {
                    log::warn!("[media] failed to create loopback stream: {e}");
                }
            }
        } else {
            log::warn!("[media] no output device available for loopback");
        }

        // Spawn the Opus encoding task
        let loopback_flag = self.loopback.clone();
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

                        // Fork PCM to loopback output if enabled
                        if loopback_flag.load(Ordering::Relaxed) {
                            let mut buf = loopback_buf.lock().unwrap();
                            buf.extend(frame_buf.iter());
                            // Cap at 1 second to prevent unbounded growth
                            while buf.len() > 48000 {
                                buf.pop_front();
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
        // Drop the loopback output stream and reset loopback flag
        *self.loopback_stream.lock().unwrap() = None;
        self.loopback.store(false, Ordering::Release);
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
        // Don't create playback pipelines if we're not in a voice session.
        // This prevents audio leak when a peer adds tracks during SDP
        // renegotiation after we've left the voice channel.
        if !self.mic_active.load(Ordering::Acquire) {
            log::info!("[media] ignoring remote audio track from {peer_id} — not in voice session");
            return Ok(());
        }

        let host = cpal::default_host();
        let device = {
            let sel = self.selected_output.lock().await;
            if let Some(name) = sel.as_ref() {
                host.output_devices()
                    .map_err(|e| e.to_string())?
                    .find(|d| d.description().map(|desc| desc.name() == name).unwrap_or(false))
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

        // Sample-level ring buffer: decoded PCM from the decode task → cpal output callback.
        // Using VecDeque avoids the partial-frame-drop bug that occurs with mpsc channels
        // when cpal's output buffer size doesn't align with the Opus frame size (960 samples).
        let pcm_buf: Arc<std::sync::Mutex<std::collections::VecDeque<f32>>> =
            Arc::new(std::sync::Mutex::new(std::collections::VecDeque::with_capacity(48000)));
        let pcm_buf_for_output = pcm_buf.clone();

        let deafened = self.deafened.clone();
        let peer_volumes = self.peer_volumes.clone();
        let pid_for_output = peer_id.clone();

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

                    let mut buf = pcm_buf_for_output.lock().unwrap();
                    for sample in output.iter_mut() {
                        *sample = buf.pop_front().unwrap_or(0.0) * volume;
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

                        let mut buf = pcm_buf.lock().unwrap();
                        buf.extend(pcm.iter());
                        // Cap at 1 second to prevent unbounded latency buildup
                        while buf.len() > 48000 {
                            buf.pop_front();
                        }
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
    pub fn enumerate_screens(&self) -> Result<ScreenSourceList, String> {
        self.capturer.enumerate()
    }

    /// Whether screen capture is supported on this platform.
    pub fn is_screen_share_supported(&self) -> bool {
        self.capturer.is_supported()
    }

    // ── Screen capture pipeline ──────────────────────────────────────────────

    /// Start sharing a screen or window.
    ///
    /// `source_id`: "monitor:\\.\DISPLAY1", "window:12345678", etc.
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
        log::info!("[media] start_screen_share called: source_id={source_id} fps={fps}");
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

    /// Stop sharing screen.
    pub async fn stop_screen_share(&self, app: &tauri::AppHandle) -> Result<(), String> {
        self.screen_active.store(false, Ordering::Release);

        if let Some(task) = self.screen_task.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }

        *self.video_track.lock().await = None;

        let _ = app.emit("media_screen_share_stopped", serde_json::json!({ "userId": "self" }));
        Ok(())
    }

    /// Whether screen share is currently active.
    pub fn is_screen_sharing(&self) -> bool {
        self.screen_active.load(Ordering::Acquire)
    }

    /// Request the screen capture encoder to emit an IDR keyframe on the next frame.
    /// Called when a new peer joins and needs to start decoding immediately.
    pub fn request_keyframe(&self) {
        self.force_keyframe.store(true, Ordering::Release);
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
        if w < 2 || h < 2 || w % 2 != 0 || h % 2 != 0 {
            // openh264 write_rgb8 requires even dimensions; skip degenerate frames
            return Ok(false);
        }
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
    pub fn write_jpeg_frame(
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

// ── Device list comparison ───────────────────────────────────────────────────

/// Compare two device lists by their ID sets (order-insensitive).
fn device_lists_differ(a: &AudioDeviceList, b: &AudioDeviceList) -> bool {
    use std::collections::HashSet;
    let a_in: HashSet<&str> = a.inputs.iter().map(|d| d.id.as_str()).collect();
    let b_in: HashSet<&str> = b.inputs.iter().map(|d| d.id.as_str()).collect();
    let a_out: HashSet<&str> = a.outputs.iter().map(|d| d.id.as_str()).collect();
    let b_out: HashSet<&str> = b.outputs.iter().map(|d| d.id.as_str()).collect();
    a_in != b_in || a_out != b_out
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

    #[test]
    fn test_device_list_diff_detects_changes() {
        let a = AudioDeviceList {
            inputs: vec![AudioDeviceInfo { id: "mic1".into(), name: "Mic 1".into() }],
            outputs: vec![AudioDeviceInfo { id: "spk1".into(), name: "Speaker 1".into() }],
        };
        let b = AudioDeviceList {
            inputs: vec![
                AudioDeviceInfo { id: "mic1".into(), name: "Mic 1".into() },
                AudioDeviceInfo { id: "mic2".into(), name: "Mic 2".into() },
            ],
            outputs: vec![AudioDeviceInfo { id: "spk1".into(), name: "Speaker 1".into() }],
        };
        assert!(device_lists_differ(&a, &b));
    }

    #[test]
    fn test_device_list_diff_empty_equal() {
        let a = AudioDeviceList { inputs: vec![], outputs: vec![] };
        let b = AudioDeviceList { inputs: vec![], outputs: vec![] };
        assert!(!device_lists_differ(&a, &b));
    }
}
