const HOUR = 3600_000;
const DAY = 24 * HOUR;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'pitti-watcher', version: '0.1.2', at: Date.now() });
    const auth = requireWatcherToken(request, env);
    if (auth) return auth;
    if (url.pathname === '/events') {
      const limit = clampInt(url.searchParams.get('limit'), 1, 100, 30);
      const rows = await env.DB.prepare(`SELECT id,player_id,event_type,fundamental_or_market,occurred_at,first_seen_at,last_seen_at,source,authority,confidence,thesis_link,payload_json FROM evidence_events ORDER BY first_seen_at DESC LIMIT ?1`).bind(limit).all();
      return json(rows.results || []);
    }
    if (url.pathname === '/runs') {
      const rows = await env.DB.prepare(`SELECT * FROM watcher_runs ORDER BY started_at DESC LIMIT 30`).all();
      return json(rows.results || []);
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
      const out = await runTrending(env, Date.now());
      return json(out);
    }
    if (url.pathname === '/debug/run-players') {
      const out = await runPlayerState(env, Date.now());
      return json(out);
    }
    return json({ ok: true, endpoints: ['/health','/events','/runs','/market','/debug/run-trending','/debug/run-players'] });
  },

  async scheduled(controller, env, ctx) {
    const cron = controller.cron || '';
    const at = Date.now();
    if (cron === '17 4 * * *') {
      ctx.waitUntil(runPlayerState(env, at));
      return;
    }
    ctx.waitUntil(runTrending(env, at));
  }
};

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

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function api(env, path) {
  const base = env.SLEEPER_BASE || 'https://api.sleeper.app/v1';
  const r = await fetch(base + path, { headers: { 'user-agent': 'PittiWatcher/0.1.2' } });
  if (!r.ok) throw new Error(`Sleeper ${path}: HTTP ${r.status}`);
  return r.json();
}

async function startRun(env, type, at) {
  const x = await env.DB.prepare(`INSERT INTO watcher_runs(run_type,started_at) VALUES(?1,?2) RETURNING id`).bind(type, at).first();
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

async function runTrending(env, at) {
  const runId = await startRun(env, 'trending', at);
  try {
    const limit = clampInt(env.TREND_LIMIT, 20, 1000, 200);
    const [a1,a3,a6,a24,d1,d6,d24] = await Promise.all([
      trendingWindow(env,'add',1,limit), trendingWindow(env,'add',3,limit), trendingWindow(env,'add',6,limit), trendingWindow(env,'add',24,limit),
      trendingWindow(env,'drop',1,limit), trendingWindow(env,'drop',6,limit), trendingWindow(env,'drop',24,limit)
    ]);
    const ids = new Set([...a1.keys(),...a3.keys(),...a6.keys(),...a24.keys(),...d1.keys(),...d6.keys(),...d24.keys()]);
    const stmt = env.DB.prepare(`INSERT INTO trending_snapshots(captured_at,player_id,adds_1h,adds_3h,adds_6h,adds_24h,drops_1h,drops_6h,drops_24h) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`);
    const batch = [];
    for (const id of ids) batch.push(stmt.bind(at,id,a1.get(id)||0,a3.get(id)||0,a6.get(id)||0,a24.get(id)||0,d1.get(id)||0,d6.get(id)||0,d24.get(id)||0));
    if (batch.length) await env.DB.batch(batch);
    await detectMarketEvents(env, at);
    await finishRun(env, runId, true, ids.size);
    return { ok: true, captured_at: at, players: ids.size };
  } catch (e) {
    await finishRun(env, runId, false, 0, String(e?.message || e));
    throw e;
  }
}

async function detectMarketEvents(env, at) {
  const current = await env.DB.prepare(`SELECT * FROM trending_snapshots WHERE captured_at=?1`).bind(at).all();
  for (const row of current.results || []) {
    const prev = await env.DB.prepare(`SELECT * FROM trending_snapshots WHERE player_id=?1 AND captured_at<?2 ORDER BY captured_at DESC LIMIT 1`).bind(row.player_id, at).first();
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

async function runPlayerState(env, at) {
  const runId = await startRun(env, 'player_state', at);
  try {
    const players = await api(env, '/players/nfl');
    let changed = 0, seen = 0;
    for (const [id,p] of Object.entries(players || {})) {
      if (!p || !p.position) continue;
      seen++;
      const s = playerStateOf(p), hash = stateHash(s);
      const old = await env.DB.prepare(`SELECT * FROM player_state WHERE player_id=?1`).bind(id).first();
      if (!old) {
        await env.DB.prepare(`INSERT INTO player_state(player_id,full_name,team,position,injury_status,practice_participation,depth_chart_order,status,first_seen_at,last_seen_at,state_hash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`)
          .bind(id,s.full_name,s.team,s.position,s.injury_status,s.practice_participation,s.depth_chart_order,s.status,at,at,hash).run();
        continue;
      }
      if (old.state_hash === hash) {
        await env.DB.prepare(`UPDATE player_state SET last_seen_at=?1 WHERE player_id=?2`).bind(at,id).run();
        continue;
      }
      changed++;
      const diffs = {};
      for (const k of ['team','position','injury_status','practice_participation','depth_chart_order','status']) {
        const before = old[k] ?? null, after = s[k] ?? null;
        if (String(before) !== String(after)) diffs[k] = { before, after };
      }
      await env.DB.prepare(`UPDATE player_state SET full_name=?1,team=?2,position=?3,injury_status=?4,practice_participation=?5,depth_chart_order=?6,status=?7,last_seen_at=?8,state_hash=?9 WHERE player_id=?10`)
        .bind(s.full_name,s.team,s.position,s.injury_status,s.practice_participation,s.depth_chart_order,s.status,at,hash,id).run();
      await upsertEvidence(env, {
        player_id: id, event_type: 'PLAYER_STATE_CHANGED', fundamental_or_market: 'fundamental', occurred_at: at,
        first_seen_at: at, last_seen_at: at, source: 'Sleeper Player Data', original_source: 'Sleeper Player Data', authority: 0.75, confidence: 0.8,
        thesis_link: inferThesisLink(diffs), payload: { player: s.full_name, team: s.team, position: s.position, diffs }
      });
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

export { playerStateOf, trackedState, stateHash, inferThesisLink, marketSignals, evidenceFingerprint, depthChartOrderOf };
