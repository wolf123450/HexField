/// LAN discovery and local signaling.
///
/// Two responsibilities:
///   1. Run a local WebSocket server so LAN peers can exchange WebRTC
///      signals without any external rendezvous server.
///   2. Register an mDNS service so peers on the same network automatically
///      discover and connect to each other.
///
/// Architecture
/// ─────────────
/// Each HexField instance:
///   • Binds a TCP listener on a random port (the "LAN signal port").
///   • Registers `_hexfield._tcp.local.` in mDNS with the userId as the
///     instance name, advertising that port.
///   • When a LAN peer is discovered via mDNS, calls `connect_to_lan_peer`
///     which establishes an outgoing WS connection to that peer's signal port
///     and stores a sender in the shared `LanPeers` map.
///   • Incoming connections do the same: after the `lan_hello` handshake the
///     incoming WS sender is stored in the same map.
///
/// `signal_send` consults this map first; if the target userId has an entry
/// the signal is delivered directly without touching the rendezvous server.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;
use tokio_tungstenite::{accept_async, tungstenite::Message as WsMessage};

/// Monotonically increasing counter used to give each `register_peer` call a
/// unique generation ID so that stale cleanup tasks cannot remove a newer entry.
static PEER_GENERATION: AtomicU64 = AtomicU64::new(0);

/// `userId → (generation, WS sender)` for every connected LAN peer.
/// The generation field lets cleanup tasks avoid removing a fresher entry that
/// replaced their own (see the comment in `register_peer`).
pub type LanPeers = Mutex<HashMap<String, (u64, UnboundedSender<Value>)>>;

// ── Local WS signal server ─────────────────────────────────────────────────

/// Bind a TCP listener, spawn the accept loop, return the bound port.
pub async fn start_lan_server(
    app_handle: AppHandle,
    lan_peers: Arc<LanPeers>,
) -> Result<u16, String> {
    let listener = TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("LAN listener bind failed: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    let app = app_handle.clone();
    let peers = Arc::clone(&lan_peers);

    tokio::spawn(async move {
        log::info!("[LAN] Signal server listening on port {}", port);
        loop {
            match listener.accept().await {
                Ok((stream, peer_addr)) => {
                    log::debug!("[LAN] Incoming TCP from {}", peer_addr);
                    let app2 = app.clone();
                    let peers2 = Arc::clone(&peers);
                    tokio::spawn(handle_incoming_lan_connection(stream, peers2, app2));
                }
                Err(e) => {
                    log::error!("[LAN] Accept error: {}", e);
                    break;
                }
            }
        }
    });

    Ok(port)
}

async fn handle_incoming_lan_connection(
    stream: tokio::net::TcpStream,
    lan_peers: Arc<LanPeers>,
    app: AppHandle,
) {
    let ws = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            log::warn!("[LAN] WS handshake error: {}", e);
            return;
        }
    };

    let (mut sink, mut source) = ws.split();

    // First frame must be { "type": "lan_hello", "userId": "<uuid>" }
    let peer_user_id = match source.next().await {
        Some(Ok(WsMessage::Text(text))) => {
            match serde_json::from_str::<Value>(&text) {
                Ok(v)
                    if v.get("type").and_then(|t| t.as_str()) == Some("lan_hello") =>
                {
                    match v.get("userId").and_then(|u| u.as_str()) {
                        Some(uid) => uid.to_string(),
                        None => {
                            log::warn!("[LAN] lan_hello missing userId");
                            return;
                        }
                    }
                }
                _ => {
                    log::warn!("[LAN] Expected lan_hello as first message");
                    return;
                }
            }
        }
        _ => return,
    };

    log::info!("[LAN] Peer {} connected (incoming)", peer_user_id);
    register_peer(
        peer_user_id.clone(),
        Arc::clone(&lan_peers),
        app.clone(),
        &mut sink,
        &mut source,
    )
    .await;
}

// ── Outgoing LAN client ────────────────────────────────────────────────────

/// Connect to another peer's LAN signal server.
pub async fn connect_to_lan_peer(
    user_id: String,
    addr: String,
    port: u16,
    local_user_id: String,
    lan_peers: Arc<LanPeers>,
    app: AppHandle,
) -> Result<(), String> {
    // Skip if already connected to this peer.
    {
        let peers = lan_peers.lock().await;
        if peers.contains_key(&user_id) {
            log::debug!("[LAN] Already have connection to {}", user_id);
            return Ok(());
        }
    }

    let url = format!("ws://{}:{}", addr, port);
    log::info!("[LAN] Connecting to peer {} at {}", user_id, url);

    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("[LAN] connect to {} failed: {}", url, e))?;

    let (mut sink, mut source) = ws.split();

    // Introduce ourselves.
    let hello = json!({ "type": "lan_hello", "userId": local_user_id });
    sink.send(WsMessage::Text(
        serde_json::to_string(&hello).unwrap().into(),
    ))
    .await
    .map_err(|e| e.to_string())?;

    log::info!("[LAN] Connected to peer {} (outgoing)", user_id);
    let uid = user_id.clone();
    let peers2 = Arc::clone(&lan_peers);
    let app2 = app.clone();

    tokio::spawn(async move {
        register_peer(uid, peers2, app2, &mut sink, &mut source).await;
    });

    Ok(())
}

/// Common loop for both incoming and outgoing LAN connections:
/// stores a sender in `lan_peers`, relays incoming frames as Tauri
/// `signal_message` events, watches for a drain message from the sender.
async fn register_peer(
    user_id: String,
    lan_peers: Arc<LanPeers>,
    app: AppHandle,
    sink: &mut (impl SinkExt<WsMessage, Error = tokio_tungstenite::tungstenite::Error>
              + Unpin
              + Send),
    source: &mut (impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>>
               + Unpin
               + Send),
) {
    let gen = PEER_GENERATION.fetch_add(1, Ordering::SeqCst);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();

    {
        let mut peers = lan_peers.lock().await;
        // Drop any previous sender — its task detects the closed channel and exits.
        peers.insert(user_id.clone(), (gen, tx));
    }

    let uid = user_id.clone();
    let peers_ref = Arc::clone(&lan_peers);
    let app_ref = app.clone();

    loop {
        tokio::select! {
            // Incoming WS frame → emit signal_message Tauri event
            msg = source.next() => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                            if let Err(e) = app.emit("signal_message", payload) {
                                log::error!("[LAN] emit signal_message: {}", e);
                            }
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => {
                        log::info!("[LAN] Peer {} disconnected", uid);
                        break;
                    }
                    Some(Err(e)) => {
                        log::warn!("[LAN] WS error from {}: {}", uid, e);
                        break;
                    }
                    _ => {} // Ping / Pong handled by tungstenite
                }
            }
            // Outgoing message queued by signal_send
            outgoing = rx.recv() => {
                match outgoing {
                    Some(payload) => {
                        let text = serde_json::to_string(&payload).unwrap_or_default();
                        if let Err(e) = sink.send(WsMessage::Text(text.into())).await {
                            log::warn!("[LAN] Send to {} failed: {}", uid, e);
                            break;
                        }
                    }
                    // Sender was dropped (e.g. replaced by a newer connection)
                    None => break,
                }
            }
        }
    }

    // Only remove the map entry if it still belongs to this task's generation.
    // When mDNS causes both sides to dial each other simultaneously, the second
    // connection replaces our entry (gen changes). If we removed unconditionally
    // we would delete the valid replacement and leave the map empty.
    {
        let mut peers = peers_ref.lock().await;
        if peers.get(&uid).map(|(g, _)| *g) == Some(gen) {
            peers.remove(&uid);
            let _ = app_ref.emit("lan_peer_lost", json!({ "userId": uid }));
        }
    }
}

// ── mDNS ──────────────────────────────────────────────────────────────────

/// Register this instance and browse for peers.
/// Emits Tauri events `lan_peer_discovered` / `lan_peer_lost`.
pub fn start_mdns(
    user_id: String,
    port: u16,
    app: AppHandle,
) -> Result<(), String> {
    let daemon = ServiceDaemon::new().map_err(|e| format!("[mDNS] daemon: {}", e))?;

    let local_ip = get_primary_local_ip();
    let host_name = format!("{}.local.", &user_id[..8]); // short, valid hostname label

    let mut properties = HashMap::new();
    properties.insert("userId".to_string(), user_id.clone());

    // Instance name = full userId (UUIDs are valid mDNS instance names).
    let service = ServiceInfo::new(
        "_hexfield._tcp.local.",
        &user_id,
        &host_name,
        local_ip,
        port,
        properties,
    )
    .map_err(|e| format!("[mDNS] ServiceInfo: {}", e))?;

    daemon
        .register(service)
        .map_err(|e| format!("[mDNS] register: {}", e))?;

    log::info!("[mDNS] Registered as {} on port {}", user_id, port);

    let receiver = daemon
        .browse("_hexfield._tcp.local.")
        .map_err(|e| format!("[mDNS] browse: {}", e))?;

    let my_user_id = user_id.clone();

    // mdns-sd's Receiver is Send-able; process it in a blocking thread.
    std::thread::spawn(move || {
        // Keep _daemon alive so our service stays registered.
        let _daemon = daemon;

        for event in receiver {
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    // Extract userId from TXT properties.
                    let peer_user_id = info
                        .get_properties()
                        .get_property_val_str("userId")
                        .unwrap_or("")
                        .to_string();

                    if peer_user_id.is_empty() || peer_user_id == my_user_id {
                        continue;
                    }

                    // Prefer the first IPv4 address.
                    let Some(peer_addr) = info
                        .get_addresses()
                        .iter()
                        .find(|a| a.is_ipv4())
                        .map(|a| a.to_string())
                    else {
                        continue;
                    };

                    let peer_port = info.get_port();
                    log::info!(
                        "[mDNS] Discovered {} at {}:{}",
                        peer_user_id,
                        peer_addr,
                        peer_port
                    );

                    let _ = app.emit(
                        "lan_peer_discovered",
                        json!({
                            "userId": peer_user_id,
                            "addr":   peer_addr,
                            "port":   peer_port,
                        }),
                    );
                }
                ServiceEvent::ServiceRemoved(_, full_name) => {
                    log::debug!("[mDNS] Service removed: {}", full_name);
                    // Extract instance name (userId) from full name.
                    if let Some(uid) = full_name.split("._hexfield.").next() {
                        if uid != my_user_id {
                            let _ = app.emit("lan_peer_lost", json!({ "userId": uid }));
                        }
                    }
                }
                _ => {}
            }
        }

        log::info!("[mDNS] Browser thread exiting");
    });

    Ok(())
}

// ── Utilities ─────────────────────────────────────────────────────────────

/// Get the primary local IPv4 address using the UDP routing trick.
/// Works offline (no packet is actually sent).
pub fn get_primary_local_ip() -> IpAddr {
    let socket = match std::net::UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return IpAddr::V4(Ipv4Addr::LOCALHOST),
    };
    // Address doesn't need to be reachable; we just need to ask the OS
    // which interface it would use.
    let _ = socket.connect("8.8.8.8:80");
    socket
        .local_addr()
        .map(|a| a.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
}
