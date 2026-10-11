# Bounded Market retention: local implementation

Base: a48e1e1a51dc9cc406b72934817b9cc2a4d6779f.
Branch: codex/watcher-write-budget-enforcement-v1.

The active Market prune formerly deleted every frame older than the preceding
accepted capture in one statement. A backlog of failed completed runs could
therefore produce an arbitrarily large deletion burst on a healthy invocation.

The same DELETE now selects at most 64 oldest eligible captured_at keys, joined
to watcher_runs with finished_at IS NOT NULL, below the existing cutoff. Selection
and deletion occur in one SQL statement. The cap reuses the earlier offline
Market-plan design's 64-target bound, without importing its budget machinery.
Completed successes and failures can be pruned; open runs cannot. The preceding
accepted frame and new frame remain protected by the strict cutoff. A normal
successful sequence still retains its last two frames. Historical proofs are
preserved; this report supersedes only the old active unbounded-prune observation.

This is a per-invocation ROW-DELETION bound, not a D1 billing certificate or global
daily budget. Index-related writes, other phases and concurrent invocations are
not covered by a hard 64-write claim. No daily net saving is asserted: the same
completed backlog is removed over more runs. An unchanged 15-minute cadence gives
96 nominal opportunities, but failures, concurrency and new frames affect draining.

Residual tradeoff: open/orphaned frames remain until their runs are finalized.
Many old open rows can increase scan/read cost; LIMIT bounds deleted rows, not
rows read or runtime. This change does not repair orphaned runs or grant cleanup
permission based solely on age. Retention errors still fail the run through the
existing path. No retry, scheduling, evidence, run-finalization or feed change.

Validation:
- Focused tests: 67/67 PASS. Actual SQLite tests use active migrations and the exact
  active DELETE: 3/72001 backlogs; deterministic oldest-first drain; open/current
  protection; completed failed/successful rows; injected trigger rollback; and
  eligibility after a formerly open run closes.
- Existing Market/finalization regressions preserve transitions, accepted-frame
  visibility, ledger behavior and feed timestamps.
- These new tests establish SQL cardinality/transaction behavior, not new workerd
  rows_written measurements. Existing local D1 proofs run in the required suite.

Rollback: restore the prior DELETE via a normal follow-up commit; no data format
or schema reversal is needed. Deleted history is not recovered by code rollback.
Before deploying a rollback, check accumulated backlog because the old SQL can
again delete it all at once. No rollback or deployment occurs in this task.

No migration, budget activation, outbox, alerts, version bump, push or deployment.
Previous Budget/Market/Recovery proofs and September reports are preserved.
Next safe gate: BOUNDED_MARKET_RETENTION_LOCAL_REVIEW; production publication and
deployment remain separate, explicitly authorized steps.

Final validation: complete suite run once on final implementation bytes:
230/230 PASS, no skips. npm run test:syntax run once: PASS. Final diff review
confirms only the active retention DELETE, corresponding regression fixtures and
this report changed. September report hashes remain unchanged. No new production
cost measurement is claimed. The earlier unbounded characterization was replaced
with stricter bounded-retention regressions, not simply removed.
