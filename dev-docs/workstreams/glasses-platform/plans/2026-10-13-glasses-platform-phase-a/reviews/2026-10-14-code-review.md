---
workstream: glasses-platform
doc_type: review
title: "Glasses platform Phase A: code review and remediation"
status: shipped
id: 2026-10-14-glasses-platform-phase-a-code-review
created: 2026-10-14
updated: 2026-10-14
authors: [agent]
---

# Phase A code review and remediation

Scope: branch `davidrudduck/glasses-phase-a`, range `7774dfd..7e80b34` (the Phase A implementation in `apps/mentra-glass`). Method: static checks run by the controller, then four parallel read-only reviews: gateway STT; controller and view; notifications, tilt, UI and manifest; tests and performance. Fixes were made test-first, each finding with a regression test that failed before the fix. Two scoped re-reviews checked the fixes.

## Static analysis

| Check | Result |
|---|---|
| `tsc --noEmit` (strict), app and `scripts/` | Clean |
| `tsc --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch` | 2 unused locals in `gatewayStt.test.ts` (S-01, fixed) |
| Forbidden background globals (`window`, `document`, `performance`, `crypto.subtle`, `crypto.randomUUID`, `URL`, `process`) | None in `src/background` or `src/gateway` |
| Deprecated SDK APIs (`storage.list`, `translation.forLanguagePair`) | Not used |
| Linter | None configured in the repo (L-04) |

## Findings fixed

All findings came from code added on this branch. Effort is the reviewer's estimate before the fix.

| ID | Severity | Finding | Effort | Fix |
|---|---|---|---|---|
| A-01 | High | A periodic flush re-armed after `finish()` started, so audio was appended after close. The gateway rejects that, and the valid transcript was discarded. | S | One ordered drain path with at most one append in flight. `finish()` waits for it, and nothing is appended after close. |
| P1 | High | A drain queued by `finish()` could run against a newer question's session before that session was ready (found by the re-review). | S | The drain is bound to its question and session when queued, and stale drains discard themselves. |
| A-02 | Medium | After the server ended the session before `finish()`, streaming went on: appends to a removed session, a close, a warning and a needless fence. | S | On `session.error` or `session.closed`, streaming and the periodic timer stop, and no close is sent for a session the server already closed. |
| A-03 | Medium | The audio held back until `session.ready` went out as one append. Above about 12.3 s of audio this exceeds the gateway's 524,288-character frame limit. | S | Appends carry whole chunks up to `MAX_APPEND_BYTES = 96_000` (3 s). |
| A-04 | Medium | A create failure arriving after `finish()` had timed out still raised the "transcription unavailable" warning. | XS | Failures are reported only while the question is current and unfinished. |
| P2 | Medium | An unresolved append from an ended session blocked the next session's audio (found by the re-review). | S | Each question gets its own append chain. |
| C-01 | Medium | Notification paging could split an emoji (a UTF-16 surrogate pair) across two pages. | S | Long words are hard-split on code points. |
| C-02 | Medium | A stale state message could reset the phone menu's local allowlist, so a later tick dropped an earlier one. | S–M | New `notifications:allow {packageName, enabled}` message applied in the background. The UI no longer keeps its own copy of the list. |
| C-03 | Medium | A notification page accepted late by the glasses was cleared before its 4 s reading time, then restarted at page 1. | S | Notification frames re-anchor their auto-clear at the first accepted render. |
| C-04 | Medium | A backward step in sample timestamps delayed tilt detection. | XS | A timestamp regression restarts the hold. |
| B-02 | Medium | Unpairing during a pending transcript could send a fallback chat on a closed socket and show a spurious error. | S | Unpair runs the same teardown as re-pair through one shared helper. |
| B-03 | Medium | A failed seen-app storage write was never retried. | S | The list of the last requested write is tracked, and a mismatch retries. |
| P3 | Medium | A seen-app reordering made while an older write was pending was lost (found by the re-review). | S | Writes compare against the last requested write; pushes compare against the last pushed snapshot. |
| D4 | Low | One notification pushed two snapshots to the phone, and unchanged or edited reposts pushed one. | S | Intake pushes only when the seen-app list or the queued count changed. `add()` stays `void`. |
| D5 | Low | Every accelerometer sample allocated a temporary array. | XS | Four direct `Number.isFinite` checks. |
| S-01 | Low | Two unused locals in a test. | XS | Removed. |

## Logged, not fixed

| ID | Severity | Finding | Effort | Why not fixed now |
|---|---|---|---|---|
| L-01 | Low | Paging can still split grapheme clusters (ZWJ emoji, combining marks). Surrogate pairs are safe. | S | Needs `Intl.Segmenter`, which the MentraOS background engine is not known to have. |
| L-02 | Info | `gatewayStt.ts` (587 lines) has 4 states and 7 boolean flags; most of this review's STT findings came from overlapping guards. The reviewer proposes one record per question with explicit phases. | M | A refactor, not a bug. 49 regression tests now pin the behaviour, so it can be done safely as its own change. |
| L-03 | Info | `AssistantController.ts` grew from 626 to 960 lines. Notification intake, seen-app persistence and STT wiring could become small collaborators. | M | A refactor, not a bug. |
| L-04 | Info | The repo has no linter; Prettier style is matched by hand. | S | Adding a toolchain is a repo-wide decision. |
| L-05 | Medium | `src/ui/App.tsx` has no tests; the package has no DOM test setup. | M | Resolved in `099fbc5`: `src/ui/App.test.tsx` adds 23 DOM tests under happy-dom (per-file environment; `@testing-library/react`, `@testing-library/dom`, `happy-dom`), and `src/ui/App.tsx` is in coverage at 100%. |
| L-06 | Info | An audio chunk larger than `MAX_APPEND_BYTES` is sent alone, not split. | XS | Ruling: chunks are about 3.2 KB in practice. A chunk over the gateway limit (about 393 KB) would fall back to Mentra. |
| L-07 | Info | When `finish()` is pending and `session.error` arrives, the capture sends `talk.session.close` before the following `session.closed`. The server may already have dropped the session, and the error reply is ignored. | XS | Kept from the earlier fix wave; the side effect is harmless. |
| L-08 | Low | Existing code, not this branch: the controller test helper `flush()` drains a fixed 20 microtasks, so it depends on await depth. | S | Resolved in `099fbc5`: `flush()` is now fake-timer only — `await vi.advanceTimersByTimeAsync(0)`, which throws under real timers; every test in the file installs fake timers in `beforeEach`. |

Resolution updates (unit-test step): L-05 and L-08 closed in `099fbc5`, which added the phone-UI test harness and the fake-timer-only `flush()`. A separate cleanup, `dabc8ba`, removed 7 unreachable guards and the write-only `currentQuery` field flagged during review — no behaviour change.

## Coverage gaps (current state)

At `099fbc5`: 387 tests pass; v8 coverage is statements 99.96%, branches
97.73%, functions 99.56%, lines 99.96% (thresholds 80%). `src/ui/App.tsx`
is covered by `src/ui/App.test.tsx` (23 tests, 100%), closing L-05. All
earlier statement gaps are covered; what remains uncovered are inert or
TS-required guards (line numbers at this commit):

- `src/background/AssistantController.ts`: 320, 337, 681
- `src/background/gatewayStt.ts`: 219, 241, 418, 501
- `src/background/notificationPresenter.ts`: 73, 82, 130, 160

## Verification

At `d7a4a3e`, from the repo root:

- `npm run glass:coverage`: 319/319 tests pass. Statements 99.52%, branches 93.58%, functions 99.53%, lines 99.52% (thresholds 80%).
- `npm run glass:typecheck` and `npm run build -w @wednesdayai/mentra-glass`: both succeed.
- `tsc --noEmit --noUnusedLocals --noUnusedParameters`: clean.
- Re-reviews: round 1 found three new defects (P1–P3) and partial fixes for A-02 and D4. Round 2 confirmed all six fixed. Round 3 cleared a leftover snapshot push. Final verdict: correct, no new breakage.

Fix commits: `f5ee273`, `466e4a3`, `f4c6067`, `a991812`, `0d15d87`, `60be13d`, `aacfec0`, `d7a4a3e`. Unit-test step and cleanup: `099fbc5` (L-05, L-08), `dabc8ba`.

## End-to-end validation

Run against the real gateway `wss://astro.tailfd11f7.ts.net` (pair, wake words, agents, chat turn, gateway STT, device-token reconnect) and an isolated dev gateway, plus lint (strict `tsc`, one-off `oxlint`), build, `mentra-miniapp pack`, manifest schema validation, and execution tests of both built bundles (background in a bare `node:vm` host, UI in happy-dom). Test devices created on the gateway were removed afterwards.

| ID | Severity | Origin | Finding | Status |
|---|---|---|---|---|
| E-01 | Medium | WednesdayAI-core | A short spoken question sent through gateway STT came back empty (`passive talk empty transcript`) and fell back to Mentra. Root cause is in core: streaming-dictation `commitInput()` finalizes with whatever partials have arrived and never awaits the provider's committed transcript. Only real-time audio after speech helps; a 500 ms and a 1.5 s digital silence tail sent on close (`25befab`, `0e45ef9`) both failed live, so they were reverted (`231230c`, `7a53520`). On glasses the mic keeps streaming in real time until Mentra's final arrives, which mitigates it. | Logged as [WednesdayAI-core#1023](https://github.com/ExpansionX/WednesdayAI-core/issues/1023); fallback works; limitation documented in the app README. |
| E-02 | Medium | WednesdayAI-core | On a Tailscale-serve gateway, a setup code does not auto-pair a new device: transport auth succeeds first, so bootstrap redemption is skipped and the device needs `devices approve` plus a rescan. | Logged as [WednesdayAI-core#1022](https://github.com/ExpansionX/WednesdayAI-core/issues/1022); workaround documented in the app README (`cde918f`). |
| E-03 | Low | Pre-existing | Plain `npm run build` bundled development React (404 KB vs 188 KB). `pack`/`release` were unaffected. | Fixed in `e9d24d6`. |
| E-04 | Info | Pre-existing | Background connect sent an empty `packageName`. | Fixed in `468c960`: passed from `miniapp.json`. |
| E-05 | Info | Pre-existing | `icon.png` was a 1×1 placeholder. | Fixed in `010d68a`: 192×192 WednesdayAI icon. |
| E-06 | Info | This branch | 23 `no-useless-spread` lint warnings in a test. | Fixed in `cf3a853`. |
| E-07 | Info | Environment | Dev gateway has no model or transcription provider, so those steps fail cleanly there. | Not an app defect; covered by the real-gateway run. |

Final run at `e0db270`: 387/387 tests (coverage 99.96 / 97.73 / 99.56 / 99.96), strict `tsc` and `oxlint` clean, build, pack, schema and both bundle execution tests pass. On the real gateway: pair (after approval, E-02), wake words, 19 agents, chat reply, gateway transcript for the clip with trailing speech pause, clean fallback path for the clipped one (E-01), and device-token reconnect all pass. All test devices were removed from the gateway.
