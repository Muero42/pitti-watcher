CREATE TABLE IF NOT EXISTS player_state_scope_frames (
  run_id INTEGER NOT NULL REFERENCES watcher_runs(id),
  source_scope TEXT NOT NULL CHECK (source_scope IN ('QB','RB','WR','TE','K')),
  captured_at INTEGER NOT NULL,
  source_etag TEXT NOT NULL,
  player_count INTEGER NOT NULL CHECK (player_count >= 0),
  frame_json TEXT NOT NULL,
  PRIMARY KEY (run_id, source_scope)
) WITHOUT ROWID;
