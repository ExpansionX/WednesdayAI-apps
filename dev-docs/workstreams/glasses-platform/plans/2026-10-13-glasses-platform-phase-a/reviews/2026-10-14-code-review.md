---
workstream: glasses-platform
doc_type: review
title: "Glasses platform Phase A: code review and remediation"
status: active
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
| L-05 | Medium | `src/ui/App.tsx` has no tests; the package has no DOM test setup. | M | Belongs to the unit-test step. |
| L-06 | Info | An audio chunk larger than `MAX_APPEND_BYTES` is sent alone, not split. | XS | Ruling: chunks are about 3.2 KB in practice. A chunk over the gateway limit (about 393 KB) would fall back to Mentra. |
| L-07 | Info | When `finish()` is pending and `session.error` arrives, the capture sends `talk.session.close` before the following `session.closed`. The server may already have dropped the session, and the error reply is ignored. | XS | Kept from the earlier fix wave; the side effect is harmless. |
| L-08 | Low | Existing code, not this branch: the controller test helper `flush()` drains a fixed 20 microtasks, so it depends on await depth. | S | Belongs to the unit-test step. |

## Coverage gaps to address in the unit-test step

Statement and branch gaps from `vitest --coverage` at the end of remediation, by file (line numbers are at that commit):

- `src/background/AssistantController.ts`: uncovered statements 239, 240, 241, 453, 454, 548, 549, 672, 673; partially covered branches 163, 199, 209, 228, 238, 264, 320, 322, 337, 354, 364, 449, 462, 480, 504, 535, 537, 538, 540, 547, 611, 671, 678, 681, 692, 712, 716, 722, 732, 792, 852, 854, 918, 944, 948, 953
- `src/background/gatewayStt.ts`: uncovered statements 280, 281; partially covered branches 190, 219, 241, 271, 279, 301, 343, 422, 470, 481, 508, 527
- `src/background/glassesView.ts`: uncovered statements none; partially covered branches 194
- `src/background/notificationPresenter.ts`: uncovered statements none; partially covered branches 73, 82, 95, 119, 131, 161, 162
- `src/background/notifications.ts`: uncovered statements none; partially covered branches 108
- `src/background/wake.ts`: uncovered statements none; partially covered branches 123, 132
- `src/ui/App.tsx`: not in coverage collection (no UI test setup; see L-05).

## Verification

At `d7a4a3e`, from the repo root:

- `npm run glass:coverage`: 319/319 tests pass. Statements 99.52%, branches 93.58%, functions 99.53%, lines 99.52% (thresholds 80%).
- `npm run glass:typecheck` and `npm run build -w @wednesdayai/mentra-glass`: both succeed.
- `tsc --noEmit --noUnusedLocals --noUnusedParameters`: clean.
- Re-reviews: round 1 found three new defects (P1–P3) and partial fixes for A-02 and D4. Round 2 confirmed all six fixed. Round 3 cleared a leftover snapshot push. Final verdict: correct, no new breakage.

Fix commits: `f5ee273`, `466e4a3`, `f4c6067`, `a991812`, `0d15d87`, `60be13d`, `aacfec0`, `d7a4a3e`.
