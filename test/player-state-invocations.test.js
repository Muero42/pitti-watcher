import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {recordPlayerStateInvocation,LEDGER_FINISH_SQL,LEDGER_RETENTION_SQL} from '../src/player-state-invocations.js';

function fixture(t, failure='') {
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0005_player_state_invocation_ledger.sql',import.meta.url),'utf8'));
  t.after(()=>db.close());
  const logs=[];
  t.mock.method(console,'log',value=>logs.push(JSON.parse(value)));
  const env={DB:{prepare(sql){return {bind(...args){return {async run(){
    if(failure && sql.startsWith(failure)) throw new Error('secret token player payload');
    const result=db.prepare(sql).run(...args);
    return {success:true,meta:{changes:Number(result.changes)}};
  }}}}}}};
  return {db,env,logs,rows:()=>db.prepare('SELECT * FROM player_state_invocations ORDER BY started_at,id').all()};
}

for(const kind of ['daily_start','continuation']) test(`${kind} records actual interval, schedule and cursor`,async t=>{
  const f=fixture(t);let now=1000000;t.mock.method(Date,'now',()=>now);
  const result=await recordPlayerStateInvocation(f.env,{scheduledTime:999000,cron:'secret'},kind,async context=>{
    assert.equal(f.rows()[0].state,'open');
    Object.assign(context,{run_id:42,scope_index:5,scope_offset:80});now+=250;return {ok:true};
  });
  assert.deepEqual(result,{ok:true});const row=f.rows()[0];
  assert.equal(row.started_at,1000000);assert.equal(row.finished_at,1000250);
  assert.equal(row.scheduled_at,999000);assert.equal(row.trigger_kind,kind);
  assert.equal(row.run_id,42);assert.equal(row.scope_index,5);assert.equal(row.scope_offset,80);
  assert.equal(row.state,'ok');assert.equal(row.error_code,null);
  assert.ok(!JSON.stringify(row).includes('secret'));
});

test('core failure identity survives and only fixed safe code is persisted',async t=>{
  const f=fixture(t);const error=new Error('secret-token player-name stack');
  await assert.rejects(recordPlayerStateInvocation(f.env,{},'continuation',async c=>{
    c.run_id=7;throw error;
  }),e=>e===error);
  assert.equal(f.rows()[0].state,'fail');assert.equal(f.rows()[0].run_id,7);
  assert.equal(f.rows()[0].error_code,'PLAYER_STATE_WORK_FAILED');
  assert.ok(!JSON.stringify(f.rows()).includes('secret'));
});

for(const failure of ['INSERT','UPDATE','DELETE']) test(`${failure} failure cannot fail healthy core`,async t=>{
  const f=fixture(t,failure);let calls=0;
  assert.equal(await recordPlayerStateInvocation(f.env,{},'daily_start',async()=>{calls++;return 123;}),123);
  assert.equal(calls,1);assert.equal(f.logs.length,1);
  assert.ok(!JSON.stringify(f.logs).includes('secret'));
  if(failure==='UPDATE'){assert.equal(f.rows()[0].state,'open');assert.equal(f.rows()[0].finished_at,null);}
});

test('simultaneous core and ledger finish failures preserve core exception',async t=>{
  const f=fixture(t,'UPDATE');const error=new Error('core');
  await assert.rejects(recordPlayerStateInvocation(f.env,{},'continuation',async()=>{throw error;}),e=>e===error);
  assert.equal(f.rows()[0].state,'open');
});

test('retries are distinct and duplicate finalization cannot touch another row',async t=>{
  const f=fixture(t);for(let i=0;i<2;i++)await recordPlayerStateInvocation(f.env,{scheduledTime:5},'continuation',async()=>({ok:true,idle:true}));
  const rows=f.rows();assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);
  assert.equal(f.db.prepare(LEDGER_FINISH_SQL).run(9,999,9,9,'fail','PLAYER_STATE_WORK_FAILED',rows[0].id).changes,0);
  assert.deepEqual(f.rows(),rows);
});

test('retention deletes at most 512 old rows and preserves seven recent days including open rows',async t=>{
  const f=fixture(t);const now=10*86400000;t.mock.method(Date,'now',()=>now);
  const insert=f.db.prepare("INSERT INTO player_state_invocations(id,started_at,trigger_kind) VALUES(?,?,'continuation')");
  for(let i=0;i<600;i++)insert.run('old'+i,1);
  insert.run('boundary',3*86400000);insert.run('recent',now-1);
  await recordPlayerStateInvocation(f.env,{},'daily_start',async()=>true);
  assert.equal(f.rows().filter(r=>r.started_at===1).length,88);
  assert.ok(f.rows().some(r=>r.id==='boundary'));assert.ok(f.rows().some(r=>r.id==='recent'));
  assert.match(LEDGER_RETENTION_SQL,/LIMIT 512/);
});

test('actual continuation intervals close missing-timing gap while overlap/open/unmatched stay unknown',()=>{
  const minute=60000;
  const market=Array.from({length:96},(_,i)=>({lane:'MARKET',started_at:i*15*minute+1000,finished_at:i*15*minute+3000}));
  const player=[{lane:'PLAYER_STATE',started_at:257*minute+17000,finished_at:257*minute+19000}];
  for(let m=262;m<=887;m++)if([2,7,12,22,27,32,37,42,47,52,57].includes(m%60))
    player.push({lane:'PLAYER_STATE',started_at:m*minute+17000,finished_at:m*minute+19000});
  const classify=(m,intervals)=>{
    const hits=intervals.filter(r=>r.started_at<(m+1)*minute && (r.finished_at===null || r.finished_at>=m*minute));
    return hits.length===1 && hits[0].finished_at!==null ? hits[0].lane : 'UNKNOWN';
  };
  const buckets=[...market,...player].map(r=>({minute:Math.floor(r.started_at/minute),rowsWritten:10}));
  assert.equal(market.length,96);
  for(const b of buckets)assert.notEqual(classify(b.minute,[...market,...player]),'UNKNOWN');
  assert.equal(classify(262,market),'UNKNOWN','a cron string supplies no interval');
  assert.equal(classify(262,[...market,...player]),'PLAYER_STATE');
  assert.equal(classify(0,[...market,...player]),'MARKET');
  const spill={lane:'PLAYER_STATE',started_at:14*minute+59000,finished_at:15*minute+2000};
  assert.equal(classify(15,[...market,spill]),'UNKNOWN');
  assert.equal(classify(14,[...market,spill]),'PLAYER_STATE');
  assert.equal(classify(5,[{lane:'PLAYER_STATE',started_at:4*minute,finished_at:null}]),'UNKNOWN');
  assert.equal(classify(1,[...market,...player]),'UNKNOWN');
});
