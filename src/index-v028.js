import v027Worker,{companionFeed} from './index-v027.js';
import {beginPlayerStateSweep,continuePlayerStateSweep} from './index.js';

const VERSION='0.2.8';
const PLAYER_STATE_CONTINUATION_CRON='2,7,12,22,37,52 * * * *';

function jsonCors(data,status=200){
  return new Response(JSON.stringify(data,null,2),{status,headers:{
    'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'
  }});
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname==='/health')return jsonCors({ok:true,service:'pitti-watcher',version:VERSION,at:Date.now()});
    if(url.pathname==='/companion-feed')return companionFeed(request,env,ctx,VERSION);
    return v027Worker.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){
    const cron=controller.cron||'';
    if(cron==='17 4 * * *'){
      ctx.waitUntil(beginPlayerStateSweep(env,Date.now()));
      return;
    }
    if(cron===PLAYER_STATE_CONTINUATION_CRON){
      ctx.waitUntil(continuePlayerStateSweep(env));
      return;
    }
    // The market lane retains its own invocation and waitUntil promise.
    return v027Worker.scheduled(controller,env,ctx);
  }
};

export {PLAYER_STATE_CONTINUATION_CRON};
