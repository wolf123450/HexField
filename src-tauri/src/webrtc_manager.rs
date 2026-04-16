//! WebRTCManager — owns one RTCPeerConnection per remote peer.
//!
//! Lifecycle:
//!   1. set_local_user_id()    — called once from webrtc_init command
//!   2. create_offer()         — caller side; emits webrtc_offer event
//!   3. handle_offer()         — callee side; emits webrtc_answer event
//!   4. handle_answer()        — caller receives answer
//!   5. add_ice_candidate()    — both sides; called as signal_ice arrives
//!   6. send()                 — send arbitrary UTF-8 over data channel
//!   7. close_peer() / destroy_all()
//!
//! ICE buffering
//! ─────────────
//! ICE trickling races are handled at the manager level with an `ice_queue`
//! HashMap.  Candidates for a peer are buffered there whenever:
//!   a) the peer entry doesn't exist yet (offer not yet processed), OR
//!   b) `remote_desc_ready` is false (set_remote_description still in flight).
//! After set_remote_description completes in both handle_offer and handle_answer,
//! the queue is drained and the candidates are applied to the actual PeerConnection.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::policy::bundle_policy::RTCBundlePolicy;
use webrtc::peer_connection::sdp::sdp_type::RTCSdpType;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::signaling_state::RTCSignalingState;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTPCodecType};
use webrtc::rtp_transceiver::rtp_receiver::RTCRtpReceiver;
use webrtc::rtp_transceiver::RTCRtpTransceiver;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;
use webrtc::track::track_remote::TrackRemote;

// H.264 RTP depacketizer — reassembles FU-A fragments and STAP-A aggregates into
// complete NAL units (Annex-B format) that openh264 can decode.
use rtp::codecs::h264::H264Packet;
use rtp::packetizer::Depacketizer;

use crate::media_manager::MediaManager;

// ── Event payload types ─────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
struct OfferEvent {
    to: String,
    sdp: String,
}

#[derive(Clone, serde::Serialize)]
struct AnswerEvent {
    to: String,
    sdp: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct IceEvent {
    to: String,
    candidate: String,
    sdp_mid: Option<String>,
    sdp_mline_index: Option<u16>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectedEvent {
    user_id: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DisconnectedEvent {
    user_id: String,
}

#[derive(Clone, serde::Serialize)]
struct DataEvent {
    from: String,
    payload: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackEvent {
    user_id: String,
    kind: String,
    track_id: String,
    stream_id: String,
}

// ── Video quality tiers ──────────────────────────────────────────────────────

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

// ── Per-peer state ──────────────────────────────────────────────────────────

struct PeerEntry {
    pc: Arc<RTCPeerConnection>,
    /// The negotiated data channel; None until `on_open` fires.
    dc: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
    /// Becomes true once set_remote_description has completed; guards ICE application.
    remote_desc_ready: Arc<AtomicBool>,
    /// Set to true before replacing this entry so its teardown callbacks don't
    /// emit `webrtc_disconnected` for the *new* connection that took its place.
    being_replaced: Arc<AtomicBool>,
    /// Local audio track attached to this peer (None if mic not active).
    audio_track: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
    /// Local video track attached to this peer (None if screen share not active).
    video_track: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
    /// Which quality tier this peer is currently receiving.
    video_quality_tier: Arc<Mutex<VideoQualityTier>>,
}

// ── Manager ─────────────────────────────────────────────────────────────────

pub struct WebRTCManager {
    local_user_id: Arc<std::sync::Mutex<String>>,
    peers: Arc<Mutex<HashMap<String, PeerEntry>>>,
    /// Manager-level ICE candidate queue.  Candidates are stored here when they
    /// arrive before the peer entry exists or before set_remote_description
    /// completes.  Drained immediately after set_remote_description succeeds.
    ice_queue: Arc<Mutex<HashMap<String, Vec<RTCIceCandidateInit>>>>,
    /// The local audio track being sent to all peers (if mic active).
    local_audio_track: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
    /// The local video track (low quality tier) being sent to all peers (if screen share active).
    local_video_track_low: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
    /// The local video track (high quality tier) for peers that request it.
    local_video_track_high: Arc<Mutex<Option<Arc<TrackLocalStaticSample>>>>,
}

impl WebRTCManager {
    pub fn new() -> Self {
        WebRTCManager {
            local_user_id: Arc::new(std::sync::Mutex::new(String::new())),
            peers: Arc::new(Mutex::new(HashMap::new())),
            ice_queue: Arc::new(Mutex::new(HashMap::new())),
            local_audio_track: Arc::new(Mutex::new(None)),
            local_video_track_low: Arc::new(Mutex::new(None)),
            local_video_track_high: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_local_user_id(&self, id: String) {
        *self.local_user_id.lock().unwrap() = id;
    }

    // ── Internal: build a new RTCPeerConnection ─────────────────────────────

    async fn build_pc() -> Result<Arc<RTCPeerConnection>, String> {
        let mut media_engine = MediaEngine::default();
        media_engine
            .register_default_codecs()
            .map_err(|e| e.to_string())?;

        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut media_engine)
            .map_err(|e| e.to_string())?;

        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build();

        let config = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_owned()],
                ..Default::default()
            }],
            bundle_policy: RTCBundlePolicy::MaxBundle,
            ..Default::default()
        };

        api.new_peer_connection(config)
            .await
            .map(Arc::new)
            .map_err(|e| e.to_string())
    }

    // ── Internal: create and emit an SDP offer if the PC is in Stable state ─

    /// Returns `true` if renegotiation was triggered, `false` if skipped
    /// (because the PC was not in Stable signaling state).
    async fn try_renegotiate(
        &self,
        pc: &Arc<RTCPeerConnection>,
        peer_id: &str,
        app: &AppHandle,
    ) -> Result<bool, String> {
        if pc.signaling_state() != RTCSignalingState::Stable {
            return Ok(false);
        }
        let offer = pc
            .create_offer(None)
            .await
            .map_err(|e| format!("create_offer renegotiate {peer_id}: {e}"))?;
        pc.set_local_description(offer.clone())
            .await
            .map_err(|e| format!("set_local_desc renegotiate {peer_id}: {e}"))?;

        let _ = app.emit(
            "webrtc_offer",
            OfferEvent {
                to: peer_id.to_string(),
                sdp: offer.sdp,
            },
        );
        Ok(true)
    }

    // ── Internal: wire ICE, state, and on_data_channel callbacks ───────────

    fn wire_callbacks(
        pc: Arc<RTCPeerConnection>,
        peer_id: String,
        dc_slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
        being_replaced: Arc<AtomicBool>,
        media_manager: Arc<MediaManager>,
        app: AppHandle,
    ) {
        // ICE candidate → relay through frontend to remote peer
        let app_ice = app.clone();
        let pid_ice = peer_id.clone();
        pc.on_ice_candidate(Box::new(move |c| {
            let app2 = app_ice.clone();
            let pid2 = pid_ice.clone();
            Box::pin(async move {
                if let Some(candidate) = c {
                    if let Ok(init) = candidate.to_json() {
                        let _ = app2.emit(
                            "webrtc_ice",
                            IceEvent {
                                to: pid2,
                                candidate: init.candidate,
                                sdp_mid: init.sdp_mid,
                                sdp_mline_index: init.sdp_mline_index,
                            },
                        );
                    }
                }
            })
        }));

        // Connection state → emit disconnect when terminal state reached
        let app_state = app.clone();
        let pid_state = peer_id.clone();
        let being_replaced_ref = being_replaced.clone();
        pc.on_peer_connection_state_change(Box::new(move |s| {
            let app2 = app_state.clone();
            let pid2 = pid_state.clone();
            let being_replaced2 = being_replaced_ref.clone();
            Box::pin(async move {
                log::debug!("[webrtc] peer state {s:?} for {pid2}");
                if matches!(
                    s,
                    RTCPeerConnectionState::Failed
                        | RTCPeerConnectionState::Closed
                ) {
                    // Skip emitting disconnect if this entry has been superseded by a
                    // newer connection — otherwise the new peer entry gets destroyed.
                    if !being_replaced2.load(Ordering::Acquire) {
                        let _ = app2.emit("webrtc_disconnected", DisconnectedEvent { user_id: pid2 });
                    }
                }
            })
        }));

        // Callee side: remote peer opened a data channel for us
        let app_dc = app.clone();
        let pid_dc = peer_id.clone();
        let dc_slot2 = dc_slot.clone();
        pc.on_data_channel(Box::new(move |d| {
            let app2 = app_dc.clone();
            let pid2 = pid_dc.clone();
            let slot = dc_slot2.clone();
            Box::pin(async move {
                Self::wire_data_channel(d, pid2, slot, app2);
            })
        }));

        // Incoming remote media track → route audio to MediaManager, log video
        let app_track = app.clone();
        let pid_track = peer_id.clone();
        let media_mgr = media_manager.clone();
        pc.on_track(Box::new(
            move |track: Arc<TrackRemote>,
                  _receiver: Arc<RTCRtpReceiver>,
                  _transceiver: Arc<RTCRtpTransceiver>| {
                let app2 = app_track.clone();
                let pid2 = pid_track.clone();
                let media_mgr2 = media_mgr.clone();
                let kind = if track.kind() == RTPCodecType::Audio {
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

                if kind == "audio" {
                    let app3 = app2.clone();
                    let pid3 = pid2.clone();
                    let track2 = track.clone();
                    tokio::spawn(async move {
                        if let Err(e) = media_mgr2
                            .handle_remote_audio_track(pid3.clone(), track2, app3)
                            .await
                        {
                            log::error!("[webrtc] handle_remote_audio_track failed for {pid3}: {e}");
                        }
                    });
                } else {
                    // Video tracks — depacketize RTP → decode H.264 → JPEG → emit frame events
                    let track_clone = track.clone();
                    let pid3 = pid2.clone();
                    let app3 = app2.clone();
                    tokio::spawn(async move {
                        let frame_dir = match MediaManager::frame_output_dir(&app3) {
                            Ok(d) => d,
                            Err(e) => {
                                log::error!("[webrtc] failed to get frame dir: {e}");
                                return;
                            }
                        };
                        let frame_path = frame_dir.join(format!("{pid3}.jpg"));
                        let mut decoder = match openh264::decoder::Decoder::new() {
                            Ok(d) => d,
                            Err(e) => {
                                log::error!("[webrtc] H.264 decoder init failed: {e}");
                                return;
                            }
                        };

                        // Depacketizer reassembles FU-A fragments and STAP-A aggregates
                        // into complete Annex-B NAL units for the openh264 decoder.
                        let mut h264_depacketizer = H264Packet::default();
                        let mut frame_number: u64 = 0;

                        loop {
                            match track_clone.read_rtp().await {
                                Ok((pkt, _attr)) => {
                                    // Depacketize RTP payload into H.264 NAL unit(s)
                                    let nal_data = match h264_depacketizer
                                        .depacketize(&pkt.payload)
                                    {
                                        Ok(data) => data,
                                        Err(e) => {
                                            log::debug!(
                                                "[webrtc] H.264 depacketize error for {pid3}: {e}"
                                            );
                                            continue;
                                        }
                                    };

                                    // Empty means FU-A fragment still accumulating
                                    if nal_data.is_empty() {
                                        continue;
                                    }

                                    match MediaManager::decode_and_write_jpeg(
                                        &mut decoder,
                                        &nal_data,
                                        &frame_path,
                                    ) {
                                        Ok(true) => {
                                            frame_number += 1;
                                            let _ = app3.emit(
                                                "media_video_frame",
                                                serde_json::json!({
                                                    "userId": pid3,
                                                    "frameNumber": frame_number,
                                                    "path": frame_path.to_string_lossy(),
                                                }),
                                            );
                                        }
                                        Ok(false) => {
                                            // Decoder needs more data
                                        }
                                        Err(e) => {
                                            log::debug!("[webrtc] H.264 decode (transient): {e}");
                                        }
                                    }
                                }
                                Err(e) => {
                                    log::debug!("[webrtc] video track read ended for {pid3}: {e}");
                                    break;
                                }
                            }
                        }

                        // Clean up frame file
                        let _ = std::fs::remove_file(&frame_path);
                        let _ = app3.emit(
                            "media_video_frame_ended",
                            serde_json::json!({ "userId": pid3 }),
                        );
                    });
                }

                Box::pin(async {})
            },
        ));
    }

    // ── Internal: wire on_open + on_message on a data channel ─────────────

    fn wire_data_channel(
        dc: Arc<RTCDataChannel>,
        peer_id: String,
        slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
        app: AppHandle,
    ) {
        let slot_open = slot.clone();
        let dc_open = dc.clone();
        let pid_open = peer_id.clone();
        let app_open = app.clone();

        dc.on_open(Box::new(move || {
            let slot2 = slot_open.clone();
            let dc2 = dc_open.clone();
            let pid2 = pid_open.clone();
            let app2 = app_open.clone();
            Box::pin(async move {
                *slot2.lock().await = Some(dc2);
                log::debug!("[webrtc] DC opened for {pid2}");
                let _ = app2.emit("webrtc_connected", ConnectedEvent { user_id: pid2 });
            })
        }));

        let pid_msg = peer_id.clone();
        let app_msg = app.clone();
        dc.on_message(Box::new(move |msg: DataChannelMessage| {
            let pid2 = pid_msg.clone();
            let app2 = app_msg.clone();
            Box::pin(async move {
                if let Ok(text) = String::from_utf8(msg.data.to_vec()) {
                    let _ = app2.emit("webrtc_data", DataEvent { from: pid2, payload: text });
                }
            })
        }));
    }

    // ── Public API ──────────────────────────────────────────────────────────

    // ── Internal: drain ICE queue into a peer connection ──────────────────────

    async fn drain_ice_queue(&self, peer_id: &str, pc: &Arc<RTCPeerConnection>) {
        let queued = self
            .ice_queue
            .lock()
            .await
            .remove(peer_id)
            .unwrap_or_default();
        for candidate in queued {
            if let Err(e) = pc.add_ice_candidate(candidate).await {
                log::warn!("[webrtc] ICE drain error for {peer_id}: {e}");
            }
        }
    }

    /// Caller side: create offer and emit `webrtc_offer` event.
    pub async fn create_offer(
        &self,
        peer_id: &str,
        media_manager: &Arc<MediaManager>,
        app: &AppHandle,
    ) -> Result<(), String> {
        log::debug!("[webrtc] create_offer → {peer_id}");
        let pc = Self::build_pc().await?;
        let dc_slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(Mutex::new(None));
        let remote_desc_ready = Arc::new(AtomicBool::new(false));
        let being_replaced = Arc::new(AtomicBool::new(false));

        // Mark any existing entry as being_replaced and close its PC so that:
        //   a) its on_peer_connection_state_change(Closed) doesn't emit webrtc_disconnected
        //   b) its data channel never opens and never fires a spurious webrtc_connected
        //      (which would cause waitForPeer to resolve while sendToPeer still uses this
        //       new PC whose DC slot is still None, silently dropping the first message).
        let old_pc_to_close: Option<(Arc<RTCPeerConnection>, Arc<Mutex<Option<Arc<RTCDataChannel>>>>)> = {
            let peers = self.peers.lock().await;
            peers.get(peer_id).map(|old| {
                old.being_replaced.store(true, Ordering::Release);
                (old.pc.clone(), old.dc.clone())
            })
        };
        if let Some((old_pc, old_dc_slot)) = old_pc_to_close {
            // Clear the old DC slot to prevent its on_open from firing webrtc_connected
            tokio::spawn(async move {
                *old_dc_slot.lock().await = None;
                let _ = old_pc.close().await;
            });
        }

        Self::wire_callbacks(pc.clone(), peer_id.to_string(), dc_slot.clone(), being_replaced.clone(), media_manager.clone(), app.clone());

        // Caller creates the data channel; callee receives it via on_data_channel
        let dc = pc
            .create_data_channel("hexfield", None)
            .await
            .map_err(|e| e.to_string())?;
        Self::wire_data_channel(dc, peer_id.to_string(), dc_slot.clone(), app.clone());

        let offer = pc.create_offer(None).await.map_err(|e| e.to_string())?;
        pc.set_local_description(offer.clone())
            .await
            .map_err(|e| e.to_string())?;

        // remote_desc_ready stays false until handle_answer sets the remote description.
        self.peers.lock().await.insert(
            peer_id.to_string(),
            PeerEntry {
                pc,
                dc: dc_slot,
                remote_desc_ready,
                being_replaced,
                audio_track: Arc::new(Mutex::new(None)),
                video_track: Arc::new(Mutex::new(None)),
                video_quality_tier: Arc::new(Mutex::new(VideoQualityTier::default())),
            },
        );

        app.emit(
            "webrtc_offer",
            OfferEvent {
                to: peer_id.to_string(),
                sdp: offer.sdp,
            },
        )
        .map_err(|e| e.to_string())
    }

    /// Callee side: consume an offer, emit `webrtc_answer` event.
    pub async fn handle_offer(
        &self,
        from: &str,
        sdp: String,
        media_manager: &Arc<MediaManager>,
        app: &AppHandle,
    ) -> Result<(), String> {
        log::debug!("[webrtc] handle_offer from {from}");

        // Check if this is a renegotiation (existing peer with a Connected PC).
        // Renegotiation offers (e.g. adding audio/video tracks) must be applied to the
        // EXISTING PeerConnection to preserve the data channel. Creating a new PC would
        // destroy the data channel and break the connection.
        let existing = {
            let peers = self.peers.lock().await;
            peers.get(from).map(|entry| {
                (
                    entry.pc.clone(),
                    entry.remote_desc_ready.clone(),
                    entry.pc.connection_state(),
                )
            })
        };

        if let Some((pc, remote_desc_ready, state)) = existing {
            if state == RTCPeerConnectionState::Connected {
                log::debug!("[webrtc] renegotiation offer from {from} — reusing existing PC");

                // Handle "glare" — both sides sent offers simultaneously.
                // Use polite-peer pattern: lower user ID yields (rolls back).
                let sig_state = pc.signaling_state();
                if sig_state == RTCSignalingState::HaveLocalOffer {
                    let local_id = self.local_user_id.lock().unwrap().clone();
                    if local_id < from.to_string() {
                        // We're the polite peer — roll back our offer and accept theirs
                        log::info!("[webrtc] glare with {from}: we are polite, rolling back");
                        let mut rollback: RTCSessionDescription = Default::default();
                        rollback.sdp_type = RTCSdpType::Rollback;
                        pc.set_local_description(rollback)
                            .await
                            .map_err(|e| format!("rollback local desc for {from}: {e}"))?;
                    } else {
                        // We're the impolite peer — ignore their offer
                        log::info!("[webrtc] glare with {from}: we are impolite, ignoring offer");
                        return Ok(());
                    }
                } else if sig_state != RTCSignalingState::Stable {
                    // PC is in some other non-stable state (e.g. HaveRemoteOffer from
                    // a previous offer still being processed). Skip this offer.
                    log::warn!("[webrtc] renegotiation from {from} skipped — signaling state {sig_state:?}");
                    return Ok(());
                }

                let offer = RTCSessionDescription::offer(sdp).map_err(|e| e.to_string())?;
                pc.set_remote_description(offer)
                    .await
                    .map_err(|e| e.to_string())?;

                remote_desc_ready.store(true, Ordering::Release);
                self.drain_ice_queue(from, &pc).await;

                let answer = pc.create_answer(None).await.map_err(|e| e.to_string())?;
                pc.set_local_description(answer.clone())
                    .await
                    .map_err(|e| e.to_string())?;

                app.emit(
                    "webrtc_answer",
                    AnswerEvent {
                        to: from.to_string(),
                        sdp: answer.sdp,
                    },
                )
                .map_err(|e| e.to_string())?;

                return Ok(());
            }
            // PC exists but is not Connected (Failed/Closed/Connecting) — treat as
            // a fresh connection attempt and replace the old PC below.
            log::debug!("[webrtc] replacing non-Connected PC ({state:?}) for {from}");
        }

        // Initial offer (or replacing a dead PC) — create a new PeerConnection
        let pc = Self::build_pc().await?;
        let dc_slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(Mutex::new(None));
        let remote_desc_ready = Arc::new(AtomicBool::new(false));
        let being_replaced = Arc::new(AtomicBool::new(false));

        // Mark any existing entry as being_replaced and close its PC (prevents stale
        // webrtc_connected / webrtc_disconnected events from the old PC).
        let old_pc_to_close: Option<(Arc<RTCPeerConnection>, Arc<Mutex<Option<Arc<RTCDataChannel>>>>)> = {
            let peers = self.peers.lock().await;
            peers.get(from).map(|old| {
                old.being_replaced.store(true, Ordering::Release);
                (old.pc.clone(), old.dc.clone())
            })
        };
        if let Some((old_pc, old_dc_slot)) = old_pc_to_close {
            tokio::spawn(async move {
                *old_dc_slot.lock().await = None;
                let _ = old_pc.close().await;
            });
        }

        Self::wire_callbacks(pc.clone(), from.to_string(), dc_slot.clone(), being_replaced.clone(), media_manager.clone(), app.clone());

        // Insert the peer entry early so add_ice_candidate buffers rather than
        // errors with "no peer entry".  remote_desc_ready stays false until
        // set_remote_description completes, so candidates go to ice_queue.
        self.peers.lock().await.insert(
            from.to_string(),
            PeerEntry {
                pc: pc.clone(),
                dc: dc_slot,
                remote_desc_ready: remote_desc_ready.clone(),
                being_replaced,
                audio_track: Arc::new(Mutex::new(None)),
                video_track: Arc::new(Mutex::new(None)),
                video_quality_tier: Arc::new(Mutex::new(VideoQualityTier::default())),
            },
        );

        let offer = RTCSessionDescription::offer(sdp).map_err(|e| e.to_string())?;
        pc.set_remote_description(offer)
            .await
            .map_err(|e| e.to_string())?;

        // Remote description is set — flip the flag and drain any buffered candidates.
        remote_desc_ready.store(true, Ordering::Release);
        self.drain_ice_queue(from, &pc).await;

        let answer = pc.create_answer(None).await.map_err(|e| e.to_string())?;
        pc.set_local_description(answer.clone())
            .await
            .map_err(|e| e.to_string())?;

        app.emit(
            "webrtc_answer",
            AnswerEvent {
                to: from.to_string(),
                sdp: answer.sdp,
            },
        )
        .map_err(|e| e.to_string())
    }

    /// Caller side: receive answer from callee.
    pub async fn handle_answer(&self, from: &str, sdp: String) -> Result<(), String> {
        let (pc, remote_desc_ready) = {
            let peers = self.peers.lock().await;
            let entry = peers
                .get(from)
                .ok_or_else(|| format!("no peer entry for {from}"))?;
            (entry.pc.clone(), entry.remote_desc_ready.clone())
        };
        let answer = RTCSessionDescription::answer(sdp).map_err(|e| e.to_string())?;
        pc.set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())?;

        // Remote description is set — flip the flag and drain any buffered candidates.
        remote_desc_ready.store(true, Ordering::Release);
        self.drain_ice_queue(from, &pc).await;
        Ok(())
    }

    /// Both sides: add a remote ICE candidate.
    /// If the peer entry doesn't exist yet, or set_remote_description hasn't
    /// completed, the candidate is buffered in ice_queue and applied once ready.
    pub async fn add_ice_candidate(
        &self,
        from: &str,
        candidate: RTCIceCandidateInit,
    ) -> Result<(), String> {
        // Snapshot the pc if the entry exists AND remote desc is ready.
        let maybe_pc = {
            let peers = self.peers.lock().await;
            peers
                .get(from)
                .filter(|e| e.remote_desc_ready.load(Ordering::Acquire))
                .map(|e| e.pc.clone())
        };

        if let Some(pc) = maybe_pc {
            pc.add_ice_candidate(candidate)
                .await
                .map_err(|e| e.to_string())
        } else {
            // Buffer — either no peer entry yet, or remote desc still in flight.
            self.ice_queue
                .lock()
                .await
                .entry(from.to_string())
                .or_default()
                .push(candidate);
            Ok(())
        }
    }

    /// Send a UTF-8 string to a connected peer's data channel.
    /// Returns false if the peer has no open data channel yet.
    pub async fn send(&self, peer_id: &str, data: String) -> Result<bool, String> {
        let peers = self.peers.lock().await;
        let entry = match peers.get(peer_id) {
            Some(e) => e,
            None => return Ok(false),
        };
        let dc_guard = entry.dc.lock().await;
        let dc = match dc_guard.as_ref() {
            Some(d) => d.clone(),
            None => return Ok(false),
        };
        drop(dc_guard);
        drop(peers);
        dc.send_text(data).await.map(|_| true).map_err(|e| e.to_string())
    }

    /// Close a single peer connection and remove it from the map.
    pub async fn close_peer(&self, peer_id: &str) -> Result<(), String> {
        let entry = self.peers.lock().await.remove(peer_id);
        self.ice_queue.lock().await.remove(peer_id);
        if let Some(e) = entry {
            e.pc.close().await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Close all peer connections.
    pub async fn destroy_all(&self) -> Result<(), String> {
        self.ice_queue.lock().await.clear();
        let mut peers = self.peers.lock().await;
        let mut errors: Vec<String> = vec![];
        for (_, entry) in peers.drain() {
            if let Err(e) = entry.pc.close().await {
                errors.push(e.to_string());
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    /// Returns user IDs of peers whose data channel is open.
    pub async fn get_connected_peers(&self) -> Vec<String> {
        let peers = self.peers.lock().await;
        let mut out = vec![];
        for (id, entry) in peers.iter() {
            if entry.dc.lock().await.is_some() {
                out.push(id.clone());
            }
        }
        out
    }

    /// Add a local audio track to every connected peer and trigger SDP renegotiation.
    /// Returns the shared TrackLocalStaticSample for the mic encoder to write into.
    pub async fn add_audio_track_to_all(
        &self,
        app: &AppHandle,
    ) -> Result<Arc<TrackLocalStaticSample>, String> {
        // Use a unique track ID each session so add_track() creates a fresh
        // transceiver instead of trying to reuse a stopped sender from a
        // previous voice session (which fails with "envelope" mismatch).
        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: "audio/opus".to_owned(),
                clock_rate: 48000,
                channels: 1,
                ..Default::default()
            },
            format!("hexfield-audio-{}", uuid::Uuid::new_v4()),
            "hexfield-stream".to_owned(),
        ));

        let peers = self.peers.lock().await;
        for (peer_id, entry) in peers.iter() {
            // Add the track to this peer connection
            let track_local: Arc<dyn TrackLocal + Send + Sync> = track.clone();
            entry
                .pc
                .add_track(track_local)
                .await
                .map_err(|e| format!("add_track to {peer_id}: {e}"))?;

            // Store a clone in the entry
            *entry.audio_track.lock().await = Some(track.clone());

            // Trigger renegotiation — create a new offer and emit it.
            // Skip if PC is not in Stable signaling state (avoids race with
            // a concurrent renegotiation from the remote side).
            if !self.try_renegotiate(&entry.pc, peer_id, app).await? {
                log::warn!("[webrtc] add_audio: skipped renegotiation for {peer_id} — not stable");
            }
        }

        // Store track at manager level for late-joining peers
        *self.local_audio_track.lock().await = Some(track.clone());

        Ok(track)
    }

    /// Remove audio tracks from all peers and trigger SDP renegotiation.
    pub async fn remove_audio_tracks_from_all(&self, app: &AppHandle) -> Result<(), String> {
        // Clear manager-level track first
        *self.local_audio_track.lock().await = None;

        let peers = self.peers.lock().await;
        for (peer_id, entry) in peers.iter() {
            // Clear the stored track
            *entry.audio_track.lock().await = None;

            // Find and remove any audio senders
            let senders = entry.pc.get_senders().await;
            for sender in senders {
                if let Some(track) = sender.track().await {
                    if track.kind() == RTPCodecType::Audio {
                        entry
                            .pc
                            .remove_track(&sender)
                            .await
                            .map_err(|e| format!("remove_track from {peer_id}: {e}"))?;
                    }
                }
            }

            // Trigger renegotiation (skip if not in stable state)
            if !self.try_renegotiate(&entry.pc, peer_id, app).await? {
                log::warn!("[webrtc] remove_audio: skipped renegotiation for {peer_id} — not stable");
            }
        }

        Ok(())
    }

    /// Ensure existing media tracks are added to a specific peer's connection.
    /// Called when a new peer connects while the local user is already in a voice
    /// channel or sharing their screen, so they receive the existing audio/video.
    pub async fn ensure_tracks_for_peer(
        &self,
        peer_id: &str,
        app: &AppHandle,
        media_manager: &Arc<MediaManager>,
    ) -> Result<(), String> {
        // Use the manager-level local tracks (set by add_audio/video_track_to_all)
        // rather than iterating other peers — the sender may be alone with no
        // other peers to copy from.
        let local_audio = self.local_audio_track.lock().await.clone();
        let local_video = self.local_video_track_low.lock().await.clone();

        let peers = self.peers.lock().await;
        let entry = match peers.get(peer_id) {
            Some(e) => e,
            None => return Ok(()),
        };

        let mut needs_reneg = false;

        // Add local audio track to the new peer if not already present
        if let Some(track) = local_audio {
            let this_audio = entry.audio_track.lock().await;
            if this_audio.is_none() {
                drop(this_audio);
                let track_local: Arc<dyn TrackLocal + Send + Sync> = track.clone();
                entry.pc.add_track(track_local).await
                    .map_err(|e| format!("add_track audio to {peer_id}: {e}"))?;
                *entry.audio_track.lock().await = Some(track);
                needs_reneg = true;
            }
        }

        // Add local video track to the new peer if not already present
        if let Some(track) = local_video {
            let this_video = entry.video_track.lock().await;
            if this_video.is_none() {
                drop(this_video);
                let track_local: Arc<dyn TrackLocal + Send + Sync> = track.clone();
                entry.pc.add_track(track_local).await
                    .map_err(|e| format!("add_track video to {peer_id}: {e}"))?;
                *entry.video_track.lock().await = Some(track);
                needs_reneg = true;
                // Force an IDR keyframe so the new peer can decode immediately
                media_manager.request_keyframe();
            }
        }

        if needs_reneg {
            if !self.try_renegotiate(&entry.pc, peer_id, app).await? {
                log::warn!("[webrtc] ensure_tracks: skipped renegotiation for {peer_id} — not stable");
            }
        }

        Ok(())
    }

    /// Add a local H.264 video track to every connected peer and trigger SDP renegotiation.
    /// Returns the shared TrackLocalStaticSample for the capture pipeline to write into.
    pub async fn add_video_track_to_all(
        &self,
        app: &AppHandle,
    ) -> Result<Arc<TrackLocalStaticSample>, String> {
        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: "video/H264".to_owned(),
                clock_rate: 90000,
                ..Default::default()
            },
            format!("hexfield-video-{}", uuid::Uuid::new_v4()),
            "hexfield-screen".to_owned(),
        ));

        let peers = self.peers.lock().await;
        for (peer_id, entry) in peers.iter() {
            let track_local: Arc<dyn TrackLocal + Send + Sync> = track.clone();
            entry
                .pc
                .add_track(track_local)
                .await
                .map_err(|e| format!("add_video_track to {peer_id}: {e}"))?;

            *entry.video_track.lock().await = Some(track.clone());

            // Trigger renegotiation (skip if not in stable state)
            if !self.try_renegotiate(&entry.pc, peer_id, app).await? {
                log::warn!("[webrtc] add_video: skipped renegotiation for {peer_id} — not stable");
            }
        }

        // Store track at manager level for late-joining peers
        *self.local_video_track_low.lock().await = Some(track.clone());

        Ok(track)
    }

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
            return Ok(());
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

    /// Remove video tracks from all peers and trigger SDP renegotiation.
    pub async fn remove_video_tracks_from_all(&self, app: &AppHandle) -> Result<(), String> {
        // Clear manager-level tracks first
        *self.local_video_track_low.lock().await = None;
        *self.local_video_track_high.lock().await = None;

        let peers = self.peers.lock().await;
        for (peer_id, entry) in peers.iter() {
            *entry.video_track.lock().await = None;

            let senders = entry.pc.get_senders().await;
            for sender in senders {
                if let Some(track) = sender.track().await {
                    if track.kind() == RTPCodecType::Video {
                        entry
                            .pc
                            .remove_track(&sender)
                            .await
                            .map_err(|e| format!("remove_video_track from {peer_id}: {e}"))?;
                    }
                }
            }

            // Trigger renegotiation (skip if not in stable state)
            if !self.try_renegotiate(&entry.pc, peer_id, app).await? {
                log::warn!("[webrtc] remove_video: skipped renegotiation for {peer_id} — not stable");
            }
        }

        Ok(())
    }
}
