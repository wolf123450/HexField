use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

const M001: &str = include_str!("../../migrations/001_initial.sql");
const M002: &str = include_str!("../../migrations/002_member_avatar.sql");

pub fn run(conn: &mut Connection) {
    let migrations = Migrations::new(vec![M::up(M001), M::up(M002)]);
    migrations.to_latest(conn).expect("DB migration failed");
}
