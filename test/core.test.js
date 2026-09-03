import test from 'node:test';
import assert from 'node:assert/strict';
import { ownershipStatus, buildFreeAgencyRadar, marketSignals, previousTrendingSnapshotSql } from '../src/index.js';

test('ownershipStatus distinguishes mine, opponent, and free agent', () => {
  const league={ownership:{
    A:{mine:true}, B:{mine:false}
  }};
  assert.equal(ownershipStatus(league,'A'),'mine');
  assert.equal(ownershipStatus(league,'B'),'opponent');
  assert.equal(ownershipStatus(league,'C'),'free_agent');
});

test('free-agency radar excludes owned players and prioritizes fundamental signals', () => {
  const league={ok:true,ownership:{
    OWNED:{mine:false},
    MINE:{mine:true}
  }};
  const market=[
    {player_id:'FA1',full_name:'Free One',adds_1h:10,adds_3h:20,adds_24h:40,drops_1h:0},
    {player_id:'OWNED',full_name:'Owned',adds_1h:999,adds_3h:999,adds_24h:999,drops_1h:0},
    {player_id:'FA2',full_name:'Free Two',adds_1h:1,adds_3h:1,adds_24h:1,drops_1h:0}
  ];
  const events=[
    {player_id:'FA2',fundamental_or_market:'fundamental',event_type:'PLAYER_STATE_CHANGED'},
    {player_id:'OWNED',fundamental_or_market:'fundamental',event_type:'PLAYER_STATE_CHANGED'}
  ];
  const radar=buildFreeAgencyRadar(events,market,league);
  assert.equal(radar.available,true);
  assert.deepEqual(radar.candidates.map(x=>x.player_id),['FA2','FA1']);
  assert.ok(!radar.candidates.some(x=>x.player_id==='OWNED'));
});

test('marketSignals preserves watcher alert thresholds', () => {
  const a=marketSignals({adds_1h:25,drops_1h:20},{adds_1h:10,drops_1h:8});
  assert.equal(a.marketAcceleration,true);
  assert.equal(a.marketReversal,true);
  const b=marketSignals({adds_1h:24,drops_1h:19},{adds_1h:0,drops_1h:0});
  assert.equal(b.marketAcceleration,false);
  assert.equal(b.marketReversal,false);
});


test('previous trending snapshot query is bounded to one capture instead of scanning history per player', () => {
  const sql=previousTrendingSnapshotSql().replace(/\s+/g,' ').trim();
  assert.match(sql,/WHERE captured_at=\( SELECT MAX\(captured_at\)/);
  assert.doesNotMatch(sql,/GROUP BY/i);
  assert.doesNotMatch(sql,/JOIN/i);
});


test('watcher source keeps unchanged player state write-free', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /if \(old\.state_hash === hash\) continue;/);
  assert.doesNotMatch(source, /UPDATE player_state SET last_seen_at=\?1 WHERE player_id=\?2/);
});

test('watcher bounds trending history to previous plus current capture', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /DELETE FROM trending_snapshots WHERE captured_at < \?1/);
  assert.match(source, /ORDER BY captured_at DESC LIMIT 1/);
});


test('companion feed probes only latest scheduled run per type', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /run_type='trending:scheduled' ORDER BY id DESC LIMIT 1/);
  assert.match(source, /run_type='player_state:scheduled' ORDER BY id DESC LIMIT 1/);
  assert.doesNotMatch(source, /WHERE run_type IN \('trending:scheduled','player_state:scheduled'\)[\s\S]{0,100}LIMIT 40/);
});


test('scheduled trending retention is write-bounded', () => {
  assert.match(source, /async function pruneTrendingSnapshots/);
  assert.match(source, /LIMIT \?2/);
  assert.match(source, /TREND_PRUNE_BATCH/);
  assert.doesNotMatch(source, /DELETE FROM trending_snapshots WHERE captured_at < \?1/);
});
