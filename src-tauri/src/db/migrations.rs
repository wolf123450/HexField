use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

const M001: &str = include_str!("../../migrations/001_initial.sql");
const M002: &str = include_str!("../../migrations/002_member_avatar.sql");
const M003: &str = include_str!("../../migrations/003_invite_codes_and_mod_log.sql");
const M004: &str = include_str!("../../migrations/004_bans.sql");
const M005: &str = include_str!("../../migrations/005_channel_acls.sql");
const M006: &str = include_str!("../../migrations/006_join_requests.sql");

pub fn run(conn: &mut Connection) {
    let migrations = Migrations::new(vec![M::up(M001), M::up(M002), M::up(M003), M::up(M004), M::up(M005), M::up(M006)]);
    migrations.to_latest(conn).expect("DB migration failed");
}
