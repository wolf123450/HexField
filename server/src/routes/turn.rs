//! TURN credentials for clients. Two backends, chosen by config:
//! - Cloudflare Realtime TURN (`HEXFIELD_CF_TURN_KEY_ID` + `HEXFIELD_CF_TURN_API_TOKEN`):
//!   short-lived credentials minted through Cloudflare's API. Preferred when set.
//! - coturn shared secret (`HEXFIELD_TURN_URL` + `HEXFIELD_TURN_SECRET`):
//!   HMAC-SHA1 credentials computed locally (TURN REST API scheme).

use axum::{extract::State, http::StatusCode, Json};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::Config;
use crate::state::ServerState;

const CF_TURN_API: &str = "https://rtc.live.cloudflare.com/v1/turn/keys";

#[derive(Deserialize)]
pub struct CredentialRequest { pub user_id: String }

#[derive(Serialize, Debug, PartialEq)]
pub struct TurnCredentials {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
    pub ttl: u64,
}

type ApiError = (StatusCode, String);

pub async fn get_credentials(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<CredentialRequest>,
) -> Result<Json<TurnCredentials>, ApiError> {
    if state.config.has_cloudflare_turn() {
        cloudflare_credentials(&state).await.map(Json)
    } else if state.config.has_turn() {
        coturn_credentials(&state.config, &req.user_id).map(Json)
    } else {
        Err((StatusCode::SERVICE_UNAVAILABLE, "TURN not configured".into()))
    }
}

fn provider_error(detail: impl std::fmt::Display) -> ApiError {
    tracing::error!("Cloudflare TURN: {detail}");
    (StatusCode::BAD_GATEWAY, "TURN provider unavailable".into())
}

async fn cloudflare_credentials(state: &ServerState) -> Result<TurnCredentials, ApiError> {
    let config = &state.config;
    let url = format!("{CF_TURN_API}/{}/credentials/generate-ice-servers", config.cf_turn_key_id);
    let resp = state
        .http
        .post(&url)
        .bearer_auth(&config.cf_turn_api_token)
        .json(&serde_json::json!({ "ttl": config.turn_ttl }))
        .send()
        .await
        .map_err(|e| provider_error(format!("request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(provider_error(format!("API returned {}", resp.status())));
    }
    let body: CfIceServersResponse = resp
        .json()
        .await
        .map_err(|e| provider_error(format!("bad response: {e}")))?;
    from_cloudflare(body, config.turn_ttl)
        .ok_or_else(|| provider_error("response had no usable TURN server"))
}

#[derive(Deserialize)]
struct CfIceServer {
    urls: Vec<String>,
    #[serde(default)]
    username: String,
    #[serde(default)]
    credential: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfIceServersResponse {
    ice_servers: Vec<CfIceServer>,
}

/// Pick the credentialed (TURN) entry from Cloudflare's `iceServers`. Clients
/// already have public STUN. Port 53 URLs are dropped: many browsers and
/// networks block them (Cloudflare docs).
fn from_cloudflare(body: CfIceServersResponse, ttl: u64) -> Option<TurnCredentials> {
    let server = body
        .ice_servers
        .into_iter()
        .find(|s| !s.username.is_empty() && !s.credential.is_empty())?;
    let urls: Vec<String> = server
        .urls
        .into_iter()
        .filter(|u| !u.contains(":53?") && !u.ends_with(":53"))
        .collect();
    if urls.is_empty() {
        return None;
    }
    Some(TurnCredentials { urls, username: server.username, credential: server.credential, ttl })
}

fn coturn_credentials(config: &Config, user_id: &str) -> Result<TurnCredentials, ApiError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .as_secs();
    let expiry = now + config.turn_ttl;
    let username = format!("{}:{}", expiry, user_id);
    let mut mac = Hmac::<Sha1>::new_from_slice(config.turn_secret.as_bytes())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    mac.update(username.as_bytes());
    let credential = STANDARD.encode(mac.finalize().into_bytes());
    Ok(TurnCredentials {
        urls: vec![config.turn_url.clone()], username, credential, ttl: config.turn_ttl,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CF_SAMPLE: &str = r#"{
      "iceServers": [
        { "urls": ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
        { "urls": [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turn:turn.cloudflare.com:53?transport=udp",
            "turn:turn.cloudflare.com:443?transport=udp",
            "turns:turn.cloudflare.com:443?transport=tcp"
          ],
          "username": "u123", "credential": "c456" }
      ]
    }"#;

    #[test]
    fn picks_turn_entry_and_drops_port_53() {
        let body: CfIceServersResponse = serde_json::from_str(CF_SAMPLE).unwrap();
        let creds = from_cloudflare(body, 3600).unwrap();
        assert_eq!(creds.username, "u123");
        assert_eq!(creds.credential, "c456");
        assert_eq!(creds.ttl, 3600);
        assert_eq!(creds.urls, vec![
            "turn:turn.cloudflare.com:3478?transport=udp".to_string(),
            "turn:turn.cloudflare.com:443?transport=udp".to_string(),
            "turns:turn.cloudflare.com:443?transport=tcp".to_string(),
        ]);
    }

    #[test]
    fn no_credentialed_entry_is_none() {
        let body: CfIceServersResponse =
            serde_json::from_str(r#"{ "iceServers": [ { "urls": ["stun:stun.cloudflare.com:3478"] } ] }"#).unwrap();
        assert!(from_cloudflare(body, 3600).is_none());
    }

    #[test]
    fn coturn_credential_is_hmac_of_expiry_and_user() {
        use clap::Parser;
        let config = Config::parse_from([
            "hexfield-server", "--turn-url", "turn:t.example:3478", "--turn-secret", "s3cret", "--turn-ttl", "600",
        ]);
        let creds = coturn_credentials(&config, "alice").unwrap();
        let (expiry, user) = creds.username.split_once(':').unwrap();
        assert_eq!(user, "alice");
        assert!(expiry.parse::<u64>().is_ok());
        let mut mac = Hmac::<Sha1>::new_from_slice(b"s3cret").unwrap();
        mac.update(creds.username.as_bytes());
        assert_eq!(creds.credential, STANDARD.encode(mac.finalize().into_bytes()));
        assert_eq!(creds.urls, vec!["turn:t.example:3478".to_string()]);
    }
}
