import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {normalizeNews,newsPlayerDirectory} from '../src/news-source.js';
import {beginChunkedPlayerStateSweep,continueChunkedPlayerStateSweep} from '../src/index.js';
const AT=Date.UTC(2026,9,12,8);
const player={full_name:'Marvin Harrison',position:'WR',team:'ARI',status:'Active'};
const directory=[{player_id:'11628',full_name:player.full_name}];
const article={id:123,headline:'Marvin Harrison trade rumors',published:new Date(AT-1000).toISOString(),links:{web:{href:'https://www.espn.com/nfl/story/_/id/123/example'}},categories:[{type:'athlete',description:player.full_name}]};

test('P2 exact malformed description cannot abort a valid neighbouring article',async()=>{
  const malformed={...article,categories:[{type:'athlete',description:{toString:0}}]};
  const result=await normalizeNews({articles:[malformed,article]},directory,AT);
  assert.equal(result.rejected,1);assert.equal(result.events.length,1);
});

test('P2 malformed consumed fields reject only their article, with visible counts',async()=>{
  const broken={toString:0};
  const cases=[{headline:broken},{headline:[]},{id:broken},{id:[]},{published:broken},{lastModified:broken},
    {links:{web:{href:broken}}},{categories:broken},{categories:null},{categories:[null]},
    {categories:[{type:broken}]},{categories:[{type:'athlete',description:[]} ]},
    {categories:[{type:'athlete',athlete:broken,description:broken}]},
    {categories:[{type:'athlete',athlete:{description:broken}}]},
    {categories:Array(101).fill({type:'athlete',description:player.full_name})},
    {categories:[{type:'athlete',description:'x'.repeat(301)}]}];
  for(const extra of cases){
    const result=await normalizeNews({articles:[{...article,...extra},article]},directory,AT);
    assert.equal(result.rejected,1,JSON.stringify(extra));assert.equal(result.events.length,1);
  }
  const fallback=await normalizeNews({articles:[{...article,categories:[{type:'athlete',athlete:{description:player.full_name}}]}]},directory,AT);
  assert.equal(fallback.rejected,0);assert.equal(fallback.events.length,1);
});

test('P1 actual sweep/promotion accepts repeated cross-position observations for News',async t=>{
  t.mock.method(Date,'now',()=>AT);
  let conflicting=false;
  t.mock.method(globalThis,'fetch',async url=>{
    const scope=new URL(url).searchParams.get('position');
    return Response.json(['QB','WR'].includes(scope)?{'11628':conflicting&&scope==='WR'?{...player,team:'OTHER'}:player}:{},{headers:{etag:'fixture-'+scope}});
  });
  const require=createRequire(process.env.PITTI_LOCAL_D1_PACKAGE||resolve('node_modules/wrangler/package.json'));
  const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
  const options={modules:true,script:'export default {fetch(){return new Response("offline")}}',compatibilityDate:'2026-08-10',cf:false,d1Databases:{DB:'news-adversarial'},d1Persist:false,outboundService(){throw Error('NETWORK_FORBIDDEN');}};
  const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
  try{
    const db=await mf.getD1Database('DB'),env={DB:db,PHASE_LOGGING:'0'};
    for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>/^000[1-6]_.*\.sql$/.test(f)).sort())
      for(const sql of readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();
    async function sweep(at){
      let result=await beginChunkedPlayerStateSweep(env,at);
      for(let i=0;i<15&&!result.complete;i++)result=await continueChunkedPlayerStateSweep(env);
      assert.equal(result.complete,true);
      return db.prepare("SELECT * FROM watcher_runs WHERE run_type='player_state:scheduled' ORDER BY id DESC LIMIT 1").first();
    }
    const accepted=await sweep(AT);
    assert.equal(accepted.ok,1);assert.equal(accepted.item_count,2,'producer counts observations, not distinct IDs');
    const frames=(await db.prepare('SELECT * FROM player_state_scope_frames WHERE run_id=? ORDER BY source_scope').bind(accepted.id).all()).results;
    assert.equal(frames.length,5);assert.equal(JSON.parse(frames.find(f=>f.source_scope==='QB').frame_json)[0][1].position,'WR');
    assert.deepEqual((await newsPlayerDirectory(db,AT)).players,directory);
    const before=(await db.prepare('SELECT * FROM player_state').all()).results;
    await db.prepare("CREATE TRIGGER no_unchanged_update BEFORE UPDATE ON player_state BEGIN SELECT RAISE(ABORT,'unexpected unchanged player update'); END").run();
    await db.prepare("CREATE TRIGGER no_unchanged_insert BEFORE INSERT ON player_state BEGIN SELECT RAISE(ABORT,'unexpected unchanged player insert'); END").run();
    t.mock.method(Date,'now',()=>AT+1000);
    const repeated=await sweep(AT+1000);
    assert.equal(repeated.item_count,2);
    assert.deepEqual((await db.prepare('SELECT * FROM player_state').all()).results,before,'unchanged players receive no canonical writes');
    await db.prepare('DROP TRIGGER no_unchanged_update').run();await db.prepare('DROP TRIGGER no_unchanged_insert').run();
    assert.deepEqual((await newsPlayerDirectory(db,AT+1000)).players,directory);
    const frame=await db.prepare("SELECT frame_json FROM player_state_scope_frames WHERE run_id=? AND source_scope='WR'").bind(repeated.id).first();
    for(const conflict of [{full_name:'Other Person'},{team:'OTHER'},{position:'RB'},{injury_status:'Out'}]){
      const entries=JSON.parse(frame.frame_json);Object.assign(entries[0][1],conflict);
      await db.prepare("UPDATE player_state_scope_frames SET frame_json=? WHERE run_id=? AND source_scope='WR'").bind(JSON.stringify(entries),repeated.id).run();
      await assert.rejects(newsPlayerDirectory(db,AT+1000),/NEWS_PLAYER_SNAPSHOT_CONFLICT/);
    }
    await db.prepare("UPDATE player_state_scope_frames SET frame_json=? WHERE run_id=? AND source_scope='WR'").bind(frame.frame_json,repeated.id).run();
    // The producer can accept conflicting observations via candidate UPSERT.
    // The News reader must not silently inherit that last-writer selection.
    conflicting=true;t.mock.method(Date,'now',()=>AT+2000);
    const conflictRun=await sweep(AT+2000);assert.equal(conflictRun.ok,1);
    await assert.rejects(newsPlayerDirectory(db,AT+2000),/NEWS_PLAYER_SNAPSHOT_CONFLICT/);
    await assert.rejects(newsPlayerDirectory(db,AT+37*3600000),/UNAVAILABLE/);
  }finally{await mf.dispose();}
});
