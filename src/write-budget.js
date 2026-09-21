const DAY_MS = 24 * 60 * 60 * 1000;
const LANES = new Set(['market', 'player_state']);

// Shadow-calibration inputs only. Do not activate enforcement until observed D1
// metadata proves these bounds conservative for the promoted schema.
export const BILLABLE_WRITE_ESTIMATES = Object.freeze({
  marketFrame: 2,
  evidenceWithOutbox: 8,
  playerStateScopeFrameInsert: 1,
  playerStateScopeFrameDelete: 1,
  playerStateCandidateStage: 1,
  playerStateCandidateDelete: 1,
  playerStateInsert: 2,
  playerStateUpdate: 1,
  retentionDelete: 2,
  checkpoint: 1,
  runStart: 2,
  runFinish: 1,
  budgetControl: 10
});

function positiveInt(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return number;
}

function assertLane(lane) {
  if (!LANES.has(lane)) {
    const error = new Error('WRITE_BUDGET_LANE_INVALID');
    error.code = 'WRITE_BUDGET_LANE_INVALID';
    throw error;
  }
}

export function writeBudgetWindowStart(at = Date.now(), windowMs = DAY_MS) {
  const timestamp = Number(at);
  const width = positiveInt(windowMs, 'WRITE_BUDGET_WINDOW_INVALID');
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    const error = new Error('WRITE_BUDGET_TIME_INVALID');
    error.code = 'WRITE_BUDGET_TIME_INVALID';
    throw error;
  }
  return Math.floor(timestamp / width) * width;
}

export function writeBudgetLimit(env, lane) {
  assertLane(lane);
  const key = lane === 'market'
    ? 'D1_MARKET_DAILY_WRITE_BUDGET'
    : 'D1_PLAYER_STATE_DAILY_WRITE_BUDGET';
  return positiveInt(env?.[key], `WRITE_BUDGET_CONFIG_MISSING_${lane.toUpperCase()}`);
}

export function estimateBillableWrites(counts = {}) {
  const count = key => {
    const value = Number(counts[key] || 0);
    if (!Number.isSafeInteger(value) || value < 0) {
      const error = new Error(`WRITE_BUDGET_ESTIMATE_INVALID_${key}`);
      error.code = 'WRITE_BUDGET_ESTIMATE_INVALID';
      throw error;
    }
    return value;
  };
  return (
    count('marketFrames') * BILLABLE_WRITE_ESTIMATES.marketFrame +
    count('evidenceInserts') * BILLABLE_WRITE_ESTIMATES.evidenceWithOutbox +
    count('playerStateScopeFramesInserted') * BILLABLE_WRITE_ESTIMATES.playerStateScopeFrameInsert +
    count('playerStateScopeFramesDeleted') * BILLABLE_WRITE_ESTIMATES.playerStateScopeFrameDelete +
    count('playerStateCandidatesStaged') * BILLABLE_WRITE_ESTIMATES.playerStateCandidateStage +
    count('playerStateCandidatesDeleted') * BILLABLE_WRITE_ESTIMATES.playerStateCandidateDelete +
    count('playerStateInserts') * BILLABLE_WRITE_ESTIMATES.playerStateInsert +
    count('playerStateUpdates') * BILLABLE_WRITE_ESTIMATES.playerStateUpdate +
    count('retentionDeletes') * BILLABLE_WRITE_ESTIMATES.retentionDelete +
    count('checkpoints') * BILLABLE_WRITE_ESTIMATES.checkpoint +
    count('runStarts') * BILLABLE_WRITE_ESTIMATES.runStart +
    count('runFinishes') * BILLABLE_WRITE_ESTIMATES.runFinish +
    BILLABLE_WRITE_ESTIMATES.budgetControl
  );
}

function reservationId() {
  if (!globalThis.crypto?.randomUUID) {
    const error = new Error('WRITE_BUDGET_SECURE_ID_UNAVAILABLE');
    error.code = 'WRITE_BUDGET_SECURE_ID_UNAVAILABLE';
    throw error;
  }
  return crypto.randomUUID();
}

export async function reserveDailyWriteBudget(db, {
  lane,
  requestedWrites,
  limitWrites,
  at = Date.now(),
  windowMs = DAY_MS,
  id = reservationId()
}) {
  assertLane(lane);
  const requested = positiveInt(requestedWrites, 'WRITE_BUDGET_REQUEST_INVALID');
  const limit = positiveInt(limitWrites, 'WRITE_BUDGET_LIMIT_INVALID');
  if (requested > limit) {
    const error = new Error('WRITE_BUDGET_EXCEEDED');
    error.code = 'WRITE_BUDGET_EXCEEDED';
    throw error;
  }
  const start = writeBudgetWindowStart(at, windowMs);
  let row;
  try {
    row = await db.prepare(`
      INSERT INTO write_budget_reservations(
        reservation_id,lane,window_start,window_ms,limit_writes,
        reserved_writes,status,created_at
      ) VALUES(?1,?2,?3,?4,?5,?6,'reserved',?7)
      RETURNING reservation_id,lane,window_start,reserved_writes,status
    `).bind(id, lane, start, windowMs, limit, requested, at).first();
  } catch (cause) {
    const error = new Error('WRITE_BUDGET_RESERVATION_FAILED', { cause });
    error.code = String(cause?.message || '').includes('WRITE_BUDGET_EXCEEDED')
      ? 'WRITE_BUDGET_EXCEEDED'
      : 'WRITE_BUDGET_RESERVATION_FAILED';
    throw error;
  }
  if (!row || row.status !== 'reserved' || row.reservation_id !== id) {
    const error = new Error('WRITE_BUDGET_RESERVATION_UNCONFIRMED');
    error.code = 'WRITE_BUDGET_RESERVATION_UNCONFIRMED';
    throw error;
  }
  return row;
}

export async function settleWriteBudget(db, reservation, committedWrites, at = Date.now()) {
  const committed = Number(committedWrites);
  if (!reservation?.reservation_id || !Number.isSafeInteger(committed) || committed < 0 || committed > Number(reservation.reserved_writes)) {
    const error = new Error('WRITE_BUDGET_SETTLEMENT_INVALID');
    error.code = 'WRITE_BUDGET_SETTLEMENT_INVALID';
    throw error;
  }
  const row = await db.prepare(`
    UPDATE write_budget_reservations
    SET status='committed',committed_writes=?1,settled_at=?2
    WHERE reservation_id=?3 AND status='reserved' AND ?1<=reserved_writes
    RETURNING reservation_id,status,committed_writes
  `).bind(committed, at, reservation.reservation_id).first();
  if (!row || row.status !== 'committed') {
    const error = new Error('WRITE_BUDGET_SETTLEMENT_UNCONFIRMED');
    error.code = 'WRITE_BUDGET_SETTLEMENT_UNCONFIRMED';
    throw error;
  }
  return row;
}

export async function abandonUnusedWriteBudget(db, reservation, at = Date.now()) {
  if (!reservation?.reservation_id) {
    const error = new Error('WRITE_BUDGET_ABANDON_INVALID');
    error.code = 'WRITE_BUDGET_ABANDON_INVALID';
    throw error;
  }
  const row = await db.prepare(`
    UPDATE write_budget_reservations
    SET status='abandoned',committed_writes=0,settled_at=?1
    WHERE reservation_id=?2 AND status='reserved'
    RETURNING reservation_id,status
  `).bind(at, reservation.reservation_id).first();
  if (!row || row.status !== 'abandoned') {
    const error = new Error('WRITE_BUDGET_ABANDON_UNCONFIRMED');
    error.code = 'WRITE_BUDGET_ABANDON_UNCONFIRMED';
    throw error;
  }
  return row;
}

export function d1Usage(result) {
  const results = Array.isArray(result) ? result : [result];
  return results.reduce((sum, item) => {
    const rowsRead = Number(item?.meta?.rows_read);
    const rowsWritten = Number(item?.meta?.rows_written);
    const sqlMs = Number(item?.meta?.timings?.sql_duration_ms ?? item?.meta?.duration);
    if (![rowsRead, rowsWritten, sqlMs].every(Number.isFinite)) {
      const error = new Error('D1_USAGE_META_MISSING');
      error.code = 'D1_USAGE_META_MISSING';
      throw error;
    }
    sum.rowsRead += rowsRead;
    sum.rowsWritten += rowsWritten;
    sum.sqlDurationMs += sqlMs;
    sum.queries += 1;
    return sum;
  }, { rowsRead: 0, rowsWritten: 0, sqlDurationMs: 0, queries: 0 });
}

export { DAY_MS };
