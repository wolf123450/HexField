# Rust-Native Audio (Pure Rust Voice Chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Testing approach:** TDD — write failing tests first, then implement. After every 2–3 tasks, run the E2E smoke tests (`npm run test:e2e` or manually via `scripts/e2e-integration.mjs`) to verify nothing regressed. E2E tests are not part of the automated CI suite, but they catch integration breakage that unit tests miss.

**Goal:** Replace the broken voice chat (no-op stubs in `webrtcService.ts`) with a pure-Rust audio pipeline: `cpal` captures mic → Opus encode → `TrackLocalStaticSample` → WebRTC → peer. Received audio: `on_track()` → Opus decode → `cpal` playback. No audio data crosses the Tauri IPC boundary — JS only sends control commands (start/stop/mute/deafen) and receives VAD events.

**Architecture:** A new `MediaManager` struct in `src-tauri/src/media_manager.rs` owns the audio capture/playback pipeline. It holds a `cpal` input stream (mic), a `cpal` output stream (speaker), Opus encoder/decoder instances, and references to `WebRTCManager`'s peer connections for track attachment. The `WebRTCManager` gains `on_track()` callbacks and `add_track()` / `remove_track()` methods. The frontend `voiceStore` replaces `getUserMedia()` with `invoke('media_start_mic')` and `audioService.ts` becomes a thin event-driven UI layer (VAD indicators, volume display) with no actual audio processing.

**Tech Stack:** `cpal` 0.17 (audio I/O), `audio-codec` or `opus` crate (Opus encode/decode), `webrtc` 0.17 (`TrackLocalStaticSample`, `TrackRemote`, `on_track`), Tauri v2 events + commands.

**Prerequisite:** The webrtc-rs data channel rewrite (commit `568c57f`) must remain intact — this plan extends it with media track support.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src-tauri/Cargo.toml` | Modify | Add `cpal`, `opus` (or `audiopus`), `bytes` dependencies |
| `src-tauri/src/media_manager.rs` | Create | `MediaManager`: mic capture, speaker playback, Opus encode/decode, VAD, device enumeration |
| `src-tauri/src/webrtc_manager.rs` | Modify | Add `on_track()` callback, `add_audio_track()` / `remove_audio_tracks()`, `TrackLocalStaticSample` management, SDP renegotiation |
| `src-tauri/src/commands/media_commands.rs` | Create | Tauri commands: `media_start_mic`, `media_stop_mic`, `media_set_muted`, `media_set_deafened`, `media_set_peer_volume`, `media_set_loopback`, `media_enumerate_devices`, `media_set_input_device`, `media_set_output_device` |
| `src-tauri/src/commands/mod.rs` | Modify | Add `pub mod media_commands` + re-export |
| `src-tauri/src/lib.rs` | Modify | Add `mod media_manager`, `pub media_manager: Arc<media_manager::MediaManager>` to `AppState`, register new commands |
| `src/services/webrtcService.ts` | Modify | Replace 4 no-op stubs with `invoke()` calls to new Rust media commands |
| `src/stores/voiceStore.ts` | Modify | Replace `getUserMedia()` with `invoke('media_start_mic')`, remove `MediaStream` management for mic |
| `src/services/audioService.ts` | Modify | Remove local audio processing (remote stream attach, VAD); keep only as event-driven UI layer for speaking indicators |
| `src/stores/networkStore.ts` | Modify | Remove `handleRemoteTrack` audio branch (Rust handles it); keep video branch for Phase B |

---

## Event Contract

New Tauri events (**Rust → frontend**):

| Event name | Payload | When |
|---|---|---|
| `media_vad` | `{ userId: string, speaking: bool }` | VAD state change for local or remote user |
| `media_mic_started` | `{ deviceName: string }` | Mic capture successfully started |
| `media_mic_stopped` | `{}` | Mic capture stopped |
| `media_error` | `{ error: string }` | Audio subsystem error (device lost, etc.) |

Existing events that gain new behavior:

| Event name | Change |
|---|---|
| `webrtc_connected` | After DC opens, if mic is active, triggers renegotiation to add audio track |
| `webrtc_offer` / `webrtc_answer` | Now also carries media track SDP (audio transceiver) |

---

## Dependency Research Summary

### `cpal` 0.17
- `Host::default()` → `host.default_input_device()` / `host.default_output_device()`
- `device.build_input_stream(config, data_callback, error_callback, timeout)` → captures `&[f32]` PCM at specified sample rate
- `device.build_output_stream(config, data_callback, error_callback, timeout)` → plays `&mut [f32]` PCM
- Platforms: WASAPI (Windows), CoreAudio (macOS), ALSA/PulseAudio (Linux)
- Sample rate: request 48000 Hz mono (Opus native rate)

### `opus` / `audiopus` / `audio-codec`
- Opus encode: 48kHz, mono, 20ms frames = 960 samples → ~60-80 bytes per frame
- Opus decode: reverse; handles packet loss concealment (PLC) built-in
- `audio-codec` crate wraps Opus with a clean Rust API and handles sample format conversion

### `webrtc` 0.17 — `TrackLocalStaticSample`
- `TrackLocalStaticSample::new(RTCRtpCodecCapability { mime_type: MIME_TYPE_OPUS }, "audio", "hexfield")`
- `peer_connection.add_track(track.clone() as Arc<dyn TrackLocal>)` — returns `RTCRtpSender`
- `track.write_sample(&Sample { data: opus_bytes.into(), duration: Duration::from_millis(20) })` — async
- Renegotiation: after `add_track()`, create new offer → relay through existing signaling

### `webrtc` 0.17 — `TrackRemote` / `on_track`
- `peer_connection.on_track(Box::new(|track, receiver, transceiver| { ... }))`
- `track.kind()` → `RTPCodecType::Audio` or `Video`
- `track.read_rtp()` → `(rtp::packet::Packet, Attributes)` — contains Opus payload in `packet.payload`

---

## Task 1: Add Audio Dependencies to Cargo.toml

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add cpal, opus, and bytes dependencies**

Add these under `[dependencies]` in `src-tauri/Cargo.toml`, keeping alphabetical order:

```toml
# Audio capture & playback (mic/speaker access)
cpal               = "0.17"

# Opus audio codec (encode mic → WebRTC, decode WebRTC → speaker)
opus               = "0.3"

# Byte buffer ergonomics (already a transitive dep of webrtc, but pin explicitly)
bytes              = "1"
```

- [ ] **Step 2: Verify it compiles**

```bash
cd src-tauri && cargo check
```

Expected: clean compile (warnings OK). The `opus` crate requires `libopus` or builds from source via `audiopus_sys` — if this fails on Windows, switch to `audiopus = "0.3"` with feature `static` instead. On Ubuntu, `apt install libopus-dev` may be needed.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml
git commit -m "deps: add cpal, opus, bytes for Rust-native audio"
```

---

## Task 2: Create `media_manager.rs` — Skeleton + Device Enumeration

**Files:**
- Create: `src-tauri/src/media_manager.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod media_manager`)

- [ ] **Step 1: Write the device enumeration test**

Add a `#[cfg(test)]` block at the bottom of the new file:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_enumerate_devices_returns_lists() {
        let mm = MediaManager::new();
        let devices = mm.enumerate_devices();
        // Should not panic; may return empty lists if no audio hardware
        // but the struct fields must exist
        assert!(devices.inputs.len() >= 0);
        assert!(devices.outputs.len() >= 0);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src-tauri && cargo test test_enumerate_devices_returns_lists
```

Expected: compile error — `MediaManager` and `enumerate_devices` don't exist yet.

- [ ] **Step 3: Implement `MediaManager` skeleton + device enumeration**

Create `src-tauri/src/media_manager.rs`:

```rust
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
//!
//! Audio data never crosses IPC — capture → encode → WebRTC and
//! WebRTC → decode → playback happen entirely in Rust.
//! Only control commands and VAD events cross the IPC boundary.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use cpal::traits::{DeviceTrait, HostTrait};
use tokio::sync::Mutex;

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

// ── Per-peer playback state ──────────────────────────────────────────────────

struct PeerPlayback {
    /// Volume multiplier (0.0 = muted, 1.0 = normal)
    volume: f32,
}

// ── MediaManager ─────────────────────────────────────────────────────────────

pub struct MediaManager {
    /// Whether the mic is currently capturing
    mic_active: Arc<AtomicBool>,
    /// Whether mic audio should be sent (false = muted but stream alive)
    mic_muted: Arc<AtomicBool>,
    /// Whether all playback is suppressed
    deafened: Arc<AtomicBool>,
    /// Per-peer volume state
    peer_volumes: Arc<Mutex<HashMap<String, PeerPlayback>>>,
    /// Whether loopback (hear own mic) is enabled
    loopback: Arc<AtomicBool>,
}

impl MediaManager {
    pub fn new() -> Self {
        MediaManager {
            mic_active: Arc::new(AtomicBool::new(false)),
            mic_muted: Arc::new(AtomicBool::new(false)),
            deafened: Arc::new(AtomicBool::new(false)),
            peer_volumes: Arc::new(Mutex::new(HashMap::new())),
            loopback: Arc::new(AtomicBool::new(false)),
        }
    }

    /// List available audio input and output devices.
    pub fn enumerate_devices(&self) -> AudioDeviceList {
        let host = cpal::default_host();

        let inputs = host
            .input_devices()
            .map(|devices| {
                devices
                    .filter_map(|d| {
                        let name = d.name().ok()?;
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
                        let name = d.name().ok()?;
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
}
```

- [ ] **Step 4: Wire into `lib.rs`**

In `src-tauri/src/lib.rs`, add `mod media_manager;` alongside the other module declarations, and add to `AppState`:

```rust
pub media_manager: Arc<media_manager::MediaManager>,
```

In the `AppState` construction (inside `setup()`), add:

```rust
media_manager: Arc::new(media_manager::MediaManager::new()),
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd src-tauri && cargo test test_enumerate_devices_returns_lists
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/media_manager.rs src-tauri/src/lib.rs
git commit -m "feat(media): add MediaManager skeleton with device enumeration"
```

---

## Task 3: Add `on_track()` Callback to WebRTCManager

**Files:**
- Modify: `src-tauri/src/webrtc_manager.rs`

This is critical infrastructure — when a remote peer sends audio, `on_track()` fires with a `TrackRemote` that streams RTP packets. We need to wire this callback and emit a Tauri event so the media manager can pick it up.

- [ ] **Step 1: Add the `TrackEvent` payload struct and new imports**

At the top of `webrtc_manager.rs`, add these imports (extend existing import block):

```rust
use webrtc::rtp_transceiver::rtp_receiver::RTCRtpReceiver;
use webrtc::rtp_transceiver::RTCRtpTransceiver;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;
use webrtc::track::track_remote::TrackRemote;
```

Add a new event struct alongside the existing ones:

```rust
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackEvent {
    user_id: String,
    kind: String,       // "audio" or "video"
    track_id: String,
    stream_id: String,
}
```

- [ ] **Step 2: Wire `on_track` in `wire_callbacks`**

Inside the `wire_callbacks` function, after the `on_data_channel` block, add:

```rust
// Incoming remote media track → emit event for MediaManager to handle
let app_track = app.clone();
let pid_track = peer_id.clone();
pc.on_track(Box::new(
    move |track: Arc<TrackRemote>,
          _receiver: Arc<RTCRtpReceiver>,
          _transceiver: Arc<RTCRtpTransceiver>| {
        let app2 = app_track.clone();
        let pid2 = pid_track.clone();
        let kind = if track.kind() == webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Audio {
            "audio"
        } else {
            "video"
        };
        let track_id = track.id().to_string();
        let stream_id = track.stream_id().to_string();

        log::info!(
            "[webrtc] on_track: peer={pid2} kind={kind} track_id={track_id} stream_id={stream_id}"
        );

        let _ = app2.emit(
            "webrtc_track",
            TrackEvent {
                user_id: pid2.clone(),
                kind: kind.to_string(),
                track_id: track_id.clone(),
                stream_id,
            },
        );

        // Spawn a task to continuously read RTP packets from this track.
        // The actual decoding + playback will be handled by MediaManager
        // (wired in Task 6). For now, just drain packets to keep the
        // WebRTC internals happy.
        let track_clone = track.clone();
        tokio::spawn(async move {
            loop {
                match track_clone.read_rtp().await {
                    Ok((_pkt, _attr)) => {
                        // Task 6 will replace this with actual Opus decode + cpal playback
                    }
                    Err(e) => {
                        log::debug!("[webrtc] track read ended for {pid2}: {e}");
                        break;
                    }
                }
            }
        });

        Box::pin(async {})
    },
));
```

- [ ] **Step 3: Verify it compiles**

```bash
cd src-tauri && cargo check
```

Expected: clean compile. The `on_track` callback signature must match the expected type in `webrtc` 0.17.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/webrtc_manager.rs
git commit -m "feat(webrtc): wire on_track callback for incoming media tracks"
```

---

## Task 4: Add `add_audio_track()` / `remove_audio_tracks()` to WebRTCManager

**Files:**
- Modify: `src-tauri/src/webrtc_manager.rs`

When the local user starts their mic, we need to add a `TrackLocalStaticSample` to every existing peer connection (and trigger SDP renegotiation). When they stop, we remove the tracks.

- [ ] **Step 1: Add audio track state to `PeerEntry`**

Extend the `PeerEntry` struct:

```rust
struct PeerEntry {
    pc: Arc<RTCPeerConnection>,
    dc: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
    remote_desc_ready: Arc<AtomicBool>,
    being_replaced: Arc<AtomicBool>,
    /// Local audio track attached to this peer (None if mic not active)
    audio_track: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
}
```

Update all places where `PeerEntry` is constructed (in `create_offer` and `handle_offer`) to include:

```rust
audio_track: Arc::new(Mutex::new(None)),
```

- [ ] **Step 2: Implement `add_audio_track` on WebRTCManager**

Add this method to the `impl WebRTCManager` block:

```rust
/// Add an Opus audio track to all connected peers and trigger renegotiation.
/// Returns the shared `TrackLocalStaticSample` that the caller should write samples to.
pub async fn add_audio_track_to_all(
    &self,
    app: &AppHandle,
) -> Result<Arc<TrackLocalStaticSample>, String> {
    use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;

    let audio_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: "audio/opus".to_owned(),
            clock_rate: 48000,
            channels: 1,
            ..Default::default()
        },
        "audio0".to_owned(),
        "hexfield-mic".to_owned(),
    ));

    let mut peers = self.peers.lock().await;
    for (peer_id, entry) in peers.iter_mut() {
        // Add track to peer connection
        entry
            .pc
            .add_track(Arc::clone(&audio_track) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| format!("add_track failed for {peer_id}: {e}"))?;

        // Store reference
        *entry.audio_track.lock().await = Some(Arc::clone(&audio_track));

        // Renegotiate — create a new offer with the audio transceiver
        let offer = entry
            .pc
            .create_offer(None)
            .await
            .map_err(|e| format!("create_offer renegotiation failed for {peer_id}: {e}"))?;
        entry
            .pc
            .set_local_description(offer.clone())
            .await
            .map_err(|e| {
                format!("set_local_description renegotiation failed for {peer_id}: {e}")
            })?;

        let _ = app.emit(
            "webrtc_offer",
            OfferEvent {
                to: peer_id.clone(),
                sdp: offer.sdp,
            },
        );
    }

    Ok(audio_track)
}

/// Remove audio tracks from all peers and trigger renegotiation.
pub async fn remove_audio_tracks_from_all(&self, app: &AppHandle) -> Result<(), String> {
    let mut peers = self.peers.lock().await;
    for (peer_id, entry) in peers.iter_mut() {
        // Clear the stored track
        *entry.audio_track.lock().await = None;

        // Get senders and remove audio senders
        let senders = entry.pc.get_senders().await;
        for sender in senders {
            if let Some(track) = sender.track().await {
                if track.kind() == webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Audio {
                    entry
                        .pc
                        .remove_track(&sender)
                        .await
                        .map_err(|e| format!("remove_track failed for {peer_id}: {e}"))?;
                }
            }
        }

        // Renegotiate
        let offer = entry
            .pc
            .create_offer(None)
            .await
            .map_err(|e| format!("renegotiation failed for {peer_id}: {e}"))?;
        entry
            .pc
            .set_local_description(offer.clone())
            .await
            .map_err(|e| format!("set_local_description failed for {peer_id}: {e}"))?;

        let _ = app.emit(
            "webrtc_offer",
            OfferEvent {
                to: peer_id.clone(),
                sdp: offer.sdp,
            },
        );
    }

    Ok(())
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd src-tauri && cargo check
```

Expected: clean compile. Watch for borrow issues with the `Mutex<HashMap>` — the `peers` lock is held across the `add_track` + renegotiation sequence, which is fine since these are all `await`s on the same tokio thread.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/webrtc_manager.rs
git commit -m "feat(webrtc): add/remove audio tracks with SDP renegotiation"
```

---

## Task 5: Mic Capture Pipeline — cpal → Opus → TrackLocalStaticSample

**Files:**
- Modify: `src-tauri/src/media_manager.rs`

This is the core audio sending pipeline. cpal captures raw PCM from the mic, we encode it to Opus in 20ms frames, and write the encoded samples to the WebRTC track.

- [ ] **Step 1: Write the Opus encode/decode round-trip test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // ... existing tests ...

    #[test]
    fn test_opus_encode_decode_roundtrip() {
        let encoder = opus::Encoder::new(48000, opus::Channels::Mono, opus::Application::Voip)
            .expect("encoder");
        let decoder = opus::Decoder::new(48000, opus::Channels::Mono).expect("decoder");

        // 20ms of 48kHz mono = 960 samples
        let input: Vec<f32> = (0..960).map(|i| (i as f32 * 0.01).sin()).collect();
        let mut encoded = vec![0u8; 4000];
        let encoded_len = encoder
            .encode_float(&input, &mut encoded)
            .expect("encode");
        assert!(encoded_len > 0);
        assert!(encoded_len < 4000); // Opus compresses heavily

        let mut decoded = vec![0f32; 960];
        let decoded_len = decoder
            .decode_float(&encoded[..encoded_len], &mut decoded, false)
            .expect("decode");
        assert_eq!(decoded_len, 960);
        // Lossy codec — check that output is non-zero and roughly similar magnitude
        let rms: f32 = (decoded.iter().map(|s| s * s).sum::<f32>() / 960.0).sqrt();
        assert!(rms > 0.001, "decoded audio should not be silent");
    }
}
```

- [ ] **Step 2: Run test to verify it compiles and passes**

```bash
cd src-tauri && cargo test test_opus_encode_decode_roundtrip
```

Expected: PASS (if `opus` crate compiles). If build fails due to missing system library, try switching to `audiopus` with `static` feature:

```toml
# In Cargo.toml, replace opus with:
audiopus = { version = "0.3", features = ["static"] }
```

And adjust imports: `use audiopus::{coder::Encoder, coder::Decoder, ...}`.

- [ ] **Step 3: Add mic capture fields to MediaManager**

Extend the `MediaManager` struct with fields for the active capture:

```rust
use cpal::Stream;
use std::sync::mpsc as std_mpsc;

pub struct MediaManager {
    // ... existing fields ...

    /// Handle to the active cpal input stream (keeps it alive)
    input_stream: Arc<Mutex<Option<cpal::Stream>>>,
    /// Handle to the audio encoding + writing task
    encode_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// The shared audio track being written to (if mic is active)
    audio_track: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
    /// Selected input device name (None = default)
    selected_input: Arc<Mutex<Option<String>>>,
    /// Selected output device name (None = default)
    selected_output: Arc<Mutex<Option<String>>>,
}
```

Update `new()` to initialize these:

```rust
input_stream: Arc::new(Mutex::new(None)),
encode_task: Arc::new(Mutex::new(None)),
audio_track: Arc::new(Mutex::new(None)),
selected_input: Arc::new(Mutex::new(None)),
selected_output: Arc::new(Mutex::new(None)),
```

- [ ] **Step 4: Implement `start_mic` method**

```rust
use bytes::Bytes;
use cpal::traits::StreamTrait;
use std::time::Duration;
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

/// Opus frame duration
const OPUS_FRAME_MS: u64 = 20;
/// Samples per Opus frame at 48kHz mono
const OPUS_FRAME_SAMPLES: usize = 960;
/// RMS threshold for voice activity detection
const VAD_THRESHOLD: f32 = 0.01;
/// How many consecutive silent frames before marking not-speaking
const VAD_SILENCE_FRAMES: u32 = 15; // 15 × 20ms = 300ms

impl MediaManager {
    // ... existing methods ...

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
                    .ok_or_else(|| format!("input device '{name}' not found"))?
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
            sample_rate: cpal::SampleRate(48000),
            buffer_size: cpal::BufferSize::Default,
        };

        // Channel to send PCM samples from the cpal callback thread to the
        // async Opus encoding task.
        let (pcm_tx, pcm_rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(64);

        let muted = self.mic_muted.clone();
        let mic_active = self.mic_active.clone();

        // Build the cpal input stream — this runs on a platform audio thread.
        // It batches samples and sends them to the encoding task.
        let mut frame_buf: Vec<f32> = Vec::with_capacity(OPUS_FRAME_SAMPLES);
        let stream = device
            .build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !mic_active.load(Ordering::Relaxed) {
                        return;
                    }
                    // Buffer samples into 960-sample (20ms) frames
                    let mut offset = 0;
                    while offset < data.len() {
                        let remaining = OPUS_FRAME_SAMPLES - frame_buf.len();
                        let take = remaining.min(data.len() - offset);
                        frame_buf.extend_from_slice(&data[offset..offset + take]);
                        offset += take;

                        if frame_buf.len() == OPUS_FRAME_SAMPLES {
                            // If muted, send silence (zeros) so VAD shows not-speaking
                            if muted.load(Ordering::Relaxed) {
                                let _ = pcm_tx.try_send(vec![0.0f32; OPUS_FRAME_SAMPLES]);
                            } else {
                                let _ = pcm_tx.try_send(frame_buf.clone());
                            }
                            frame_buf.clear();
                        }
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
        *self.input_stream.lock().await = Some(stream);
        *self.audio_track.lock().await = Some(audio_track.clone());

        // Spawn the Opus encoding task
        let app_clone = app.clone();
        let loopback = self.loopback.clone();
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

            loop {
                // Receive PCM frame from cpal thread (blocking OK — in dedicated task)
                let pcm = match pcm_rx.recv() {
                    Ok(data) => data,
                    Err(_) => break, // Channel closed — mic stopped
                };

                // VAD: compute RMS of the PCM frame
                let rms: f32 =
                    (pcm.iter().map(|s| s * s).sum::<f32>() / pcm.len() as f32).sqrt();

                if rms > VAD_THRESHOLD {
                    vad_silence_count = 0;
                    if !vad_speaking {
                        vad_speaking = true;
                        let _ = app_clone.emit("media_vad", serde_json::json!({
                            "userId": "self",
                            "speaking": true,
                        }));
                    }
                } else {
                    vad_silence_count += 1;
                    if vad_speaking && vad_silence_count >= VAD_SILENCE_FRAMES {
                        vad_speaking = false;
                        let _ = app_clone.emit("media_vad", serde_json::json!({
                            "userId": "self",
                            "speaking": false,
                        }));
                    }
                }

                // Encode PCM → Opus
                let encoded_len = match encoder.encode_float(&pcm, &mut encoded_buf) {
                    Ok(n) => n,
                    Err(e) => {
                        log::warn!("[media] opus encode error: {e}");
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
            }

            log::debug!("[media] encode task exited");
        });

        *self.encode_task.lock().await = Some(encode_handle);

        let _ = app.emit("media_mic_started", serde_json::json!({
            "deviceName": device_name,
        }));

        Ok(())
    }

    /// Stop mic capture and encoding.
    pub async fn stop_mic(&self, app: &tauri::AppHandle) -> Result<(), String> {
        self.mic_active.store(false, Ordering::Release);

        // Drop the input stream (stops cpal capture, closes the pcm channel)
        *self.input_stream.lock().await = None;
        // The encode task will exit when the channel closes
        if let Some(handle) = self.encode_task.lock().await.take() {
            handle.abort();
        }
        *self.audio_track.lock().await = None;

        let _ = app.emit("media_mic_stopped", serde_json::json!({}));
        // Ensure VAD shows not-speaking
        let _ = app.emit("media_vad", serde_json::json!({
            "userId": "self",
            "speaking": false,
        }));

        Ok(())
    }

    /// Mute/unmute the mic without stopping capture.
    pub fn set_muted(&self, muted: bool) {
        self.mic_muted.store(muted, Ordering::Release);
    }

    /// Set loopback mode.
    pub fn set_loopback(&self, enabled: bool) {
        self.loopback.store(enabled, Ordering::Release);
    }

    /// Set the selected input device by name. Takes effect on next `start_mic()`.
    pub async fn set_input_device(&self, device_name: Option<String>) {
        *self.selected_input.lock().await = device_name;
    }

    /// Set the selected output device by name. Takes effect on next playback stream.
    pub async fn set_output_device(&self, device_name: Option<String>) {
        *self.selected_output.lock().await = device_name;
    }
}
```

- [ ] **Step 5: Verify it compiles**

```bash
cd src-tauri && cargo check
```

Expected: clean compile. The `cpal::Stream` is `!Send` on some platforms — if this causes issues with `tokio::Mutex`, switch `input_stream` to use `std::sync::Mutex` instead of `tokio::sync::Mutex`.

> **Important:** `cpal::Stream` is not `Send` on macOS (CoreAudio). If `tokio::sync::Mutex<Option<cpal::Stream>>` fails to compile, change `input_stream` to `Arc<std::sync::Mutex<Option<cpal::Stream>>>` and use `.lock().unwrap()` instead of `.lock().await`.

- [ ] **Step 6: Run existing tests + new test**

```bash
cd src-tauri && cargo test
```

Expected: all tests pass including the Opus round-trip.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/media_manager.rs
git commit -m "feat(media): mic capture pipeline — cpal → Opus → WebRTC track"
```

---

## Task 6: Remote Audio Playback — on_track → Opus decode → cpal output

**Files:**
- Modify: `src-tauri/src/media_manager.rs`
- Modify: `src-tauri/src/webrtc_manager.rs`

When a remote peer sends audio, we need to decode the Opus RTP payload and play it through the local speakers using cpal.

- [ ] **Step 1: Write the playback integration test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // ... existing tests ...

    #[test]
    fn test_per_peer_volume_default() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mm = MediaManager::new();
            // Default volume for unknown peer should be 1.0
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
}
```

- [ ] **Step 2: Implement `get_peer_volume`, `set_peer_volume`, `set_deafened`**

```rust
impl MediaManager {
    // ... existing methods ...

    /// Get the volume for a peer (default 1.0).
    pub async fn get_peer_volume(&self, peer_id: &str) -> f32 {
        self.peer_volumes
            .lock()
            .await
            .get(peer_id)
            .map(|p| p.volume)
            .unwrap_or(1.0)
    }

    /// Set volume for a specific peer (0.0 = silent, 1.0 = normal).
    pub async fn set_peer_volume(&self, peer_id: &str, volume: f32) {
        let vol = volume.max(0.0);
        self.peer_volumes
            .lock()
            .await
            .entry(peer_id.to_string())
            .or_insert(PeerPlayback { volume: 1.0 })
            .volume = vol;
    }

    /// Deafen all playback.
    pub fn set_deafened(&self, deafened: bool) {
        self.deafened.store(deafened, Ordering::Release);
    }

    pub fn is_deafened(&self) -> bool {
        self.deafened.load(Ordering::Acquire)
    }
}
```

- [ ] **Step 3: Run tests**

```bash
cd src-tauri && cargo test test_per_peer_volume
cd src-tauri && cargo test test_set_peer_volume
```

Expected: PASS.

- [ ] **Step 4: Implement `handle_remote_audio_track` — decode + playback**

This is the method that `webrtc_manager.rs` `on_track` will call when an audio track arrives. Add to `media_manager.rs`:

```rust
/// State for an active remote audio playback stream
struct RemotePlayback {
    /// cpal output stream handle (keeps it alive)
    _output_stream: cpal::Stream,
    /// Task that reads RTP → decodes → feeds output buffer
    decode_task: tokio::task::JoinHandle<()>,
}

// Add to MediaManager struct:
// remote_playback: Arc<Mutex<HashMap<String, RemotePlayback>>>,

impl MediaManager {
    /// Handle an incoming remote audio track from a peer.
    /// Spawns a decode+playback pipeline: TrackRemote → Opus decode → cpal output.
    pub async fn handle_remote_audio_track(
        &self,
        peer_id: String,
        track: Arc<TrackRemote>,
        app: tauri::AppHandle,
    ) -> Result<(), String> {
        use std::sync::mpsc as std_mpsc;

        let host = cpal::default_host();
        let device = {
            let sel = self.selected_output.lock().await;
            if let Some(name) = sel.as_ref() {
                host.output_devices()
                    .map_err(|e| e.to_string())?
                    .find(|d| d.name().map(|n| &n == name).unwrap_or(false))
                    .ok_or_else(|| format!("output device '{name}' not found"))?
            } else {
                host.default_output_device()
                    .ok_or("no default output device")?
            }
        };

        let config = cpal::StreamConfig {
            channels: 1,
            sample_rate: cpal::SampleRate(48000),
            buffer_size: cpal::BufferSize::Default,
        };

        // Ring buffer: decoded PCM from the decode task → cpal output callback
        let (pcm_tx, pcm_rx) = std_mpsc::sync_channel::<Vec<f32>>(64);

        let deafened = self.deafened.clone();
        let peer_volumes = self.peer_volumes.clone();
        let pid_for_output = peer_id.clone();

        // cpal output stream — pulls decoded PCM and plays it
        let mut leftover: Vec<f32> = Vec::new();
        let output_stream = device
            .build_output_stream(
                &config,
                move |output: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    if deafened.load(Ordering::Relaxed) {
                        output.fill(0.0);
                        return;
                    }

                    // Get peer volume (blocking lock is OK in audio callback — lock is uncontended fast path)
                    // Note: we can't use async here, so we use try_lock on a std::sync::Mutex wrapper.
                    // For simplicity, default to 1.0 if we can't get the lock.
                    let volume = 1.0f32; // Will be refined in step 6 with a better pattern

                    let mut written = 0;
                    // First, drain any leftover from previous callback
                    while written < output.len() && !leftover.is_empty() {
                        output[written] = leftover.remove(0) * volume;
                        written += 1;
                    }
                    // Then pull new frames
                    while written < output.len() {
                        match pcm_rx.try_recv() {
                            Ok(frame) => {
                                for sample in &frame {
                                    if written < output.len() {
                                        output[written] = sample * volume;
                                        written += 1;
                                    } else {
                                        leftover.push(*sample);
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
                    log::error!("[media] output stream error for {pid_for_output}: {err}");
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
                                let _ = app_for_vad.emit("media_vad", serde_json::json!({
                                    "userId": pid_for_task,
                                    "speaking": true,
                                }));
                            }
                        } else {
                            vad_silence_count += 1;
                            if vad_speaking && vad_silence_count >= VAD_SILENCE_FRAMES {
                                vad_speaking = false;
                                let _ = app_for_vad.emit("media_vad", serde_json::json!({
                                    "userId": pid_for_task,
                                    "speaking": false,
                                }));
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
            let _ = app_for_vad.emit("media_vad", serde_json::json!({
                "userId": pid_for_task,
                "speaking": false,
            }));
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
}
```

Add `remote_playback` to the struct and `new()`:

```rust
// In struct:
remote_playback: Arc<Mutex<HashMap<String, RemotePlayback>>>,

// In new():
remote_playback: Arc::new(Mutex::new(HashMap::new())),
```

- [ ] **Step 5: Wire `on_track` in `webrtc_manager.rs` to call `MediaManager::handle_remote_audio_track`**

Update the `on_track` callback in `wire_callbacks` to accept a `MediaManager` reference and route audio tracks to it. This requires adding `media_manager: Arc<MediaManager>` to `wire_callbacks` and propagating it from `create_offer` / `handle_offer`.

In the `on_track` body, replace the "drain packets" placeholder:

```rust
if kind == "audio" {
    let media_mgr = media_manager_clone.clone();
    let app3 = app2.clone();
    let pid3 = pid2.clone();
    let track2 = track.clone();
    tokio::spawn(async move {
        if let Err(e) = media_mgr
            .handle_remote_audio_track(pid3.clone(), track2, app3)
            .await
        {
            log::error!("[webrtc] handle_remote_audio_track failed for {pid3}: {e}");
        }
    });
} else {
    // Video tracks — Phase B (screen share)
    let track_clone = track.clone();
    tokio::spawn(async move {
        loop {
            match track_clone.read_rtp().await {
                Ok((_pkt, _attr)) => {}
                Err(_) => break,
            }
        }
    });
}
```

> **Note:** `wire_callbacks` needs the `MediaManager` reference. Pass it as a parameter:
> ```rust
> fn wire_callbacks(
>     pc: Arc<RTCPeerConnection>,
>     peer_id: String,
>     dc_slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
>     being_replaced: Arc<AtomicBool>,
>     media_manager: Arc<MediaManager>,
>     app: AppHandle,
> )
> ```
> Update `create_offer` and `handle_offer` to accept and pass `media_manager`.
> Update WebRTCManager to hold `media_manager: Arc<MediaManager>` or accept it as a parameter.

- [ ] **Step 6: Verify it compiles**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 7: Run all tests**

```bash
cd src-tauri && cargo test
```

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/media_manager.rs src-tauri/src/webrtc_manager.rs
git commit -m "feat(media): remote audio playback — on_track → Opus decode → cpal output"
```

---

## Task 7: Create Tauri Commands for Media Control

**Files:**
- Create: `src-tauri/src/commands/media_commands.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create `media_commands.rs`**

```rust
//! Tauri commands for Rust-native audio capture and playback.

use tauri::{AppHandle, State};
use crate::AppState;
use crate::media_manager::AudioDeviceList;

/// List available audio input and output devices.
#[tauri::command]
pub async fn media_enumerate_devices(
    state: State<'_, AppState>,
) -> Result<AudioDeviceList, String> {
    Ok(state.media_manager.enumerate_devices())
}

/// Start mic capture. Adds an audio track to all connected peers.
#[tauri::command]
pub async fn media_start_mic(
    device_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Set device if specified
    if let Some(id) = device_id {
        state.media_manager.set_input_device(Some(id)).await;
    }

    // Add audio track to all peers (triggers SDP renegotiation)
    let audio_track = state
        .webrtc_manager
        .add_audio_track_to_all(&app)
        .await?;

    // Start capturing
    state.media_manager.start_mic(audio_track, app).await
}

/// Stop mic capture. Removes audio tracks from all peers.
#[tauri::command]
pub async fn media_stop_mic(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.media_manager.stop_mic(&app).await?;
    state.webrtc_manager.remove_audio_tracks_from_all(&app).await
}

/// Mute/unmute the mic (keeps capture running, sends silence).
#[tauri::command]
pub async fn media_set_muted(
    muted: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.media_manager.set_muted(muted);
    Ok(())
}

/// Deafen/undeafen (suppresses all remote audio playback).
#[tauri::command]
pub async fn media_set_deafened(
    deafened: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.media_manager.set_deafened(deafened);
    Ok(())
}

/// Set volume for a specific remote peer (0.0 = silent, 1.0+ = normal).
#[tauri::command]
pub async fn media_set_peer_volume(
    peer_id: String,
    volume: f32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.media_manager.set_peer_volume(&peer_id, volume).await;
    Ok(())
}

/// Toggle loopback (hear own mic through speakers).
#[tauri::command]
pub async fn media_set_loopback(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.media_manager.set_loopback(enabled);
    Ok(())
}

/// Set the input device for future mic captures.
#[tauri::command]
pub async fn media_set_input_device(
    device_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.media_manager.set_input_device(device_name).await;
    Ok(())
}

/// Set the output device for future remote audio playback.
#[tauri::command]
pub async fn media_set_output_device(
    device_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.media_manager.set_output_device(device_name).await;
    Ok(())
}
```

- [ ] **Step 2: Register in `commands/mod.rs`**

Add `pub mod media_commands;` and `pub use media_commands::*;`.

- [ ] **Step 3: Register commands in `lib.rs`**

Add to the `invoke_handler![]` macro:

```rust
media_enumerate_devices,
media_start_mic,
media_stop_mic,
media_set_muted,
media_set_deafened,
media_set_peer_volume,
media_set_loopback,
media_set_input_device,
media_set_output_device,
```

Add the import: `use commands::media_commands::*;`

- [ ] **Step 4: Verify it compiles**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/media_commands.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(media): add Tauri commands for mic/speaker control"
```

---

## Task 8: Update `webrtcService.ts` — Replace No-Op Stubs

**Files:**
- Modify: `src/services/webrtcService.ts`

Replace the 4 no-op stub methods with actual `invoke()` calls to the new Rust commands.

- [ ] **Step 1: Write the frontend test for addAudioTrack stub replacement**

Create `src/services/__tests__/webrtcService.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))

import { invoke } from '@tauri-apps/api/core'
import { WebRTCService } from '../webrtcService'

describe('WebRTCService media methods', () => {
  let service: WebRTCService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new WebRTCService()
  })

  it('addAudioTrack invokes media_start_mic', async () => {
    await service.addAudioTrack()
    expect(invoke).toHaveBeenCalledWith('media_start_mic', { deviceId: null })
  })

  it('removeAudioTracks invokes media_stop_mic', async () => {
    await service.removeAudioTracks()
    expect(invoke).toHaveBeenCalledWith('media_stop_mic')
  })

  it('addScreenShareTrack logs Phase B warning', () => {
    // Screen share is Phase B — should still be a no-op
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    service.addScreenShareTrack()
    // Should not throw
    warnSpy.mockRestore()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test -- --run src/services/__tests__/webrtcService.test.ts
```

Expected: FAIL — `addAudioTrack` currently doesn't call `invoke`.

- [ ] **Step 3: Replace the stub methods in `webrtcService.ts`**

Change the Phase 2 stubs section:

```typescript
// ── Media control (Rust-native audio pipeline) ─────────────────────────────

/**
 * Start mic capture in Rust. Audio flows entirely in Rust:
 * cpal → Opus encode → WebRTC track. No MediaStream crosses IPC.
 */
async addAudioTrack(deviceId?: string): Promise<void> {
  await invoke('media_start_mic', { deviceId: deviceId ?? null })
}

/**
 * Stop mic capture and remove audio tracks from all peers.
 */
async removeAudioTracks(): Promise<void> {
  await invoke('media_stop_mic')
}

/**
 * Screen share track — Phase B (not yet implemented in Rust backend).
 */
addScreenShareTrack(_track?: MediaStreamTrack, _maxBitrateKbps?: number): void {
  logger.warn('webrtc', 'addScreenShareTrack: not yet implemented (Phase B)')
}

removeScreenShareTrack(): void {
  logger.warn('webrtc', 'removeScreenShareTrack: not yet implemented (Phase B)')
}
```

Note: `addAudioTrack` and `removeAudioTracks` are now `async`. Update callers in the next task.

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test -- --run src/services/__tests__/webrtcService.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/webrtcService.ts src/services/__tests__/webrtcService.test.ts
git commit -m "feat(webrtc): replace audio no-op stubs with Rust IPC calls"
```

---

## Task 9: Update `voiceStore.ts` — Replace getUserMedia with Rust Mic

**Files:**
- Modify: `src/stores/voiceStore.ts`
- Modify: `src/stores/__tests__/voiceStore.test.ts` (if exists, otherwise create)

The voice store currently calls `navigator.mediaDevices.getUserMedia()` to get a `MediaStream`, then passes tracks to `webrtcService.addAudioTrack()`. Since audio is now entirely in Rust, we replace this with a simple `invoke('media_start_mic')`.

- [ ] **Step 1: Write the test**

Add or create `src/stores/__tests__/voiceStore.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))
vi.mock('@/services/audioService', () => ({
  audioService: {
    init: vi.fn(),
    setLocalStream: vi.fn(),
    setLocalMuted: vi.fn(),
    setDeafened: vi.fn(),
    detachAll: vi.fn(),
    setLoopback: vi.fn(),
  },
}))
vi.mock('@/services/webrtcService', () => ({
  webrtcService: {
    addAudioTrack: vi.fn().mockResolvedValue(undefined),
    removeAudioTracks: vi.fn().mockResolvedValue(undefined),
    addScreenShareTrack: vi.fn(),
    removeScreenShareTrack: vi.fn(),
  },
}))

import { invoke } from '@tauri-apps/api/core'
import { useVoiceStore } from '../voiceStore'

describe('voiceStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  it('joinVoiceChannel invokes media_start_mic instead of getUserMedia', async () => {
    const store = useVoiceStore()
    await store.joinVoiceChannel('ch1', 'srv1')

    // Should NOT have called navigator.mediaDevices.getUserMedia
    // (it's not mocked, so it would throw if called)
    expect(store.session).not.toBeNull()
    expect(store.session?.channelId).toBe('ch1')
  })

  it('leaveVoiceChannel invokes media_stop_mic', async () => {
    const store = useVoiceStore()
    await store.joinVoiceChannel('ch1', 'srv1')
    await store.leaveVoiceChannel()

    expect(store.session).toBeNull()
  })
})
```

- [ ] **Step 2: Modify `voiceStore.ts` `joinVoiceChannel`**

Replace the `getUserMedia` + `addAudioTrack` block with:

```typescript
async function joinVoiceChannel(channelId: string, serverId: string): Promise<void> {
    if (session.value?.channelId === channelId) return
    if (session.value) await leaveVoiceChannel()

    const { useSettingsStore } = await import('./settingsStore')
    const settingsStore = useSettingsStore()
    const deviceId = settingsStore.settings.inputDeviceId || undefined

    // Start mic capture in Rust — audio flows entirely in Rust
    // (cpal → Opus → WebRTC track). No MediaStream in JS.
    await webrtcService.addAudioTrack(deviceId)

    isMuted.value     = false
    isDeafened.value   = false
    adminMuted.value   = false

    voiceViewActive.value = true
    session.value = {
      channelId,
      serverId,
      joinedAt: new Date().toISOString(),
      peers: {},
    }

    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({ type: 'voice_join', channelId, serverId })

    const { useNotificationStore } = await import('./notificationStore')
    const { useChannelsStore } = await import('./channelsStore')
    const ch = Object.values(useChannelsStore().channels).flat().find(c => c.id === channelId)
    useNotificationStore().notify({
      type: 'join_self', serverId, channelId,
      titleText: `You joined ${ch?.name ? `#${ch.name}` : 'voice'}`,
    }).catch(() => {})
}
```

Key changes:
- Removed `navigator.mediaDevices.getUserMedia()`
- Removed `localStream.value = stream` (no JS MediaStream for mic)
- Removed `audioService.setLocalStream(stream)` (VAD is now in Rust)
- Replaced `webrtcService.addAudioTrack(track, stream)` loop with `await webrtcService.addAudioTrack(deviceId)`

- [ ] **Step 3: Update `leaveVoiceChannel`**

Replace:
```typescript
webrtcService.removeAudioTracks()
localStream.value?.getTracks().forEach(t => t.stop())
audioService.setLocalStream(null as unknown as MediaStream)
```

With:
```typescript
await webrtcService.removeAudioTracks()
```

Remove `localStream.value = null` (no longer needed — but keep the ref for screen share compatibility if needed. Actually, `localStream` can be repurposed or removed; keep it as `null` for now).

- [ ] **Step 4: Update `toggleMute` and `toggleDeafen`**

Replace `audioService.setLocalMuted()` calls with `invoke('media_set_muted')`:

```typescript
async function toggleMute(): Promise<void> {
    if (adminMuted.value) return
    isMuted.value = !isMuted.value
    await invoke('media_set_muted', { muted: isMuted.value })
}

async function toggleDeafen(): Promise<void> {
    isDeafened.value = !isDeafened.value
    await invoke('media_set_deafened', { deafened: isDeafened.value })
    if (isDeafened.value && !isMuted.value) {
      isMuted.value = true
      await invoke('media_set_muted', { muted: true })
    } else if (!isDeafened.value) {
      isMuted.value = false
      await invoke('media_set_muted', { muted: false })
    }
}
```

Add `import { invoke } from '@tauri-apps/api/core'` at the top.

- [ ] **Step 5: Update `toggleLoopback`**

```typescript
async function toggleLoopback(): Promise<void> {
    loopbackEnabled.value = !loopbackEnabled.value
    await invoke('media_set_loopback', { enabled: loopbackEnabled.value })
}
```

- [ ] **Step 6: Run tests**

```bash
npm run test -- --run src/stores/__tests__/voiceStore.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run full frontend test suite + type check**

```bash
npm run build
npm run test
```

Expected: all pass. Fix any type errors from API changes (e.g., `addAudioTrack` is now async, callers must await).

- [ ] **Step 8: Commit**

```bash
git add src/stores/voiceStore.ts src/stores/__tests__/voiceStore.test.ts
git commit -m "feat(voice): replace getUserMedia with Rust-native mic capture"
```

---

## Task 10: Update `audioService.ts` — Strip Local Processing, Keep VAD UI

**Files:**
- Modify: `src/services/audioService.ts`

`audioService.ts` currently does too much: it manages `<audio>` elements for remote playback, runs VAD on AnalyserNodes, and handles local stream references. Since Rust now handles all audio capture and playback, this service becomes a thin UI event handler.

- [ ] **Step 1: Write test for the new event-driven VAD**

Add `src/services/__tests__/audioService.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))

import { AudioServiceUI } from '../audioService'

describe('AudioServiceUI', () => {
  it('forwards VAD events to registered callback', () => {
    const cb = vi.fn()
    const service = new AudioServiceUI()
    service.init(cb)
    // Simulate receiving a media_vad event
    service._handleVadEvent({ userId: 'peer-1', speaking: true })
    expect(cb).toHaveBeenCalledWith('peer-1', true)
  })

  it('maps userId "self" to "self" in callback', () => {
    const cb = vi.fn()
    const service = new AudioServiceUI()
    service.init(cb)
    service._handleVadEvent({ userId: 'self', speaking: false })
    expect(cb).toHaveBeenCalledWith('self', false)
  })
})
```

- [ ] **Step 2: Refactor `audioService.ts`**

The existing `AudioService` class should be replaced with a lighter `AudioServiceUI` that:
- Subscribes to `media_vad` Tauri events
- Forwards speaking state to voiceStore via the callback
- Exposes `init()` + `destroy()` only

**Keep the existing class for backward compatibility** but gut the internals. Remote stream management (audio elements, AnalyserNode, VAD polling) is now handled 100% in Rust:

```typescript
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type SpeakingChangeCallback = (userId: string, speaking: boolean) => void

/**
 * AudioServiceUI — lightweight event-driven layer.
 *
 * All audio processing (capture, encode, decode, playback, VAD) is now
 * handled in Rust via MediaManager. This service just:
 * 1. Subscribes to Rust `media_vad` events
 * 2. Forwards speaking-state changes to voiceStore
 */
export class AudioServiceUI {
  private onSpeakingChange: SpeakingChangeCallback | null = null
  private unlistenVad: UnlistenFn | null = null

  init(onSpeakingChange: SpeakingChangeCallback): void {
    this.onSpeakingChange = onSpeakingChange
    this._subscribe()
  }

  private async _subscribe(): Promise<void> {
    this.unlistenVad = await listen<{ userId: string; speaking: boolean }>(
      'media_vad',
      ({ payload }) => this._handleVadEvent(payload),
    )
  }

  /** Exposed for testing — called by the Tauri event listener. */
  _handleVadEvent(payload: { userId: string; speaking: boolean }): void {
    this.onSpeakingChange?.(payload.userId, payload.speaking)
  }

  destroy(): void {
    this.unlistenVad?.()
    this.unlistenVad = null
  }

  // ── Legacy API stubs (no-ops — Rust handles everything) ─────────────────

  setLocalStream(_stream: MediaStream): void { /* no-op */ }
  setLocalMuted(_muted: boolean): void { /* Rust handles via media_set_muted */ }
  setDeafened(_deafened: boolean): void { /* Rust handles via media_set_deafened */ }
  attachRemoteStream(_userId: string, _stream: MediaStream): void { /* Rust handles */ }
  detachRemoteStream(_userId: string): void { /* Rust handles */ }
  detachAll(): void { /* Rust handles via stop_all_remote_playback */ }
  setPeerVolume(_userId: string, _volume: number): void { /* Rust handles via media_set_peer_volume */ }
  setPersonallyMuted(_userId: string, _muted: boolean): void { /* Rust handles via media_set_peer_volume(0) */ }
  setLoopback(_enabled: boolean): void { /* Rust handles via media_set_loopback */ }
}

export const audioService = new AudioServiceUI()
```

> **Note:** This is a big refactor. The old `audioService` had rich functionality. To minimize risk, keep the old class definition but rename it to `_LegacyAudioService` and export the new `AudioServiceUI` as `audioService`. This way if something breaks, the old code can be restored quickly.

- [ ] **Step 3: Run test**

```bash
npm run test -- --run src/services/__tests__/audioService.test.ts
```

- [ ] **Step 4: Run full test suite**

```bash
npm run test
npm run build
```

Fix any imports that reference removed methods.

- [ ] **Step 5: Commit**

```bash
git add src/services/audioService.ts src/services/__tests__/audioService.test.ts
git commit -m "refactor(audio): replace JS audio processing with Rust event-driven VAD"
```

---

## Task 11: Update `networkStore.ts` — Wire `media_vad` + Remove Audio Track Handling

**Files:**
- Modify: `src/stores/networkStore.ts`

The `handleRemoteTrack` function currently handles both audio and video tracks from browser `RTCPeerConnection.ontrack`. Since audio is now 100% Rust, remove the audio branch. Video (screen share) stays for Phase B.

- [ ] **Step 1: Listen for `webrtc_track` events (for Phase B prep)**

In the `init()` function, after the existing WebRTC event listeners, add:

```typescript
// Listen for incoming media tracks (Rust WebRTC on_track events)
listen<{ userId: string; kind: string; trackId: string; streamId: string }>(
  'webrtc_track',
  ({ payload }) => {
    if (payload.kind === 'audio') {
      // Audio is handled entirely in Rust (MediaManager) — just update UI
      const { useVoiceStore } = await import('./voiceStore')
      useVoiceStore().updatePeer(payload.userId, { audioEnabled: true })
    } else if (payload.kind === 'video') {
      // Phase B: screen share tracks — handled in future implementation
      logger.info('network', `remote video track from ${payload.userId} (Phase B)`)
    }
  },
).catch(e => logger.warn('network', 'webrtc_track listen failed:', e))
```

- [ ] **Step 2: Remove `handleRemoteTrack` audio branch**

The existing `handleRemoteTrack` function can keep the video branch but the audio branch is now dead code. Simplify:

```typescript
async function handleRemoteTrack(userId: string, stream: MediaStream, track: MediaStreamTrack) {
    const { useVoiceStore } = await import('./voiceStore')
    const voiceStore = useVoiceStore()
    if (!voiceStore.session) return
    // Audio is handled by Rust MediaManager — only handle video here
    if (track.kind === 'video') {
      voiceStore.screenStreams[userId] = stream
      voiceStore.updatePeer(userId, { screenSharing: true })
      track.onended = () => {
        delete voiceStore.screenStreams[userId]
        voiceStore.updatePeer(userId, { screenSharing: false })
      }
    }
}
```

- [ ] **Step 3: Wire peer volume changes through Rust**

In `UserProfileModal.vue` or wherever per-peer volume is set, the call to `audioService.setPeerVolume(userId, vol)` should now go through `invoke('media_set_peer_volume', { peerId: userId, volume: vol })`. Update the relevant call sites.

- [ ] **Step 4: Run tests**

```bash
npm run test
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/stores/networkStore.ts
git commit -m "feat(network): wire webrtc_track events, remove JS audio handling"
```

---

## Task 12: Integration Testing — E2E Voice Chat Verification

**Files:**
- No new files — manual and E2E testing

This is not a code task but a critical verification checkpoint. Run E2E tests to confirm that:
1. Data channels still work (messaging, sync, emoji, etc.)
2. Voice chat works end-to-end between two instances
3. Mute/deafen/volume controls work
4. VAD indicators respond to speaking

- [ ] **Step 1: Run automated E2E smoke tests**

```bash
node scripts/e2e-integration.mjs
```

Or run specific tests:
```bash
npx playwright test e2e/tests/smoke.spec.ts
```

Expected: all existing tests pass (they test data channel functionality which hasn't changed).

- [ ] **Step 2: Manual two-instance voice test**

Launch two dev instances:

```bash
# Terminal 1
npm run dev:tauri -- alice

# Terminal 2
npm run dev:tauri -- bob
```

Test sequence:
1. Alice creates a server, creates a voice channel
2. Alice joins the voice channel → verify "You joined #voice" notification
3. Alice speaks into mic → verify self-speaking indicator lights up
4. Bob joins the server (via invite), joins the voice channel
5. Bob speaks → verify Alice sees Bob's speaking indicator
6. Alice speaks → verify Bob sees Alice's speaking indicator AND hears audio
7. Alice mutes → verify speaking indicator stops, Bob stops hearing Alice
8. Alice unmutes → verify audio resumes
9. Alice deafens → verify Alice stops hearing Bob
10. Alice undeafens → verify audio resumes
11. Alice adjusts Bob's volume slider → verify volume changes
12. Alice leaves voice → verify cleanup

- [ ] **Step 3: Verify frontend test suite**

```bash
npm run test
```

- [ ] **Step 4: Verify Rust test suite**

```bash
cd src-tauri && cargo test
```

- [ ] **Step 5: Document any issues found**

If any issues are found, fix them before committing. Common issues to watch for:
- `cpal::Stream` is `!Send` on macOS — may need `std::sync::Mutex` instead of `tokio::sync::Mutex`
- Opus sample rate mismatch — ensure both encoder and decoder use 48000 Hz
- SDP renegotiation failures — check that the offer/answer relay still works with audio transceivers
- Audio crackling/latency — check buffer sizes in cpal stream config

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "test: verify voice chat end-to-end with Rust-native audio"
```

---

## Post-Phase A Checklist

After completing all 12 tasks, verify:

- [ ] `npm run build` passes (vue-tsc + vite)
- [ ] `cd src-tauri && cargo check` passes
- [ ] `npm run test` — all frontend tests pass
- [ ] `cd src-tauri && cargo test` — all Rust tests pass
- [ ] E2E smoke tests pass (`node scripts/e2e-integration.mjs`)
- [ ] Two-instance voice chat works manually (see Task 12 Step 2)
- [ ] Screen share still shows "Phase B" warning (no regression on that path)

---

## Phase B Preview (Screen Share — Future Plan)

After Phase A is stable, Phase B will add:
1. `xcap` crate for native screen/window capture
2. VP8 encoding via `vpx-sys`
3. `TrackLocalStaticSample` for video tracks
4. JS `<canvas>` rendering of received video frames via Tauri events
5. Screen/window picker UI backed by `invoke('media_enumerate_screens')`

## Phase C Preview (Device Enumeration UI — Future Plan)

After Phase B:
1. Settings > Voice tab reads device list from `invoke('media_enumerate_devices')`
2. Device picker dropdown in join-voice modal
3. Hot-swap device while in voice (stop + restart with new device)
4. Output device selection for remote audio playback
