import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {articleUrl,normalizeNews,newsPlayerDirectory,runNews,newsFeed,retainNews} from '../src/news-source.js';
import {processPlayerStateSweepChunk} from '../src/index.js';
import {seedNewsDirectory} from './helpers/news-directory.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/espn-news-2026-10-12.json',import.meta.url)));
const AT=Date.parse(fixture.capturedAt),DAY=86400000;
const player={player_id:'11628',full_name:'Marvin Harrison',position:'WR'};
const article={id:123,headline:'Marvin Harrison Jr. trade rumors continue',published:new Date(AT-60000).toISOString(),links:{web:{href:'http://www.espn.com/nfl/story/_/id/123/example'}},categories:[{type:'athlete',description:'Marvin Harrison Jr.'}]};
const fetcher=articles=>async()=>Response.json({articles});

test('observed ESPN fixture: HTTP upgrade, strict host/path/ID, isolated invalid articles and canonical replay',async()=>{
  const observedHttp=fixture.articles.filter(a=>a.links.web.href.startsWith('http:'));
  assert(observedHttp.length>0);
  for(const a of observedHttp)assert.equal(articleUrl(a.links.web.href,a.id).protocol,'https:');
  for(const url of ['https://www.espn.com.evil.test/nfl/story/_/id/123/example','http://espn.com/nfl/story/_/id/123/example',
    'https://evil@www.espn.com/nfl/story/_/id/123/example','https://www.espn.com:444/nfl/story/_/id/123/example',
    'javascript:alert(1)','https://www.espn.com/redirect/123','https://www.espn.com/nfl/story/_/id/124/example',
    'https://www.espn.com/nfl/story/_/id/123/%2e%2e','http:\\www.espn.com/nfl/story/_/id/123/example'])assert.throws(()=>articleUrl(url,123));
  const normalized=await normalizeNews({articles:[article,{...article,links:{web:{href:'https://evil.test/'}}},
    {...article,links:{web:{href:article.links.web.href.replace('http:','https:')}}}]},[player],AT);
  assert.equal(normalized.rejected,1);assert.equal(normalized.events.length,1);
  assert.equal((await normalizeNews({articles:[{...article,categories:[null]},article]},[player],AT)).events.length,1,'malformed category cannot abort valid neighbours');
  assert.equal((await normalizeNews({articles:[article]},[player,{...player,player_id:'other',full_name:'Marvin Harrison Jr.'}],AT)).events.length,0);
  const players=[...new Set(fixture.articles.flatMap(a=>a.categories.map(c=>c.description)).filter(Boolean))].map((full_name,i)=>({player_id:'fixture-'+i,full_name}));
  const real=await normalizeNews(fixture,players,AT);
  const excluded=fixture.articles.filter(a=>a.links.web.href.includes('/espn/betting/'));
  assert.equal(real.rejected,excluded.length,'observed article routes validate; betting routes remain outside the allowlist');
  assert(real.events.length>0); // Category-derived IDs are fixture-only, not verified Production coverage.
});

test('real workerd: accepted snapshot, unchanged players, isolation, bounded retention and measured cost',async t=>{
  t.mock.method(Date,'now',()=>AT);
  const pkg=process.env.PITTI_LOCAL_D1_PACKAGE||resolve('node_modules/wrangler/package.json');
  const require=createRequire(pkg),{Miniflare,convertV4MiniflareOptions}=require('miniflare');
  const options={modules:true,script:'export default {fetch(){return new Response("offline")}}',compatibilityDate:'2026-08-10',cf:false,d1Databases:{DB:'news-readiness'},d1Persist:false,outboundService(){throw Error('NETWORK_FORBIDDEN');}};
  const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
  const measurements=[];
  try{
    const db=await mf.getD1Database('DB');
    for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>/^000[1-6]_.*\.sql$/.test(f)).sort())
      for(const sql of readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();
    const scalar=async sql=>(await db.prepare(sql).first()).n;
    const record=(name,results)=>{
      assert(results.every(r=>Number.isFinite(r.meta?.rows_read)&&Number.isFinite(r.meta?.rows_written)));
      measurements.push({name,statements:results.length,rows_read:results.reduce((n,r)=>n+r.meta.rows_read,0),rows_written:results.reduce((n,r)=>n+r.meta.rows_written,0),changes:results.reduce((n,r)=>n+r.meta.changes,0)});
    };
    // Instrument actual D1 responses, never estimate metadata from affected rows.
    const measuredDb=label=>{
      const results=[];
      const prepare=(sql,args=[])=>({bind(...a){return prepare(sql,a);},sql,args,
        async all(){const r=await db.prepare(sql).bind(...args).all();results.push(r);return r;},
        async first(){const r=await this.all();return r.results[0]??null;},
        async run(){const r=await db.prepare(sql).bind(...args).run();results.push(r);return r;}});
      return {DB:{prepare,async batch(stmts){const r=await db.batch(stmts.map(s=>db.prepare(s.sql).bind(...s.args)));results.push(...r);return r;}},finish(){record(label,results);}};
    };
    await assert.rejects(newsPlayerDirectory(db,AT),/SNAPSHOT_UNAVAILABLE/);
    await db.prepare('INSERT INTO player_state(player_id,full_name,first_seen_at,last_seen_at,state_hash) VALUES(?,?,?,?,?)').bind(player.player_id,player.full_name,AT-10*DAY,AT-10*DAY,'unchanged').run();
    assert.equal(await scalar(`SELECT count(*) n FROM player_state WHERE last_seen_at>=${AT-36*3600000}`),0);
    const accepted=await seedNewsDirectory(db,AT,[player]);
    const missingSweep=(await db.prepare("INSERT INTO watcher_runs(run_type,started_at,finished_at,ok,item_count) VALUES('player_state:scheduled',?,?,1,1) RETURNING id").bind(AT,AT).first()).id;
    await assert.rejects(newsPlayerDirectory(db,AT),/SNAPSHOT_UNAVAILABLE/,'newest accepted run missing metadata cannot silently fall back');
    await db.prepare('UPDATE watcher_runs SET ok=0 WHERE id=?').bind(missingSweep).run();
    const meter=measuredDb('accepted-directory');
    assert.deepEqual((await newsPlayerDirectory(meter.DB,AT)).players,[{player_id:player.player_id,full_name:player.full_name}]);meter.finish();
    const beforeState=(await db.prepare('SELECT * FROM player_state').all()).results;
    const open=await seedNewsDirectory(db,AT+1,[{...player,player_id:'unaccepted'}],{accepted:false,complete:false});
    assert.equal((await newsPlayerDirectory(db,AT+1)).runId,accepted,'open sweep cannot replace accepted coverage');
    await db.prepare('UPDATE watcher_runs SET finished_at=?,error=? WHERE id=?').bind(AT+2,'FAILED',open).run();
    assert.equal((await newsPlayerDirectory(db,AT+2)).runId,accepted,'failed sweep cannot replace accepted coverage');
    await assert.rejects(newsPlayerDirectory(db,AT+36*3600000),/SNAPSHOT_UNAVAILABLE/);
    await db.prepare("DELETE FROM player_state_scope_frames WHERE run_id=? AND source_scope='K'").bind(accepted).run();
    await assert.rejects(newsPlayerDirectory(db,AT),/SNAPSHOT_INCOMPLETE/);
    await db.prepare("INSERT INTO player_state_scope_frames VALUES(?,'K',?,'fixture',0,'[]')").bind(accepted,AT).run();
    for(const label of ['insert-with-invalid-neighbour','identical-replay']){
      const m=measuredDb(label);
      const result=await runNews({DB:m.DB,NEWS_SOURCE_ENABLED:'1'},AT,fetcher([article,{...article,links:{web:{href:'https://evil.test/'}}}]));
      assert.equal(result.retention,'PASS');assert.equal(result.rejected,1);m.finish();
      assert.equal(await scalar("SELECT count(*) n FROM evidence_events WHERE fundamental_or_market='news'"),1);
      const feed=await newsFeed({DB:db,NEWS_SOURCE_ENABLED:'1'},AT);assert.equal(feed.events.length,1);assert.equal(feed.collectionAudit.rejected,1);
    }
    const saved=(await db.prepare('SELECT * FROM evidence_events').all()).results;
    const broken={prepare:db.prepare.bind(db),batch:stmts=>db.batch([...stmts,db.prepare('INSERT INTO missing_table VALUES(1)')])};
    await assert.rejects(runNews({DB:broken,NEWS_SOURCE_ENABLED:'1'},AT,fetcher([{...article,headline:'Marvin Harrison Jr. trade confirmed'}])));
    assert.deepEqual((await db.prepare('SELECT * FROM evidence_events').all()).results,saved);
    assert.equal((await newsFeed({DB:db,NEWS_SOURCE_ENABLED:'1'},AT)).status,'FAIL');
    assert.equal((await newsFeed({DB:db},AT)).status,'DISABLED');
    assert.deepEqual((await db.prepare('SELECT * FROM player_state').all()).results,beforeState,'no writes for unchanged players');
    const old=AT-100*DAY;
    const oldRun=(await db.prepare("INSERT INTO watcher_runs(run_type,started_at,finished_at,ok) VALUES('news:scheduled',?,?,1) RETURNING id").bind(old,old+1).first()).id;
    const insert=db.prepare(`INSERT INTO evidence_events(fingerprint,event_type,fundamental_or_market,first_seen_at,last_seen_at,source,original_source,authority,confidence,payload_json,observation_run_id)
      VALUES(?,'NEWS_REPORT',?,?,?,'ESPN NFL News','fixture',0,0,'{}',?)`);
    await db.batch(Array.from({length:130},(_,i)=>insert.bind('news:old-'+i,'news',old,old,oldRun)));
    await insert.bind('market-preserved','market',old,old,oldRun).run();
    await insert.bind('player-preserved','fundamental',old,old,oldRun).run();
    const orphan=(await db.prepare("INSERT INTO watcher_runs(run_type,started_at) VALUES('news:scheduled',?) RETURNING id").bind(old).first()).id;
    await insert.bind('news:orphan','news',old,old,orphan).run();
    for(let i=0;i<3;i++){
      const count=await scalar("SELECT count(*) n FROM evidence_events WHERE fingerprint LIKE 'news:old-%'");
      const r=await retainNews(db,AT);record('retention-pass-'+(i+1),r);
      assert(r[0].meta.changes<=64);assert(r[1].meta.changes<=64);
      assert.equal(await scalar("SELECT count(*) n FROM evidence_events WHERE fingerprint LIKE 'news:old-%'"),Math.max(0,count-64));
    }
    assert.equal(await scalar("SELECT count(*) n FROM evidence_events WHERE fundamental_or_market<>'news'"),2);
    assert.equal(await scalar("SELECT count(*) n FROM evidence_events WHERE fingerprint='news:orphan'"),1);
    assert.equal(await scalar(`SELECT count(*) n FROM watcher_runs WHERE id=${oldRun}`),1,'any Evidence reference pins the ledger');
    const idempotent=await retainNews(db,AT);record('retention-idempotent',idempotent);assert(idempotent.every(r=>r.meta.changes===0));
    // Old completed unreferenced News ledgers are removed in batches, open runs survive.
    await db.batch(Array.from({length:70},()=>db.prepare("INSERT INTO watcher_runs(run_type,started_at,finished_at,ok) VALUES('news:scheduled',?,?,0)").bind(old,old+2)));
    const r=await retainNews(db,AT);record('ledger-retention',r);assert(r[1].meta.changes>0&&r[1].meta.changes<=64);
    assert.equal(await scalar(`SELECT count(*) n FROM watcher_runs WHERE id=${orphan}`),1);
    const failedMeter=measuredDb('source-failure-with-retention');
    const oldLedgers=await scalar(`SELECT count(*) n FROM watcher_runs WHERE run_type='news:scheduled' AND finished_at<${AT-90*DAY}`);
    await assert.rejects(runNews({DB:failedMeter.DB,NEWS_SOURCE_ENABLED:'1'},AT,async()=>new Response('',{status:503})),/NEWS_HTTP_503/);failedMeter.finish();
    assert((await scalar(`SELECT count(*) n FROM watcher_runs WHERE run_type='news:scheduled' AND finished_at<${AT-90*DAY}`))<oldLedgers,'failed source collection still retires eligible ledgers');
    // A failed retention transaction rolls back its evidence deletions too.
    await insert.bind('news:rollback-old','news',old,old,oldRun).run();
    await assert.rejects(retainNews(broken,AT));
    assert.equal(await scalar("SELECT count(*) n FROM evidence_events WHERE fingerprint='news:rollback-old'"),1);
    // Real promotion of unchanged state retains all five scopes without a state upsert.
    const pending=await seedNewsDirectory(db,AT+10,[player],{accepted:false});
    const sweep=await db.prepare('SELECT * FROM player_state_sweeps WHERE run_id=?').bind(pending).first();
    t.mock.method(Date,'now',()=>AT+10);
    const p=measuredDb('unchanged-player-promotion');
    await processPlayerStateSweepChunk({DB:p.DB,PHASE_LOGGING:'0'},sweep);p.finish();
    assert.equal((await newsPlayerDirectory(db,AT+10)).runId,pending);
    assert.equal(await scalar(`SELECT count(*) n FROM player_state_scope_frames WHERE run_id=${accepted}`),0);
    assert.equal(await scalar(`SELECT count(*) n FROM player_state_scope_frames WHERE run_id=${pending}`),5);
    assert.deepEqual((await db.prepare('SELECT * FROM player_state').all()).results,beforeState);
    // Deterministic second directory read produces the same logical results and metadata.
    const repeat=measuredDb('accepted-directory-repeat');await newsPlayerDirectory(repeat.DB,AT+10);repeat.finish();
    const failing=await seedNewsDirectory(db,AT+20,[player],{accepted:false});
    await db.prepare(`CREATE TRIGGER fail_readiness_promotion BEFORE UPDATE OF ok ON watcher_runs WHEN NEW.id=${failing} AND NEW.ok=1 BEGIN SELECT RAISE(ABORT,'promotion rollback fixture'); END`).run();
    t.mock.method(Date,'now',()=>AT+20);
    await assert.rejects(processPlayerStateSweepChunk({DB:db,PHASE_LOGGING:'0'},await db.prepare('SELECT * FROM player_state_sweeps WHERE run_id=?').bind(failing).first()),/promotion rollback fixture/);
    assert.equal((await newsPlayerDirectory(db,AT+20)).runId,pending,'failed promotion preserves accepted directory');
    assert.equal(await scalar(`SELECT count(*) n FROM player_state_scope_frames WHERE run_id=${pending}`),5);
    // Production-sized synthetic coverage; no per-player canonical-state writes.
    const large=[player,...Array.from({length:4363},(_,i)=>({player_id:'s'+i,full_name:'Synthetic Player '+i,position:['QB','RB','WR','TE','K'][i%5]}))];
    await seedNewsDirectory(db,AT+30,large);
    const largeMeter=measuredDb('directory-4364-players');assert.equal((await newsPlayerDirectory(largeMeter.DB,AT+30)).players.length,4364);largeMeter.finish();
    const real=await normalizeNews(fixture,[player],AT);
    const evidence={schema:'pitti.news-readiness-cost.v1',runtime:'real disposable local D1/workerd',observedAt:new Date().toISOString(),sourceFixtureAt:fixture.capturedAt,measurements,
      coverage:{unchangedPlayerFixture:{oldLastSeenFilter:0,acceptedSnapshot:1},largeSyntheticSnapshot:4364,realFeedWithSingleVerifiedFixturePlayer:{articles:real.articleCount,rejected:real.rejected,matchedEvents:real.events.length}},
      limits:['Local D1 metadata, not Production billing.','Directory cases contain one or 4364 synthetic players in five retained scope rows.','Fixture coverage is not a new Production coverage measurement.','No daily savings or quota guarantee.']};
    if(process.env.PITTI_NEWS_COST_REPORT)writeFileSync(process.env.PITTI_NEWS_COST_REPORT,JSON.stringify(evidence,null,2)+'\n');
    console.log('NEWS_LOCAL_D1_COST '+JSON.stringify(evidence));
  }finally{await mf.dispose();}
});
