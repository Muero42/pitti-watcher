# Player-State invocation interval ledger

Local shadow-only candidate on top of calibration commit
`c7528016fd2baae6ed30069a19b7fe94a2a6ac13`. Not deployed or migrated remotely.
No budget enforcement, outbox or sender activation.

## Evidence and semantics

Migration 0005 adds only `player_state_invocations`, with a UUID primary key
and a start-time retention index. Each natural daily-start or continuation
scheduled invocation (including idle calls and promotion) gets its own row.
Actual `Date.now()` start and core completion are separate from nominal
`controller.scheduledTime`. Trigger kind is a fixed daily_start/continuation
value; no arbitrary cron or exception is stored. Run ID and entry cursor are
passed from the existing core path, including replacement of a legacy sweep.
Failure persists only `PLAYER_STATE_WORK_FAILED`.

Start is inserted before core work; finish updates exactly that UUID while
open. Duplicate finalization cannot overwrite a closed row or another
invocation. Platform retries have distinct UUIDs. Failed finish leaves an open
row. Lost start acknowledgements can also leave an open row. Fixed diagnostic
codes distinguish start, finish and retention failures without exposing errors.
All ledger operations are best effort; core results and exception identity
are preserved. No persistent phase telemetry is added.

Daily-start retention runs after ledger start and before core work, deleting
at most 512 rows older than seven days, including stale open rows. No retention
query runs in a continuation. At the configured 265 Player-State schedule
opportunities/day, the cap exceeds steady-state expiry; nominal history is
about 1,855 rows. Excess retries or missed daily cleanup can leave a backlog,
which drains by bounded subsequent daily cleanups. This is a rolling retention
policy, not an absolute row-count cap.

## Disposable local D1 calibration

Command: `node tools/local-d1-invocation-ledger-calibration.mjs <wrangler/package.json>`.
Wrangler 4.143.0 / Miniflare 5.20260926.0-alpha; real local D1 metadata,
not SQLite affected rows. In-memory disposable binding, outbound network disabled,
no repository Wrangler configuration, credentials or remote database.

| Operation | Queries | Rows read | Rows written | sql_ms |
| --- | ---: | ---: | ---: | ---: |
| Start | 1 | 1 | 3 | 2 |
| Finish ok | 1 | 2 | 1 | 2 |
| Finish fail | 1 | 2 | 1 | 0 |
| Duplicate finish | 1 | 1 | 0 | 1 |
| Empty retention | 1 | 3 | 0 | 2 |
| Retention one row | 1 | 5 | 1 | 0 |
| Retention cap (513 eligible rows) | 1 | 2,562 | 512 | 2 |

Local interval overhead: **4 writes/invocation**, plus retention measured at
one write/deleted row, bounded to **512 additional writes per daily start**.
Nominal schedule-only daily scenario: 265 * 4 + 512 = **1,572 writes** with
maximum cleanup; steady-state amortized cost is five writes/invocation.
These are fixture measurements/scenarios, not Production billing or retry bounds.
Existing runFinish=2, budgetControl=10 and evidenceWithOutbox=9 are unchanged.

## Attribution proof and limits

Synthetic GraphQL-like minute buckets contain 96 actual Market intervals,
a daily Player-State start and continuation intervals at the existing cadence.
Single-lane overlap attributes to that lane. Cross-minute execution is included;
true cross-lane overlap stays UNKNOWN. Without continuation intervals the same
Player-State minute is UNKNOWN. Cron strings never establish an interval.

Intervals close the specific missing-continuation-timing gap; they do not prove
100% future billing attribution. Open/missing ledger rows, unrelated D1 writers,
and actual overlaps remain UNKNOWN. `finished_at` is the timestamp after core
work, immediately before the final ledger UPDATE; its own query completion is
not a persisted upper bound. A possible finish-write tail across a minute
boundary must remain UNKNOWN in a real audit, as must any uncertain ledger
acknowledgement. Retention is inside the recorded work interval. Do not treat
an open row as continuous confirmed work until the next daily sweep.

Historical October 1–3 gaps are not backfilled. Future sufficiency requires an
explicitly authorized migration/deployment gate followed by complete observed
UTC days, reconciliation, ledger diagnostics and spillover checks. Account plan
remains UNKNOWN. No activation decision follows from this local package.
