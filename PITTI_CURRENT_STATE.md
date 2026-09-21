# PITTI CURRENT STATE

Updated: 2026-09-21
Production watcher version: v0.2.8
Feature candidate: v0.2.9 (`codex/watcher-p0-chunked-frames`)
Mode: POST_DRAFT / PRE_WEEK_1

## Source of truth

This file is the canonical PITTI project checkpoint for chat handoffs. The feature branch was created directly from canonical `origin/main@749ba52`; production remains unchanged until a separately authorized migration and deployment.

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
- D1 is already quota-blocked until the provider reset; service recovery before reset is not expected even after deployment.

## Current technical verification

- v0.2.3 source includes the bounded previous-snapshot D1 query and regression coverage.
- Unit tests exist in `test/core.test.js` for ownership filtering, free-agent radar prioritization, and market thresholds.
- Wrangler config now contains the completed draft ID and user draft slot so the worker can resolve the live league without hardcoding an unverified league ID.

## Next technical priorities

1. Review and merge the v0.2.9 P0 candidate; do not apply its migration or deploy without explicit authorization.
2. Apply migration `0003_chunked_player_state_and_market_frames.sql` in a non-production database and run the v0.2.9 scheduled paths there.
3. Shadow-measure phase-level D1 rows and invocation CPU; validate the projected market write reduction and player chunk headroom.
4. Calibrate write-budget multipliers and define the pending-outbox hard bound before promoting the preview SQL into a migration.
5. Verify `/league-state` and `/companion-feed` continue to resolve ownership and exclude owned candidates after the frame read-path switch.
6. Only after that, connect roster-relative add/drop scoring in the Companion UI.


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

- Canonical source is `main@749ba52`; production serves Worker version `c04a4018-ab00-4023-b16b-08d403f4f2ac` and `/health` reports `0.2.8`.
- Market is the dominant D1 write lane. The trailing-24-hour query attribution is recorded in `docs/LIVE_COST_ATTRIBUTION_2026-09-21.md`.
- A sampled market cron completed `ok` with 42 ms Worker CPU and 26,044 ms wall time.
- The market lane is live `PASS`. The player-state lane is live `FAIL`: sweep run `3983` remains open at scope cursor `1/5` with 477 seen players. The configured continuation cron is active, but the cursor has not advanced.
- Lane isolation remains effective: the overall companion gate stays `PASS` from the healthy market lane while fundamental evidence from player-state is excluded.

## Write-budget and alert-outbox foundation

- `docs/sql/write_budget_alert_outbox_preview.sql`, `src/write-budget.js`, and the architecture document specify an atomic, fail-closed daily reservation model per lane plus a deduplicated internal alert outbox.
- The preview SQL is deliberately outside `migrations/`; the foundation is not production-deployed and is not wired into the active path. Enforcement requires shadow validation of the provisional billable-write estimates and an explicit activation change.
- The outbox has no delivery consumer. No external message source/destination and no automated fantasy transaction path were added.

## v0.2.9 P0 candidate

- Player state uses a persisted two-dimensional cursor (`next_index`, `scope_offset`) and processes 25–50 eligible players per invocation (configured default: 40).
- A scope ETag is pinned across its chunks. Rotation fails the partial run and restarts from a fresh snapshot; a run becomes `PASS` only after all five scope ETags revalidate.
- Structured phase markers cover source fetch/revalidation, state load, evidence batch, state batch, and checkpoint without logging payloads or bind values.
- Market polling writes one compact JSON frame per run, retains only current plus previous frame, and writes evidence only for `STARTED`, `LEVEL_UP`, and `ENDED` transitions.
- At 96 market polls/day, the steady snapshot/retention baseline drops from tens of thousands of row/index mutations to roughly 190 frame mutations/day plus run control and actual signal transitions. The `<10k/day` target is a design projection pending shadow measurement.
- `tools/inspect-live-schedules.mjs` was a temporary read-only audit helper, not a product or deployment artifact, and is intentionally absent.

### Coherence hardening after review

- Every compact market frame carries its `run_id`; readers and subsequent delta calculations consume only frames whose run is successfully finalized.
- Market signal episodes are embedded in the frame, so an incomplete invocation cannot mutate a separate global signal generation.
- New market and chunked player-state evidence carries `observation_run_id`. Feed reads admit only successfully finalized observations; nullable legacy evidence remains explicitly readable.
- Player-state health exposes `latest_attempt` separately from `latest_accepted`. An open multi-hour sweep keeps a fresh accepted snapshot available, while a newer explicitly failed attempt still closes the lane.
- The preview outbox trigger runs only when an observation run transitions to successful finalization. Open and failed evidence never becomes pending delivery.
- v0.2.9 matches the market cron explicitly; unknown future schedules are logged and ignored.
