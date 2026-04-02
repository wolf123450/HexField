use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::AppState;

/// Connect to a WebSocket signaling server.
/// Spawns a tokio task that reads incoming messages and emits them as Tauri events.
/// Outgoing messages are sent via the `signal_tx` channel stored in AppState.
#[tauri::command]
pub async fn signal_connect(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    // Disconnect any existing connection first
    {
        let mut tx_guard = state.signal_tx.lock().map_err(|e| e.to_string())?;
        if tx_guard.is_some() {
            *tx_guard = None;
        }
    }

    let (outgoing_tx, mut outgoing_rx) = mpsc::channel::<serde_json::Value>(256);

    // Store the sender so signal_send can use it
    {
        let mut tx_guard = state.signal_tx.lock().map_err(|e| e.to_string())?;
        *tx_guard = Some(outgoing_tx);
    }

    // Clone the Arc so the spawned task can clear the sender on shutdown
    let signal_tx_ref = Arc::clone(&state.signal_tx);
    let app = app_handle.clone();

    tokio::spawn(async move {
        let _ = app.emit("signal_state", "connecting");

        let ws_stream = match tokio_tungstenite::connect_async(&url).await {
            Ok((stream, _)) => stream,
            Err(e) => {
                log::error!("WS connect failed: {}", e);
                let _ = app.emit("signal_state", "error");
                if let Ok(mut tx) = signal_tx_ref.lock() {
                    *tx = None;
                }
                return;
            }
        };

        let _ = app.emit("signal_state", "connected");
        log::info!("WS signaling connected to {}", url);

        let (mut ws_sink, mut ws_source) = ws_stream.split();

        loop {
            tokio::select! {
                // Incoming WS message -> emit to frontend
                msg = ws_source.next() => {
                    match msg {
                        Some(Ok(WsMessage::Text(text))) => {
                            match serde_json::from_str::<serde_json::Value>(&text) {
                                Ok(payload) => {
                                    if let Err(e) = app.emit("signal_message", payload) {
                                        log::error!("Failed to emit signal_message: {}", e);
                                    }
                                }
                                Err(e) => {
                                    log::warn!("Non-JSON WS message: {}", e);
                                }
                            }
                        }
                        Some(Ok(WsMessage::Close(_))) | None => {
                            log::info!("WS connection closed");
                            break;
                        }
                        Some(Err(e)) => {
                            log::error!("WS read error: {}", e);
                            break;
                        }
                        _ => {} // Ping/Pong handled by tungstenite
                    }
                }
                // Outgoing message from frontend -> send to WS
                outgoing = outgoing_rx.recv() => {
                    match outgoing {
                        Some(payload) => {
                            let text = serde_json::to_string(&payload).unwrap_or_default();
                            if let Err(e) = ws_sink.send(WsMessage::Text(text.into())).await {
                                log::error!("WS send error: {}", e);
                                break;
                            }
                        }
                        None => {
                            // Channel closed — disconnect requested
                            log::info!("Signal send channel closed, shutting down WS");
                            break;
                        }
                    }
                }
            }
        }

        // Clean up
        let _ = ws_sink.close().await;
        let _ = app.emit("signal_state", "disconnected");
        if let Ok(mut tx) = signal_tx_ref.lock() {
            *tx = None;
        }
    });

    Ok(())
}

/// Disconnect from the signaling server.
#[tauri::command]
pub fn signal_disconnect(state: State<AppState>) -> Result<(), String> {
    let mut tx_guard = state.signal_tx.lock().map_err(|e| e.to_string())?;
    *tx_guard = None;
    Ok(())
}

/// Send a JSON payload through the signaling WebSocket.
#[tauri::command]
pub async fn signal_send(
    state: State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<(), String> {
    let tx = {
        let guard = state.signal_tx.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };
    match tx {
        Some(sender) => {
            sender.send(payload).await.map_err(|e| e.to_string())?;
            Ok(())
        }
        None => Err("Not connected to signaling server".to_string()),
    }
}
