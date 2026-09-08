import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runTrending, evidenceFingerprint } from '../src/index.js';

const HOUR = 3600000;
const AT = 1788850862324;
const BEFORE = AT - 900000;
const WINDOWS = ['add/1', 'add/3', 'add/6', 'add/24', 'drop/1', 'drop/6', 'drop/24'];
const SNAPSHOT = ['captured_at','player_id','adds_1h','adds_3h','adds_6h','adds_24h','drops_1h','drops_6h','drops_24h'];
const CURRENT = ['player_id','adds_1h','adds_3h','adds_24h','drops_1h','drops_6h','drops_24h'];
const PREVIOUS = ['player_id','adds_1h','drops_1h'];
const EVIDENCE = ['fingerprint','player_id','event_type','fundamental_or_market','occurred_at','first_seen_at','last_seen_at','source','original_source','authority','confidence','thesis_link','payload_json'];
const entry = (player_id, count) => ({ player_id, count });
const previous = (player_id, adds_1h = 10, drops_1h = 8) => ({ captured_at: BEFORE, player_id, adds_1h, drops_1h });

// Models only the statements this run uses, including projection, retention and UPSERT.
// No SQL engine, network, credentials or Cloudflare binding is used.
function fixture(t, options = {}) {
  t.mock.method(Date, 'now', () => AT);
  const calls = { requests: [], prepares: 0, binds: 0, runs: 0, active: 0, maxActive: 0, batches: [], selects: [], order: [], deletes: [] };
  const snapshots = [...(options.previous || [])];
  const events = new Map();
  const runRows = [];
  const injected = new Error('synthetic work failure');
  const fail = stage => { if (options.fail === stage) throw injected; };
  const DB = {
    prepare(raw) {
      const sql = raw.replace(/\s+/g, ' ').trim();
      const isEvidence = sql.startsWith('INSERT INTO evidence_events');
      if (isEvidence) {
        fail('prepareEvidence'); calls.prepares++;
        assert.equal(sql, `INSERT INTO evidence_events(${EVIDENCE.join(',')}) VALUES(${EVIDENCE.map((_,i) => `?${i+1}`).join(',')}) ON CONFLICT(fingerprint) DO UPDATE SET last_seen_at=excluded.last_seen_at`);
      }
      const statement = (args = []) => ({
        sql, args,
        bind(...values) {
          if (isEvidence) { fail('bindEvidence'); calls.binds++; }
          return statement(values);
        },
        async first() {
          if (sql.startsWith('INSERT INTO watcher_runs')) {
            const row = { id: runRows.length+1, run_type: args[0], started_at: args[1], finished_at: null, ok: 0, item_count: 0, error: null };
            runRows.push(row); calls.order.push('start'); return { id: row.id };
          }
          if (sql === 'SELECT captured_at FROM trending_snapshots WHERE captured_at < ?1 ORDER BY captured_at DESC LIMIT 1') {
            calls.order.push('previousAt');
            const eligible = snapshots.filter(row => row.captured_at < args[0]);
            return eligible.length ? { captured_at: Math.max(...eligible.map(row => row.captured_at)) } : null;
          }
          throw new Error(`Unexpected first: ${sql}`);
        },
        async all() {
          const match = /^SELECT ([a-z0-9_,]+) FROM trending_snapshots WHERE captured_at=\?1$/.exec(sql);
          assert.ok(match, `Unexpected SELECT: ${sql}`);
          const columns = match[1].split(',');
          const stage = columns.length === 7 ? 'currentSelect' : 'previousSelect';
          calls.selects.push({ columns, at: args[0] }); calls.order.push(stage); fail(stage);
          return { results: snapshots.filter(row => row.captured_at === args[0]).map(row => Object.fromEntries(columns.map(key => [key, row[key]]))) };
        },
        async run() {
          if (sql.startsWith('UPDATE watcher_runs')) {
            calls.order.push('finish');
            assert.ok(sql.endsWith('WHERE id=?5 AND finished_at IS NULL'));
            const row = runRows.find(row => row.id === args[4] && row.finished_at === null);
            if (!row) return { success: true, meta: { changes: 0 } };
            Object.assign(row, { finished_at: args[0], ok: args[1], item_count: args[2], error: args[3] });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('DELETE FROM trending_snapshots')) {
            calls.order.push('retention'); fail('retention');
            assert.equal(sql, 'DELETE FROM trending_snapshots WHERE rowid IN ( SELECT rowid FROM trending_snapshots WHERE captured_at < ?1 ORDER BY captured_at ASC LIMIT ?2 )');
            const victims = snapshots.filter(row => row.captured_at < args[0]).sort((a,b) => a.captured_at-b.captured_at).slice(0,args[1]);
            for (const row of victims) snapshots.splice(snapshots.indexOf(row),1);
            calls.deletes.push({ args, count: victims.length });
            return { success: true, meta: { changes: victims.length } };
          }
          assert.ok(isEvidence, `Unexpected run: ${sql}`);
          calls.order.push('evidence'); calls.runs++; calls.active++;
          calls.maxActive = Math.max(calls.maxActive, calls.active);
          try {
            await Promise.resolve(); fail('evidence');
            const event = Object.fromEntries(EVIDENCE.map((key,i) => [key,args[i]]));
            const old = events.get(event.fingerprint);
            if (old) old.last_seen_at = event.last_seen_at;
            else events.set(event.fingerprint, event);
            return { success: true, meta: { changes: 1 } };
          } finally { calls.active--; }
        }
      });
      return statement();
    },
    async batch(statements) {
      calls.order.push('snapshotBatch'); calls.batches.push(statements); fail('batch');
      for (const stmt of statements) {
        assert.equal(stmt.sql, `INSERT INTO trending_snapshots(${SNAPSHOT.join(',')}) VALUES(${SNAPSHOT.map((_,i) => `?${i+1}`).join(',')})`);
        snapshots.push(Object.fromEntries(SNAPSHOT.map((key,i) => [key,stmt.args[i]])));
      }
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    }
  };
  let windows = options.windows || {};
  t.mock.method(globalThis, 'fetch', async url => {
    calls.requests.push(url); fail('sleeper');
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.sleeper.app');
    const type = parsed.pathname.split('/').at(-1);
    assert.equal(parsed.searchParams.get('limit'), '200');
    const key = `${type}/${parsed.searchParams.get('lookback_hours')}`;
    assert.ok(WINDOWS.includes(key));
    return { ok: true, json: async () => windows[key] || [] };
  });
  return { env: { DB, TREND_LIMIT: '200' }, calls, snapshots, events, runRows, injected, setWindows(value) { windows = value; } };
}

test('seven windows preserve ID insertion order, duplicate overwrite and exact snapshots', async t => {
  const windows = {
    'add/1': [entry('b',1),entry('a',2),entry('b',3)], 'add/3': [entry('c',4),entry('a',5)],
    'add/6': [entry('d',6)], 'add/24': [entry('e',7)], 'drop/1': [entry('f',8)],
    'drop/6': [entry('g',9)], 'drop/24': [entry('h',10),entry('b',11)]
  };
  const f = fixture(t, { windows });
  const out = await runTrending(f.env, AT, 'scheduled');
  assert.equal(out.players, 8);
  assert.deepEqual(f.calls.requests.map(url => { const u = new URL(url); return `${u.pathname.split('/').at(-1)}/${u.searchParams.get('lookback_hours')}`; }), WINDOWS);
  assert.deepEqual(f.snapshots, [
    [AT,'b',3,0,0,0,0,0,11], [AT,'a',2,5,0,0,0,0,0], [AT,'c',0,4,0,0,0,0,0],
    [AT,'d',0,0,6,0,0,0,0], [AT,'e',0,0,0,7,0,0,0], [AT,'f',0,0,0,0,8,0,0],
    [AT,'g',0,0,0,0,0,9,0], [AT,'h',0,0,0,0,0,0,10]
  ].map(args => Object.fromEntries(SNAPSHOT.map((key,i) => [key,args[i]]))));
  assert.equal(f.calls.prepares, 0);
  assert.deepEqual(f.calls.selects, [{ columns: CURRENT, at: AT }]);
  assert.equal(f.runRows[0].ok, 1);
});

test('disjoint seven 200-player windows preserve all 1400 IDs in first-insertion order', async t => {
  const windows = Object.fromEntries(WINDOWS.map((key,w) => [key, Array.from({ length: 200 }, (_,i) => entry(`${w}:${i}`,i+1))]));
  const f = fixture(t, { windows });
  assert.equal((await runTrending(f.env, AT)).players, 1400);
  assert.equal(f.calls.batches.length, 1); assert.equal(f.calls.batches[0].length, 1400);
  assert.deepEqual(f.snapshots.map(row => row.player_id), WINDOWS.flatMap((_,w) => Array.from({ length: 200 }, (_,i) => `${w}:${i}`)));
});

test('zero IDs skips snapshot batch and evidence prepare, succeeds with zero count', async t => {
  const f = fixture(t);
  await runTrending(f.env, AT);
  assert.equal(f.calls.batches.length, 0); assert.equal(f.calls.prepares, 0);
  assert.equal(f.runRows[0].ok, 1); assert.equal(f.runRows[0].item_count, 0);
});

test('no previous capture suppresses evidence even with high counts', async t => {
  const f = fixture(t, { windows: { 'add/1': [entry('1',100)], 'drop/1': [entry('1',100)] } });
  await runTrending(f.env, AT);
  assert.equal(f.calls.selects.length, 1); assert.equal(f.calls.prepares, 0); assert.equal(f.calls.runs, 0);
});

test('projected numeric previous ID matches string current ID and both payloads remain exact', async t => {
  const f = fixture(t, { previous: [previous(1)], windows: {
    'add/1': [entry('1',25)], 'add/3': [entry('1',31)], 'add/24': [entry('1',241)],
    'drop/1': [entry('1',20)], 'drop/6': [entry('1',61)], 'drop/24': [entry('1',242)]
  } });
  await runTrending(f.env, AT);
  assert.deepEqual(f.calls.selects, [{ columns: CURRENT, at: AT }, { columns: PREVIOUS, at: BEFORE }]);
  const [accel, reversal] = [...f.events.values()];
  assert.deepEqual(JSON.parse(accel.payload_json), { adds_1h:25, previous_adds_1h:10, acceleration:15, adds_3h:31, adds_24h:241 });
  assert.deepEqual(JSON.parse(reversal.payload_json), { drops_1h:20, previous_drops_1h:8, acceleration:12, drops_6h:61, drops_24h:242 });
  for (const [event,type,confidence] of [[accel,'MARKET_ACCELERATION',0.95],[reversal,'MARKET_REVERSAL',0.9]]) {
    assert.deepEqual({ ...event, fingerprint: undefined, payload_json: undefined }, {
      fingerprint: undefined, payload_json: undefined, player_id:'1', event_type:type, fundamental_or_market:'market',
      occurred_at:AT, first_seen_at:AT, last_seen_at:AT, source:'Sleeper Trending', original_source:'Sleeper Trending',
      authority:0.95, confidence, thesis_link:'market_recognition'
    });
  }
  assert.equal(f.calls.prepares, 1); assert.equal(f.calls.binds, 2); assert.equal(f.calls.runs, 2); assert.equal(f.calls.maxActive, 1);
});

for (const [name,add,drop,oldAdd,oldDrop,expected] of [
  ['unchanged',25,20,25,20,0], ['below counts',24,19,0,0,0], ['below deltas',25,20,11,9,0],
  ['add boundary',25,0,10,0,1], ['drop boundary',0,20,0,8,1], ['both boundaries',25,20,10,8,2]
]) {
  test(`market thresholds: ${name}`, async t => {
    const f = fixture(t, { previous:[previous('1',oldAdd,oldDrop)], windows:{ 'add/1':[entry('1',add)], 'drop/1':[entry('1',drop)] } });
    await runTrending(f.env, AT);
    assert.equal(f.events.size, expected); assert.equal(f.calls.prepares, expected ? 1 : 0);
    assert.equal(f.calls.binds, expected); assert.equal(f.calls.runs, expected);
  });
}

test('200 players produce 400 serial events with one prepared evidence statement', async t => {
  const ids = Array.from({length:200},(_,i) => String(i));
  const f = fixture(t, { previous:ids.map(id => previous(id)), windows:{ 'add/1':ids.map(id => entry(id,25)), 'drop/1':ids.map(id => entry(id,20)) } });
  await runTrending(f.env, AT);
  assert.equal(f.events.size, 400); assert.equal(f.calls.prepares, 1);
  assert.equal(f.calls.binds, 400); assert.equal(f.calls.runs, 400); assert.equal(f.calls.maxActive, 1);
  assert.deepEqual([...f.events.values()].map(e => [e.player_id,e.event_type]), ids.flatMap(id => [[id,'MARKET_ACCELERATION'],[id,'MARKET_REVERSAL']]));
});

test('retention deletes at most 100 oldest rows and preserves immediately preceding capture', async t => {
  const backlog = Array.from({length:120},(_,i) => ({...previous(`old${i}`),captured_at: BEFORE-1000-i}));
  const f = fixture(t, { previous:[...backlog,previous('keep')], windows:{'add/1':[entry('keep',10)]} });
  await runTrending(f.env, AT);
  assert.deepEqual(f.calls.deletes, [{ args:[BEFORE,100], count:100 }]);
  assert.equal(f.snapshots.filter(row => row.captured_at < BEFORE).length, 20);
  assert.ok(f.snapshots.some(row => row.captured_at === BEFORE));
  assert.ok(f.calls.order.indexOf('retention') < f.calls.order.indexOf('snapshotBatch'));
});

test('fingerprint matches independent original identity encoding, same hour stable, next hour distinct', async () => {
  const event = {player_id:'1',event_type:'MARKET_ACCELERATION',fundamental_or_market:'market',occurred_at:AT,original_source:'Sleeper Trending'};
  const expected = createHash('sha256').update(JSON.stringify(['1','MARKET_ACCELERATION',Math.floor(AT/HOUR),'Sleeper Trending'])).digest('hex');
  assert.equal(await evidenceFingerprint(event), expected);
  assert.match(expected,/^[0-9a-f]{64}$/);
  assert.equal(await evidenceFingerprint({...event,occurred_at:AT+60000,payload:{different:true}}), expected);
  assert.notEqual(await evidenceFingerprint({...event,occurred_at:(Math.floor(AT/HOUR)+1)*HOUR}), expected);
});

test('same-hour repeated event refreshes only last_seen_at; preparation is scoped per detection', async t => {
  const f = fixture(t, { previous:[previous('1')], windows:{'add/1':[entry('1',25)]} });
  await runTrending(f.env, AT);
  const before = {...[...f.events.values()][0]};
  f.setWindows({'add/1':[entry('1',40)]});
  await runTrending(f.env, AT+60000);
  assert.equal(f.events.size, 1);
  assert.deepEqual([...f.events.values()][0], {...before,last_seen_at:AT+60000});
  assert.equal(f.calls.prepares, 2); assert.equal(f.calls.binds, 2); assert.equal(f.calls.runs, 2);
});

for (const stage of ['sleeper','batch','currentSelect','previousSelect','retention','prepareEvidence','bindEvidence','evidence']) {
  test(`${stage} error preserves merged work-error/finalization semantics`, async t => {
    const f = fixture(t, { fail:stage, previous:[previous('1')], windows:{'add/1':[entry('1',25)]} });
    await assert.rejects(runTrending(f.env, AT, 'scheduled'), error => error === f.injected);
    assert.equal(f.runRows[0].finished_at, AT); assert.equal(f.runRows[0].ok, 0);
    assert.equal(f.runRows[0].error, 'WORK_FAILED'); assert.equal(f.runRows[0].item_count, 0);
    assert.equal(f.calls.order.filter(x => x === 'finish').length, 1);
    if (['prepareEvidence','bindEvidence','evidence'].includes(stage)) assert.ok(f.snapshots.some(row => row.captured_at === AT));
  });
}
