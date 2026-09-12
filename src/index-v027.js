import baseWorker from './index.js';

const HOUR=3600_000;
const VERSION='0.2.7';

export function runLaneStatus(run,maxAgeMs,now=Date.now()){
  if(!run)return 'WAIT_FOR_SCHEDULED_EVIDENCE';
  if(Number(run.ok)!==1||run.finished_at==null)return 'FAIL';
  const started=Number(run.started_at);
  if(!Number.isFinite(started)||now-started<0||now-started>maxAgeMs)return 'STALE';
  return 'PASS';
}

export function overallLaneGate(marketStatus,playerStateStatus){
  if(marketStatus==='PASS'||playerStateStatus==='PASS')return 'PASS';
  if(marketStatus==='FAIL'||playerStateStatus==='FAIL')return 'FAIL';
  if(marketStatus==='STALE'||playerStateStatus==='STALE')return 'STALE';
  return 'WAIT_FOR_SCHEDULED_EVIDENCE';
}

export function filterLaneEvents(events,{marketStatus,playerStateStatus}){
  return (Array.isArray(events)?events:[]).filter(row=>{
    const lane=String(row?.fundamental_or_market||'');
    if(lane==='market')return marketStatus==='PASS';
    if(lane==='fundamental')return playerStateStatus==='PASS';
    return false;
  });
}

function ownershipStatus(league,playerId){
  const x=league?.ownership?.[String(playerId)];
  if(!x)return 'free_agent';
  return x.mine?'mine':'opponent';
}

export function buildFreeAgencyRadar(events=[],market=[],league=null){
  if(!league?.ok)return{available:false,reason:'LEAGUE_STATE_UNAVAILABLE',candidates:[]};
  const byPlayer=new Map();
  const ensure=id=>{
    const key=String(id||'');if(!key)return null;
    if(!byPlayer.has(key))byPlayer.set(key,{player_id:key,events:[],market:null});
    return byPlayer.get(key);
  };
  for(const row of market||[]){const x=ensure(row.player_id);if(x)x.market=row;}
  for(const row of events||[]){const x=ensure(row.player_id);if(x)x.events.push(row);}
  const candidates=[];
  for(const x of byPlayer.values()){
    if(ownershipStatus(league,x.player_id)!=='free_agent')continue;
    const fundamental=x.events.filter(e=>e.fundamental_or_market==='fundamental');
    const marketEvents=x.events.filter(e=>e.fundamental_or_market==='market');
    const adds1=Number(x.market?.adds_1h||0),adds3=Number(x.market?.adds_3h||0),adds24=Number(x.market?.adds_24h||0),drops1=Number(x.market?.drops_1h||0);
    const signalScore=(fundamental.length?1000:0)+(marketEvents.length?250:0)+adds1*4+adds3+Math.min(adds24,200)-drops1*2;
    candidates.push({
      player_id:x.player_id,
      full_name:x.market?.full_name||null,
      team:x.market?.team||null,
      position:x.market?.position||null,
      availability:'free_agent',
      fundamental_events:fundamental.length,
      market_events:marketEvents.length,
      adds_1h:adds1,adds_3h:adds3,adds_24h:adds24,drops_1h:drops1,
      signal_score:signalScore,
      evidence:x.events.slice(0,5)
    });
  }
  candidates.sort((a,b)=>b.signal_score-a.signal_score||b.adds_1h-a.adds_1h);
  return{available:true,generated_at:Date.now(),candidates:candidates.slice(0,50)};
}

function publicRun(x){
  if(!x)return null;
  return{started_at:x.started_at,finished_at:x.finished_at,ok:Number(x.ok)===1,item_count:Number(x.item_count||0)};
}

function jsonCors(data,status=200){
  return new Response(JSON.stringify(data,null,2),{status,headers:{
    'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'
  }});
}

async function companionFeed(request,env,ctx){
  const [trending,playerState]=await Promise.all([
    env.DB.prepare(`SELECT run_type,started_at,finished_at,ok,item_count FROM watcher_runs WHERE run_type='trending:scheduled' ORDER BY id DESC LIMIT 1`).first(),
    env.DB.prepare(`SELECT run_type,started_at,finished_at,ok,item_count FROM watcher_runs WHERE run_type='player_state:scheduled' ORDER BY id DESC LIMIT 1`).first()
  ]);
  const now=Date.now();
  const marketStatus=runLaneStatus(trending,45*60_000,now);
  const playerStateStatus=runLaneStatus(playerState,36*HOUR,now);
  const overall=overallLaneGate(marketStatus,playerStateStatus);
  let events=[],market=[],league=null;

  if(overall==='PASS'){
    const queries=[];
    queries.push(env.DB.prepare(`SELECT id,player_id,event_type,fundamental_or_market,occurred_at,first_seen_at,last_seen_at,source,original_source,authority,confidence,thesis_link,payload_json FROM evidence_events ORDER BY first_seen_at DESC LIMIT 250`).all());
    if(marketStatus==='PASS')queries.push(env.DB.prepare(`
      WITH latest AS (SELECT MAX(captured_at) t FROM trending_snapshots)
      SELECT t.captured_at,t.player_id,t.adds_1h,t.adds_3h,t.adds_6h,t.adds_24h,t.drops_1h,t.drops_6h,t.drops_24h,
             COALESCE(p.full_name,t.player_id) full_name,p.team,p.position
      FROM trending_snapshots t LEFT JOIN player_state p ON p.player_id=t.player_id
      WHERE t.captured_at=(SELECT t FROM latest)
      ORDER BY COALESCE(t.adds_1h,0) DESC,COALESCE(t.adds_3h,0) DESC LIMIT 50`).all());
    const rows=await Promise.all(queries);
    events=filterLaneEvents(rows[0]?.results||[],{marketStatus,playerStateStatus});
    market=marketStatus==='PASS'?(rows[1]?.results||[]):[];
    try{
      const leagueUrl=new URL('/league-state',request.url);
      const response=await baseWorker.fetch(new Request(leagueUrl,{method:'GET'}),env,ctx);
      league=response.ok?await response.json():{ok:false,error:`league-state HTTP ${response.status}`};
    }catch(error){league={ok:false,error:String(error?.message||error)};}
  }

  const freeAgency=overall==='PASS'?buildFreeAgencyRadar(events,market,league):{available:false,reason:'WATCHER_ALL_LANES_'+overall,candidates:[]};
  return jsonCors({
    schema:'draft-companion.watcher-feed.v2',
    generatedAt:Date.now(),watcherVersion:VERSION,
    gate:{
      overall,
      market:marketStatus,
      player_state_status:playerStateStatus,
      trending:publicRun(trending),
      player_state:publicRun(playerState)
    },
    league,freeAgency,events,market
  });
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname==='/health')return jsonCors({ok:true,service:'pitti-watcher',version:VERSION,at:Date.now()});
    if(url.pathname==='/companion-feed')return companionFeed(request,env,ctx);
    return baseWorker.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){
    return baseWorker.scheduled(controller,env,ctx);
  }
};
