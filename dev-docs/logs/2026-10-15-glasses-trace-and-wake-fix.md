---
workstream: glasses-platform
doc_type: log
title: "Glasses: dev trace mode and repeated wake-word fix"
status: shipped
id: 2026-10-15-glasses-trace-and-wake-fix
created: 2026-10-15
updated: 2026-10-15
authors: [agent]
---

## Summary

A build-time trace mode prints the assistant's main inputs and outputs to the `mentra-miniapp dev` terminal. The first live trace on Even G2 + iPhone found two wake-word bugs. First, the gateway transcript of a bare wake word followed by a retry ("Computer? Computer, what time is it?") reached the agent with the second wake word still in the question. Second, "openclaw" was heard as "open claw" and never matched. Both are fixed. A code review then found and fixed three more defects in the same changes.

## Goal

See what the glasses hear and send, without a debugger on the phone, to diagnose "wake words listed but no interaction" reports.

## Changes

- `apps/mentra-glass/src/background/trace.ts`: `trace(event, data)` writes `[trace] <event> <json>` through `console.log`, which the dev sidecar forwards from the background JSContext. Off unless built with `MENTRA_PUBLIC_TRACE=1`.
- `apps/mentra-glass/build.ts` + `scripts/build-flags.ts` (`traceDefine`): always inlines `process.env.MENTRA_PUBLIC_TRACE`, so a normal build has no live `process` reference. It is `"1"` only when the flag is exactly `"1"` and `NODE_ENV` is not `production`.
- `apps/mentra-glass/src/background/wake.ts`: a trigger word heard split into two or three words ("open claw" for `openclaw`, observed 15:20:01) now matches. Among the triggers that match at a position, the one spanning the most transcript wins, whatever the configured order. `dropLeadingWakes` strips repeated leading wake phrases.
- `apps/mentra-glass/src/background/AssistantController.ts`: the gateway transcript's query has repeated wake phrases stripped only when Mentra's query does not itself start with a wake word, so "Wednesday, computer science …" keeps "computer". A superseded or disposed `chat.send` is dropped before its payload is read. An empty `chat.send` payload shows "Gateway sent an empty reply" instead of leaving Thinking on screen.
- `apps/mentra-glass/AGENTS.md`, `README.md`, `README.zh-CN.md`: the `MENTRA_PUBLIC_TRACE=1 bun run dev` command; AGENTS.md records the `process.env.MENTRA_PUBLIC_*` exception to the no-`process` rule.

## Verification

- `npm run test:coverage` in `apps/mentra-glass`: 414 tests pass; `wake.ts` and `trace.ts` 100%, all files 99.96% lines. `trace.test.ts` and `scripts/build-flags.test.ts` cover the trace line format and the production gate. Controller and matcher cases cover:
  - the repeated wake word in the gateway transcript;
  - a gateway question that starts with another wake word;
  - split trigger words;
  - longest span regardless of trigger order;
  - `dropLeadingWakes`;
  - a stale send with no payload;
  - an empty or non-object `chat.send` payload;
  - a superseded send's empty ack;
  - the three-part split boundary (four parts do not match).
- Bundle check: `TRACE_ENABLED = false` by default, `true` with the flag; no `process.` in `dist/background/index.js`.
- Live, Even G2 + iPhone, 2026-10-15: before the fix, `chat.send` carried "Computer, what time is it?"; after it, 15:19:33 `gateway-stt` "Computer, what's the weather?" sent `chat.send` "what's the weather?".

## Impact

- Trace mode is off in normal builds. Trace builds log transcripts and answers to the dev terminal only.
- The repeated-wake fix applies to the gateway transcript path. Without gateway transcription, a single Mentra transcript holding both wake words still sends the second one. Stripping it there would also strip "computer" from "Wednesday, computer science …".
- `pack`/`release` build with `NODE_ENV=production`, and `build.ts` forces trace off there even if `MENTRA_PUBLIC_TRACE=1` is set in the shell or `.env`.

## Open items

- Device turns go to `agent:main:main` instead of the user's direct session: needs a gateway change. Plan: [plans/2026-10-15-device-session-key/plan.md](../workstreams/glasses-platform/plans/2026-10-15-device-session-key/plan.md).
- The split-word match is unit-tested only; no live "open claw" run yet.
- Logged: [#38](https://github.com/ExpansionX/WednesdayAI-apps/issues/38) Mentra-only repeated wake; [#39](https://github.com/ExpansionX/WednesdayAI-apps/issues/39) split matching widens false wakes.
