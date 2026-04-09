use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::AppState;
#[cfg(not(mobile))]
use crate::lan;
#[cfg(not(mobile))]
use std::sync::atomic::Ordering;

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

/// Send a JSON payload through the best available signaling path.
///
/// Routing priority:
///   1. Direct LAN connection to the target peer (if `payload.to` is present)
///   2. Rendezvous WebSocket (if connected)
///   3. Error — no path available
#[tauri::command]
pub async fn signal_send(
    state: State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<(), String> {
    // Try LAN path first (desktop only — mobile uses relay exclusively).
    #[cfg(not(mobile))]
    {
        let to_user_id = payload.get("to").and_then(|v| v.as_str()).map(|s| s.to_string());
        if let Some(ref to_id) = to_user_id {
            let lan_sender = {
                let peers = state.lan_peers.lock().await;
                peers.get(to_id).map(|(_, s)| s.clone())
            };
            if let Some(sender) = lan_sender {
                return sender.send(payload).map_err(|e| e.to_string());
            }
        }
    }

    // Fall through to rendezvous server.
    let tx = {
        let guard = state.signal_tx.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };
    match tx {
        Some(sender) => sender.send(payload).await.map_err(|e| e.to_string()),
        None => Err("Not connected to any signaling server".to_string()),
    }
}

// ── LAN commands (desktop only — mobile uses relay/rendezvous) ───────────

/// Return the user IDs of all currently connected LAN peers.
/// Used after a webview refresh to reconnect WebRTC without waiting for
/// mDNS re-discovery (the Rust WS connections stay alive across refreshes).
#[cfg(not(mobile))]
#[tauri::command]
pub async fn lan_get_connected_peers(
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let peers = state.lan_peers.lock().await;
    Ok(peers.keys().cloned().collect())
}

/// Start the local LAN signal server and register mDNS.
/// Idempotent — safe to call multiple times (skips restart if already running).
/// Returns the local signal port.
#[cfg(not(mobile))]
#[tauri::command]
pub async fn lan_start(
    user_id: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<u16, String> {
    // If already started, return existing port.
    let existing = state.lan_signal_port.load(Ordering::Relaxed);
    if existing != 0 {
        return Ok(existing);
    }

    let port = lan::start_lan_server(
        app_handle.clone(),
        Arc::clone(&state.lan_peers),
    ).await?;

    state.lan_signal_port.store(port, Ordering::Relaxed);

    {
        let mut uid = state.local_user_id.lock().map_err(|e| e.to_string())?;
        *uid = user_id.clone();
    }

    lan::start_mdns(user_id, port, app_handle)?;

    Ok(port)
}

/// Connect directly to another peer's LAN signal server.
/// After this call, `signal_send` will route to this peer via the direct
/// WS connection instead of going through the rendezvous server.
#[cfg(not(mobile))]
#[tauri::command]
pub async fn lan_connect_peer(
    user_id: String,
    addr: String,
    port: u16,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let local_user_id = state
        .local_user_id
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    if local_user_id.is_empty() {
        return Err("LAN not started — call lan_start first".to_string());
    }

    lan::connect_to_lan_peer(
        user_id,
        addr,
        port,
        local_user_id,
        Arc::clone(&state.lan_peers),
        app_handle,
    ).await
}

/// Return the local IP address and LAN signal port for embedding in invite links.
/// Returns an empty array if LAN is not started yet.
#[cfg(not(mobile))]
#[tauri::command]
pub fn lan_get_local_addrs(state: State<AppState>) -> Result<Vec<serde_json::Value>, String> {
    let port = state.lan_signal_port.load(Ordering::Relaxed);
    if port == 0 {
        return Ok(vec![]);
    }
    let addr = lan::get_primary_local_ip();
    Ok(vec![serde_json::json!({
        "type": "lan",
        "addr": addr.to_string(),
        "port": port,
    })])
}

// ── UPnP commands (desktop only) ─────────────────────────────────────────

/// Attempt UPnP/NAT-PMP port forwarding for the LAN signal port.
/// Stores the result in AppState for later removal and endpoint generation.
/// Returns the external port on success, or an error if UPnP is unavailable.
#[cfg(not(mobile))]
#[tauri::command]
pub async fn upnp_forward_port(
    state: State<'_, AppState>,
) -> Result<u16, String> {
    let internal_port = state.lan_signal_port.load(Ordering::Relaxed);
    if internal_port == 0 {
        return Err("LAN signal server not started yet".to_string());
    }

    let local_ip = crate::lan::get_primary_local_ip();
    let local_ipv4 = match local_ip {
        std::net::IpAddr::V4(v4) => v4,
        std::net::IpAddr::V6(_) => return Err("IPv6 local IP not supported for UPnP".to_string()),
    };

    let mapping = crate::upnp::forward_port(local_ipv4, internal_port).await?;

    state.upnp_external_port.store(mapping.external_port, Ordering::Relaxed);

    Ok(mapping.external_port)
}

/// Remove the UPnP port mapping created by `upnp_forward_port`.
/// Safe to call even if no mapping exists (returns Ok).
#[cfg(not(mobile))]
#[tauri::command]
pub async fn upnp_remove_mapping(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let port = state.upnp_external_port.swap(0, Ordering::Relaxed);
    if port == 0 {
        return Ok(());
    }
    crate::upnp::remove_mapping(port).await
}

/// Return the public WAN endpoint for embedding in invite links.
/// Requires that UPnP forwarding succeeded and public IP is known.
/// Returns `null` if either is unavailable.
#[cfg(not(mobile))]
#[tauri::command]
pub fn get_public_endpoint(
    state: State<AppState>,
) -> Result<Option<serde_json::Value>, String> {
    let ext_port = state.upnp_external_port.load(Ordering::Relaxed);
    if ext_port == 0 {
        return Ok(None);
    }

    let public_ip = state.public_ip.lock().map_err(|e| e.to_string())?;
    match &*public_ip {
        Some(ip) => Ok(Some(serde_json::json!({
            "type": "direct",
            "addr": ip,
            "port": ext_port,
        }))),
        None => Ok(None),
    }
}

/// Store the public IP address discovered by the frontend (via STUN).
/// Called by the frontend after `detectNATType()` runs.
#[cfg(not(mobile))]
#[tauri::command]
pub fn set_public_ip(
    state: State<AppState>,
    ip: String,
) -> Result<(), String> {
    let mut guard = state.public_ip.lock().map_err(|e| e.to_string())?;
    *guard = Some(ip);
    Ok(())
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU16, Ordering};
    use std::sync::{Arc, Mutex};

    /// Mirrors the get_public_endpoint logic — returns a JSON endpoint or None
    /// based on the external port and public IP.
    fn build_endpoint(ext_port: u16, public_ip: &Option<String>) -> Option<serde_json::Value> {
        if ext_port == 0 {
            return None;
        }
        public_ip.as_ref().map(|ip| serde_json::json!({
            "type": "direct",
            "addr": ip,
            "port": ext_port,
        }))
    }

    #[test]
    fn endpoint_returns_none_when_no_upnp_mapping() {
        let result = build_endpoint(0, &Some("203.0.113.1".to_string()));
        assert!(result.is_none());
    }

    #[test]
    fn endpoint_returns_none_when_no_public_ip() {
        let result = build_endpoint(8080, &None);
        assert!(result.is_none());
    }

    #[test]
    fn endpoint_returns_json_when_both_present() {
        let result = build_endpoint(8080, &Some("203.0.113.1".to_string()));
        assert!(result.is_some());
        let v = result.unwrap();
        assert_eq!(v["type"], "direct");
        assert_eq!(v["addr"], "203.0.113.1");
        assert_eq!(v["port"], 8080);
    }

    #[test]
    fn upnp_port_swap_clears_atomically() {
        let port = Arc::new(AtomicU16::new(9999));
        let swapped = port.swap(0, Ordering::Relaxed);
        assert_eq!(swapped, 9999);
        assert_eq!(port.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn set_public_ip_stores_value() {
        let public_ip: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        {
            let mut guard = public_ip.lock().unwrap();
            *guard = Some("198.51.100.5".to_string());
        }
        let guard = public_ip.lock().unwrap();
        assert_eq!(*guard, Some("198.51.100.5".to_string()));
    }
}
