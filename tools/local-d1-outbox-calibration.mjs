// Local-only: node tools/local-d1-outbox-calibration.mjs [path/to/wrangler/package.json]
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync, mkdtempSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {BILLABLE_WRITE_ESTIMATES} from '../src/write-budget.js';

// No repository Wrangler config, credentials, persistent database or remote binding.
process.env.WRANGLER_SEND_METRICS = 'false';
process.env.WRANGLER_LOG_PATH = join(mkdtempSync(join(tmpdir(), 'pitti-d1-log-')), 'wrangler.log');
const require = createRequire(import.meta.url);
const packagePath = realpathSync(process.argv[2] ? resolve(process.argv[2]) : require.resolve('wrangler/package.json'));
const runtimeRequire = createRequire(packagePath);
const {Miniflare} = runtimeRequire('miniflare');
const {unstable_splitSqlQuery: splitSql} = runtimeRequire(packagePath.replace(/package\.json$/, 'wrangler-dist/cli.js'));
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const versions = {
  wrangler: JSON.parse(readFileSync(packagePath, 'utf8')).version,
  miniflare: runtimeRequire('miniflare/package.json').version
};
const mf = new Miniflare({
  modules: true, script: 'export default {fetch(){return new Response("local calibration only")}}',
  compatibilityDate: '2025-08-03', cf: false,
  d1Databases: {DB: 'pitti-disposable-outbox-calibration'}, d1Persist: false,
  outboundService() { throw new Error('NETWORK_DISABLED'); }
});
const report = {verdict: 'CALIBRATION_INCONCLUSIVE', versions, cases: []};
function metadata(result) {
  assert.equal(result.success, true);
  const meta = result.meta;
  for (const field of ['rows_read', 'rows_written']) {
    assert.ok(Number.isSafeInteger(meta?.[field]) && meta[field] >= 0, `Missing/invalid D1 ${field}`);
  }
  const duration = meta.timings?.sql_duration_ms ?? meta.duration;
  return {queries: 1, rows_read: meta.rows_read, rows_written: meta.rows_written,
    sql_ms: Number.isFinite(duration) ? duration : null};
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
  report.verdict = report.estimate >= evidence + incremental
    ? (report.estimate === 8 ? 'CALIBRATION_PASS_KEEP_8' : `CALIBRATION_PASS_RECALIBRATED_${report.estimate}`)
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
