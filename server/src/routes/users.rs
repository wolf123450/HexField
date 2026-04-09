use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::db;
use crate::models::{User, UserUpdate};
use crate::schema::{users, server_members};
use crate::middleware::extract_user_id;
use crate::state::ServerState;

/// Public-facing user profile (subset of User, excludes internal fields).
#[derive(Serialize)]
pub struct UserProfile {
    pub user_id: String,
    pub display_name: String,
    pub public_sign_key: String,
    pub public_dh_key: String,
    pub avatar_hash: Option<String>,
    pub bio: String,
    pub last_seen_at: Option<String>,
}

impl From<User> for UserProfile {
    fn from(u: User) -> Self {
        UserProfile {
            user_id: u.user_id,
            display_name: u.display_name,
            public_sign_key: u.public_sign_key,
            public_dh_key: u.public_dh_key,
            avatar_hash: u.avatar_hash,
            bio: u.bio,
            last_seen_at: u.last_seen_at,
        }
    }
}

#[derive(Deserialize)]
pub struct UpdateProfileReq {
    pub display_name: Option<String>,
    pub avatar_hash: Option<String>,
    pub bio: Option<String>,
    pub discoverability: Option<String>,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// GET /users/me
pub async fn get_me(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Result<Json<UserProfile>, StatusCode> {
    let uid = extract_user_id(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let conn = &mut *state.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let user = users::table
        .find(&uid)
        .select(User::as_select())
        .first(conn)
        .optional()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    Ok(Json(user.into()))
}

/// PUT /users/me
pub async fn update_me(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(body): Json<UpdateProfileReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    let uid = extract_user_id(&headers).ok_or((StatusCode::UNAUTHORIZED, String::new()))?;

    if let Some(ref d) = body.discoverability {
        if d != "public" && d != "private" {
            return Err((StatusCode::BAD_REQUEST, "discoverability must be 'public' or 'private'".into()));
        }
    }

    let changeset = UserUpdate {
        display_name: body.display_name,
        avatar_hash: body.avatar_hash.map(Some),
        bio: body.bio,
        discoverability: body.discoverability,
        updated_at: Some(db::now_iso()),
        ..Default::default()
    };

    let conn = &mut *state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    diesel::update(users::table.find(&uid))
        .set(&changeset)
        .execute(conn)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /users/:user_id — respects discoverability
pub async fn get_user(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(target_id): Path<String>,
) -> Result<Json<UserProfile>, StatusCode> {
    let requester = extract_user_id(&headers);
    let conn = &mut *state.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let user = users::table
        .find(&target_id)
        .select(User::as_select())
        .first(conn)
        .optional()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    if user.discoverability == "private" {
        let req_id = requester.ok_or(StatusCode::NOT_FOUND)?;
        // Check if requester shares a server with the target user
        let requester_servers: Vec<String> = server_members::table
            .filter(server_members::user_id.eq(&req_id))
            .select(server_members::server_id)
            .load(conn)
            .unwrap_or_default();

        let shares: i64 = server_members::table
            .filter(server_members::user_id.eq(&target_id))
            .filter(server_members::server_id.eq_any(&requester_servers))
            .count()
            .get_result(conn)
            .unwrap_or(0);

        if shares == 0 { return Err(StatusCode::NOT_FOUND); }
    }

    Ok(Json(user.into()))
}

/// GET /users?q=name&limit=20&offset=0
pub async fn search_users(
    State(state): State<Arc<ServerState>>,
    Query(params): Query<SearchQuery>,
) -> Result<Json<Vec<UserProfile>>, StatusCode> {
    let q = params.q.unwrap_or_default();
    if q.is_empty() { return Ok(Json(vec![])); }

    let limit = params.limit.unwrap_or(20).min(100);
    let offset = params.offset.unwrap_or(0);
    let pattern = format!("%{}%", q);

    let conn = &mut *state.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let results = users::table
        .filter(users::discoverability.eq("public"))
        .filter(users::display_name.like(&pattern))
        .order(users::display_name.asc())
        .limit(limit)
        .offset(offset)
        .select(User::as_select())
        .load(conn)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(results.into_iter().map(UserProfile::from).collect()))
}
