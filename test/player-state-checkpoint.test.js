import test from 'node:test';
import assert from 'node:assert/strict';
import {beginPlayerStateSweep,continuePlayerStateSweep,playerStateOf,stateHash} from '../src/index.js';
import {runLaneStatus,overallLaneGate} from '../src/index-v027.js';
import v028Worker,{PLAYER_STATE_CONTINUATION_CRON} from '../src/index-v028.js';

const NOW=1789490000000;
const oldPlayer={full_name:'Player',position:'RB',team:'AAA'};
const changedPlayer={...oldPlayer,team:'BBB'};
const rowFor=(id,p=oldPlayer)=>({player_id:String(id),...playerStateOf(p),state_hash:stateHash(playerStateOf(p)),first_seen_at:NOW-1,last_seen_at:NOW-1});
const success=(changes=1)=>({success:true,meta:{changes}});

function fixture(t,{count=30,changed=count,chunkSize=25,failStateOnce=false,failFinalize=false}={}){
  t.mock.method(Date,'now',()=>NOW);
  const state=new Map();
  const payload={};
  for(let i=0;i<count;i++){
    const id=String(i).padStart(4,'0');
    state.set(id,rowFor(id));
    payload[id]=i<changed?changedPlayer:oldPlayer;
  }
  const runs=[];
  const sweeps=new Map();
  const evidence=new Map();
  const calls={order:[],evidenceAttempts:0,stateAttempts:0};
  let etag='"snapshot-a"';
  let failState=failStateOnce;
  let failFinish=failFinalize;

  const DB={
    prepare(raw){
      const sql=raw.replace(/\s+/g,' ').trim();
      const statement=(args=[])=>({
        sql,args,
        bind(...values){return statement(values);},
        async first(){
          if(sql.startsWith('INSERT INTO watcher_runs')){
            const row={id:runs.length+1,run_type:args[0],started_at:args[1],finished_at:null,ok:0,item_count:0,error:null};
            runs.push(row);calls.order.push('start');return{id:row.id};
          }
          if(sql.startsWith('SELECT s.run_id')){
            const active=[...sweeps.values()].filter(s=>runs.find(r=>r.id===s.run_id)?.finished_at==null).sort((a,b)=>b.run_id-a.run_id)[0];
            return active?{...active}:null;
          }
          if(sql.startsWith('SELECT finished_at,ok,item_count,error')) return runs.find(r=>r.id===args[0])||null;
          throw new Error(`Unexpected first: ${sql}`);
        },
        async all(){
          if(sql.startsWith('SELECT * FROM player_state WHERE player_id>=?1')){
            return{results:[...state.values()].filter(row=>row.player_id>=args[0]&&row.player_id<=args[1])};
          }
          throw new Error(`Unexpected all: ${sql}`);
        },
        async run(){
          if(sql.startsWith('INSERT INTO player_state_sweeps')){
            const sweep={run_id:args[0],source_etag:args[1],total_entries:args[2],next_index:0,seen_count:0,started_at:args[3]};
            sweeps.set(sweep.run_id,sweep);calls.order.push('init');return success();
          }
          if(sql.startsWith('UPDATE player_state_sweeps')){
            const sweep=sweeps.get(args[2]);
            if(!sweep||sweep.next_index!==args[3])return success(0);
            sweep.next_index=args[0];sweep.seen_count+=args[1];calls.order.push('checkpoint');return success();
          }
          if(sql.startsWith('UPDATE watcher_runs')){
            calls.order.push(args[1]===1?'pass':'fail');
            if(failFinish)throw new Error('synthetic finalization failure');
            const row=runs.find(r=>r.id===args[4]&&r.finished_at==null);
            if(!row)return success(0);
            Object.assign(row,{finished_at:args[0],ok:args[1],item_count:args[2],error:args[3]});return success();
          }
          throw new Error(`Unexpected run: ${sql}`);
        }
      });
      return statement();
    },
    async batch(statements){
      const evidenceBatch=statements.every(x=>x.sql.startsWith('INSERT INTO evidence_events'));
      calls.order.push(evidenceBatch?'evidence':'state');
      if(evidenceBatch){
        calls.evidenceAttempts+=statements.length;
        for(const stmt of statements){
          const prior=evidence.get(stmt.args[0]);
          if(prior)prior.last_seen_at=stmt.args[6];else evidence.set(stmt.args[0],{fingerprint:stmt.args[0],last_seen_at:stmt.args[6]});
        }
      }else{
        calls.stateAttempts+=statements.length;
        if(failState){failState=false;throw new Error('synthetic state failure');}
        for(const stmt of statements){
          if(stmt.sql.startsWith('UPDATE player_state')){
            const [full_name,team,position,injury_status,practice_participation,depth_chart_order,status,last_seen_at,state_hash,id]=stmt.args;
            Object.assign(state.get(String(id)),{full_name,team,position,injury_status,practice_participation,depth_chart_order,status,last_seen_at,state_hash});
          }else if(stmt.sql.startsWith('INSERT INTO player_state')){
            const [player_id,full_name,team,position,injury_status,practice_participation,depth_chart_order,status,first_seen_at,last_seen_at,state_hash]=stmt.args;
            state.set(String(player_id),{player_id:String(player_id),full_name,team,position,injury_status,practice_participation,depth_chart_order,status,first_seen_at,last_seen_at,state_hash});
          }else throw new Error(`Unexpected batch: ${stmt.sql}`);
        }
      }
      return statements.map(()=>success());
    }
  };
  t.mock.method(globalThis,'fetch',async()=>({ok:true,headers:new Headers({etag}),json:async()=>payload}));
  return{
    env:{DB,PLAYER_STATE_CHUNK_SIZE:String(chunkSize)},runs,sweeps,evidence,state,calls,payload,
    setEtag(value){etag=value;},setFailFinalize(value){failFinish=value;}
  };
}

test('bounded chunks remain FAIL until the complete coherent observation becomes PASS',async t=>{
  const f=fixture(t,{count:30,changed:30});
  const first=await beginPlayerStateSweep(f.env,NOW);
  assert.deepEqual({complete:first.complete,processed:first.processed,seen:first.seen},{complete:false,processed:25,seen:25});
  assert.equal(runLaneStatus(f.runs[0],36*3600000,NOW),'FAIL');
  assert.equal(overallLaneGate('PASS','FAIL'),'PASS');
  const done=await continuePlayerStateSweep(f.env);
  assert.deepEqual({complete:done.complete,processed:done.processed,seen:done.seen},{complete:true,processed:5,seen:30});
  assert.equal(runLaneStatus(f.runs[0],36*3600000,NOW),'PASS');
  assert.equal(f.runs[0].item_count,30);
  assert.deepEqual(f.calls.order,['start','init','evidence','state','checkpoint','evidence','state','checkpoint','pass']);
});

test('the production-sized 12k payload prepares at most one bounded chunk',async t=>{
  const f=fixture(t,{count:12000,changed:12000,chunkSize:100});
  const first=await beginPlayerStateSweep(f.env,NOW);
  assert.deepEqual({complete:first.complete,processed:first.processed,seen:first.seen},{complete:false,processed:100,seen:100});
  assert.equal(f.calls.evidenceAttempts,100);
  assert.equal(f.calls.stateAttempts,100);
  assert.deepEqual([...f.sweeps.values()].map(s=>[s.next_index,s.total_entries]),[[100,12000]]);
  assert.equal(f.runs[0].finished_at,null);
});

test('retry after evidence commit is idempotent and preserves evidence-before-state ordering',async t=>{
  const f=fixture(t,{count:30,changed:30,failStateOnce:true});
  await assert.rejects(beginPlayerStateSweep(f.env,NOW),/synthetic state failure/);
  assert.equal(f.sweeps.get(1).next_index,0);
  assert.equal(f.evidence.size,25);
  assert.equal(runLaneStatus(f.runs[0],36*3600000,NOW),'FAIL');
  await continuePlayerStateSweep(f.env);
  assert.equal(f.evidence.size,25);
  assert.equal(f.calls.evidenceAttempts,50);
  assert.ok(f.calls.order.indexOf('evidence')<f.calls.order.indexOf('state'));
  await continuePlayerStateSweep(f.env);
  assert.equal(f.evidence.size,30);
  assert.equal(f.runs[0].ok,1);
});

test('unchanged canonical player states stay write-free while checkpoints advance',async t=>{
  const f=fixture(t,{count:30,changed:0});
  await beginPlayerStateSweep(f.env,NOW);
  await continuePlayerStateSweep(f.env);
  assert.equal(f.calls.evidenceAttempts,0);
  assert.equal(f.calls.stateAttempts,0);
  assert.equal(f.runs[0].ok,1);
});

test('ETag change fails the partial run and starts a fresh coherent observation',async t=>{
  const f=fixture(t,{count:30,changed:30});
  await beginPlayerStateSweep(f.env,NOW);
  f.setEtag('"snapshot-b"');
  const rotated=await continuePlayerStateSweep(f.env);
  assert.equal(f.runs[0].ok,0);
  assert.equal(f.runs[0].error,'WORK_FAILED');
  assert.equal(f.runs[1].finished_at,null);
  assert.equal(f.sweeps.get(2).source_etag,'"snapshot-b"');
  assert.equal(rotated.complete,false);
});

test('finalization failure leaves the complete checkpoint fail-closed and retryable',async t=>{
  const f=fixture(t,{count:1,changed:0,failFinalize:true});
  await assert.rejects(beginPlayerStateSweep(f.env,NOW),/FINALIZATION_FAILED/);
  assert.equal(f.sweeps.get(1).next_index,1);
  assert.equal(f.runs[0].finished_at,null);
  assert.equal(runLaneStatus(f.runs[0],36*3600000,NOW),'FAIL');
  f.setFailFinalize(false);
  const retried=await continuePlayerStateSweep(f.env);
  assert.equal(retried.complete,true);
  assert.equal(f.runs[0].ok,1);
});

test('continuation cron is distinct from the market polling cron',()=>{
  assert.equal(PLAYER_STATE_CONTINUATION_CRON,'2,7,12,22,37,52 * * * *');
  assert.notEqual(PLAYER_STATE_CONTINUATION_CRON,'*/15 * * * *');
});

test('v0.2.8 schedules begin and continuation as separate invocations',async t=>{
  const f=fixture(t,{count:30,changed:0});
  const first=[];
  await v028Worker.scheduled({cron:'17 4 * * *'},f.env,{waitUntil(p){first.push(p);}});
  assert.equal(first.length,1);
  await first[0];
  assert.equal(f.sweeps.get(1).next_index,25);
  const next=[];
  await v028Worker.scheduled({cron:PLAYER_STATE_CONTINUATION_CRON},f.env,{waitUntil(p){next.push(p);}});
  assert.equal(next.length,1);
  await next[0];
  assert.equal(f.runs[0].ok,1);
});

test('v0.2.8 health reports the repaired entrypoint version',async()=>{
  const response=await v028Worker.fetch(new Request('https://local.invalid/health'),{});
  assert.equal(response.status,200);
  assert.equal((await response.json()).version,'0.2.8');
});
