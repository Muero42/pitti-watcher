// Local-only: node tools/local-d1-outbox-calibration.mjs [path/to/wrangler/package.json]
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync, mkdtempSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {BILLABLE_WRITE_ESTIMATES, d1Usage, reserveDailyWriteBudget, settleWriteBudget,
  abandonUnusedWriteBudget, writeBudgetLimit} from '../src/write-budget.js';

// No repository Wrangler config, credentials, persistent database or remote binding.
process.env.WRANGLER_SEND_METRICS = 'false';
process.env.WRANGLER_LOG_PATH = join(mkdtempSync(join(tmpdir(), 'pitti-d1-log-')), 'wrangler.log');
const require = createRequire(import.meta.url);
const packagePath = realpathSync(process.argv[2] ? resolve(process.argv[2]) : require.resolve('wrangler/package.json'));
const runtimeRequire = createRequire(packagePath);
const {Miniflare, convertV4MiniflareOptions} = runtimeRequire('miniflare');
const {unstable_splitSqlQuery: splitSql} = runtimeRequire(packagePath.replace(/package\.json$/, 'wrangler-dist/cli.js'));
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const versions = {
  wrangler: JSON.parse(readFileSync(packagePath, 'utf8')).version,
  miniflare: runtimeRequire('miniflare/package.json').version
};
const localOptions = {
  modules: true, script: 'export default {fetch(){return new Response("local calibration only")}}',
  compatibilityDate: '2025-08-03', cf: false,
  d1Databases: {DB: 'pitti-disposable-outbox-calibration'}, d1Persist: false,
  outboundService() { throw new Error('NETWORK_DISABLED'); }
};
// Miniflare 5 exposes an explicit adapter for the established v4 local options.
const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(localOptions) : localOptions);
const report = {verdict: 'CALIBRATION_INCONCLUSIVE', versions, cases: []};
function metadata(result) {
  const usage = d1Usage(result);
  return {queries: usage.queries, rows_read: usage.rowsRead, rows_written: usage.rowsWritten,
    sql_ms: usage.sqlDurationMs};
}
try {
  const db = await mf.getD1Database('DB');
  // Preserve the existing relevant tables AND indexes, without unrelated domain tables.
  const schema = ['migrations/0001_init.sql', 'migrations/0003_chunked_player_state_and_market_frames.sql']
    .flatMap(path => splitSql(read(path)))
    .filter(sql => /^(CREATE TABLE IF NOT EXISTS (watcher_runs|evidence_events)\s|CREATE INDEX IF NOT EXISTS idx_(evidence_|watcher_runs_)|ALTER TABLE evidence_events)/.test(sql.trim()));
  assert.equal(schema.length, 7, 'Review schema selection if existing migrations change');
  for (const sql of [...schema, ...splitSql(read('docs/sql/write_budget_alert_outbox_preview.sql'))]) {
    assert.equal((await db.prepare(sql).run()).success, true);
  }
  const insert = `INSERT INTO evidence_events(
    fingerprint,player_id,event_type,fundamental_or_market,occurred_at,first_seen_at,last_seen_at,
    source,original_source,authority,confidence,payload_json,observation_run_id
  ) VALUES(?1,'fixture-player','PLAYER_STATE_CHANGED','fundamental',100,100,100,
    'fixture','fixture',1,1,'{}',1) ON CONFLICT(fingerprint) DO NOTHING`;
  for (const n of [0, 1, 3]) {
    // Equivalent empty fixtures inside the single disposable instance; reset sequences too.
    for (const table of ['alert_outbox', 'evidence_events', 'watcher_runs']) {
      await db.prepare(`DELETE FROM ${table}`).run();
    }
    await db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('alert_outbox','evidence_events','watcher_runs')").run();
    await db.prepare("INSERT INTO watcher_runs(id,run_type,started_at) VALUES(1,'player_state:scheduled',100)").run();
    const item = {evidence_count: n, evidence_inserts: []};
    report.cases.push(item);
    for (let i = 0; i < n; i++) item.evidence_inserts.push(metadata(await db.prepare(insert).bind(`fixture-${i}`).run()));
    if (n === 3) item.duplicate_insert = metadata(await db.prepare(insert).bind('fixture-0').run());
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM evidence_events WHERE observation_run_id=1').first()).n, n);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM alert_outbox').first()).n,0,'open observation never becomes pending');
    item.finalization = metadata(await db.prepare(
      'UPDATE watcher_runs SET finished_at=?1,ok=1,item_count=?2,error=NULL WHERE id=?3 AND finished_at IS NULL'
    ).bind(200, n, 1).run());
    const rows = (await db.prepare('SELECT evidence_fingerprint,status FROM alert_outbox ORDER BY evidence_fingerprint').all()).results;
    assert.equal(rows.length, n);
    assert.ok(rows.every(row => row.status === 'pending'));
    assert.equal(new Set(rows.map(row => row.evidence_fingerprint)).size, n);
    item.pending_outbox = rows.length;
  }
  const [zero, one, three] = report.cases;
  assert.equal(zero.finalization.rows_written,2,'zero-evidence finalization baseline');
  assert.equal(BILLABLE_WRITE_ESTIMATES.runFinish,zero.finalization.rows_written);
  // Exercise the actual helpers, adapting first() only to retain real D1 metadata.
  report.control_phases = [];
  let phase;
  const measuredDb = {prepare(sql) {return {bind(...args) {return {async first() {
    const result = await db.prepare(sql).bind(...args).run();
    report.control_phases.push({phase, ...metadata(result)});
    return result.results[0] ?? null;
  }}}}}};
  const at = Date.UTC(2026, 9, 3, 12);
  const reserve = async (id, writes, limit = 100, name = 'write_budget.reserve.subsequent') => {
    phase = name;
    return reserveDailyWriteBudget(measuredDb, {lane:'market',requestedWrites:writes,limitWrites:limit,at,id});
  };
  const full = await reserve('full', 30, 100, 'write_budget.reserve.first');
  const partial = await reserve('partial', 30);
  phase = 'write_budget.settle.full'; await settleWriteBudget(measuredDb, full, 30, at);
  phase = 'write_budget.settle.partial'; await settleWriteBudget(measuredDb, partial, 10, at);
  const unused = await reserve('unused', 20);
  phase = 'write_budget.abandon'; await abandonUnusedWriteBudget(measuredDb, unused, at);
  const window = () => db.prepare("SELECT reserved_writes,committed_writes FROM write_budget_windows WHERE lane='market'").first();
  assert.deepEqual(await window(), {reserved_writes:0,committed_writes:40});
  phase = 'write_budget.duplicate_terminal';
  for (const action of [() => settleWriteBudget(measuredDb, full, 30, at),
    () => abandonUnusedWriteBudget(measuredDb, unused, at),
    () => abandonUnusedWriteBudget(measuredDb, full, at)]) await assert.rejects(action);
  assert.deepEqual(await window(), {reserved_writes:0,committed_writes:40}, 'no double release');
  await assert.rejects(reserve('mismatch', 1, 101), error => error.cause?.message.includes('WRITE_BUDGET_CONFIG_MISMATCH'));
  for (const limit of [undefined,null,0,-1,NaN,Infinity,'invalid']) {
    assert.throws(() => writeBudgetLimit({D1_MARKET_DAILY_WRITE_BUDGET:limit}, 'market'));
    await assert.rejects(reserve('invalid',1,limit === undefined ? NaN : limit));
  }
  const held = await reserve('held', 60);
  await assert.rejects(reserve('exhausted',1), {code:'WRITE_BUDGET_EXCEEDED'});
  await assert.rejects(settleWriteBudget(measuredDb,held,61,at), {code:'WRITE_BUDGET_SETTLEMENT_INVALID'});
  await assert.rejects(db.prepare("UPDATE write_budget_reservations SET status='committed',committed_writes=61 WHERE reservation_id='held'").run());
  // Modeled caller: only unused reservations may be abandoned. Once a domain
  // write is attempted, ambiguous outcomes hold allowance for reconciliation.
  let attempted = false;
  const releaseUnused = () => {
    assert.equal(attempted,false,'domain attempt prohibits automatic release');
    return abandonUnusedWriteBudget(measuredDb,held,at);
  };
  assert.equal((await db.prepare("SELECT status FROM write_budget_reservations WHERE reservation_id='held'").first()).status,'reserved');
  attempted = true; // reservation above precedes this real disposable domain write
  await db.prepare("INSERT INTO watcher_runs(run_type,started_at) VALUES('fixture:domain',100)").run();
  assert.throws(releaseUnused);
  assert.equal((await db.prepare("SELECT status FROM write_budget_reservations WHERE reservation_id='held'").first()).status,'reserved');
  assert.deepEqual(await window(), {reserved_writes:60,committed_writes:40});
  const boundary = await Promise.allSettled([reserve('race-a',1),reserve('race-b',1)]);
  assert.ok(boundary.every(result => result.status==='rejected' && result.reason.code==='WRITE_BUDGET_EXCEEDED'));
  phase = 'write_budget.reserve.concurrent_first';
  const concurrent = await Promise.allSettled(['concurrent-a','concurrent-b'].map(id =>
    reserveDailyWriteBudget(measuredDb,{lane:'player_state',requestedWrites:6,limitWrites:10,at,id})));
  assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(concurrent.filter(r=>r.status==='rejected'&&r.reason.code==='WRITE_BUDGET_EXCEEDED').length,1);
  const actualCosts = report.control_phases.slice(0,6);
  assert.deepEqual(actualCosts.map(x=>[x.phase,x.queries,x.rows_read,x.rows_written]),[
    ['write_budget.reserve.first',1,6,5],['write_budget.reserve.subsequent',1,6,4],
    ['write_budget.settle.full',1,4,3],['write_budget.settle.partial',1,4,3],
    ['write_budget.reserve.subsequent',1,6,4],['write_budget.abandon',1,4,3]
  ]);
  const overhead = Math.max(actualCosts[0].rows_written,actualCosts[1].rows_written)
    + Math.max(...actualCosts.slice(2).filter(x=>!x.phase.includes('reserve')).map(x=>x.rows_written));
  assert.ok(BILLABLE_WRITE_ESTIMATES.budgetControl>=overhead);
  report.control_envelope={reservation_plus_one_terminal:overhead,estimate:BILLABLE_WRITE_ESTIMATES.budgetControl,
    margin:BILLABLE_WRITE_ESTIMATES.budgetControl-overhead};
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM write_budget_reservations WHERE committed_writes>reserved_writes').first()).n,0);
  report.fail_closed_semantics = 'PASS';
  const baseline = zero.finalization.rows_written;
  const incremental = one.finalization.rows_written - baseline;
  const evidence = one.evidence_inserts[0].rows_written;
  // Reject placeholder counters or unexplained/nonlinear metadata rather than guessing.
  assert.ok(baseline > 0 && incremental > 0 && evidence > 0, 'D1 counters do not measure known writes');
  assert.equal(three.finalization.rows_written - baseline, 3 * incremental, 'Nonlinear outbox write cost');
  assert.ok(three.evidence_inserts.every(meta => meta.rows_written === evidence));
  report.incremental_outbox_rows_written = incremental;
  report.evidence_plus_outbox_rows_written = evidence + incremental;
  report.estimate = BILLABLE_WRITE_ESTIMATES.evidenceWithOutbox;
  assert.equal(evidence + incremental,9);
  report.verdict = report.estimate >= evidence + incremental
    ? 'RESERVATION_SETTLEMENT_CALIBRATION_PASS'
    : 'CALIBRATION_INCONCLUSIVE';
  if (report.estimate < evidence + incremental) {
    report.reason = `Estimate ${report.estimate} is below measured cost ${evidence + incremental}`;
    process.exitCode = 1;
  }
} catch (error) {
  report.reason = String(error.message);
  process.exitCode = 1;
} finally {
  try { await mf.dispose(); }
  catch (error) {
    report.verdict = 'CALIBRATION_INCONCLUSIVE';
    report.dispose_error = String(error.message);
    process.exitCode = 1;
  }
  console.log(JSON.stringify(report, null, 2));
}
