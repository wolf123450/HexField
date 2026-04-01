use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

const M001: &str = include_str!("../../migrations/001_initial.sql");

pub fn run(conn: &mut Connection) {
    let migrations = Migrations::new(vec![M::up(M001)]);
    migrations.to_latest(conn).expect("DB migration failed");
}
