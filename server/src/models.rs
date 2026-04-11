use diesel::prelude::*;
use serde::Serialize;
use crate::schema::*;

// ───── Users ─────

#[derive(Queryable, Selectable, Serialize, Debug, Clone)]
#[diesel(table_name = users)]
pub struct User {
    pub user_id: String,
    pub display_name: String,
    pub public_sign_key: String,
    pub public_dh_key: String,
    pub avatar_hash: Option<String>,
    pub bio: String,
    pub discoverability: String,
    pub last_seen_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable)]
#[diesel(table_name = users)]
pub struct NewUser<'a> {
    pub user_id: &'a str,
    pub display_name: &'a str,
    pub public_sign_key: &'a str,
    pub public_dh_key: &'a str,
}

#[derive(AsChangeset, Default)]
#[diesel(table_name = users)]
pub struct UserUpdate {
    pub display_name: Option<String>,
    pub avatar_hash: Option<Option<String>>,
    pub bio: Option<String>,
    pub discoverability: Option<String>,
    pub last_seen_at: Option<Option<String>>,
    pub updated_at: Option<String>,
}

// ───── Servers ─────

#[derive(Queryable, Selectable, Serialize, Debug, Clone)]
#[diesel(table_name = servers)]
pub struct Server {
    pub server_id: String,
    pub name: String,
    pub description: String,
    pub icon_hash: Option<String>,
    pub owner_id: String,
    pub visibility: String,
    pub member_count: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable)]
#[diesel(table_name = servers)]
pub struct NewServer<'a> {
    pub server_id: &'a str,
    pub name: &'a str,
    pub description: &'a str,
    pub icon_hash: Option<&'a str>,
    pub owner_id: &'a str,
    pub visibility: &'a str,
    pub member_count: i32,
}

#[derive(AsChangeset, Default)]
#[diesel(table_name = servers)]
pub struct ServerUpdate {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon_hash: Option<Option<String>>,
    pub visibility: Option<String>,
    pub updated_at: Option<String>,
}

// ───── Server Members ─────

#[derive(Queryable, Selectable, Serialize, Debug, Clone)]
#[diesel(table_name = server_members)]
pub struct ServerMember {
    pub server_id: String,
    pub user_id: String,
    pub role: String,
    pub joined_at: String,
}

#[derive(Insertable)]
#[diesel(table_name = server_members)]
pub struct NewServerMember<'a> {
    pub server_id: &'a str,
    pub user_id: &'a str,
    pub role: &'a str,
}

// ───── Invites ─────

#[derive(Queryable, Selectable, Serialize, Debug, Clone)]
#[diesel(table_name = invites)]
pub struct Invite {
    pub code: String,
    pub server_id: String,
    pub server_name: String,
    pub creator_id: String,
    pub endpoints: String,
    pub max_uses: Option<i32>,
    pub use_count: i32,
    pub expires_at: Option<String>,
    pub created_at: String,
}

#[derive(Insertable)]
#[diesel(table_name = invites)]
pub struct NewInvite<'a> {
    pub code: &'a str,
    pub server_id: &'a str,
    pub server_name: &'a str,
    pub creator_id: &'a str,
    pub endpoints: &'a str,
    pub max_uses: Option<i32>,
    pub expires_at: Option<&'a str>,
}

// ───── Rate Limit Bans ─────

#[derive(Queryable, Selectable, Debug)]
#[diesel(table_name = rate_limit_bans)]
pub struct RateLimitBan {
    pub ip_addr: String,
    pub reason: Option<String>,
    pub banned_at: String,
    pub expires_at: Option<String>,
}
