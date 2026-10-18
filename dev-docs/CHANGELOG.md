# Narrative changelog

Narrative index of feature work. Full history lives in the linked dev logs.

### [2026-10-15] Fix: wake word repeated or split; glasses trace mode

When you said a wake word, paused, then repeated it with your question, your agent received the second wake word as part of the question. With gateway transcription on, it now gets only the question. A wake word that speech-to-text splits ("open claw" for "openclaw") now wakes the assistant. The glasses no longer stay on Thinking when the gateway acknowledges a question with an empty reply. Developers can run `MENTRA_PUBLIC_TRACE=1 bun run dev` to see transcripts, wake decisions, the gateway transcript, `chat.send` requests and assistant frames in the terminal.

**Benefits:** cleaner questions to the agent; on-device behaviour visible without a debugger.

**Bug Fixes:** repeated wake word no longer reaches the agent (gateway transcription); split wake words match; an empty `chat.send` reply shows an error instead of hanging.

**Breaking Changes:** None

**Author:** agent

[Full development log](logs/2026-10-15-glasses-trace-and-wake-fix.md)

### [2026-10-14] Feature: glasses glance, notifications and gateway transcription

The WednesdayAI miniapp for MentraOS display glasses shows a glance when you tilt your head up, and shows notifications from apps you choose on Android, one at a time and paged. It also transcribes the question after the wake word on your WednesdayAI gateway, falling back to Mentra's transcript. Whether the glance coexists with the glasses' own tilt dashboard is unverified until operator check V2 passes.

**Benefits:** hands-free glance at time and status; chosen notifications on the glasses; more accurate question transcription through your own gateway.

**Bug Fixes:** None

**Breaking Changes:** None

**Author:** agent

[Full development log](logs/2026-10-14-glasses-phase-a.md)
