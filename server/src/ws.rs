use axum::{
    extract::{ws::{Message, WebSocket}, Query, State, WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

use crate::state::{ConnectedClient, ServerState};

#[derive(Deserialize)]
pub struct WsParams {
    /// Session token from `/auth/verify`. The user ID is taken from it.
    #[serde(default)]
    pub token: String,
}

/// GET /ws?token=<session token>. Rejects the upgrade with 401 unless the
/// token is valid; the connection's user ID always comes from the token.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsParams>,
    State(state): State<Arc<ServerState>>,
) -> Response {
    let Some(user_id) = state.verify_session_token(&params.token) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    ws.on_upgrade(move |socket| handle_socket(socket, user_id, state))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

async fn handle_socket(socket: WebSocket, user_id: String, state: Arc<ServerState>) {
    let (mut ws_sink, mut ws_source) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let client = Arc::new(ConnectedClient {
        tx,
        msg_count: AtomicU32::new(0),
        window_start: AtomicU64::new(now_secs()),
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

    // A newer connection for the same user replaces the older one.
    { let mut c = state.clients.write().await; c.insert(user_id.clone(), client.clone()); }
    tracing::info!("WS connected: {}", user_id);

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
                    let clients = state.clients.read().await;
                    deliver(route(&clients, &user_id, payload), &client);
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    // Only remove our own entry: if the user reconnected, the map already
    // holds the newer connection and it must stay.
    {
        let mut c = state.clients.write().await;
        if c.get(&user_id).is_some_and(|cur| Arc::ptr_eq(cur, &client)) {
            c.remove(&user_id);
        }
    }
    tracing::info!("WS disconnected: {}", user_id);
    send_task.abort();
}

fn check_ws_rate_limit(client: &ConnectedClient, max_rps: u32) -> bool {
    let now = now_secs();
    let window = client.window_start.load(Ordering::Relaxed);
    if now > window {
        client.window_start.store(now, Ordering::Relaxed);
        client.msg_count.store(1, Ordering::Relaxed);
        true
    } else {
        client.msg_count.fetch_add(1, Ordering::Relaxed) < max_rps
    }
}

enum Outbound {
    /// Forward to the addressed recipient.
    To(Arc<ConnectedClient>, String),
    /// Reply to the sender only.
    Sender(String),
}

fn deliver(out: Option<Outbound>, sender: &ConnectedClient) {
    match out {
        Some(Outbound::To(recipient, text)) => { let _ = recipient.tx.send(text); }
        Some(Outbound::Sender(text)) => { let _ = sender.tx.send(text); }
        None => {}
    }
}

/// The server is a signaling mailbox only: it forwards `signal_*` messages to
/// the addressed `to` and answers `ping`. Nothing is ever broadcast, so no
/// one learns who is online without addressing them directly.
fn route(
    clients: &HashMap<String, Arc<ConnectedClient>>,
    from: &str,
    mut payload: serde_json::Value,
) -> Option<Outbound> {
    let msg_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
    match msg_type.as_str() {
        "signal_offer" | "signal_answer" | "signal_ice" => {
            let to = payload.get("to").and_then(|v| v.as_str())?.to_string();
            // `from` is always the authenticated sender, never client-supplied.
            payload["from"] = serde_json::Value::String(from.to_string());
            Some(match clients.get(&to) {
                Some(recipient) => Outbound::To(recipient.clone(), payload.to_string()),
                None => Outbound::Sender(
                    serde_json::json!({ "type": "peer_unavailable", "to": to }).to_string(),
                ),
            })
        }
        "ping" => Some(Outbound::Sender(serde_json::json!({ "type": "pong" }).to_string())),
        _ => {
            tracing::debug!("Dropped WS msg type {:?} from {}", msg_type, from);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn client() -> Arc<ConnectedClient> {
        let (tx, _rx) = mpsc::unbounded_channel();
        Arc::new(ConnectedClient { tx, msg_count: AtomicU32::new(0), window_start: AtomicU64::new(0) })
    }

    fn reply_to_sender(out: Option<Outbound>) -> Value {
        match out {
            Some(Outbound::Sender(t)) => serde_json::from_str(&t).unwrap(),
            _ => panic!("expected a reply to the sender"),
        }
    }

    #[test]
    fn signal_is_forwarded_to_addressee_with_authenticated_from() {
        let bob = client();
        let clients = HashMap::from([("bob".to_string(), bob.clone())]);
        let out = route(&clients, "alice",
            json!({ "type": "signal_offer", "to": "bob", "from": "mallory", "sdp": "x" }));
        match out {
            Some(Outbound::To(r, t)) => {
                assert!(Arc::ptr_eq(&r, &bob));
                let v: Value = serde_json::from_str(&t).unwrap();
                assert_eq!(v["from"], "alice");
                assert_eq!(v["sdp"], "x");
            }
            _ => panic!("expected forward to bob"),
        }
    }

    #[test]
    fn signal_to_offline_user_replies_peer_unavailable_to_sender_only() {
        let out = route(&HashMap::new(), "alice", json!({ "type": "signal_ice", "to": "carol", "candidate": {} }));
        assert_eq!(reply_to_sender(out), json!({ "type": "peer_unavailable", "to": "carol" }));
    }

    #[test]
    fn ping_gets_pong() {
        let out = route(&HashMap::new(), "alice", json!({ "type": "ping" }));
        assert_eq!(reply_to_sender(out), json!({ "type": "pong" }));
    }

    #[test]
    fn presence_and_typing_are_not_relayed() {
        let clients = HashMap::from([("bob".to_string(), client())]);
        for t in ["presence_update", "typing_start", "typing_stop", "chat_message", ""] {
            assert!(route(&clients, "alice", json!({ "type": t, "to": "bob" })).is_none(), "{t} must not be relayed");
        }
    }

    #[test]
    fn signal_without_to_is_dropped() {
        let clients = HashMap::from([("bob".to_string(), client())]);
        assert!(route(&clients, "alice", json!({ "type": "signal_offer" })).is_none());
    }
}
