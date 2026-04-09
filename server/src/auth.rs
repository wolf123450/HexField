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

    Ok(Json(VerifyResponse { token: req.user_id }))
}
