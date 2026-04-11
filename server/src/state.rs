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
