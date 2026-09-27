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
    /// Nonces of login challenges already used, with their expiry (unix
    /// seconds). Makes each challenge single-use. Only a caller that holds
    /// the user's sign key can add an entry (see `consume_challenge`).
    used_challenges: std::sync::Mutex<HashMap<String, u64>>,
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
            used_challenges: std::sync::Mutex::new(HashMap::new()),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("Failed to build HTTP client"),
            session_secret: session_secret_from(config),
        }
    }

    /// Issue a session token for `user_id`, valid for `config.session_ttl`.
    /// Returns the token and its expiry (unix seconds).
    pub fn issue_session_token(&self, user_id: &str) -> (String, u64) {
        let exp = now_secs() + self.config.session_ttl;
        (crate::session::issue(&self.session_secret, user_id, exp), exp)
    }

    /// Return the user ID from a valid, unexpired session token.
    pub fn verify_session_token(&self, token: &str) -> Option<String> {
        crate::session::verify(&self.session_secret, token, now_secs()).ok()
    }

    /// Like `verify_session_token`, but also returns the token's expiry.
    pub fn verify_session(&self, token: &str) -> Option<crate::session::Session> {
        crate::session::verify_session(&self.session_secret, token, now_secs()).ok()
    }

    /// Issue a login challenge for `user_id`, valid for `ttl_secs`.
    pub fn issue_challenge(&self, user_id: &str, ttl_secs: u64) -> String {
        crate::session::issue_challenge(&self.session_secret, user_id, now_secs() + ttl_secs)
    }

    /// Check that `challenge` is a valid, unexpired challenge for `user_id`
    /// that has not been used yet. Does not mark it used.
    pub fn check_challenge(&self, challenge: &str, user_id: &str) -> Option<crate::session::Challenge> {
        let c = crate::session::verify_challenge(&self.session_secret, challenge, now_secs()).ok()?;
        if c.user_id != user_id {
            return None;
        }
        let used = self.used_challenges.lock().ok()?;
        (!used.contains_key(&c.nonce)).then_some(c)
    }

    /// Mark a checked challenge as used. Returns false if it was used in the
    /// meantime. Call only after the signature over it has been verified.
    pub fn consume_challenge(&self, challenge: &crate::session::Challenge) -> bool {
        let Ok(mut used) = self.used_challenges.lock() else { return false };
        let now = now_secs();
        used.retain(|_, exp| *exp > now);
        used.insert(challenge.nonce.clone(), challenge.exp).is_none()
    }

    #[cfg(test)]
    pub fn issue_session_token_until(&self, user_id: &str, exp: u64) -> String {
        crate::session::issue(&self.session_secret, user_id, exp)
    }
}

pub fn now_secs() -> u64 {
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
