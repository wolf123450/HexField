CREATE TABLE IF NOT EXISTS governance_motions (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  is_binding INTEGER NOT NULL,
  seat_count INTEGER NOT NULL DEFAULT 1,
  proposer_user_id TEXT NOT NULL,
  eligibility_snapshot_json TEXT,
  discussion_open_at TEXT,
  vote_open_at TEXT,
  vote_close_at TEXT,
  ruleset_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_governance_motions_server_state
  ON governance_motions(server_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS governance_candidates (
  motion_id TEXT NOT NULL,
  candidate_user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  nominated_by_user_id TEXT,
  seconded_by_user_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (motion_id, candidate_user_id),
  FOREIGN KEY (motion_id) REFERENCES governance_motions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS governance_ballots (
  motion_id TEXT NOT NULL,
  voter_user_id TEXT NOT NULL,
  approved_candidate_ids_json TEXT NOT NULL,
  reject_vote INTEGER NOT NULL,
  abstain_vote INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (motion_id, voter_user_id),
  FOREIGN KEY (motion_id) REFERENCES governance_motions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS governance_posts (
  id TEXT PRIMARY KEY,
  motion_id TEXT NOT NULL,
  parent_post_id TEXT,
  author_user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (motion_id) REFERENCES governance_motions(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_post_id) REFERENCES governance_posts(id) ON DELETE CASCADE
);
