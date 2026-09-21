# Fail-closed D1 write budget and alert outbox

Status: implementation foundation, not production-deployed
Scope: existing Sleeper market and player-state lanes only

## Invariants

1. A lane must reserve a conservative upper bound before its first domain write.
2. Missing limits, missing D1 metadata, an unconfirmed reservation, or an exhausted budget fail the lane closed.
3. A reservation is atomic in D1. Concurrent invocations cannot both spend the same remaining allowance.
4. A reservation may be released only before any domain write. After an ambiguous or partial write, it remains reserved until an operator reconciles it; leaking allowance is safer than overspending it.
5. `committed_writes` may never exceed `reserved_writes`.
6. Alert creation is gated by successful run finalization and deduplicated by evidence fingerprint; failed or open observations never enter the outbox.
7. The outbox has no delivery consumer in this change. It sends no email, Slack, Discord, push, or other external message.
8. The watcher observes fantasy state. It does not submit adds, drops, waivers, trades, lineup changes, or any other fantasy transaction.

## Flow

```text
existing Sleeper fetch
        |
        v
build bounded write plan + conservative billable-row estimate
        |
        v
INSERT reservation ── D1 trigger ──> reject if daily lane budget would be exceeded
        |
        v
execute planned D1 batch; collect rows_read/rows_written/sql_duration_ms per query phase
        |
        v
finish and accept coherent watcher run
        |
        v
accepted-run trigger ──> pending alert_outbox rows (deduplicated)
        |
        v
settle reservation with observed rows_written; publish accepted lane health
```

## Lane budgets

The budget window is a UTC day. Limits are mandatory environment variables:

- `D1_MARKET_DAILY_WRITE_BUDGET`
- `D1_PLAYER_STATE_DAILY_WRITE_BUDGET`

The initial limits should be chosen below the account-level allowance and leave a fixed control-plane reserve for run finalization, budget bookkeeping, migrations, and manual recovery. Do not set the two lane limits to the full provider quota.

`src/write-budget.js` deliberately uses provisional conservative multipliers derived from the current schema/index shape and live D1 observations. They are not treated as billing truth. Before enforcement is activated, validate the multipliers in a disposable/non-production database using `docs/sql/write_budget_alert_outbox_preview.sql`; the outbox trigger adds writes to a new evidence insert.

## Query attribution

Every D1 result must be recorded under a stable phase name, not raw parameter values:

| Lane | Phase | Query family |
| --- | --- | --- |
| market | run.start / run.finish | `watcher_runs` lifecycle |
| market | state.load | previous accepted compact frame including signal episodes |
| market | retention.prune | bounded snapshot delete |
| market | frame.insert | one current JSON frame |
| market | evidence.batch | run-scoped transition evidence; episode state is embedded in the frame |
| player_state | sweep.active / sweep.init / checkpoint | observation cursor lifecycle |
| player_state | state.load | 25–50-ID canonical-state reads during observation |
| player_state | candidate.batch | run-scoped changed-state staging; canonical state remains untouched |
| player_state | promotion.load / promotion.state_load | staged candidates and current canonical state after source revalidation |
| player_state | promotion.evidence_batch | accepted fundamental evidence; new inserts later create outbox rows |
| player_state | promotion.state_batch / promotion.checkpoint | accepted canonical-state promotion and resumable promotion cursor |
| player_state | source.fetch / source.revalidate | network/CPU only; zero D1 rows |

For each phase emit one structured summary after completion: lane, run ID, phase, query count, rows read, rows written, SQL duration, and wall duration. Never emit bound values, payload JSON, player names, tokens, or raw D1 errors. Worker CPU is invocation-level platform telemetry; D1 SQL duration is not Worker CPU and must remain a separate field.

## Outbox state machine

```text
pending -> leased -> sent
              \-> pending (retry with bounded backoff)
              \-> dead    (terminal policy decision)
```

Only the schema/trigger preview for `pending` creation exists now. A future activation must also enforce a hard pending-row bound before enabling the trigger: either reject the evidence transaction fail-closed when the bound is reached, or reserve outbox capacity atomically with the lane write budget. Silent eviction is forbidden. A future sender must use a lease token, bounded batch size, retry ceiling, and an idempotency key equal to `dedupe_key`. Adding a destination or sender is a separate change requiring explicit authorization and destination-specific secrets. `sent` must mean an acknowledged external delivery, never merely an attempted fetch.

## Rollout gates

1. Apply `docs/sql/write_budget_alert_outbox_preview.sql` only to a disposable/non-production database and run the reservation/outbox tests.
2. Deploy phase-level logging in shadow mode; compare provisional estimates with observed `rows_written` for at least one representative daily sweep and market window.
3. Define and test the pending-outbox hard bound; keep both trigger and reservation path inactive until then.
4. Promote reviewed SQL into a new migration, set lane limits with control-plane headroom, and enable reservation before any domain write.
5. Exercise budget exhaustion and ambiguous-write tests. The lane must end `FAIL`; no unreserved alert may become eligible.
6. Deploy without any outbox consumer. Verify pending rows and deduplication only.
7. A sender, new source, or fantasy transaction executor remains a separately reviewed project.
