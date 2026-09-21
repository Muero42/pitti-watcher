ALTER TABLE player_state_sweeps ADD COLUMN scope_offset INTEGER NOT NULL DEFAULT 0
  CHECK (scope_offset >= 0);

ALTER TABLE player_state_sweeps ADD COLUMN scope_etag TEXT;

ALTER TABLE evidence_events ADD COLUMN observation_run_id INTEGER
  REFERENCES watcher_runs(id);

CREATE INDEX IF NOT EXISTS idx_evidence_observation_run
  ON evidence_events(observation_run_id, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_watcher_runs_type_id
  ON watcher_runs(run_type, id DESC);

CREATE TABLE IF NOT EXISTS trending_snapshot_frames (
  captured_at INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL UNIQUE REFERENCES watcher_runs(id),
  player_count INTEGER NOT NULL CHECK (player_count >= 0),
  frame_json TEXT NOT NULL,
  signal_state_json TEXT NOT NULL DEFAULT '[]'
);
