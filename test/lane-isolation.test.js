import test from 'node:test';
import assert from 'node:assert/strict';
import {runLaneStatus,overallLaneGate,filterLaneEvents,buildFreeAgencyRadar} from '../src/index-v027.js';

const NOW=1_800_000_000_000;
const okRun=age=>({ok:1,started_at:NOW-age,finished_at:NOW-age+1000,item_count:10});
const failedRun={ok:0,started_at:NOW-10_000,finished_at:NOW-9000,item_count:0};

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
