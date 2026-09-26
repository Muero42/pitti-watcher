# Live Watcher health and cost attribution — 2026-09-21

Observation window: Cloudflare D1 Insights, trailing 24 hours; live endpoints and tail sampled around 07:08–07:15 UTC.
Production deployment: Worker version `c04a4018-ab00-4023-b16b-08d403f4f2ac`, deployed 2026-09-19 15:51:54 UTC.
Source at audit: canonical `main` `749ba52`, package/health version `0.2.8`.

## Live health

- `/health`: HTTP 200, `ok=true`, version `0.2.8`.
- `/companion-feed`: HTTP 200, schema v2, overall `PASS`.
- Market lane: `PASS`; latest run completed with 185 items.
- Player-state lane: `FAIL`; latest scheduled sweep was open (`finished_at=null`, `ok=false`, zero finalized items) during the observation.
- Lane isolation behaved as designed: the healthy market lane remained available while fundamental evidence from the failed player-state lane was excluded.
- League state resolved successfully; the feed exposed 50 free-agent candidates and 50 market rows at the sample time.

## D1 totals

- Database size: 92,868,608 bytes.
- 24-hour database totals reported by `wrangler d1 info`: 287 read queries, 25,208 write queries, 93,082 rows read, 88,111 rows written.
- Insights groups can cross slightly different rolling aggregation boundaries than the info summary, so grouped values below are attribution evidence, not an independently summed billing total.

## Query and lane attribution

| Lane | Query family | Executions | Rows read | Rows written | D1 SQL time |
| --- | ---: | ---: | ---: | ---: | ---: |
| market | snapshot insert | 15,535 | 0 | 46,605 | 2,284.7 ms |
| market | market evidence upsert | 8,942 | 22,505 | 30,847 | 5,981.2 ms |
| market | bounded retention delete | 204 | 81,600 | 20,400 | 491.6 ms |
| market | current snapshot read | 241 | 43,021 | 0 | 248.0 ms |
| market | previous snapshot read | 94 | 16,520 | 0 | 70.1 ms |
| market | previous capture probe | 112 | 112 | 0 | 64.1 ms |
| shared/control | run finalize | 107 | 107 | 107 | 46.2 ms |
| shared/control | run start | 50 | 100 | 100 | 39.0 ms |
| player_state | 100-ID state load | 4 | 800 | 0 | 24.3 ms |
| player_state | changed state update | 12 | 12 | 12 | 0.8 ms |

The market lane is the write driver. Snapshot rows, evidence upserts, and retention deletes account for essentially all observed domain writes. Player-state canonical writes were low; its operational problem during the sample was completion/CPU, not write amplification.

## CPU attribution

- Market scheduled invocation (`*/15 * * * *`): 42 ms Worker CPU, 26,044 ms wall time, outcome `ok`, not truncated.
- D1 SQL time is database execution time and is not Worker CPU. Network and D1 wait time explain much of the gap between 42 ms CPU and 26 seconds wall time.
- A fresh player-state CPU sample was not emitted during the bounded tail window. The lane was therefore not assigned a fabricated CPU number; its live status is recorded as failed/open and requires a later continuation-cron tail sample after instrumentation.

## Immediate conclusions

1. Budget market writes first; it dominates current D1 usage.
2. Attribute run-control writes separately so failure reporting remains possible after a lane budget closes.
3. Keep CPU and D1 SQL duration separate. Per-query CPU does not exist as a D1 metric; per-query rows and SQL duration plus invocation-level Worker CPU are the defensible attribution boundary.
4. Do not attach an external sender to the outbox until reservation enforcement and deduplication have been validated in production-like traffic.

## v0.2.9 rollout observation (13:20–13:52 UTC)

- Migration `0003` and Worker version `95ae7e6e-f282-4c55-bdb3-ca5bf7caed49` deployed successfully; `/health` reported 0.2.9.
- Market run `4020`: 183 players, accepted compact frame, 9 ms Worker CPU, 3,522 ms wall. The first compact run performed a one-time legacy bootstrap read of 40,211 rows; frame insert was one query with 2 rows read / 2 rows written.
- Market run `4021`: 181 players and a second accepted compact frame. The companion feed returned 50 compact market rows and selected `4021` as both latest attempt and latest accepted run.
- Player continuation for run `3983`: 10 ms Worker CPU, 12,381 ms wall; source fetch consumed 10,904 ms. The upstream RB ETag rotated after offset 40, and the fail-closed scope reset was attempted.
- D1 rejected that reset with `YOUR_ACCOUNT_HAS_EXCEEDED_D1_S_FREE_TIER_DAILY_ROW_WRITES`. No canonical promotion occurred. Free D1 allows 100,000 written rows/day and resets at 00:00 UTC.
- The quota exhaustion happened after earlier traffic plus the migration/index build. DDL can contribute read/write rows; therefore production migrations require their own control-plane reserve and must not share the lane budget blindly.

## v0.2.10 frozen-scope calibration

- Live source sizes after normalization: QB 76,818 bytes / 477 players; RB 170,075 / 1,049; WR 290,271 / 1,792; TE 137,381 / 849; K 31,396 / 196. Each immutable scope frame is safely below D1's 2 MB row limit.
- A fresh serial Workerd run against the real Sleeper sources accepted 4,363 observations and atomically promoted 4,354 unique players. Candidate and scope-frame tables were empty afterward.
- Worst-case 40-player bootstrap chunk: frame load 1 query/1 row read; state load 1 query/40 rows read; candidate batch 40 queries/80 rows read/40 rows written; checkpoint 1 query/1 row read/1 row written. Including the active-sweep lookup, this stays at 44 D1 queries, below the Free-plan 50-query invocation cap.
- Bootstrap promotion: 6 batched statements, 17,434 rows read, 13,070 rows written, 8 ms D1 SQL time, 21 ms local wall. This is the expensive first-fill case; unchanged steady-state chunks produce no candidate writes.

## v0.2.10 production rollout — 2026-09-22

- Additive migration `0004_player_state_scope_frames.sql` applied remotely with no other pending migration. Worker `0f495bd6-f72b-4451-8d39-714bc64f0864` serves `/health` version 0.2.10.
- Market run `4086` finalized accepted with 182 players: 22 ms Worker CPU, 740 ms wall, and the following logged D1 phase totals:

| Lane | Phase | Queries | Rows read | Rows written | D1 SQL time | Phase wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| market | state.load | 1 | 4,090 | 0 | 1.6159 ms | 24 ms |
| market | frame.insert | 1 | 2 | 2 | 0.3114 ms | 34 ms |
| market | evidence.batch | 200 | 600 | 1,200 | 88.2338 ms | 284 ms |
| market | retention.prune | 1 | 3 | 1 | 0.3325 ms | 33 ms |
| market | **logged total** | **203** | **4,695** | **1,203** | **90.4936 ms** | **375 ms** |

- The v0.2.10 player initialization closed pre-frame partial run `4080` as `WORK_FAILED`, created run `4087`, and captured its immutable QB frame: 15 ms Worker CPU, 504 ms wall. Logged D1 phases totalled 4 queries, 3 reads, 1 write, 4.4716 ms SQL time, and 129 ms phase wall; source fetch added 146 ms wall without D1 work.
- The observed 40-player QB chunk at offset 120 used 4 ms Worker CPU / 246 ms wall:

| Lane | Phase | Queries | Rows read | Rows written | D1 SQL time | Phase wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| player_state | scope.frame.load | 1 | 1 | 0 | 1.1596 ms | 32 ms |
| player_state | state.load | 1 | 80 | 0 | 2.8446 ms | 28 ms |
| player_state | candidate.batch | 1 | 2 | 1 | 0.4938 ms | 34 ms |
| player_state | checkpoint | 1 | 1 | 1 | 0.3057 ms | 31 ms |
| player_state | **logged total** | **4** | **84** | **2** | **4.8037 ms** | **125 ms** |

- After the chunk, run `4087` was open at QB offset/seen count 160, its 477-player/76,826-byte frame retained the capture ETag, and 16 candidates were staged. No candidate was visible as accepted canonical state. Companion remained overall `PASS` through the market lane while player-state remained fail-closed.
- D1 phase metadata is attributable per query family; Worker CPU remains invocation-level and must not be fabricated per individual D1 query.

## Full live sweep acceptance — 2026-09-23

Run `4087` finalized successfully at `2026-09-23T01:07:58.606Z` with 4,363 observations across all five scopes. Read-only verification found zero candidates and zero frames for this run. Companion selected it as the latest accepted player observation and reported market/player/overall `PASS`. Production promotion CPU, wall time and write metadata were not captured by this completion check and remain a calibration gap; the SELECT verification costs are not promotion costs.
