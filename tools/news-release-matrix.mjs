// Offline paired release proof. No production endpoint or persisted D1 is used.
// Usage: node tools/news-release-matrix.mjs <Companion checkout> <wrangler/package.json> [report.json]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {runNews,NEWS_URL} from '../src/news-source.js';
import {companionFeed} from '../src/index-v027.js';

const [companionRoot,wranglerPackage,reportPath]=process.argv.slice(2);
assert(companionRoot&&wranglerPackage,'Companion checkout and local Wrangler package required');
const NEW='670e0745a72e9b1acf38d2151928f0e73f7d1e7b';
const FLOOR='c4ca793288d728f84f92e0319d18e9bb4f1373a0';
const OLD='f65cfa891ba2cb64999bfa1fc7855bea8024778a';
const WATCHER_BASE='38e4c4ede061644b0e879f408bf6a489a9fe6511';
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).replace(/\r\n/g,'\n');
const appAt=sha=>git(companionRoot,'show',sha+':app.js');
const app=appAt(NEW),oldApp=appAt(OLD),floorApp=appAt(FLOOR);
const at=Date.UTC(2026,9,11,20),player={id:'11628',name:'Marvin Harrison'};
const report={schema:'pitti.news-release-matrix.v1',companionHead:NEW,companionTree:git(companionRoot,'rev-parse',NEW+'^{tree}').trim(),rollbackFloor:FLOOR,forbiddenRollback:OLD,watcherBase:WATCHER_BASE,cases:[],limitations:['Synthetic article; not historical Harrison evidence.','Local D1/workerd and headless Chromium only; no Production or physical Android acceptance.','Old Companion rollback with cached news is intentionally rejected, not repaired.','No closed-app push; source activation remains separately gated.']};
report.watcherRuntimeBlobs={};
for(const file of ['src/index.js','src/index-v027.js','src/index-v029.js','src/news-source.js']){
 assert.equal(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n'),git(process.cwd(),'show','9e2e5943bea0e07b91af454f9474547cdbf6679c:'+file),file+' exact reviewed runtime');
 report.watcherRuntimeBlobs[file]=git(process.cwd(),'hash-object',file).trim();
}
const pass=(name,details={})=>report.cases.push({name,result:'PASS',...details});
const researchCode=text=>text.slice(text.indexOf('function researchCacheKey('),text.indexOf('const WATCHER_FEED_URL='));
const feedCode=text=>text.slice(text.indexOf('function watcherPayload('),text.indexOf('\n/*',text.indexOf('async function syncWatcherFeed(')));
function client(text,feed,seed=[]){
 const storage=new Map([['v117_researchEvidence',JSON.stringify(seed)]]),status={};
 const c={Date,URL,AbortController,setTimeout,clearTimeout,Math,Number,String,Boolean,Set,
  localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value))},
  WATCHER_FEED_URL:'https://offline.invalid/companion-feed',WATCHER_SYNC_META_KEY:'meta',els:{watcherSyncStatus:status},store:{set(){}},
  fetch:async()=>({ok:true,json:async()=>feed}),queueSeasonRerender(){},clamp:(n,l,h)=>Math.min(h,Math.max(l,n)),norm:s=>String(s).toLowerCase()};
 vm.createContext(c);vm.runInContext(researchCode(text)+'\n'+feedCode(text),c);
 return {c,storage,status,rows:()=>JSON.parse(storage.get('v117_researchEvidence'))};
}
const originalNow=Date.now,originalFetch=globalThis.fetch;
Date.now=()=>at;
globalThis.fetch=async()=>{throw Error('EXTERNAL_NETWORK_FORBIDDEN');};
const require=createRequire(path.resolve(wranglerPackage)),{Miniflare,convertV4MiniflareOptions}=require('miniflare');
const options={modules:true,script:'export default {fetch(){return new Response("offline")}}',compatibilityDate:'2026-08-10',cf:false,d1Databases:{DB:'news-release-matrix'},d1Persist:false,outboundService(){throw Error('NETWORK_FORBIDDEN');}};
let mf,browser;
try{
 mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
 const db=await mf.getD1Database('DB'),env={DB:db};
 for(const name of ['0001_init.sql','0002_player_state_sweeps.sql','0003_chunked_player_state_and_market_frames.sql','0004_player_state_scope_frames.sql','0005_player_state_invocation_ledger.sql']){
  for(const sql of fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();
 }
 await db.prepare('INSERT INTO player_state(player_id,full_name,first_seen_at,last_seen_at,state_hash) VALUES(?,?,?,?,?)').bind(player.id,player.name,at,at,'fixture').run();
 for(const type of ['trending:scheduled','player_state:scheduled'])await db.prepare('INSERT INTO watcher_runs(run_type,started_at,finished_at,ok,item_count) VALUES(?,?,?,?,?)').bind(type,at-1000,at-500,1,1).run();
 await db.prepare("INSERT INTO evidence_events(fingerprint,player_id,event_type,fundamental_or_market,first_seen_at,last_seen_at,source,original_source,authority,confidence,payload_json) VALUES('market-fixture','11628','MARKET_ACCELERATION_STARTED','market',?,?,'fixture','fixture',0,0,'{}')").bind(at,at).run();
 const request=new Request('https://offline.invalid/companion-feed');
 const newFeed=async extra=>(await companionFeed(request,{...env,...extra},{},'fixture',async()=>[])).json();
 const oldSource=git(process.cwd(),'show',WATCHER_BASE+':src/index-v027.js');
 const oldContext=vm.createContext({Date,URL,Request,Response,baseWorker:{fetch:async()=>Response.json({ok:false},{status:503})}});
 vm.runInContext(oldSource.slice(oldSource.indexOf('const HOUR='),oldSource.indexOf('export default')).replaceAll('export ',''),oldContext);
 const oldFeed=async()=>(await oldContext.companionFeed(request,env,{},'old',async()=>[])).json();
 const before=await newFeed();assert.equal(before.newsEvidence.status,'DISABLED');
 for(const [name,text,feed]of [['new Companion + old Watcher',app,await oldFeed()],['new Companion + new Watcher disabled',app,before],['old Companion + new Watcher disabled',oldApp,before]]){
  const x=client(text,feed),result=await x.c.syncWatcherFeed();assert.equal(result.ok,true);assert.equal(x.rows().length,1);assert.equal(x.rows()[0].evidenceType,'MARKET_ACCELERATION_STARTED');pass(name);
 }
 const article={id:123,headline:'Marvin Harrison Jr. trade rumors continue',published:new Date(at-60000).toISOString(),lastModified:new Date(at-1000).toISOString(),links:{web:{href:'https://www.espn.com/nfl/story/_/id/123/fixture'}},categories:[{type:'athlete',description:'Marvin Harrison Jr.'}]};
 await runNews({...env,NEWS_SOURCE_ENABLED:'1'},at,async url=>{assert.equal(url,NEWS_URL);return Response.json({articles:[article]});});
 const snapshot=await db.prepare('SELECT * FROM evidence_events ORDER BY id').all();
 const enabled=await newFeed({NEWS_SOURCE_ENABLED:'1'});assert.equal(enabled.newsEvidence.events.length,1);assert.equal(enabled.events.length,1);
 const x=client(app,enabled);assert.equal((await x.c.syncWatcherFeed()).newsAdded,1);
 const news=x.rows().filter(e=>e.payload?.watcherNews);assert.equal(news.length,1);
 assert.equal(x.c.actionableResearchEvents(player).some(e=>e.payload?.watcherNews),false);assert.match(x.c.researchHint(player),/Nachrichtenhinweis/);
 pass('collected D1 article reaches new Companion as visible, unverified review hint');
 assert.equal((await x.c.syncWatcherFeed()).newsAdded,0);pass('repeat feed is idempotent');
 for(const [name,feed]of [['source disabled after News rows exist',await newFeed()],['Watcher code rollback after News rows exist',await oldFeed()]]){
  assert.equal(feed.events.some(e=>e.fundamental_or_market==='news'),false);
  const y=client(app,feed,news);await y.c.syncWatcherFeed();assert.equal(y.rows().filter(e=>e.payload?.watcherNews).length,1);
  assert.equal(y.c.actionableResearchEvents(player).some(e=>e.payload?.watcherNews),false);pass(name);
 }
 const safe=client(floorApp,await newFeed(),news);await safe.c.syncWatcherFeed();assert.equal(safe.c.actionableResearchEvents(player).some(e=>e.payload?.watcherNews),false);pass('authorized Companion rollback floor rc4.233 preserves cached News protection');
 const unsafe=client(oldApp,await newFeed(),news);await unsafe.c.syncWatcherFeed();assert.equal(unsafe.c.actionableResearchEvents(player).filter(e=>e.payload?.watcherNews).length,1);
 pass('negative control: old Main rollback is correctly forbidden',{actual:'UNSAFE_ACTIONABLE_NEWS',allowed:false});
 for(const [name,lane]of [['no news',undefined],['unsupported news schema',{...enabled.newsEvidence,schema:'future'}],['stale lane',{...enabled.newsEvidence,status:'STALE'}],['stale article',{...enabled.newsEvidence,events:[{...enabled.newsEvidence.events[0],sourcePublishedAt:at-3*86400000}]}],['partial payload',{...enabled.newsEvidence,events:[null,{}, {playerId:'11628'}]}]]){
  const y=client(app,{...before,newsEvidence:lane},news);const result=await y.c.syncWatcherFeed();assert.equal(result.ok,true);assert.equal(result.newsAdded,0);assert.equal(y.rows().filter(e=>e.payload?.watcherNews).length,1);assert.equal(y.c.actionableResearchEvents(player).some(e=>e.payload?.watcherNews),false);pass(name+' fails closed and preserves history');
 }
 const unknown=client(app,{...enabled,schema:'unsupported'},news);assert.equal((await unknown.c.syncWatcherFeed()).ok,false);assert.deepEqual(unknown.rows(),news);pass('unsupported top-level feed preserves history');
 assert.deepEqual((await db.prepare('SELECT * FROM evidence_events ORDER BY id').all()).results,snapshot.results);pass('all rollback/feed reads preserve D1 history');

 // Real browser DOM + actual foreground timer and ingestion functions. Other
 // application surfaces are not loaded; their regressions remain separate.
 const {chromium}=createRequire(path.join(path.resolve(companionRoot),'package.json'))('playwright');
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage();let requests=0;
 await page.route('**/*',async route=>{
  const url=route.request().url();
  if(url==='https://release-proof.invalid/')return route.fulfill({contentType:'text/html',body:'<div id="watcherSyncStatus"></div><div id="researchHint"></div>'});
  if(url==='https://release-proof.invalid/companion-feed'){requests++;return route.fulfill({contentType:'application/json',body:JSON.stringify(enabled)});}
  return route.abort();
 });
 await page.clock.install({time:new Date(at)});
 await page.goto('https://release-proof.invalid/');
 const timer=app.split('\n').find(line=>line.startsWith('setInterval(()=>{if(!document.hidden)void syncWatcherFeed()}'));
 assert(timer,'actual foreground timer must exist');
 await page.addScriptTag({content:`const els={watcherSyncStatus:document.getElementById('watcherSyncStatus')},store={set(){}},WATCHER_FEED_URL='https://release-proof.invalid/companion-feed',WATCHER_SYNC_META_KEY='meta';
 const clamp=(n,l,h)=>Math.min(h,Math.max(l,n)),norm=s=>String(s).toLowerCase();
 function queueSeasonRerender(){document.getElementById('researchHint').textContent=researchHint({id:'11628',name:'Marvin Harrison'});}
 ${researchCode(app)}\n${feedCode(app)}\n${timer}`});
 assert.equal(requests,0);await page.clock.runFor(15*60*1000);
 await page.waitForFunction(()=>document.getElementById('watcherSyncStatus').textContent.includes('Nachrichten PASS: 1'));
 assert.match(await page.locator('#researchHint').textContent(),/Nachrichtenhinweis/);assert.equal(requests,1);
 await page.clock.runFor(15*60*1000);await page.waitForFunction(()=>document.getElementById('watcherSyncStatus').textContent.includes('Nachrichten PASS: 0'));
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('v117_researchEvidence')).filter(e=>e.payload?.watcherNews).length),1);
 pass('open-page foreground timer automatically renders News without click',{browser:'Chromium',scope:'actual timer, persistence and feed code; isolated DOM, not complete app rendering',requests});
 // Complete, byte-exact Companion UI. Begin with its saved Live / News view;
 // no click, injected sync hook or altered application code triggers ingestion.
 const fullContext=await browser.newContext({serviceWorkers:'block'}),full=await fullContext.newPage();
 let available=false,fullRequests=0;const pageErrors=[];
 full.on('pageerror',error=>pageErrors.push(error.message));
 const assets=new Set(Object.keys(JSON.parse(git(companionRoot,'show',NEW+':tools/fixtures/rc4234/release-binding.json')).runtimeBlobs));
 await fullContext.route('**/*',async route=>{
  const url=new URL(route.request().url()),file=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(url.origin==='https://full-release-proof.invalid'&&assets.has(file))return route.fulfill({contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.svg')?'image/svg+xml':'application/json',body:git(companionRoot,'show',NEW+':'+file)});
  if(url.hostname==='pitti-watcher.tim-muero.workers.dev'&&url.pathname==='/companion-feed'){
   fullRequests++;return route.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(available?enabled:before)});
  }
  return route.fulfill({status:503,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'{"error":"OFFLINE_UNRELATED_PROVIDER"}'});
 });
 await fullContext.addInitScript(()=>localStorage.setItem('v117_workspace','live'));
 await full.clock.install({time:new Date(at)});
 await full.goto('https://full-release-proof.invalid/',{waitUntil:'domcontentloaded'});
 for(let i=0;i<40&&fullRequests===0;i++){await full.clock.runFor(1000);await full.waitForTimeout(25);}
 await full.waitForFunction(()=>document.getElementById('watcherSyncStatus').textContent.includes('Nachrichten DISABLED'));
 assert.equal(await full.locator('#watcherSyncStatus').isVisible(),true);
 available=true;await full.clock.runFor(15*60*1000);
 await full.waitForFunction(()=>document.getElementById('watcherSyncStatus').textContent.includes('Nachrichten PASS: 1'));
 assert.equal(await full.locator('#watcherSyncStatus').isVisible(),true);
 const savedNews=await full.evaluate(()=>JSON.parse(localStorage.getItem('v117_researchEvidence')).filter(e=>e.payload?.watcherNews));
 assert.equal(savedNews.length,1);assert.equal(savedNews[0].payload.headline,article.headline);
 assert.deepEqual(pageErrors,[]);
 pass('complete Companion app: News automatically visible in open Live / News view',{browser:'Chromium',requests:fullRequests,applicationBytes:NEW,visible:'Nachrichten PASS: 1 neue Prüfhinweise',limits:'Visible count; no article card, recommendation or cross-tab notification is claimed. Unrelated providers fail closed in fixtures.'});
 await fullContext.close();
 report.verdict='PASS_WITH_RESTRICTED_ROLLBACK';
 report.publicationScope='Companion first; Watcher second with News disabled. No publication executed.';
}finally{
 if(browser)await browser.close();if(mf)await mf.dispose();Date.now=originalNow;globalThis.fetch=originalFetch;
}
if(reportPath)fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
