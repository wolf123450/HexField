//! Tauri commands for Rust-native audio capture, playback, and screen sharing.

use crate::media_manager::{AudioDeviceList, ScreenSourceList};
use crate::AppState;
use tauri::{AppHandle, State};

/// Reset all media state. Called on frontend init to recover from stale state
/// after a webview refresh (F5). Idempotent — safe to call when nothing is active.
#[tauri::command]
pub async fn media_reset_all(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Stop mic if active (ignore errors — may not be running)
    let _ = state.media_manager.stop_mic(&app).await;
    state.media_manager.stop_all_remote_playback().await;
    let _ = state.webrtc_manager.remove_audio_tracks_from_all(&app).await;

    // Stop screen share if active
    let _ = state.media_manager.stop_screen_share(&app).await;
    let _ = state.webrtc_manager.remove_video_tracks_from_all(&app).await;

    log::info!("[media] reset_all: cleared stale media state");
    Ok(())
}

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
    state.media_manager.stop_all_remote_playback().await;
    state
        .webrtc_manager
        .remove_audio_tracks_from_all(&app)
        .await
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

/// List available monitors and windows for screen sharing.
#[tauri::command]
pub async fn media_enumerate_screens(
    state: State<'_, AppState>,
) -> Result<ScreenSourceList, String> {
    state.media_manager.enumerate_screens()
}

/// Check if screen sharing is supported on this platform.
#[tauri::command]
pub async fn media_screen_share_supported(
    state: State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.media_manager.is_screen_share_supported())
}

/// Start screen sharing. Adds a video track to all peers and begins capture.
#[tauri::command]
pub async fn media_start_screen_share(
    source_id: String,
    fps: Option<u32>,
    bitrate_kbps: Option<u32>,
    use_new_pipeline: Option<bool>,
    dual_encoding: Option<bool>,
    inline_preview: Option<bool>,
    downscale_method: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let use_new = use_new_pipeline.unwrap_or(false);
    let dual = dual_encoding.unwrap_or(false) && use_new; // dual requires new pipeline
    let inline = inline_preview.unwrap_or(false);
    let method = match downscale_method.as_deref() {
        Some("nearest")  => crate::capture::DownscaleMethod::Nearest,
        Some("bicubic")  => crate::capture::DownscaleMethod::Bicubic,
        Some("lanczos3") => crate::capture::DownscaleMethod::Lanczos3,
        _                => crate::capture::DownscaleMethod::Bilinear,
    };

    let (video_track, video_track_high) = if dual {
        let (low, high) = state
            .webrtc_manager
            .add_video_tracks_dual(&app)
            .await?;
        (low, Some(high))
    } else {
        let track = state
            .webrtc_manager
            .add_video_track_to_all(&app)
            .await?;
        (track, None)
    };

    state
        .media_manager
        .start_screen_share(
            &source_id,
            video_track,
            video_track_high,
            app,
            fps.unwrap_or(30),
            bitrate_kbps.unwrap_or(2500),
            use_new,
            inline,
            method,
        )
        .await
}

/// Stop screen sharing. Stops capture and removes video tracks from all peers.
#[tauri::command]
pub async fn media_stop_screen_share(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.media_manager.stop_screen_share(&app).await?;
    state
        .webrtc_manager
        .remove_video_tracks_from_all(&app)
        .await
}

/// Switch a specific peer's video track to a different quality tier.
#[tauri::command]
pub async fn webrtc_set_peer_quality(
    peer_id: String,
    tier: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let quality_tier = match tier.as_str() {
        "high" => crate::webrtc_manager::VideoQualityTier::High,
        _ => crate::webrtc_manager::VideoQualityTier::Low,
    };
    state
        .webrtc_manager
        .set_peer_video_quality(&peer_id, quality_tier, &app)
        .await
}
