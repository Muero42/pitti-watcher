# Controlled local News Bridge release preparation

This is the current release-scope and rollback contract. Earlier proof documents
are preserved as historical source evidence, not instructions to publish their
original branch ancestry. No remote publication or activation is authorized.

## Candidates and provenance

Watcher branch: `codex/watcher-news-release-v1`, directly based on locally verified
canonical main `38e4c4ede061644b0e879f408bf6a489a9fe6511`. The candidate is one new
local commit; its final HEAD/tree are recorded in the validation receipt after
commit, avoiding a self-referential document hash.

Runtime files are byte-identical to their reviewed versions at
`9e2e5943bea0e07b91af454f9474547cdbf6679c`. Relative to canonical main they contain
only the bounded-retention correction from `d11e4018ce47d0931180dd306d9cb1f72d305df3`
and the News Bridge changes. The standalone retention regression is copied
unchanged from d11e401's `test/write-budget-design-gate.test.js`, now named
`test/bounded-market-retention.test.js`; it imports no budget design machinery.

Companion release branch: `codex/companion-news-release-rc4234`, a reference to the
existing, unchanged `670e0745a72e9b1acf38d2151928f0e73f7d1e7b`.
Tree: `637854eb4dac4f7206387e80ea9c72a859675bea`.
Parent: `c4ca793288d728f84f92e0319d18e9bb4f1373a0`.
Its original development branch remains intact. No redundant Companion commit,
version change, generation change, reseal or history rewrite was necessary.

The four included Companion ancestors above locally stored main are the Android
HOLD evidence (`52e441b6`), rc4.232 diagnostics (`0966857e`), rc4.233 News Bridge
(`c4ca7932`) and rc4.234 bootstrap diagnostic repair (`670e0745`). rc4.231 repairs
are preserved through ancestry and exact inverse bindings. The main-only merge
commit `f65cfa891ba2cb64999bfa1fc7855bea8024778a` has the same tree as the common
ancestor `a2480df7a09dafed20b1df7618a225fb22171e5e`; no missing runtime repair was
inferred merely from graph divergence. No rebase or merge was performed.

rc4.234 is included because it fixes a reproduced diagnostic error: bootstrap
completion was recorded before fallible persistence, and failures could omit the
diagnostic ERROR. It changes neither decision gates nor source acquisition.
Its own exact runtime/authority inversion preserves rc4.233 and earlier fixes.

## Complete scope

`NEWS_RELEASE_SCOPE.json` lists every included file, every Companion commit and
every excluded Watcher ancestor/file. Watcher includes four runtime files, three
tests, one offline paired test tool and six evidence/scope documents.

Excluded additions: the twelve unpublished Market budget/admission, D1 settlement,
durable recovery, clock and cost-calibration commits between canonical main and
the retention commit. Their original branches, commits, proofs and untracked
reports remain preserved. Existing files already in canonical main are not
removed, even if they document older budget work. No enforcement is activated.

No migrations, Wrangler configuration, bindings, cron, package version, Player-State
implementation, Outbox or alerts are changed. The Market DELETE is the expressly
included retention correction: at most 64 completed old frames, retaining open,
previous and current frames. Market observation remains every 15 minutes.

News is OFF unless `NEWS_SOURCE_ENABLED` is exactly `1`. The checked-in Wrangler
configuration contains no such activation. Disabled collection/feed returns before
News database work or source requests. No claim about unseen Production secrets
or environment overrides is made.

## Source and operational limits

The fixed ESPN endpoint, HTTPS publisher URL, full-name plus athlete-category
matching, explicit timestamp validation, response/event bounds and timeout remain
unchanged. Invalid collection fails its own lane. Evidence and successful run
acceptance share a D1 batch; replay does not change ownership or observation time.
Feed results exclude incomplete/failed runs and stale evidence. Legacy feed lanes
cannot be crowded by News in the new query.

News records/run ledgers currently have no deletion policy; the 48-hour feed
window does not bound stored history. The feed's LIMIT does not certify read cost.
At 96 scheduled runs/day the model is 96 source requests, 192 successful run-ledger
statements and at most 4,800 attempted evidence inserts. These are statement counts,
NOT measured billable rows or a verified account quota. Actual costs, retention and
source coverage remain activation gates; this task starts no new cost project.

## Authorized rollback contract

The user explicitly selected a restricted rollback contract: after activation,
only a reviewed Companion with News protection is a valid rollback target.

- Reviewed safe Companion floor: rc4.233 `c4ca793288d728f84f92e0319d18e9bb4f1373a0`.
  rc4.234 is the chosen release. A version string or ancestry alone is not proof:
  any future rollback artifact must pass the cached-News regression.
- Main `f65cfa891ba2cb64999bfa1fc7855bea8024778a` is FORBIDDEN when cached News may
  exist. The negative control proves its old actionable filter admits one saved
  News record. The new candidate cannot retroactively change that old binary.
- Disabling News on the new Watcher preserves stored rows and cached reports.
  Rolling Watcher back to `38e4c4e` also leaves News outside its public Companion
  feed through the existing lane filter. Keep the protected Companion installed.
- Old Companion + new Watcher disabled is compatible for a clean/no-News cache;
  this does NOT override the prohibition once cached News may exist.
- Never clear caches or delete D1 evidence to make rollback appear safe.
- A Watcher rollback loses bounded retention and can restore unbounded backlog
  deletion; prefer disabling News on the current Watcher. Any actual code rollback
  requires separate operational review/authorization of that retention risk.

These are publication/rollback approval constraints, not an automatically deployed
rollback mechanism. No rollback or activation was performed.

## Reproducible validation

Use an already installed Wrangler/Miniflare package and the Companion Git checkout:

```powershell
$env:PITTI_LOCAL_D1_PACKAGE = 'C:\path\to\wrangler\package.json'
node --test test/bounded-market-retention.test.js test/news-source.test.js test/lane-isolation.test.js test/market-frames.test.js
node tools/news-release-matrix.mjs C:\path\to\PITTI-Codex $env:PITTI_LOCAL_D1_PACKAGE docs/NEWS_RELEASE_MATRIX.json
```

Focused Watcher result: 19/19 PASS, including disposable workerd/D1. An initial
sandbox execution failed because Windows denied workerd a filesystem operation;
the authorized unsandboxed local run passed. Matrix construction first exposed a
missing mandatory field in its new SQL fixture; only the fixture was corrected.

The final matrix records 18 passing cases, including the explicitly unsafe old
Companion negative control. It exercises actual local D1 and real Chromium, with
all external requests intercepted. It binds the exact Watcher runtime blobs and
the exact Companion commit/tree. Missing, partial, stale and unsupported payloads
preserve historical evidence and do not promote News into actionable evidence.

Companion focused checks passed: rc4.234 binding (35 negatives), rc4.233 binding
(37 negatives), lifecycle including eight bootstrap cases, render diagnostics,
News ingestion, feed-v2 isolation and strict guardrails. The complete strict suite
was executed once on unchanged HEAD `670e0745`: 336/336 PASS, including package
and no-Git re-extraction checks. The machine scope document records each check
and the SHA-256 of the raw result file retained in the Companion checkout.

The final Watcher full-suite/syntax result and exact tested tree are recorded in
the local validation receipt after execution. Older 232-test/230-test results
belong to the larger experimental branches and are not claimed for this isolated
candidate. No tests were weakened to reproduce their old counts.

## Product acceptance and publication boundary

The complete unchanged Companion application was loaded in Chromium with its saved
Live / News view open. After a disabled initial response, the actual foreground
timer consumed a real local-D1 fixture feed without a click or injected sync call.
The visible status became `Nachrichten PASS: 1 neue Prüfhinweise`; the specific
article headline was persisted as unverified review evidence. A repeat poll did
not duplicate it. Other providers were offline fixture failures and remained
fail-closed. This is an automated local integration demonstration, not Production,
physical Android, a historical Harrison replay or a quality-of-recommendation test.

Important limit: the visible result is currently a count in Live / News, not a
headline card or an alert across other views. No closed-app push exists or is
claimed. The News Bridge alone does not complete the user's notification goal.

After passing final local gates, the independent recommendation is publication
eligibility for rc4.234 first, then this isolated Watcher with News OFF, under the
restricted rollback contract. Actual push/PR/merge/deployment requires a separate
authorization. News activation requires its own later operational readiness gate.

Next authorization gate: `NEWS_BRIDGE_V1_EXACT_CANDIDATES_PUBLICATION_AUTHORIZATION`.
No remote command, production mutation, migration or activation was executed.
