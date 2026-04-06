CREATE INDEX IF NOT EXISTS idx_messages_server ON messages(server_id, logical_ts DESC);
