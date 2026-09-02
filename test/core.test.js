import test from 'node:test';
import assert from 'node:assert/strict';
import { ownershipStatus, buildFreeAgencyRadar, buildRosterMoveRadar, buildTradeRadar, safePayload, marketSignals, previousTrendingSnapshotSql } from '../src/index.js';

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


test('free-agency payload parser accepts stored JSON text', () => {
  assert.equal(safePayload('{"player":"Example"}').player,'Example');
  assert.deepEqual(safePayload('{broken'),{});
});

test('roster move radar excludes reserve and protects starters', () => {
  const league={ok:true,my_roster:{roster_id:9},my_players:['START','BENCH','IR'],my_reserve:['IR'],my_starters:['START']};
  const fa={available:true,candidates:[{player_id:'FA',signal_score:10}]};
  const states=[
    {player_id:'START',full_name:'Starter',position:'RB'},
    {player_id:'BENCH',full_name:'Bench',position:'WR'},
    {player_id:'IR',full_name:'Reserve',position:'RB'}
  ];
  const x=buildRosterMoveRadar(fa,league,states);
  assert.equal(x.available,true);
  assert.deepEqual(x.drop_candidates.map(p=>p.player_id),['BENCH','START']);
  assert.ok(!x.drop_candidates.some(p=>p.player_id==='IR'));
  assert.equal(x.drop_candidates.find(p=>p.player_id==='BENCH').actionable,false);
  assert.equal(x.drop_candidates.find(p=>p.player_id==='BENCH').valuation_status,'awaiting_current_replacement_upside_evidence');
  assert.equal(x.policy.skill_bench_fail_closed,true);
  assert.equal(x.policy.automatic_moves,false);
});

test('trade radar is discovery-only until external valuation and fit exist', () => {
  const league={ok:true,my_roster:{roster_id:9},my_players:['ME'],rosters:[
    {roster_id:9,owner_id:'me',players:['ME']},
    {roster_id:2,owner_id:'them',players:['TARGET']}
  ]};
  const x=buildTradeRadar(league,[{player_id:'TARGET',full_name:'Target',position:'RB'}]);
  assert.equal(x.available,true);
  assert.equal(x.targets.length,1);
  assert.equal(x.targets[0].actionable,false);
  assert.equal(x.targets[0].valuation.boone,null);
  assert.equal(x.policy.automatic_trades,false);
});

test('roster move radar exposes streamable K/DST capacity without making skill bench actionable', () => {
  const league={ok:true,my_roster:{roster_id:9},my_players:['WR','K','DST'],my_reserve:[],my_starters:[]};
  const fa={available:true,candidates:[]};
  const states=[
    {player_id:'WR',full_name:'Upside WR',position:'WR'},
    {player_id:'K',full_name:'Kicker',position:'K'},
    {player_id:'DST',full_name:'Defense',position:'DEF'}
  ];
  const x=buildRosterMoveRadar(fa,league,states);
  assert.deepEqual(x.actionable_drop_candidates.map(p=>p.player_id).sort(),['DST','K']);
  assert.equal(x.drop_candidates.find(p=>p.player_id==='WR').actionable,false);
});
