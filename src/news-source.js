// One bounded public source. Opt-in locally; no claim of exhaustive news coverage.
export const NEWS_URL='https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50';
const DAY=86400000;
const nameKey=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const relevant=/\b(trade|trades|trading|rumor|rumors|injury|injured|inactive|out|questionable|doubtful|practice|practicing|return|returns|starter|starting|benched|bench|role|waived|released|signs|signed|suspended|suspension)\b/i;
const safeTime=s=>typeof s==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(s)?Date.parse(s):NaN;
async function hash(s){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');}

export function articleUrl(raw,id){
  if(typeof raw!=='string'||raw!==raw.trim()||/[\\\s]/.test(raw))throw Error('NEWS_URL_INVALID');
  const url=new URL(raw);
  // Only observed ESPN article routes from the fixed NFL feed may upgrade.
  if(!['http:','https:'].includes(url.protocol)||url.hostname!=='www.espn.com'||url.port||url.username||url.password||!/^\d+$/.test(String(id)))throw Error('NEWS_URL_INVALID');
  const story=new RegExp('^/(?:nfl/story|fantasy/football/story|video/clip)/_/id/'+String(id)+'(?:/[a-zA-Z0-9-]+)?/?$').test(url.pathname)||
    new RegExp('^/fantasy/football/story/_/page/[a-zA-Z]+-'+String(id)+'(?:/[a-zA-Z0-9-]+)?/?$').test(url.pathname);
  const games=url.searchParams.getAll('gameId');
  const recap=url.pathname==='/nfl/recap'&&games.length===1&&/^\d+$/.test(games[0]);
  if(!story&&!recap)throw Error('NEWS_URL_INVALID');
  url.protocol='https:';url.hash='';url.search=recap?'?gameId='+games[0]:'';return url;
}

export async function newsPlayerDirectory(db,at){
  const run=await db.prepare(`SELECT r.id,r.started_at,r.finished_at,r.item_count,s.total_entries,s.next_index,s.seen_count,s.revalidated_at
    FROM watcher_runs r LEFT JOIN player_state_sweeps s ON s.run_id=r.id
    WHERE r.run_type='player_state:scheduled' AND r.ok=1 AND r.finished_at IS NOT NULL
    ORDER BY r.id DESC LIMIT 1`).first();
  if(!run||!Number.isSafeInteger(at)||!['id','started_at','finished_at','item_count','total_entries','next_index','seen_count','revalidated_at'].every(k=>Number.isSafeInteger(run[k])&&run[k]>=0)||run.started_at>at||at-run.started_at>36*3600000||
     run.finished_at<run.started_at||run.finished_at>at||run.total_entries!==5||run.next_index!==5||
     run.revalidated_at<run.started_at||run.revalidated_at>run.finished_at||run.revalidated_at==null||
     run.item_count!==run.seen_count||run.item_count<=0)throw Error('NEWS_PLAYER_SNAPSHOT_UNAVAILABLE');
  const rows=(await db.prepare(`SELECT source_scope,captured_at,source_etag,player_count,frame_json
    FROM player_state_scope_frames WHERE run_id=? ORDER BY source_scope`).bind(run.id).all()).results;
  const scopes=new Set(['QB','RB','WR','TE','K']),ids=new Set(),players=[];
  if(rows?.length!==5)throw Error('NEWS_PLAYER_SNAPSHOT_INCOMPLETE');
  for(const row of rows){
    if(!scopes.delete(row.source_scope)||!row.source_etag||!Number.isSafeInteger(row.captured_at)||!Number.isSafeInteger(row.player_count)||row.player_count<0||row.captured_at<run.started_at||row.captured_at>run.finished_at||
       typeof row.frame_json!=='string'||new TextEncoder().encode(row.frame_json).length>1500000)throw Error('NEWS_PLAYER_SNAPSHOT_INVALID');
    const entries=JSON.parse(row.frame_json);
    if(!Array.isArray(entries)||entries.length!==row.player_count)throw Error('NEWS_PLAYER_SNAPSHOT_INVALID');
    for(const entry of entries){
      if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||!entry[0]||ids.has(entry[0])||
         entry[1]?.position!==row.source_scope||typeof entry[1]?.full_name!=='string'||!nameKey(entry[1].full_name))throw Error('NEWS_PLAYER_SNAPSHOT_INVALID');
      ids.add(entry[0]);players.push({player_id:entry[0],full_name:entry[1].full_name});
    }
  }
  if(players.length!==run.item_count)throw Error('NEWS_PLAYER_SNAPSHOT_INCOMPLETE');
  return {runId:run.id,players};
}

// Preserve 30 days of News evidence and 90 days of completed News run audit.
// Limit candidates BEFORE reference checks, so pinned/orphan rows cannot cause
// an unbounded search. Such rows remain pinned; expiration is not release proof.
export async function retainNews(db,at){
  if(!Number.isSafeInteger(at)||at<=0)throw Error('NEWS_RETENTION_TIME');
  const results=await db.batch([
    db.prepare(`DELETE FROM evidence_events WHERE id IN (
      SELECT id FROM (SELECT id,last_seen_at,observation_run_id FROM evidence_events INDEXED BY idx_news_evidence_retention
        WHERE fundamental_or_market='news' AND event_type='NEWS_REPORT' AND first_seen_at<? ORDER BY first_seen_at,id LIMIT 64) old
      WHERE old.last_seen_at<? AND EXISTS (SELECT 1 FROM watcher_runs r WHERE r.id=old.observation_run_id
        AND r.run_type='news:scheduled' AND r.finished_at IS NOT NULL AND r.ok=1))`).bind(at-30*DAY,at-30*DAY),
    db.prepare(`DELETE FROM watcher_runs WHERE id IN (
      SELECT id FROM (SELECT id FROM watcher_runs INDEXED BY idx_news_runs_retention
        WHERE run_type='news:scheduled' AND finished_at IS NOT NULL AND finished_at<? ORDER BY finished_at,id LIMIT 64) old
      WHERE old.id<>(SELECT MAX(id) FROM watcher_runs WHERE run_type='news:scheduled')
        AND NOT EXISTS (SELECT 1 FROM evidence_events WHERE observation_run_id=old.id)
        AND NOT EXISTS (SELECT 1 FROM player_state_sweeps WHERE run_id=old.id)
        AND NOT EXISTS (SELECT 1 FROM trending_snapshot_frames WHERE run_id=old.id))`).bind(at-90*DAY)
  ]);
  if(results.some(r=>r.success!==true))throw Error('NEWS_RETENTION_FAILED');
  return results;
}

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
    let url;try{url=articleUrl(a?.links?.web?.href,a?.id);}catch{rejected++;continue;}
    if(!/^[0-9]+$/.test(String(a.id))||typeof a.headline!=='string'||!a.headline.trim()||a.headline.length>300||
       !Number.isFinite(published)||!Number.isFinite(updated)||published>at||updated>at||updated<published){rejected++;continue;}
    if(at-published>2*DAY)continue;
    if(!relevant.test(a.headline)||/\b(betting|best bets|odds|predictions)\b/i.test(a.headline))continue;
    // Require a full player name in the headline AND an athlete tag; no surname guessing.
    const headline=' '+nameKey(a.headline)+' ',matched=new Set();
    for(const c of Array.isArray(a.categories)?a.categories:[]){
      if(c?.type!=='athlete')continue;
      const key=nameKey(c.description||c.athlete?.description),ids=names.get(key);
      if(key&&ids?.size===1&&headline.includes(' '+key+' '))matched.add([...ids][0]);
    }
    if(!matched.size){unmatched++;continue;}
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
    const directory=await newsPlayerDirectory(env.DB,observedAt);
    const normalized=await normalizeNews(document,directory.players,observedAt);
    if(normalized.rejected&&normalized.rejected===normalized.articleCount)throw Error('NEWS_ALL_ARTICLES_INVALID');
    const statements=normalized.events.map(e=>env.DB.prepare(`INSERT INTO evidence_events
      (fingerprint,player_id,event_type,fundamental_or_market,occurred_at,first_seen_at,last_seen_at,source,original_source,authority,confidence,thesis_link,payload_json,observation_run_id)
      VALUES(?,?,'NEWS_REPORT','news',NULL,?,?,'ESPN NFL News',?,0,0,'news_review',?,?)
      ON CONFLICT(fingerprint) DO NOTHING`).bind('news:'+e.version,e.playerId,observedAt,observedAt,e.sourceUrl,JSON.stringify(e),run.id));
    // Accepted subset is explicit in the audit trail; invalid articles never enter evidence.
    const audit=JSON.stringify({schema:'news.audit.v1',directoryRunId:directory.runId,articles:normalized.articleCount,rejected:normalized.rejected,unmatched:normalized.unmatched});
    statements.push(env.DB.prepare('UPDATE watcher_runs SET finished_at=?,ok=1,item_count=?,error=? WHERE id=? AND finished_at IS NULL').bind(Math.max(observedAt,Date.now()),normalized.events.length,audit,run.id));
    // New evidence and acceptance are committed together. Replay never steals ownership.
    const results=await env.DB.batch(statements);
    if(results.some(r=>r.success!==true))throw Error('NEWS_BATCH_FAILED');
    // Retention failure cannot revoke an already committed accepted observation.
    let retention='PASS';try{await retainNews(env.DB,observedAt);}catch{retention='FAIL';console.warn('NEWS_RETENTION_FAILED');}
    return {runId:run.id,directoryRunId:directory.runId,retention,...normalized};
  }catch(error){
    // An ambiguous successful batch must not be relabelled failed.
    await env.DB.prepare("UPDATE watcher_runs SET finished_at=?,ok=0,error='NEWS_COLLECTION_FAILED' WHERE id=? AND finished_at IS NULL").bind(at,run.id).run();
    // Failed collections also age the News ledger; retention must not depend on
    // the publisher recovering. Storage failures still preserve all pinned rows.
    try{await retainNews(env.DB,Math.max(at,Date.now()));}catch{console.warn('NEWS_RETENTION_FAILED');}
    throw error;
  }
}

export async function newsFeed(env,now=Date.now()){
  if(env.NEWS_SOURCE_ENABLED!=='1')return {schema:'pitti.news-evidence.v1',status:'DISABLED',events:[]};
  const run=await env.DB.prepare("SELECT id,started_at,finished_at,ok,error FROM watcher_runs WHERE run_type='news:scheduled' ORDER BY id DESC LIMIT 1").first();
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
  let collectionAudit=null;try{collectionAudit=JSON.parse(run.error);}catch{}
  return {schema:'pitti.news-evidence.v1',status,events:events.slice(0,50),collectionAudit};
}
