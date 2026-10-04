// Disposable local workerd only; no repository Wrangler config or auth.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {LEDGER_START_SQL,LEDGER_FINISH_SQL,LEDGER_RETENTION_SQL} from '../src/player-state-invocations.js';
const require=createRequire(import.meta.url);
const pkg=process.argv[2] ? resolve(process.argv[2]) : require.resolve('wrangler/package.json');
const runtime=createRequire(pkg);
const {Miniflare,convertV4MiniflareOptions}=runtime('miniflare');
const options={modules:true,script:'export default {fetch(){return new Response("local")}}',
  compatibilityDate:'2025-08-03',cf:false,d1Databases:{DB:'disposable-invocation-ledger'},d1Persist:false,
  outboundService(){throw new Error('NETWORK_DISABLED');}};
const mf=new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
const report={runtime:{wrangler:runtime(pkg).version,miniflare:runtime('miniflare/package.json').version},measurements:[]};
function measured(name,result){
  assert.equal(result.success,true);const m=result.meta;
  for(const field of ['rows_read','rows_written'])assert.ok(Number.isFinite(m[field]));
  const sqlMs=m.timings?.sql_duration_ms ?? m.duration;assert.ok(Number.isFinite(sqlMs));
  report.measurements.push({name,query_count:1,rows_read:m.rows_read,rows_written:m.rows_written,sql_ms:sqlMs});
}
try {
  const db=await mf.getD1Database('DB');
  const schema=readFileSync(new URL('../migrations/0005_player_state_invocation_ledger.sql',import.meta.url),'utf8');
  for(const sql of schema.split(';').filter(s=>s.trim()))await db.prepare(sql).run();
  measured('start',await db.prepare(LEDGER_START_SQL).bind('ok',100,90,'continuation').run());
  measured('finish_ok',await db.prepare(LEDGER_FINISH_SQL).bind(200,42,1,80,'ok',null,'ok').run());
  await db.prepare(LEDGER_START_SQL).bind('fail',100,90,'continuation').run();
  measured('finish_fail',await db.prepare(LEDGER_FINISH_SQL).bind(200,42,1,80,'fail','PLAYER_STATE_WORK_FAILED','fail').run());
  measured('finish_duplicate',await db.prepare(LEDGER_FINISH_SQL).bind(300,99,5,0,'ok',null,'ok').run());
  assert.equal(report.measurements.at(-1).rows_written,0);
  measured('retention_empty',await db.prepare(LEDGER_RETENTION_SQL).bind(0).run());
  await db.prepare('DELETE FROM player_state_invocations').run();
  await db.prepare(LEDGER_START_SQL).bind('old',1,null,'continuation').run();
  measured('retention_one',await db.prepare(LEDGER_RETENTION_SQL).bind(10).run());
  for(let i=0;i<513;i++)await db.prepare(LEDGER_START_SQL).bind('old'+i,1,null,'continuation').run();
  measured('retention_cap',await db.prepare(LEDGER_RETENTION_SQL).bind(10).run());
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM player_state_invocations').first()).n,1);
  report.per_invocation_writes=report.measurements[0].rows_written+Math.max(report.measurements[1].rows_written,report.measurements[2].rows_written);
  console.log(JSON.stringify(report,null,2));
} finally {await mf.dispose();}
