// One bounded public source. Opt-in locally; no claim of exhaustive news coverage.
export const NEWS_URL='https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50';
const DAY=86400000;
const nameKey=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const relevant=/\b(trade|trades|trading|rumor|rumors|injury|injured|inactive|out|questionable|doubtful|practice|practicing|return|returns|starter|starting|benched|bench|role|waived|released|signs|signed|suspended|suspension)\b/i;
const safeTime=s=>typeof s==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(s)?Date.parse(s):NaN;
async function hash(s){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');}

export async function normalizeNews(document,players,at){
  if(!Number.isSafeInteger(at)||at<=0||!Array.isArray(document?.articles)||document.articles.length>100)throw Error('NEWS_SCHEMA_INVALID');
  const names=new Map();
  for(const p of players){
    if(!p.player_id||!p.full_name)continue;
    const key=nameKey(p.full_name),ids=names.get(key)||new Set();ids.add(String(p.player_id));names.set(key,ids);
  }
  const events=new Map();let rejected=0,unmatched=0;
  for(const a of document.articles){
    const published=safeTime(a?.published),updated=a?.lastModified==null?published:safeTime(a.lastModified);
    let url;try{url=new URL(a?.links?.web?.href);}catch{rejected++;continue;}
    if(!/^[0-9]+$/.test(String(a.id))||typeof a.headline!=='string'||!a.headline.trim()||a.headline.length>300||
       url.protocol!=='https:'||url.hostname!=='www.espn.com'||url.username||url.password||
       !Number.isFinite(published)||!Number.isFinite(updated)||published>at||updated>at||updated<published){rejected++;continue;}
    if(at-published>2*DAY)continue;
    if(!relevant.test(a.headline)||/\b(betting|best bets|odds|predictions)\b/i.test(a.headline))continue;
    // Require a full player name in the headline AND an athlete tag; no surname guessing.
    const headline=' '+nameKey(a.headline)+' ',matched=new Set();
    for(const c of Array.isArray(a.categories)?a.categories:[]){
      if(c.type!=='athlete')continue;
      const key=nameKey(c.description||c.athlete?.description),ids=names.get(key);
      if(key&&ids?.size===1&&headline.includes(' '+key+' '))matched.add([...ids][0]);
    }
    if(!matched.size){unmatched++;continue;}
    url.hash='';url.search='';
    for(const playerId of matched){
      const version=await hash(JSON.stringify([String(a.id),playerId,a.headline,published,updated,url.href]));
      events.set(version,{version,articleId:String(a.id),playerId,headline:a.headline,sourceUrl:url.href,
        sourcePublishedAt:published,sourceUpdatedAt:updated,observedAt:at,classification:'REPORT_REQUIRES_EVALUATION'});
    }
  }
  if(events.size>50)throw Error('NEWS_EVENT_LIMIT');
  return {events:[...events.values()],rejected,unmatched,articleCount:document.articles.length};
}

export async function fetchNews(fetcher=fetch){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetcher(NEWS_URL,{signal:controller.signal,redirect:'error',headers:{accept:'application/json'}});
    if(!r.ok)throw Error('NEWS_HTTP_'+r.status);
    const reader=r.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576){await reader.cancel();throw Error('NEWS_RESPONSE_TOO_LARGE');}chunks.push(value);}}
    finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
  }finally{clearTimeout(timer);}
}

export async function runNews(env,at=Date.now(),fetcher=fetch){
  if(env.NEWS_SOURCE_ENABLED!=='1')return {disabled:true};
  const run=await env.DB.prepare("INSERT INTO watcher_runs(run_type,started_at) VALUES('news:scheduled',?) RETURNING id").bind(at).first();
  if(!Number.isSafeInteger(run?.id)||run.id<=0)throw Error('NEWS_RUN_ID');
  try{
    const document=await fetchNews(fetcher);
    const observedAt=Math.max(at,Date.now());
    const players=await env.DB.prepare('SELECT player_id,full_name FROM player_state WHERE last_seen_at BETWEEN ? AND ?').bind(observedAt-36*3600000,observedAt).all();
    if(!players.results?.length)throw Error('NEWS_PLAYER_DIRECTORY_UNAVAILABLE');
    const normalized=await normalizeNews(document,players.results,observedAt);
    // Invalid articles make this source run visibly degraded, never silently green.
    if(normalized.rejected)throw Error('NEWS_ARTICLE_INVALID');
    const statements=normalized.events.map(e=>env.DB.prepare(`INSERT INTO evidence_events
      (fingerprint,player_id,event_type,fundamental_or_market,occurred_at,first_seen_at,last_seen_at,source,original_source,authority,confidence,thesis_link,payload_json,observation_run_id)
      VALUES(?,?,'NEWS_REPORT','news',NULL,?,?,'ESPN NFL News',?,0,0,'news_review',?,?)
      ON CONFLICT(fingerprint) DO NOTHING`).bind('news:'+e.version,e.playerId,observedAt,observedAt,e.sourceUrl,JSON.stringify(e),run.id));
    statements.push(env.DB.prepare('UPDATE watcher_runs SET finished_at=?,ok=1,item_count=? WHERE id=? AND finished_at IS NULL').bind(Math.max(observedAt,Date.now()),normalized.events.length,run.id));
    // New evidence and acceptance are committed together. Replay never steals ownership.
    const results=await env.DB.batch(statements);
    if(results.some(r=>r.success!==true))throw Error('NEWS_BATCH_FAILED');
    return {runId:run.id,...normalized};
  }catch(error){
    // An ambiguous successful batch must not be relabelled failed.
    await env.DB.prepare("UPDATE watcher_runs SET finished_at=?,ok=0,error='NEWS_COLLECTION_FAILED' WHERE id=? AND finished_at IS NULL").bind(at,run.id).run();
    throw error;
  }
}

export async function newsFeed(env,now=Date.now()){
  if(env.NEWS_SOURCE_ENABLED!=='1')return {schema:'pitti.news-evidence.v1',status:'DISABLED',events:[]};
  const run=await env.DB.prepare("SELECT id,started_at,finished_at,ok FROM watcher_runs WHERE run_type='news:scheduled' ORDER BY id DESC LIMIT 1").first();
  const status=!run?'WAIT':!run.finished_at||run.ok!==1?'FAIL':now<run.started_at||now-run.started_at>45*60000?'STALE':'PASS';
  if(status!=='PASS')return {schema:'pitti.news-evidence.v1',status,events:[]};
  const rows=await env.DB.prepare(`SELECT e.payload_json FROM evidence_events e JOIN watcher_runs r ON r.id=e.observation_run_id
    WHERE e.fundamental_or_market='news' AND r.ok=1 AND r.finished_at IS NOT NULL AND e.first_seen_at>=?
    ORDER BY json_extract(e.payload_json,'$.sourceUpdatedAt') DESC,e.id DESC LIMIT 100`).bind(now-2*DAY).all();
  const seen=new Set(),events=[];
  for(const row of rows.results||[]){
    const e=JSON.parse(row.payload_json),key=e.articleId+':'+e.playerId;
    if(seen.has(key))continue;seen.add(key);
    if(e.sourcePublishedAt<=now&&now-e.sourcePublishedAt<=2*DAY&&e.observedAt<=now&&e.sourceUpdatedAt<=now)events.push(e);
  }
  return {schema:'pitti.news-evidence.v1',status,events:events.slice(0,50)};
}
