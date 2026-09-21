import v027Worker,{acceptedEvidenceSql,companionFeed} from './index-v027.js';
import {
  beginChunkedPlayerStateSweep,
  continueChunkedPlayerStateSweep,
  latestMarketFrameRows,
  runTrendingFrames,
  timingSafeStringEqual
} from './index.js';

const VERSION='0.2.9';
const MARKET_CRON='*/15 * * * *';
const PLAYER_STATE_CONTINUATION_CRON='2,7,12,22,37,52 * * * *';

function jsonCors(data,status=200){
  return new Response(JSON.stringify(data,null,2),{status,headers:{
    'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'
  }});
}

async function requireWatcherToken(request,env){
  const expected=String(env.WATCHER_TOKEN||'').trim();
  if(!expected)return jsonCors({ok:false,error:'WATCHER_TOKEN is not configured'},503);
  const header=String(request.headers.get('authorization')||'');
  const supplied=header.startsWith('Bearer ')?header.slice(7):'';
  if(!await timingSafeStringEqual(supplied,expected))return jsonCors({ok:false,error:'unauthorized'},401);
  return null;
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname==='/health')return jsonCors({ok:true,service:'pitti-watcher',version:VERSION,at:Date.now()});
    if(url.pathname==='/companion-feed')return companionFeed(request,env,ctx,VERSION,latestMarketFrameRows);
    if(url.pathname==='/market'||url.pathname==='/events'||url.pathname.startsWith('/debug/')){
      const auth=await requireWatcherToken(request,env);
      if(auth)return auth;
    }
    if(url.pathname==='/market'){
      const limit=Math.max(1,Math.min(100,Math.trunc(Number(url.searchParams.get('limit'))||50)));
      return jsonCors(await latestMarketFrameRows(env,limit));
    }
    if(url.pathname==='/events'){
      const limit=Math.max(1,Math.min(100,Math.trunc(Number(url.searchParams.get('limit'))||30)));
      const rows=await env.DB.prepare(acceptedEvidenceSql(limit)).all();
      return jsonCors(rows.results||[]);
    }
    if(url.pathname==='/debug/run-trending'||url.pathname==='/debug/run-players'){
      return jsonCors({ok:false,error:'LEGACY_DEBUG_MUTATION_DISABLED'},410);
    }
    if(url.pathname==='/')return jsonCors({ok:true,endpoints:['/health','/companion-feed','/league-state','/events','/runs','/run-health','/market']});
    if(['/league-state','/runs','/run-health'].includes(url.pathname))return v027Worker.fetch(request,env,ctx);
    return jsonCors({ok:false,error:'NOT_FOUND'},404);
  },
  async scheduled(controller,env,ctx){
    const cron=controller.cron||'';
    if(cron==='17 4 * * *'){
      ctx.waitUntil(beginChunkedPlayerStateSweep(env,Date.now()));
      return;
    }
    if(cron===PLAYER_STATE_CONTINUATION_CRON){
      ctx.waitUntil(continueChunkedPlayerStateSweep(env));
      return;
    }
    if(cron===MARKET_CRON){
      ctx.waitUntil(runTrendingFrames(env,Date.now(),'scheduled'));
      return;
    }
    console.log(JSON.stringify({event:'watcher_cron_ignored',cron}));
  }
};
