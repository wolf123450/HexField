pub mod migrations;
pub mod types;

use rusqlite::Connection;
use std::path::PathBuf;

pub fn open(app_data_dir: PathBuf) -> Connection {
    std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data directory");
    let db_path = app_data_dir.join("gamechat.db");
    let mut conn = Connection::open(db_path).expect("Failed to open SQLite database");
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .expect("Failed to set PRAGMA");
    migrations::run(&mut conn);
    conn
}
