import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {processPlayerStateSweepChunk,stateHash} from '../src/index.js';

function d1For(db){
  const prepare=(sql,args=[])=>({
    sql,args,
    bind(...values){return prepare(sql,values);},
    async first(){return db.prepare(sql).get(...args)??null;},
    async all(){return{results:db.prepare(sql).all(...args)};},
    async run(){
      const result=db.prepare(sql).run(...args);
      return{success:true,meta:{changes:Number(result.changes),rows_read:0,rows_written:Number(result.changes)}};
    }
  });
  return{
    prepare,
    async batch(statements){
      db.exec('BEGIN');
      try{
        const results=[];
        for(const statement of statements){
          const result=db.prepare(statement.sql).run(...statement.args);
          results.push({success:true,meta:{changes:Number(result.changes),rows_read:0,rows_written:Number(result.changes)}});
        }
        db.exec('COMMIT');
        return results;
      }catch(error){
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

test('active migrations and preview outbox accept the atomic set-based promotion',async()=>{
  const db=new DatabaseSync(':memory:');
  for(const path of [
    'migrations/0001_init.sql',
    'migrations/0002_player_state_sweeps.sql',
    'migrations/0003_chunked_player_state_and_market_frames.sql',
    'docs/sql/write_budget_alert_outbox_preview.sql'
  ])db.exec(readFileSync(new URL(`../${path}`,import.meta.url),'utf8'));

  const at=1790000000000;
  const oldState={full_name:'Player',team:'AAA',position:'RB',injury_status:null,practice_participation:null,depth_chart_order:1,status:'Active'};
  const nextState={...oldState,injury_status:'Questionable'};
  db.prepare(`INSERT INTO watcher_runs(id,run_type,started_at) VALUES(1,'player_state:scheduled',?1)`).run(at);
  db.prepare(`
    INSERT INTO player_state_sweeps(
      run_id,source_etag,total_entries,next_index,scope_offset,scope_etag,revalidated_at,promotion_offset,seen_count,started_at
    ) VALUES(1,'{}',5,5,0,NULL,?1,0,1,?1)
  `).run(at);
  db.prepare(`
    INSERT INTO player_state(
      player_id,full_name,team,position,injury_status,practice_participation,depth_chart_order,status,first_seen_at,last_seen_at,state_hash
    ) VALUES('p1',?1,?2,?3,?4,?5,?6,?7,?8,?8,?9)
  `).run(oldState.full_name,oldState.team,oldState.position,oldState.injury_status,oldState.practice_participation,oldState.depth_chart_order,oldState.status,at,stateHash(oldState));
  db.prepare(`
    INSERT INTO player_state_candidates(
      run_id,player_id,source_scope,full_name,team,position,injury_status,practice_participation,depth_chart_order,status,state_hash,observed_at,
      evidence_fingerprint,evidence_thesis_link,evidence_payload_json
    ) VALUES(1,'p1','RB',?1,?2,?3,?4,?5,?6,?7,?8,?9,'fingerprint','availability_contingency','{"player":"Player"}')
  `).run(nextState.full_name,nextState.team,nextState.position,nextState.injury_status,nextState.practice_participation,nextState.depth_chart_order,nextState.status,stateHash(nextState),at);

  const result=await processPlayerStateSweepChunk({DB:d1For(db),PHASE_LOGGING:'0'}, {
    run_id:1,source_etag:'{}',total_entries:5,next_index:5,scope_offset:0,scope_etag:null,
    revalidated_at:at,promotion_offset:0,seen_count:1,started_at:at
  });
  assert.equal(result.complete,true);
  assert.equal(db.prepare('SELECT injury_status FROM player_state WHERE player_id=?1').get('p1').injury_status,'Questionable');
  const run=db.prepare('SELECT ok,item_count FROM watcher_runs WHERE id=1').get();
  assert.equal(run.ok,1);
  assert.equal(run.item_count,1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM evidence_events WHERE observation_run_id=1').get().count,1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM alert_outbox').get().count,1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM player_state_candidates WHERE run_id=1').get().count,0);

  db.prepare(`INSERT INTO watcher_runs(id,run_type,started_at) VALUES(2,'player_state:scheduled',?1)`).run(at+1);
  db.prepare(`
    INSERT INTO player_state_sweeps(
      run_id,source_etag,total_entries,next_index,scope_offset,scope_etag,revalidated_at,promotion_offset,seen_count,started_at
    ) VALUES(2,'{}',5,5,0,NULL,?1,0,1,?1)
  `).run(at+1);
  db.prepare(`
    INSERT INTO player_state_candidates(
      run_id,player_id,source_scope,full_name,team,position,injury_status,practice_participation,depth_chart_order,status,state_hash,observed_at,
      evidence_fingerprint,evidence_thesis_link,evidence_payload_json
    ) VALUES(2,'p1','RB',?1,?2,?3,'Out',?4,?5,?6,?7,?8,'fingerprint-2','availability_contingency','{"player":"Player"}')
  `).run(nextState.full_name,nextState.team,nextState.position,nextState.practice_participation,nextState.depth_chart_order,nextState.status,stateHash({...nextState,injury_status:'Out'}),at+1);
  db.exec(`
    CREATE TRIGGER reject_second_acceptance BEFORE UPDATE OF ok ON watcher_runs
    WHEN NEW.id=2 AND NEW.ok=1
    BEGIN SELECT RAISE(ABORT,'synthetic finalization failure'); END;
  `);
  await assert.rejects(processPlayerStateSweepChunk({DB:d1For(db),PHASE_LOGGING:'0'}, {
    run_id:2,source_etag:'{}',total_entries:5,next_index:5,scope_offset:0,scope_etag:null,
    revalidated_at:at+1,promotion_offset:0,seen_count:1,started_at:at+1
  }),/synthetic finalization failure/);
  assert.equal(db.prepare('SELECT injury_status FROM player_state WHERE player_id=?1').get('p1').injury_status,'Questionable');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM evidence_events WHERE observation_run_id=2').get().count,0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM player_state_candidates WHERE run_id=2').get().count,1);
  assert.equal(db.prepare('SELECT finished_at FROM watcher_runs WHERE id=2').get().finished_at,null);
  db.close();
});
