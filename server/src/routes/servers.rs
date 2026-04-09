use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::db;
use crate::models::{Server, ServerMember, NewServer, NewServerMember, ServerUpdate, User};
use crate::schema::{servers, server_members, users};
use crate::middleware::extract_user_id;
use crate::state::ServerState;

#[derive(Serialize)]
pub struct ServerInfo {
    pub server_id: String,
    pub name: String,
    pub description: String,
    pub icon_hash: Option<String>,
    pub owner_id: String,
    pub visibility: String,
    pub member_count: i32,
    pub created_at: String,
}

impl From<Server> for ServerInfo {
    fn from(s: Server) -> Self {
        ServerInfo {
            server_id: s.server_id, name: s.name, description: s.description,
            icon_hash: s.icon_hash, owner_id: s.owner_id, visibility: s.visibility,
            member_count: s.member_count, created_at: s.created_at,
        }
    }
}

#[derive(Deserialize)]
pub struct RegisterServerReq {
    pub server_id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon_hash: Option<String>,
    pub visibility: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateServerReq {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon_hash: Option<String>,
    pub visibility: Option<String>,
}

#[derive(Deserialize)]
pub struct DiscoverQuery {
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Serialize)]
pub struct MemberInfo {
    pub user_id: String,
    pub display_name: String,
    pub role: String,
    pub joined_at: String,
}

/// POST /servers
pub async fn register_server(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(req): Json<RegisterServerReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    let owner_id = extract_user_id(&headers).ok_or((StatusCode::UNAUTHORIZED, String::new()))?;
    let vis = req.visibility.unwrap_or_else(|| "unlisted".into());
    if !["public", "unlisted", "secret"].contains(&vis.as_str()) {
        return Err((StatusCode::BAD_REQUEST, "visibility must be 'public', 'unlisted', or 'secret'".into()));
    }

    let conn = &mut *state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let now = db::now_iso();

    diesel::insert_into(servers::table)
        .values(&NewServer {
            server_id: &req.server_id, name: &req.name,
            description: req.description.as_deref().unwrap_or(""),
            icon_hash: req.icon_hash.as_deref(),
            owner_id: &owner_id, visibility: &vis, member_count: 1,
        })
        .on_conflict(servers::server_id)
        .do_update()
        .set((
            servers::name.eq(&req.name),
            servers::description.eq(req.description.as_deref().unwrap_or("")),
            servers::icon_hash.eq(&req.icon_hash),
            servers::visibility.eq(&vis),
            servers::updated_at.eq(&now),
        ))
        .execute(conn)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Ensure owner in members
    diesel::insert_or_ignore_into(server_members::table)
        .values(&NewServerMember { server_id: &req.server_id, user_id: &owner_id, role: "owner" })
        .execute(conn)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::CREATED)
}

/// PUT /servers/:server_id — owner/admin only
pub async fn update_server(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Json(body): Json<UpdateServerReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    let uid = extract_user_id(&headers).ok_or((StatusCode::UNAUTHORIZED, String::new()))?;
    let conn = &mut *state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Check role
    let role: String = server_members::table
        .filter(server_members::server_id.eq(&server_id))
        .filter(server_members::user_id.eq(&uid))
        .select(server_members::role)
        .first(conn)
        .map_err(|_| (StatusCode::FORBIDDEN, "Not a member".into()))?;

    if role != "owner" && role != "admin" {
        return Err((StatusCode::FORBIDDEN, "Only owners/admins can update".into()));
    }

    if let Some(ref v) = body.visibility {
        if !["public", "unlisted", "secret"].contains(&v.as_str()) {
            return Err((StatusCode::BAD_REQUEST, "Invalid visibility".into()));
        }
    }

    let changeset = ServerUpdate {
        name: body.name, description: body.description,
        icon_hash: body.icon_hash.map(Some),
        visibility: body.visibility,
        updated_at: Some(db::now_iso()),
    };

    diesel::update(servers::table.find(&server_id))
        .set(&changeset)
        .execute(conn)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /servers/:server_id (respects visibility)
pub async fn get_server(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Result<Json<ServerInfo>, StatusCode> {
    let requester = extract_user_id(&headers);
    let conn = &mut *state.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let srv = servers::table
        .find(&server_id)
        .select(Server::as_select())
        .first(conn)
        .optional()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    if srv.visibility == "secret" {
        let is_member = requester.as_ref().map_or(false, |uid| {
            server_members::table
                .filter(server_members::server_id.eq(&server_id))
                .filter(server_members::user_id.eq(uid))
                .count()
                .get_result::<i64>(conn)
                .unwrap_or(0) > 0
        });
        if !is_member { return Err(StatusCode::NOT_FOUND); }
    }

    Ok(Json(srv.into()))
}

/// GET /servers?q=...&limit=20&offset=0 (only public)
pub async fn discover_servers(
    State(state): State<Arc<ServerState>>,
    Query(params): Query<DiscoverQuery>,
) -> Result<Json<Vec<ServerInfo>>, StatusCode> {
    let limit = params.limit.unwrap_or(20).min(100);
    let offset = params.offset.unwrap_or(0);
    let conn = &mut *state.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut query = servers::table
        .filter(servers::visibility.eq("public"))
        .into_boxed();

    if let Some(ref q) = params.q {
        if !q.is_empty() {
            let pat = format!("%{}%", q);
            query = query.filter(
                servers::name.like(pat.clone()).or(servers::description.like(pat))
            );
        }
    }

    let results = query
        .order(servers::member_count.desc())
        .limit(limit)
        .offset(offset)
        .select(Server::as_select())
        .load(conn)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(results.into_iter().map(ServerInfo::from).collect()))
}

/// GET /servers/:server_id/members (members only)
pub async fn get_members(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Result<Json<Vec<MemberInfo>>, StatusCode> {
    let uid = extract_user_id(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let conn = &mut *state.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Verify requester is member
    let count: i64 = server_members::table
        .filter(server_members::server_id.eq(&server_id))
        .filter(server_members::user_id.eq(&uid))
        .count()
        .get_result(conn)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if count == 0 { return Err(StatusCode::FORBIDDEN); }

    // Join server_members + users
    let rows: Vec<(ServerMember, User)> = server_members::table
        .inner_join(users::table.on(users::user_id.eq(server_members::user_id)))
        .filter(server_members::server_id.eq(&server_id))
        .order(server_members::joined_at.asc())
        .select((ServerMember::as_select(), User::as_select()))
        .load(conn)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let members = rows.into_iter().map(|(sm, u)| MemberInfo {
        user_id: sm.user_id, display_name: u.display_name,
        role: sm.role, joined_at: sm.joined_at,
    }).collect();

    Ok(Json(members))
}
