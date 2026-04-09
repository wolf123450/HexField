use axum::{
    extract::{ws::{Message, WebSocket}, Query, State, WebSocketUpgrade},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

use crate::state::{ConnectedClient, ServerState};

#[derive(Deserialize)]
pub struct WsParams {
    pub token: String,
    #[serde(default)]
    pub public_sign_key: String,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsParams>,
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    let user_id = params.token.clone();
    let public_sign_key = params.public_sign_key.clone();
    ws.on_upgrade(move |socket| handle_socket(socket, user_id, public_sign_key, state))
}

async fn handle_socket(socket: WebSocket, user_id: String, public_sign_key: String, state: Arc<ServerState>) {
    let (mut ws_sink, mut ws_source) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

    let client = Arc::new(ConnectedClient {
        user_id: user_id.clone(), public_sign_key, tx: tx.clone(),
        msg_count: AtomicU32::new(0), window_start: AtomicU64::new(now_secs),
    });

    // Connection limit check
    {
        let c = state.clients.read().await;
        if c.len() >= state.config.max_connections {
            tracing::warn!("Connection limit reached, rejecting {}", user_id);
            let _ = ws_sink.send(Message::Close(None)).await;
            return;
        }
    }

    { let mut c = state.clients.write().await; c.insert(user_id.clone(), client.clone()); }
    tracing::info!("WS connected: {}", user_id);
    broadcast_presence(&state, &user_id, "online").await;

    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sink.send(Message::Text(msg.into())).await.is_err() { break; }
        }
        let _ = ws_sink.close().await;
    });

    let ws_msg_rps = state.config.ws_msg_rps;
    while let Some(msg) = ws_source.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if !check_ws_rate_limit(&client, ws_msg_rps) { continue; }
                let text_str: &str = &text;
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(text_str) {
                    route_message(&state, &user_id, payload).await;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    { let mut c = state.clients.write().await; c.remove(&user_id); }
    broadcast_presence(&state, &user_id, "offline").await;
    tracing::info!("WS disconnected: {}", user_id);
    send_task.abort();
}

fn check_ws_rate_limit(client: &ConnectedClient, max_rps: u32) -> bool {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let window = client.window_start.load(Ordering::Relaxed);
    if now > window {
        client.window_start.store(now, Ordering::Relaxed);
        client.msg_count.store(1, Ordering::Relaxed);
        true
    } else {
        client.msg_count.fetch_add(1, Ordering::Relaxed) < max_rps
    }
}

async fn route_message(state: &ServerState, from: &str, mut payload: serde_json::Value) {
    payload["from"] = serde_json::Value::String(from.to_string());
    match payload.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "signal_offer" | "signal_answer" | "signal_ice" => {
            if let Some(to) = payload.get("to").and_then(|v| v.as_str()) {
                send_to_client(state, to, &payload).await;
            }
        }
        "presence_update" | "typing_start" | "typing_stop" => {
            broadcast_except(state, from, &payload).await;
        }
        "ping" => { send_to_client(state, from, &serde_json::json!({"type":"pong"})).await; }
        _ => { tracing::debug!("Unknown WS msg type from {}", from); }
    }
}

async fn send_to_client(state: &ServerState, user_id: &str, payload: &serde_json::Value) {
    let clients = state.clients.read().await;
    if let Some(c) = clients.get(user_id) {
        let _ = c.tx.send(serde_json::to_string(payload).unwrap_or_default());
    }
}

async fn broadcast_except(state: &ServerState, except: &str, payload: &serde_json::Value) {
    let text = serde_json::to_string(payload).unwrap_or_default();
    let clients = state.clients.read().await;
    for (uid, c) in clients.iter() {
        if uid != except { let _ = c.tx.send(text.clone()); }
    }
}

async fn broadcast_presence(state: &ServerState, user_id: &str, status: &str) {
    broadcast_except(state, user_id, &serde_json::json!({"type":"presence_update","from":user_id,"status":status})).await;
}
