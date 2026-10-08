# Write-budget policy v1 — local decision draft

**POLICY CANDIDATE ONLY. No active limits or Production changes.**
Baseline main: `9b2de9642a1f2a8c689d044b36281388eec9f651`, tree
`c90dacd9f21d424186479a97fe3e5e3b01ed3b26`, runtime 0.2.10.
The JSON is consumed only by the offline simulator/tests. No runtime import,
environment variable, Wrangler change, migration, outbox or sender is introduced.

## Candidate envelopes

| Accounting class | Writes / UTC day |
| --- | ---: |
| Normal Market | 72,000 |
| Normal Player-State | 4,000 |
| Unattributed / UNKNOWN | 3,000 |
| Budget-control + retention bookkeeping | 4,000 |
| Bounded retry / completion reserve | 5,000 |
| Independent safety reserve | 12,000 |
| **Global planning ceiling** | **100,000** |

Invariant: 72,000 + 4,000 + 3,000 + 4,000 + 5,000 + 12,000 = 100,000.
The ceiling is a **hypothetical conservative Free planning assumption**,
never a verified account quota. Actual account plan: **UNKNOWN**.
Normal classes plus retry can use at most 88,000; spare capacity in another
class does not raise a lane's ceiling. Neither reserve is a normal lane.

## Completed Production evidence: October 5–7, 2026 UTC

| Day | Market | Player-State | UNKNOWN | Observed total | Added control + maximum future retention | Planning scenario total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| October 5 | 63,911 | 1,953 | 1,169 | 67,033 | 3,041 | 70,074 |
| October 6 | 59,771 | 1,481 | 629 | 61,881 | 3,041 | 64,922 |
| October 7 | 61,576 | 1,894 | 1,203 | 64,673 | 3,041 | 67,714 |

Totals: Market 185,258, Player-State 5,328, UNKNOWN 3,001;
98.4498% attribution, HIGH quality. UNKNOWN stays its own accounting class:
the aggregate 3,001 is over three days, not a breach of a 3,000 daily allowance.
795/795 ledger entries ok, no OPEN/FAIL, no schedule gaps/duplicates;
three complete sweeps of 4,364 items, Market 288/288 successful runs.

Conservative observed lane bounds, independently assigning all daily UNKNOWN
to each lane for sensitivity analysis: Market 65,080 < 72,000 and
Player-State 3,122 < 4,000. These are bounds, not fabricated attribution.
The simulator's combined-bound stress case intentionally overcounts possible
UNKNOWN exposure; it does not replace the measured day totals or remove UNKNOWN.
Daily UNKNOWN maximum 1,203 < 3,000. Bookkeeping 3,041 < 4,000.

The extra 3,041 consists of 2,529 control writes for 361 observed calls/day
(96 Market + 265 Player-State), plus 512 maximum future retention writes.
Control scenario: first reservation per lane/day 5 writes, subsequent 4,
one settlement OR abandon 3; 361 * 7 + 2 = 2,529. The already observed ledger
cost is included in the measured totals and is not added a second time.
Local calibration estimates are not per-statement Production billing evidence.
Retries, their additional bookkeeping and possible overruns must fit their
respective envelopes. Three days are not a season maximum.

## Future enforcement semantics — specified, not wired

1. Admission precedes new optional lane work. Both lane and global capacity
   must permit it; global availability overrides lane availability. On rejection,
   skip/defer new work, without a new Market/Player-State start.
2. Protect necessary settlement/abandon and ledger finalization by budgeting
   completion costs at admission. Do not block them using the same guard that
   denies new work. Account their consumption in bookkeeping even on failure.
3. Settle reservations from reliable actual usage; release only proven unused
   capacity. Missing/invalid metadata closes new admission, never fabricates
   zero usage or remaining capacity. Do not blindly abandon after work occurred.
   Preserve overruns as evidence instead of clamping them to the reservation.
4. UNKNOWN remains independent. Exceeding its allowance closes uncertain new
   admission and emits a bounded local diagnostic; it does not invent attribution
   or initiate external alerts.
5. Retry capacity is only for bounded retry/completion of already admitted work.
   It cannot fund regular new starts, permanently increase lane ceilings or
   recursively create retries. A later implementation must specify operation
   eligibility and attempt bounds; this draft authorizes none of those operations.
6. The 12,000 independent reserve is never lane-borrowable and cannot fund outbox
   or alerts. It protects against unknown account writes, model errors and peaks.
   Unaccounted aggregate usage is a fail-closed discrepancy, not spare budget.
7. UTC-day accounting must cover actual consumption across midnight. Do not
   reset unresolved reservations into free capacity or hide next-day completion
   writes in the old day's remaining balance. Exact atomic admission, concurrency,
   retry counting and cross-day settlement require a separately reviewed design.

## Outbox exclusion

INTERNAL_OUTBOX_READY = NO; EXTERNAL_ALERTING_READY = NO.
The existing 9-write evidenceWithOutbox estimate includes original evidence
cost 6 plus incremental outbox cost 3. Add only the incremental 3/event to
observed Production totals; do not add all 9 again.

| Day | Accepted new events | Outbox increment scenario | Observed + outbox + control | Including maximum future retention |
| --- | ---: | ---: | ---: | ---: |
| October 5 | 10,830 | 32,490 | 102,052 | 102,564 |
| October 6 | 9,991 | 29,973 | 94,383 | 94,895 |
| October 7 | 10,439 | 31,317 | 98,519 | 99,031 |

October 5 already exceeds the hypothetical 100,000 ceiling with control alone.
Outbox has no allocation in this policy, and cannot consume either reserve;
therefore no observed day's outbox scenario is eligible. These are offline
scenarios, not actual billing. No max_pending or sender policy is proposed.

## Offline verification and status

Run `node tools/write-budget-policy-simulation.mjs` and focused policy/relevant
Watcher tests. The simulator rejects class overruns, independent-reserve borrowing,
recursive/ineligible retry, invalid usage metadata and global/accounting mismatches.
It makes no network calls and does not apply the policy anywhere.
Usage and options must be plain objects with known own fields; all five usage
classes are required. Invalid option types, unknown reserve fields and explicit
null/nonfinite aggregate usage are rejected. An omitted aggregate is only the
sum of supplied offline scenario classes, never proof of account billing usage.

- WATCHER_CORE_OPERATIONAL = YES (existing evidence)
- WRITE_BUDGET_ENFORCEMENT_EVIDENCE = SUFFICIENT_FOR_POLICY_DECISION
- WRITE_BUDGET_POLICY_DRAFT = READY
- WRITE_BUDGET_ENFORCEMENT_READY = NO
- WRITE_BUDGET_ENFORCEMENT_ACTIVE = NO
- INTERNAL_OUTBOX_READY = NO
- EXTERNAL_ALERTING_READY = NO

Next gate: **WATCHER_WRITE_BUDGET_POLICY_V1_LOCAL_REVIEW_REQUIRED**.
Review the candidate envelopes and failure semantics locally before separately
authorizing any implementation, publication or activation. No such action follows
automatically from a passing simulation.
