# PITTI CURRENT STATE

Updated: 2026-09-21
Production watcher version: v0.2.9 (`95ae7e6e-f282-4c55-bdb3-ca5bf7caed49`)
Feature candidate: v0.2.10 (`codex/watcher-p0-chunked-frames`)
Mode: POST_DRAFT / PRE_WEEK_1

## Source of truth

This file is the canonical PITTI project checkpoint for chat handoffs. The feature branch was created directly from canonical `origin/main@749ba52`. Commits through `3c41ca1` were deployed as v0.2.9 after the user selected `AUTO`; v0.2.10 is the local follow-up that freezes each mutable player scope before chunk processing.

## League / draft context

- Completed real draft ID: `1366053132970233856`
- User draft slot: `9`
- League format: 10 teams, Half-PPR.
- Starters: QB, 2 WR, RB, TE, 2 FLEX, K, DST. Bench 6.
- No regular QB2 roster strategy.
- K and DST were intentionally not drafted; both must be filled before Week 1.
- Current user-reported post-draft roster delta: Zach Charbonnet moved to reserve/IR and Tank Bigsby added. This must be verified from live Sleeper league state before being treated as machine-confirmed.

## Watcher architecture

### v0.1.5 baseline
- Sleeper global add/drop trending every 15 minutes.
- Player-state sweep daily at 04:17 UTC.
- Evidence for market acceleration/reversal and player-state changes.
- Companion feed health gate prevents stale/failed evidence from being treated as current.

### v0.2.x post-draft additions
- `/league-state` resolves live Sleeper league context.
- Draft ID + slot can resolve league ID, roster ID, and Sleeper user ID from Sleeper draft metadata.
- Live league sync returns rosters, users, ownership, reserve/taxi, starters and recent transactions.
- `/companion-feed` schema v2 integrates league ownership.
- Free-agency radar excludes players already owned by the user or opponents.
- Radar combines fundamental events and market signals and ranks only actual free-agent candidates.
- Fundamental change is intentionally weighted above market hype.
- Sleeper trending remains an alert signal, not an autonomous add/drop justification.

## Post-draft decision policy

For every candidate use:
1. Verify actual league availability.
2. Verify source/fundamental reason behind the signal.
3. Compare candidate against a concrete drop candidate on the current roster.
4. Prefer ceiling / contingent RB upside where expected value justifies it; do not optimize for shallow weekly floor by default.
5. Account for K/DST roster slots that still must be created before Week 1.
6. Reserve/IR players must not be counted as ordinary bench occupancy.
7. No roster move is executed automatically without explicit user approval.

Draft-only return probability, ADP-return logic and opponent pick prediction are no longer primary decision variables.

## Known hard constraints / retained strategy

- Geno Smith and Aaron Rodgers remain QB exclusions.
- No second QB as a normal roster construction choice.
- Weekly and pre-Week-1 workflow: free agents vs current roster, not generic best-available rankings.
- Manager profiles remain relevant for likely waiver competition / roster needs, not draft return modeling.
- Expert accuracy collection remains a future season-long project.

## AUTO behavior

`AUTO` / `AUTO BLOCK` means autonomous execution with no unnecessary status chatter, no empty messages, and no false “AUTO continues” messages that themselves stop execution. Continue until a real blocker, user action, material external commitment, or validated end state is reached.

## Cloudflare D1 rows_read correction

- The D1 database is directly bound to this watcher as `env.DB`; this corrects the earlier draft-companion-only audit that could not see the separate watcher repository.
- Root cause candidate with direct code evidence: the 15-minute `detectMarketEvents` path previously reconstructed each player's previous sample using `GROUP BY player_id, MAX(captured_at)` over the entire growing `trending_snapshots` history. That makes D1 rows_read grow with retained history on every scheduled poll.
- v0.2.3 replaces that historical per-player scan with one immediately preceding `captured_at` snapshot. Because every polling batch shares one timestamp, this preserves the intended comparison while bounding the previous-snapshot read to roughly one polling batch.
- An executable regression forbids GROUP BY/JOIN in the previous-snapshot query. No paid Cloudflare upgrade is required as a code remediation.
- The 2026-09-21 migration/index build plus earlier production traffic exhausted the Free-plan daily write allowance. D1 write recovery is expected at 00:00 UTC; reads and the last accepted data remain available.

## Current technical verification

- v0.2.3 source includes the bounded previous-snapshot D1 query and regression coverage.
- Unit tests exist in `test/core.test.js` for ownership filtering, free-agent radar prioritization, and market thresholds.
- Wrangler config now contains the completed draft ID and user draft slot so the worker can resolve the live league without hardcoding an unverified league ID.

## Next technical priorities

1. Keep v0.2.9 serving accepted market frames while the Free D1 write limit is closed; do not generate recovery writes before the 00:00 UTC reset.
2. Review and deploy v0.2.10 with additive migration `0004_player_state_scope_frames.sql` after reset, then verify that legacy run `3983` is failed and replaced by a fresh frozen-scope sweep.
3. Capture live steady-state phase metadata for one changed and one unchanged player chunk; use it to finish budget calibration.
4. Keep budget/outbox SQL in preview until reservation estimates and the pending limit are reviewed as a production migration.
5. Only after that, connect roster-relative add/drop scoring in the Companion UI.


## Cloudflare D1 v0.2.4 hardening
- Unchanged daily player-state observations are now write-free; successful watcher_runs provide liveness evidence.
- Trending history is bounded to the immediately previous capture plus current capture; historical snapshots are deleted before each new capture.
- Previous snapshot lookup uses ORDER BY captured_at DESC LIMIT 1 and the resolved timestamp is reused by market detection.
- Intended result: ~200 trending inserts per 15-minute run remain, but historical rows_read growth and thousands of unchanged player_state writes are eliminated.


## Cloudflare D1 v0.2.5 read hardening
- Post-v0.2.4 observation: 30-minute window showed only 4 rows_written but ~8k rows_read across 10 queries.
- This confirms the write amplification fix is effective while a read-amplified feed health query remains.
- companionFeed now probes only the newest scheduled trending/player-state run via reverse INTEGER PRIMARY KEY id instead of selecting/scanning up to 40 mixed run rows.
- No cron-frequency reduction; 15-minute market detection remains intact.

## 2026-09-21 live audit

- The pre-rollout baseline was `main@749ba52`, Worker `c04a4018-ab00-4023-b16b-08d403f4f2ac`, `/health` 0.2.8.
- Market is the dominant D1 write lane. The trailing-24-hour query attribution is recorded in `docs/LIVE_COST_ATTRIBUTION_2026-09-21.md`.
- A sampled market cron completed `ok` with 42 ms Worker CPU and 26,044 ms wall time.
- Migration `0003` is applied and production now serves v0.2.9, Worker `95ae7e6e-f282-4c55-bdb3-ca5bf7caed49`.
- Two v0.2.9 market runs finalized PASS with 183 and 181 players. The first bootstrap used 40,211 legacy reads; its invocation used 9 ms CPU / 3,522 ms wall and wrote a 22,423-byte frame. The second run consumed the compact baseline.
- The player-state lane remains live `FAIL`: run `3983` advanced once to RB offset 40, then the next invocation detected an ETag rotation. Its reset write was rejected because the account had exhausted the 100,000-row daily Free D1 write allowance. That invocation used 10 ms CPU / 12,381 ms wall, including 10,904 ms upstream fetch time.
- Lane isolation remains effective: the overall companion gate stays `PASS` from the healthy market lane while fundamental evidence from player-state is excluded.

## Write-budget and alert-outbox foundation

- `docs/sql/write_budget_alert_outbox_preview.sql`, `src/write-budget.js`, and the architecture document specify an atomic, fail-closed daily reservation model per lane plus a deduplicated internal alert outbox.
- The preview SQL is deliberately outside `migrations/`; the foundation is not production-deployed and is not wired into the active path. Enforcement requires shadow validation of the provisional billable-write estimates and an explicit activation change.
- The outbox has no delivery consumer. No external message source/destination and no automated fantasy transaction path were added.

## v0.2.10 frozen-scope follow-up

- Player state uses a persisted two-dimensional cursor (`next_index`, `scope_offset`) and processes 25–50 eligible players per invocation (configured default: 40).
- Each Sleeper position response is normalized once into one immutable, run-bound D1 frame (31–290 KB in the measured live source, below the 2 MB row limit). Later chunks read only that frozen frame, so a changing upstream ETag cannot create an endless reset loop.
- A pre-frame partial run is explicitly failed and replaced before new candidate work. Canonical state remains unchanged until every frozen scope is processed and the promotion batch succeeds.
- Structured phase markers cover source fetch/revalidation, canonical-state load, candidate staging, accepted promotion, evidence, and both observation/promotion checkpoints without logging payloads or bind values.
- Market polling writes one compact JSON frame per run, retains only current plus previous frame, and writes evidence only for `STARTED`, `LEVEL_UP`, and `ENDED` transitions.
- At 96 market polls/day, the steady snapshot/retention baseline drops from tens of thousands of row/index mutations to roughly 190 frame mutations/day plus run control and actual signal transitions. The `<10k/day` target is a design projection pending shadow measurement.
- `tools/inspect-live-schedules.mjs` was a temporary read-only audit helper, not a product or deployment artifact, and is intentionally absent.

### Coherence hardening after review

- Every compact market frame carries its `run_id`; readers and subsequent delta calculations consume only frames whose run is successfully finalized.
- Market signal episodes are embedded in the frame, so an incomplete invocation cannot mutate a separate global signal generation.
- New market and chunked player-state evidence carries `observation_run_id`. Feed reads admit only successfully finalized observations; nullable legacy evidence remains explicitly readable.
- Player-state observations stage changed rows and prepared transition evidence by run and do not mutate canonical hashes before all five frozen scopes complete. One set-based D1 batch then atomically promotes evidence and canonical state, finalizes the coherent run, and removes its candidates and scope frames; rejected candidates remain invisible. The promotion invocation uses eight explicit D1 statements including its active-run/count reads and frame cleanup, below the Free-plan limit of 50 queries per invocation. A worst-case 40-player chunk uses 44 queries.
- Production showed why even per-scope end revalidation is not viable with 5–15 minute continuation spacing: RB changed ETag after the first chunk and reset. Immutable run-bound scope frames preserve the exact observed generation without requiring the upstream response to remain static for hours.
- Player-state health exposes `latest_attempt`, `latest_accepted`, and `latest_completed_failure`. An open retry cannot mask a newer explicit failure; only a still newer accepted run clears it.
- v0.2.9 owns `/market` and `/events`: market reads only accepted compact frames and events read only accepted/legacy evidence. The legacy `/debug/run-trending` and `/debug/run-players` mutation paths return `410`; unknown inherited routes return `404`.
- The preview outbox trigger runs only when an observation run transitions to successful finalization. Open and failed evidence never becomes pending delivery.
- New fundamental evidence is deduplicated within its coherent observation run, while the same injury or role transition in a later run receives a new fingerprint and remains independently alertable.
- v0.2.9 matches the market cron explicitly; unknown future schedules are logged and ignored.

### Local Workerd rollout validation

- Wrangler 4.135.0 bundled the production entrypoint successfully and applied migrations `0001`–`0004` to a fresh isolated local D1 database.
- Real Workerd initially exposed an invalid module surface: string cron constants were exported as named Worker entrypoints. v0.2.9 now exports only its default Worker handler.
- The local market cron completed successfully against Sleeper and finalized an accepted compact frame with 184 players.
- A complete serial frozen-frame player-state run against Sleeper finalized `PASS` with 4,363 observed entries, promoted 4,354 unique canonical players atomically, and left zero staged candidates and zero scope frames.
- The bootstrap promotion reported 13,070 rows written; total measured bootstrap work remains roughly below 20,000 writes. Subsequent unchanged daily runs avoid candidate/canonical writes and retain only five frame inserts, bounded checkpoints, run control, and five frame deletions.
- An intentionally overlapping accelerated continuation attempt failed its cursor guard and remained fail-closed. Normal validation used non-overlapping invocations; production's shortest continuation interval is five minutes.
- Remote migration `0003` and v0.2.9 were deployed under `AUTO`. Migration `0004` and v0.2.10 remain local until the daily D1 quota resets. No external alert delivery or fantasy transaction was added.
