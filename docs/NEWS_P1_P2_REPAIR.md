# Targeted News P1/P2 repair — 2026-10-12

Result: **PASS_LOCAL**. Parent `ce809cd55b9b25dd19377da89620813a219f607c`,
parent tree `7308ecab706d3e77f223888f960b9b60a99c3790`, branch
`codex/watcher-news-readiness-repair-v1`. No publication or activation performed.
This report supersedes only the duplicate/scope assumptions in the earlier
readiness report; its other contracts and all historical artifacts are preserved.

## Reproduced baseline failures

Before modifying runtime code, the new regressions ran against the exact parent:
**0/2 PASS, both expected failures** (`news-p1p2-baseline.log`).

- **P1:** actual `beginChunkedPlayerStateSweep` / `continueChunkedPlayerStateSweep`
  with disposable local D1/workerd captured the same canonical WR in the QB and WR
  source responses, sealed and promoted the run successfully (`ok=1`,
  `item_count=2`). `newsPlayerDirectory` then threw `NEWS_PLAYER_SNAPSHOT_INVALID`.
- **P2:** an athlete category with `description: {toString: 0}` next to a valid
  article threw `TypeError: Cannot convert object to primitive value` in `nameKey`.

## P1 root cause and correction

Producer references: `src/index.js:1161` normalizes each returned source frame;
`:1235` counts every observation; `:1267` upserts candidates by `(run_id,player_id)`;
`:1425` accumulates observations in `seen_count`. Source scope is a requested
filter, not a guaranteed partition or a claim about the canonical `position`.
Promotion copies the observation count to the accepted run. The News reader
incorrectly required unique IDs across all frames, position equal to source scope,
and unique player count equal to the producer's observation count.

`src/news-source.js:38` now counts observations separately from unique identities.
Repeated IDs in different frames are allowed only when all persisted producer
fields agree: name, team, position, injury status, practice participation, depth
order and status. Comparison uses explicit fields in fixed order; absent nullable
fields normalize to null, matching producer representation. No contradictory
value is overwritten or chosen by frame order. Conflicts fail closed with
`NEWS_PLAYER_SNAPSHOT_CONFLICT`. Duplicate IDs within a single frame remain
invalid because the producer constructs each frame from unique object keys.
Output is sorted deterministically by player ID. Distinct IDs sharing a normalized
name still cannot produce an ambiguous article mapping.

Latest accepted run, five-frame completeness, count, timestamps and 36-hour
freshness checks remain. The existing partitioned 4,364-player fixture remains.
Open/failed runs cannot replace accepted coverage; stale or incomplete accepted
snapshots fail closed. The sweep, promotion, canonical storage and SQL are unchanged.

The actual producer regression also runs an unchanged repeat sweep with D1 triggers
that abort **any canonical player INSERT or UPDATE**. It passes and preserves the
canonical rows. A further real sweep with contradictory QB/WR observations is
accepted by the producer's existing UPSERT contract but deliberately rejected by
News. Separate identity, team, position and injury-conflict cases pass as well.

## P2 root cause and correction

`nameKey` previously called `String` on external category descriptions. Valid JSON
objects can make that coercion throw. A whole-source exception then prevented valid
neighbouring articles from being processed.

`src/news-source.js:4` no longer coerces non-string names. `:8` validates category
objects and optional descriptions; `:97` validates each article before matching.
Malformed consumed fields increment that article's existing rejection count and
do not discard valid neighbours. Headline, ID, timestamps, URL, category container,
category type and nested athlete description have targeted regressions, including
the exact reported payload. Missing optional categories/descriptions remain safe;
the valid nested athlete-description fallback is preserved.

Additional input bounds: at most 100 categories/article, 300 characters/description,
80 characters/category type, and either a safe nonnegative numeric article ID or
a 1–32 digit string. Existing headline, response, article-count, event-count and
timeout bounds remain. ESPN host/path/HTTPS validation is unchanged except that
article-ID type validation happens before any conversion. Invalid entire documents
and entirely invalid nonempty source runs remain fail-closed. Existing persisted
rejection audit and non-actionable News classification are unchanged.

## Final validation and costs

- Focused tests: **30/30 PASS** (new adversarial tests plus existing News readiness,
  URL, partitioned directory, retention, rollback, Player-State, Market/coherence).
- Actual unchanged Companion rc4.234 offline D1/Chromium matrix: **18/18 PASS**, with
  the existing protected rollback floor and unchanged News schema.
- Full required `npm test`: **218/218 PASS**, one run after final focused tests.
- `npm run test:syntax`: PASS; News module separately syntax-checked.
- Final diff review / `git diff --check`: PASS. Runtime change is only
  `src/news-source.js`; new files are the adversarial test and this report.

All 12 named real-local-D1 operation measurements match the prior committed report
exactly (statements, rows_read, rows_written, affected rows). For example: the
4,364-player directory remains 2 statements / 7 reads / 0 writes; new one-event
collection remains 19 reads / 12 writes, replay 19 reads / 6 writes. No SQL or
per-player writes were added. CPU impact of in-memory comparison/sorting was not
separately benchmarked; no Production billing or daily savings claim is made.

Local evidence (existing logs/reports were not overwritten):
`news-p1p2-baseline.log`, `news-p1p2-focused.log`, `news-p1p2-full-suite.log`,
`news-p1p2-syntax.log`, `news-p1p2-matrix.log`, `news-p1p2-d1-cost.json`,
`news-p1p2-companion-matrix.json`, `news-p1p2-validation-receipt.json`.
The receipt records their hashes and actual final Git identity. The matrix records
tested runtime blob identities, which must match the committed files.

## Remaining gate

**NEWS_BRIDGE_V1_P1_P2_LOCAL_PUBLICATION_REVIEW**.

Publication, index migration 0006, deployment and activation remain separately
authorized steps. Before News activation: obtain a fresh complete accepted snapshot
with retained frames, verify the protected Companion artifact/rollback floor,
verify shared invocation/D1 resource headroom and then authorize a real-event canary.
Historical conflicts block News instead of being silently resolved. The offline
browser test is synthetic, not a real delivered event, Add/Drop recommendation or
closed-app push. No Production D1 mutation, new migration, schedule change,
Outbox/Push activation or budget-enforcement work was performed in this repair.
