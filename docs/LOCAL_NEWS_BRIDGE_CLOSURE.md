# Local news bridge closure — 2026-10-11

This closure supersedes the unresolved integration/test status in `LOCAL_NEWS_SOURCE_BRIDGE.md`; that report is retained as the implementation checkpoint.

## Result

Local Watcher collection and Companion ingestion are implemented and locally verified. News remains disabled (`NEWS_SOURCE_ENABLED` is not present in Wrangler configuration). No publication, activation, push, Outbox, remote migration or fantasy transaction occurred.

Watcher source branch: `codex/watcher-news-source-v1`, parent `d11e4018ce47d0931180dd306d9cb1f72d305df3`.
Companion source branch: `codex/rc4233-watcher-news-bridge`, parent `0966857e48d3e0267e65c14db8b0b51a1d443306`, candidate `v11.8.0-rc4.233`.

The previously sealed rc4.232 diagnostic candidate is preserved through exact inverse patches. Companion's new binding checks all 18 runtime files against both the actual parent Git objects and the candidate hashes, reconstructs prior authority, and rejects 37 mutation/overclaim cases. Historical candidate checks continue to run against their original bytes. A new seal records the successor; no old acceptance is carried forward.

## Final validation

- Watcher focused: **16/16 PASS** with real disposable local workerd/D1.
- Watcher full suite on final runtime/test bytes: **232/232 PASS**, no skips (`news-final-suite.log`).
- Watcher syntax: PASS, including separate syntax check of the new news module.
- Companion news ingestion and prior feed-v2 regressions: PASS.
- Companion guardrail, new candidate binding and historical rc4.232 binding: PASS.
- Companion complete strict-suite invocation: **331/333 PASS**. Both failures were missing-module errors in temporary no-Git package tests, because their `git ls-files` copy omitted the new, then-untracked modules. After staging those exact files, both failed tests passed in targeted reruns (`season-rc4229-release-binding-regression.mjs`, `season-rc4230-release-binding-regression.mjs`). No source or assertion was changed for this repair. All 333 checks therefore have passing evidence on the same source bytes, but this is **not a single 333/333 full-suite run**. No redundant full rerun was made.
- `git diff --check`: PASS. Final diff review confirmed no unrelated runtime changes: Companion changes news ingestion/review handling plus version strings; Watcher changes the isolated news lane and keeps it off by default.

The focused D1 test initially exposed a fixture-clock dependency after real time passed its fixed replay timestamp. The fixture now freezes Date.now before the first collection. Runtime chronology checks were preserved; post-download observation and no-hindsight assertions remain in place.

## Product boundary and next gate

Watcher collection runs without a browser; Companion imports pending reports at the next synchronization. This is not background push and not an autonomous Add/Drop evaluator. Reports are explicitly unverified and non-actionable pending evaluation. ESPN coverage is partial and its endpoint has no asserted stability guarantee.

Next gate: review the paired local commits for publication, **separately from activation**. Before enabling recurring news collection, settle the bounded retention/observed-cost question recorded in the implementation report; no new hard-ceiling project is implied. After activation, measure source-to-Watcher-to-Companion latency. A real closed-app notification requires its own delivered-notification evidence.

The Watcher branch retains earlier unpublished work in its ancestry. Publishing a branch must not be mistaken for authorization to deploy all prior Budget/Recovery work. Review the actual release diff when preparing publication.

Existing September measurement reports and Harrison replay artifacts remain untouched. Commit identities and trees are reported after local commits, avoiding self-referential hashes inside this document.
