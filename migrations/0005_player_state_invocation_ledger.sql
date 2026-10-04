CREATE TABLE player_state_invocations (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  scheduled_at INTEGER,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('daily_start','continuation')),
  run_id INTEGER,
  scope_index INTEGER,
  scope_offset INTEGER,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','ok','fail')),
  error_code TEXT CHECK(error_code IS NULL OR error_code='PLAYER_STATE_WORK_FAILED')
);
CREATE INDEX idx_player_state_invocations_started ON player_state_invocations(started_at);
