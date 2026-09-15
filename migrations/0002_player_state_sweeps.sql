CREATE TABLE IF NOT EXISTS player_state_sweeps (
  run_id INTEGER PRIMARY KEY,
  source_etag TEXT NOT NULL,
  total_entries INTEGER NOT NULL,
  next_index INTEGER NOT NULL DEFAULT 0,
  seen_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  CHECK (total_entries >= 0),
  CHECK (next_index >= 0 AND next_index <= total_entries),
  CHECK (seen_count >= 0)
);
