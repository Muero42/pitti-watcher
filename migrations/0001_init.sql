CREATE TABLE IF NOT EXISTS watcher_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS trending_snapshots (
  captured_at INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  adds_1h INTEGER,
  adds_3h INTEGER,
  adds_6h INTEGER,
  adds_24h INTEGER,
  drops_1h INTEGER,
  drops_6h INTEGER,
  drops_24h INTEGER,
  PRIMARY KEY (captured_at, player_id)
);
CREATE INDEX IF NOT EXISTS idx_trending_player_time ON trending_snapshots(player_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS player_state (
  player_id TEXT PRIMARY KEY,
  full_name TEXT,
  team TEXT,
  position TEXT,
  injury_status TEXT,
  practice_participation TEXT,
  depth_chart_order INTEGER,
  status TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  state_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  player_id TEXT,
  event_type TEXT NOT NULL,
  fundamental_or_market TEXT NOT NULL,
  occurred_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  original_source TEXT NOT NULL,
  authority REAL NOT NULL,
  confidence REAL NOT NULL,
  thesis_link TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_recent ON evidence_events(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_player ON evidence_events(player_id, first_seen_at DESC);
