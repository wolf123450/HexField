//! Tauri commands for Rust-native audio capture and playback.

use crate::media_manager::AudioDeviceList;
use crate::AppState;
use tauri::{AppHandle, State};

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
