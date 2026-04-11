mod auth;
mod config;
mod db;
mod middleware;
mod models;
mod routes;
mod schema;
mod state;
mod ws;

use axum::{Router, routing::{get, post}};
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_governor::{GovernorLayer, governor::GovernorConfigBuilder};

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

    let governor_config = GovernorConfigBuilder::default()
        .per_second(config.rate_limit_rps.into())
        .burst_size(config.rate_limit_burst)
        .finish()
        .unwrap();
    let rate_limit = GovernorLayer::new(governor_config);

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/auth/challenge", post(auth::challenge))
        .route("/auth/verify", post(auth::verify))
        .route("/users/me", get(routes::users::get_me).put(routes::users::update_me))
        .route("/users/{user_id}", get(routes::users::get_user))
        .route("/users", get(routes::users::search_users))
        .route("/servers", post(routes::servers::register_server).get(routes::servers::discover_servers))
        .route("/servers/{server_id}", get(routes::servers::get_server).put(routes::servers::update_server))
        .route("/servers/{server_id}/members", get(routes::servers::get_members))
        .route("/invites", post(routes::invites::register_invite))
        .route("/invites/{code}", get(routes::invites::resolve_invite))
        .route("/turn/credentials", post(routes::turn::get_credentials))
        .route("/ws", get(ws::ws_handler))
        .layer(rate_limit)
        .layer(CorsLayer::permissive())
        .with_state(shared);

    let addr = format!("{}:{}", config.host, config.port);
    tracing::info!("hexfield-server listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await.expect("Failed to bind");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("Server error");
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c().await.expect("ctrl-c listener failed");
    tracing::info!("Shutting down gracefully");
}
