---
workstream: glasses-platform
doc_type: plan
title: "Owned Even Hub on Even G2: decision and roadmap"
status: planned
id: 2026-10-13-glasses-platform-exploration
created: 2026-10-13
updated: 2026-10-13
authors: [agent]
---

# Owned Even Hub on Even G2: decision and roadmap

## Context

The target is an "owned Even Hub" on Even G2: our AI, transcription, memory, home screen and notifications. The platform is an iOS phone + G2 glasses, with MentraOS replacing the Even app. MentraOS drives the stock G2 firmware and renders miniapps into one EvenHub page; the firmware keeps the dashboard, notification rendering, "Hey Even" and sleep. Evidence and verdicts for Q1-Q7 are in [options.md](options.md).

## Decision

- **Own now, as a miniapp (`apps/mentra-glass`):** AI, memory, wake via STT, own STT, our glance frame, an Android notification renderer, firmware notification tuning (global settings only).
- **Needs upstream MentraOS PRs:** G2 head-up event, "Hey Even" forwarding, dashboard widget content API, menu-selected event, assistant role (#3).
- **Not reachable on stock iOS + G2:** phone-side notification text from other apps, cross-app widget sharing.
- **Unmeasured:** whether the glasses reach native low-power idle while MentraOS keeps the EvenHub page (#14).

## Roadmap

### Phase A: miniapp only

|Id|Item|Issue|Acceptance (observable on device)|
|---|---|---|---|
|A1|Glance frame on tilt: time + agent status + queued notification count. Ships only if V2 shows it coexists with the firmware tilt dashboard (MentraOS cannot turn firmware tilt off). If not, add a head-up switch setting to B1.|#12|Tilting the head up past the threshold shows the frame within one display tick; it clears after `durationMs`.|
|A2|Notification queue renderer. Android first. iOS: firmware history-only mode is global, so it also stops popups from every non-mirrored app in the firmware whitelist. Document it as an explicit operator trade-off, to enable only once the gateway mirror works; until #8 lands, iOS keeps firmware popups.|#13|On Android with Notify stopped, three notifications arriving together show one at a time, each scrolled in full, then the next.|
|A3|Own STT after wake|#15|After wake, the utterance is transcribed by the gateway; Mentra STT is used only when the gateway is unreachable.|
|A4|Idle-power measurement|#14|Battery drain per hour recorded for MentraOS connected + blank vs Even app idle.|
|A5|Device spike of the hidden dashboard path|#11|With `use_native_dashboard` off, a temple double-tap shows our `view:"dashboard"` frame (V1).|
|A6|`apps/mentra-glass` README note: do not pin WednesdayAI in the glasses menu|#16|README states the note in both languages.|

### Phase B: upstream PRs, in order

|Id|Item|Branch|Issue|Acceptance (observable on device)|
|---|---|---|---|---|
|B1|G2 head-up from IMU pitch (plus a head-up switch setting if V2 shows a conflict with the firmware tilt dashboard)|`wai/g2-head-up-pitch`|#12|`session.imu.onHeadPosition` fires "up"/"down" on G2 when the head tilts.|
|B2|"Hey Even" wake forwarding as a `wakeword` stream|`wai/g2-hey-even-wakeword`|#3, #4|Saying "Hey Even" delivers a `wakeword` event to a subscribed miniapp and the EvenHub page stays visible (V4).|
|B3|Menu-selected event to running apps|`wai/menu-selected-event`|#16|Selecting a running background app in the glasses menu delivers an event and the app keeps running.|
|B4|Dashboard widget content API|`wai/dashboard-widget-content`|#11|`dashboard.setContent()` text appears in a firmware dashboard widget slot.|
|B5|sherpa KWS `session.wake`, only if B2 is rejected or a custom keyword is required|`wai/sherpa-kws-wake`|#4|A custom keyword triggers `session.wake` without STT running.|
|B6|Assistant role|`wai/assistant-role`|#3|A user-chosen assistant miniapp receives wake events in place of the Mentra AI.|

Order reason: the smallest diffs in the lowest-churn driver files go first. B4 comes last among the display items because it needs protocol reverse-engineering.

## MentraOS fork workflow

Repo: [`ExpansionX/MentraOS`](https://github.com/ExpansionX/MentraOS) (Apache-2.0), forked from `Mentra-Community/MentraOS`.

- `dev` mirrors upstream only. Sync with `gh repo sync ExpansionX/MentraOS --branch dev`. Never commit to it.
- One branch per hook off `dev`, named `wai/<slug>` (branch names in the Phase B table).
- Each branch carries its tests in upstream's existing homes: iOS XCTest `mobile/modules/bluetooth-sdk/ios/Tests/` (next to `G2TextTests.swift`), Android `mobile/modules/bluetooth-sdk/android/src/test/java/com/mentra/bluetoothsdk/`, engine vitest `mobile/modules/engine/src/services/__tests__/`.
- Upstream PR: from `ExpansionX:wai/<slug>` to `Mentra-Community/MentraOS:dev`, one hook per PR (`CONTRIBUTING.md:3`).
- Device builds: branch `wai/device` is recreated from `dev` by merging every open `wai/*` branch (never rebased by hand). Build it with your own Apple team + Mapbox token (`mobile/app.config.ts:71-86,177-180`). Never distributed.
- Local clone `~/Code/MentraOS`; worktrees `~/Code/.worktrees/MentraOS/<slug>`. The reference clone `~/Code/reference/glass/MentraOS` stays read-only.
- Keep hook diffs in `LocalMiniappRuntime.ts` and `protocol.ts` to ≤20 lines each, because those files churn 59 and 17 commits/30d.
- When upstream merges a hook, delete its `wai/*` branch.

## Device verification checklist

- **V1:** the hidden dashboard path renders on G2 after the Super Settings toggle + double-tap (#11).
- **V2:** real `onAccel` sample rate per pace code and tilt-to-glance latency. Also check whether the firmware tilt dashboard covers an EvenHub frame and sends eventType 4/5 (#12).
- **V3:** `durationMs` expiry timing while the iOS app is backgrounded (`mobile/modules/engine/src/services/LocalDisplayManager.ts:12-16` notes JS timers stall when suspended).
- **V4:** with "Hey Even" re-enabled, whether `EVEN_AI_WAKE_UP` reaches the host and whether the stock Even AI UI displaces the EvenHub page (B2).
- **V5:** battery per hour, connected + blank vs Even app idle (#14).
- **V6:** whether G2 sends `NOTIFICATION_IOS` (app identity) for every incoming iOS notification or only after "show notifications" (`mobile/modules/bluetooth-sdk/ios/Source/sgcs/G2.swift:894-899` comment). If per notification, it can trigger the miniapp to pull the mirrored message from the gateway (#13).
- **V7:** stock firmware truncation length, and behaviour at 30 s duration in history-only mode (#13).
