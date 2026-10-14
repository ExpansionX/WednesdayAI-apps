---
workstream: glasses-platform
title: "Glasses platform: owned Even Hub on Even G2 via MentraOS"
status: planned
owner: unassigned
staging_pointers: []
updated: 2026-10-13
---

# Glasses platform

Intent: an "owned Even Hub" on Even G2 (iOS phone). WednesdayAI provides the AI, transcription, memory, glance screen and notification renderer as a MentraOS miniapp, and pushes the few host hooks it needs upstream through the [`ExpansionX/MentraOS`](https://github.com/ExpansionX/MentraOS) fork.

- Plan: [plans/2026-10-13-glasses-platform-exploration/plan.md](plans/2026-10-13-glasses-platform-exploration/plan.md)
- Options and evidence: [options.md](plans/2026-10-13-glasses-platform-exploration/options.md)

Findings (`ExpansionX/WednesdayAI-apps`):

- #1 Miniapp secrets stored in plain session.storage (no secure storage API)
- #2 forceLocal transcription is silent when the offline model is missing
- #3 No default-assistant slot; system interop is provenance-gated
- #4 Replace always-on STT wake detection with an acoustic keyword spotter
- #5 Measure display contention with Notify's background display lock
- #6 Translation and notes via WednesdayAI
- #7 Voice replies on speaker glasses via WednesdayAI talk TTS
- #8 Proactive agent→glasses push (node role + canvas.present)
- #9 Miniapp SDK apps cannot be distributed via the Mentra Miniapp Store
- #11 Own the G2 home: firmware dashboard overlays and the "dashboard" view
- #12 Tilt-to-glance on G2: firmware tilt is internal, raw accelerometer is exposed
- #13 Messaging notification queue: show, scroll, hide, next
- #14 Measure G2 idle power while MentraOS keeps the EvenHub page
- #15 Own STT: stream glasses audio to WednesdayAI instead of Mentra transcription
- #16 Firmware dashboard menu toggles our background miniapp off

Related: shipped background miniapp `apps/mentra-glass` (#10); WednesdayAI-core gateway client id `openclaw-mentra-node` (core #1001).

Calendar: parked, out of scope.
