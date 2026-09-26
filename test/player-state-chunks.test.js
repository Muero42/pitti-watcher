import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  beginChunkedPlayerStateSweep,
  continueChunkedPlayerStateSweep,
  evidenceFingerprint,
  processPlayerStateSweepChunk,
  playerStateOf,
  stateHash
} from '../src/index.js';
import {runLaneStatus} from '../src/index-v027.js';
import v029Worker from '../src/index-v029.js';
import * as v029Module from '../src/index-v029.js';

const NOW=1790000000000;
const SCOPES=['QB','RB','WR','TE','K'];
const success=(changes=1)=>({success:true,meta:{changes}});

test('fundamental evidence is idempotent within one observation but distinct across later episodes',async()=>{
  const event={
    player_id:'p1',event_type:'PLAYER_STATE_CHANGED',fundamental_or_market:'fundamental',
    original_source:'Sleeper Player Data',observation_run_id:11,
    payload:{diffs:{injury_status:{before:null,after:'Questionable'}}}
  };
  assert.equal(await evidenceFingerprint(event),await evidenceFingerprint({...event}));
  assert.notEqual(await evidenceFingerprint(event),await evidenceFingerprint({...event,observation_run_id:12}));
});

function fixture(t,{count=95,changedCount=count,failCheckpointOnce=false,failPromotionOnce=false}={}){
  t.mock.method(Date,'now',()=>NOW);
  const oldPlayer={full_name:'Player',position:'QB',team:'AAA'};
  const newPlayer={...oldPlayer,injury_status:'Questionable'};
  const state=new Map();
  const qb={};
  for(let i=0;i<count;i++){
    const id=String(i).padStart(4,'0');
    const normalized=playerStateOf(oldPlayer);
    state.set(id,{player_id:id,...normalized,state_hash:stateHash(normalized)});
    qb[id]=i<changedCount?newPlayer:oldPlayer;
  }
  const payloads={QB:qb,RB:{},WR:{},TE:{},K:{}};
  const etags=Object.fromEntries(SCOPES.map(scope=>[scope,`"${scope}-etag"`]));
  const runs=[];
  const sweeps=new Map();
  const candidates=new Map();
  const frames=new Map();
  const evidence=new Map();
  const calls={fetches:[],checkpointAttempts:0,batchSizes:[],queries:[],batches:[]};
  let failCheckpoint=failCheckpointOnce;
  let failPromotion=failPromotionOnce;

  const DB={
    prepare(raw){
      const sql=raw.replace(/\s+/g,' ').trim();
      const statement=(args=[])=>(
        {sql,args,bind(...values){return statement(values);},
        async first(){
          calls.queries.push({method:'first',sql,args});
          if(sql.startsWith('INSERT INTO watcher_runs')){
            const row={id:runs.length+1,run_type:args[0],started_at:args[1],finished_at:null,ok:0,item_count:0,error:null};
            runs.push(row);return{id:row.id};
          }
          if(sql.startsWith('SELECT s.run_id')){
            const active=[...sweeps.values()].filter(s=>runs.find(r=>r.id===s.run_id)?.finished_at==null).sort((a,b)=>b.run_id-a.run_id)[0];
            return active?{...active}:null;
          }
          if(sql.startsWith('SELECT finished_at,ok,item_count,error'))return runs.find(r=>r.id===args[0])||null;
          if(sql.startsWith('SELECT finished_at,ok,item_count FROM watcher_runs'))return runs.find(r=>r.id===args[0])||null;
          throw new Error(`Unexpected first: ${sql}`);
        },
        async all(){
          calls.queries.push({method:'all',sql,args});
          if(sql.startsWith('SELECT COUNT(*) candidate_count')){
            const count=[...candidates.values()].filter(row=>row.run_id===args[0]).length;
            return{results:[{candidate_count:count}],meta:{rows_read:count,rows_written:0,timings:{sql_duration_ms:1.25}}};
          }
          if(sql.startsWith('SELECT run_id,source_scope,captured_at,source_etag,player_count,frame_json')){
            const row=frames.get(`${args[0]}:${args[1]}`);
            return{results:row?[{...row}]:[],meta:{rows_read:row?1:0,rows_written:0}};
          }
          if(sql.startsWith('SELECT * FROM player_state WHERE player_id IN')){
            const ids=new Set(args.map(String));
            return{results:[...state.values()].filter(row=>ids.has(String(row.player_id)))};
          }
          if(sql.startsWith('SELECT * FROM player_state_candidates')){
            const rows=[...candidates.values()].filter(row=>row.run_id===args[0]).sort((a,b)=>a.player_id.localeCompare(b.player_id));
            return{results:rows.slice(args[2],args[2]+args[1])};
          }
          throw new Error(`Unexpected all: ${sql}`);
        },
        async run(){
          calls.queries.push({method:'run',sql,args});
          if(sql.startsWith('INSERT INTO player_state_scope_frames')){
            const key=`${args[0]}:${args[1]}`;
            if(frames.has(key))return success(0);
            frames.set(key,{run_id:args[0],source_scope:args[1],captured_at:args[2],source_etag:args[3],player_count:args[4],frame_json:args[5]});
            return success();
          }
          if(sql.startsWith('INSERT INTO player_state_sweeps')){
            const sweep={run_id:args[0],source_etag:args[1],total_entries:args[2],next_index:0,scope_offset:0,scope_etag:null,revalidated_at:null,promotion_offset:0,seen_count:0,started_at:args[3]};
            sweeps.set(sweep.run_id,sweep);return success();
          }
          if(sql.startsWith('UPDATE player_state_sweeps')){
            if(sql.includes('SET revalidated_at')){
              const sweep=sweeps.get(args[1]);
              if(!sweep||sweep.next_index!==args[2]||sweep.revalidated_at!=null)return success(0);
              sweep.revalidated_at=args[0];return success();
            }
            if(sql.includes('SET promotion_offset')){
              const sweep=sweeps.get(args[1]);
              if(!sweep||sweep.promotion_offset!==args[2]||sweep.revalidated_at==null)return success(0);
              sweep.promotion_offset=args[0];return success();
            }
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
      calls.batches.push(statements);
      calls.batchSizes.push(statements.length);
      if(failPromotion&&statements.some(stmt=>stmt.sql.includes('UPDATE watcher_runs SET finished_at'))){
        failPromotion=false;
        throw new Error('synthetic atomic promotion failure');
      }
      for(const stmt of statements){
        if(stmt.sql.startsWith('INSERT INTO player_state_candidates')){
          const [run_id,player_id,source_scope,full_name,team,position,injury_status,practice_participation,depth_chart_order,status,nextHash,observed_at,evidence_fingerprint,evidence_thesis_link,evidence_payload_json]=stmt.args;
          candidates.set(`${run_id}:${player_id}`,{run_id,player_id:String(player_id),source_scope,full_name,team,position,injury_status,practice_participation,depth_chart_order,status,state_hash:nextHash,observed_at,evidence_fingerprint,evidence_thesis_link,evidence_payload_json});
        }else if(stmt.sql.startsWith('INSERT INTO evidence_events(')&&stmt.sql.includes('FROM player_state_candidates')){
          for(const candidate of [...candidates.values()].filter(row=>row.run_id===stmt.args[0]&&row.evidence_fingerprint)){
            evidence.set(candidate.evidence_fingerprint,{fingerprint:candidate.evidence_fingerprint,observation_run_id:candidate.run_id});
          }
        }else if(stmt.sql.startsWith('INSERT INTO player_state(')&&stmt.sql.includes('FROM player_state_candidates')){
          for(const candidate of [...candidates.values()].filter(row=>row.run_id===stmt.args[0])){
            const prior=state.get(String(candidate.player_id))||{};
            state.set(String(candidate.player_id),{...prior,...candidate,first_seen_at:prior.first_seen_at??candidate.observed_at,last_seen_at:candidate.observed_at});
          }
        }else if(stmt.sql.startsWith('UPDATE player_state_sweeps SET promotion_offset')){
          const sweep=sweeps.get(stmt.args[1]);
          if(sweep&&sweep.promotion_offset===0&&sweep.revalidated_at!=null)sweep.promotion_offset=stmt.args[0];
        }else if(stmt.sql.startsWith('UPDATE watcher_runs SET finished_at')){
          const row=runs.find(r=>r.id===stmt.args[2]&&r.finished_at==null);
          if(row)Object.assign(row,{finished_at:stmt.args[0],ok:1,item_count:stmt.args[1],error:null});
        }else if(stmt.sql.startsWith('DELETE FROM player_state_candidates')){
          for(const [key,candidate] of candidates){
            if(candidate.run_id===stmt.args[0]&&(stmt.args.length<2||candidate.source_scope===stmt.args[1]))candidates.delete(key);
          }
        }else if(stmt.sql.startsWith('DELETE FROM player_state_scope_frames')){
          for(const [key,frame] of frames)if(frame.run_id===stmt.args[0])frames.delete(key);
        }else if(stmt.sql.startsWith('UPDATE player_state_sweeps')&&stmt.sql.includes('SET scope_offset=0')){
          const sweep=sweeps.get(stmt.args[0]);
          if(sweep&&sweep.next_index===stmt.args[1]&&sweep.scope_offset===stmt.args[2]&&sweep.revalidated_at==null){
            sweep.seen_count-=sweep.scope_offset;sweep.scope_offset=0;sweep.scope_etag=null;
          }
        }else if(stmt.sql.startsWith('INSERT INTO evidence_events')){
          evidence.set(stmt.args[0],{fingerprint:stmt.args[0],observation_run_id:stmt.args[13]});
        }else if(stmt.sql.startsWith('UPDATE player_state')){
          const [full_name,team,position,injury_status,practice_participation,depth_chart_order,status,last_seen_at,nextHash,id]=stmt.args;
          Object.assign(state.get(String(id)),{full_name,team,position,injury_status,practice_participation,depth_chart_order,status,last_seen_at,state_hash:nextHash});
        }else if(stmt.sql.startsWith('INSERT INTO player_state(')){
          const [player_id,full_name,team,position,injury_status,practice_participation,depth_chart_order,status,first_seen_at,last_seen_at,nextHash]=stmt.args;
          const prior=state.get(String(player_id))||{};
          state.set(String(player_id),{...prior,player_id:String(player_id),full_name,team,position,injury_status,practice_participation,depth_chart_order,status,first_seen_at:prior.first_seen_at??first_seen_at,last_seen_at,state_hash:nextHash});
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

  return{
    env:{DB,PLAYER_STATE_CHUNK_SIZE:'40',PHASE_LOGGING:'1'},runs,sweeps,candidates,frames,evidence,state,calls,
    setEtag(scope,value){etags[scope]=value;}
  };
}

test('chunked sweep freezes each scope before bounded processing and stays fail-closed until promotion',async t=>{
  const f=fixture(t);
  const logs=[];
  t.mock.method(console,'log',value=>logs.push(JSON.parse(value)));
  const first=await beginChunkedPlayerStateSweep(f.env,NOW);
  assert.deepEqual({scope:first.scope,captured:first.captured,processed:first.processed,offset:first.player_offset},{scope:'QB',captured:true,processed:0,offset:0});
  assert.equal(f.sweeps.get(1).next_index,0);
  assert.equal(f.sweeps.get(1).scope_offset,0);
  assert.equal(runLaneStatus(f.runs[0],36*3600000,NOW),'FAIL');

  let result;
  for(let i=0;i<20;i++){
    result=await continueChunkedPlayerStateSweep(f.env);
    if(result.complete)break;
  }
  assert.equal(result.complete,true);
  assert.equal(f.runs[0].ok,1);
  assert.equal(f.runs[0].item_count,95);
  assert.ok(f.calls.batchSizes.every(size=>size<=75));
  assert.deepEqual(f.calls.fetches.map(x=>x.scope),SCOPES);
  assert.ok(f.calls.fetches.every(x=>!x.conditional));
  for(const phase of ['source.fetch','scope.frame.load','scope.frame.capture','state.load','candidate.batch','checkpoint','sweep.seal','promotion.load','promotion.commit']){
    assert.ok(logs.some(row=>row.phase===phase&&row.state==='start'),`missing ${phase} start`);
    assert.ok(logs.some(row=>row.phase===phase&&row.state==='ok'),`missing ${phase} ok`);
  }
});

test('an aborted chunk resumes from the last committed cursor without duplicate evidence',async t=>{
  const f=fixture(t,{count:40,failCheckpointOnce:true});
  t.mock.method(console,'log',()=>{});
  await beginChunkedPlayerStateSweep(f.env,NOW);
  const sweep=f.sweeps.get(1);
  await assert.rejects(processPlayerStateSweepChunk(f.env,{...sweep}),/synthetic termination/);
  assert.equal(sweep.scope_offset,0);
  assert.equal(f.candidates.size,40);
  assert.equal(f.evidence.size,0);
  const resumed=await processPlayerStateSweepChunk(f.env,{...sweep});
  assert.equal(resumed.scope_index,1);
  assert.equal(resumed.player_offset,0);
  assert.equal(f.candidates.size,40);
  assert.equal(f.evidence.size,0);
  assert.equal(sweep.seen_count,40);
});

test('an upstream rotation after capture cannot reset the frozen scope generation',async t=>{
  const f=fixture(t,{count:41,changedCount:1});
  t.mock.method(console,'log',()=>{});
  await beginChunkedPlayerStateSweep(f.env,NOW);
  assert.equal(f.sweeps.get(1).scope_offset,0);
  await continueChunkedPlayerStateSweep(f.env);
  assert.equal(f.sweeps.get(1).scope_offset,40);
  assert.equal(f.state.get('0000').injury_status,null);
  assert.equal(f.candidates.get('1:0000').injury_status,'Questionable');
  assert.equal(f.evidence.size,0);

  f.setEtag('QB','"QB-rotated"');
  let result;
  for(let i=0;i<20;i++){
    result=await continueChunkedPlayerStateSweep(f.env);
    if(result.complete)break;
  }
  assert.equal(result.complete,true);
  assert.equal(f.runs[0].ok,1);
  assert.equal(f.state.get('0000').injury_status,'Questionable');
  assert.equal(f.candidates.size,0);
  assert.equal(f.evidence.size,1);
  assert.equal(f.calls.fetches.filter(row=>row.scope==='QB').length,1);
  assert.deepEqual([...f.evidence.values()].map(row=>row.observation_run_id),[1]);
  const visible=[...f.evidence.values()].filter(event=>{
    const run=f.runs.find(row=>row.id===event.observation_run_id);
    return run?.ok===1&&run.finished_at!=null;
  });
  assert.equal(visible.length,1);
});

test('a partial pre-frame sweep is failed and replaced by a fresh frozen run',async t=>{
  const f=fixture(t,{count:40,changedCount:1});
  t.mock.method(console,'log',()=>{});
  f.runs.push({id:1,run_type:'player_state:scheduled',started_at:NOW-1,finished_at:null,ok:0,item_count:0,error:null});
  f.sweeps.set(1,{
    run_id:1,source_etag:'{}',total_entries:5,next_index:0,scope_offset:40,
    scope_etag:'"legacy"',revalidated_at:null,promotion_offset:0,seen_count:40,started_at:NOW-1
  });

  const result=await continueChunkedPlayerStateSweep(f.env);
  assert.equal(result.restarted_legacy_sweep,true);
  assert.equal(f.runs[0].ok,0);
  assert.equal(f.runs[0].finished_at,NOW);
  assert.equal(f.runs[1].finished_at,null);
  assert.equal(f.sweeps.get(2).scope_offset,0);
  assert.equal(f.frames.has('2:QB'),true);
  assert.equal(f.candidates.size,0);
});

test('promotion stays below the free-plan query cap and rolls back as one D1 batch',async t=>{
  const f=fixture(t,{count:40,failPromotionOnce:true});
  t.mock.method(console,'log',()=>{});
  await beginChunkedPlayerStateSweep(f.env,NOW);
  for(let i=0;i<9;i++)await continueChunkedPlayerStateSweep(f.env);
  await assert.rejects(continueChunkedPlayerStateSweep(f.env),/synthetic atomic promotion failure/);
  assert.equal(f.runs[0].ok,0);
  assert.ok([...f.state.values()].every(row=>row.injury_status==null));
  assert.equal(f.evidence.size,0);
  assert.equal(f.calls.batchSizes.at(-1),6);
  assert.ok(1+1+6<=50,'active-sweep read, candidate count and promotion batch must fit the free D1 query cap');
});

test('v0.2.9 disables legacy debug mutations before touching storage or upstreams',async t=>{
  let touched=false;
  t.mock.method(globalThis,'fetch',async()=>{touched=true;throw new Error('unexpected upstream call');});
  const env={
    WATCHER_TOKEN:'secret',
    DB:{prepare(){touched=true;throw new Error('unexpected database call');}}
  };
  for(const path of ['/debug/run-trending','/debug/run-players']){
    const response=await v029Worker.fetch(new Request(`https://local.invalid${path}`,{
      headers:{authorization:'Bearer secret'}
    }),env,{});
    assert.equal(response.status,410);
    assert.equal((await response.json()).error,'LEGACY_DEBUG_MUTATION_DISABLED');
  }
  assert.equal(touched,false);
});

test('v0.2.9 events returns only the accepted-evidence query result',async()=>{
  const accepted={id:7,player_id:'p1',observation_run_id:2};
  let sql='';
  const env={
    WATCHER_TOKEN:'secret',
    DB:{prepare(raw){sql=raw;return{async all(){return{results:[accepted]};}};}}
  };
  const response=await v029Worker.fetch(new Request('https://local.invalid/events',{
    headers:{authorization:'Bearer secret'}
  }),env,{});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),[accepted]);
  assert.match(sql,/e\.observation_run_id IS NULL OR \(r\.ok=1 AND r\.finished_at IS NOT NULL\)/);
});

test('v0.2.9 does not inherit unknown legacy routes',async()=>{
  const response=await v029Worker.fetch(new Request('https://local.invalid/legacy-surprise'),{},{});
  assert.equal(response.status,404);
  assert.equal((await response.json()).error,'NOT_FOUND');
});

test('v0.2.10 health identifies the frozen-scope entrypoint',async()=>{
  const response=await v029Worker.fetch(new Request('https://local.invalid/health'),{});
  assert.equal(response.status,200);
  assert.equal((await response.json()).version,'0.2.10');
});

test('v0.2.9 exposes only a valid default Worker entrypoint',()=>{
  assert.deepEqual(Object.keys(v029Module),['default']);
});

test('v0.2.9 ignores unknown cron expressions instead of starting market work',async t=>{
  const waits=[];
  const logs=[];
  t.mock.method(console,'log',value=>logs.push(JSON.parse(value)));
  await v029Worker.scheduled({cron:'3 3 * * 0'}, {}, {waitUntil(promise){waits.push(promise);}});
  assert.equal(waits.length,0);
  assert.deepEqual(logs,[{event:'watcher_cron_ignored',cron:'3 3 * * 0'}]);
});

const continuationCron='2,7,12,22,27,32,37,42,47,52,57 * * * *';
async function scheduled(cron,env){
  const waits=[];
  await v029Worker.scheduled({cron},env,{waitUntil(promise){waits.push(promise);}});
  assert.equal(waits.length,1);
  return (await Promise.all(waits))[0];
}

test('configured continuation cadence matches the active runtime and avoids other schedules',()=>{
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  const runtime=readFileSync(new URL('../src/index-v029.js',import.meta.url),'utf8');
  assert.equal(config.main,'src/index-v029.js');
  assert.equal(config.vars.PLAYER_STATE_CHUNK_SIZE,'40');
  assert.deepEqual(config.triggers.crons,['*/15 * * * *','17 4 * * *',continuationCron]);
  assert.equal(runtime.match(/const PLAYER_STATE_CONTINUATION_CRON='([^']+)'/)[1],continuationCron);
  const minutes=continuationCron.split(' ')[0].split(',').map(Number);
  assert.equal(new Set(minutes).size,11);
  assert.ok(minutes.every(minute=>minute%15!==0&&minute!==17));
});

for(const count of [0,41])test(`scheduled start, continuation and promotion preserve count ${count} and D1 metadata`,async t=>{
  const f=fixture(t,{count});
  const logs=[];
  t.mock.method(console,'log',value=>logs.push(JSON.parse(value)));
  const first=await scheduled('17 4 * * *',f.env);
  assert.equal(first.captured,true);
  assert.equal(f.runs.length,1);
  assert.equal(f.runs[0].run_type,'player_state:scheduled');
  let result;
  for(let i=0;i<20;i++){
    result=await scheduled(continuationCron,f.env);
    if(result.complete)break;
  }
  assert.equal(result.complete,true);
  assert.equal(result.promoted,count);
  assert.equal(f.sweeps.get(1).promotion_offset,count);
  assert.equal(f.runs[0].item_count,count);
  assert.equal(f.runs[0].ok,1);
  const counts=f.calls.queries.filter(query=>query.sql.startsWith('SELECT COUNT(*) candidate_count'));
  assert.equal(counts.length,1);
  assert.equal(counts[0].method,'all');
  const commits=f.calls.batches.filter(batch=>batch.some(stmt=>stmt.sql.startsWith('UPDATE watcher_runs SET finished_at')));
  assert.equal(commits.length,1);
  assert.equal(commits[0].length,6);
  assert.equal(commits[0][2].args[0],count);
  assert.equal(commits[0][3].args[3],count,'finalization guard uses the same candidate count');
  const loadLogs=logs.filter(row=>row.phase==='promotion.load'&&row.state==='ok');
  assert.equal(loadLogs.length,1);
  const {query_count,rows_read,rows_written,sql_ms}=loadLogs[0];
  assert.deepEqual({query_count,rows_read,rows_written,sql_ms},{query_count:1,rows_read:count,rows_written:0,sql_ms:1.25});
  assert.equal(f.candidates.size,0);
  assert.equal(f.frames.size,0);

  const snapshot=()=>JSON.stringify([f.runs,[...f.sweeps],[...f.candidates],[...f.frames],[...f.evidence],[...f.state],f.calls.batches,f.calls.fetches]);
  const before=snapshot();
  f.calls.queries.length=0;
  for(let i=0;i<3;i++)assert.deepEqual(await scheduled(continuationCron,f.env),{ok:true,idle:true});
  assert.equal(snapshot(),before);
  assert.equal(f.calls.queries.length,3);
  assert.ok(f.calls.queries.every(query=>query.method==='first'&&query.sql.startsWith('SELECT s.run_id')));
});

test('idle scheduled continuation before any run only checks for an active sweep',async t=>{
  const f=fixture(t);
  assert.deepEqual(await scheduled(continuationCron,f.env),{ok:true,idle:true});
  assert.equal(f.calls.queries.length,1);
  assert.match(f.calls.queries[0].sql,/^SELECT s.run_id/);
  assert.equal(f.calls.queries[0].method,'first');
  assert.equal(f.runs.length,0);
  assert.equal(f.candidates.size,0);
  assert.equal(f.evidence.size,0);
  assert.equal(f.calls.batches.length,0);
  assert.equal(f.calls.fetches.length,0);
});
