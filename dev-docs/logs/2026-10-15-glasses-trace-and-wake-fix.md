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

A build-time trace mode prints every assistant input and output to the `mentra-miniapp dev` terminal. The first live trace on Even G2 + iPhone found a bug: the gateway transcript of a bare wake word followed by a retry ("Computer? Computer, what time is it?") reached the agent with the second wake word still in the question. Repeated leading wake words are now dropped.

## Goal

See what the glasses hear and send, without a debugger on the phone, to diagnose "wake words listed but no interaction" reports.

## Changes

- `apps/mentra-glass/src/background/trace.ts`: `trace(event, data)` writes `[trace] <event> <json>` through `console.log`, which the dev sidecar forwards from the background JSContext. Off unless built with `MENTRA_PUBLIC_TRACE=1`.
- `apps/mentra-glass/build.ts`: always inlines `process.env.MENTRA_PUBLIC_TRACE` (empty by default), so a normal build has no live `process` reference.
- `apps/mentra-glass/src/background/wake.ts`: `findWake` drops wake phrases (with optional greeting) repeated at the start of the query. A trigger word heard split into two or three words ("open claw" for `openclaw`, observed 15:20:01) now matches.
- `apps/mentra-glass/AGENTS.md`, `README.md`, `README.zh-CN.md`: the `MENTRA_PUBLIC_TRACE=1 bun run dev` command; AGENTS.md records the `process.env.MENTRA_PUBLIC_*` exception to the no-`process` rule.

## Verification

- `npm run test:coverage` in `apps/mentra-glass`: 393 tests pass; new cases `drops a repeated wake phrase from the query`, `matches a trigger word that speech-to-text split into parts`, `does not match split parts with a word between them or a longer join`.
- Bundle check: `TRACE_ENABLED = false` by default, `true` with the flag; no `process.` in `dist/background/index.js`.
- Live, Even G2 + iPhone, 2026-10-15: before the fix, `chat.send` carried "Computer, what time is it?"; after it, 15:19:33 `gateway-stt` "Computer, what's the weather?" sent `chat.send` "what's the weather?".

## Impact

- Trace mode is off in normal builds. Trace builds log transcripts and answers to the dev terminal only.
- A question that genuinely starts with a wake word ("computer, claude is …") loses that word. Accepted for wake-word UX.

## Open items

- Device turns go to `agent:main:main` instead of the user's direct session: needs a gateway change. Plan: [plans/2026-10-15-device-session-key/plan.md](../workstreams/glasses-platform/plans/2026-10-15-device-session-key/plan.md).
- The split-word match is unit-tested only; no live "open claw" run yet.
