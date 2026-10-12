import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {normalizeNews,fetchNews,runNews,newsFeed,NEWS_URL} from '../src/news-source.js';
import worker from '../src/index-v029.js';
import {seedNewsDirectory} from './helpers/news-directory.js';
import {companionFeed,acceptedEvidenceSql} from '../src/index-v027.js';
const AT=Date.UTC(2026,9,11,8);
const players=[{player_id:'11628',full_name:'Marvin Harrison'},{player_id:'11586',full_name:'Blake Corum'}];
// Synthetic contract fixture, NOT a reconstructed historical publication.
const article=(extra={})=>({id:123,headline:'Marvin Harrison Jr. trade rumors continue',published:new Date(AT-60000).toISOString(),lastModified:new Date(AT-60000).toISOString(),links:{web:{href:'https://www.espn.com/nfl/story/_/id/123/fixture'}},categories:[{type:'athlete',description:'Marvin Harrison Jr.'}],...extra});
const response=articles=>async url=>{assert.equal(url,NEWS_URL);return Response.json({articles});};

test('news matching, ambiguity, bounds and chronology fail closed',async()=>{
 const n=await normalizeNews({articles:[article(),article()]},players,AT);
 assert.equal(n.events.length,1);assert.equal(n.events[0].playerId,'11628');
 assert.equal(n.events[0].classification,'REPORT_REQUIRES_EVALUATION');
 assert.equal((await normalizeNews({articles:[article()]},[...players,{player_id:'1',full_name:'Marvin Harrison Jr.'}],AT)).events.length,0);
 assert.equal((await normalizeNews({articles:[article({headline:'Harrison trade rumors'})]},players,AT)).events.length,0);
 for(const extra of [{published:'invalid'},{published:new Date(AT+1).toISOString()},{lastModified:'2026-10-11T08:00:00'},{links:{web:{href:'https://evil.test/story'}}}])assert.equal((await normalizeNews({articles:[article(extra)]},players,AT)).rejected,1);
 assert.equal((await normalizeNews({articles:[article({published:new Date(AT-3*86400000).toISOString()})]},players,AT)).events.length,0);
 assert.equal((await normalizeNews({articles:[article({headline:'Marvin Harrison Jr. best bets and trade odds'})]},players,AT)).events.length,0);
 await assert.rejects(normalizeNews({articles:Array(101).fill(article())},players,AT));
 await assert.rejects(fetchNews(async()=>new Response('x',{status:503})),/NEWS_HTTP_503/);
 await assert.rejects(fetchNews(async()=>new Response('x'.repeat(1048577))),/NEWS_RESPONSE_TOO_LARGE/);
 assert.deepEqual(await runNews({},AT),{disabled:true});
});

test('real local D1: autonomous collection, atomic acceptance, replay, correction, rollback and independent feed',async t=>{
 t.mock.method(Date,'now',()=>AT);
 const pkg=process.env.PITTI_LOCAL_D1_PACKAGE||resolve('node_modules/wrangler/package.json');
 const require=createRequire(pkg),{Miniflare,convertV4MiniflareOptions}=require('miniflare');
 const options={modules:true,script:'export default {fetch(){return new Response("offline")}}',compatibilityDate:'2026-08-10',cf:false,d1Databases:{DB:'news-proof'},d1Persist:false,outboundService(){throw Error('NETWORK_DISABLED');}};
 const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
 try{
  const db=await mf.getD1Database('DB'),env={DB:db,NEWS_SOURCE_ENABLED:'1'};
  for(const file of ['0001_init.sql','0002_player_state_sweeps.sql','0003_chunked_player_state_and_market_frames.sql','0004_player_state_scope_frames.sql','0005_player_state_invocation_ledger.sql','0006_news_retention_indexes.sql'])for(const sql of readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();
  await db.prepare('INSERT INTO player_state(player_id,full_name,first_seen_at,last_seen_at,state_hash) VALUES(?,?,?,?,?)').bind('11628','Marvin Harrison',AT,AT,'fixture').run();
  await seedNewsDirectory(db,AT,players);
  await runNews(env,AT,response([article()]));
  const before=await db.prepare('SELECT * FROM evidence_events').all();assert.equal(before.results.length,1);
  assert.equal((await newsFeed(env,AT)).events.length,1); // No Market run or Companion/browser exists.
  const bridge=await (await companionFeed(new Request('https://local.test/companion-feed'),env,{})).json();
  assert.notEqual(bridge.gate.market,'PASS');assert.equal(bridge.newsEvidence.events.length,1);
  assert.equal((await db.prepare(acceptedEvidenceSql()).all()).results.length,0,'news cannot crowd the Market/Player evidence window');
  await runNews(env,AT+1,response([article()]));
  assert.deepEqual((await db.prepare('SELECT * FROM evidence_events').all()).results,before.results);
  const revision=article({headline:'Marvin Harrison Jr. trade rumors denied',lastModified:new Date(AT+2).toISOString()});
  await runNews(env,AT+3,response([revision]));
  assert.equal((await newsFeed(env,AT+3)).events[0].headline,revision.headline);
  const broken={prepare:db.prepare.bind(db),batch:stmts=>db.batch([...stmts,db.prepare('INSERT INTO nonexistent_table VALUES(1)')])};
  await assert.rejects(runNews({...env,DB:broken},AT+4,response([article({id:124,links:{web:{href:'https://www.espn.com/nfl/story/_/id/124/fixture'}}})])));
  assert.equal((await db.prepare('SELECT count(*) n FROM evidence_events').first()).n,2);
  assert.equal((await newsFeed(env,AT+4)).status,'FAIL');
  await runNews(env,AT+5,response([revision]));assert.equal((await newsFeed(env,AT+5)).events.length,1);
  assert.equal((await newsFeed(env,AT+46*60000)).status,'STALE');
  const saved=await db.prepare('SELECT * FROM evidence_events').all();
  await assert.rejects(runNews(env,AT+6,async()=>new Response('',{status:503})));
  assert.deepEqual((await db.prepare('SELECT * FROM evidence_events').all()).results,saved.results);
  assert.equal((await newsFeed({DB:db},AT)).status,'DISABLED');
  t.mock.method(Date,'now',()=>AT+1000);
  t.mock.method(globalThis,'fetch',async url=>url===NEWS_URL?Response.json({articles:[revision]}):Response.json([]));
  const pending=[];await worker.scheduled({cron:'*/15 * * * *'},env,{waitUntil:p=>pending.push(p)});
  assert.equal(pending.length,2,'separate scheduled Market and news tasks, no browser trigger');
  const settled=await Promise.allSettled(pending);assert(settled.every(r=>r.status==='fulfilled'),JSON.stringify(settled));
  assert.equal((await newsFeed(env,AT+1000)).status,'PASS');
  await runNews(env,AT+2000,async()=>{t.mock.method(Date,'now',()=>AT+5000);return Response.json({articles:[article({id:125,links:{web:{href:'https://www.espn.com/nfl/story/_/id/125/fixture'}}})]});});
  const delayed=(await newsFeed(env,AT+5000)).events.find(e=>e.articleId==='125');
  assert.equal(delayed.observedAt,AT+5000,'observation is after download, not backdated to cron start');
 }finally{await mf.dispose();}
});
