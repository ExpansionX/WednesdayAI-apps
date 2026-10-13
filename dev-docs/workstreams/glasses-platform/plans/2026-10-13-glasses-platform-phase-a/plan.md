---
workstream: glasses-platform
doc_type: plan
title: "Glasses platform Phase A: implementation plan"
status: active
id: 2026-10-13-glasses-platform-phase-a
created: 2026-10-13
updated: 2026-10-13
authors: [agent]
---

# Glasses Platform Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, run by the omp controller session. Dispatch every implementer and reviewer with the omp `task` tool, using the agent and effort in **Execution** below. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Phase A miniapp features to `apps/mentra-glass`: a head-tilt glance frame (A1), an app-allowlisted Android notification queue (A2), WednesdayAI-gateway transcription of the spoken question after the wake word (A3), and the README note about the glasses menu (A6).

**Architecture:** Each feature has its own pure module with its own tests: `tilt.ts`, `glance.ts`, `notifications.ts` + `notificationPresenter.ts`, and `gatewayStt.ts`. `AssistantController` wires them to the session. It decides which frame owns the display, in priority order assistant > notification > glance. `GlassesView` gains `glance` and `notification` frame types. Gateway STT uses the existing gateway WebSocket methods `talk.session.create` / `talk.session.appendAudio` / `talk.session.close` and the `talk.event` event, all already allowed for the `openclaw-mentra-node` scopes (`operator.read`, `operator.write`).

**Tech Stack:** TypeScript 5.9, `@mentra/miniapp` 3.2.1 (background JSContext), React 19 phone UI, vitest 3 with v8 coverage, bun build.

**Spec:** `dev-docs/workstreams/glasses-platform/plans/2026-10-13-glasses-platform-exploration/plan.md` (Phase A table) and `options.md` (evidence). Issues: #12 (tilt), #13 (notifications), #15 (own STT), #16 (menu toggle).

## Context

The user asked for an executable implementation plan for Phase A of the glasses-platform roadmap, scoped to code in `apps/mentra-glass`. Their decisions:

- The tilt glance is **always on**.
- Question transcription defaults to the **WednesdayAI gateway** and falls back to Mentra.
- Notifications use a phone-UI **app allowlist**.

A4 (power measurement), A5 (dashboard spike) and device checks V1–V7 need the glasses. They stay with the operator: see **Operator device checks**. Phase B (MentraOS fork branches) is out of scope. Do not push, and do not open or merge a PR: the user runs the final steps.

## Global Constraints

- Work in `/Users/david/Code/.worktrees/WednesdayAI-apps/shearwater` on local branch `davidrudduck/glasses-phase-a`. Never push. Never run `gh pr` or merge.
- Run commands from the repo root: `npm run glass:test`, `npm run glass:typecheck`, `npm run glass:coverage`, `npm run build -w @wednesdayai/mentra-glass`.
- Coverage thresholds stay at 80/80/80/80 (`apps/mentra-glass/vitest.config.ts`).
- Background code (`src/background/`, `src/gateway/`) runs in a bare JS engine: no `window`, `document`, `performance`, `crypto.subtle`, `crypto.randomUUID`, `URL`, `URLSearchParams`, Node built-ins or `process`. `setTimeout`/`clearTimeout`, `Date`, `btoa`/`atob`, `Math` are available.
- Style: `.prettierrc.json` (no semicolons, `bracketSpacing: false`, printWidth 120, double quotes). Prettier is not installed: match by hand.
- Commits: Conventional Commits, imperative mood. Never add AI co-author trailers or "Generated with" lines.
- The user-facing product name is "WednesdayAI".
- Any `README.md` change needs the matching `README.zh-CN.md` change. This applies to `apps/mentra-glass/README*` too.
- Read-only: `~/Code/reference/glass/**`, `~/Code/WednesdayAI-core`.
- Tests live next to the code as `src/**/*.test.ts`. Use `vi.useFakeTimers()` for timer behaviour, following the existing `glassesView.test.ts` / `AssistantController.test.ts`.

## Review Focus

1. **Talk-session leaks.** Every `talk.session.create` must end in a `talk.session.close`, whether through finish, abort, connection drop or dispose. The gateway allows one transcription session per connection, so one leak makes every later create fail with CONFLICT. Owned by Task 4 (`abort while opening closes the session once created`, `dispose closes an open session`).
2. **Painting after disconnect.** An awaited gateway transcript that resolves after `session.on("disconnect")` must not send chat or render. Owned by Task 7 (`disconnect while awaiting the gateway transcript sends nothing`).
3. **Display lock contention.** A glance or notification must never take the display from a live assistant frame (listening/thinking/streaming) or a visible final frame. Owned by Task 6 (`tilt up is ignored while an assistant frame is up`, `wake word interrupts a notification and the notification resumes after cancel`).
4. **Notification storms and reposts.** More than 20 queued notifications drop the oldest. An Android repost with the same id replaces the queued entry instead of duplicating it. Owned by Task 3.
5. **Non-PCM audio.** LC3 chunks and chunks not at 16 kHz must never reach `talk.session.appendAudio`. Owned by Task 4 (`ignores lc3 and non-16k chunks`).

## Execution

The controller is the omp session that runs this plan:

- Use superpowers:subagent-driven-development, with its scripts under `skill://subagent-driven-development/scripts/` (`sdd-workspace`, `task-brief`, `review-package`).
- Implementers run strictly one at a time; never in parallel.
- Implementers never spawn subagents.
- Pass reviewers the **Global Constraints** block verbatim.

|Task|Implementer (`task` tool)|Task reviewer|
|---|---|---|
|0|controller itself (no dispatch)|—|
|1 GlassesView frames|`agent: "task"`, `effort: "lo"`|`agent: "reviewer"`, `effort: "lo"`|
|2 Tilt detector|`agent: "task"`, `effort: "lo"`|`agent: "reviewer"`, `effort: "lo"`|
|3 Notification queue + presenter|`agent: "task"`, `effort: "med"`|`agent: "reviewer"`, `effort: "med"`|
|4 Gateway STT capture|`agent: "task"`, `effort: "med"`|`agent: "reviewer"`, `effort: "med"`|
|5 Settings, channels, manifest|`agent: "task"`, `effort: "lo"`|`agent: "reviewer"`, `effort: "lo"`|
|6 Controller: glance + notifications|`agent: "task"`, `effort: "med"`|`agent: "reviewer"`, `effort: "med"`|
|7 Controller: gateway STT|`agent: "task"`, `effort: "hi"`|`agent: "reviewer"`, `effort: "med"`|
|8 Phone UI|`agent: "task"`, `effort: "lo"`|`agent: "reviewer"`, `effort: "lo"`|
|9 README (A6 + new features)|`agent: "task"`, `effort: "lo"`|`agent: "reviewer"`, `effort: "lo"`|
|Final whole-branch review|—|`agent: "reviewer"`, `effort: "hi"`|

- Fix rounds 4–5 use `effort` one step higher than the task's implementer row.
- The final review's merge base is `7774dfd`, the head of `davidrudduck/shearwater` when this plan was written.
- After the final review and its single fix wave, stop. Report the branch, the commit list, the "Rulings I made" list, and the operator device checks. Do not run the push/PR/merge options of superpowers:finishing-a-development-branch.

## Tasks

### Task 0: Branch, plan copy, baseline (controller)

- [ ] **Step 1:** Run `git switch -c davidrudduck/glasses-phase-a`. If the branch exists, `git switch davidrudduck/glasses-phase-a` and resume from the ledger instead.
- [ ] **Step 2:** Write this plan to `dev-docs/workstreams/glasses-platform/plans/2026-10-13-glasses-platform-phase-a/plan.md`, prefixed with this frontmatter:
  ```yaml
  ---
  workstream: glasses-platform
  doc_type: plan
  title: "Glasses platform Phase A: implementation plan"
  status: active
  id: 2026-10-13-glasses-platform-phase-a
  created: 2026-10-13
  updated: 2026-10-13
  authors: [agent]
  ---
  ```
  Commit it: `git add dev-docs && git commit -m "docs(glasses-platform): Phase A implementation plan"`. That file is the `PLAN_FILE` for every SDD script.
- [ ] **Step 3:** Baseline: `npm run glass:test && npm run glass:typecheck`. Expected: both pass. If they fail, stop and report the pre-existing failure.
- [ ] **Step 4:** Run `bash <sdd scripts>/sdd-workspace dev-docs/workstreams/glasses-platform/plans/2026-10-13-glasses-platform-phase-a/plan.md`. Create the ledger and run the pre-flight scan per the skill.

### Task 1: GlassesView glance and notification frames

**Files:**
- Modify: `apps/mentra-glass/src/background/glassesView.ts`
- Test: `apps/mentra-glass/src/background/glassesView.test.ts`

**Interfaces:**
- Produces:
  - `export type GlassesPhase = "listening" | "thinking" | "streaming" | "final" | "error" | "offline" | "glance" | "notification"`
  - `GlassesViewModel` gains `header?: string`. When set, it replaces the whole header text; when unset, the header is built exactly as today.
  - `export const GLANCE_HIDE_MS = 5000`
  - `export const NOTIFICATION_HIDE_MS = 6000`
  - `export interface GlassesViewOptions { onAutoClear?: () => void }`
  - `constructor(session: MiniappSession, options: GlassesViewOptions = {})`

- [ ] **Step 1: Write failing tests** in `glassesView.test.ts`. Reuse `FakeDisplayHost`/`asSession` and fake timers.
  - `glance frame auto-clears after 5 s and reports onAutoClear once`: show `{phase: "glance", agentLabel: "Main", body: "14:05\nReady"}`. After the first render, advancing to 4999 ms past show gives no `render([])`. At 5000 ms the last render is `[]` and `onAutoClear` was called exactly once.
  - `notification frame auto-clears after 6 s`: same shape with `phase: "notification"` and 6000 ms.
  - `header override replaces the default header`: show `{phase: "notification", agentLabel: "", header: "Messages · Alice", body: "hi"}`. The `wai-header` text equals `"Messages · Alice"`.
  - `glance and notification bodies window from the start`: the `wai-body` `style.textWindow` is `"start"` for glance and notification, and `"end"` for `final`.
  - `hide() does not report onAutoClear`: show final, call `hide()`, advance 20 s. `onAutoClear` was called 0 times.
- [ ] **Step 2:** Run `npm run test -w @wednesdayai/mentra-glass -- src/background/glassesView.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - Add `glance: ""` and `notification: ""` to `STATUS_BY_PHASE`.
  - Choose the terminal hide duration by phase: offline → `OFFLINE_HIDE_MS`, glance → `GLANCE_HIDE_MS`, notification → `NOTIFICATION_HIDE_MS`, otherwise `FINAL_HIDE_MS`.
  - In `elements()`, use `vm.header ?? <existing header string>`, and `textWindow: "start"` for glance/notification.
  - Store `options.onAutoClear` and call it in `scheduleClear`'s timer right after `render([])`. Never call it from `hide()` or `dispose()`.
  - Update the file header comment for the two new phases.
- [ ] **Step 4:** Re-run the Step 2 command. Expected: PASS. All existing tests still PASS.
- [ ] **Step 5:** Commit: `feat(mentra-glass): glance and notification frames in GlassesView`.

### Task 2: Head-tilt detector and glance body

**Files:**
- Create: `apps/mentra-glass/src/background/tilt.ts`, `apps/mentra-glass/src/background/tilt.test.ts`
- Create: `apps/mentra-glass/src/background/glance.ts`, `apps/mentra-glass/src/background/glance.test.ts`

**Interfaces:**
- Produces (`tilt.ts`):
  ```ts
  export const TILT_UP_DEG = 25
  export const TILT_DOWN_DEG = 15
  export const TILT_HOLD_MS = 300
  /** Flip to -1 if device check V2 shows the glance firing on head-down. */
  export const PITCH_SIGN = 1
  export function pitchDegrees(sample: {x: number; y: number; z: number}): number
  export type TiltEvent = "up" | "down"
  export interface TiltDetectorOptions { upDeg?: number; downDeg?: number; holdMs?: number }
  export class TiltDetector {
    constructor(options?: TiltDetectorOptions)
    onSample(sample: AccelData): TiltEvent | null // AccelData from "@mentra/miniapp/background"
    reset(): void
  }
  ```
- Produces (`glance.ts`): `export function glanceBody(now: Date, state: ConnectionState, queued: number): string`. `ConnectionState` comes from `../gateway/types`.

- [ ] **Step 1: Write failing tests.** Use the helper `sample(deg, ts) = {x: 0, y: Math.sin(rad), z: Math.cos(rad), timestamp: ts}`.
  - `pitchDegrees(sample(30, 0))` is close to 30 (`toBeCloseTo(30, 5)`).
  - `emits up once after the hold`: 30° at t=0/100/200 → `null`; t=300 → `"up"`; t=400 → `null`.
  - `emits down after the hold below the down threshold`: from the up state, 20° at t=400 → `null`. 10° at t=500/600/700 → `null`; t=800 → `"down"`.
  - `a dip below the up threshold restarts the hold`: 30° at 0 and 100, 20° at 200, 30° at 300/400/500 → `null`; 30° at 600 → `"up"`.
  - `non-finite samples are ignored without resetting`: 30° at 0, `{x: NaN, ...}` at 100 → `null`, 30° at 300 → `"up"`.
  - `glanceBody`:
    - `(new Date(2026, 9, 13, 9, 5), "connected", 0)` → `"09:05\nReady"`.
    - `(…, "offline", 1)` → `"09:05\nOffline\n1 notification"`.
    - `(…, "unpaired", 3)` → `"09:05\nNot paired\n3 notifications"`.
    - Status labels: connected `Ready`, connecting `Connecting…`, offline `Offline`, unpaired `Not paired`, repair_required `Pairing needs repair`.
- [ ] **Step 2:** Run `npm run test -w @wednesdayai/mentra-glass -- src/background/tilt.test.ts src/background/glance.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.**
  - `pitchDegrees = PITCH_SIGN * Math.atan2(y, Math.sqrt(x*x + z*z)) * 180 / Math.PI`.
  - The detector keeps `up: boolean` and `candidateSince: number | null`, and uses `sample.timestamp` for timing.
  - Not up: when pitch ≥ upDeg, set `candidateSince ??= ts`. When `ts - candidateSince >= holdMs`, set up, clear the candidate and return `"up"`. A sample below upDeg clears the candidate.
  - Up: mirror the same logic with pitch ≤ downDeg, returning `"down"`.
  - Ignore samples where any of x/y/z/timestamp is non-finite.
  - `glanceBody`: zero-pad `HH:MM` from `getHours()`/`getMinutes()`, then the status label, then the count line only when `queued > 0`. Join lines with `"\n"`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(mentra-glass): head-tilt detector and glance body`.

### Task 3: Notification queue and presenter

**Files:**
- Create: `apps/mentra-glass/src/background/notifications.ts` + `notifications.test.ts`
- Create: `apps/mentra-glass/src/background/notificationPresenter.ts` + `notificationPresenter.test.ts`

**Interfaces:**
- Consumes: `GlassesViewModel` from Task 1, with `phase: "notification"` and `header`.
- Produces (`notifications.ts`):
  ```ts
  export interface QueuedNotification { id: string; app: string; packageName: string; title: string; content: string }
  export const NOTIFICATION_QUEUE_LIMIT = 20
  export const NOTIFICATION_PAGE_CHARS = 160
  export function notificationFromEvent(data: PhoneNotificationData): QueuedNotification | null
  export function paginate(text: string, maxChars: number): string[]
  export class NotificationQueue {
    constructor(limit?: number) // default NOTIFICATION_QUEUE_LIMIT
    enqueue(item: QueuedNotification): void
    unshift(item: QueuedNotification): void
    shift(): QueuedNotification | null
    remove(id: string): boolean
    retain(keep: (item: QueuedNotification) => boolean): void
    get size(): number
  }
  ```
- Produces (`notificationPresenter.ts`):
  ```ts
  export const NOTIFICATION_PAGE_MS = 4000
  export interface NotificationSurface { canShow(): boolean; show(vm: GlassesViewModel): void; hide(): void }
  export class NotificationPresenter {
    constructor(surface: NotificationSurface, onChange?: () => void)
    add(item: QueuedNotification): void
    dismiss(id: string): void
    retain(keep: (item: QueuedNotification) => boolean): void
    interrupt(): void
    pump(): void
    get queued(): number   // waiting items, excluding the one on screen
    get showing(): boolean
    dispose(): void
  }
  ```

- [ ] **Step 1: Write failing tests.**
  - `notificationFromEvent`:
    - Trims title and content.
    - Returns `null` when both are empty or whitespace (the iOS shape), or when `packageName` is empty.
    - `id` = `notificationId`, or `` `${packageName}:${timestamp}` `` when `notificationId` is empty.
    - `app` = trimmed `app`, or `packageName` when empty.
  - `paginate`:
    - `""` → `[]`.
    - `"a  b\n c"` with 160 → `["a b c"]`.
    - 300 chars of 9-char words + spaces split at 160 → 2 pages, each ≤ 160 chars and breaking only at spaces.
    - One 400-char word at 160 → `[160, 160, 80]`-length slices.
  - `NotificationQueue`:
    - Enqueuing an existing id replaces it in place and keeps the size.
    - The 21st enqueue drops the oldest.
    - `unshift` puts the item first and removes any same-id entry.
    - `remove` returns false for unknown ids.
    - `retain` keeps only the matching items.
  - `NotificationPresenter` (fake timers; recording surface with `canShow` toggled by the test):
    - `shows notifications one at a time, paging each, then hides`: add A (short), B (300-char content), C (short) while `canShow` is true. The `show` headers in order are `"Messages · A"`, `"Messages · B (1/2)"`, `"Messages · B (2/2)"`, `"Messages · C"`, advancing 4000 ms between each. At 16000 ms `hide` was called once.
    - `waits while the surface is busy and resumes on pump`: `canShow` false → add → no `show`. Set `canShow` true and call `pump()` → the first page is shown.
    - `interrupt requeues the current notification at the front and restarts it at page 1`: B on page 2, `interrupt()`, then `pump()` → shows `"Messages · B (1/2)"`.
    - `dismissing the showing notification advances; dismissing a queued one removes it`.
    - `title-only notification uses the app as header and the title as body`: header `"Messages"`, body = the title.
    - `queued excludes the notification on screen`: three added → `queued === 2`. `onChange` is called on add, dismiss and advance.
    - `a repost of the showing notification does not restart it`: adding the same id while it is showing makes no new `show` call.
- [ ] **Step 2:** Run `npm run test -w @wednesdayai/mentra-glass -- src/background/notifications.test.ts src/background/notificationPresenter.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `paginate`: collapse whitespace runs to one space and trim. Pack words greedily up to `maxChars`. Hard-split any word longer than `maxChars`.
  - Queue `unshift`: if the limit is exceeded, drop the last item.
  - Presenter:
    - `pump()` starts the next item only when not showing, not disposed and `surface.canShow()`.
    - Starting an item builds the pages: `paginate(content || title, NOTIFICATION_PAGE_CHARS)`.
    - Header: `` `${app} · ${title}` `` when both content and title are non-empty, else `app`. Append `` ` (${i + 1}/${n})` `` when n > 1.
    - Each page: `surface.show({phase: "notification", agentLabel: "", header, body: page})`, then a `NOTIFICATION_PAGE_MS` timer to the next page.
    - After the last page, start the next queued item directly, or call `surface.hide()` when the queue is empty.
    - `interrupt()` clears the timer and requeues the current item at the front, without calling `hide`.
    - `dismiss` of the current item advances as if its last page had ended.
    - `retain` filters the queue and advances if the current item fails the filter.
    - Every queue-size change calls `onChange`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(mentra-glass): notification queue and paged presenter`.

### Task 4: Gateway STT capture

**Files:**
- Create: `apps/mentra-glass/src/background/gatewayStt.ts` + `gatewayStt.test.ts`
- Modify: `apps/mentra-glass/src/gateway/encoding.ts`. Create `apps/mentra-glass/src/gateway/encoding.test.ts`.
- Modify: `apps/mentra-glass/src/background/wake.ts` + `wake.test.ts`
- Modify: `apps/mentra-glass/scripts/smoke-gateway.ts`

**Interfaces:**
- Produces:
  - `encoding.ts`: `export function concatBase64(chunks: string[]): string`, implemented as `btoa(chunks.map((c) => atob(c)).join(""))`.
  - `wake.ts`: `export function findWake(text: string, triggers: string[]): {query: string} | null`. Like `matchWake`, but the trigger may start at any token. The earliest start position wins; at the same position the longest trigger wins. Extract the query-cut code in `matchWake` (`text.slice(tokens[consumed - 1].end).replace(/^[\s\p{P}]+/u, "")`) into a private helper shared by both. `matchWake` behaviour must not change.
  - `gatewayStt.ts`:
    ```ts
    export const PREROLL_MS = 1500
    export const AUDIO_FLUSH_MS = 250
    export const STT_RESULT_TIMEOUT_MS = 6000
    export const MAX_CAPTURE_MS = 20000
    export interface SttRequester { request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> }
    export interface GatewaySttCaptureOptions { requester: SttRequester; now?: () => number; onError?: (message: string) => void }
    export type CaptureState = "idle" | "opening" | "open" | "closing"
    export class GatewaySttCapture {
      constructor(options: GatewaySttCaptureOptions)
      get state(): CaptureState
      get active(): boolean            // state is "opening" or "open"
      pushChunk(chunk: AudioChunkData): void
      begin(sessionKey: string): void
      finish(): Promise<string | null>
      abort(): void
      onTalkEvent(payload: unknown): void
      dispose(): void
    }
    ```
- Wire facts (WednesdayAI-core, read-only):
  - `talk.session.create` params `{sessionKey, mode: "transcription", transport: "gateway-relay", brain: "none"}` → `{sessionId, audio: {inputEncoding: "pcm16", inputSampleRateHz: 16000, channels: 1}}` (`src/gateway/protocol/schema/talk-session.ts:137-170`).
  - `talk.session.appendAudio` params `{sessionId, audioBase64}`. `talk.session.close` params `{sessionId}`.
  - Event `talk.event` payload `{type, sessionId, seq, turnId?, final?, payload?}`. The terminals after close are either `transcript.done` with `payload: {text}`, or `session.error` (empty payload), always followed by `session.closed` (`src/gateway/talk-realtime-relay.ts:1180-1257`).
  - With no provider, create fails with `"no active transcription provider"`. A second concurrent transcription session on one connection fails with CONFLICT.

- [ ] **Step 1: Write failing tests.**
  - `encoding.test.ts`: `concatBase64([b64([1,2,3]), b64([4,5])])` decodes to bytes `[1,2,3,4,5]`. `concatBase64([])` → `""`.
  - `wake.test.ts`:
    - `findWake("so anyway hey wednesday what time is it", ["wednesday"])` → `{query: "what time is it"}`.
    - `findWake("nothing here", ["wednesday"])` → `null`.
    - `findWake("ok wednesday prime go", ["wednesday", "wednesday prime"])` → `{query: "go"}`.
  - `gatewayStt.test.ts`. Use fake timers, an injected `now`, and a fake requester that records `{method, params}` and answers from per-method responders that can return deferred promises.
    - `creates a transcription session with the exact params`.
    - `sends the last 1.5 s of pre-roll in the first append`: push 21 two-byte chunks at t=0,100,…,2000 (`format: "pcm_s16le"`, `sampleRate: 16000`), then `begin` at t=2000. The first `appendAudio` decodes to the 16 chunks from t=500..2000 (32 bytes), in order.
    - `batches live chunks every 250 ms`.
    - `ignores lc3 and non-16k chunks`: `format: "lc3"` or `sampleRate: 8000` → never appended. Chunks without `format`/`sampleRate` are accepted.
    - `finish closes the session and resolves the transcript.done text`: emit `{type: "transcript.done", sessionId: "s1", payload: {text: "  hello world "}}` → `"hello world"`.
    - `finish resolves null on session.error, on session.closed without a transcript, on empty text, and after 6000 ms`.
    - `create failure resolves finish with null and reports onError`: create rejects `Error("no active transcription provider")` → `onError` called with that message, `finish()` → `null`, state back to `"idle"`.
    - `abort while opening closes the session once created`: abort, then resolve create with `s1` → exactly one `talk.session.close {sessionId: "s1"}`, and no append.
    - `dispose closes an open session`.
    - `begin is ignored unless idle`: begin while closing makes no second create.
    - `events for another session are ignored`.
    - `auto-aborts after 20 s without finish` (a close request is sent).
- [ ] **Step 2:** Run `npm run test -w @wednesdayai/mentra-glass -- src/background/gatewayStt.test.ts src/gateway/encoding.test.ts src/background/wake.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `GatewaySttCapture`.**
  - `pushChunk`: drop chunks with empty `data`, with `format` set and not `"pcm_s16le"`, or with `sampleRate` set and not `16000`. Append `{at: now(), data}` to the pre-roll ring and drop entries older than `now() - PREROLL_MS`. While opening or open, also append to `pending`.
  - `begin` (only from idle):
    - Set state opening and `pending = [...ring]`.
    - Arm the `MAX_CAPTURE_MS` timer, which calls `abort()`.
    - Request create, keeping the outcome as a promise that `finish()` awaits.
    - On success while still opening: store `sessionId`, set state open, flush now, then flush every `AUDIO_FLUSH_MS`.
    - On success after an abort: send close and ignore errors.
    - On rejection: call `onError(message)` and mark the utterance failed, so `finish()` resolves null and resets to idle.
  - Flush: skip when `pending` is empty. Otherwise request `appendAudio` with `concatBase64(pending)` and clear `pending`. A rejected append calls `onError` and makes `finish()` resolve null.
  - `finish`:
    - Await the create outcome.
    - Stop the flush timer, do a final flush, set state closing, request close.
    - Resolve on the matching terminal event, or `null` after `STT_RESULT_TIMEOUT_MS`.
    - Always return to idle and clear timers.
  - `abort` / `dispose`:
    - Close any known session and ignore its later events.
    - Resolve a pending `finish` with `null`.
    - After dispose, `pushChunk`/`begin` are no-ops.
  - `onError` is never called for timeouts, empty transcripts or `session.error`.
- [ ] **Step 4: Extend `scripts/smoke-gateway.ts`** with an optional `--stt-pcm <path>`. The file is raw PCM16 LE, 16 kHz, mono; exit 2 with a usage message if its byte length is odd.
  - After the existing chat step, build a `GatewaySttCapture` with the script's connection as `requester`, and forward `talk.event` from the connection's `onEvent` hook to `onTalkEvent`.
  - `begin(sessionKey)`, then push 3200-byte slices as base64 with `format: "pcm_s16le"` and `sampleRate: 16000`, waiting 100 ms between slices.
  - `await finish()`. Print `stt: <text>`, or fail the step with `gateway transcription returned nothing`.
  - Update the script's header comment and usage line, and follow the script's existing step/timeout helpers.
- [ ] **Step 5:** Re-run Step 2's command and `npm run glass:typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat(mentra-glass): gateway speech-to-text capture over talk.session`.

### Task 5: Settings, channels, manifest

**Files:**
- Modify: `apps/mentra-glass/src/shared/channels.ts`, `apps/mentra-glass/src/gateway/constants.ts`, `apps/mentra-glass/src/background/AssistantController.ts` (settings code only), `apps/mentra-glass/miniapp.json`
- Test: `apps/mentra-glass/src/background/AssistantController.test.ts`

**Interfaces:**
- Produces:
  - `GlassSettings` = `{wakeSttMode: "local" | "cloud"; agentId: string | null; querySttMode: "gateway" | "mentra"; notificationApps: string[]}`.
  - `DEFAULT_SETTINGS = {wakeSttMode: "local", agentId: null, querySttMode: "gateway", notificationApps: []}`.
  - Channel `"settings:set": Partial<GlassSettings>` replaces the inline type.
  - `export interface NotificationAppOption { packageName: string; app: string }` in `channels.ts`, used by Task 6.
  - `export const NOTIFICATION_APPS_STORAGE_KEY = "wai.notificationApps.v1"` in `constants.ts`.

- [ ] **Step 1: Write failing tests** in `AssistantController.test.ts`.
  - `defaults query transcription to the gateway and no notification apps`: no stored settings → the snapshot settings include `querySttMode: "gateway"` and `notificationApps: []`.
  - `persists querySttMode and notificationApps`: `settings:set {querySttMode: "mentra", notificationApps: ["com.whatsapp"]}` → the stored JSON under `SETTINGS_STORAGE_KEY` contains both. A new controller on the same store shows both in its snapshot.
  - `sanitizes stored settings`: stored `{querySttMode: "bogus", notificationApps: [1, "a", "a", ""]}` → `"gateway"`, `["a"]`.
  - Existing tests that assert the full settings object get the two new fields in their expectations.
- [ ] **Step 2:** Run `npm run test -w @wednesdayai/mentra-glass -- src/background/AssistantController.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `loadSettings`: `querySttMode = parsed.querySttMode === "mentra" ? "mentra" : "gateway"`. `notificationApps` = string entries, trimmed, non-empty, de-duplicated in first-seen order. Non-arrays give `[]`.
  - `updateSettings` merges the two fields and runs the same sanitizer on a `notificationApps` patch.
  - `snapshot()` copies `notificationApps`.
  - `miniapp.json`: append to `permissions` `{"type": "READ_NOTIFICATIONS", "description": "Shows notifications from the apps you choose on the glasses"}`. Append to `hardwareRequirements` `{"type": "IMU", "level": "OPTIONAL", "description": "Shows a glance when you tilt your head up"}`.
- [ ] **Step 4:** Re-run, plus `npm run glass:typecheck`. Expected: PASS. `App.tsx` still compiles, because the UI only sends subsets.
- [ ] **Step 5:** Commit: `feat(mentra-glass): settings for question transcription and notification apps`.

### Task 6: Controller wiring for glance and notifications

**Files:**
- Modify: `apps/mentra-glass/src/background/AssistantController.ts`, `apps/mentra-glass/src/shared/channels.ts`
- Test: `apps/mentra-glass/src/background/AssistantController.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `GlassesView` options and phases.
  - Task 2: `TiltDetector`, `glanceBody`.
  - Task 3: `NotificationPresenter`, `notificationFromEvent`.
  - Task 5: `GlassSettings.notificationApps`, `NotificationAppOption`, `NOTIFICATION_APPS_STORAGE_KEY`.
  - SDK: `session.imu.onAccel(handler): () => void`, `session.phone.notifications.on(handler)`, `session.phone.notifications.onDismissed(handler)` (payload `{notificationId, ...}`).
- Produces: `StateSnapshot` gains `seenNotificationApps: NotificationAppOption[]` and `queuedNotifications: number`.

- [ ] **Step 1: Extend `FakeSession`** with `imu.onAccel`, `phone.notifications.on` and `phone.notifications.onDismissed`. They capture handlers and return unsubscribers. Add drivers `accel(deg, ts)` (same sample formula as Task 2), `notify(partial)` (fills `PhoneNotificationData` defaults: `app: "Messages"`, `packageName: "com.google.android.apps.messaging"`, `priority: ""`, `timestamp: Date.now()`) and `dismiss(id)`.
- [ ] **Step 2: Write failing tests.**
  - `tilt up shows the glance with the time and status`: `vi.setSystemTime(new Date(2026, 9, 13, 14, 5))`. Accel 30° at t=0..300 → the last render's body is `"14:05\nReady"` and its header is `"WednesdayAI · default"` (`agentLabel()` returns `"default"` when no agent is saved).
  - `tilt down hides the glance`: after the glance, 10° for 300 ms → the last render is `[]`.
  - `tilt up is ignored while an assistant frame is up`: start a chat run (thinking frame), then tilt up → no glance render.
  - `allowlisted notification renders; other apps only appear in seen apps`: allowlist the messaging package, notify `{notificationId: "n1", title: "Alice", content: "Lunch?"}` → header `"Messages · Alice"`, body `"Lunch?"`. Notify from `com.other` → not rendered, and the snapshot `seenNotificationApps` starts with `{packageName: "com.other", app: "Messages"}`.
  - `notification without text is ignored`: `title: ""`, `content: ""` → no render and no seen app.
  - `wake word interrupts a notification and the notification resumes after cancel`: notification on screen → interim `"hey wednesday"` → listening frame → a non-matching final → cancel → the notification renders again from page 1.
  - `seen apps persist across restarts`: storage holds JSON under `NOTIFICATION_APPS_STORAGE_KEY`, and a new controller's snapshot lists the same apps.
  - `removing an app from the allowlist drops its queued notifications`.
  - `dismissed notification leaves the queue` (`queuedNotifications` decrements).
- [ ] **Step 3: Implement in `AssistantController`.**
  - Add `private displayOwner: "assistant" | "notification" | "glance" | null = null`, a `TiltDetector`, a `NotificationPresenter`, and `private seenApps: NotificationAppOption[] = []`.
  - Build the view as `new GlassesView(session, {onAutoClear: () => this.onDisplayAutoClear()})`. `onDisplayAutoClear` sets `displayOwner = null` and calls `notifications.pump()`.
  - Presenter surface:
    - `canShow = displayOwner === null || displayOwner === "glance"`.
    - `show` sets owner `"notification"`, sets `listeningFrameUp = false`, calls `view.show`.
    - `hide` sets owner `null` and calls `view.hide()`.
    - `onChange` calls `pushState()`.
  - `showFrame` (assistant frames): if the owner is `"notification"`, call `notifications.interrupt()` first. Then set owner `"assistant"`.
  - Add `private releaseDisplay(): void`: set owner `null`, `view.hide()`, `notifications.pump()`. It replaces exactly the four `this.view.hide()` calls in `AssistantController.ts` (`grep -n "this.view.hide()"` shows four: the unpaired branch of `onConnectionState`, the `cancel` case, the listening-window expiry, and `pairWithCode`).
  - `start()`:
    - After `loadSettings`, `await this.loadSeenApps()`, then re-check `disposed`.
    - Push the unsubscribers for `imu.onAccel` → `onAccel`, `phone.notifications.on` → `onPhoneNotification`, and `phone.notifications.onDismissed` → `notifications.dismiss(d.notificationId)`.
  - `onAccel`:
    - `"up"` with owner `null` or `"glance"` → set owner `"glance"`, `listeningFrameUp = false`, `view.show({phase: "glance", agentLabel: this.agentLabel(), body: glanceBody(new Date(), this.connection.state, this.notifications.queued)})`.
    - `"down"` with owner `"glance"` → `releaseDisplay()`.
  - `onPhoneNotification`:
    - `item = notificationFromEvent(data)`; return if null.
    - `recordSeenApp(item)`: move or insert `{packageName, app}` at the front, cap at 50, persist JSON under `NOTIFICATION_APPS_STORAGE_KEY`. A save failure calls `pushError("Could not save notification apps")`. Skip the write when the list did not change.
    - If `settings.notificationApps` includes the package, call `notifications.add(item)`.
    - `pushState()`.
  - `loadSeenApps`: keep valid `{packageName: string, app: string}` entries, cap at 50. Any error gives `[]`.
  - `updateSettings`: when `notificationApps` changes, call `notifications.retain((n) => settings.notificationApps.includes(n.packageName))`.
  - `snapshot()` adds `seenNotificationApps` (copies) and `queuedNotifications: this.notifications.queued`.
  - `dispose()` calls `notifications.dispose()` before `view.dispose()`.
  - Update the class header comment.
- [ ] **Step 4:** Run `npm run test -w @wednesdayai/mentra-glass -- src/background/AssistantController.test.ts` and `npm run glass:typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(mentra-glass): tilt glance and notification queue on the glasses`.

### Task 7: Controller wiring for gateway question transcription

**Files:**
- Modify: `apps/mentra-glass/src/background/AssistantController.ts`
- Test: `apps/mentra-glass/src/background/AssistantController.test.ts`

**Interfaces:**
- Consumes:
  - Task 4: `GatewaySttCapture`, `findWake`.
  - Task 5: `querySttMode`.
  - Task 6: `releaseDisplay`, `showFrame`.
  - SDK: `session.mic.onAudioChunk(handler: (data: AudioChunkData) => void): () => void`.
- Produces: no new exports.

- [ ] **Step 1: Test setup.**
  - Add `mic.onAudioChunk` to `FakeSession`, with a driver `audio(data, format = "pcm_s16le", sampleRate = 16000)` and `audioSubscriptions(): number`.
  - Change `startAssistant(session, connection, options: {querySttMode?: "gateway" | "mentra"} = {})`. Before `start()` it merges `querySttMode` (default `"mentra"`) into the stored settings JSON, keeping existing tests on the Mentra path. New STT tests pass `"gateway"`.
- [ ] **Step 2: Write failing tests.**
  - `streams audio after the wake word and sends the gateway transcript`:
    - Gateway mode. Stub `talk.session.create` → `{sessionId: "s1", audio: {inputEncoding: "pcm16", inputSampleRateHz: 16000, channels: 1}}`, and `appendAudio`/`close` → `{}`.
    - Push audio chunks, then interim `"hey wednesday what's"` → a create request with params `{sessionKey: <the same sessionKey later sent in chat.send>, mode: "transcription", transport: "gateway-relay", brain: "none"}`.
    - Final `"hey wednesday what is the weather in paris"` → a close request.
    - Emit `talk.event` `{type: "transcript.done", sessionId: "s1", payload: {text: "Hey Wednesday, what's the weather in Paris?"}}` → `chat.send` `message` is `"what's the weather in Paris?"`.
  - `falls back to the Mentra query when the gateway has no transcription provider`: create rejects `Error("no active transcription provider")`. Two wake+query rounds with different queries (the tracker drops a repeated query within its duplicate window) → each `chat.send` uses the Mentra query. `errorMessages` contains `"WednesdayAI transcription unavailable: no active transcription provider. Using Mentra transcription."` exactly once.
  - `falls back to the Mentra query after 6 s without a transcript`.
  - `uses the Mentra query when the gateway transcript has no wake word`.
  - `Mentra mode never subscribes to audio or opens talk sessions`.
  - `cancel aborts the talk session without sending chat`.
  - `audio subscription follows the connection`: offline → `audioSubscriptions() === 0`; connected → 1.
  - `disconnect while awaiting the gateway transcript sends nothing`.
- [ ] **Step 3: Implement.**
  - Build `this.stt = new GatewaySttCapture({requester: this.connection, onError: (m) => this.onSttError(m)})` after the connection exists.
  - `private syncAudioSubscription()`:
    - Wanted when `!disposed && settings.querySttMode === "gateway" && connection.state === "connected"`.
    - When wanted, subscribe with `session.mic.onAudioChunk((c) => this.stt.pushChunk(c))`.
    - When not wanted, unsubscribe and call `stt.abort()`.
    - Call it at the end of `start()`, in `updateSettings` when `querySttMode` changed, and at the top of `onConnectionState`.
  - `onGatewayEvent`: route `"talk.event"` to `stt.onTalkEvent(payload)`.
  - `onHello`: reset `sttWarned = false`.
  - `onSttError(message)`: once per hello, `pushError(`WednesdayAI transcription unavailable: ${message}. Using Mentra transcription.`)`.
  - Wake actions:
    - `listening`: when the audio subscription is live, `stt.begin(this.sessionKey())`.
    - `cancel` and the listening-window expiry: `stt.abort()`.
    - `send`: `stopListeningTimer()`, then `void this.resolveAndSend(action.query)`.
  - `resolveAndSend(mentraQuery)`:
    - `token = ++this.sendToken`.
    - If `!stt.active`, return `sendQuery(mentraQuery)`.
    - Otherwise set `currentQuery = mentraQuery`, show the thinking frame with `mentraQuery`, and `text = await stt.finish()`.
    - Return if disposed or `token !== this.sendToken`.
    - `query = (text && findWake(text, this.triggers)?.query.trim()) || mentraQuery`, then `sendQuery(query)`.
  - `dispose()`: `stt.dispose()` and the audio unsubscribe.
  - Update the class header comment.
- [ ] **Step 4:** Run `npm run glass:test` and `npm run glass:typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(mentra-glass): transcribe the question on the WednesdayAI gateway`.

### Task 8: Phone UI for the new settings

**Files:**
- Modify: `apps/mentra-glass/src/ui/App.tsx`

**Interfaces:**
- Consumes: `StateSnapshot.settings.querySttMode`, `.notificationApps`, `.seenNotificationApps`, `.queuedNotifications`, and channel `settings:set`.

- [ ] **Step 1: Add a "Question transcription" card** after "Wake listening". Use radios named `query-stt-mode`:
  - `WednesdayAI gateway (more accurate; needs a transcription provider on the gateway)` → `settings:set {querySttMode: "gateway"}`.
  - `Mentra (same as wake listening)` → `{querySttMode: "mentra"}`.
  - Hint: `If the gateway cannot transcribe, Mentra's transcript is used.`
- [ ] **Step 2: Add a "Glasses notifications" card.**
  - Hint: `Android only. On iOS the glasses firmware shows notifications itself.`
  - With no seen apps: hint `No notifications seen yet. Apps appear here after your phone shows one.`
  - Otherwise, one `label.row` per seen app: a checkbox (checked when `notificationApps` includes the package), the app name, and a `hint` span with the package name. Toggling sends `settings:set {notificationApps: <next array>}`.
  - When `queuedNotifications > 0`: hint `Queued: N`.
  - Last line: hint `Stop Mentra Notify in the Mentra App so messages are not shown twice.`
  - Reuse the existing classes `card`, `row`, `hint`.
- [ ] **Step 3:** Run `npm run glass:typecheck && npm run build -w @wednesdayai/mentra-glass`. Expected: both succeed.
- [ ] **Step 4:** Commit: `feat(mentra-glass): phone settings for question transcription and notifications`.

### Task 9: README updates (A6 and new features)

**Files:**
- Modify: `apps/mentra-glass/README.md` and `apps/mentra-glass/README.zh-CN.md` (same changes, Chinese text in the zh-CN file, keeping its heading style `### …`).

- [ ] **Step 1: Make these edits in both languages.**
  - **Using the wake word**: after the wake word, the question is transcribed by your WednesdayAI gateway; if it cannot, Mentra's transcript is used.
  - New `### Head-tilt glance` (zh `### 抬头速览`) after "Using the wake word":
    - Tilting your head up shows the time, the connection status and the number of queued notifications for 5 seconds; it hides when you look down.
    - It never covers an answer.
    - The glasses' own tilt dashboard may also appear; MentraOS cannot turn it off.
  - New `### Glasses notifications` (zh `### 眼镜通知`):
    - Android only.
    - Tick apps in the phone menu.
    - Notifications show one at a time, in 160-character pages that advance every 4 seconds, then the next.
    - Stop Mentra Notify to avoid duplicates.
    - On iOS the glasses firmware shows notifications itself.
  - **Settings**: add bullets for **Question transcription** and **Glasses notifications**.
  - **Troubleshooting**: "Do not pin WednesdayAI in the glasses menu: selecting it there stops the assistant (#16)."
  - **Privacy note**:
    - With gateway transcription on, the phone keeps the last 1.5 seconds of microphone audio in memory while connected.
    - It sends audio to your gateway only from the wake word to the end of your question.
    - Notification text never leaves the phone.
  - **Granted scopes** (administrators):
    - Question transcription uses `talk.session.*` under the existing `operator.write` scope.
    - It needs a transcription provider on the gateway; otherwise the user sees "WednesdayAI transcription unavailable" once and Mentra's transcript is used.
  - **Constraints and known limits**: add the storage key `wai.notificationApps.v1`, and change the findings range to `#1–#16`.
  - **Requirements**: Android notification access for glasses notifications.
- [ ] **Step 2: Verify.** Run `grep -c "#16" apps/mentra-glass/README.md apps/mentra-glass/README.zh-CN.md`. Expected: both ≥ 1. The section count matches: `grep -c "^### " <file>` is equal for both files.
- [ ] **Step 3:** Commit: `docs(mentra-glass): document glance, notifications and gateway transcription`.

## Verification

From the repo root, after Task 9:

1. `npm run glass:test`: all tests pass. These test names pass and prove the new behaviour:
   - `tilt up shows the glance with the time and status`
   - `allowlisted notification renders; other apps only appear in seen apps`
   - `wake word interrupts a notification and the notification resumes after cancel`
   - `streams audio after the wake word and sends the gateway transcript`
   - `falls back to the Mentra query when the gateway has no transcription provider`
   - `abort while opening closes the session once created`
   - `disconnect while awaiting the gateway transcript sends nothing`
2. `npm run glass:coverage`: thresholds of 80% hold for statements, branches, functions and lines.
3. `npm run glass:typecheck && npm run build -w @wednesdayai/mentra-glass`: both succeed.
4. `git log --oneline 7774dfd..HEAD`: 10 commits (plan + 9 tasks, plus any review-fix commits). `git status --short` is empty. `git rev-parse --abbrev-ref @{u}` fails, because there is no upstream: nothing was pushed.
5. Operator end-to-end STT (needs a gateway with a transcription provider):
   - `ffmpeg -i question.m4a -f s16le -ac 1 -ar 16000 /tmp/q.raw`
   - `cd apps/mentra-glass && bun run smoke:gateway -- --setup-code <code> --stt-pcm /tmp/q.raw`
   - Expected: prints `stt: <your question>` and exits 0.

## Operator device checks

Hand these to the user in the final message; agents cannot run them.

- **V2 tilt.** Sideload the build and tilt your head up.
  - The glance appears within about one display tick.
  - If it fires on head-down, set `PITCH_SIGN = -1` in `src/background/tilt.ts`.
  - Note whether the firmware tilt dashboard covers it.
- **A2.** On Android, tick an app and stop Mentra Notify. Three messages show one at a time and page fully.
- **A3.** On device, say the wake word plus a question with gateway transcription on: the answer uses the gateway transcript. Check `wednesdayai logs` for `relay session ended`.
- **A4 / V5.** Record battery drain per hour, connected + blank vs Even app idle (#14).
- **A5 / V1.** Enable Super Settings → "Use Native G2 Dashboard" off, double-tap: does a `view:"dashboard"` frame show? (#11)

## Assumptions & contingencies

- **Separate branch.** Work goes on a new local branch `davidrudduck/glasses-phase-a` cut from `davidrudduck/shearwater` @ `7774dfd`, so PR #17 stays docs-only. Override: if the user wants it on `davidrudduck/shearwater`, skip Task 0 Step 1.
- **Interim transcripts.** Gateway transcription relies on Mentra STT sending interim transcripts, which is what opens the capture with pre-roll. If a final transcript carrying wake word + question arrives with no capture open, the Mentra query is sent unchanged. This is by design, not a bug to fix.
- **Different event shape.** If `talk.event` frames reach the miniapp with a different shape than documented, Task 4 parses defensively (ignore unknown shapes) and Task 7 falls back to Mentra. Record the observed shape as a ledger ruling.
- **SDK version.** If `session.imu`, `session.phone` or `session.mic` types differ from `@mentra/miniapp` 3.2.1 as described, follow the installed `node_modules/@mentra/miniapp/src/modules/*.ts` signatures and record a ruling.
