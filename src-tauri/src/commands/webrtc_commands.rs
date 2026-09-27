//! Tauri commands for Rust-native WebRTC data-channel management.

use tauri::{AppHandle, State};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;

use crate::AppState;

/// Register the local user ID with the WebRTC manager.
/// Must be called once before any peer operations (at network init time).
#[tauri::command]
pub async fn webrtc_init(
    local_user_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.set_local_user_id(local_user_id);
    Ok(())
}

/// One ICE server entry as sent by the frontend (`buildICEServers()`).
#[derive(serde::Deserialize, Debug, Clone)]
pub struct IceServerInput {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential: String,
}

const MAX_ICE_SERVERS: usize = 16;
const MAX_URLS_PER_SERVER: usize = 4;

/// Validate frontend ICE servers. Drops what webrtc-rs 0.17 cannot use
/// (`turns:` and TCP TURN; its TURN client is UDP-only) and TURN entries
/// without credentials. Falls back to the defaults when nothing usable remains.
fn sanitize_ice_servers(input: Vec<IceServerInput>) -> Vec<RTCIceServer> {
    let mut out = Vec::new();
    for server in input.into_iter().take(MAX_ICE_SERVERS) {
        let has_creds = !server.username.is_empty() && !server.credential.is_empty();
        let urls: Vec<String> = server
            .urls
            .into_iter()
            .take(MAX_URLS_PER_SERVER)
            .filter(|url| {
                let usable = if url.starts_with("stun:") {
                    true
                } else if url.starts_with("turn:") {
                    has_creds && !url.contains("transport=tcp")
                } else {
                    false
                };
                if !usable {
                    log::warn!("[webrtc] ignoring unsupported ICE server URL: {url}");
                }
                usable
            })
            .collect();
        if !urls.is_empty() {
            out.push(RTCIceServer {
                urls,
                username: server.username,
                credential: server.credential,
            });
        }
    }
    if out.is_empty() {
        crate::webrtc_manager::default_ice_servers()
    } else {
        out
    }
}

/// Set the ICE servers (STUN/TURN) used for peer connections created from now on.
/// Returns the number of server entries applied.
#[tauri::command]
pub async fn webrtc_set_ice_servers(
    servers: Vec<IceServerInput>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let servers = sanitize_ice_servers(servers);
    let count = servers.len();
    state.webrtc_manager.set_ice_servers(servers);
    Ok(count)
}

/// Initiate a connection to `peer_id`. Emits `webrtc_offer` event when ready.
#[tauri::command]
pub async fn webrtc_create_offer(
    peer_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.create_offer(&peer_id, &state.media_manager, &crate::event_sink::from_app(&app)).await
}

/// Accept an incoming offer from `from`. Emits `webrtc_answer` event.
#[tauri::command]
pub async fn webrtc_handle_offer(
    from: String,
    sdp: String,
    relay_only: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .webrtc_manager
        .handle_offer(&from, sdp, relay_only.unwrap_or(false), &state.media_manager, &crate::event_sink::from_app(&app))
        .await
}

/// Process an answer received from `from` (must have an existing peer entry).
#[tauri::command]
pub async fn webrtc_handle_answer(
    from: String,
    sdp: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.handle_answer(&from, sdp).await
}

/// Add a remote ICE candidate for peer `from`.
#[tauri::command]
pub async fn webrtc_add_ice(
    from: String,
    candidate: String,
    sdp_mid: Option<String>,
    sdp_mline_index: Option<u16>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .webrtc_manager
        .add_ice_candidate(
            &from,
            RTCIceCandidateInit {
                candidate,
                sdp_mid,
                sdp_mline_index,
                username_fragment: None,
            },
        )
        .await
}

/// Send UTF-8 `data` to `peer_id` over the data channel.
/// Returns false if the peer has no open data channel yet.
#[tauri::command]
pub async fn webrtc_send(
    peer_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state.webrtc_manager.send(&peer_id, data).await
}

/// Ensure existing audio/video tracks are added to a specific peer.
/// Call when a new peer connects while already in a voice channel.
#[tauri::command]
pub async fn webrtc_ensure_tracks(
    peer_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.ensure_tracks_for_peer(&peer_id, &crate::event_sink::from_app(&app), &state.media_manager).await
}

/// Close and remove the peer connection for `peer_id`.
#[tauri::command]
pub async fn webrtc_close_peer(
    peer_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.close_peer(&peer_id).await
}

/// Close all open peer connections.
#[tauri::command]
pub async fn webrtc_destroy_all(state: State<'_, AppState>) -> Result<(), String> {
    state.webrtc_manager.destroy_all().await
}

/// Returns a list of peer IDs whose data channel is currently open.
#[tauri::command]
pub async fn webrtc_get_connected_peers(
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    Ok(state.webrtc_manager.get_connected_peers().await)
}

// ── Manual code exchange (plan step 1b, "Direct connect") ──────────────────
//
// Non-trickle variants for serverless, out-of-band signaling: the caller gets
// a single self-contained SDP string (all ICE candidates already gathered)
// instead of the offer/answer/ICE events the rest of this file emits. The
// frontend wraps the SDP in a signed, expiring code (`directConnectService.ts`)
// before it's pasted or scanned; these commands only see the raw SDP.

/// Offerer side: create an offer and wait for ICE gathering to complete.
/// `session_id` is a frontend-chosen id used to reclaim this pending PC in
/// `webrtc_apply_answer_code` once the answer code names the real peer.
#[tauri::command]
pub async fn webrtc_create_offer_code(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.webrtc_manager.create_offer_code(&session_id).await
}

/// Answerer side: consume a pasted offer's SDP (from `from`, already decoded
/// and verified by the frontend) and return a complete answer SDP.
#[tauri::command]
pub async fn webrtc_accept_offer_code(
    from: String,
    sdp: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state
        .webrtc_manager
        .accept_offer_code(&from, sdp, &state.media_manager, &crate::event_sink::from_app(&app))
        .await
}

/// Offerer side: apply the pasted-back answer SDP (from `from`, decoded and
/// verified by the frontend) to the pending offer created for `session_id`.
#[tauri::command]
pub async fn webrtc_apply_answer_code(
    session_id: String,
    from: String,
    sdp: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .webrtc_manager
        .apply_answer_code(&session_id, &from, sdp, &state.media_manager, &crate::event_sink::from_app(&app))
        .await
}

/// Discard a pending offer session (modal closed, or the code expired before
/// a reply arrived). No-op if the session id is unknown.
#[tauri::command]
pub async fn webrtc_cancel_offer_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.cancel_offer_session(&session_id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(urls: &[&str], username: &str, credential: &str) -> IceServerInput {
        IceServerInput {
            urls: urls.iter().map(|u| u.to_string()).collect(),
            username: username.into(),
            credential: credential.into(),
        }
    }

    #[test]
    fn keeps_stun_and_udp_turn_with_credentials() {
        let out = sanitize_ice_servers(vec![
            server(&["stun:stun.example.org:3478"], "", ""),
            server(&["turn:turn.example.org:3478?transport=udp"], "u", "p"),
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].username, "u");
    }

    #[test]
    fn drops_turns_tcp_and_credentialless_turn() {
        let out = sanitize_ice_servers(vec![
            server(&["turns:turn.example.org:443", "turn:turn.example.org:3478?transport=tcp"], "u", "p"),
            server(&["turn:turn.example.org:3478"], "", ""),
            server(&["stun:stun.example.org:3478", "https://evil.example"], "", ""),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].urls, vec!["stun:stun.example.org:3478".to_string()]);
    }

    #[test]
    fn falls_back_to_defaults_when_nothing_usable() {
        let out = sanitize_ice_servers(vec![server(&["turns:x:443"], "u", "p")]);
        assert_eq!(out, crate::webrtc_manager::default_ice_servers());
        assert_eq!(sanitize_ice_servers(vec![]), crate::webrtc_manager::default_ice_servers());
    }

    #[test]
    fn caps_server_and_url_counts() {
        let many: Vec<IceServerInput> = (0..40)
            .map(|i| server(&[&format!("stun:s{i}:3478"), "stun:a:1", "stun:b:1", "stun:c:1", "stun:d:1"], "", ""))
            .collect();
        let out = sanitize_ice_servers(many);
        assert_eq!(out.len(), MAX_ICE_SERVERS);
        assert!(out.iter().all(|s| s.urls.len() == MAX_URLS_PER_SERVER));
    }
}
