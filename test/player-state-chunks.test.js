import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginChunkedPlayerStateSweep,
  continueChunkedPlayerStateSweep,
  processPlayerStateSweepChunk,
  playerStateOf,
  stateHash
} from '../src/index.js';
import {runLaneStatus} from '../src/index-v027.js';
import v029Worker from '../src/index-v029.js';

const NOW=1790000000000;
const SCOPES=['QB','RB','WR','TE','K'];
const success=(changes=1)=>({success:true,meta:{changes}});

function fixture(t,{count=95,failCheckpointOnce=false}={}){
  t.mock.method(Date,'now',()=>NOW);
  const oldPlayer={full_name:'Player',position:'QB',team:'AAA'};
  const newPlayer={...oldPlayer,team:'BBB'};
  const state=new Map();
  const qb={};
  for(let i=0;i<count;i++){
    const id=String(i).padStart(4,'0');
    const normalized=playerStateOf(oldPlayer);
    state.set(id,{player_id:id,...normalized,state_hash:stateHash(normalized)});
    qb[id]=newPlayer;
  }
  const payloads={QB:qb,RB:{},WR:{},TE:{},K:{}};
  const etags=Object.fromEntries(SCOPES.map(scope=>[scope,`"${scope}-etag"`]));
  const runs=[];
  const sweeps=new Map();
  const evidence=new Map();
  const calls={fetches:[],checkpointAttempts:0,batchSizes:[]};
  let failCheckpoint=failCheckpointOnce;

  const DB={
    prepare(raw){
      const sql=raw.replace(/\s+/g,' ').trim();
      const statement=(args=[])=>(
        {sql,args,bind(...values){return statement(values);},
        async first(){
          if(sql.startsWith('INSERT INTO watcher_runs')){
            const row={id:runs.length+1,run_type:args[0],started_at:args[1],finished_at:null,ok:0,item_count:0,error:null};
            runs.push(row);return{id:row.id};
          }
          if(sql.startsWith('SELECT s.run_id')){
            const active=[...sweeps.values()].filter(s=>runs.find(r=>r.id===s.run_id)?.finished_at==null).sort((a,b)=>b.run_id-a.run_id)[0];
            return active?{...active}:null;
          }
          if(sql.startsWith('SELECT finished_at,ok,item_count,error'))return runs.find(r=>r.id===args[0])||null;
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
            const sweep={run_id:args[0],source_etag:args[1],total_entries:args[2],next_index:0,scope_offset:0,scope_etag:null,seen_count:0,started_at:args[3]};
            sweeps.set(sweep.run_id,sweep);return success();
          }
          if(sql.startsWith('UPDATE player_state_sweeps')){
            calls.checkpointAttempts++;
            if(failCheckpoint){failCheckpoint=false;throw new Error('synthetic termination before checkpoint commit');}
            const sweep=sweeps.get(args[5]);
            if(!sweep||sweep.next_index!==args[6]||sweep.scope_offset!==args[7])return success(0);
            Object.assign(sweep,{next_index:args[0],scope_offset:args[1],scope_etag:args[2],seen_count:sweep.seen_count+args[3],source_etag:args[4]});
            return success();
          }
          if(sql.startsWith('UPDATE watcher_runs')){
            const row=runs.find(r=>r.id===args[4]&&r.finished_at==null);
            if(!row)return success(0);
            Object.assign(row,{finished_at:args[0],ok:args[1],item_count:args[2],error:args[3]});return success();
          }
          throw new Error(`Unexpected run: ${sql}`);
        }}
      );
      return statement();
    },
    async batch(statements){
      calls.batchSizes.push(statements.length);
      for(const stmt of statements){
        if(stmt.sql.startsWith('INSERT INTO evidence_events')){
          evidence.set(stmt.args[0],{fingerprint:stmt.args[0]});
        }else if(stmt.sql.startsWith('UPDATE player_state')){
          const [full_name,team,position,injury_status,practice_participation,depth_chart_order,status,last_seen_at,nextHash,id]=stmt.args;
          Object.assign(state.get(String(id)),{full_name,team,position,injury_status,practice_participation,depth_chart_order,status,last_seen_at,state_hash:nextHash});
        }else throw new Error(`Unexpected batch: ${stmt.sql}`);
      }
      return statements.map(()=>success());
    }
  };

  t.mock.method(globalThis,'fetch',async(input,init={})=>{
    const scope=new URL(String(input)).searchParams.get('position');
    calls.fetches.push({scope,conditional:Boolean(init.headers?.['if-none-match'])});
    const etag=etags[scope];
    if(init.headers?.['if-none-match']===etag)return new Response(null,{status:304,headers:{etag}});
    return new Response(JSON.stringify(payloads[scope]),{status:200,headers:{etag,'content-type':'application/json'}});
  });

  return{env:{DB,PLAYER_STATE_CHUNK_SIZE:'40',PHASE_LOGGING:'1'},runs,sweeps,evidence,state,calls};
}

test('chunked sweep persists a two-dimensional cursor and stays fail-closed through revalidation',async t=>{
  const f=fixture(t);
  const logs=[];
  t.mock.method(console,'log',value=>logs.push(JSON.parse(value)));
  const first=await beginChunkedPlayerStateSweep(f.env,NOW);
  assert.deepEqual({scope:first.scope,processed:first.processed,offset:first.player_offset},{scope:'QB',processed:40,offset:40});
  assert.equal(f.sweeps.get(1).next_index,0);
  assert.equal(f.sweeps.get(1).scope_offset,40);
  assert.equal(runLaneStatus(f.runs[0],36*3600000,NOW),'FAIL');

  let result;
  for(let i=0;i<10;i++){
    result=await continueChunkedPlayerStateSweep(f.env);
    if(result.complete)break;
  }
  assert.equal(result.complete,true);
  assert.equal(f.runs[0].ok,1);
  assert.equal(f.runs[0].item_count,95);
  assert.ok(f.calls.batchSizes.every(size=>size<=75));
  assert.deepEqual(f.calls.fetches.slice(-5).map(x=>x.scope),SCOPES);
  assert.ok(f.calls.fetches.slice(-5).every(x=>x.conditional));
  for(const phase of ['source.fetch','state.load','evidence.batch','state.batch','checkpoint']){
    assert.ok(logs.some(row=>row.phase===phase&&row.state==='start'),`missing ${phase} start`);
    assert.ok(logs.some(row=>row.phase===phase&&row.state==='ok'),`missing ${phase} ok`);
  }
});

test('an aborted chunk resumes from the last committed cursor without duplicate evidence',async t=>{
  const f=fixture(t,{count:40,failCheckpointOnce:true});
  t.mock.method(console,'log',()=>{});
  f.runs.push({id:1,run_type:'player_state:scheduled',started_at:NOW,finished_at:null,ok:0,item_count:0,error:null});
  const sweep={run_id:1,source_etag:'{}',total_entries:5,next_index:0,scope_offset:0,scope_etag:null,seen_count:0,started_at:NOW};
  f.sweeps.set(1,sweep);

  await assert.rejects(processPlayerStateSweepChunk(f.env,{...sweep}),/synthetic termination/);
  assert.equal(sweep.scope_offset,0);
  assert.equal(f.evidence.size,40);
  const resumed=await processPlayerStateSweepChunk(f.env,{...sweep});
  assert.equal(resumed.scope_index,1);
  assert.equal(resumed.player_offset,0);
  assert.equal(f.evidence.size,40);
  assert.equal(sweep.seen_count,40);
});

test('v0.2.9 health identifies the chunked-frame entrypoint',async()=>{
  const response=await v029Worker.fetch(new Request('https://local.invalid/health'),{});
  assert.equal(response.status,200);
  assert.equal((await response.json()).version,'0.2.9');
});
