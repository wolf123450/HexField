use axum::{extract::State, http::StatusCode, Json};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use diesel::prelude::*;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::db;
use crate::models::NewUser;
use crate::schema::users;
use crate::state::ServerState;

const CHALLENGE_TTL: Duration = Duration::from_secs(300);

#[derive(Deserialize)]
pub struct ChallengeRequest {
    pub user_id: String,
    pub public_sign_key: String,
    pub public_dh_key: String,
    pub display_name: String,
}

#[derive(Serialize)]
pub struct ChallengeResponse { pub challenge: String }

#[derive(Deserialize)]
pub struct VerifyRequest {
    pub user_id: String,
    pub public_sign_key: String,
    pub public_dh_key: String,
    pub display_name: String,
    pub signature: String,
}

/// `token` is a signed session token (see `session.rs`). Send it as
/// `Authorization: Bearer <token>` and as the `token` query value on `/ws`.
#[derive(Serialize)]
pub struct VerifyResponse { pub token: String }

pub async fn challenge(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<ChallengeRequest>,
) -> Json<ChallengeResponse> {
    let nonce = Uuid::new_v4().to_string();
    {
        let mut challenges = state.challenges.write().await;
        challenges.retain(|_, (_, created)| created.elapsed() < CHALLENGE_TTL);
        challenges.insert(req.user_id.clone(), (nonce.clone(), Instant::now()));
    }
    Json(ChallengeResponse { challenge: nonce })
}

pub async fn verify(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<VerifyRequest>,
) -> Result<Json<VerifyResponse>, StatusCode> {
    // Pop challenge
    let nonce = {
        let mut challenges = state.challenges.write().await;
        match challenges.remove(&req.user_id) {
            Some((nonce, created)) if created.elapsed() < CHALLENGE_TTL => nonce,
            _ => return Err(StatusCode::UNAUTHORIZED),
        }
    };

    // Verify Ed25519 signature
    let key_bytes = URL_SAFE_NO_PAD.decode(&req.public_sign_key).map_err(|_| StatusCode::BAD_REQUEST)?;
    let key_arr: [u8; 32] = key_bytes.try_into().map_err(|_| StatusCode::BAD_REQUEST)?;
    let verifying_key = VerifyingKey::from_bytes(&key_arr).map_err(|_| StatusCode::BAD_REQUEST)?;
    let sig_bytes = URL_SAFE_NO_PAD.decode(&req.signature).map_err(|_| StatusCode::BAD_REQUEST)?;
    let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| StatusCode::BAD_REQUEST)?;
    let signature = Signature::from_bytes(&sig_arr);
    verifying_key.verify(nonce.as_bytes(), &signature).map_err(|_| StatusCode::UNAUTHORIZED)?;

    // Upsert user via Diesel
    {
        let conn = &mut *state.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let now = db::now_iso();

        // Pin the user ID to the first key that authenticated for it. Without
        // this, anyone could sign a challenge for someone else's user ID with
        // their own key and take over that ID.
        let existing_key: Option<String> = users::table
            .find(&req.user_id)
            .select(users::public_sign_key)
            .first(conn)
            .optional()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if let Some(key) = existing_key {
            if key != req.public_sign_key {
                tracing::warn!("auth: key mismatch for existing user {}", req.user_id);
                return Err(StatusCode::UNAUTHORIZED);
            }
        }

        diesel::insert_into(users::table)
            .values(&NewUser {
                user_id: &req.user_id,
                display_name: &req.display_name,
                public_sign_key: &req.public_sign_key,
                public_dh_key: &req.public_dh_key,
            })
            .on_conflict(users::user_id)
            .do_update()
            .set((
                users::display_name.eq(&req.display_name),
                users::public_sign_key.eq(&req.public_sign_key),
                users::public_dh_key.eq(&req.public_dh_key),
                users::last_seen_at.eq(&now),
                users::updated_at.eq(&now),
            ))
            .execute(conn)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }

    Ok(Json(VerifyResponse { token: state.issue_session_token(&req.user_id) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::middleware::optional_user;
    use axum::http::HeaderMap;
    use clap::Parser;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_state() -> Arc<ServerState> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config = Config::parse_from([
            "hexfield-server", "--db-path", ":memory:",
            "--session-secret", "0123456789abcdef0123456789abcdef",
        ]);
        Arc::new(ServerState::new(&config))
    }

    /// Run challenge + verify for `user_id`, advertising `key` and signing with `signer`.
    async fn login_with(
        state: &Arc<ServerState>, user_id: &str, key: &SigningKey, signer: &SigningKey,
    ) -> Result<String, StatusCode> {
        let pk = URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes());
        let Json(ch) = challenge(State(state.clone()), Json(ChallengeRequest {
            user_id: user_id.into(), public_sign_key: pk.clone(),
            public_dh_key: "dh".into(), display_name: "name".into(),
        })).await;
        let signature = URL_SAFE_NO_PAD.encode(signer.sign(ch.challenge.as_bytes()).to_bytes());
        let Json(resp) = verify(State(state.clone()), Json(VerifyRequest {
            user_id: user_id.into(), public_sign_key: pk,
            public_dh_key: "dh".into(), display_name: "name".into(), signature,
        })).await?;
        Ok(resp.token)
    }

    async fn login(state: &Arc<ServerState>, user_id: &str, key: &SigningKey) -> Result<String, StatusCode> {
        login_with(state, user_id, key, key).await
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("authorization", format!("Bearer {token}").parse().unwrap());
        h
    }

    #[tokio::test]
    async fn verify_issues_a_session_token_not_the_user_id() {
        let state = test_state();
        let token = login(&state, "alice", &SigningKey::from_bytes(&[1; 32])).await.unwrap();
        assert_ne!(token, "alice");
        assert_eq!(state.verify_session_token(&token).as_deref(), Some("alice"));
        assert_eq!(optional_user(&state, &bearer(&token)).as_deref(), Some("alice"));
    }

    #[tokio::test]
    async fn bare_user_id_is_not_a_valid_bearer() {
        let state = test_state();
        login(&state, "alice", &SigningKey::from_bytes(&[1; 32])).await.unwrap();
        assert_eq!(optional_user(&state, &bearer("alice")), None);
        assert_eq!(optional_user(&state, &HeaderMap::new()), None);
    }

    #[tokio::test]
    async fn same_key_can_log_in_again() {
        let state = test_state();
        let key = SigningKey::from_bytes(&[1; 32]);
        login(&state, "alice", &key).await.unwrap();
        assert!(login(&state, "alice", &key).await.is_ok());
    }

    #[tokio::test]
    async fn different_key_cannot_take_over_existing_user_id() {
        let state = test_state();
        login(&state, "alice", &SigningKey::from_bytes(&[1; 32])).await.unwrap();
        let err = login(&state, "alice", &SigningKey::from_bytes(&[2; 32])).await.unwrap_err();
        assert_eq!(err, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn signature_from_wrong_key_is_rejected() {
        let state = test_state();
        let key = SigningKey::from_bytes(&[1; 32]);
        let err = login_with(&state, "bob", &key, &SigningKey::from_bytes(&[2; 32])).await.unwrap_err();
        assert_eq!(err, StatusCode::UNAUTHORIZED);
    }
}
