use axum::{extract::State, http::StatusCode, Json};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use diesel::prelude::*;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::db;
use crate::models::NewUser;
use crate::schema::users;
use crate::state::ServerState;

/// Challenge lifetime in seconds.
const CHALLENGE_TTL_SECS: u64 = 300;

#[derive(Deserialize)]
pub struct ChallengeRequest {
    pub user_id: String,
    pub public_sign_key: String,
    pub public_dh_key: String,
    pub display_name: String,
}

/// `challenge` is an opaque, server-signed string bound to the requested
/// user ID (see `session.rs`). Sign its UTF-8 bytes and send it back
/// unchanged in `VerifyRequest::challenge`.
#[derive(Serialize)]
pub struct ChallengeResponse { pub challenge: String }

#[derive(Deserialize)]
pub struct VerifyRequest {
    pub user_id: String,
    pub public_sign_key: String,
    pub public_dh_key: String,
    pub display_name: String,
    pub signature: String,
    /// The challenge string from `/auth/challenge`, echoed back. Required:
    /// the server keeps no per-user challenge state.
    #[serde(default)]
    pub challenge: String,
}

/// `token` is a signed session token (see `session.rs`). Send it as
/// `Authorization: Bearer <token>`, on REST routes and on the `/ws` upgrade.
/// `expires_at` is the token's expiry in unix seconds.
#[derive(Serialize)]
pub struct VerifyResponse { pub token: String, pub expires_at: u64 }

pub async fn challenge(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<ChallengeRequest>,
) -> Json<ChallengeResponse> {
    // Stateless: requesting a challenge for someone else's user ID cannot
    // replace or invalidate theirs.
    Json(ChallengeResponse { challenge: state.issue_challenge(&req.user_id, CHALLENGE_TTL_SECS) })
}

pub async fn verify(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<VerifyRequest>,
) -> Result<Json<VerifyResponse>, StatusCode> {
    // The challenge must be ours, unexpired, unused and issued for this user ID.
    let challenge = state.check_challenge(&req.challenge, &req.user_id).ok_or(StatusCode::UNAUTHORIZED)?;

    // Verify Ed25519 signature
    let key_bytes = URL_SAFE_NO_PAD.decode(&req.public_sign_key).map_err(|_| StatusCode::BAD_REQUEST)?;
    let key_arr: [u8; 32] = key_bytes.try_into().map_err(|_| StatusCode::BAD_REQUEST)?;
    let verifying_key = VerifyingKey::from_bytes(&key_arr).map_err(|_| StatusCode::BAD_REQUEST)?;
    let sig_bytes = URL_SAFE_NO_PAD.decode(&req.signature).map_err(|_| StatusCode::BAD_REQUEST)?;
    let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| StatusCode::BAD_REQUEST)?;
    let signature = Signature::from_bytes(&sig_arr);
    verifying_key.verify(req.challenge.as_bytes(), &signature).map_err(|_| StatusCode::UNAUTHORIZED)?;
    // Single use: a replayed verify request with the same challenge fails.
    if !state.consume_challenge(&challenge) {
        return Err(StatusCode::UNAUTHORIZED);
    }

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

    let (token, expires_at) = state.issue_session_token(&req.user_id);
    Ok(Json(VerifyResponse { token, expires_at }))
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

    async fn get_challenge(state: &Arc<ServerState>, user_id: &str) -> String {
        let Json(ch) = challenge(State(state.clone()), Json(ChallengeRequest {
            user_id: user_id.into(), public_sign_key: "pk".into(),
            public_dh_key: "dh".into(), display_name: "name".into(),
        })).await;
        ch.challenge
    }

    /// Sign `challenge` with `signer` and call verify for `user_id`, advertising `key`.
    async fn verify_with(
        state: &Arc<ServerState>, user_id: &str, key: &SigningKey, signer: &SigningKey, challenge: &str,
    ) -> Result<String, StatusCode> {
        let pk = URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes());
        let signature = URL_SAFE_NO_PAD.encode(signer.sign(challenge.as_bytes()).to_bytes());
        let Json(resp) = verify(State(state.clone()), Json(VerifyRequest {
            user_id: user_id.into(), public_sign_key: pk,
            public_dh_key: "dh".into(), display_name: "name".into(), signature,
            challenge: challenge.into(),
        })).await?;
        Ok(resp.token)
    }

    /// Run challenge + verify for `user_id`, advertising `key` and signing with `signer`.
    async fn login_with(
        state: &Arc<ServerState>, user_id: &str, key: &SigningKey, signer: &SigningKey,
    ) -> Result<String, StatusCode> {
        let ch = get_challenge(state, user_id).await;
        verify_with(state, user_id, key, signer, &ch).await
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

    #[tokio::test]
    async fn third_party_challenge_request_does_not_invalidate_pending_one() {
        let state = test_state();
        let key = SigningKey::from_bytes(&[1; 32]);
        let mine = get_challenge(&state, "alice").await;
        // Mallory asks for challenges for alice's user ID in the meantime.
        for _ in 0..20 {
            get_challenge(&state, "alice").await;
        }
        assert!(verify_with(&state, "alice", &key, &key, &mine).await.is_ok());
    }

    #[tokio::test]
    async fn challenge_is_single_use() {
        let state = test_state();
        let key = SigningKey::from_bytes(&[1; 32]);
        let ch = get_challenge(&state, "alice").await;
        assert!(verify_with(&state, "alice", &key, &key, &ch).await.is_ok());
        let err = verify_with(&state, "alice", &key, &key, &ch).await.unwrap_err();
        assert_eq!(err, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn challenge_is_bound_to_its_user_id() {
        let state = test_state();
        let key = SigningKey::from_bytes(&[1; 32]);
        let for_bob = get_challenge(&state, "bob").await;
        let err = verify_with(&state, "alice", &key, &key, &for_bob).await.unwrap_err();
        assert_eq!(err, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn missing_or_forged_challenge_is_rejected() {
        let state = test_state();
        let key = SigningKey::from_bytes(&[1; 32]);
        // Old clients sent no challenge.
        assert_eq!(verify_with(&state, "alice", &key, &key, "").await.unwrap_err(), StatusCode::UNAUTHORIZED);
        // A session token is not a challenge.
        let (token, _) = state.issue_session_token("alice");
        assert_eq!(verify_with(&state, "alice", &key, &key, &token).await.unwrap_err(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn failed_signature_does_not_consume_challenge() {
        let state = test_state();
        let key = SigningKey::from_bytes(&[1; 32]);
        let ch = get_challenge(&state, "alice").await;
        let bad = verify_with(&state, "alice", &key, &SigningKey::from_bytes(&[2; 32]), &ch).await;
        assert_eq!(bad.unwrap_err(), StatusCode::UNAUTHORIZED);
        assert!(verify_with(&state, "alice", &key, &key, &ch).await.is_ok());
    }

    #[tokio::test]
    async fn challenge_is_not_a_session_token() {
        let state = test_state();
        let ch = get_challenge(&state, "alice").await;
        assert_eq!(state.verify_session_token(&ch), None);
        assert_eq!(optional_user(&state, &bearer(&ch)), None);
    }
}
