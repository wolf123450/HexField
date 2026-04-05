pub mod migrations;
pub mod types;

use rusqlite::Connection;
use std::path::PathBuf;

pub fn open(app_data_dir: PathBuf) -> Connection {
    // HEXFIELD_DATA_DIR overrides the default app-data directory.
    // Set by scripts/dev-tauri.mjs when launching a named dev instance
    // (e.g. `npm run dev:tauri -- alice`), keeping each instance isolated.
    let dir = match std::env::var("HEXFIELD_DATA_DIR") {
        Ok(v) if !v.is_empty() => {
            log::info!("DB data dir override: {}", v);
            PathBuf::from(v)
        }
        _ => app_data_dir,
    };
    std::fs::create_dir_all(&dir).expect("Failed to create app data directory");
    let db_path = dir.join("hexfield.db");
    let mut conn = Connection::open(db_path).expect("Failed to open SQLite database");
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .expect("Failed to set PRAGMA");
    migrations::run(&mut conn);
    conn
}
