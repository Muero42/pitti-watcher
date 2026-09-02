const HOUR = 3600_000;
const DAY = 24 * HOUR;
const VERSION = '0.2.5';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'pitti-watcher', version: VERSION, at: Date.now() });
    if (url.pathname === '/companion-feed') return companionFeed(env);
    if (url.pathname === '/league-state') {
      const context = await resolveLeagueContext(env, {
        leagueId:String(url.searchParams.get('league_id') || '').trim(),
        userId:String(url.searchParams.get('user_id') || '').trim(),
        rosterId:String(url.searchParams.get('roster_id') || '').trim()
      });
      if (!context.leagueId) return jsonCors({ ok:false, error:'league_id could not be resolved' },400);
      return jsonCors(await leagueState(env, context.leagueId, context.userId, context.rosterId));
    }
    const auth = requireWatcherToken(request, env);
    if (auth) return auth;
    if (url.pathname === '/events') {
      const limit = clampInt(url.searchParams.get('limit'), 1, 100, 30);
      const rows = await env.DB.prepare(`SELECT id,player_id,event_type,fundamental_or_market,occurred_at,first_seen_at,last_seen_at,source,authority,confidence,thesis_link,payload_json FROM evidence_events ORDER BY first_seen_at DESC LIMIT ?1`).bind(limit).all();
      return json(rows.results || []);
    }
    if (url.pathname === '/runs') {
      const limit = clampInt(url.searchParams.get('limit'), 1, 500, 30);
      const type = normalizeRunType(url.searchParams.get('type'));
      const source = normalizeRunSource(url.searchParams.get('source'));
      const { sql, binds } = runsQuery({ type, source, limit });
      let stmt = env.DB.prepare(sql);
      if (binds.length) stmt = stmt.bind(...binds);
      const rows = await stmt.all();
      return json(rows.results || []);
    }
    if (url.pathname === '/run-health') {
      const rows = await env.DB.prepare(`
        SELECT * FROM watcher_runs
        WHERE run_type IN ('trending:scheduled','player_state:scheduled')
        ORDER BY started_at DESC
        LIMIT 40`).all();
      const list = rows.results || [];
      return json({
        ok: true,
        version: VERSION,
        latest: {
          trending: list.find(x => x.run_type === 'trending:scheduled') || null,
          player_state: list.find(x => x.run_type === 'player_state:scheduled') || null
        },
        recentScheduledRuns: list
      });
    }
    if (url.pathname === '/market') {
      const rows = await env.DB.prepare(`
        WITH latest AS (SELECT MAX(captured_at) t FROM trending_snapshots)
        SELECT t.player_id,t.adds_1h,t.adds_3h,t.adds_6h,t.adds_24h,t.drops_1h,t.drops_6h,t.drops_24h,
               COALESCE(p.full_name,t.player_id) full_name,p.team,p.position
        FROM trending_snapshots t
        LEFT JOIN player_state p ON p.player_id=t.player_id
        WHERE t.captured_at=(SELECT t FROM latest)
        ORDER BY COALESCE(t.adds_1h,0) DESC, COALESCE(t.adds_3h,0) DESC
        LIMIT 50`).all();
      return json(rows.results || []);
    }
    if (url.pathname === '/debug/run-trending') {
      const out = await runTrending(env, Date.now(), 'debug');
      return json(out);
    }
    if (url.pathname === '/debug/run-players') {
      const out = await runPlayerState(env, Date.now(), 'debug');
      return json(out);
    }
    return json({ ok: true, endpoints: ['/health','/events','/runs','/run-health','/market','/debug/run-trending','/debug/run-players'] });
  },

  async scheduled(controller, env, ctx) {
    const cron = controller.cron || '';
    const at = Date.now();
    if (cron === '17 4 * * *') {
      ctx.waitUntil(runPlayerState(env, at, 'scheduled'));
      return;
    }
    ctx.waitUntil(runTrending(env, at, 'scheduled'));
  }
};

async function resolveLeagueContext(env, override = {}) {
  let leagueId=String(override.leagueId || env.LEAGUE_ID || '').trim();
  let userId=String(override.userId || env.SLEEPER_USER_ID || '').trim();
  let rosterId=String(override.rosterId || env.MY_ROSTER_ID || '').trim();
  const draftId=String(env.DRAFT_ID || '').trim();
  const mySlot=Number(env.MY_DRAFT_SLOT || 0);
  if ((!leagueId || !rosterId || !userId) && draftId) {
    try {
      const draft=await api(env,`/draft/${draftId}`);
      leagueId=leagueId || String(draft?.league_id || '').trim();
      if (!rosterId && mySlot>0) {
        const mapped=draft?.slot_to_roster_id?.[String(mySlot)] ?? draft?.slot_to_roster_id?.[mySlot];
        if (mapped!==undefined && mapped!==null) rosterId=String(mapped);
      }
      if (!userId && mySlot>0 && draft?.draft_order) {
        const pair=Object.entries(draft.draft_order).find(([,slot])=>Number(slot)===mySlot);
        if(pair) userId=String(pair[0]);
      }
    } catch (_) {}
  }
  return {leagueId,userId,rosterId,draftId:draftId||null,mySlot:mySlot||null};
}

async function leagueState(env, leagueId, userId = '', rosterId = '') {
  const [rosters, users, nflState] = await Promise.all([
    api(env, `/league/${leagueId}/rosters`),
    api(env, `/league/${leagueId}/users`),
    api(env, '/state/nfl').catch(()=>({}))
  ]);
  const currentWeek = Math.max(0, Number(nflState?.week || 0));
  const weeks = [...new Set([0, Math.max(0,currentWeek-1), currentWeek])];
  const transactionPages = await Promise.all(
    weeks.map(w => api(env, `/league/${leagueId}/transactions/${w}`).catch(()=>[]))
  );
  const myRoster = (rosters||[]).find(r =>
    (userId && String(r.owner_id)===userId) ||
    (rosterId && String(r.roster_id)===rosterId)
  ) || null;
  const owned = {};
  for (const r of rosters||[]) {
    const ids = new Set([...(r.players||[]),...(r.reserve||[]),...(r.taxi||[])].filter(Boolean).map(String));
    for (const pid of ids) {
      owned[pid] = {
        roster_id:r.roster_id,
        owner_id:r.owner_id,
        mine:!!(myRoster && String(r.roster_id)===String(myRoster.roster_id)),
        reserve:(r.reserve||[]).map(String).includes(pid),
        taxi:(r.taxi||[]).map(String).includes(pid)
      };
    }
  }
  const txSeen = new Set();
  const transactions = transactionPages.flat().filter(tx => {
    const key=String(tx.transaction_id || tx.created || JSON.stringify(tx));
    if(txSeen.has(key)) return false;
    txSeen.add(key); return true;
  }).sort((a,b)=>Number(b.created||0)-Number(a.created||0));
  return {
    ok:true, league_id:leagueId, user_id:userId||null, roster_id:myRoster?.roster_id||null,
    generated_at:Date.now(), nfl_state:nflState||{}, current_week:currentWeek,
    my_roster:myRoster, rosters, users,
    my_starters:myRoster?.starters||[],
    my_players:myRoster?.players||[],
    my_reserve:myRoster?.reserve||[],
    ownership:owned,
    transactions
  };
}

function ownershipStatus(league, playerId) {
  const x = league?.ownership?.[String(playerId)];
  if (!x) return 'free_agent';
  return x.mine ? 'mine' : 'opponent';
}

function buildFreeAgencyRadar(events = [], market = [], league = null) {
  if (!league?.ok) return { available:false, reason:'LEAGUE_STATE_UNAVAILABLE', candidates:[] };
  const byPlayer = new Map();
  const ensure = id => {
    const key=String(id||'');
    if(!key) return null;
    if(!byPlayer.has(key)) byPlayer.set(key,{ player_id:key, events:[], market:null });
    return byPlayer.get(key);
  };
  for (const m of market||[]) {
    const x=ensure(m.player_id); if(x) x.market=m;
  }
  for (const e of events||[]) {
    const x=ensure(e.player_id); if(x) x.events.push(e);
  }
  const candidates=[];
  for (const x of byPlayer.values()) {
    if (ownershipStatus(league,x.player_id)!=='free_agent') continue;
    const fundamental=x.events.filter(e=>e.fundamental_or_market==='fundamental');
    const marketEvents=x.events.filter(e=>e.fundamental_or_market==='market');
    const adds1=Number(x.market?.adds_1h||0), adds3=Number(x.market?.adds_3h||0), adds24=Number(x.market?.adds_24h||0);
    const drops1=Number(x.market?.drops_1h||0);
    const signalScore=(fundamental.length?1000:0)+(marketEvents.length?250:0)+adds1*4+adds3+Math.min(adds24,200)-drops1*2;
    candidates.push({
      player_id:x.player_id,
      full_name:x.market?.full_name || fundamental[0]?.payload_json?.player || null,
      team:x.market?.team||null, position:x.market?.position||null,
      availability:'free_agent',
      fundamental_events:fundamental.length,
      market_events:marketEvents.length,
      adds_1h:adds1, adds_3h:adds3, adds_24h:adds24, drops_1h:drops1,
      signal_score:signalScore,
      evidence:x.events.slice(0,5)
    });
  }
  candidates.sort((a,b)=>b.signal_score-a.signal_score || b.adds_1h-a.adds_1h);
  return { available:true, generated_at:Date.now(), candidates:candidates.slice(0,50) };
}

async function companionFeed(env) {
  // id is the INTEGER PRIMARY KEY, so reverse-id probes avoid repeatedly scanning
  // the complete run history merely to establish health.
  const [trending, playerState] = await Promise.all([
    env.DB.prepare(`SELECT run_type,started_at,finished_at,ok,item_count FROM watcher_runs
      WHERE run_type='trending:scheduled' ORDER BY id DESC LIMIT 1`).first(),
    env.DB.prepare(`SELECT run_type,started_at,finished_at,ok,item_count FROM watcher_runs
      WHERE run_type='player_state:scheduled' ORDER BY id DESC LIMIT 1`).first()
  ]);
  const now = Date.now();
  const runPass = (x,maxAgeMs) => !!(x && Number(x.ok) === 1 && x.finished_at != null && Number.isFinite(Number(x.started_at)) && now-Number(x.started_at) >= 0 && now-Number(x.started_at) <= maxAgeMs);
  const explicitFail = [trending,playerState].some(x => x && (Number(x.ok) !== 1 || x.finished_at == null));
  const gate = runPass(trending,45*60_000) && runPass(playerState,36*HOUR) ? 'PASS' :
    (explicitFail ? 'FAIL' : (trending && playerState ? 'STALE' : 'WAIT_FOR_SCHEDULED_EVIDENCE'));

  let events = [], market = [], league = null;
  if (gate === 'PASS') {
    const [eventRows, marketRows] = await Promise.all([
      env.DB.prepare(`SELECT id,player_id,event_type,fundamental_or_market,occurred_at,first_seen_at,last_seen_at,source,original_source,authority,confidence,thesis_link,payload_json
        FROM evidence_events ORDER BY first_seen_at DESC LIMIT 250`).all(),
      env.DB.prepare(`
        WITH latest AS (SELECT MAX(captured_at) t FROM trending_snapshots)
        SELECT t.captured_at,t.player_id,t.adds_1h,t.adds_3h,t.adds_6h,t.adds_24h,t.drops_1h,t.drops_6h,t.drops_24h,
               COALESCE(p.full_name,t.player_id) full_name,p.team,p.position
        FROM trending_snapshots t LEFT JOIN player_state p ON p.player_id=t.player_id
        WHERE t.captured_at=(SELECT t FROM latest)
        ORDER BY COALESCE(t.adds_1h,0) DESC, COALESCE(t.adds_3h,0) DESC LIMIT 50`).all()
    ]);
    events = eventRows.results || [];
    market = marketRows.results || [];
    const context=await resolveLeagueContext(env);
    if(context.leagueId) {
      try {
        league=await leagueState(env,context.leagueId,context.userId,context.rosterId);
        league.context={draft_id:context.draftId,my_slot:context.mySlot};
      } catch(e) {
        league={ok:false,error:String(e?.message||e),league_id:context.leagueId,context};
      }
    }
  }
  const freeAgency=gate==='PASS'
    ? buildFreeAgencyRadar(events,market,league)
    : {available:false,reason:'WATCHER_GATE_'+gate,candidates:[]};
  return jsonCors({
    schema:'draft-companion.watcher-feed.v2',
    generatedAt:Date.now(),
    watcherVersion:VERSION,
    gate:{overall:gate,trending:publicRun(trending),player_state:publicRun(playerState)},
    league,freeAgency,events,market
  });
}

function publicRun(x){
  if(!x)return null;
  return {started_at:x.started_at,finished_at:x.finished_at,ok:Number(x.ok)===1,item_count:Number(x.item_count||0)};
}

function jsonCors(data,status=200){
  return new Response(JSON.stringify(data,null,2),{status,headers:{
    'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'
  }});
}

function requireWatcherToken(request, env) {
  const expected = String(env.WATCHER_TOKEN || '').trim();
  if (!expected) return json({ ok: false, error: 'WATCHER_TOKEN is not configured' }, 503);
  const header = String(request.headers.get('authorization') || '');
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!supplied || supplied !== expected) return json({ ok: false, error: 'unauthorized' }, 401);
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}


function normalizeRunType(v) {
  const x = String(v || '').trim();
  return x === 'trending' || x === 'player_state' ? x : null;
}

function normalizeRunSource(v) {
  const x = String(v || '').trim();
  return x === 'scheduled' || x === 'debug' || x === 'legacy' ? x : null;
}

function runsQuery({ type = null, source = null, limit = 30 } = {}) {
  const where = [];
  const binds = [];
  if (type && source === 'scheduled') {
    binds.push(`${type}:scheduled`);
    where.push(`run_type=?${binds.length}`);
  } else if (type && source === 'debug') {
    binds.push(`${type}:debug`);
    where.push(`run_type=?${binds.length}`);
  } else if (type && source === 'legacy') {
    binds.push(type);
    where.push(`run_type=?${binds.length}`);
  } else if (type) {
    binds.push(type, `${type}:scheduled`, `${type}:debug`);
    const a = binds.length - 2, b = binds.length - 1, c = binds.length;
    where.push(`run_type IN (?${a},?${b},?${c})`);
  } else if (source === 'scheduled') {
    where.push(`run_type LIKE '%:scheduled'`);
  } else if (source === 'debug') {
    where.push(`run_type LIKE '%:debug'`);
  } else if (source === 'legacy') {
    where.push(`run_type IN ('trending','player_state')`);
  }
  binds.push(clampInt(limit, 1, 500, 30));
  const limitParam = binds.length;
  return {
    sql: `SELECT * FROM watcher_runs${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT ?${limitParam}`,
    binds
  };
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function api(env, path) {
  const base = env.SLEEPER_BASE || 'https://api.sleeper.app/v1';
  const r = await fetch(base + path, { headers: { 'user-agent': `PittiWatcher/${VERSION}` } });
  if (!r.ok) throw new Error(`Sleeper ${path}: HTTP ${r.status}`);
  return r.json();
}

async function startRun(env, type, at, source = 'internal') {
  const storedType = source === 'scheduled' || source === 'debug' ? `${type}:${source}` : type;
  const x = await env.DB.prepare(`INSERT INTO watcher_runs(run_type,started_at) VALUES(?1,?2) RETURNING id`).bind(storedType, at).first();
  return x?.id;
}

async function finishRun(env, id, ok, count, error = null) {
  if (!id) return;
  await env.DB.prepare(`UPDATE watcher_runs SET finished_at=?1,ok=?2,item_count=?3,error=?4 WHERE id=?5`).bind(Date.now(), ok ? 1 : 0, count || 0, error, id).run();
}

async function trendingWindow(env, type, hours, limit) {
  const rows = await api(env, `/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`);
  const map = new Map();
  for (const x of Array.isArray(rows) ? rows : []) map.set(String(x.player_id), Number(x.count) || 0);
  return map;
}

async function runTrending(env, at, source = 'internal') {
  const runId = await startRun(env, 'trending', at, source);
  try {
    const limit = clampInt(env.TREND_LIMIT, 20, 1000, 200);
    const [a1,a3,a6,a24,d1,d6,d24] = await Promise.all([
      trendingWindow(env,'add',1,limit), trendingWindow(env,'add',3,limit), trendingWindow(env,'add',6,limit), trendingWindow(env,'add',24,limit),
      trendingWindow(env,'drop',1,limit), trendingWindow(env,'drop',6,limit), trendingWindow(env,'drop',24,limit)
    ]);
    const ids = new Set([...a1.keys(),...a3.keys(),...a6.keys(),...a24.keys(),...d1.keys(),...d6.keys(),...d24.keys()]);
    // Keep only the immediately preceding capture plus the current capture. This
    // bounds both D1 storage and MAX(captured_at) reads while preserving delta signals.
    const previousAt = await latestTrendingCaptureBefore(env, at);
    await env.DB.prepare('DELETE FROM trending_snapshots WHERE captured_at < ?1').bind(previousAt ?? at).run();
    const stmt = env.DB.prepare(`INSERT INTO trending_snapshots(captured_at,player_id,adds_1h,adds_3h,adds_6h,adds_24h,drops_1h,drops_6h,drops_24h) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`);
    const batch = [];
    for (const id of ids) batch.push(stmt.bind(at,id,a1.get(id)||0,a3.get(id)||0,a6.get(id)||0,a24.get(id)||0,d1.get(id)||0,d6.get(id)||0,d24.get(id)||0));
    if (batch.length) await env.DB.batch(batch);
    await detectMarketEvents(env, at, previousAt);
    await finishRun(env, runId, true, ids.size);
    return { ok: true, captured_at: at, players: ids.size };
  } catch (e) {
    await finishRun(env, runId, false, 0, String(e?.message || e));
    throw e;
  }
}

async function latestTrendingCaptureBefore(env, at) {
  const row = await env.DB.prepare('SELECT captured_at FROM trending_snapshots WHERE captured_at < ?1 ORDER BY captured_at DESC LIMIT 1').bind(at).first();
  return row?.captured_at ?? null;
}

function previousTrendingSnapshotSql() {
  // All rows from one polling run share captured_at. Select exactly the immediately
  // preceding snapshot instead of grouping the entire historical table by player_id.
  // The old GROUP BY path made rows_read grow with total history on every 15-minute run.
  return `
    SELECT *
    FROM trending_snapshots
    WHERE captured_at=(
      SELECT MAX(captured_at)
      FROM trending_snapshots
      WHERE captured_at < ?1
    )
  `;
}

async function detectMarketEvents(env, at, previousAt = null) {
  const [currentResult, previousResult] = await Promise.all([
    env.DB.prepare(`SELECT * FROM trending_snapshots WHERE captured_at=?1`).bind(at).all(),
    previousAt === null ? Promise.resolve({ results: [] }) : env.DB.prepare(`SELECT * FROM trending_snapshots WHERE captured_at=?1`).bind(previousAt).all()
  ]);

  const previous = new Map(
    (previousResult.results || []).map(row => [String(row.player_id), row])
  );

  for (const row of currentResult.results || []) {
    const prev = previous.get(String(row.player_id));
    if (!prev) continue;

    const { addNow, addPrev, dropNow, dropPrev, accel, reversal, marketAcceleration, marketReversal } = marketSignals(row, prev);

    if (marketAcceleration) {
      await upsertEvidence(env, {
        player_id: row.player_id, event_type: 'MARKET_ACCELERATION', fundamental_or_market: 'market', occurred_at: at,
        first_seen_at: at, last_seen_at: at, source: 'Sleeper Trending', original_source: 'Sleeper Trending', authority: 0.95, confidence: 0.95,
        thesis_link: 'market_recognition', payload: { adds_1h: addNow, previous_adds_1h: addPrev, acceleration: accel, adds_3h: row.adds_3h, adds_24h: row.adds_24h }
      });
    }

    if (marketReversal) {
      await upsertEvidence(env, {
        player_id: row.player_id, event_type: 'MARKET_REVERSAL', fundamental_or_market: 'market', occurred_at: at,
        first_seen_at: at, last_seen_at: at, source: 'Sleeper Trending', original_source: 'Sleeper Trending', authority: 0.95, confidence: 0.9,
        thesis_link: 'market_recognition', payload: { drops_1h: dropNow, previous_drops_1h: dropPrev, acceleration: reversal, drops_6h: row.drops_6h, drops_24h: row.drops_24h }
      });
    }
  }
}

function marketSignals(row, prev) {
  const addNow = Number(row.adds_1h || 0), addPrev = Number(prev.adds_1h || 0);
  const dropNow = Number(row.drops_1h || 0), dropPrev = Number(prev.drops_1h || 0);
  const accel = addNow - addPrev;
  const reversal = dropNow - dropPrev;
  return { addNow, addPrev, dropNow, dropPrev, accel, reversal, marketAcceleration: addNow >= 25 && accel >= 15, marketReversal: dropNow >= 20 && reversal >= 12 };
}

function playerStateOf(p) {
  return {
    full_name: p.full_name || [p.first_name,p.last_name].filter(Boolean).join(' ') || null,
    team: p.team || null,
    position: p.position || null,
    injury_status: p.injury_status || null,
    practice_participation: p.practice_participation || null,
    depth_chart_order: depthChartOrderOf(p),
    status: p.status || null
  };
}

function depthChartOrderOf(p) {
  const raw = p.depth_chart_order ?? p.depth_chart_position;
  return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
}

function trackedState(s) {
  return { team:s.team, position:s.position, injury_status:s.injury_status, practice_participation:s.practice_participation, depth_chart_order:s.depth_chart_order, status:s.status };
}

function stateHash(s) {
  return JSON.stringify(trackedState(s));
}

async function runPlayerState(env, at, source = 'internal') {
  const runId = await startRun(env, 'player_state', at, source);

  try {
    const players = await api(env, '/players/nfl');

    // Bestehenden Zustand einmal gesammelt laden:
    // kein SELECT mehr pro Spieler.
    const existingResult = await env.DB
      .prepare('SELECT * FROM player_state')
      .all();

    const existing = new Map(
      (existingResult.results || []).map(row => [String(row.player_id), row])
    );

    let changed = 0;
    let seen = 0;
    const writes = [];

    for (const [id, p] of Object.entries(players || {})) {
      if (!p || !p.position) continue;
      seen++;

      const s = playerStateOf(p);
      const hash = stateHash(s);
      const old = existing.get(String(id));

      if (!old) {
        writes.push(
          env.DB.prepare(
            `INSERT INTO player_state(
              player_id,full_name,team,position,injury_status,
              practice_participation,depth_chart_order,status,
              first_seen_at,last_seen_at,state_hash
            ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
          ).bind(
            id,
            s.full_name,
            s.team,
            s.position,
            s.injury_status,
            s.practice_participation,
            s.depth_chart_order,
            s.status,
            at,
            at,
            hash
          )
        );
        continue;
      }

      // Unchanged state is deliberately write-free. last_seen_at is not used as
      // liveness evidence; watcher_runs records successful full-state observations.
      if (old.state_hash === hash) continue;

      changed++;
      const diffs = {};

      for (const k of [
        'team',
        'position',
        'injury_status',
        'practice_participation',
        'depth_chart_order',
        'status'
      ]) {
        const before = old[k] ?? null;
        const after = s[k] ?? null;

        if (String(before) !== String(after)) {
          diffs[k] = { before, after };
        }
      }

      writes.push(
        env.DB.prepare(
          `UPDATE player_state
           SET full_name=?1,team=?2,position=?3,injury_status=?4,
               practice_participation=?5,depth_chart_order=?6,status=?7,
               last_seen_at=?8,state_hash=?9
           WHERE player_id=?10`
        ).bind(
          s.full_name,
          s.team,
          s.position,
          s.injury_status,
          s.practice_participation,
          s.depth_chart_order,
          s.status,
          at,
          hash,
          id
        )
      );

      await upsertEvidence(env, {
        player_id: id,
        event_type: 'PLAYER_STATE_CHANGED',
        fundamental_or_market: 'fundamental',
        occurred_at: at,
        first_seen_at: at,
        last_seen_at: at,
        source: 'Sleeper Player Data',
        original_source: 'Sleeper Player Data',
        authority: 0.75,
        confidence: 0.8,
        thesis_link: inferThesisLink(diffs),
        payload: {
          player: s.full_name,
          team: s.team,
          position: s.position,
          diffs
        }
      });
    }

    // Schreiboperationen gebündelt an D1 schicken.
    const BATCH_SIZE = 75;
    for (let i = 0; i < writes.length; i += BATCH_SIZE) {
      await env.DB.batch(writes.slice(i, i + BATCH_SIZE));
    }

    await finishRun(env, runId, true, seen);
    return { ok: true, captured_at: at, seen, changed };
  } catch (e) {
    await finishRun(env, runId, false, 0, String(e?.message || e));
    throw e;
  }
}

function inferThesisLink(diffs) {
  if (diffs.injury_status || diffs.practice_participation) return 'availability_contingency';
  if (diffs.depth_chart_order) return 'role_access';
  if (diffs.team || diffs.position || diffs.status) return 'roster_context';
  return 'player_state';
}

async function upsertEvidence(env, e) {
  const fingerprint = await evidenceFingerprint(e);
  const payload = JSON.stringify(e.payload || {});
  await env.DB.prepare(`
    INSERT INTO evidence_events(fingerprint,player_id,event_type,fundamental_or_market,occurred_at,first_seen_at,last_seen_at,source,original_source,authority,confidence,thesis_link,payload_json)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
    ON CONFLICT(fingerprint) DO UPDATE SET last_seen_at=excluded.last_seen_at
  `).bind(fingerprint,e.player_id||null,e.event_type,e.fundamental_or_market,e.occurred_at||null,e.first_seen_at,e.last_seen_at,e.source,e.original_source,e.authority,e.confidence,e.thesis_link||null,payload).run();
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
}

async function evidenceFingerprint(e) {
  // Market alerts can repeat on every poll while the same surge is active. Bucket them
  // by UTC hour so first_seen_at remains stable within the alert window. Fundamental
  // state changes retain their exact before/after payload identity.
  const identity = e.fundamental_or_market === 'market'
    ? [e.player_id, e.event_type, Math.floor(Number(e.occurred_at || e.first_seen_at) / HOUR), e.original_source]
    : [e.player_id, e.event_type, e.original_source, e.payload];
  return sha256(JSON.stringify(identity));
}

export { playerStateOf, trackedState, stateHash, inferThesisLink, marketSignals, evidenceFingerprint, depthChartOrderOf, normalizeRunType, normalizeRunSource, runsQuery, ownershipStatus, buildFreeAgencyRadar, resolveLeagueContext, previousTrendingSnapshotSql };
