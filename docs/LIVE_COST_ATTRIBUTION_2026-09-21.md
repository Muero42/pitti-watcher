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
