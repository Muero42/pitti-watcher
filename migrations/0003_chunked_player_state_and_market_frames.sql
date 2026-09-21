ALTER TABLE player_state_sweeps ADD COLUMN scope_offset INTEGER NOT NULL DEFAULT 0
  CHECK (scope_offset >= 0);

ALTER TABLE player_state_sweeps ADD COLUMN scope_etag TEXT;

CREATE TABLE IF NOT EXISTS trending_snapshot_frames (
  captured_at INTEGER PRIMARY KEY,
  player_count INTEGER NOT NULL CHECK (player_count >= 0),
  frame_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_signal_state (
  player_id TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('acceleration', 'reversal')),
  level INTEGER NOT NULL CHECK (level > 0),
  episode_started_at INTEGER NOT NULL,
  last_transition_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, signal_type)
) WITHOUT ROWID;
