-- Preview only. Deliberately outside migrations/ until shadow calibration proves
-- conservative write multipliers and pending-outbox bounds.
CREATE TABLE IF NOT EXISTS write_budget_windows (
  lane TEXT NOT NULL CHECK (lane IN ('market', 'player_state')),
  window_start INTEGER NOT NULL,
  window_ms INTEGER NOT NULL CHECK (window_ms > 0),
  limit_writes INTEGER NOT NULL CHECK (limit_writes >= 0),
  reserved_writes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_writes >= 0),
  committed_writes INTEGER NOT NULL DEFAULT 0 CHECK (committed_writes >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (lane, window_start)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS write_budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL CHECK (lane IN ('market', 'player_state')),
  window_start INTEGER NOT NULL,
  window_ms INTEGER NOT NULL CHECK (window_ms > 0),
  limit_writes INTEGER NOT NULL CHECK (limit_writes >= 0),
  reserved_writes INTEGER NOT NULL CHECK (reserved_writes > 0),
  committed_writes INTEGER CHECK (
    committed_writes IS NULL OR
    (committed_writes >= 0 AND committed_writes <= reserved_writes)
  ),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'abandoned')),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  FOREIGN KEY (lane, window_start) REFERENCES write_budget_windows(lane, window_start)
);

CREATE INDEX IF NOT EXISTS idx_write_budget_reservations_open
  ON write_budget_reservations(lane, window_start, status);

CREATE TRIGGER IF NOT EXISTS trg_write_budget_reserve
BEFORE INSERT ON write_budget_reservations
BEGIN
  INSERT INTO write_budget_windows(
    lane, window_start, window_ms, limit_writes,
    reserved_writes, committed_writes, updated_at
  ) VALUES(
    NEW.lane, NEW.window_start, NEW.window_ms, NEW.limit_writes,
    0, 0, NEW.created_at
  ) ON CONFLICT(lane, window_start) DO NOTHING;

  SELECT CASE
    WHEN (SELECT window_ms FROM write_budget_windows
          WHERE lane=NEW.lane AND window_start=NEW.window_start) != NEW.window_ms
      OR (SELECT limit_writes FROM write_budget_windows
          WHERE lane=NEW.lane AND window_start=NEW.window_start) != NEW.limit_writes
    THEN RAISE(ABORT, 'WRITE_BUDGET_CONFIG_MISMATCH')
  END;

  SELECT CASE
    WHEN (SELECT committed_writes + reserved_writes + NEW.reserved_writes
          FROM write_budget_windows
          WHERE lane=NEW.lane AND window_start=NEW.window_start) > NEW.limit_writes
    THEN RAISE(ABORT, 'WRITE_BUDGET_EXCEEDED')
  END;

  UPDATE write_budget_windows
  SET reserved_writes=reserved_writes+NEW.reserved_writes,
      updated_at=NEW.created_at
  WHERE lane=NEW.lane AND window_start=NEW.window_start;
END;

CREATE TRIGGER IF NOT EXISTS trg_write_budget_settle
AFTER UPDATE OF status ON write_budget_reservations
WHEN OLD.status='reserved' AND NEW.status IN ('committed', 'abandoned')
BEGIN
  UPDATE write_budget_windows
  SET reserved_writes=reserved_writes-OLD.reserved_writes,
      committed_writes=committed_writes+
        CASE WHEN NEW.status='committed' THEN NEW.committed_writes ELSE 0 END,
      updated_at=NEW.settled_at
  WHERE lane=OLD.lane AND window_start=OLD.window_start;
END;

CREATE TABLE IF NOT EXISTS alert_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  evidence_fingerprint TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('market', 'player_state')),
  topic TEXT NOT NULL,
  player_id TEXT,
  occurred_at INTEGER,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'sent', 'dead')),
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_alert_outbox_delivery
  ON alert_outbox(status, available_at, id);

-- The outbox is populated only from evidence that the existing Sleeper lanes already
-- produce. There is intentionally no sender, external source, or transaction executor.
CREATE TRIGGER IF NOT EXISTS trg_accepted_run_to_alert_outbox
AFTER UPDATE OF finished_at, ok ON watcher_runs
WHEN NEW.ok=1 AND NEW.finished_at IS NOT NULL
  AND (OLD.ok!=1 OR OLD.finished_at IS NULL)
BEGIN
  INSERT INTO alert_outbox(
    dedupe_key, evidence_fingerprint, lane, topic, player_id, occurred_at,
    payload_json, available_at, created_at, updated_at
  )
  SELECT
    e.fingerprint,
    e.fingerprint,
    CASE WHEN e.fundamental_or_market='market' THEN 'market' ELSE 'player_state' END,
    e.event_type,
    e.player_id,
    e.occurred_at,
    e.payload_json,
    NEW.finished_at,
    NEW.finished_at,
    NEW.finished_at
  FROM evidence_events e
  WHERE e.observation_run_id=NEW.id
    AND e.fundamental_or_market IN ('market', 'fundamental')
  ON CONFLICT(dedupe_key) DO NOTHING;
END;
