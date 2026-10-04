# Disposable local D1 outbox calibration

Local measurement only; no production activation, remote D1, sender, or reservation enforcement.

Canonical parent: `8574542ca506dd3729443f49c645e9c1e885180e`.
Runtime: Wrangler 4.28.1 / Miniflare 4.20250803.0, Node 24.19.0 on Windows.

Run with the repository's installed Wrangler, or provide an absolute path to a
Wrangler package.json installed in a disposable directory:

```sh
node tools/local-d1-outbox-calibration.mjs /path/to/wrangler/package.json
```

The harness uses Wrangler's SQL splitter and its Miniflare dependency. It creates
one nonpersistent local D1 instance, disables outbound requests and CF metadata
fetching, and never loads the repository Wrangler configuration or credentials.
Only watcher_runs, evidence_events, their existing indexes/observation column,
and the unchanged preview SQL are applied. Each case resets rows and sequences.
The preview remains outside migrations. No other database is opened.

These are D1 result metadata counters, not SQLite affected-row counts:
Miniflare obtains rows_read/rows_written from the workerd SQL cursor. Its
separate changes counter is not used for calibration. Query count is the number
of measured D1 statements. Setup, reset and verification queries are excluded.

| Case / statement | Queries | rows_read | rows_written | sql_ms |
| --- | ---: | ---: | ---: | ---: |
| 0: accepted finalization, no evidence | 1 | 3 | 2 | 1 |
| 1: new evidence insert | 1 | 2 | 6 | 0 |
| 1: accepted finalization | 1 | 8 | 5 | 0 |
| 2: first evidence insert | 1 | 2 | 6 | 0 |
| 2: second evidence insert | 1 | 3 | 6 | 0 |
| 2: third evidence insert | 1 | 3 | 6 | 0 |
| 2: duplicate fingerprint insert, DO NOTHING | 1 | 2 | 1 | 0 |
| 2: accepted finalization | 1 | 21 | 11 | 0 |

The final validation run returned 1 ms for Case 0 and zero for the other phases
at the available resolution; this is not a claim of zero CPU or a production
latency measurement. The initial run returned zero throughout. Durations vary on
reruns. Row counts are asserted and the summary preserves each measured phase.

Cases 0/1/2 produce exactly 0/1/3 pending outbox rows. Case 2 attempts the same
fingerprint twice and still has exactly three unique evidence/outbox rows.
The duplicate attempt costs one additional write, reported separately; it is
not a new evidence event and is excluded from the new-event estimate.

Finalization baseline = 2. Incremental outbox cost = 5 - 2 = 3.
New evidence plus outbox = 6 + 3 = **9** writes, without double-counting the
baseline. Case 2 confirms 11 - 2 = 9 = 3 x 3 incremental outbox writes, and
18 + 9 = 27 = 3 x 9 writes for three new events.

Decision: **CALIBRATION_PASS_RECALIBRATED_9**. The prior estimate 8 was not
conservative for these observations; 9 is the smallest integer covering the
measured new-event cost. Only evidenceWithOutbox changes. Other estimates,
apart from the separately reproduced runFinish correction below, remain provisional; this is not validation
of the entire budget model or authorization to activate enforcement.

On this host the sandbox prevented workerd startup. Running this same local-only
harness outside the sandbox succeeded. Startup/disposal failures report
CALIBRATION_INCONCLUSIVE and must never be treated as measurements.

Next gate: review this local measurement and estimate change before any separate
publication or rollout decision. Production validation/activation is out of scope.

## Reservation / settlement envelope — 2026-10-04

Canonical parent: `ee908689ac31e94b04e8fae4e61b3c07b8f2506b`.
Measured with cached Wrangler 4.143.0 / Miniflare 5.20260926.0-alpha, using its
exported `convertV4MiniflareOptions` adapter for the existing nonpersistent v4
configuration. No credentials, remote binding, metadata fetch or outbound network
is used by the harness. Setup/reset/verification and the simulated domain action
are excluded from control-phase measurements. SQL timing resolution is coarse;
zero is not a claim of zero CPU. The existing 0/1/3 evidence cases remain intact.

| Phase | Queries | rows_read | rows_written | sql_ms (final measurement) |
| --- | ---: | ---: | ---: | ---: |
| write_budget.reserve.first | 1 | 6 | 5 | 1 |
| write_budget.reserve.subsequent | 1 | 6 | 4 | 1 |
| write_budget.settle.full | 1 | 4 | 3 | 1 |
| write_budget.settle.partial | 1 | 4 | 3 | 0 |
| write_budget.abandon | 1 | 4 | 3 | 1 |
| zero-evidence accepted run finish | 1 | 3 | 2 | 1 |
| duplicate terminal operation (each) | 1 | 2 | 0 | 0–1 |

`runFinish` changes from 1 to 2, tied by an executable assertion to the actual
zero-evidence D1 metadata. Evidence insert 6 + incremental outbox 3 remains 9.
Duplicate fingerprint remains one extra write, not a new event. Three evidence
rows still yield three pending rows; finalization writes 11 = baseline 2 + 9.

The explicit `budgetControl` scope is one reserve plus ONE terminal operation:
settle OR abandon before any domain attempt. The estimate is per modeled plan,
not a daily or account-level reserve. Domain/evidence/outbox writes and
run.start/run.finish are separately counted by `estimateBillableWrites`.
Worst measured control envelope is 5 + 3 = 8; subsequent-window path is 4 + 3 = 7.
Keep 10: margin 2 on the first-window path. Reconciliation/retry writes after an
ambiguous result are NOT covered by an unlimited implicit envelope.

Real disposable D1 proves sequential and concurrent same-window exhaustion,
atomic config mismatch rejection, invalid limits, oversettlement rejection both
in the helper and persisted schema, and no double-release. Two simultaneous
requests of 6 against limit 10 admit exactly one. The caller test model refuses
abandon after a domain attempt and retains the reservation for reconciliation.
The low-level abandon helper itself cannot discover whether domain writes occurred;
that invariant must be enforced by a future reviewed caller, which is not added here.

Locally, a reservation sized with the estimator can include bounded control cost
before domain work; terminal operations do not require a new lane reservation.
Settlement's caller-supplied actual cost must include attributable reservation,
domain and settlement writes. This harness proves the cost envelope and atomic
ledger behavior, not a production billing integrator or automatic recovery.
External quota exhaustion may still reject all writes, including failure reporting.
Available Cloudflare allowance and approved account-level recovery capacity remain
UNKNOWN / AUTH_BLOCKED. No activation follows from this calibration.
