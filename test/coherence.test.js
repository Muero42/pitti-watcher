import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {acceptedEvidenceSql} from '../src/index-v027.js';

function database({preview=false}={}){
  const db=new DatabaseSync(':memory:');
  for(const file of [
    'migrations/0001_init.sql',
    'migrations/0002_player_state_sweeps.sql',
    'migrations/0003_chunked_player_state_and_market_frames.sql',
    'migrations/0004_player_state_scope_frames.sql',
    ...(preview?['docs/sql/write_budget_alert_outbox_preview.sql']:[])
  ])db.exec(readFileSync(file,'utf8'));
  return db;
}

function insertEvidence(db,{fingerprint,runId=null,seen}){
  db.prepare(`
    INSERT INTO evidence_events(
      fingerprint,event_type,fundamental_or_market,first_seen_at,last_seen_at,
      source,original_source,authority,confidence,payload_json,observation_run_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `).run(fingerprint,'TEST','fundamental',seen,seen,'test','test',1,1,'{}',runId);
}

test('accepted evidence query preserves legacy rows and permanently hides open or failed observations',()=>{
  const db=database();
  db.exec(`
    INSERT INTO watcher_runs(id,run_type,started_at,finished_at,ok) VALUES
      (1,'player_state:scheduled',100,110,0),
      (2,'player_state:scheduled',200,NULL,0),
      (3,'player_state:scheduled',300,310,1);
  `);
  insertEvidence(db,{fingerprint:'failed',runId:1,seen:100});
  insertEvidence(db,{fingerprint:'open',runId:2,seen:200});
  insertEvidence(db,{fingerprint:'accepted',runId:3,seen:300});
  insertEvidence(db,{fingerprint:'legacy',seen:50});
  const rows=db.prepare(acceptedEvidenceSql()).all();
  assert.deepEqual(rows.map(row=>row.observation_run_id),[3,null]);
});

test('preview outbox is populated only by successful run finalization',()=>{
  const db=database({preview:true});
  db.exec(`INSERT INTO watcher_runs(id,run_type,started_at,finished_at,ok) VALUES(1,'player_state:scheduled',100,NULL,0)`);
  insertEvidence(db,{fingerprint:'candidate',runId:1,seen:100});
  assert.equal(db.prepare('SELECT COUNT(*) count FROM alert_outbox').get().count,0);
  db.exec(`UPDATE watcher_runs SET finished_at=110,ok=0,error='WORK_FAILED' WHERE id=1`);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM alert_outbox').get().count,0);

  db.exec(`INSERT INTO watcher_runs(id,run_type,started_at,finished_at,ok) VALUES(2,'player_state:scheduled',200,NULL,0)`);
  insertEvidence(db,{fingerprint:'accepted',runId:2,seen:200});
  db.exec(`UPDATE watcher_runs SET finished_at=210,ok=1 WHERE id=2`);
  assert.deepEqual(db.prepare('SELECT evidence_fingerprint,status FROM alert_outbox').all().map(row=>({...row})),[
    {evidence_fingerprint:'accepted',status:'pending'}
  ]);
});

test('preview outbox capacity aborts acceptance atomically and missing policy fails closed',()=>{
  const db=database({preview:true});
  db.exec(`UPDATE alert_outbox_policy SET max_pending=1 WHERE singleton_id=1`);
  db.exec(`INSERT INTO watcher_runs(id,run_type,started_at,finished_at,ok) VALUES(1,'player_state:scheduled',100,NULL,0)`);
  insertEvidence(db,{fingerprint:'first',runId:1,seen:100});
  insertEvidence(db,{fingerprint:'second',runId:1,seen:100});
  assert.throws(()=>db.exec(`UPDATE watcher_runs SET finished_at=110,ok=1 WHERE id=1`),/ALERT_OUTBOX_PENDING_LIMIT/);
  assert.equal(db.prepare('SELECT finished_at FROM watcher_runs WHERE id=1').get().finished_at,null);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM alert_outbox').get().count,0);

  db.exec(`DELETE FROM alert_outbox_policy WHERE singleton_id=1`);
  assert.throws(()=>db.exec(`UPDATE watcher_runs SET finished_at=110,ok=1 WHERE id=1`),/ALERT_OUTBOX_POLICY_MISSING/);
  db.close();
});
