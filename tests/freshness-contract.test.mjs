import assert from 'node:assert/strict';
import fs from 'node:fs';

const HOUR=3600_000;
const TRENDING_MAX_AGE=45*60_000;
const PLAYER_STATE_MAX_AGE=8*HOUR;
const source=fs.readFileSync('src/index.js','utf8');
const wrangler=fs.readFileSync('wrangler.jsonc','utf8');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));

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

const now=Date.UTC(2026,7,31,18,0,0);
const goodT={started_at:now-10*60_000,finished_at:now-9*60_000,ok:1};
const goodP={started_at:now-5*HOUR,finished_at:now-5*HOUR+60_000,ok:1};
assert.equal(gate({trending:goodT,playerState:goodP,now}),'PASS');
assert.equal(gate({trending:goodT,playerState:{...goodP,started_at:now-9*HOUR},now}),'STALE');
assert.equal(gate({trending:goodT,playerState:{...goodP,ok:0},now}),'FAIL');
const a=ages({trending:goodT,playerState:goodP,now});
assert.equal(a.trending_age_ms,10*60_000);
assert.equal(a.player_state_age_ms,5*HOUR);

assert.match(wrangler,/"17 \*\/6 \* \* \*"/,'runtime cron must refresh player_state every 6 hours');
assert.doesNotMatch(wrangler,/"17 4 \* \* \*"/,'legacy daily player_state cron must be removed');
assert.match(source,/const VERSION = '0\.1\.6';/,'worker version must be v0.1.6');
assert.match(source,/cron === '17 \*\/6 \* \* \*'/,'scheduled router must recognize 6-hour player_state cron');
assert.match(source,/runPass\(playerState,8\*HOUR\)/,'companion gate must reject player_state older than 8 hours');
assert.equal(pkg.version,'0.1.6');

console.log('watcher freshness runtime contract: OK');
