use axum::{
    extract::FromRequestParts,
    http::{request::Parts, HeaderMap, StatusCode},
};
use std::sync::Arc;

use crate::state::ServerState;

pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers.get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
}

/// The caller's user ID if the request carries a valid session token.
/// For routes where auth is optional (it only widens what the caller can see).
pub fn optional_user(state: &ServerState, headers: &HeaderMap) -> Option<String> {
    bearer_token(headers).and_then(|t| state.verify_session_token(t))
}

/// Extractor for routes that require `Authorization: Bearer <session token>`.
/// Rejects with 401 when the token is missing, forged or expired. Must come
/// before any body extractor (`Json`) in the handler signature.
pub struct AuthUser(pub String);

impl FromRequestParts<Arc<ServerState>> for AuthUser {
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, state: &Arc<ServerState>) -> Result<Self, Self::Rejection> {
        optional_user(state, &parts.headers)
            .map(AuthUser)
            .ok_or(StatusCode::UNAUTHORIZED)
    }
}
