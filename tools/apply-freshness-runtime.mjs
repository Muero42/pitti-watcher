import fs from 'node:fs';

function replaceOnce(src,from,to,label){
  const i=src.indexOf(from);
  if(i<0)throw new Error(`missing anchor: ${label}`);
  if(src.indexOf(from,i+from.length)>=0)throw new Error(`ambiguous anchor: ${label}`);
  console.log(`anchor OK: ${label}`);
  return src.slice(0,i)+to+src.slice(i+from.length);
}

let source=fs.readFileSync('src/index.js','utf8');
source=replaceOnce(source,"const VERSION = '0.1.5';","const VERSION = '0.1.6';",'worker version');
source=replaceOnce(source,"if (cron === '17 4 * * *') {","if (cron === '17 */6 * * *') {",'player_state scheduled route');
source=replaceOnce(source,"runPass(playerState,36*HOUR)","runPass(playerState,8*HOUR)",'player_state freshness gate');
fs.writeFileSync('src/index.js',source);

let wrangler=fs.readFileSync('wrangler.jsonc','utf8');
wrangler=replaceOnce(wrangler,'"*/15 * * * *", "17 4 * * *"','"*/15 * * * *", "17 */6 * * *"','cron schedule');
fs.writeFileSync('wrangler.jsonc',wrangler);

const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
if(pkg.version!=='0.1.5')throw new Error(`unexpected package version ${pkg.version}`);
pkg.version='0.1.6';
fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');

console.log('watcher v0.1.6 freshness patch applied');
