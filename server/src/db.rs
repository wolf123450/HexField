use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};

pub const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

pub fn establish_connection(database_url: &str) -> SqliteConnection {
    let mut conn = SqliteConnection::establish(database_url)
        .unwrap_or_else(|e| panic!("Error connecting to {}: {}", database_url, e));
    diesel::sql_query("PRAGMA journal_mode=WAL")
        .execute(&mut conn)
        .expect("Failed to set WAL mode");
    diesel::sql_query("PRAGMA foreign_keys=ON")
        .execute(&mut conn)
        .expect("Failed to enable foreign keys");
    conn.run_pending_migrations(MIGRATIONS)
        .expect("Failed to run migrations");
    conn
}

pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}
