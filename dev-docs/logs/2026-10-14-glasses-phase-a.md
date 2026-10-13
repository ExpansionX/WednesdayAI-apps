---
workstream: glasses-platform
doc_type: log
title: "Glasses platform Phase A: glance, notifications and gateway transcription"
status: active
id: 2026-10-14-glasses-phase-a
created: 2026-10-14
updated: 2026-10-14
authors: [agent]
---

## Summary

The WednesdayAI miniapp on MentraOS display glasses gains a head-tilt glance, a queue of notifications from apps you choose (Android), and transcription of the spoken question on the WednesdayAI gateway, with Mentra's transcript as the fallback.

## Goal

Phase A of the glasses-platform roadmap ([plan](../workstreams/glasses-platform/plans/2026-10-13-glasses-platform-exploration/plan.md)): own more of the glasses experience inside the miniapp, without MentraOS host changes. It covers issues #12 (tilt), #13 (notifications), #15 (own speech-to-text) and #16 (menu toggle note).

## Changes

- `apps/mentra-glass/src/background/tilt.ts`, `glance.ts`: tilt-up detector with a hold time and hysteresis; glance text (time, connection status, queued count).
- `apps/mentra-glass/src/background/notifications.ts`, `notificationPresenter.ts`: bounded queue (20, same-id replace) and a paged presenter (160 characters per page, 4 s per page).
- `apps/mentra-glass/src/background/gatewayStt.ts`: question capture over `talk.session.create` / `appendAudio` / `close`. Keeps 1.5 s of pre-roll, waits for `session.ready`, sends bounded ordered appends, and holds off a new session until the old one is retired.
- `apps/mentra-glass/src/background/glassesView.ts`: `glance` and `notification` frames, header override, auto-clear and accepted-render callbacks.
- `apps/mentra-glass/src/background/AssistantController.ts`: display ownership (assistant > notification > glance), notification intake and seen-app persistence, gateway transcription with Mentra fallback.
- `apps/mentra-glass/src/background/wake.ts`: `findWake` for wake words in the middle of a transcript.
- `apps/mentra-glass/src/shared/channels.ts`, `src/gateway/constants.ts`, `src/ui/App.tsx`: settings `querySttMode` and `notificationApps`, the `notifications:allow` message, and two phone settings cards.
- `apps/mentra-glass/miniapp.json`: `READ_NOTIFICATIONS` permission and optional `IMU` hardware.
- `apps/mentra-glass/scripts/smoke-gateway.ts`: `--stt-pcm <file>` end-to-end transcription check.
- `apps/mentra-glass/README.md`, `README.zh-CN.md`: glance, notifications, transcription, privacy and admin notes.
- `apps/mentra-glass/src/ui/App.test.tsx` (`099fbc5`): phone UI tests under happy-dom (`@testing-library/react`, `@testing-library/dom`, `happy-dom`); coverage now includes `src/ui/App.tsx` (23 tests, 100%), and the controller tests' `flush()` helper is fake-timer only (`vi.advanceTimersByTimeAsync(0)`).
- Cleanup (`dabc8ba`): removed 7 unreachable guards and the write-only `currentQuery` field; no behaviour change.

## Impact

- Background miniapp only. No MentraOS host or gateway changes.
- Uses the existing gateway client scopes: `talk.session.*` falls under `operator.write`. Gateway transcription needs a transcription provider on the gateway; without one the user sees "WednesdayAI transcription unavailable" once and Mentra's transcript is used.
- New storage key `wai.notificationApps.v1`. `wai.settings.v1` gains two fields; old stored settings load with defaults.

## Benefits

- Glance at the time and status by tilting your head up, without speaking.
- Messages from the apps you choose, shown one at a time and paged in full.
- More accurate question transcription through your own gateway, with automatic fallback.

## References

- Implementation plan: [plan.md](../workstreams/glasses-platform/plans/2026-10-13-glasses-platform-phase-a/plan.md)
- Code review: [2026-10-14-code-review.md](../workstreams/glasses-platform/plans/2026-10-13-glasses-platform-phase-a/reviews/2026-10-14-code-review.md)
- Issues: #12, #13, #15, #16
