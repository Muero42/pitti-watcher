import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceFingerprint,latestMarketFrameRows,marketTransitionPlan,processTrendingFrameRun,runTrendingFrames} from '../src/index.js';
import v029Worker from '../src/index-v029.js';

const success=(changes=1)=>({success:true,meta:{changes}});

function fixture(t){
  const runs=[];
  const frames=[];
  const evidence=new Map();
  const calls={frameInserts:0,framePrunes:0,batchSizes:[]};
  let stage=0;
  let failEvidence=false;
  const players=Array.from({length:185},(_,i)=>String(i).padStart(4,'0'));
  const acceptedFrames=()=>frames.filter(frame=>{
    const run=runs.find(row=>row.id===frame.run_id);
    return run?.ok===1&&run.finished_at!=null;
  });

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
          if(sql.startsWith('SELECT f.captured_at')){
            const row=acceptedFrames().at(-1);return row?{...row}:null;
          }
          if(sql.startsWith('SELECT finished_at,ok,item_count,error'))return runs.find(row=>row.id===args[0])||null;
          throw new Error(`Unexpected first: ${sql}`);
        },
        async all(){
          if(sql.startsWith('SELECT f.captured_at')){
            const row=acceptedFrames().at(-1);return{results:row?[{...row}]:[]};
          }
          if(sql.startsWith('SELECT player_id,full_name,team,position FROM player_state WHERE player_id IN')){
            return{results:args.map(id=>({player_id:String(id),full_name:`Player ${id}`,team:'AAA',position:'WR'}))};
          }
          throw new Error(`Unexpected all: ${sql}`);
        },
        async run(){
          if(sql.startsWith('INSERT INTO trending_snapshot_frames')){
            frames.push({captured_at:args[0],run_id:args[1],player_count:args[2],frame_json:args[3],signal_state_json:args[4]});
            frames.sort((a,b)=>a.captured_at-b.captured_at);calls.frameInserts++;return success();
          }
          if(sql.startsWith('DELETE FROM trending_snapshot_frames')){
            const candidates=frames.filter(row=>row.captured_at<args[0]);
            for(const stale of candidates)frames.splice(frames.indexOf(stale),1);
            if(candidates.length)calls.framePrunes++;
            return success(candidates.length);
          }
          if(sql.startsWith('UPDATE watcher_runs')){
            const row=runs.find(x=>x.id===args[4]&&x.finished_at==null);
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
      if(failEvidence&&statements.some(stmt=>stmt.sql.startsWith('INSERT INTO evidence_events'))){
        failEvidence=false;
        throw new Error('synthetic termination after frame insert');
      }
      for(const stmt of statements){
        if(stmt.sql.startsWith('INSERT INTO evidence_events')){
          evidence.set(stmt.args[0],{fingerprint:stmt.args[0],event_type:stmt.args[2],payload_json:stmt.args[12],observation_run_id:stmt.args[13]});
        }else throw new Error(`Unexpected batch: ${stmt.sql}`);
      }
      return statements.map(()=>success());
    }
  };

  t.mock.method(globalThis,'fetch',async input=>{
    const url=new URL(String(input));
    const type=url.pathname.endsWith('/add')?'add':'drop';
    const hours=Number(url.searchParams.get('lookback_hours'));
    const rows=players.map((player_id,i)=>{
      let count=type==='add'?1:0;
      if(i===0&&type==='add'&&hours===1)count=[0,30,100,0][stage];
      return{player_id,count};
    });
    return new Response(JSON.stringify(rows),{status:200,headers:{'content-type':'application/json'}});
  });

  return{
    env:{DB,TREND_LIMIT:'200'},runs,frames,evidence,calls,
    setStage(value){stage=value;},failNextEvidence(){failEvidence=true;}
  };
}

test('scheduled market cron routes to frame capture and completes a trending run',async t=>{
  const f=fixture(t);
  const waits=[];
  await v029Worker.scheduled({cron:'*/15 * * * *'},f.env,{waitUntil(promise){waits.push(promise);}});
  assert.equal(waits.length,1);
  await Promise.all(waits);
  assert.equal(f.runs.length,1);
  assert.equal(f.runs[0].run_type,'trending:scheduled');
  assert.equal(f.runs[0].ok,1);
  assert.equal(f.calls.frameInserts,1);
});

test('market lane writes one compact frame, retains two frames, and emits transitions only',async t=>{
  const f=fixture(t);
  for(let stage=0;stage<4;stage++){
    f.setStage(stage);
    const result=await runTrendingFrames(f.env,1000+stage,'scheduled');
    assert.equal(result.ok,true);
    assert.equal(result.players,185);
  }
  assert.equal(f.calls.frameInserts,4);
  assert.equal(f.calls.framePrunes,2);
  assert.equal(f.frames.length,2);
  assert.ok(f.calls.batchSizes.every(size=>size<=75));
  assert.deepEqual([...f.evidence.values()].map(row=>row.event_type),[
    'MARKET_ACCELERATION_STARTED','MARKET_ACCELERATION_LEVEL_UP','MARKET_ACCELERATION_ENDED'
  ]);
  assert.deepEqual(JSON.parse(f.frames.at(-1).signal_state_json),[]);
  assert.ok(f.runs.every(run=>run.ok===1&&run.item_count===185));
});

test('transition evidence identity is stable across retries and independent of the hour',async()=>{
  const previous=[{player_id:'p1',adds_1h:0,drops_1h:0}];
  const current=[{player_id:'p1',adds_1h:30,drops_1h:0}];
  const first=marketTransitionPlan(current,previous,[],1000).events[0];
  const retried={...first,occurred_at:999999999,first_seen_at:999999999,last_seen_at:999999999};
  assert.equal(await evidenceFingerprint(first),await evidenceFingerprint(retried));
});

test('latest compact market frame is enriched for the companion feed',async t=>{
  const f=fixture(t);
  await runTrendingFrames(f.env,2000,'scheduled');
  const rows=await latestMarketFrameRows(f.env,3);
  assert.equal(rows.length,3);
  assert.equal(rows[0].captured_at,2000);
  assert.match(rows[0].full_name,/Player/);
});

test('a termination after frame insert cannot promote that frame or its embedded signal generation',async t=>{
  const f=fixture(t);
  await runTrendingFrames(f.env,1000,'scheduled');
  f.setStage(1);
  f.runs.push({id:2,run_type:'trending:scheduled',started_at:2000,finished_at:null,ok:0,item_count:0,error:null});
  f.failNextEvidence();
  await assert.rejects(processTrendingFrameRun(f.env,2000,2),/synthetic termination/);
  assert.equal(f.frames.at(-1).run_id,2);

  f.setStage(2);
  await runTrendingFrames(f.env,3000,'scheduled');
  const accepted=await latestMarketFrameRows(f.env,1);
  assert.equal(accepted[0].captured_at,3000);
  assert.equal([...f.evidence.values()].at(-1).event_type,'MARKET_ACCELERATION_STARTED');
});

test('a completed frame/evidence work phase stays invisible until its run is finalized',async t=>{
  const f=fixture(t);
  await runTrendingFrames(f.env,1000,'scheduled');
  f.setStage(1);
  f.runs.push({id:2,run_type:'trending:scheduled',started_at:2000,finished_at:null,ok:0,item_count:0,error:null});
  await processTrendingFrameRun(f.env,2000,2);
  const visible=await latestMarketFrameRows(f.env,1);
  assert.equal(visible[0].captured_at,1000);
  assert.ok([...f.evidence.values()].some(row=>row.observation_run_id===2));
});

test('v0.2.9 market route reads only the latest accepted compact frame',async t=>{
  const f=fixture(t);
  f.env.WATCHER_TOKEN='secret';
  await runTrendingFrames(f.env,1000,'scheduled');
  f.setStage(1);
  f.runs.push({id:2,run_type:'trending:scheduled',started_at:2000,finished_at:null,ok:0,item_count:0,error:null});
  await processTrendingFrameRun(f.env,2000,2);

  const response=await v029Worker.fetch(new Request('https://local.invalid/market?limit=1',{
    headers:{authorization:'Bearer secret'}
  }),f.env,{});
  assert.equal(response.status,200);
  const rows=await response.json();
  assert.equal(rows.length,1);
  assert.equal(rows[0].captured_at,1000);
});
