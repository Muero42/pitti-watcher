# Write-budget / internal outbox activation readiness

Decision: **NOT_READY — activation remains disabled.**
Reviewed canonical main: `38e44ed5346bc44c0539cb41bca5a64f8920ad77`.
This candidate hardens the inactive d1Usage helper. It changes no active Worker runtime, configuration, estimates,
schema, migration, reservation enforcement or delivery behavior.

## Evidence and its limits

The task supplied the following production observation for successful
Player-State run 4566. These values were not independently fetched in this local
review. The supplied correlation states both events share requestId, traceId,
script version and scheduled invocation; those identifiers were not supplied.

| Phase | State | Queries | Rows read | Rows written | SQL ms | Wall ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| promotion.load | ok | 1 | 52 | 0 | 0.5473 | 100 |
| promotion.commit | ok | 6 | 332 | 372 | 20.4866 | 190 |

This closes the latest successful promotion's metadata gap. It does not measure
the full sweep, daily lane totals, event arrival peaks, or production outbox
cost. Rows read by COUNT are not the returned candidate count. The six-statement
aggregate cannot identify how many of its writes were new evidence events.
SQL time and wall time are not Worker CPU.

[Local D1 calibration](LOCAL_D1_OUTBOX_CALIBRATION.md) supports the existing
evidenceWithOutbox value 9: six writes per new evidence row plus three
incremental outbox writes, excluding the two-write finalization baseline.
The three-event fixture verifies scaling and duplicate-fingerprint behavior.
It does not establish all reservation/control costs or daily limits. In
particular, runFinish remains a provisional estimate of 1 while that local
fixture measured a baseline of 2; budgetControl headroom must be attributed
and validated rather than assumed to cover the difference.

[Live cost attribution](LIVE_COST_ATTRIBUTION_2026-09-21.md) includes older
row-based Market traffic, isolated compact-frame observations, bootstrap cost,
and quota exhaustion. Its historical daily totals cannot safely be treated as
the current compact-frame implementation's daily demand or available allowance.

## Why no numeric activation configuration is supplied

The preview max_pending=1000 is a test fixture default, not a justified
production capacity. Without a consumer, pending rows accumulate. Any finite
bound eventually blocks acceptance under continued new-event arrivals. The
preview trigger deliberately aborts acceptance when full or policy is absent;
that safety mechanism does not establish an acceptable availability horizon.

Neither lane's daily write budget can be derived from one promotion. The
available evidence does not allocate account/database headroom among current
lane demand, other workloads, control operations, retries and recovery.
No values are supplied for D1_MARKET_DAILY_WRITE_BUDGET,
D1_PLAYER_STATE_DAILY_WRITE_BUDGET or production max_pending.

## Exact evidence needed before an activation implementation

1. Current-version, UTC-day-aligned phase totals for both lanes over complete
   representative days, including a full sweep and Market peaks. Include new
   eligible fingerprint counts, duplicate attempts, failures, retries, run
   lifecycle, candidate/frame cleanup and reconciliation with database totals.
2. Confirmed available write allowance and competing consumption for the same
   period; explicitly approved control/recovery/migration reserve and lane
   allocations. Do not extrapolate the old allowance observation into a current
   production limit.
3. For internal-only outbox operation: initial backlog, measured peak arrivals
   and burst size, payload/storage costs, an explicitly approved accumulation
   horizon and an operator response before saturation. Document the accepted
   fail-closed availability impact. No sender or silent eviction is implied.
4. Local D1 validation of the complete reservation/settlement cost envelope,
   including the finalization baseline, duplicate paths and ambiguous outcomes.
   Prove reservation occurs before the first domain write, actual committed
   writes cannot exceed the reservation, and exhausted budgets still leave
   enough capacity to record failure/recovery.
5. Approved production max_pending derived from the observed event/write peak
   envelope, storage costs and approved accumulation/retention period. The
   preview value 1000 is not a production policy.
6. A reviewed consumer lifecycle before enabling any accumulating outbox;
   if delivery is ever enabled, define leases, retries, deduplication, terminal
   states and operational ownership. No consumer exists today, so an enabled
   accumulating outbox is explicitly unacceptable and remains blocked.

## Closed prerequisites

- Production promotion phase metadata gap: closed for supplied run 4566.
- Strict D1 metadata validation: closed locally. d1Usage rejects empty/sparse
  batches, missing/null values, nonnumeric/nonfinite/negative values, failed
  results, fractional row counts and aggregate overflow. Numeric zero remains
  valid. timings.sql_duration_ms is primary; only an absent/null primary permits
  fallback to an actually present valid meta.duration. Invalid primary values
  cannot be hidden by a valid fallback. Multiple results still aggregate.

Full-day Market write/read costs, full-day Player-State cost, safe quota reserve,
peak envelope, approved accumulation/retention period, production max_pending
and consumer/delivery lifecycle remain open. Closing metadata validation does
not activate enforcement or outbox, nor establish safe production budgets.
## Preserved boundary and next gate

The [architecture](WRITE_BUDGET_OUTBOX_ARCHITECTURE.md) remains the required
contract: reservation before domain writes, bounded settlement, atomic accepted
evidence/outbox creation, fingerprint deduplication and fail-closed exhaustion.
Keep the six-statement promotion.commit unchanged. Preview SQL stays outside
migrations; do not apply its policy default as a production setting.

Next gate: obtain and review the evidence above and explicitly approve a bounded
internal-only operating policy. Then scope a separate local implementation with
failure/atomicity tests. Merely setting environment variables or copying the
preview SQL is not an approved activation path.

No push, PR, merge, deployment, remote D1, production activation, sender,
external message or fantasy transaction is part of this candidate.
