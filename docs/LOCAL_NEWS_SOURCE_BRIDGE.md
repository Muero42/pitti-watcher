# Local news-source -> Companion candidate

2026-10-11. Status: **LOCAL FUNCTIONAL PROOF PASS; COMPANION RELEASE/INTEGRITY INTEGRATION UNRESOLVED**.
This is not a published or activated feature. No commit made while the coupled candidate has unresolved checks.

## Product boundary

Watcher independently fetches one source on the existing 15-minute schedule. Companion receives dated player-bound reports for evaluation. Collection requires no open Companion. A closed Companion receives no push from this implementation; it imports the stored reports on its next feed synchronization. Roster advice, rumour confirmation and actual background delivery are not claimed.

Source: public [ESPN NFL news JSON](https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50). Direct read-only compatibility probe at 2026-10-11T07:46:58.157Z returned 50 articles, 11 matched player/article events, 6 relevant but unmatched headlines and 0 structurally rejected articles. This is one observation, not measured historical coverage or an uptime/API stability commitment. Player names for that probe came from the public Sleeper directory; production-candidate collection uses existing recent local player_state rows.

## Changes

Watcher:
- `src/news-source.js`: fixed source URL, 8-second network timeout, 1 MiB streamed response cap, at most 100 input articles / 50 mapped events, valid explicit-zone timestamps and HTTPS publisher URLs required. Discard publications older than 48 hours; reject malformed or future chronology. Full-name headline mention and matching athlete category required; ambiguous names are not guessed.
- Exact article/player/content-version fingerprints; unchanged replay uses DO NOTHING, preserving first observation and accepted-run ownership. Publication, source revision and observation times remain separate. Observation is recorded after download, not at cron start. Source-reported publication dates are not event occurrence dates.
- Existing D1 schema only. A new `news:scheduled` run records execution; evidence inserts and successful finalization share one D1 batch. A failed batch rolls back evidence; failure updates only an unfinished run. No automatic release or recovery of orphaned runs.
- `src/index-v029.js`: a separate waitUntil task on the existing Market cron, only when `NEWS_SOURCE_ENABLED === '1'`. Wrangler variables are unchanged, so the feature remains disabled. Market cadence and its own execution remain unchanged.
- `src/index-v027.js`: independent `newsEvidence` schema/status/events; news is excluded from the legacy Market/Player evidence window. News failure does not change their gate. News feed exposes the newest observed source revision per article/player, with a 45-minute run freshness gate and 48-hour publication horizon.

Companion (`C:/Users/timmu/Documents/PITTI-Codex`):
- `app.js`: validate the news contract independently of Market/Player health, import into the existing versioned research cache and display the count of pending news hints. Do not assign confirmed-event chronology, verified status or decision confidence to headlines.
- News remains `REQUIRES_EVALUATION`, excluded from actionable research weighting. No change to roster utility or Add/Drop logic. Replay excludes versions not observed by its cutoff. Feed failures preserve the existing cache. No push/Outbox/transaction activation.
- `tools/season-watcher-news-regression.mjs`: uses actual app functions for ingestion, repeated-poll deduplication, stale/invalid rejection, no-hindsight and non-actionable treatment.

## Evidence / tests

- Final focused Watcher tests: **16/16 PASS**, including real disposable workerd/D1, the actual scheduled handler and `/companion-feed` function with no browser/Companion present. New insert, exact replay, revision, rollback and retry, independent feed with unhealthy other lanes, and HTTP failure/cache preservation covered. Download-delay assertion verifies post-download observation time.
- Companion news regression and existing feed-v2 regression: **PASS**.
- Watcher full suite executed once: **232/232 PASS**. This run preceded the final narrow post-download timestamp correction; the affected 16-test suite passed again on the final bytes. Do not describe the full-suite result as a final-byte release certificate.
- `npm run test:syntax`: PASS; new news module also separately syntax-checked. `git diff --check`: PASS.
- Companion full suite executed once: **317/330**. Eleven failures concern the current seal and exact historical runtime/diagnostic byte bindings. Two entries run the same cloud-foundation regression and failed because the Windows sandbox could not initialize temporary Git repositories. A targeted run outside the sandbox subsequently passed **63 cases**; the full suite was not rerun or relabelled green.
- Existing historical binding tests and seals were not bypassed or rewritten. This new feature changes bytes outside the former diagnostic-only candidate, so the successor-candidate contract must be established before a clean coupled commit/publication. This is actual remaining engineering work, not missing user permission to implement news.

Logs: Watcher `news-full-suite.log`; Companion `watcher-news-full-suite.log` and `watcher-news-cloud-recheck.log`. Fixtures are synthetic source-contract tests, not a claim of historical Harrison detection or delivered push.

## Limitations and next work

One public, undocumented publisher endpoint cannot guarantee earliest reports or comprehensive coverage. Headline/category matching intentionally misses ambiguous names, surname-only headlines, and players absent from the recent directory. The latest 50 source articles can turn over between polls. No historical catch-up, source SLA, complete-news guarantee or daily cost estimate is asserted. The source lane shares D1 resources but not gate state with other lanes; writes and run ledgers consume additional budget. News rows have no new retention policy in this candidate; long-term retention and actual cost must be checked before activation rather than claiming infinite bounded storage.

Next: reconcile the Companion changes as an explicit successor feature candidate while preserving the previous diagnostic proof, satisfy its integrity checks, then review the paired local changes. No broad budget project is needed. Only after that comes separately authorized publication/activation; genuine push delivery remains a later product test.

## Git preservation

Watcher branch: `codex/watcher-write-budget-enforcement-v1`

- HEAD `d11e4018ce47d0931180dd306d9cb1f72d305df3`
- Tree `9cfdcb2217509077f9b49f4952885305144e5560`
- Parent `a48e1e1a51dc9cc406b72934817b9cc2a4d6779f`
- Existing replay reports and September measurement reports retained; September SHA256s still match the prior recorded values.

Companion branch: `codex/rc4232-render-diagnostics`

- HEAD `0966857e48d3e0267e65c14db8b0b51a1d443306`
- Tree `dc2d4d7114567f641a9fae067a3342044c9981cd`

Both worktrees contain this uncommitted local candidate. No existing commits rewritten, no migration, version bump, push, PR, deployment, Cloudflare mutation or external notification.
