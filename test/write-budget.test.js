import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BILLABLE_WRITE_ESTIMATES,
  d1Usage,
  estimateBillableWrites,
  reserveDailyWriteBudget,
  settleWriteBudget,
  abandonUnusedWriteBudget,
  writeBudgetLimit,
  writeBudgetWindowStart
} from '../src/write-budget.js';

const AT = Date.UTC(2026, 8, 21, 12, 34, 56);

function dbFixture({ reserveError = null, missingReserve = false, settle = true, abandon = true } = {}) {
  const calls = [];
  return {
    calls,
    prepare(raw) {
      const sql = raw.replace(/\s+/g, ' ').trim();
      return {
        bind(...args) {
          calls.push({ sql, args });
          return {
            async first() {
              if (sql.startsWith('INSERT INTO write_budget_reservations')) {
                if (reserveError) throw reserveError;
                return missingReserve ? null : {
                  reservation_id: args[0], lane: args[1], window_start: args[2],
                  reserved_writes: args[5], status: 'reserved'
                };
              }
              if (sql.startsWith('UPDATE write_budget_reservations') && sql.includes("status='committed'")) {
                return settle ? { reservation_id: args[2], status: 'committed', committed_writes: args[0] } : null;
              }
              if (sql.startsWith('UPDATE write_budget_reservations') && sql.includes("status='abandoned'")) {
                return abandon ? { reservation_id: args[1], status: 'abandoned' } : null;
              }
              throw new Error(`Unexpected SQL: ${sql}`);
            }
          };
        }
      };
    }
  };
}

test('daily windows are UTC-aligned and lane limits fail closed when absent', () => {
  assert.equal(writeBudgetWindowStart(AT), Date.UTC(2026, 8, 21));
  assert.equal(writeBudgetLimit({ D1_MARKET_DAILY_WRITE_BUDGET: '90000' }, 'market'), 90000);
  assert.throws(() => writeBudgetLimit({}, 'player_state'), { code: 'WRITE_BUDGET_CONFIG_MISSING_PLAYER_STATE' });
});

test('billable estimates include outbox and budget-control overhead', () => {
  const estimate = estimateBillableWrites({
    marketFrames: 1,
    evidenceInserts: 10,
    retentionDeletes: 1,
    runStarts: 1,
    runFinishes: 1
  });
  assert.equal(estimate,
    BILLABLE_WRITE_ESTIMATES.marketFrame +
    10 * BILLABLE_WRITE_ESTIMATES.evidenceWithOutbox + 1 + 2 + 1 + 2);
});

test('reservation is a single confirmed insert and refuses an oversized request before D1', async () => {
  const db = dbFixture();
  const reservation = await reserveDailyWriteBudget(db, {
    lane: 'market', requestedWrites: 800, limitWrites: 90000, at: AT, id: 'reservation-1'
  });
  assert.equal(reservation.reserved_writes, 800);
  assert.equal(db.calls.length, 1);
  await assert.rejects(reserveDailyWriteBudget(db, {
    lane: 'market', requestedWrites: 90001, limitWrites: 90000, at: AT, id: 'reservation-2'
  }), { code: 'WRITE_BUDGET_EXCEEDED' });
  assert.equal(db.calls.length, 1);
});

test('D1 budget rejection is normalized and unknown reservation results fail closed', async () => {
  const rejected = dbFixture({ reserveError: new Error('D1_ERROR: WRITE_BUDGET_EXCEEDED') });
  await assert.rejects(reserveDailyWriteBudget(rejected, {
    lane: 'player_state', requestedWrites: 10, limitWrites: 100, at: AT, id: 'r'
  }), { code: 'WRITE_BUDGET_EXCEEDED' });
  const unknown = dbFixture({ missingReserve: true });
  await assert.rejects(reserveDailyWriteBudget(unknown, {
    lane: 'player_state', requestedWrites: 10, limitWrites: 100, at: AT, id: 'r'
  }), { code: 'WRITE_BUDGET_RESERVATION_UNCONFIRMED' });
});

test('settlement cannot exceed the reservation and unused reservations can be abandoned', async () => {
  const db = dbFixture();
  const reservation = { reservation_id: 'r', reserved_writes: 20 };
  await assert.rejects(settleWriteBudget(db, reservation, 21, AT), { code: 'WRITE_BUDGET_SETTLEMENT_INVALID' });
  assert.equal((await settleWriteBudget(db, reservation, 12, AT)).committed_writes, 12);
  assert.equal((await abandonUnusedWriteBudget(db, reservation, AT)).status, 'abandoned');
});

test('D1 usage sums batch metadata and fails closed when metadata is absent', () => {
  assert.deepEqual(d1Usage([
    { meta: { rows_read: 4, rows_written: 2, timings: { sql_duration_ms: 1.25 } } },
    { meta: { rows_read: 3, rows_written: 1, duration: 0.75 } }
  ]), { rowsRead: 7, rowsWritten: 3, sqlDurationMs: 2, queries: 2 });
  assert.throws(() => d1Usage({ success: true, meta: { changes: 1 } }), { code: 'D1_USAGE_META_MISSING' });
});
