const HOUR = 3600_000;
const DAY = 24 * HOUR;
const VERSION = '0.2.6';

function d1PhaseMeta(value) {
  const results = Array.isArray(value) ? value : [value];
  const totals = { query_count: 0, rows_read: 0, rows_written: 0, sql_ms: 0 };
  let observed = false;
  for (const result of results) {
    const meta = result?.meta;
    if (!meta) continue;
    const rowsRead = Number(meta.rows_read);
    const rowsWritten = Number(meta.rows_written);
    const sqlMs = Number(meta.timings?.sql_duration_ms ?? meta.duration);
    if (Number.isFinite(rowsRead)) totals.rows_read += rowsRead;
    if (Number.isFinite(rowsWritten)) totals.rows_written += rowsWritten;
    if (Number.isFinite(sqlMs)) totals.sql_ms += sqlMs;
    totals.query_count++;
    observed = true;
  }
  return observed ? totals : {};
}

function phaseErrorCode(error) {
  const raw = String(error?.code || error?.message || 'PHASE_FAILED').toUpperCase();
  const normalized = raw.replace(/[^A-Z0-9_:-]/g, '_').slice(0, 64);
  return normalized || 'PHASE_FAILED';
}

async function runPhase(env, lane, phase, context, work) {
  const enabled = String(env.PHASE_LOGGING || '') === '1';
  const started = performance.now();
  if (enabled) console.log(JSON.stringify({ event: 'watcher_phase', lane, phase, state: 'start', ...context }));
  try {
    const result = await work();
    if (enabled) console.log(JSON.stringify({
      event: 'watcher_phase', lane, phase, state: 'ok',
      wall_ms: Math.round((performance.now() - started) * 1000) / 1000,
      ...d1PhaseMeta(result), ...context
    }));
    return result;
  } catch (error) {
    if (enabled) console.log(JSON.stringify({
      event: 'watcher_phase', lane, phase, state: 'fail',
      wall_ms: Math.round((performance.now() - started) * 1000) / 1000,
      error_code: phaseErrorCode(error), ...context
    }));
    throw error;
  }
}

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
  validateRunId(x?.id);
  return x?.id;
}

function finalizationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateRunId(id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw finalizationError('INVALID_RUN_ID');
}

async function finishRun(env, id, state) {
  let result;
  try {
    result = await env.DB.prepare(`UPDATE watcher_runs SET finished_at=?1,ok=?2,item_count=?3,error=?4 WHERE id=?5 AND finished_at IS NULL`)
      .bind(state.finished_at, state.ok, state.item_count, state.error, id).run();
  } catch (_) {
    throw finalizationError('FINALIZE_D1_ERROR');
  }
  if (result?.success !== true) throw finalizationError('FINALIZE_D1_RESULT');
  if (result.meta?.changes !== 1) throw finalizationError('FINALIZE_NO_MATCH');
}

async function safeFinishRun(env, id, ok, count) {
  validateRunId(id);
  // Stable values make an ambiguous commit verifiable without overwriting it.
  const state = { finished_at: Date.now(), ok: ok ? 1 : 0, item_count: count || 0, error: ok ? null : 'WORK_FAILED' };
  try {
    await finishRun(env, id, state);
    return;
  } catch (firstError) {
    let row;
    try {
      row = await env.DB.prepare('SELECT finished_at,ok,item_count,error FROM watcher_runs WHERE id=?1').bind(id).first();
    } catch (_) {
      throw new AggregateError([firstError, finalizationError('FINALIZE_CONFIRM_ERROR')], 'FINALIZATION_FAILED');
    }
    if (row && Object.keys(state).every(key => row[key] === state[key])) return;
    if (!row || row.finished_at !== null) {
      throw new AggregateError([firstError, finalizationError(row ? 'FINALIZE_CONFLICT' : 'FINALIZE_NO_MATCH')], 'FINALIZATION_FAILED');
    }
    // Exactly one retry, only after the intended row was confirmed still open.
    try {
      await finishRun(env, id, state);
    } catch (retryError) {
      throw new AggregateError([firstError, retryError], 'FINALIZATION_FAILED');
    }
  }
}

async function rejectWorkFailure(env, id, workError) {
  try {
    await safeFinishRun(env, id, false, 0);
  } catch (finalError) {
    // Preserve the original value as the primary cause; diagnostics never stringify it.
    throw new AggregateError([workError, finalError], 'WORK_FAILED;FINALIZATION_FAILED', { cause: workError });
  }
  throw workError;
}

async function trendingWindow(env, type, hours, limit) {
  const rows = await api(env, `/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`);
  const map = new Map();
  for (const x of Array.isArray(rows) ? rows : []) map.set(String(x.player_id), Number(x.count) || 0);
  return map;
}

function collectTrendingIds(...maps) {
  const ids = new Set();
  for (const map of maps) {
    for (const id of map.keys()) ids.add(id);
  }
  return ids;
}

async function runTrending(env, at, source = 'internal') {
  const runId = await startRun(env, 'trending', at, source);
  let result;
  try {
    const limit = clampInt(env.TREND_LIMIT, 20, 1000, 200);
    const [a1,a3,a6,a24,d1,d6,d24] = await Promise.all([
      trendingWindow(env,'add',1,limit), trendingWindow(env,'add',3,limit), trendingWindow(env,'add',6,limit), trendingWindow(env,'add',24,limit),
      trendingWindow(env,'drop',1,limit), trendingWindow(env,'drop',6,limit), trendingWindow(env,'drop',24,limit)
    ]);
    const ids = collectTrendingIds(a1, a3, a6, a24, d1, d6, d24);
    // Keep only the immediately preceding capture plus the current capture. This
    // bounds both D1 storage and MAX(captured_at) reads while preserving delta signals.
    const previousAt = await latestTrendingCaptureBefore(env, at);
    // Never run an unbounded historical DELETE in the scheduled hot path. D1 counts
    // deleted rows as rows_written, so legacy backlog could exhaust a fresh daily quota
    // in one run. Retention is intentionally bounded and incremental.
    await pruneTrendingSnapshots(env, previousAt ?? at);
    const stmt = env.DB.prepare(`INSERT INTO trending_snapshots(captured_at,player_id,adds_1h,adds_3h,adds_6h,adds_24h,drops_1h,drops_6h,drops_24h) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`);
    const batch = [];
    for (const id of ids) batch.push(stmt.bind(at,id,a1.get(id)||0,a3.get(id)||0,a6.get(id)||0,a24.get(id)||0,d1.get(id)||0,d6.get(id)||0,d24.get(id)||0));
    if (batch.length) await env.DB.batch(batch);
    await detectMarketEvents(env, at, previousAt);
    result = { ok: true, captured_at: at, players: ids.size };
  } catch (e) {
    return rejectWorkFailure(env, runId, e);
  }
  await safeFinishRun(env, runId, true, result.players);
  return result;
}

async function pruneTrendingSnapshots(env, keepFrom) {
  const batchSize = clampInt(env.TREND_PRUNE_BATCH, 10, 500, 100);
  // SQLite/D1 supports DELETE ... WHERE rowid IN (SELECT ... LIMIT ...).
  // At most batchSize legacy rows are charged as writes per trending run.
  return env.DB.prepare(`
    DELETE FROM trending_snapshots
    WHERE rowid IN (
      SELECT rowid FROM trending_snapshots
      WHERE captured_at < ?1
      ORDER BY captured_at ASC
      LIMIT ?2
    )
  `).bind(keepFrom, batchSize).run();
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
    env.DB.prepare(`SELECT player_id,adds_1h,adds_3h,adds_24h,drops_1h,drops_6h,drops_24h FROM trending_snapshots WHERE captured_at=?1`).bind(at).all(),
    previousAt === null ? Promise.resolve({ results: [] }) : env.DB.prepare(`SELECT player_id,adds_1h,drops_1h FROM trending_snapshots WHERE captured_at=?1`).bind(previousAt).all()
  ]);

  const previous = new Map();
  for (const row of previousResult.results || []) previous.set(String(row.player_id), row);
  let evidenceStatement;
  const prepareEvidence = () => evidenceStatement ??= env.DB.prepare(EVIDENCE_UPSERT_SQL);

  for (const row of currentResult.results || []) {
    const prev = previous.get(String(row.player_id));
    if (!prev) continue;

    const { addNow, addPrev, dropNow, dropPrev, accel, reversal, marketAcceleration, marketReversal } = marketSignals(row, prev);

    if (marketAcceleration) {
      await upsertEvidence(env, {
        player_id: row.player_id, event_type: 'MARKET_ACCELERATION', fundamental_or_market: 'market', occurred_at: at,
        first_seen_at: at, last_seen_at: at, source: 'Sleeper Trending', original_source: 'Sleeper Trending', authority: 0.95, confidence: 0.95,
        thesis_link: 'market_recognition', payload: { adds_1h: addNow, previous_adds_1h: addPrev, acceleration: accel, adds_3h: row.adds_3h, adds_24h: row.adds_24h }
      }, prepareEvidence);
    }

    if (marketReversal) {
      await upsertEvidence(env, {
        player_id: row.player_id, event_type: 'MARKET_REVERSAL', fundamental_or_market: 'market', occurred_at: at,
        first_seen_at: at, last_seen_at: at, source: 'Sleeper Trending', original_source: 'Sleeper Trending', authority: 0.95, confidence: 0.9,
        thesis_link: 'market_recognition', payload: { drops_1h: dropNow, previous_drops_1h: dropPrev, acceleration: reversal, drops_6h: row.drops_6h, drops_24h: row.drops_24h }
      }, prepareEvidence);
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

function trendingRows(ids, windows) {
  const { a1, a3, a6, a24, d1, d6, d24 } = windows;
  return [...ids].map(player_id => ({
    player_id,
    adds_1h: a1.get(player_id) || 0,
    adds_3h: a3.get(player_id) || 0,
    adds_6h: a6.get(player_id) || 0,
    adds_24h: a24.get(player_id) || 0,
    drops_1h: d1.get(player_id) || 0,
    drops_6h: d6.get(player_id) || 0,
    drops_24h: d24.get(player_id) || 0
  }));
}

function parseTrendingFrame(row) {
  if (!row) return { captured_at: null, rows: [] };
  let rows;
  try { rows = JSON.parse(String(row.frame_json || '[]')); }
  catch (_) { throw new Error('TRENDING_FRAME_INVALID'); }
  if (!Array.isArray(rows) || rows.length !== Number(row.player_count)) throw new Error('TRENDING_FRAME_INVALID');
  return { captured_at: Number(row.captured_at), rows };
}

function marketSignalLevel(signalType, row, previous) {
  if (!previous) return 0;
  const addNow = Number(row?.adds_1h || 0), addPrev = Number(previous?.adds_1h || 0);
  const dropNow = Number(row?.drops_1h || 0), dropPrev = Number(previous?.drops_1h || 0);
  if (signalType === 'acceleration') {
    const delta = addNow - addPrev;
    if (addNow >= 100 && delta >= 60) return 3;
    if (addNow >= 50 && delta >= 30) return 2;
    if (addNow >= 25 && delta >= 15) return 1;
    return 0;
  }
  const delta = dropNow - dropPrev;
  if (dropNow >= 80 && delta >= 48) return 3;
  if (dropNow >= 40 && delta >= 24) return 2;
  if (dropNow >= 20 && delta >= 12) return 1;
  return 0;
}

function marketTransitionPlan(currentRows, previousRows, storedSignals, at) {
  const current = new Map((currentRows || []).map(row => [String(row.player_id), row]));
  const previous = new Map((previousRows || []).map(row => [String(row.player_id), row]));
  const stored = new Map((storedSignals || []).map(row => [`${row.player_id}:${row.signal_type}`, row]));
  const playerIds = new Set([...current.keys(), ...(storedSignals || []).map(row => String(row.player_id))]);
  const events = [];
  const stateChanges = [];

  for (const playerId of playerIds) {
    const row = current.get(playerId) || { player_id: playerId };
    const priorFrame = previous.get(playerId);
    for (const signalType of ['acceleration', 'reversal']) {
      const key = `${playerId}:${signalType}`;
      const old = stored.get(key) || null;
      const level = current.has(playerId) ? marketSignalLevel(signalType, row, priorFrame) : 0;
      if (!old && level === 0) continue;

      const episodeStartedAt = old ? Number(old.episode_started_at) : at;
      let transition = null;
      if (!old && level > 0) transition = 'STARTED';
      else if (old && level === 0) transition = 'ENDED';
      else if (old && level > Number(old.level)) transition = 'LEVEL_UP';

      if (!old || level !== Number(old.level)) {
        stateChanges.push({
          action: level === 0 ? 'delete' : 'upsert',
          player_id: playerId, signal_type: signalType, level,
          episode_started_at: episodeStartedAt, last_transition_at: at
        });
      }
      if (!transition) continue;

      const addNow = Number(row.adds_1h || 0), addPrev = Number(priorFrame?.adds_1h || 0);
      const dropNow = Number(row.drops_1h || 0), dropPrev = Number(priorFrame?.drops_1h || 0);
      const prefix = signalType === 'acceleration' ? 'MARKET_ACCELERATION' : 'MARKET_REVERSAL';
      events.push({
        player_id: playerId,
        event_type: `${prefix}_${transition}`,
        fundamental_or_market: 'market', occurred_at: at,
        first_seen_at: at, last_seen_at: at,
        source: 'Sleeper Trending', original_source: 'Sleeper Trending',
        authority: 0.95, confidence: signalType === 'acceleration' ? 0.95 : 0.9,
        thesis_link: 'market_recognition',
        transition_key: `${signalType}:${episodeStartedAt}:${transition}:${level}`,
        payload: {
          signal_type: signalType, transition, level,
          adds_1h: addNow, previous_adds_1h: addPrev, add_acceleration: addNow - addPrev,
          drops_1h: dropNow, previous_drops_1h: dropPrev, drop_acceleration: dropNow - dropPrev
        }
      });
    }
  }
  return { events, stateChanges };
}

async function runStatementBatches(env, lane, phase, context, statements, size = 75) {
  const results = [];
  await runPhase(env, lane, phase, context, async () => {
    for (let i = 0; i < statements.length; i += size) {
      results.push(...await env.DB.batch(statements.slice(i, i + size)));
    }
    return results;
  });
  return results;
}

async function runTrendingFrames(env, at, source = 'internal') {
  const runId = await startRun(env, 'trending', at, source);
  const context = { run_id: runId };
  try {
    const limit = clampInt(env.TREND_LIMIT, 20, 1000, 200);
    const [a1,a3,a6,a24,d1,d6,d24] = await runPhase(env, 'market', 'source.fetch', context, () => Promise.all([
      trendingWindow(env,'add',1,limit), trendingWindow(env,'add',3,limit), trendingWindow(env,'add',6,limit), trendingWindow(env,'add',24,limit),
      trendingWindow(env,'drop',1,limit), trendingWindow(env,'drop',6,limit), trendingWindow(env,'drop',24,limit)
    ]));
    const ids = collectTrendingIds(a1, a3, a6, a24, d1, d6, d24);
    const rows = trendingRows(ids, { a1, a3, a6, a24, d1, d6, d24 });
    const [previousFrameResult, signalResult] = await runPhase(env, 'market', 'state.load', context, () => Promise.all([
      env.DB.prepare(`SELECT captured_at,player_count,frame_json FROM trending_snapshot_frames ORDER BY captured_at DESC LIMIT 1`).all(),
      env.DB.prepare(`SELECT player_id,signal_type,level,episode_started_at,last_transition_at FROM market_signal_state`).all()
    ]));
    const previousFrameRow = previousFrameResult.results?.[0] || null;
    const previousFrame = parseTrendingFrame(previousFrameRow);
    const plan = marketTransitionPlan(rows, previousFrame.rows, signalResult.results || [], at);

    const evidence = [];
    let evidenceStatement;
    for (const event of plan.events) {
      evidenceStatement ??= env.DB.prepare(EVIDENCE_UPSERT_SQL);
      evidence.push(await bindEvidence(evidenceStatement, event));
    }
    const state = plan.stateChanges.map(change => change.action === 'delete'
      ? env.DB.prepare(`DELETE FROM market_signal_state WHERE player_id=?1 AND signal_type=?2`).bind(change.player_id, change.signal_type)
      : env.DB.prepare(`
          INSERT INTO market_signal_state(player_id,signal_type,level,episode_started_at,last_transition_at)
          VALUES(?1,?2,?3,?4,?5)
          ON CONFLICT(player_id,signal_type) DO UPDATE SET
            level=excluded.level,episode_started_at=excluded.episode_started_at,last_transition_at=excluded.last_transition_at
        `).bind(change.player_id, change.signal_type, change.level, change.episode_started_at, change.last_transition_at));

    await runPhase(env, 'market', 'frame.insert', context, () => env.DB.prepare(`
      INSERT INTO trending_snapshot_frames(captured_at,player_count,frame_json) VALUES(?1,?2,?3)
    `).bind(at, rows.length, JSON.stringify(rows)).run());
    await runStatementBatches(env, 'market', 'evidence.batch', context, evidence);
    await runStatementBatches(env, 'market', 'signal_state.batch', context, state);
    if (previousFrame.captured_at !== null) {
      await runPhase(env, 'market', 'retention.prune', context, () => env.DB.prepare(`
        DELETE FROM trending_snapshot_frames
        WHERE captured_at < ?1
      `).bind(previousFrame.captured_at).run());
    }
    await safeFinishRun(env, runId, true, rows.length);
    return { ok: true, captured_at: at, players: rows.length, transitions: plan.events.length };
  } catch (error) {
    return rejectWorkFailure(env, runId, error);
  }
}

async function latestMarketFrameRows(env, limit = 50) {
  const frame = parseTrendingFrame(await env.DB.prepare(`
    SELECT captured_at,player_count,frame_json FROM trending_snapshot_frames ORDER BY captured_at DESC LIMIT 1
  `).first());
  const rows = frame.rows
    .sort((a,b) => Number(b.adds_1h || 0)-Number(a.adds_1h || 0) || Number(b.adds_3h || 0)-Number(a.adds_3h || 0))
    .slice(0, clampInt(limit, 1, 100, 50));
  if (!rows.length) return [];
  const ids = rows.map(row => String(row.player_id));
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(',');
  const players = await env.DB.prepare(`SELECT player_id,full_name,team,position FROM player_state WHERE player_id IN (${placeholders})`).bind(...ids).all();
  const byId = new Map((players.results || []).map(player => [String(player.player_id), player]));
  return rows.map(row => ({ captured_at: frame.captured_at, ...row, ...(byId.get(String(row.player_id)) || { full_name: row.player_id, team: null, position: null }) }));
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

const PLAYER_STATE_BATCH_SIZE = 75;
const PLAYER_STATE_SCOPES = Object.freeze(['QB','RB','WR','TE','K']);

async function persistPlayerStateEntries(env, at, entries, existingRows, phaseContext = null) {
  const existing = new Map((existingRows || []).map(row => [String(row.player_id), row]));
  let changed = 0;
  let seen = 0;
  const evidenceWrites = [];
  const writes = [];
  let evidenceStatement;

  for (const [id, p] of entries) {
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
          id, s.full_name, s.team, s.position, s.injury_status,
          s.practice_participation, s.depth_chart_order, s.status,
          at, at, hash
        )
      );
      continue;
    }

    if (old.state_hash === hash) continue;

    changed++;
    const diffs = {};
    for (const k of ['team','position','injury_status','practice_participation','depth_chart_order','status']) {
      const before = old[k] ?? null;
      const after = s[k] ?? null;
      if (String(before) !== String(after)) diffs[k] = { before, after };
    }

    writes.push(
      env.DB.prepare(
        `UPDATE player_state
         SET full_name=?1,team=?2,position=?3,injury_status=?4,
             practice_participation=?5,depth_chart_order=?6,status=?7,
             last_seen_at=?8,state_hash=?9
         WHERE player_id=?10`
      ).bind(
        s.full_name, s.team, s.position, s.injury_status,
        s.practice_participation, s.depth_chart_order, s.status,
        at, hash, id
      )
    );

    evidenceStatement ??= env.DB.prepare(EVIDENCE_UPSERT_SQL);
    evidenceWrites.push(await bindEvidence(evidenceStatement, {
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
      payload: { player: s.full_name, team: s.team, position: s.position, diffs }
    }));
  }

  const persistEvidence = async () => {
    const results = [];
    for (let i = 0; i < evidenceWrites.length; i += PLAYER_STATE_BATCH_SIZE) {
      results.push(...await env.DB.batch(evidenceWrites.slice(i, i + PLAYER_STATE_BATCH_SIZE)));
    }
    return results;
  };
  const persistState = async () => {
    const results = [];
    for (let i = 0; i < writes.length; i += PLAYER_STATE_BATCH_SIZE) {
      results.push(...await env.DB.batch(writes.slice(i, i + PLAYER_STATE_BATCH_SIZE)));
    }
    return results;
  };
  if (phaseContext) {
    await runPhase(env, 'player_state', 'evidence.batch', phaseContext, persistEvidence);
    await runPhase(env, 'player_state', 'state.batch', phaseContext, persistState);
  } else {
    await persistEvidence();
    await persistState();
  }

  return { seen, changed };
}

function playerScopePath(scope) {
  return `/players/nfl?position=${encodeURIComponent(scope)}`;
}

async function fetchPlayerScope(env, scope, expectedEtag = null, parseBody = true) {
  const base = env.SLEEPER_BASE || 'https://api.sleeper.app/v1';
  const headers = { 'user-agent': `PittiWatcher/${VERSION}` };
  if (expectedEtag) headers['if-none-match'] = expectedEtag;
  const response = await fetch(base + playerScopePath(scope), { headers, cache: 'no-store' });
  if (response.status === 304) return { unchanged: true, sourceEtag: expectedEtag, players: null };
  if (!response.ok) throw new Error(`Sleeper ${playerScopePath(scope)}: HTTP ${response.status}`);
  const sourceEtag = String(response.headers?.get?.('etag') || '').trim();
  if (!sourceEtag) throw new Error(`Sleeper ${playerScopePath(scope)}: missing ETag`);
  if (!parseBody) {
    try { await response.body?.cancel?.(); } catch (_) {}
    return { unchanged: sourceEtag === expectedEtag, sourceEtag, players: null };
  }
  return { unchanged: sourceEtag === expectedEtag, sourceEtag, players: await response.json() };
}

async function activePlayerStateSweep(env) {
  return env.DB.prepare(`
    SELECT s.run_id,s.source_etag,s.total_entries,s.next_index,s.seen_count,s.started_at
    FROM player_state_sweeps s
    JOIN watcher_runs r ON r.id=s.run_id
    WHERE r.finished_at IS NULL
    ORDER BY s.run_id DESC
    LIMIT 1
  `).first();
}

async function initializePlayerStateSweep(env, at, source = 'scheduled', existingRunId = null) {
  const runId = existingRunId ?? await startRun(env, 'player_state', at, source);
  try {
    const result = await env.DB.prepare(`
      INSERT INTO player_state_sweeps(run_id,source_etag,total_entries,next_index,seen_count,started_at)
      VALUES(?1,?2,?3,0,0,?4)
    `).bind(runId, '{}', PLAYER_STATE_SCOPES.length, at).run();
    if (result?.success !== true || result.meta?.changes !== 1) throw new Error('PLAYER_SWEEP_INIT_FAILED');
  } catch (error) {
    return rejectWorkFailure(env, runId, error);
  }
  return processPlayerStateSweepScope(env, {
    run_id: runId, source_etag: '{}', total_entries: PLAYER_STATE_SCOPES.length,
    next_index: 0, seen_count: 0, started_at: at
  });
}

function parseSweepEtags(raw) {
  try {
    const value = JSON.parse(String(raw || '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    throw new Error('PLAYER_SWEEP_ETAGS_INVALID');
  }
}

async function loadExistingPlayerRows(env, ids) {
  if (!ids.length) return [];
  const rows = [];
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const placeholders = slice.map((_, j) => `?${j + 1}`).join(',');
    const result = await env.DB.prepare(
      `SELECT * FROM player_state WHERE player_id IN (${placeholders})`
    ).bind(...slice).all();
    rows.push(...(result.results || []));
  }
  return rows;
}

async function revalidatePlayerStateScopes(env, etags) {
  for (const scope of PLAYER_STATE_SCOPES) {
    const expected = String(etags[scope] || '');
    if (!expected) return false;
    const check = await fetchPlayerScope(env, scope, expected, false);
    if (!check.unchanged || check.sourceEtag !== expected) return false;
  }
  return true;
}

async function processPlayerStateSweepScope(env, sweep) {
  const index = Number(sweep.next_index);
  if (!Number.isSafeInteger(index) || index < 0 || index > PLAYER_STATE_SCOPES.length) {
    throw new Error('PLAYER_SWEEP_CURSOR_INVALID');
  }
  const etags = parseSweepEtags(sweep.source_etag);

  if (index === PLAYER_STATE_SCOPES.length) {
    const coherent = await revalidatePlayerStateScopes(env, etags);
    if (!coherent) {
      await safeFinishRun(env, Number(sweep.run_id), false, 0);
      return initializePlayerStateSweep(env, Date.now(), 'scheduled');
    }
    await safeFinishRun(env, Number(sweep.run_id), true, Number(sweep.seen_count));
    return { ok: true, complete: true, seen: Number(sweep.seen_count), processed: 0 };
  }

  const scope = PLAYER_STATE_SCOPES[index];
  const snapshot = await fetchPlayerScope(env, scope);
  const entries = Object.entries(snapshot.players || {}).sort(([a],[b]) => a.localeCompare(b));
  const eligibleIds = entries.filter(([,p]) => p?.position).map(([id]) => String(id));
  const existingRows = await loadExistingPlayerRows(env, eligibleIds);
  const persisted = await persistPlayerStateEntries(env, Number(sweep.started_at), entries, existingRows);

  etags[scope] = snapshot.sourceEtag;
  const nextIndex = index + 1;
  const checkpoint = await env.DB.prepare(`
    UPDATE player_state_sweeps
    SET next_index=?1,seen_count=seen_count+?2,source_etag=?3
    WHERE run_id=?4 AND next_index=?5
  `).bind(nextIndex, persisted.seen, JSON.stringify(etags), sweep.run_id, index).run();
  if (checkpoint?.success !== true || checkpoint.meta?.changes !== 1) {
    throw new Error('PLAYER_SWEEP_CHECKPOINT_FAILED');
  }

  return {
    ok: true,
    complete: false,
    scope,
    seen: Number(sweep.seen_count) + persisted.seen,
    changed: persisted.changed,
    processed: entries.length
  };
}

async function beginPlayerStateSweep(env, at = Date.now()) {
  const prior = await activePlayerStateSweep(env);
  if (prior) await safeFinishRun(env, Number(prior.run_id), false, 0);
  return initializePlayerStateSweep(env, at, 'scheduled');
}

async function continuePlayerStateSweep(env) {
  const sweep = await activePlayerStateSweep(env);
  if (!sweep) return { ok: true, idle: true };
  try {
    return await processPlayerStateSweepScope(env, sweep);
  } catch (error) {
    return rejectWorkFailure(env, Number(sweep.run_id), error);
  }
}

async function runPlayerState(env, at, source = 'internal') {
  const runId = await startRun(env, 'player_state', at, source);
  let result;

  try {
    const players = await api(env, '/players/nfl');

    // Bestehenden Zustand einmal gesammelt laden:
    // kein SELECT mehr pro Spieler.
    const existingResult = await env.DB
      .prepare('SELECT * FROM player_state')
      .all();

    const persisted = await persistPlayerStateEntries(env, at, Object.entries(players || {}), existingResult.results || []);
    result = { ok: true, captured_at: at, seen: persisted.seen, changed: persisted.changed };
  } catch (e) {
    return rejectWorkFailure(env, runId, e);
  }
  await safeFinishRun(env, runId, true, result.seen);
  return result;
}

function inferThesisLink(diffs) {
  if (diffs.injury_status || diffs.practice_participation) return 'availability_contingency';
  if (diffs.depth_chart_order) return 'role_access';
  if (diffs.team || diffs.position || diffs.status) return 'roster_context';
  return 'player_state';
}

const EVIDENCE_UPSERT_SQL = `
    INSERT INTO evidence_events(fingerprint,player_id,event_type,fundamental_or_market,occurred_at,first_seen_at,last_seen_at,source,original_source,authority,confidence,thesis_link,payload_json)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
    ON CONFLICT(fingerprint) DO UPDATE SET last_seen_at=excluded.last_seen_at
  `;

async function upsertEvidence(env, e, prepareEvidence = () => env.DB.prepare(EVIDENCE_UPSERT_SQL)) {
  const statement = await bindEvidence(prepareEvidence(), e);
  await statement.run();
}

async function bindEvidence(statement, e) {
  const fingerprint = await evidenceFingerprint(e);
  const payload = JSON.stringify(e.payload || {});
  return statement.bind(fingerprint,e.player_id||null,e.event_type,e.fundamental_or_market,e.occurred_at||null,e.first_seen_at,e.last_seen_at,e.source,e.original_source,e.authority,e.confidence,e.thesis_link||null,payload);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
}

async function evidenceFingerprint(e) {
  // Transition-aware market events retain one identity for a concrete episode and
  // level change. Legacy callers keep the hourly identity until the frame path fully
  // replaces the row-per-player deployment.
  const identity = e.fundamental_or_market === 'market'
    ? e.transition_key
      ? [e.player_id, e.event_type, e.transition_key, e.original_source]
      : [e.player_id, e.event_type, Math.floor(Number(e.occurred_at || e.first_seen_at) / HOUR), e.original_source]
    : [e.player_id, e.event_type, e.original_source, e.payload];
  return sha256(JSON.stringify(identity));
}

async function activeChunkedPlayerStateSweep(env) {
  return env.DB.prepare(`
    SELECT s.run_id,s.source_etag,s.total_entries,s.next_index,s.scope_offset,s.scope_etag,s.seen_count,s.started_at
    FROM player_state_sweeps s
    JOIN watcher_runs r ON r.id=s.run_id
    WHERE r.finished_at IS NULL
    ORDER BY s.run_id DESC
    LIMIT 1
  `).first();
}

async function initializeChunkedPlayerStateSweep(env, at, source = 'scheduled', existingRunId = null) {
  const runId = existingRunId ?? await startRun(env, 'player_state', at, source);
  try {
    const result = await env.DB.prepare(`
      INSERT INTO player_state_sweeps(
        run_id,source_etag,total_entries,next_index,scope_offset,scope_etag,seen_count,started_at
      ) VALUES(?1,?2,?3,0,0,NULL,0,?4)
    `).bind(runId, '{}', PLAYER_STATE_SCOPES.length, at).run();
    if (result?.success !== true || result.meta?.changes !== 1) throw new Error('PLAYER_SWEEP_INIT_FAILED');
  } catch (error) {
    return rejectWorkFailure(env, runId, error);
  }
  return processPlayerStateSweepChunk(env, {
    run_id: runId, source_etag: '{}', total_entries: PLAYER_STATE_SCOPES.length,
    next_index: 0, scope_offset: 0, scope_etag: null, seen_count: 0, started_at: at
  });
}

async function processPlayerStateSweepChunk(env, sweep) {
  const index = Number(sweep.next_index);
  const offset = Number(sweep.scope_offset || 0);
  if (!Number.isSafeInteger(index) || index < 0 || index > PLAYER_STATE_SCOPES.length ||
      !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('PLAYER_SWEEP_CURSOR_INVALID');
  }
  const etags = parseSweepEtags(sweep.source_etag);
  const baseContext = { run_id: Number(sweep.run_id), scope_index: index, player_offset: offset };

  if (index === PLAYER_STATE_SCOPES.length) {
    const coherent = await runPhase(env, 'player_state', 'source.revalidate', baseContext,
      () => revalidatePlayerStateScopes(env, etags));
    if (!coherent) {
      await safeFinishRun(env, Number(sweep.run_id), false, 0);
      return initializeChunkedPlayerStateSweep(env, Date.now(), 'scheduled');
    }
    await safeFinishRun(env, Number(sweep.run_id), true, Number(sweep.seen_count));
    return { ok: true, complete: true, seen: Number(sweep.seen_count), processed: 0 };
  }

  const scope = PLAYER_STATE_SCOPES[index];
  const snapshot = await runPhase(env, 'player_state', 'source.fetch', baseContext,
    () => fetchPlayerScope(env, scope));
  if (offset > 0 && String(sweep.scope_etag || '') !== snapshot.sourceEtag) {
    await safeFinishRun(env, Number(sweep.run_id), false, 0);
    return initializeChunkedPlayerStateSweep(env, Date.now(), 'scheduled');
  }

  const entries = Object.entries(snapshot.players || {})
    .filter(([, player]) => player?.position)
    .sort(([a],[b]) => a.localeCompare(b));
  if (offset > entries.length) throw new Error('PLAYER_SWEEP_OFFSET_INVALID');
  const chunkSize = clampInt(env.PLAYER_STATE_CHUNK_SIZE, 25, 50, 40);
  const chunk = entries.slice(offset, offset + chunkSize);
  const context = { ...baseContext, scope, chunk_size: chunk.length };
  const existingResult = await runPhase(env, 'player_state', 'state.load', context, async () => {
    if (!chunk.length) return { results: [], meta: { rows_read: 0, rows_written: 0 } };
    const ids = chunk.map(([id]) => String(id));
    const placeholders = ids.map((_, position) => `?${position + 1}`).join(',');
    return env.DB.prepare(`SELECT * FROM player_state WHERE player_id IN (${placeholders})`).bind(...ids).all();
  });
  const persisted = await persistPlayerStateEntries(
    env, Number(sweep.started_at), chunk, existingResult.results || [], context
  );

  const scopeComplete = offset + chunk.length >= entries.length;
  const nextIndex = scopeComplete ? index + 1 : index;
  const nextOffset = scopeComplete ? 0 : offset + chunk.length;
  if (scopeComplete) etags[scope] = snapshot.sourceEtag;
  const nextScopeEtag = scopeComplete ? null : snapshot.sourceEtag;
  await runPhase(env, 'player_state', 'checkpoint', context, async () => {
    const checkpoint = await env.DB.prepare(`
      UPDATE player_state_sweeps
      SET next_index=?1,scope_offset=?2,scope_etag=?3,
          seen_count=seen_count+?4,source_etag=?5
      WHERE run_id=?6 AND next_index=?7 AND scope_offset=?8
    `).bind(
      nextIndex, nextOffset, nextScopeEtag, persisted.seen, JSON.stringify(etags),
      sweep.run_id, index, offset
    ).run();
    if (checkpoint?.success !== true || checkpoint.meta?.changes !== 1) {
      throw new Error('PLAYER_SWEEP_CHECKPOINT_FAILED');
    }
    return checkpoint;
  });

  return {
    ok: true, complete: false, scope,
    scope_index: nextIndex, player_offset: nextOffset,
    seen: Number(sweep.seen_count) + persisted.seen,
    changed: persisted.changed, processed: chunk.length
  };
}

async function beginChunkedPlayerStateSweep(env, at = Date.now()) {
  const prior = await activeChunkedPlayerStateSweep(env);
  if (prior) await safeFinishRun(env, Number(prior.run_id), false, 0);
  return initializeChunkedPlayerStateSweep(env, at, 'scheduled');
}

async function continueChunkedPlayerStateSweep(env) {
  const sweep = await activeChunkedPlayerStateSweep(env);
  if (!sweep) return { ok: true, idle: true };
  try {
    return await processPlayerStateSweepChunk(env, sweep);
  } catch (error) {
    return rejectWorkFailure(env, Number(sweep.run_id), error);
  }
}

export { playerStateOf, trackedState, stateHash, inferThesisLink, marketSignals, marketTransitionPlan, evidenceFingerprint, depthChartOrderOf, normalizeRunType, normalizeRunSource, runsQuery, ownershipStatus, buildFreeAgencyRadar, resolveLeagueContext, previousTrendingSnapshotSql };
export { safeFinishRun, runTrending, runTrendingFrames, latestMarketFrameRows, runPlayerState, beginPlayerStateSweep, continuePlayerStateSweep, beginChunkedPlayerStateSweep, continueChunkedPlayerStateSweep, processPlayerStateSweepChunk };
