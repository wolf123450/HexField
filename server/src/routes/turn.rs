use axum::{extract::State, http::StatusCode, Json};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use sha1::Sha1;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::state::ServerState;

#[derive(Deserialize)]
pub struct CredentialRequest { pub user_id: String }

#[derive(Serialize)]
pub struct TurnCredentials {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
    pub ttl: u64,
}

pub async fn get_credentials(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<CredentialRequest>,
) -> Result<Json<TurnCredentials>, (StatusCode, String)> {
    if !state.config.has_turn() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "TURN not configured".into()));
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let expiry = now + state.config.turn_ttl;
    let username = format!("{}:{}", expiry, req.user_id);
    let mut mac = Hmac::<Sha1>::new_from_slice(state.config.turn_secret.as_bytes())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    mac.update(username.as_bytes());
    let credential = STANDARD.encode(mac.finalize().into_bytes());
    Ok(Json(TurnCredentials {
        urls: vec![state.config.turn_url.clone()], username, credential, ttl: state.config.turn_ttl,
    }))
}
