# News Bridge v1 readiness repair — local evidence, 2026-10-12

Verdict: **PASS_LOCAL_WITH_ACTIVATION_GATES**. Publication, migration application,
deployment and News activation were not performed. This document supersedes only
the readiness limitations addressed here; previous proof documents remain intact.

## Base and scope

Branch: `codex/watcher-news-readiness-repair-v1`, directly based on verified remote
main `59983889af7802f4791ce08f0ea2490e2b58e949`. The previous release/development
branches, untracked reports and logs were preserved. Exact final commit/tree and
test-log hashes are recorded in the local post-commit validation receipt.

Changed runtime: `src/news-source.js` and the accepted-snapshot cleanup statement
in `src/index.js`. No Market logic, schedule, Wrangler binding, activation flag,
Companion code, package version or budget/recovery implementation changed.

Additional files: migration `0006_news_retention_indexes.sql`; focused News tests,
snapshot fixture helper, the reduced real ESPN response fixture; the three affected
existing News/Player-State tests; an independent readiness copy of the offline
Companion matrix tool; this report and its two JSON evidence artifacts.

## Root causes and contracts

### ESPN URLs and per-article isolation

The original HTTPS-only check rejected genuine ESPN HTTP links and any rejection
aborted the entire run. The captured public NFL feed at
`2026-10-12T06:13:06.159Z` contains 50 articles and four HTTP NFL recap URLs.
The fixture retains only article identity, title, timestamps, URL and athlete tags;
it contains no invented historical news or copied article bodies.

Only `www.espn.com` and explicitly recognized NFL story/recap, fantasy-football
story and video-clip paths are allowed. Story/clip IDs must match the source
article ID. Recaps retain their numeric `gameId`, which is a different source
identity from the article ID. Credentials, foreign hosts, nonstandard ports,
unsupported schemes/routes and malformed URLs are rejected. HTTP upgrades to
HTTPS; fragments and unrelated query parameters are removed. No additional
article fetch, redirect following or source authority is inferred.

Invalid articles do not contaminate valid neighbours. Rejection/unmatched counts
and directory-run identity are persisted as `news.audit.v1` JSON in the News run's
existing `error` text field (also for accepted runs), and exposed as optional
`collectionAudit`. Consumers must interpret `ok`, not assume non-null `error`
always means failed execution. An entirely invalid nonempty response still fails.
In this fixture one betting route is rejected; two events match the Harrison test
player. They are unverified review hints, not confirmed news or recommendations.
HTTP and HTTPS variants normalize to the same fingerprint. Replay preserves the
original accepted owner, observation time and evidence row.

### Accepted Player-State coverage

`last_seen_at` changes only when canonical player state changes. It cannot prove
coverage of unchanged players. News now reads the latest accepted scheduled run,
validates its completed/sealed sweep, and loads its five frozen positional frames.
Acceptance atomically retains the current five frames and removes at most five
older accepted frame rows. No new per-player writes are introduced.

All scopes, counts, IDs, names, positions and timestamps are validated. Duplicate
IDs invalidate the snapshot; normalized name collisions cannot produce a guessed
mapping. A missing/incomplete/invalid latest accepted snapshot never falls back
silently. Its start must be within 36 hours. Open/failed newer attempts cannot
replace that still-valid accepted snapshot; a stale accepted snapshot blocks News.
Each frame retains the existing 1.5 MB bound. Concurrent replacement can cause a
conservative missing-frame failure, not acceptance of mixed-run frames.

Before/after local fixture: one unchanged player with a ten-day-old `last_seen_at`
was excluded before and is included now. A separate synthetic complete snapshot
returns all 4,364 players from five frames. This is not a measurement proving
Production coverage rose from 71 to 4,364; no Production database was accessed.

### Bounded News retention

Policy: keep at least **30 days of News evidence**, **90 days of completed News run
audit**, and all currently referenced/unresolved records. The 48-hour Companion
publication horizon remains unchanged. Historical audit within those windows is
preserved; this is explicitly not indefinite archival storage.

Each pass first selects at most 64 old News evidence candidates through a partial
index, then checks their last observation and accepted, completed News owner.
It selects at most 64 completed old News ledger candidates through another partial
index, then checks references and protects the latest run. Market/Player-State
evidence and runs are never retention targets. Open/orphaned or referenced runs
are not released by expiration alone. Evidence and ledger cleanup share a D1 batch.

The two indexes are the only migration changes; they do not backfill or mutate
non-News records. **Production application requires a separate authorization.**
Candidate limits precede reference checks, keeping work bounded even when records
are pinned. Pinned records may prevent draining a backlog; they are retained for
explicit reconciliation rather than skipped using an unbounded search. Therefore
this does not guarantee a hard total database-size ceiling.

Retention runs after successful and failed collection. Failure is returned/logged
as `NEWS_RETENTION_FAILED` and cannot revoke already committed accepted evidence.
Missing indexes are a retention failure, not permission to claim healthy cleanup.
The activation checklist must verify migration 0006 and successful cleanup first.

## Real local D1/workerd measurements

Source: `NEWS_READINESS_LOCAL_D1_COST.json`. These are actual local D1 metadata,
not mocked affected-row estimates or Production billing. Setup/migrations and
fixture writes are excluded from the named operation measurements.

| Operation | Statements | rows_read | rows_written | affected rows |
| --- | ---: | ---: | ---: | ---: |
| Directory, with one newer failed run | 2 | 8 | 0 | 0 |
| Collect one new event + one rejected neighbour, including empty retention | 7 | 19 | 12 | 3 |
| Identical replay, including empty retention | 7 | 19 | 6 | 2 |
| Retire 64 expired evidence rows (two deterministic passes) | 2 | 325 | 64 | 64 |
| Repeated drained retention, pinned rows remain | 2 | 9 | 0 | 0 |
| Ledger cleanup, 63 eligible of 64 candidates | 2 | 322 | 63 | 63 |
| Source failure plus cleanup of remaining old ledgers | 4 | 46 | 12 | 9 |
| Unchanged-player promotion + previous frame cleanup | 7 | 37 | 7 | 7 |
| Repeated accepted-directory read | 2 | 7 | 0 | 0 |
| Directory containing 4,364 synthetic players | 2 | 7 | 0 | 0 |

The seven writes in promotion are run/sweep bookkeeping and old frame deletion;
canonical `player_state` is asserted byte-for-byte unchanged. Seven database rows
read do not mean seven player objects parsed; frame JSON CPU/bytes still scale with
the player count. Actual Production News cost and daily duplicate frequency remain
unknown. No daily savings, account-plan verification or quota guarantee is claimed.

## Validation on final implementation bytes

- Focused Watcher/News/Player-State/Market/coherence tests: **27/27 PASS**.
- Offline real-D1 + Chromium Companion matrix: **18/18 PASS**, against exact
  Companion `670e0745a72e9b1acf38d2151928f0e73f7d1e7b` (rc4.234), with the reviewed
  rc4.233 rollback floor. Runtime Git blob identities are in
  `NEWS_READINESS_COMPANION_MATRIX.json`.
- `npm test`: **215/215 PASS**, executed once after the final focused pass.
- `npm run test:syntax`: **PASS**, executed once; News module and new matrix tool
  also checked explicitly. `git diff --check`: PASS.
- Final diff review: changes limited to the three proven blockers and their direct
  contracts. Review caught and corrected missing-latest-sweep fallback, a null
  category abort, and cleanup omission on failed collection before the final suite.

The prior tests expecting immediate removal of the accepted frames now assert
their retention. Existing atomic promotion, failed-batch rollback, evidence
isolation and unchanged-player assertions remain, with additional real-workerd
rollback/preservation coverage. No earlier test proof is relabelled as current.
Initial sandbox workerd startup failed; the same offline tests were then run with
the required local process permission. Early fixture/parser failures were repaired
before the final focused/full passes; their intermediate logs are not PASS evidence.

Reproduce focused tests with `PITTI_LOCAL_D1_PACKAGE` pointing to the existing local
Wrangler package; optionally set `PITTI_NEWS_COST_REPORT` to an output JSON path:

```powershell
node --test test/news-readiness.test.js test/news-source.test.js test/player-state-chunks.test.js test/chunked-promotion-sqlite.test.js test/bounded-market-retention.test.js test/coherence.test.js
node tools/news-readiness-matrix.mjs C:/Users/timmu/Documents/PITTI-Codex <wrangler/package.json> <report.json>
npm.cmd test
npm.cmd run test:syntax
```

## Remaining gates and limitations

1. Authorize publication of the exact local candidate; News stays OFF.
2. Separately authorize index migration and deployment. Wait for a **new complete
   accepted Player-State sweep** under the repaired runtime: pre-repair accepted
   frames were deleted and cannot be reconstructed from change timestamps.
3. Confirm the protected Companion artifact and rollback floor. Never fall back
   to the known unsafe old Companion when cached News exists. Disabling News
   preserves retained history; no cache clearing is part of rollback.
4. Before activation, check total invocation query/CPU headroom and observed D1
   consumption with Market sharing resources. News uses `N + 6` SQL statements
   per successful run for N normalized events (maximum 50); this is not a certified
   Free-plan resource envelope. Retention can add up to 128 row deletions per pass.
5. Separately authorize a short genuine-event canary through the open Companion.
   The local browser proof is synthetic. It proves automatic visibility of a count
   of unverified review hints, not a delivered real event, article card, Add/Drop
   recommendation, closed-app push or comprehensive/earliest news coverage.

Next gate: **NEWS_BRIDGE_V1_READINESS_REPAIR_LOCAL_PUBLICATION_REVIEW**.
No push, PR, merge, deployment, News/Outbox/Push activation or Production D1
mutation belongs to this completed local work package.
