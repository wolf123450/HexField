use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use diesel::sqlite::SqliteConnection;

use crate::config::Config;

pub type ClientTx = mpsc::UnboundedSender<String>;

pub struct ConnectedClient {
    pub tx: ClientTx,
    pub msg_count: std::sync::atomic::AtomicU32,
    pub window_start: std::sync::atomic::AtomicU64,
}

pub struct ServerState {
    pub clients: RwLock<HashMap<String, Arc<ConnectedClient>>>,
    pub db: std::sync::Mutex<SqliteConnection>,
    pub config: Config,
    pub challenges: RwLock<HashMap<String, (String, std::time::Instant)>>,
    /// Outbound HTTP (Cloudflare TURN credential API).
    pub http: reqwest::Client,
    /// HMAC key for session tokens (see `session.rs`).
    session_secret: Vec<u8>,
}

impl ServerState {
    pub fn new(config: &Config) -> Self {
        let conn = crate::db::establish_connection(&config.db_path);
        ServerState {
            clients: RwLock::new(HashMap::new()),
            db: std::sync::Mutex::new(conn),
            config: config.clone(),
            challenges: RwLock::new(HashMap::new()),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("Failed to build HTTP client"),
            session_secret: session_secret_from(config),
        }
    }

    /// Issue a session token for `user_id`, valid for `config.session_ttl`.
    pub fn issue_session_token(&self, user_id: &str) -> String {
        crate::session::issue(&self.session_secret, user_id, now_secs() + self.config.session_ttl)
    }

    /// Return the user ID from a valid, unexpired session token.
    pub fn verify_session_token(&self, token: &str) -> Option<String> {
        crate::session::verify(&self.session_secret, token, now_secs()).ok()
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn session_secret_from(config: &Config) -> Vec<u8> {
    if config.session_secret.is_empty() {
        tracing::warn!(
            "HEXFIELD_SESSION_SECRET is not set: using a random key. \
             Session tokens will not survive a server restart."
        );
        return rand::random::<[u8; 32]>().to_vec();
    }
    if config.session_secret.len() < 32 {
        tracing::warn!("HEXFIELD_SESSION_SECRET is shorter than 32 bytes; use a longer random value");
    }
    config.session_secret.as_bytes().to_vec()
}
