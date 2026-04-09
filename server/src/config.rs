use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[command(name = "hexfield-server", about = "HexField rendezvous, signal relay, and discovery server")]
pub struct Config {
    #[arg(long, env = "HEXFIELD_HOST", default_value = "0.0.0.0")]
    pub host: String,
    #[arg(long, env = "HEXFIELD_PORT", default_value_t = 7700)]
    pub port: u16,
    #[arg(long, env = "HEXFIELD_DB_PATH", default_value = "hexfield-server.db")]
    pub db_path: String,
    #[arg(long, env = "HEXFIELD_TURN_URL", default_value = "")]
    pub turn_url: String,
    #[arg(long, env = "HEXFIELD_TURN_SECRET", default_value = "")]
    pub turn_secret: String,
    #[arg(long, env = "HEXFIELD_TURN_TTL", default_value_t = 86400)]
    pub turn_ttl: u64,
    #[arg(long, env = "HEXFIELD_MAX_CONNECTIONS", default_value_t = 5000)]
    pub max_connections: usize,
    #[arg(long, env = "HEXFIELD_RATE_LIMIT_RPS", default_value_t = 30)]
    pub rate_limit_rps: u32,
    #[arg(long, env = "HEXFIELD_RATE_LIMIT_BURST", default_value_t = 60)]
    pub rate_limit_burst: u32,
    #[arg(long, env = "HEXFIELD_WS_MSG_RPS", default_value_t = 50)]
    pub ws_msg_rps: u32,
}

impl Config {
    pub fn parse_from_env() -> Self { Config::parse() }
    pub fn has_turn(&self) -> bool { !self.turn_url.is_empty() && !self.turn_secret.is_empty() }
}
