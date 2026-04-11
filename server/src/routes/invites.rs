use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::models::{Invite, NewInvite};
use crate::schema::{invites, server_members};
use crate::middleware::extract_user_id;
use crate::state::ServerState;

#[derive(Deserialize)]
pub struct RegisterInviteReq {
    pub code: String,
    pub server_id: String,
    pub server_name: String,
    #[serde(default)]
    pub endpoints: String,
    pub max_uses: Option<i32>,
    pub expires_at: Option<String>,
}

#[derive(Serialize)]
pub struct InviteInfo {
    pub code: String,
    pub server_id: String,
    pub server_name: String,
    pub creator_id: String,
    pub endpoints: serde_json::Value,
}

/// POST /invites — register invite code (admin/owner required if server is registered)
pub async fn register_invite(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(req): Json<RegisterInviteReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    let creator_id = extract_user_id(&headers).ok_or((StatusCode::UNAUTHORIZED, String::new()))?;
    let conn = &mut *state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Check role if server is registered
    let role: Option<String> = server_members::table
        .filter(server_members::server_id.eq(&req.server_id))
        .filter(server_members::user_id.eq(&creator_id))
        .select(server_members::role)
        .first(conn)
        .optional()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(ref r) = role {
        if r != "owner" && r != "admin" {
            return Err((StatusCode::FORBIDDEN, "Only owners/admins can register invites".into()));
        }
    }

    diesel::replace_into(invites::table)
        .values(&NewInvite {
            code: &req.code,
            server_id: &req.server_id,
            server_name: &req.server_name,
            creator_id: &creator_id,
            endpoints: &req.endpoints,
            max_uses: req.max_uses,
            expires_at: req.expires_at.as_deref(),
        })
        .execute(conn)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::CREATED)
}

/// GET /invites/:code — resolve invite (no auth required)
pub async fn resolve_invite(
    State(state): State<Arc<ServerState>>,
    Path(code): Path<String>,
) -> Result<Json<InviteInfo>, (StatusCode, String)> {
    let conn = &mut *state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let invite = invites::table
        .find(&code)
        .select(Invite::as_select())
        .first(conn)
        .optional()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Invite code not found".into()))?;

    // Check expiry
    if let Some(ref exp) = invite.expires_at {
        let now = chrono::Utc::now().to_rfc3339();
        if now > *exp {
            return Err((StatusCode::GONE, "Invite code has expired".into()));
        }
    }

    // Check max uses
    if let Some(max) = invite.max_uses {
        if invite.use_count >= max {
            return Err((StatusCode::GONE, "Invite code has reached max uses".into()));
        }
    }

    // Increment use count
    diesel::update(invites::table.find(&code))
        .set(invites::use_count.eq(invites::use_count + 1))
        .execute(conn)
        .ok();

    let endpoints: serde_json::Value = serde_json::from_str(&invite.endpoints)
        .unwrap_or(serde_json::Value::Array(vec![]));

    Ok(Json(InviteInfo {
        code, server_id: invite.server_id, server_name: invite.server_name,
        creator_id: invite.creator_id, endpoints,
    }))
}
