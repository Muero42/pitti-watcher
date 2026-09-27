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
including runFinish, remain provisional and unchanged; this is not validation
of the entire budget model or authorization to activate enforcement.

On this host the sandbox prevented workerd startup. Running this same local-only
harness outside the sandbox succeeded. Startup/disposal failures report
CALIBRATION_INCONCLUSIVE and must never be treated as measurements.

Next gate: review this local measurement and estimate change before any separate
publication or rollout decision. Production validation/activation is out of scope.
