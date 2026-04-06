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

use std::collections::HashMap;
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
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

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

// ── Per-peer state ──────────────────────────────────────────────────────────

struct PeerEntry {
    pc: Arc<RTCPeerConnection>,
    /// The negotiated data channel; None until `on_open` fires.
    dc: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
}

// ── Manager ─────────────────────────────────────────────────────────────────

pub struct WebRTCManager {
    local_user_id: Arc<std::sync::Mutex<String>>,
    peers: Arc<Mutex<HashMap<String, PeerEntry>>>,
}

impl WebRTCManager {
    pub fn new() -> Self {
        WebRTCManager {
            local_user_id: Arc::new(std::sync::Mutex::new(String::new())),
            peers: Arc::new(Mutex::new(HashMap::new())),
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

    // ── Internal: wire ICE, state, and on_data_channel callbacks ───────────

    fn wire_callbacks(
        pc: Arc<RTCPeerConnection>,
        peer_id: String,
        dc_slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
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
        pc.on_peer_connection_state_change(Box::new(move |s| {
            let app2 = app_state.clone();
            let pid2 = pid_state.clone();
            Box::pin(async move {
                if matches!(
                    s,
                    RTCPeerConnectionState::Failed
                        | RTCPeerConnectionState::Disconnected
                        | RTCPeerConnectionState::Closed
                ) {
                    let _ = app2.emit("webrtc_disconnected", DisconnectedEvent { user_id: pid2 });
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

    /// Caller side: create offer and emit `webrtc_offer` event.
    pub async fn create_offer(&self, peer_id: &str, app: &AppHandle) -> Result<(), String> {
        let pc = Self::build_pc().await?;
        let dc_slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(Mutex::new(None));
        Self::wire_callbacks(pc.clone(), peer_id.to_string(), dc_slot.clone(), app.clone());

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

        self.peers.lock().await.insert(
            peer_id.to_string(),
            PeerEntry {
                pc,
                dc: dc_slot,
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
        app: &AppHandle,
    ) -> Result<(), String> {
        let pc = Self::build_pc().await?;
        let dc_slot: Arc<Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(Mutex::new(None));
        Self::wire_callbacks(pc.clone(), from.to_string(), dc_slot.clone(), app.clone());

        let offer = RTCSessionDescription::offer(sdp).map_err(|e| e.to_string())?;
        pc.set_remote_description(offer)
            .await
            .map_err(|e| e.to_string())?;

        let answer = pc.create_answer(None).await.map_err(|e| e.to_string())?;
        pc.set_local_description(answer.clone())
            .await
            .map_err(|e| e.to_string())?;

        self.peers.lock().await.insert(
            from.to_string(),
            PeerEntry {
                pc,
                dc: dc_slot,
            },
        );

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
        let peers = self.peers.lock().await;
        let entry = peers
            .get(from)
            .ok_or_else(|| format!("no peer entry for {from}"))?;
        let answer = RTCSessionDescription::answer(sdp).map_err(|e| e.to_string())?;
        entry
            .pc
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())
    }

    /// Both sides: add a remote ICE candidate.
    pub async fn add_ice_candidate(
        &self,
        from: &str,
        candidate: RTCIceCandidateInit,
    ) -> Result<(), String> {
        let peers = self.peers.lock().await;
        let entry = peers
            .get(from)
            .ok_or_else(|| format!("no peer entry for {from}"))?;
        entry
            .pc
            .add_ice_candidate(candidate)
            .await
            .map_err(|e| e.to_string())
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
        if let Some(e) = entry {
            e.pc.close().await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Close all peer connections.
    pub async fn destroy_all(&self) -> Result<(), String> {
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
}
