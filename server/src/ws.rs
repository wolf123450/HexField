use axum::{
    extract::{ws::{CloseFrame, Message, WebSocket}, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::session::Session;
use crate::state::{now_secs, ConnectedClient, ServerState};

/// Close code sent when the connection's session token expires. The client
/// re-authenticates and reconnects.
pub const CLOSE_SESSION_EXPIRED: u16 = 4001;

/// GET /ws with `Authorization: Bearer <session token>` on the upgrade
/// request. Rejects the upgrade with 401 unless the token is valid; the
/// connection's user ID always comes from the token. The token is not read
/// from the query string, so it does not end up in proxy access logs.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<Arc<ServerState>>,
) -> Response {
    let Some(session) = crate::middleware::bearer_token(&headers).and_then(|t| state.verify_session(t)) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    ws.on_upgrade(move |socket| handle_socket(socket, session, state))
}

/// The instant at which a token with expiry `exp` (unix seconds) runs out.
fn deadline_for(exp: u64) -> Instant {
    Instant::now() + Duration::from_secs(exp.saturating_sub(now_secs()))
}

/// Handle `{"type":"auth","token":...}` sent on an open socket: a fresh
/// token for the same user extends the connection's deadline. Returns the
/// new expiry, or None if the token is invalid or for another user.
fn refresh_session(state: &ServerState, user_id: &str, payload: &serde_json::Value) -> Option<u64> {
    let token = payload.get("token").and_then(|v| v.as_str())?;
    let session = state.verify_session(token)?;
    (session.user_id == user_id).then_some(session.exp)
}

async fn handle_socket(socket: WebSocket, session: Session, state: Arc<ServerState>) {
    let Session { user_id, exp } = session;
    let (mut ws_sink, mut ws_source) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let (close_tx, mut close_rx) = oneshot::channel::<CloseFrame>();

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

    let mut send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                // Queued text goes out before a close frame.
                biased;
                msg = rx.recv() => match msg {
                    Some(msg) => {
                        if ws_sink.send(Message::Text(msg.into())).await.is_err() { break; }
                    }
                    None => break,
                },
                frame = &mut close_rx => {
                    if let Ok(frame) = frame {
                        let _ = ws_sink.send(Message::Close(Some(frame))).await;
                    }
                    break;
                }
            }
        }
        let _ = ws_sink.close().await;
    });

    // Close the socket when the session token expires, unless the client
    // sends a fresh token first (`{"type":"auth","token":...}`).
    let expiry = tokio::time::sleep_until(deadline_for(exp));
    tokio::pin!(expiry);
    let mut expired = false;

    let ws_msg_rps = state.config.ws_msg_rps;
    loop {
        tokio::select! {
            msg = ws_source.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    if !check_ws_rate_limit(&client, ws_msg_rps) { continue; }
                    let text_str: &str = &text;
                    let Ok(payload) = serde_json::from_str::<serde_json::Value>(text_str) else { continue };
                    if payload.get("type").and_then(|v| v.as_str()) == Some("auth") {
                        let reply = match refresh_session(&state, &user_id, &payload) {
                            Some(new_exp) => {
                                expiry.as_mut().reset(deadline_for(new_exp));
                                serde_json::json!({ "type": "auth_ok", "expires_at": new_exp })
                            }
                            None => serde_json::json!({ "type": "auth_failed" }),
                        };
                        let _ = client.tx.send(reply.to_string());
                        continue;
                    }
                    let clients = state.clients.read().await;
                    deliver(route(&clients, &user_id, payload), &client);
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            _ = &mut expiry => {
                tracing::info!("WS session expired: {}", user_id);
                let _ = client.tx.send(serde_json::json!({ "type": "session_expired" }).to_string());
                let _ = close_tx.send(CloseFrame {
                    code: CLOSE_SESSION_EXPIRED,
                    reason: "session expired".into(),
                });
                expired = true;
                break;
            }
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
    // On expiry, let the send task flush `session_expired` and the close frame.
    if expired && tokio::time::timeout(Duration::from_secs(5), &mut send_task).await.is_ok() {
        return;
    }
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

    // ── Loopback tests of the /ws endpoint ───────────────────────────────

    use axum::{routing::get, Router};
    use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, protocol::frame::coding::CloseCode};

    type Client = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    fn test_state() -> Arc<ServerState> {
        use clap::Parser;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config = crate::config::Config::parse_from([
            "hexfield-server", "--db-path", ":memory:",
            "--session-secret", "0123456789abcdef0123456789abcdef",
        ]);
        Arc::new(ServerState::new(&config))
    }

    /// Serve `/ws` on a loopback port and return its URL.
    async fn serve(state: Arc<ServerState>) -> String {
        let app = Router::new().route("/ws", get(ws_handler)).with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("ws://{addr}/ws")
    }

    async fn connect(url: &str, bearer: Option<&str>) -> Result<Client, tungstenite::Error> {
        let mut req = url.into_client_request()?;
        if let Some(t) = bearer {
            req.headers_mut().insert("authorization", format!("Bearer {t}").parse().unwrap());
        }
        tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws)
    }

    fn assert_unauthorized(res: Result<Client, tungstenite::Error>) {
        match res {
            Err(tungstenite::Error::Http(resp)) => assert_eq!(resp.status(), StatusCode::UNAUTHORIZED),
            Err(e) => panic!("expected 401, got {e}"),
            Ok(_) => panic!("expected 401, upgrade succeeded"),
        }
    }

    /// Next message within `secs`, or panic.
    async fn next(ws: &mut Client, secs: u64) -> tungstenite::Message {
        tokio::time::timeout(Duration::from_secs(secs), ws.next())
            .await
            .expect("timed out waiting for a message")
            .expect("stream ended")
            .expect("read error")
    }

    async fn next_json(ws: &mut Client, secs: u64) -> Value {
        match next(ws, secs).await {
            tungstenite::Message::Text(t) => serde_json::from_str(&t).unwrap(),
            other => panic!("expected text, got {other:?}"),
        }
    }

    async fn send_json(ws: &mut Client, v: Value) {
        ws.send(tungstenite::Message::Text(v.to_string().into())).await.unwrap();
    }

    #[tokio::test]
    async fn upgrade_accepts_bearer_header() {
        let state = test_state();
        let url = serve(state.clone()).await;
        let (token, _) = state.issue_session_token("alice");
        let mut ws = connect(&url, Some(&token)).await.unwrap();
        send_json(&mut ws, json!({ "type": "ping" })).await;
        assert_eq!(next_json(&mut ws, 5).await, json!({ "type": "pong" }));
    }

    #[tokio::test]
    async fn upgrade_rejects_missing_forged_or_expired_token() {
        let state = test_state();
        let url = serve(state.clone()).await;
        assert_unauthorized(connect(&url, None).await);
        assert_unauthorized(connect(&url, Some("alice")).await);
        let expired = state.issue_session_token_until("alice", now_secs() - 1);
        assert_unauthorized(connect(&url, Some(&expired)).await);
    }

    #[tokio::test]
    async fn token_in_query_string_is_not_accepted() {
        let state = test_state();
        let url = serve(state.clone()).await;
        let (token, _) = state.issue_session_token("alice");
        assert_unauthorized(connect(&format!("{url}?token={token}"), None).await);
    }

    #[tokio::test]
    async fn socket_is_closed_when_token_expires() {
        let state = test_state();
        let url = serve(state.clone()).await;
        let token = state.issue_session_token_until("alice", now_secs() + 1);
        let mut ws = connect(&url, Some(&token)).await.unwrap();
        assert_eq!(next_json(&mut ws, 5).await, json!({ "type": "session_expired" }));
        match next(&mut ws, 5).await {
            tungstenite::Message::Close(Some(frame)) => {
                assert_eq!(frame.code, CloseCode::from(CLOSE_SESSION_EXPIRED));
            }
            other => panic!("expected close frame, got {other:?}"),
        }
        // The user's entry is removed, so signals to them get peer_unavailable.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!state.clients.read().await.contains_key("alice"));
    }

    #[tokio::test]
    async fn fresh_token_on_socket_extends_the_session() {
        let state = test_state();
        let url = serve(state.clone()).await;
        let short = state.issue_session_token_until("alice", now_secs() + 1);
        let mut ws = connect(&url, Some(&short)).await.unwrap();
        let (fresh, fresh_exp) = state.issue_session_token("alice");
        send_json(&mut ws, json!({ "type": "auth", "token": fresh })).await;
        assert_eq!(next_json(&mut ws, 5).await, json!({ "type": "auth_ok", "expires_at": fresh_exp }));
        // Past the old expiry, the socket still works.
        tokio::time::sleep(Duration::from_millis(2500)).await;
        send_json(&mut ws, json!({ "type": "ping" })).await;
        assert_eq!(next_json(&mut ws, 5).await, json!({ "type": "pong" }));
    }

    #[tokio::test]
    async fn refresh_with_another_users_token_is_rejected() {
        let state = test_state();
        let url = serve(state.clone()).await;
        let short = state.issue_session_token_until("alice", now_secs() + 1);
        let mut ws = connect(&url, Some(&short)).await.unwrap();
        let (bobs, _) = state.issue_session_token("bob");
        send_json(&mut ws, json!({ "type": "auth", "token": bobs })).await;
        assert_eq!(next_json(&mut ws, 5).await, json!({ "type": "auth_failed" }));
        send_json(&mut ws, json!({ "type": "auth", "token": "garbage" })).await;
        assert_eq!(next_json(&mut ws, 5).await, json!({ "type": "auth_failed" }));
        // The original deadline still applies.
        assert_eq!(next_json(&mut ws, 5).await, json!({ "type": "session_expired" }));
    }
}
