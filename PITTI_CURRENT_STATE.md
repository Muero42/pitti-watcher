# PITTI CURRENT STATE

Updated: 2026-09-01
Watcher version: v0.2.3
Mode: POST_DRAFT / PRE_WEEK_1

## Source of truth

This file is the canonical PITTI project checkpoint for chat handoffs. Code state is the current `main` branch of `Muero42/pitti-watcher`.

## League / draft context

- Completed real draft ID: `1366053132970233856`
- User draft slot: `9`
- League format: 10 teams, Half-PPR.
- Starters: QB, 2 WR, RB, TE, 2 FLEX, K, DST. Bench 6.
- No regular QB2 roster strategy.
- K and DST were intentionally not drafted; both must be filled before Week 1.
- Current user-reported post-draft roster delta: Zach Charbonnet moved to reserve/IR and Tank Bigsby added. This must be verified from live Sleeper league state before being treated as machine-confirmed.

## Watcher architecture

### v0.1.5 baseline
- Sleeper global add/drop trending every 15 minutes.
- Player-state sweep daily at 04:17 UTC.
- Evidence for market acceleration/reversal and player-state changes.
- Companion feed health gate prevents stale/failed evidence from being treated as current.

### v0.2.x post-draft additions
- `/league-state` resolves live Sleeper league context.
- Draft ID + slot can resolve league ID, roster ID, and Sleeper user ID from Sleeper draft metadata.
- Live league sync returns rosters, users, ownership, reserve/taxi, starters and recent transactions.
- `/companion-feed` schema v2 integrates league ownership.
- Free-agency radar excludes players already owned by the user or opponents.
- Radar combines fundamental events and market signals and ranks only actual free-agent candidates.
- Fundamental change is intentionally weighted above market hype.
- Sleeper trending remains an alert signal, not an autonomous add/drop justification.

## Post-draft decision policy

For every candidate use:
1. Verify actual league availability.
2. Verify source/fundamental reason behind the signal.
3. Compare candidate against a concrete drop candidate on the current roster.
4. Prefer ceiling / contingent RB upside where expected value justifies it; do not optimize for shallow weekly floor by default.
5. Account for K/DST roster slots that still must be created before Week 1.
6. Reserve/IR players must not be counted as ordinary bench occupancy.
7. No roster move is executed automatically without explicit user approval.

Draft-only return probability, ADP-return logic and opponent pick prediction are no longer primary decision variables.

## Known hard constraints / retained strategy

- Geno Smith and Aaron Rodgers remain QB exclusions.
- No second QB as a normal roster construction choice.
- Weekly and pre-Week-1 workflow: free agents vs current roster, not generic best-available rankings.
- Manager profiles remain relevant for likely waiver competition / roster needs, not draft return modeling.
- Expert accuracy collection remains a future season-long project.

## AUTO behavior

`AUTO` / `AUTO BLOCK` means autonomous execution with no unnecessary status chatter, no empty messages, and no false “AUTO continues” messages that themselves stop execution. Continue until a real blocker, user action, material external commitment, or validated end state is reached.

## Cloudflare D1 rows_read correction

- The D1 database is directly bound to this watcher as `env.DB`; this corrects the earlier draft-companion-only audit that could not see the separate watcher repository.
- Root cause candidate with direct code evidence: the 15-minute `detectMarketEvents` path previously reconstructed each player's previous sample using `GROUP BY player_id, MAX(captured_at)` over the entire growing `trending_snapshots` history. That makes D1 rows_read grow with retained history on every scheduled poll.
- v0.2.3 replaces that historical per-player scan with one immediately preceding `captured_at` snapshot. Because every polling batch shares one timestamp, this preserves the intended comparison while bounding the previous-snapshot read to roughly one polling batch.
- An executable regression forbids GROUP BY/JOIN in the previous-snapshot query. No paid Cloudflare upgrade is required as a code remediation.
- D1 is already quota-blocked until the provider reset; service recovery before reset is not expected even after deployment.

## Current technical verification

- v0.2.3 source includes the bounded previous-snapshot D1 query and regression coverage.
- Unit tests exist in `test/core.test.js` for ownership filtering, free-agent radar prioritization, and market thresholds.
- Wrangler config now contains the completed draft ID and user draft slot so the worker can resolve the live league without hardcoding an unverified league ID.

## Next technical priorities

1. Deploy current `main` to the Cloudflare Worker if the deployment is not automatic.
2. Verify `/health` reports v0.2.2.
3. Verify `/league-state` resolves the correct league and user roster.
4. Confirm live Sleeper state shows the reported Charbonnet reserve/IR + Bigsby roster move.
5. Verify `/companion-feed` v2 returns `freeAgency.available=true` and excludes all owned players.
6. Only after that, connect roster-relative add/drop scoring in the Companion UI.
