// Regression replacing the former unbounded-retention characterization.
// SQLite row counts below prove cardinality, NOT Cloudflare billed writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index-v029.js';

for(const backlog of [3,72001])test(`active Market bounds completed-frame retention for backlog ${backlog}`,async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  for(const name of ['0001_init.sql','0002_player_state_sweeps.sql',
    '0003_chunked_player_state_and_market_frames.sql','0004_player_state_scope_frames.sql',
    '0005_player_state_invocation_ledger.sql']) {
    db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  // Completed failed runs may leave a large backlog. One call must never drain
  // more than 64 frames; unfinished runs are never retention targets.
  db.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<${backlog+1})
    INSERT INTO watcher_runs(id,run_type,started_at,finished_at,ok)
    SELECT n,'trending:scheduled',n,n+1,CASE WHEN n=${backlog+1} THEN 1 ELSE 0 END FROM seq;
    INSERT INTO trending_snapshot_frames(captured_at,run_id,player_count,frame_json,signal_state_json)
    SELECT id,id,0,'[]','[]' FROM watcher_runs;`);
  const trace=[];let deleted=0;
  const prepare=(sql,args=[])=>({
    bind(...values){return prepare(sql,values);},
    async first(){trace.push({kind:'sql',sql});return db.prepare(sql).get(...args)??null;},
    async all(){trace.push({kind:'sql',sql});return {results:db.prepare(sql).all(...args)};},
    async run(){
      trace.push({kind:'sql',sql});const result=db.prepare(sql).run(...args);
      if(/DELETE FROM trending_snapshot_frames/.test(sql))deleted=Number(result.changes);
      return {success:true,meta:{changes:Number(result.changes)}};
    }
  });
  t.mock.method(globalThis,'fetch',async()=>{
    trace.push({kind:'fetch'});return new Response('[]',{status:200});
  });
  t.mock.method(Date,'now',()=>backlog+2);
  const pending=[];
  await worker.scheduled({cron:'*/15 * * * *'},
    {DB:{prepare,async batch(){throw new Error('No evidence expected for empty source');}}},
    {waitUntil(p){pending.push(p);}});
  const [result]=await Promise.all(pending);
  assert.equal(result.ok,true);
  assert.match(trace[0].sql,/INSERT INTO watcher_runs/,'first domain write precedes source/preflight');
  assert.ok(trace.findIndex(x=>x.kind==='fetch')>0);
  assert.equal(deleted,Math.min(backlog,64));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trending_snapshot_frames').get().n,backlog+2-Math.min(backlog,64));
  const prune=trace.find(x=>x.sql?.includes('DELETE FROM trending_snapshot_frames'));
  assert.match(prune.sql,/LIMIT 64/);
  assert.equal(db.prepare('SELECT ok FROM watcher_runs ORDER BY id DESC LIMIT 1').get().ok,1);
  assert.ok(db.prepare('SELECT 1 FROM trending_snapshot_frames WHERE captured_at=?').get(backlog+1),'previous accepted frame retained');
  assert.ok(db.prepare('SELECT 1 FROM trending_snapshot_frames WHERE captured_at=?').get(backlog+2),'new frame retained');
});

// Use the exact active DELETE, with real SQLite transaction/selection behavior.
test('retention protects open/current frames, drains oldest completed frames, and rolls back errors',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const name of ['0001_init.sql','0002_player_state_sweeps.sql','0003_chunked_player_state_and_market_frames.sql','0004_player_state_scope_frames.sql','0005_player_state_invocation_ledger.sql'])db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const sql=source.match(/DELETE FROM trending_snapshot_frames[\s\S]*?(?=`)/)?.[0];assert.ok(sql);
 db.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<132)
 INSERT INTO watcher_runs(id,run_type,started_at,finished_at,ok)
 SELECT n,'trending:scheduled',n,CASE WHEN n IN (1,2,131) THEN NULL ELSE n+1 END,CASE WHEN n%2=0 THEN 1 ELSE 0 END FROM seq;
 INSERT INTO trending_snapshot_frames SELECT id,id,0,'[]','[]' FROM watcher_runs;`);
 const snapshot=()=>db.prepare('SELECT * FROM trending_snapshot_frames ORDER BY captured_at').all();
 const before=snapshot();
 db.exec("CREATE TRIGGER prune_fault BEFORE DELETE ON trending_snapshot_frames WHEN OLD.captured_at=10 BEGIN SELECT RAISE(ABORT,'FAULT'); END;");
 assert.throws(()=>db.prepare(sql).run(130),/FAULT/);assert.deepEqual(snapshot(),before);
 db.exec('DROP TRIGGER prune_fault');
 assert.equal(Number(db.prepare(sql).run(130).changes),64);
 assert.deepEqual(snapshot().map(r=>r.captured_at),[1,2,...Array.from({length:66},(_,i)=>i+67)]);
 assert.equal(Number(db.prepare(sql).run(130).changes),63);
 assert.deepEqual(snapshot().map(r=>r.captured_at),[1,2,130,131,132]);
 assert.equal(Number(db.prepare(sql).run(130).changes),0);
 // A formerly open old run becomes eligible only after durable finalization.
 db.prepare('UPDATE watcher_runs SET finished_at=200,ok=0 WHERE id=1').run();
 assert.equal(Number(db.prepare(sql).run(130).changes),1);
 assert.deepEqual(snapshot().map(r=>r.captured_at),[2,130,131,132]);
});
