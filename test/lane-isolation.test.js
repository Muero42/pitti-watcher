import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptedLaneStatus,runLaneStatus,overallLaneGate,filterLaneEvents,buildFreeAgencyRadar,companionFeed} from '../src/index-v027.js';

const NOW=1_800_000_000_000;
const okRun=age=>({ok:1,started_at:NOW-age,finished_at:NOW-age+1000,item_count:10});
const failedRun={ok:0,started_at:NOW-10_000,finished_at:NOW-9000,item_count:0};

test('Companion uses accepted started_at at the 36-hour boundary with open and failed newer attempts',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const HOUR=3600_000;
  const accepted={id:1,ok:1,started_at:NOW-36*HOUR,finished_at:NOW-1000,item_count:4363};
  const open={id:3,ok:0,started_at:NOW-500,finished_at:null,item_count:0};
  let failure=null;
  const env={DB:{prepare(sql){return{
    async first(){
      if(sql.includes("run_type='trending:scheduled'"))return null;
      if(sql.includes("run_type='player_state:scheduled'")){
        if(sql.includes('AND ok=1'))return accepted;
        if(sql.includes('AND ok=0'))return failure;
        return open;
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async all(){assert.match(sql,/FROM evidence_events/);return{results:[]};}
  };}}};
  const gate=async()=> (await (await companionFeed(new Request('https://local.invalid/companion-feed'),env,{})).json()).gate.player_state_status;
  assert.equal(await gate(),'PASS');
  accepted.started_at--;
  assert.equal(await gate(),'STALE','recent finish must not refresh an old frozen observation');
  accepted.started_at=NOW-2*HOUR;
  assert.equal(await gate(),'PASS');
  failure={id:2,...failedRun};
  assert.equal(await gate(),'FAIL','completed newer failure closes the lane even with an open attempt');
});

test('market PASS survives player-state FAIL',()=>{
  const market=runLaneStatus(okRun(10*60_000),45*60_000,NOW);
  const player=runLaneStatus(failedRun,36*3600_000,NOW);
  assert.equal(market,'PASS');
  assert.equal(player,'FAIL');
  assert.equal(overallLaneGate(market,player),'PASS');
});

test('player-state PASS survives market STALE',()=>{
  const market=runLaneStatus(okRun(60*60_000),45*60_000,NOW);
  const player=runLaneStatus(okRun(2*3600_000),36*3600_000,NOW);
  assert.equal(market,'STALE');
  assert.equal(player,'PASS');
  assert.equal(overallLaneGate(market,player),'PASS');
});

test('lane filtering prevents stale fundamental evidence from leaking into market-only feed',()=>{
  const events=[
    {id:1,fundamental_or_market:'market',player_id:'a'},
    {id:2,fundamental_or_market:'fundamental',player_id:'b'}
  ];
  assert.deepEqual(filterLaneEvents(events,{marketStatus:'PASS',playerStateStatus:'FAIL'}).map(x=>x.id),[1]);
  assert.deepEqual(filterLaneEvents(events,{marketStatus:'FAIL',playerStateStatus:'PASS'}).map(x=>x.id),[2]);
});

test('free-agency radar still excludes owned players under a single healthy lane',()=>{
  const league={ok:true,ownership:{owned:{mine:false}}};
  const events=[
    {player_id:'free',fundamental_or_market:'fundamental'},
    {player_id:'owned',fundamental_or_market:'fundamental'}
  ];
  const radar=buildFreeAgencyRadar(events,[],league);
  assert.equal(radar.available,true);
  assert.deepEqual(radar.candidates.map(x=>x.player_id),['free']);
  assert.equal(radar.candidates[0].fundamental_events,1);
});

test('all unhealthy lanes remain fail-closed',()=>{
  assert.equal(overallLaneGate('FAIL','STALE'),'FAIL');
  assert.equal(overallLaneGate('WAIT_FOR_SCHEDULED_EVIDENCE','STALE'),'STALE');
});

test('an open sweep keeps the last accepted observation available while an explicit failure closes it',()=>{
  const accepted={id:1,...okRun(2*3600_000)};
  const failure={id:2,...failedRun};
  const open={id:3,ok:0,started_at:NOW-1000,finished_at:null,item_count:0};
  assert.equal(acceptedLaneStatus(open,accepted,null,36*3600_000,NOW),'PASS');
  assert.equal(acceptedLaneStatus(failure,accepted,failure,36*3600_000,NOW),'FAIL');
  assert.equal(acceptedLaneStatus(open,null,null,36*3600_000,NOW),'FAIL');
  assert.equal(acceptedLaneStatus(open,accepted,failure,36*3600_000,NOW),'FAIL');
});
