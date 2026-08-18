import assert from 'node:assert/strict';

const HOUR=3600_000;
const TRENDING_MAX_AGE=45*60_000;
const PLAYER_STATE_MAX_AGE=8*HOUR;

function routeCron(cron){
  if(cron==='17 */6 * * *')return 'player_state';
  if(cron==='*/15 * * * *')return 'trending';
  return 'unknown';
}
function runPass(x,maxAgeMs,now){
  return !!(x&&Number(x.ok)===1&&x.finished_at!=null&&Number.isFinite(Number(x.started_at))&&now-Number(x.started_at)>=0&&now-Number(x.started_at)<=maxAgeMs);
}
function gate({trending,playerState,now}){
  const explicitFail=[trending,playerState].some(x=>x&&(Number(x.ok)!==1||x.finished_at==null));
  return runPass(trending,TRENDING_MAX_AGE,now)&&runPass(playerState,PLAYER_STATE_MAX_AGE,now)?'PASS':
    (explicitFail?'FAIL':(trending&&playerState?'STALE':'WAIT_FOR_SCHEDULED_EVIDENCE'));
}
function ages({trending,playerState,now}){
  const age=x=>x&&Number.isFinite(Number(x.started_at))?Math.max(0,now-Number(x.started_at)):null;
  return {trending_age_ms:age(trending),player_state_age_ms:age(playerState)};
}

assert.equal(routeCron('*/15 * * * *'),'trending');
assert.equal(routeCron('17 */6 * * *'),'player_state');
assert.equal(routeCron('17 4 * * *'),'unknown');

const now=Date.UTC(2026,7,31,18,0,0); // 20:00 CEST draft time
const goodT={started_at:now-10*60_000,finished_at:now-9*60_000,ok:1};
const goodP={started_at:now-5*HOUR,finished_at:now-5*HOUR+60_000,ok:1};
assert.equal(gate({trending:goodT,playerState:goodP,now}),'PASS');
const staleP={...goodP,started_at:now-9*HOUR};
assert.equal(gate({trending:goodT,playerState:staleP,now}),'STALE');
const badP={...goodP,ok:0};
assert.equal(gate({trending:goodT,playerState:badP,now}),'FAIL');
const a=ages({trending:goodT,playerState:goodP,now});
assert.equal(a.trending_age_ms,10*60_000);
assert.equal(a.player_state_age_ms,5*HOUR);

console.log('watcher freshness contract: OK');
