# Rendezvous Server — Full Implementation Plan (Diesel)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `hexfield-server`, a full-featured rendezvous and signal relay server that enables HexField clients to connect across the internet, discover servers and users, resolve invite links, relay WebRTC signaling, provide TURN credentials, and broadcast presence — all while preserving privacy through admin-controlled and user-controlled visibility.

**Architecture:** Axum + tokio web server in `server/` subfolder of the monorepo. SQLite via **Diesel 2 ORM** for persistent storage (user profiles, server registry, invite codes). Diesel provides compile-time schema checking via `table!` macros, typed query builder (no raw SQL strings), and `Queryable`/`Insertable`/`AsChangeset` derive macros for model structs. In-memory state for connected WebSocket clients and presence. Ed25519 challenge-response authentication. Rate limiting via `tower-governor`. Privacy controls: servers can be `public` (listed in discovery), `unlisted` (findable by direct link only), or `secret` (join link required). Users can opt out of directory listing. TURN credentials generated via coturn's HMAC-SHA1 shared-secret scheme.

**Tech Stack:** Axum 0.8, tokio, **Diesel 2 (SQLite backend)**, tower-governor (rate limiting), ed25519-dalek, hmac/sha1 (TURN), serde_json, tracing, clap.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/Cargo.toml` | Create | Dependencies (Diesel, Axum, etc.) |
| `server/diesel.toml` | Create | Diesel CLI config (schema output path) |
| `server/src/main.rs` | Create | Entry point, router, graceful shutdown |
| `server/src/config.rs` | Create | CLI args + env vars (clap) |
| `server/src/state.rs` | Create | SharedState: Diesel SqliteConnection, clients, config |
| `server/src/schema.rs` | Create | Diesel `table!` macro definitions (generated/maintained) |
| `server/src/models.rs` | Create | Queryable, Insertable, AsChangeset structs for all tables |
| `server/src/db.rs` | Create | Connection setup, embedded migrations, helpers |
| `server/src/auth.rs` | Create | Challenge-response Ed25519 auth, JWT-like token |
| `server/src/ws.rs` | Create | WebSocket upgrade, message routing, presence |
| `server/src/routes/mod.rs` | Create | Route module barrel |
| `server/src/routes/users.rs` | Create | User registry: Diesel queries for register, get, update, search |
| `server/src/routes/servers.rs` | Create | Server registry: Diesel queries for register, update, discover |
| `server/src/routes/invites.rs` | Create | Invite code registration + resolution via Diesel |
| `server/src/routes/turn.rs` | Create | TURN credential generation |
| `server/src/middleware.rs` | Create | Auth extraction, rate limiting setup |
| `server/migrations/` | Create | Diesel migration SQL files |
| `server/Dockerfile` | Create | Multi-stage build |
| `server/README.md` | Create | Setup, config, deployment docs |
| `src/stores/networkStore.ts` | Modify | Auto-connect, auth flow, invite registration |
| `src/components/settings/SettingsPrivacyTab.vue` | Modify | Rendezvous URL + user discoverability toggles |

---

### Task 1: Initialize Server Project + Dependencies

**Files:**
- Create: `server/Cargo.toml`
- Create: `server/diesel.toml`
- Create: `server/src/main.rs` (skeleton)

- [ ] **Step 1: Create `server/Cargo.toml`**

```toml
[package]
name = "hexfield-server"
version = "0.1.0"
edition = "2021"
description = "HexField rendezvous, signal relay, and discovery server"

[dependencies]
# Web framework
axum              = { version = "0.8", features = ["ws"] }
axum-extra        = { version = "0.10", features = ["typed-header"] }
tokio             = { version = "1", features = ["rt-multi-thread", "macros", "net", "signal", "time"] }
tower             = "0.5"
tower-http        = { version = "0.6", features = ["cors"] }
tower-governor    = "0.5"
governor          = "0.8"

# WebSocket
futures-util      = "0.3"

# Serialization
serde             = { version = "1", features = ["derive"] }
serde_json        = "1"

# Auth
ed25519-dalek     = { version = "2", features = ["serde"] }
rand              = "0.8"
base64            = "0.22"

# Database — Diesel ORM with SQLite
diesel            = { version = "2", features = ["sqlite", "r2d2"] }
diesel_migrations = "2"

# TURN credential generation
hmac              = "0.12"
sha1              = "0.10"

# Logging
tracing           = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

# CLI
clap              = { version = "4", features = ["derive", "env"] }

# Misc
uuid              = { version = "1", features = ["v4", "v7"] }
chrono            = { version = "0.4", features = ["serde"] }
```

- [ ] **Step 2: Create `server/diesel.toml`**

```toml
[print_schema]
file = "src/schema.rs"
```

- [ ] **Step 3: Create `server/src/main.rs` skeleton with module stubs**

```rust
mod auth;
mod config;
mod db;
mod middleware;
mod models;
mod routes;
mod schema;
mod state;
mod ws;

use axum::{Router, routing::{get, post, put}};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "hexfield_server=info,tower_http=info".into()),
        )
        .init();

    let config = config::Config::parse_from_env();
    let shared = Arc::new(state::ServerState::new(&config));

    let rate_limit = middleware::rate_limit_layer(&config);

    let app = Router::new()
        // Health
        .route("/health", get(|| async { "ok" }))
        // Auth
        .route("/auth/challenge", post(auth::challenge))
        .route("/auth/verify", post(auth::verify))
        // Users
        .route("/users/me", get(routes::users::get_me).put(routes::users::update_me))
        .route("/users/{user_id}", get(routes::users::get_user))
        .route("/users", get(routes::users::search_users))
        // Servers
        .route("/servers", post(routes::servers::register_server).get(routes::servers::discover_servers))
        .route("/servers/{server_id}", get(routes::servers::get_server).put(routes::servers::update_server))
        .route("/servers/{server_id}/members", get(routes::servers::get_members))
        // Invites
        .route("/invites", post(routes::invites::register_invite))
        .route("/invites/{code}", get(routes::invites::resolve_invite))
        // TURN
        .route("/turn/credentials", post(routes::turn::get_credentials))
        // WebSocket
        .route("/ws", get(ws::ws_handler))
        .layer(rate_limit)
        .layer(CorsLayer::permissive())
        .with_state(shared);

    let addr = format!("{}:{}", config.host, config.port);
    tracing::info!("hexfield-server listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await.expect("Failed to bind");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("Server error");
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c().await.expect("ctrl-c listener failed");
    tracing::info!("Shutting down gracefully");
}
```

Create empty stub files so it compiles (same function signatures returning `impl IntoResponse` with a `"not implemented"` body):
- `server/src/config.rs`, `server/src/state.rs`, `server/src/db.rs`, `server/src/schema.rs`, `server/src/models.rs`
- `server/src/auth.rs`, `server/src/ws.rs`, `server/src/middleware.rs`
- `server/src/routes/mod.rs`, `server/src/routes/users.rs`, `server/src/routes/servers.rs`, `server/src/routes/invites.rs`, `server/src/routes/turn.rs`

- [ ] **Step 4: Verify it compiles**

Run: `cd server && cargo check`
Expected: Compiles with warnings.

- [ ] **Step 5: Commit**

```bash
git add server/
git commit -m "feat: initialize hexfield-server project with Axum + Diesel skeleton"
```

---

### Task 2: Diesel Schema, Models, and Migration

**Files:**
- Create: `server/migrations/00000000000000_diesel_initial_setup/up.sql`
- Create: `server/migrations/00000000000000_diesel_initial_setup/down.sql`
- Create: `server/migrations/2026-04-09-000001_create_tables/up.sql`
- Create: `server/migrations/2026-04-09-000001_create_tables/down.sql`
- Modify: `server/src/schema.rs`
- Modify: `server/src/models.rs`
- Modify: `server/src/db.rs`

- [ ] **Step 1: Create initial Diesel migration**

Create `server/migrations/00000000000000_diesel_initial_setup/up.sql`:
```sql
-- Diesel internal setup (required)
SELECT 1;
```

Create `server/migrations/00000000000000_diesel_initial_setup/down.sql`:
```sql
SELECT 1;
```

- [ ] **Step 2: Create the main schema migration**

Create `server/migrations/2026-04-09-000001_create_tables/up.sql`:

```sql
CREATE TABLE users (
    user_id          TEXT PRIMARY KEY NOT NULL,
    display_name     TEXT NOT NULL,
    public_sign_key  TEXT NOT NULL,
    public_dh_key    TEXT NOT NULL DEFAULT '',
    avatar_hash      TEXT,
    bio              TEXT NOT NULL DEFAULT '',
    discoverability  TEXT NOT NULL DEFAULT 'public',
    last_seen_at     TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE servers (
    server_id     TEXT PRIMARY KEY NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    icon_hash     TEXT,
    owner_id      TEXT NOT NULL REFERENCES users(user_id),
    visibility    TEXT NOT NULL DEFAULT 'unlisted',
    member_count  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE server_members (
    server_id    TEXT NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(user_id),
    role         TEXT NOT NULL DEFAULT 'member',
    joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, user_id)
);

CREATE TABLE invites (
    code          TEXT PRIMARY KEY NOT NULL,
    server_id     TEXT NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
    server_name   TEXT NOT NULL,
    creator_id    TEXT NOT NULL REFERENCES users(user_id),
    endpoints     TEXT NOT NULL DEFAULT '[]',
    max_uses      INTEGER,
    use_count     INTEGER NOT NULL DEFAULT 0,
    expires_at    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rate_limit_bans (
    ip_addr     TEXT PRIMARY KEY NOT NULL,
    reason      TEXT,
    banned_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT
);

-- Indexes
CREATE INDEX idx_servers_visibility ON servers(visibility);
CREATE INDEX idx_servers_owner ON servers(owner_id);
CREATE INDEX idx_server_members_user ON server_members(user_id);
CREATE INDEX idx_invites_server ON invites(server_id);
CREATE INDEX idx_users_discoverability ON users(discoverability);
```

Create `server/migrations/2026-04-09-000001_create_tables/down.sql`:
```sql
DROP TABLE IF EXISTS rate_limit_bans;
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS server_members;
DROP TABLE IF EXISTS servers;
DROP TABLE IF EXISTS users;
```

- [ ] **Step 3: Write `server/src/schema.rs`**

This file is typically generated by `diesel print-schema`, but we hand-write it since we don't have a running DB at plan time. It must match the migration SQL exactly.

```rust
diesel::table! {
    users (user_id) {
        user_id -> Text,
        display_name -> Text,
        public_sign_key -> Text,
        public_dh_key -> Text,
        avatar_hash -> Nullable<Text>,
        bio -> Text,
        discoverability -> Text,
        last_seen_at -> Nullable<Text>,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    servers (server_id) {
        server_id -> Text,
        name -> Text,
        description -> Text,
        icon_hash -> Nullable<Text>,
        owner_id -> Text,
        visibility -> Text,
        member_count -> Integer,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    server_members (server_id, user_id) {
        server_id -> Text,
        user_id -> Text,
        role -> Text,
        joined_at -> Text,
    }
}

diesel::table! {
    invites (code) {
        code -> Text,
        server_id -> Text,
        server_name -> Text,
        creator_id -> Text,
        endpoints -> Text,
        max_uses -> Nullable<Integer>,
        use_count -> Integer,
        expires_at -> Nullable<Text>,
        created_at -> Text,
    }
}

diesel::table! {
    rate_limit_bans (ip_addr) {
        ip_addr -> Text,
        reason -> Nullable<Text>,
        banned_at -> Text,
        expires_at -> Nullable<Text>,
    }
}

diesel::allow_tables_to_appear_in_same_query!(users, servers, server_members, invites, rate_limit_bans);
diesel::joinable!(servers -> users (owner_id));
diesel::joinable!(invites -> servers (server_id));
```

**Note:** `server_members` cannot use `joinable!` for both `users` and `servers` since it has two FK columns referencing different tables. Use explicit `.inner_join()` with `on()` clauses in queries instead.

- [ ] **Step 4: Write `server/src/models.rs`**

```rust
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
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
```

- [ ] **Step 5: Write `server/src/db.rs`**

```rust
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};

pub const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

/// Open (or create) a Diesel SqliteConnection, apply pending migrations.
pub fn establish_connection(database_url: &str) -> SqliteConnection {
    let mut conn = SqliteConnection::establish(database_url)
        .unwrap_or_else(|e| panic!("Error connecting to {}: {}", database_url, e));

    // Enable WAL mode and foreign keys
    diesel::sql_query("PRAGMA journal_mode=WAL")
        .execute(&mut conn)
        .expect("Failed to set WAL mode");
    diesel::sql_query("PRAGMA foreign_keys=ON")
        .execute(&mut conn)
        .expect("Failed to enable foreign keys");

    // Run pending migrations
    conn.run_pending_migrations(MIGRATIONS)
        .expect("Failed to run migrations");

    conn
}

/// Helper: current ISO-8601 timestamp for UPDATE SET updated_at
pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}
```

- [ ] **Step 6: Verify it compiles**

Run: `cd server && cargo check`
Expected: Clean compile.

- [ ] **Step 7: Commit**

```bash
git add server/
git commit -m "feat: add Diesel schema, models, migration, and DB setup"
```

---

### Task 3: Configuration + Shared Server State

**Files:**
- Modify: `server/src/config.rs`
- Modify: `server/src/state.rs`

- [ ] **Step 1: Write `server/src/config.rs`**

```rust
use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[command(name = "hexfield-server", about = "HexField rendezvous, signal relay, and discovery server")]
pub struct Config {
    #[arg(long, env = "HEXFIELD_HOST", default_value = "0.0.0.0")]
    pub host: String,
    #[arg(long, env = "HEXFIELD_PORT", default_value_t = 7700)]
    pub port: u16,
    #[arg(long, env = "HEXFIELD_DB_PATH", default_value = "hexfield-server.db")]
    pub db_path: String,
    #[arg(long, env = "HEXFIELD_TURN_URL", default_value = "")]
    pub turn_url: String,
    #[arg(long, env = "HEXFIELD_TURN_SECRET", default_value = "")]
    pub turn_secret: String,
    #[arg(long, env = "HEXFIELD_TURN_TTL", default_value_t = 86400)]
    pub turn_ttl: u64,
    #[arg(long, env = "HEXFIELD_MAX_CONNECTIONS", default_value_t = 5000)]
    pub max_connections: usize,
    #[arg(long, env = "HEXFIELD_RATE_LIMIT_RPS", default_value_t = 30)]
    pub rate_limit_rps: u32,
    #[arg(long, env = "HEXFIELD_RATE_LIMIT_BURST", default_value_t = 60)]
    pub rate_limit_burst: u32,
    #[arg(long, env = "HEXFIELD_WS_MSG_RPS", default_value_t = 50)]
    pub ws_msg_rps: u32,
}

impl Config {
    pub fn parse_from_env() -> Self { Config::parse() }
    pub fn has_turn(&self) -> bool { !self.turn_url.is_empty() && !self.turn_secret.is_empty() }
}
```

- [ ] **Step 2: Write `server/src/state.rs`** (uses Diesel's `SqliteConnection`)

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use diesel::sqlite::SqliteConnection;

use crate::config::Config;

pub type ClientTx = mpsc::UnboundedSender<String>;

pub struct ConnectedClient {
    pub user_id: String,
    pub public_sign_key: String,
    pub tx: ClientTx,
    pub msg_count: std::sync::atomic::AtomicU32,
    pub window_start: std::sync::atomic::AtomicU64,
}

pub struct ServerState {
    pub clients: RwLock<HashMap<String, Arc<ConnectedClient>>>,
    /// Diesel SqliteConnection — sync API, behind std::sync::Mutex.
    pub db: std::sync::Mutex<SqliteConnection>,
    pub config: Config,
    pub challenges: RwLock<HashMap<String, (String, std::time::Instant)>>,
}

impl ServerState {
    pub fn new(config: &Config) -> Self {
        let conn = crate::db::establish_connection(&config.db_path);
        ServerState {
            clients: RwLock::new(HashMap::new()),
            db: std::sync::Mutex::new(conn),
            config: config.clone(),
            challenges: RwLock::new(HashMap::new()),
        }
    }
}
```

- [ ] **Step 3: Verify & commit**

```bash
cd server && cargo check
git add server/src/config.rs server/src/state.rs
git commit -m "feat: add config and Diesel-backed server state"
```

---

### Task 4: Rate Limiting Middleware

**Files:**
- Modify: `server/src/middleware.rs`

- [ ] **Step 1: Write `server/src/middleware.rs`**

```rust
use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::sync::Arc;
use tower_governor::{GovernorLayer, GovernorConfigBuilder};

use crate::config::Config;
use crate::state::ServerState;

/// Per-IP rate limiting layer.
pub fn rate_limit_layer(config: &Config) -> GovernorLayer<tower_governor::key_extractor::PeerIpKeyExtractor, governor::middleware::NoOpMiddleware> {
    let governor_config = GovernorConfigBuilder::default()
        .per_second(config.rate_limit_rps.into())
        .burst_size(config.rate_limit_burst)
        .finish()
        .expect("Failed to build rate limit config");
    GovernorLayer { config: Arc::new(governor_config) }
}

/// Extract the authenticated userId from the Authorization header.
/// Format: `Bearer <userId>` (MVP — upgrade to JWT later).
pub fn extract_user_id(headers: &HeaderMap) -> Option<String> {
    headers.get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

/// Axum middleware that rejects unauthenticated requests.
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
```

**Note:** The `GovernorLayer` type signature may need adjustment based on the `tower-governor` version. Check `cargo check` and fix if needed.

- [ ] **Step 2: Verify & commit**

```bash
cd server && cargo check
git add server/src/middleware.rs
git commit -m "feat: add rate limiting middleware and auth extraction"
```

---

### Task 5: Challenge-Response Authentication (Diesel)

**Files:**
- Modify: `server/src/auth.rs`

- [ ] **Step 1: Write `server/src/auth.rs`**

```rust
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

        // Try insert first; on conflict update existing record
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
```

- [ ] **Step 2: Verify & commit**

```bash
cd server && cargo check
git add server/src/auth.rs
git commit -m "feat: add Ed25519 challenge-response auth with Diesel user upsert"
```

---

### Task 6: User Registry Routes (Diesel)

**Files:**
- Modify: `server/src/routes/users.rs`

- [ ] **Step 1: Write `server/src/routes/users.rs`**

```rust
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
        avatar_hash: body.avatar_hash.map(Some), // Option<Option<String>> for nullable
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
        // Only if requester shares a server
        let req_id = requester.ok_or(StatusCode::NOT_FOUND)?;                
        let shares: bool = diesel::dsl::select(diesel::dsl::exists(
            server_members::table
                .filter(server_members::user_id.eq(&req_id))
                .filter(server_members::server_id.eq_any(
                    server_members::table
                        .filter(server_members::user_id.eq(&target_id))
                        .select(server_members::server_id)
                ))
        ))
        .get_result(conn)
        .unwrap_or(false);

        if !shares { return Err(StatusCode::NOT_FOUND); }
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
```

- [ ] **Step 2: Verify & commit**

```bash
cd server && cargo check
git add server/src/routes/users.rs
git commit -m "feat: add user registry routes with Diesel query builder"
```

---

### Task 7: Server Registry Routes (Diesel)

**Files:**
- Modify: `server/src/routes/servers.rs`

- [ ] **Step 1: Write `server/src/routes/servers.rs`**

```rust
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
```

- [ ] **Step 2: Verify & commit**

```bash
cd server && cargo check
git add server/src/routes/servers.rs
git commit -m "feat: add server registry with Diesel query builder + visibility controls"
```

---

### Task 8: Invite Code Routes (Diesel)

**Files:**
- Modify: `server/src/routes/invites.rs`

- [ ] **Step 1: Write `server/src/routes/invites.rs`**

```rust
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::models::{Invite, NewInvite, ServerMember};
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
```

- [ ] **Step 2: Verify & commit**

```bash
cd server && cargo check
git add server/src/routes/invites.rs
git commit -m "feat: add invite routes with Diesel query builder"
```

---

### Task 9: TURN Credential Generation

**Files:**
- Modify: `server/src/routes/turn.rs`

- [ ] **Step 1: Write `server/src/routes/turn.rs`**

```rust
use axum::{extract::State, http::StatusCode, Json};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use sha1::Sha1;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::state::ServerState;

#[derive(Deserialize)]
pub struct CredentialRequest { pub user_id: String }

#[derive(Serialize)]
pub struct TurnCredentials {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
    pub ttl: u64,
}

pub async fn get_credentials(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<CredentialRequest>,
) -> Result<Json<TurnCredentials>, (StatusCode, String)> {
    if !state.config.has_turn() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "TURN not configured".into()));
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let expiry = now + state.config.turn_ttl;
    let username = format!("{}:{}", expiry, req.user_id);
    let mut mac = Hmac::<Sha1>::new_from_slice(state.config.turn_secret.as_bytes())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    mac.update(username.as_bytes());
    let credential = STANDARD.encode(mac.finalize().into_bytes());
    Ok(Json(TurnCredentials {
        urls: vec![state.config.turn_url.clone()], username, credential, ttl: state.config.turn_ttl,
    }))
}
```

- [ ] **Step 2: Verify & commit**

```bash
cd server && cargo check
git add server/src/routes/turn.rs
git commit -m "feat: add TURN credential generation"
```

---

### Task 10: WebSocket Signal Relay with Per-Client Rate Limiting

**Files:**
- Modify: `server/src/ws.rs`

- [ ] **Step 1: Write `server/src/ws.rs`**

```rust
use axum::{
    extract::{ws::{Message, WebSocket}, Query, State, WebSocketUpgrade},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

use crate::state::{ConnectedClient, ServerState};

#[derive(Deserialize)]
pub struct WsParams {
    pub token: String,
    #[serde(default)]
    pub public_sign_key: String,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsParams>,
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    let user_id = params.token.clone();
    let public_sign_key = params.public_sign_key.clone();
    ws.on_upgrade(move |socket| handle_socket(socket, user_id, public_sign_key, state))
}

async fn handle_socket(socket: WebSocket, user_id: String, public_sign_key: String, state: Arc<ServerState>) {
    let (mut ws_sink, mut ws_source) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

    let client = Arc::new(ConnectedClient {
        user_id: user_id.clone(), public_sign_key, tx: tx.clone(),
        msg_count: AtomicU32::new(0), window_start: AtomicU64::new(now_secs),
    });

    // Connection limit check
    { let c = state.clients.read().await;
      if c.len() >= state.config.max_connections {
          tracing::warn!("Connection limit reached, rejecting {}", user_id);
          let _ = ws_sink.send(Message::Close(None)).await; return;
      }
    }

    { let mut c = state.clients.write().await; c.insert(user_id.clone(), client.clone()); }
    tracing::info!("WS connected: {}", user_id);
    broadcast_presence(&state, &user_id, "online").await;

    let uid_send = user_id.clone();
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sink.send(Message::Text(msg.into())).await.is_err() { break; }
        }
        let _ = ws_sink.close().await;
    });

    let ws_msg_rps = state.config.ws_msg_rps;
    while let Some(msg) = ws_source.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if !check_ws_rate_limit(&client, ws_msg_rps) { continue; }
                let text_str: &str = &text;
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(text_str) {
                    route_message(&state, &user_id, payload).await;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    { let mut c = state.clients.write().await; c.remove(&user_id); }
    broadcast_presence(&state, &user_id, "offline").await;
    tracing::info!("WS disconnected: {}", user_id);
    send_task.abort();
}

fn check_ws_rate_limit(client: &ConnectedClient, max_rps: u32) -> bool {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let window = client.window_start.load(Ordering::Relaxed);
    if now > window {
        client.window_start.store(now, Ordering::Relaxed);
        client.msg_count.store(1, Ordering::Relaxed);
        true
    } else {
        client.msg_count.fetch_add(1, Ordering::Relaxed) < max_rps
    }
}

async fn route_message(state: &ServerState, from: &str, mut payload: serde_json::Value) {
    payload["from"] = serde_json::Value::String(from.to_string());
    match payload.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "signal_offer" | "signal_answer" | "signal_ice" => {
            if let Some(to) = payload.get("to").and_then(|v| v.as_str()) {
                send_to_client(state, to, &payload).await;
            }
        }
        "presence_update" | "typing_start" | "typing_stop" => {
            broadcast_except(state, from, &payload).await;
        }
        "ping" => { send_to_client(state, from, &serde_json::json!({"type":"pong"})).await; }
        _ => { tracing::debug!("Unknown WS msg type from {}", from); }
    }
}

async fn send_to_client(state: &ServerState, user_id: &str, payload: &serde_json::Value) {
    let clients = state.clients.read().await;
    if let Some(c) = clients.get(user_id) {
        let _ = c.tx.send(serde_json::to_string(payload).unwrap_or_default());
    }
}

async fn broadcast_except(state: &ServerState, except: &str, payload: &serde_json::Value) {
    let text = serde_json::to_string(payload).unwrap_or_default();
    let clients = state.clients.read().await;
    for (uid, c) in clients.iter() {
        if uid != except { let _ = c.tx.send(text.clone()); }
    }
}

async fn broadcast_presence(state: &ServerState, user_id: &str, status: &str) {
    broadcast_except(state, user_id, &serde_json::json!({"type":"presence_update","from":user_id,"status":status})).await;
}
```

- [ ] **Step 2: Write `server/src/routes/mod.rs`**

```rust
pub mod invites;
pub mod servers;
pub mod turn;
pub mod users;
```

- [ ] **Step 3: Verify & commit**

```bash
cd server && cargo check
git add server/src/ws.rs server/src/routes/mod.rs
git commit -m "feat: add WebSocket signal relay with per-client rate limiting"
```

---

### Task 11: Dockerfile + README

**Files:**
- Create: `server/Dockerfile`
- Create: `server/README.md`

- [ ] **Step 1: Write `server/Dockerfile`**

```dockerfile
FROM rust:1.82-slim AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src/ src/
COPY migrations/ migrations/
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/hexfield-server /usr/local/bin/
EXPOSE 7700
ENV HEXFIELD_HOST=0.0.0.0
ENV HEXFIELD_PORT=7700
ENTRYPOINT ["hexfield-server"]
```

**Note:** The `migrations/` directory must be copied into the build context because `diesel_migrations::embed_migrations!()` embeds them at compile time.

- [ ] **Step 2: Write `server/README.md`**

Write a comprehensive README covering: features, privacy controls (server visibility table: public/unlisted/secret; user discoverability table: public/private), quick start, configuration table (all env vars + CLI flags + defaults), Docker instructions, API reference (all endpoints), WebSocket protocol. Refer to the previous plan's README section for the exact content — it is unchanged.

- [ ] **Step 3: Commit**

```bash
git add server/Dockerfile server/README.md
git commit -m "docs: add Dockerfile and README for hexfield-server"
```

---

### Task 12: Client-Side — Auto-Connect + Auth Flow

**Files:**
- Modify: `src/stores/networkStore.ts`

- [ ] **Step 1: Add rendezvous authentication and auto-connect**

In `networkStore.ts`, after the LAN start + UPnP block in `init()`, add:

```typescript
// Auto-connect to rendezvous server if configured
try {
  const { useSettingsStore } = await import('./settingsStore')
  const settingsStore = useSettingsStore()
  const rendezvousUrl = settingsStore.rendezvousServerUrl
  if (rendezvousUrl) {
    // Challenge-response auth
    const challengeResp = await fetch(`${rendezvousUrl}/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: localUserId,
        public_sign_key: identityStore.publicSignKey ?? '',
        public_dh_key: identityStore.publicDHKey ?? '',
        display_name: identityStore.displayName,
      }),
    })
    if (!challengeResp.ok) throw new Error('Challenge failed')
    const { challenge } = await challengeResp.json()

    const { default: cryptoService } = await import('../services/cryptoService')
    const signature = await cryptoService.signMessage(challenge)

    const verifyResp = await fetch(`${rendezvousUrl}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: localUserId,
        public_sign_key: identityStore.publicSignKey ?? '',
        public_dh_key: identityStore.publicDHKey ?? '',
        display_name: identityStore.displayName,
        signature,
      }),
    })
    if (!verifyResp.ok) throw new Error('Auth verify failed')
    const { token } = await verifyResp.json()

    // Connect WebSocket
    const wsScheme = rendezvousUrl.startsWith('https') ? 'wss' : 'ws'
    const wsBase = rendezvousUrl.replace(/^https?/, wsScheme)
    const wsUrl = `${wsBase}/ws?token=${encodeURIComponent(token)}&public_sign_key=${encodeURIComponent(identityStore.publicSignKey ?? '')}`
    await invoke('signal_connect', { url: wsUrl })
    _rendezvousToken = token
    console.log('[network] Connected to rendezvous server')

    // Fetch TURN credentials
    try {
      const turnResp = await fetch(`${rendezvousUrl}/turn/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: localUserId }),
      })
      if (turnResp.ok) {
        _turnCredentials = await turnResp.json()
        console.log('[network] TURN credentials obtained')
      }
    } catch (e) { console.warn('[network] TURN fetch failed:', e) }
  }
} catch (e) { console.warn('[network] Rendezvous connection failed:', e) }
```

Add module-level:
```typescript
let _rendezvousToken: string | null = null
let _turnCredentials: { urls: string[]; username: string; credential: string } | null = null
export function getTurnCredentials() { return _turnCredentials }
```

- [ ] **Step 2: Wire TURN credentials into ICE config**

In the ICE server config builder, add:
```typescript
const turn = getTurnCredentials()
if (turn) { iceServers.push({ urls: turn.urls, username: turn.username, credential: turn.credential }) }
```

- [ ] **Step 3: Verify frontend compiles** (`npm run build`) **& commit**

---

### Task 13: Client-Side — Register Invites on Rendezvous

**Files:**
- Modify: `src/components/modals/InviteModal.vue`

- [ ] **Step 1:** After generating an invite in `generateNewLink()`, POST it to the rendezvous server:

```typescript
try {
  const { useSettingsStore } = await import('@/stores/settingsStore')
  const settingsStore = useSettingsStore()
  if (settingsStore.rendezvousServerUrl && inviteToken.value) {
    await fetch(`${settingsStore.rendezvousServerUrl}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${identityStore.userId}` },
      body: JSON.stringify({
        code: inviteToken.value, server_id: server.value.id, server_name: server.value.name,
        endpoints: JSON.stringify(endpoints.value),
        max_uses: maxUsesInput.value ? parseInt(maxUsesInput.value, 10) : null,
        expires_at: selectedExpiry.value ? new Date(Date.now() + selectedExpiry.value).toISOString() : null,
      }),
    })
  }
} catch { /* Non-critical */ }
```

- [ ] **Step 2: Verify & commit**

---

### Task 14: Client-Side — Rendezvous URL Settings UI

**Files:**
- Modify: `src/components/settings/SettingsPrivacyTab.vue`
- Modify: `src/stores/settingsStore.ts`

- [ ] **Step 1:** Add "Rendezvous Server" section with URL input and discoverability toggle to `SettingsPrivacyTab.vue`
- [ ] **Step 2:** Add `userDiscoverability: 'public' | 'private'` to `settingsStore.ts` (default `'public'`)
- [ ] **Step 3: Verify & commit**

---

### Task 15: npm Scripts + Top-Level Integration

Already done — scripts added to `package.json`.

---

### Task 16: Update TODO.md

- [ ] **Step 1:** Add rendezvous server checkboxes under Phase 5c
- [ ] **Step 2: Commit**

---

## Notes

### Privacy Model
- **Servers**: Admin sets visibility to `public` (listed in discovery), `unlisted` (findable by direct `/servers/:id` link but not in search), or `secret` (only reachable via invite code; `GET /servers/:id` returns 404 to non-members).
- **Users**: Each user sets their own discoverability to `public` (appears in user search) or `private` (only visible to users who share a server with them).
- **Server never stores message content** — only routing metadata.

### Rate Limiting
- **REST**: tower-governor per-IP. Default 30 req/s, 60 burst.
- **WebSocket**: Per-client sliding-window. Default 50 msg/s. Excess dropped.
- **Persistent bans**: `rate_limit_bans` table for future IP blocking.

### Diesel Patterns Used
- `diesel::table!` for compile-time schema checking
- `#[derive(Queryable, Selectable)]` for SELECT results
- `#[derive(Insertable)]` for INSERT
- `#[derive(AsChangeset)]` for UPDATE (partial updates with `Option` fields)
- `diesel::insert_into().on_conflict().do_update()` for upserts
- `diesel::insert_or_ignore_into()` for idempotent inserts
- `diesel::replace_into()` for INSERT OR REPLACE
- `.into_boxed()` for dynamic query building (e.g. optional search filters)
- `diesel_migrations::embed_migrations!()` for compile-time embedded migrations
- `diesel::sql_query()` available as escape hatch for raw SQL when needed

### Auth MVP vs Production
- Current token = bare userId. Upgrade to JWT by changing `extract_user_id` and `/auth/verify`.

### Scaling
- In-memory `HashMap<String, ConnectedClient>` for <10K connections.
- Scale with Redis pub/sub for cross-instance routing.
