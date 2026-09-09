import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker, { safeFinishRun, runPlayerState, runTrending, playerStateOf, stateHash } from '../src/index.js';

const NOW = 1788850862324;
const SECRET = 'private-payload-token-do-not-persist';
const success = () => ({ success: true, meta: { changes: 1 } });
const openRun = (id = 1, type = 'player_state:scheduled') => ({ id, run_type: type, started_at: NOW, finished_at: null, ok: 0, item_count: 0, error: null });

// A deliberately small statement fake: unexpected SQL fails instead of going to a service.
function database(options = {}) {
  const db = {
    rows: options.rows || [], updates: [], reads: 0, batches: [], writes: [], order: [], snapshots: [],
    prepare(sql) {
      sql = sql.replace(/\s+/g, ' ').trim();
      const statement = (args = []) => ({
        sql, args,
        bind(...values) { return statement(values); },
        async first() {
          if (sql.startsWith('INSERT INTO watcher_runs')) {
            const row = openRun(db.rows.length + 1, args[0]);
            row.started_at = args[1]; db.rows.push(row); db.order.push('start');
            return { id: Object.hasOwn(options, 'startId') ? options.startId : row.id };
          }
          if (sql.startsWith('SELECT finished_at,ok,item_count,error')) {
            db.reads++;
            if (options.confirmError) throw options.confirmError;
            return db.rows.find(row => row.id === args[0]) || null;
          }
          if (sql.startsWith('SELECT captured_at FROM trending_snapshots')) return options.previous ? { captured_at: NOW - 900000 } : null;
          if (sql.includes('ORDER BY id DESC LIMIT 1')) {
            const type = sql.includes("run_type='trending:scheduled'") ? 'trending:scheduled' : 'player_state:scheduled';
            return db.rows.filter(row => row.run_type === type).sort((a,b) => b.id-a.id)[0] || null;
          }
          throw new Error(`Unexpected first: ${sql}`);
        },
        async all() {
          if (sql === 'SELECT * FROM player_state') {
            if (options.selectError) throw options.selectError;
            return { results: options.players || [] };
          }
          if (sql.startsWith('SELECT player_id,') && sql.includes('FROM trending_snapshots WHERE captured_at=?1')) {
            const columns = sql.slice(7, sql.indexOf(' FROM')).split(',');
            const rows = args[0] === NOW ? db.snapshots : options.previous || [];
            return { results: rows.map(row => Object.fromEntries(columns.map(key => [key, row[key]]))) };
          }
          if (sql.includes('FROM evidence_events') || sql.startsWith('WITH latest AS')) return { results: [] };
          throw new Error(`Unexpected all: ${sql}`);
        },
        async run() {
          if (sql.startsWith('UPDATE watcher_runs')) {
            assert.match(sql, /WHERE id=\?5 AND finished_at IS NULL$/);
            db.updates.push(args); db.order.push('finalize');
            const action = (options.finalize || [])[db.updates.length - 1];
            if (action === 'throw') throw new Error(SECRET);
            if (action === 'zero') return { success: true, meta: { changes: 0 } };
            if (action === 'null') return null;
            if (action === 'false') return { success: false, meta: { changes: 1 } };
            if (action === 'no-meta') return { success: true };
            const row = db.rows.find(row => row.id === args[4] && row.finished_at === null);
            if (!row) return { success: true, meta: { changes: 0 } };
            Object.assign(row, { finished_at: args[0], ok: args[1], item_count: args[2], error: args[3] });
            if (action === 'commit-throw') throw new Error(SECRET);
            return success();
          }
          if (sql.startsWith('DELETE FROM trending_snapshots')) { db.order.push('prune'); return success(); }
          if (sql.startsWith('INSERT INTO evidence_events')) {
            db.order.push('evidence');
            if (options.evidenceError) throw options.evidenceError;
            db.writes.push({ sql, args }); return success();
          }
          throw new Error(`Unexpected run: ${sql}`);
        }
      });
      return statement();
    },
    async batch(statements) {
      db.batches.push(statements);
      db.order.push(statements.every(stmt => stmt.sql.startsWith('INSERT INTO evidence_events')) ? 'evidenceBatch' : 'batch');
      if (options.batchError && db.batches.length === (options.failBatch || 1)) throw options.batchError;
      for (const stmt of statements) {
        db.writes.push(stmt);
        if (stmt.sql.startsWith('INSERT INTO trending_snapshots')) {
          const [captured_at,player_id,adds_1h,adds_3h,adds_6h,adds_24h,drops_1h,drops_6h,drops_24h] = stmt.args;
          db.snapshots.push({ captured_at,player_id,adds_1h,adds_3h,adds_6h,adds_24h,drops_1h,drops_6h,drops_24h });
        }
      }
      return statements.map(success);
    }
  };
  return db;
}

function setup(t, options = {}, payload = {}) {
  t.mock.method(Date, 'now', () => NOW);
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => payload }));
  const DB = database(options);
  return { DB, env: { DB }, fetch };
}

test('finalization: one successful UPDATE, no confirmation read', async t => {
  const { DB, env } = setup(t, { rows: [openRun()] });
  await safeFinishRun(env, 1, true, 0);
  assert.deepEqual(DB.rows[0], { ...openRun(), finished_at: NOW, ok: 1 });
  assert.equal(DB.updates.length, 1); assert.equal(DB.reads, 0);
});

for (const id of [undefined, null, false, 0, -1, 1.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
  test(`finalization: invalid ID ${String(id)}`, async t => {
    const { DB, env } = setup(t);
    await assert.rejects(safeFinishRun(env, id, true, 1), { code: 'INVALID_RUN_ID' });
    assert.equal(DB.updates.length, 0); assert.equal(DB.reads, 0);
  });
}

for (const action of ['throw', 'zero', 'null', 'false', 'no-meta']) {
  test(`finalization: ${action} result, confirm open, retry once`, async t => {
    const { DB, env } = setup(t, { rows: [openRun()], finalize: [action] });
    await safeFinishRun(env, 1, true, 7);
    assert.equal(DB.rows[0].ok, 1); assert.equal(DB.rows[0].item_count, 7);
    assert.equal(DB.reads, 1); assert.equal(DB.updates.length, 2);
    assert.deepEqual(DB.updates[0], DB.updates[1]);
  });
}

for (const ok of [true, false]) {
  test(`finalization: committed ${ok ? 'success' : 'failure'} with lost response is confirmed`, async t => {
    const { DB, env } = setup(t, { rows: [openRun()], finalize: ['commit-throw'] });
    await safeFinishRun(env, 1, ok, 0);
    assert.equal(DB.rows[0].ok, Number(ok)); assert.equal(DB.updates.length, 1); assert.equal(DB.reads, 1);
  });
}

test('finalization: retry failure is bounded and diagnostics exclude raw D1 error', async t => {
  const { DB, env } = setup(t, { rows: [openRun()], finalize: ['throw', 'throw'] });
  await assert.rejects(safeFinishRun(env, 1, true, 1), error => {
    assert.equal(error.message, 'FINALIZATION_FAILED');
    const text = [error.message, ...error.errors.map(e => e.message)].join(';');
    assert.ok(text.length < 150); assert.ok(!text.includes(SECRET)); return true;
  });
  assert.equal(DB.updates.length, 2); assert.equal(DB.reads, 1); assert.equal(DB.rows[0].finished_at, null);
});

test('finalization: failed confirmation never retries blindly', async t => {
  const { DB, env } = setup(t, { rows: [openRun()], finalize: ['commit-throw'], confirmError: new Error(SECRET) });
  await assert.rejects(safeFinishRun(env, 1, true, 1), /FINALIZATION_FAILED/);
  assert.equal(DB.updates.length, 1); assert.equal(DB.reads, 1); assert.equal(DB.rows[0].ok, 1);
});

test('finalization: missing row is explicit, never accepted as zero-row success', async t => {
  const { DB, env } = setup(t);
  await assert.rejects(safeFinishRun(env, 1, true, 1), e => e.errors.some(x => x.code === 'FINALIZE_NO_MATCH'));
  assert.equal(DB.updates.length, 1); assert.equal(DB.reads, 1);
});

test('finalization: conflicting closed row is never overwritten', async t => {
  const row = { ...openRun(), finished_at: NOW - 1, ok: 1, item_count: 10 };
  const { DB, env } = setup(t, { rows: [row] });
  await assert.rejects(safeFinishRun(env, 1, false, 0), e => e.errors.some(x => x.code === 'FINALIZE_CONFLICT'));
  assert.equal(row.ok, 1); assert.equal(row.item_count, 10); assert.equal(DB.updates.length, 1);
});

for (const [field, value] of [['ok', 0], ['item_count', 9], ['error', 'WORK_FAILED']]) {
  test(`finalization: confirmation rejects mismatched ${field}`, async t => {
    const row = { ...openRun(), finished_at: NOW, ok: 1, item_count: 1, [field]: value };
    const { DB, env } = setup(t, { rows: [row] });
    await assert.rejects(safeFinishRun(env, 1, true, 1), e => e.errors.some(x => x.code === 'FINALIZE_CONFLICT'));
    assert.equal(DB.updates.length, 1); assert.equal(DB.reads, 1);
  });
}

test('finalization: repeated identical intended completion is confirmed, not rewritten', async t => {
  const { DB, env } = setup(t, { rows: [openRun()] });
  await safeFinishRun(env, 1, true, 1);
  await safeFinishRun(env, 1, true, 1);
  assert.equal(DB.updates.length, 2); assert.equal(DB.reads, 1);
  assert.equal(DB.rows[0].finished_at, NOW); assert.equal(DB.rows[0].item_count, 1);
});

const player = { full_name: 'Test Player', position: 'RB', team: 'AAA' };
const oldPlayer = { player_id: '1', ...playerStateOf(player), state_hash: stateHash(playerStateOf(player)) };

test('players: unchanged state is write-free, count is seen', async t => {
  const { DB, env } = setup(t, { players: [oldPlayer] }, { 1: player });
  assert.deepEqual(await runPlayerState(env, NOW, 'scheduled'), { ok: true, captured_at: NOW, seen: 1, changed: 0 });
  assert.equal(DB.writes.length, 0); assert.equal(DB.batches.length, 0);
  assert.equal(DB.rows[0].item_count, 1); assert.deepEqual(DB.order, ['start', 'finalize']);
});

test('players: evidence precedes state batch, new players do not fabricate change evidence', async t => {
  const { DB, env } = setup(t, { players: [oldPlayer] }, { 1: { ...player, team: 'BBB' }, 2: player });
  const out = await runPlayerState(env, NOW, 'scheduled');
  assert.equal(out.changed, 1); assert.equal(out.seen, 2);
  assert.deepEqual(DB.order, ['start', 'evidenceBatch', 'batch', 'finalize']);
  assert.deepEqual(DB.batches.map(batch => batch.length), [1, 2]);
});

test('players: 12k-player sweep batches 1000 changes with exact evidence identity', async t => {
  const count = 12000, changed = 1000;
  const payload = {}, existing = [];
  for (let i = 0; i < count; i++) {
    const id = String(i);
    payload[id] = i < changed ? { ...player, team: 'BBB' } : player;
    existing.push({ ...oldPlayer, player_id:id });
  }
  const { DB, env } = setup(t, { players:existing }, payload);
  const out = await runPlayerState(env, NOW, 'scheduled');
  assert.deepEqual(out, { ok:true, captured_at:NOW, seen:count, changed });
  const evidenceBatches = DB.batches.filter(batch => batch[0]?.sql.startsWith('INSERT INTO evidence_events'));
  const stateBatches = DB.batches.filter(batch => !batch[0]?.sql.startsWith('INSERT INTO evidence_events'));
  assert.deepEqual(evidenceBatches.map(x => x.length), [...Array(13).fill(75), 25]);
  assert.deepEqual(stateBatches.map(x => x.length), [...Array(13).fill(75), 25]);
  assert.ok(DB.batches.every(batch => batch.length <= 75));
  assert.ok(DB.order.lastIndexOf('evidenceBatch') < DB.order.indexOf('batch'));

  const first = evidenceBatches[0][0].args;
  const expectedPayload = JSON.stringify({
    player:'Test Player', team:'BBB', position:'RB',
    diffs:{ team:{ before:'AAA', after:'BBB' } }
  });
  const expectedFingerprint = createHash('sha256')
    .update(JSON.stringify(['0','PLAYER_STATE_CHANGED','Sleeper Player Data',JSON.parse(expectedPayload)]))
    .digest('hex');
  assert.deepEqual(first, [expectedFingerprint,'0','PLAYER_STATE_CHANGED','fundamental',NOW,NOW,NOW,
    'Sleeper Player Data','Sleeper Player Data',0.75,0.8,'roster_context',expectedPayload]);
});

test('players: intermediate evidence batch failure writes no canonical state and finalizes FAIL', async t => {
  const original = new Error('second evidence batch');
  const payload = Object.fromEntries(Array.from({ length:151 }, (_,i) => [String(i), { ...player, team:'BBB' }]));
  const players = Array.from({ length:151 }, (_,i) => ({ ...oldPlayer, player_id:String(i) }));
  const { DB, env } = setup(t, { players, batchError:original, failBatch:2 }, payload);
  await assert.rejects(runPlayerState(env, NOW, 'scheduled'), e => e === original);
  assert.deepEqual(DB.batches.map(x => x.length), [75, 75]);
  assert.ok(DB.writes.every(stmt => stmt.sql.startsWith('INSERT INTO evidence_events')));
  assert.deepEqual(DB.order, ['start','evidenceBatch','evidenceBatch','finalize']);
  assert.equal(DB.rows[0].ok, 0); assert.equal(DB.rows[0].item_count, 0);
});

test('players: intermediate state batch failure follows complete evidence persistence and finalizes FAIL', async t => {
  const original = new Error('second state batch');
  const payload = Object.fromEntries(Array.from({ length:80 }, (_,i) => [String(i), { ...player, team:'BBB' }]));
  const players = Array.from({ length:80 }, (_,i) => ({ ...oldPlayer, player_id:String(i) }));
  const { DB, env } = setup(t, { players, batchError:original, failBatch:4 }, payload);
  await assert.rejects(runPlayerState(env, NOW, 'scheduled'), e => e === original);
  assert.deepEqual(DB.batches.map(x => x.length), [75, 5, 75, 5]);
  assert.deepEqual(DB.order, ['start','evidenceBatch','evidenceBatch','batch','batch','finalize']);
  assert.equal(DB.writes.filter(stmt => stmt.sql.startsWith('INSERT INTO evidence_events')).length, 80);
  assert.equal(DB.writes.filter(stmt => stmt.sql.startsWith('UPDATE player_state')).length, 75);
  assert.equal(DB.rows[0].ok, 0); assert.equal(DB.rows[0].item_count, 0);
});

for (const [name, run, payload] of [['players', runPlayerState, { 1: player }], ['trending', runTrending, [{ player_id: '1', count: 30 }]]]) {
  for (const mode of ['http', 'parse', 'batch']) {
    test(`${name}: ${mode} work failure closes row and preserves original error`, async t => {
      const original = new Error(SECRET);
      const { DB, env, fetch } = setup(t, mode === 'batch' ? { batchError: original } : {}, payload);
      if (mode === 'http') fetch.mock.mockImplementation(async () => ({ ok: false, status: 503 }));
      if (mode === 'parse') fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => { throw original; } }));
      await assert.rejects(run(env, NOW, 'scheduled'), e => mode === 'http' ? e.message.startsWith('Sleeper ') && e.message.endsWith('HTTP 503') : e === original);
      assert.equal(DB.rows[0].finished_at, NOW); assert.equal(DB.rows[0].ok, 0);
      assert.equal(DB.rows[0].item_count, 0); assert.equal(DB.rows[0].error, 'WORK_FAILED');
      assert.equal(DB.updates.length, 1);
    });
  }

  test(`${name}: work plus finalization failure preserves both classes`, async t => {
    const original = new Error(SECRET);
    const { DB, env, fetch } = setup(t, { finalize: ['throw', 'throw'] });
    fetch.mock.mockImplementation(async () => { throw original; });
    await assert.rejects(run(env, NOW, 'scheduled'), e => {
      assert.equal(e.cause, original); assert.equal(e.errors[0], original);
      assert.equal(e.errors[1].message, 'FINALIZATION_FAILED'); return true;
    });
    assert.equal(DB.rows[0].finished_at, null); assert.equal(DB.rows[0].ok, 0);
    assert.equal(DB.updates.length, 2); assert.equal(DB.reads, 1);
    assert.ok(DB.updates.every(args => args[3] === 'WORK_FAILED'));
  });

  for (const action of ['throw', 'commit-throw']) {
    test(`${name}: success finalization ${action} confirms/retries without failure overwrite`, async t => {
      const { DB, env } = setup(t, { finalize: [action] }, name === 'players' ? {} : []);
      await run(env, NOW, 'scheduled');
      assert.equal(DB.rows[0].ok, 1); assert.ok(DB.updates.every(args => args[1] === 1));
      assert.equal(DB.reads, 1); assert.equal(DB.updates.length, action === 'throw' ? 2 : 1);
    });
  }

  test(`${name}: null and zero-match completion results fail explicitly after bounded retry`, async t => {
    const { DB, env } = setup(t, { finalize: ['null', 'zero'] }, name === 'players' ? {} : []);
    await assert.rejects(run(env, NOW, 'scheduled'), /FINALIZATION_FAILED/);
    assert.equal(DB.rows[0].finished_at, null); assert.equal(DB.updates.length, 2);
  });

  test(`${name}: missing start ID fails before work`, async t => {
    const { DB, env, fetch } = setup(t, { startId: null });
    await assert.rejects(run(env, NOW, 'scheduled'), { code: 'INVALID_RUN_ID' });
    assert.equal(fetch.mock.callCount(), 0); assert.equal(DB.updates.length, 0);
  });
}

test('players: SELECT failure preserves exact original exception', async t => {
  const original = new Error(SECRET);
  const { DB, env } = setup(t, { selectError: original });
  await assert.rejects(runPlayerState(env, NOW), e => e === original);
  assert.equal(DB.rows[0].error, 'WORK_FAILED'); assert.equal(DB.rows[0].finished_at, NOW);
});

test('players: arbitrary thrown values are preserved without diagnostic serialization', async t => {
  const original = { payload: SECRET.repeat(10000), toString() { throw new Error('must not stringify'); } };
  const { DB, env, fetch } = setup(t);
  fetch.mock.mockImplementation(async () => { throw original; });
  await assert.rejects(runPlayerState(env, NOW), error => error === original);
  assert.equal(DB.rows[0].error, 'WORK_FAILED');
  assert.ok(DB.updates[0][3].length < 32);
});

test('players: later state batch failure leaves earlier committed work represented honestly', async t => {
  const original = new Error('second batch');
  const payload = Object.fromEntries(Array.from({ length: 76 }, (_, i) => [String(i), player]));
  const { DB, env } = setup(t, { batchError: original, failBatch: 2 }, payload);
  await assert.rejects(runPlayerState(env, NOW), e => e === original);
  assert.deepEqual(DB.batches.map(x => x.length), [75, 1]); assert.equal(DB.writes.length, 75);
  assert.equal(DB.rows[0].ok, 0); assert.equal(DB.rows[0].finished_at, NOW);
});

test('trending: normal work order, seven windows and event semantics remain intact', async t => {
  const { DB, env, fetch } = setup(t, { previous: [{ player_id: '1', adds_1h: 10, drops_1h: 8 }] }, [{ player_id: '1', count: 30 }]);
  assert.deepEqual(await runTrending(env, NOW, 'scheduled'), { ok: true, captured_at: NOW, players: 1 });
  assert.equal(fetch.mock.callCount(), 7);
  assert.deepEqual(DB.order, ['start', 'prune', 'batch', 'evidence', 'evidence', 'finalize']);
  assert.equal(DB.rows[0].item_count, 1); assert.equal(DB.rows[0].run_type, 'trending:scheduled');
});

test('trending: evidence failure retains snapshots, closes failed run', async t => {
  const original = new Error(SECRET);
  const { DB, env } = setup(t, { evidenceError: original, previous: [{ player_id: '1', adds_1h: 0 }] }, [{ player_id: '1', count: 30 }]);
  await assert.rejects(runTrending(env, NOW), e => e === original);
  assert.equal(DB.snapshots.length, 1); assert.equal(DB.rows[0].ok, 0); assert.equal(DB.rows[0].finished_at, NOW);
});

test('scheduled: ordinary error still rejects registered waitUntil after durable failure', async t => {
  const original = new Error(SECRET);
  const { DB, env, fetch } = setup(t);
  fetch.mock.mockImplementation(async () => { throw original; });
  const pending = [];
  await worker.scheduled({ cron: '17 4 * * *' }, env, { waitUntil(p) { pending.push(p); } });
  assert.equal(pending.length, 1); await assert.rejects(pending[0], e => e === original);
  assert.equal(DB.rows[0].run_type, 'player_state:scheduled'); assert.equal(DB.rows[0].finished_at, NOW);
});

test('scheduled: trending cron and debug/internal run types remain unchanged', async t => {
  const { DB, env } = setup(t, {}, []);
  const pending = [];
  await worker.scheduled({ cron: '*/15 * * * *' }, env, { waitUntil(p) { pending.push(p); } });
  await Promise.all(pending);
  await runTrending(env, NOW, 'debug'); await runPlayerState(env, NOW, 'internal');
  assert.deepEqual(DB.rows.map(x => x.run_type), ['trending:scheduled', 'trending:debug', 'player_state']);
});

async function feed(env) {
  const response = await worker.fetch(new Request('https://local.invalid/companion-feed'), env);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  return response.json();
}
const closed = (id, type, age = 0) => ({ ...openRun(id, type), started_at: NOW-age, finished_at: NOW, ok: 1 });

test('gate: higher scheduled IDs override older open rows; zero items remain PASS-capable', async t => {
  const { env, DB, fetch } = setup(t, { rows: [openRun(), closed(2, 'player_state:scheduled'), closed(3, 'trending:scheduled')] });
  const body = await feed(env);
  assert.equal(body.gate.overall, 'PASS'); assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(Object.keys(body), ['schema','generatedAt','watcherVersion','gate','league','freeAgency','events','market']);
  assert.equal(body.schema, 'draft-companion.watcher-feed.v2'); assert.equal(body.watcherVersion, '0.2.6');
  assert.deepEqual(body.gate.trending, { started_at: NOW, finished_at: NOW, ok: true, item_count: 0 });
  DB.rows.push(openRun(4, 'trending:scheduled'));
  assert.equal((await feed(env)).gate.overall, 'FAIL');
  DB.rows[3].finished_at = NOW; assert.equal((await feed(env)).gate.overall, 'FAIL');
  DB.rows.push(closed(5, 'trending:debug')); assert.equal((await feed(env)).gate.overall, 'FAIL');
});

for (const [type, threshold] of [['trending:scheduled', 45*60000], ['player_state:scheduled', 36*3600000]]) {
  test(`gate: ${type} exact age boundary unchanged`, async t => {
    const { DB, env } = setup(t, { rows: [closed(1,'trending:scheduled'), closed(2,'player_state:scheduled')] });
    const row = DB.rows.find(x => x.run_type === type);
    row.started_at = NOW-threshold; assert.equal((await feed(env)).gate.overall, 'PASS');
    row.started_at--; assert.equal((await feed(env)).gate.overall, 'STALE');
    row.started_at = NOW+1; assert.equal((await feed(env)).gate.overall, 'STALE');
  });
}
