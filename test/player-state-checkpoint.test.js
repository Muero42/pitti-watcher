import test from 'node:test';
import assert from 'node:assert/strict';
import {beginPlayerStateSweep,continuePlayerStateSweep,playerStateOf,stateHash} from '../src/index.js';
import {runLaneStatus,overallLaneGate} from '../src/index-v027.js';
import v028Worker,{PLAYER_STATE_CONTINUATION_CRON} from '../src/index-v028.js';

const NOW=1789490000000;
const SCOPES=['QB','RB','WR','TE','K'];
const oldPlayer={full_name:'Player',position:'QB',fantasy_positions:['QB'],team:'AAA'};
const changedPlayer={...oldPlayer,team:'BBB'};
const rowFor=(id,p=oldPlayer)=>({player_id:String(id),...playerStateOf(p),state_hash:stateHash(playerStateOf(p)),first_seen_at:NOW-1,last_seen_at:NOW-1});
const success=(changes=1)=>({success:true,meta:{changes}});

function fixture(t,{count=30,changed=count,failStateOnce=false,failFinalize=false}={}){
  t.mock.method(Date,'now',()=>NOW);
  const state=new Map();
  const qbPayload={};
  for(let i=0;i<count;i++){
    const id=String(i).padStart(4,'0');
    state.set(id,rowFor(id));
    qbPayload[id]=i<changed?changedPlayer:oldPlayer;
  }
  const payloads={QB:qbPayload,RB:{},WR:{},TE:{},K:{}};
  const runs=[];
  const sweeps=new Map();
  const evidence=new Map();
  const calls={order:[],evidenceAttempts:0,stateAttempts:0,fetches:[]};
  let failState=failStateOnce;
  let failFinish=failFinalize;
  const etags=Object.fromEntries(SCOPES.map(scope=>[scope,`"snapshot-${scope}"`]));

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
          if(sql.startsWith('SELECT * FROM player_state WHERE player_id IN')){
            const ids=new Set(args.map(String));
            return{results:[...state.values()].filter(row=>ids.has(String(row.player_id)))};
          }
          throw new Error(`Unexpected all: ${sql}`);
        },
        async run(){
          if(sql.startsWith('INSERT INTO player_state_sweeps')){
            const sweep={run_id:args[0],source_etag:args[1],total_entries:args[2],next_index:0,seen_count:0,started_at:args[3]};
            sweeps.set(sweep.run_id,sweep);calls.order.push('init');return success();
          }
          if(sql.startsWith('UPDATE player_state_sweeps')){
            const sweep=sweeps.get(args[3]);
            if(!sweep||sweep.next_index!==args[4])return success(0);
            sweep.next_index=args[0];sweep.seen_count+=args[1];sweep.source_etag=args[2];calls.order.push('checkpoint');return success();
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

  t.mock.method(globalThis,'fetch',async(input,init={})=>{
    const url=new URL(String(input));
    const scope=url.searchParams.get('position');
    assert.ok(SCOPES.includes(scope),`unexpected unbounded Sleeper request: ${url}`);
    calls.fetches.push({scope,conditional:!!init.headers?.['if-none-match']});
    const etag=etags[scope];
    if(init.headers?.['if-none-match']===etag)return new Response(null,{status:304,headers:{etag}});
    return new Response(JSON.stringify(payloads[scope]),{status:200,headers:{'content-type':'application/json',etag}});
  });

  return{
    env:{DB},runs,sweeps,evidence,state,calls,payloads,etags,
    setEtag(scope,value){etags[scope]=value;},
    setFailFinalize(value){failFinish=value;}
  };
}

async function finishSweep(env){
  let out;
  for(let i=0;i<5;i++)out=await continuePlayerStateSweep(env);
  return out;
}

test('production path processes one documented Sleeper position scope per invocation',async t=>{
  const f=fixture(t,{count:12000,changed:0});
  const first=await beginPlayerStateSweep(f.env,NOW);
  assert.equal(first.scope,'QB');
  assert.equal(first.complete,false);
  assert.deepEqual(f.calls.fetches.map(x=>x.scope),['QB']);
  assert.equal(f.sweeps.get(1).next_index,1);
  assert.equal(f.runs[0].finished_at,null);
});

test('complete multi-scope observation remains fail-closed until ETags revalidate',async t=>{
  const f=fixture(t,{count:30,changed:30});
  await beginPlayerStateSweep(f.env,NOW);
  assert.equal(runLaneStatus(f.runs[0],36*3600000,NOW),'FAIL');
  assert.equal(overallLaneGate('PASS','FAIL'),'PASS');
  const done=await finishSweep(f.env);
  assert.equal(done.complete,true);
  assert.equal(f.runs[0].ok,1);
  assert.equal(f.runs[0].item_count,30);
  assert.deepEqual(f.calls.fetches.slice(0,5).map(x=>x.scope),SCOPES);
  assert.deepEqual(f.calls.fetches.slice(5).map(x=>x.scope),SCOPES);
  assert.ok(f.calls.fetches.slice(5).every(x=>x.conditional));
});

test('source rotation during final revalidation fails the partial run and starts fresh',async t=>{
  const f=fixture(t,{count:2,changed:0});
  await beginPlayerStateSweep(f.env,NOW);
  for(let i=0;i<4;i++)await continuePlayerStateSweep(f.env);
  f.setEtag('WR','"snapshot-WR-rotated"');
  const rotated=await continuePlayerStateSweep(f.env);
  assert.equal(f.runs[0].ok,0);
  assert.equal(f.runs[0].error,'WORK_FAILED');
  assert.equal(f.runs[1].finished_at,null);
  assert.equal(rotated.scope,'QB');
});

test('retry after evidence commit is idempotent and preserves evidence-before-state ordering',async t=>{
  const f=fixture(t,{count:30,changed:30,failStateOnce:true});
  await assert.rejects(beginPlayerStateSweep(f.env,NOW),/synthetic state failure/);
  assert.equal(f.sweeps.get(1).next_index,0);
  assert.equal(f.evidence.size,30);
  await continuePlayerStateSweep(f.env);
  assert.equal(f.evidence.size,30);
  assert.equal(f.calls.evidenceAttempts,60);
  assert.ok(f.calls.order.indexOf('evidence')<f.calls.order.indexOf('state'));
});

test('unchanged canonical player states stay write-free while source checkpoints advance',async t=>{
  const f=fixture(t,{count:30,changed:0});
  await beginPlayerStateSweep(f.env,NOW);
  await finishSweep(f.env);
  assert.equal(f.calls.evidenceAttempts,0);
  assert.equal(f.calls.stateAttempts,0);
  assert.equal(f.runs[0].ok,1);
});

test('finalization failure leaves a fully revalidated sweep fail-closed and retryable',async t=>{
  const f=fixture(t,{count:1,changed:0});
  await beginPlayerStateSweep(f.env,NOW);
  for(let i=0;i<4;i++)await continuePlayerStateSweep(f.env);
  f.setFailFinalize(true);
  await assert.rejects(continuePlayerStateSweep(f.env),/FINALIZATION_FAILED/);
  assert.equal(f.sweeps.get(1).next_index,5);
  assert.equal(f.runs[0].finished_at,null);
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
  assert.equal(f.sweeps.get(1).next_index,1);
  const next=[];
  await v028Worker.scheduled({cron:PLAYER_STATE_CONTINUATION_CRON},f.env,{waitUntil(p){next.push(p);}});
  assert.equal(next.length,1);
  await next[0];
  assert.equal(f.sweeps.get(1).next_index,2);
});

test('v0.2.8 health reports the repaired entrypoint version',async()=>{
  const response=await v028Worker.fetch(new Request('https://local.invalid/health'),{});
  assert.equal(response.status,200);
  assert.equal((await response.json()).version,'0.2.8');
});
