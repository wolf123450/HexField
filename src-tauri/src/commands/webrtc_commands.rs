//! Tauri commands for Rust-native WebRTC data-channel management.

use tauri::{AppHandle, State};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;

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

/// Initiate a connection to `peer_id`. Emits `webrtc_offer` event when ready.
#[tauri::command]
pub async fn webrtc_create_offer(
    peer_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.create_offer(&peer_id, &state.media_manager, &app).await
}

/// Accept an incoming offer from `from`. Emits `webrtc_answer` event.
#[tauri::command]
pub async fn webrtc_handle_offer(
    from: String,
    sdp: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.webrtc_manager.handle_offer(&from, sdp, &state.media_manager, &app).await
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
