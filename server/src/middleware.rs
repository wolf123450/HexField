use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::sync::Arc;

use crate::state::ServerState;

pub fn extract_user_id(headers: &HeaderMap) -> Option<String> {
    headers.get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

pub async fn require_auth(
    State(_state): State<Arc<ServerState>>,
    request: Request,
    next: Next,
) -> Response {
    match extract_user_id(request.headers()) {
        Some(_) => next.run(request).await,
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}
