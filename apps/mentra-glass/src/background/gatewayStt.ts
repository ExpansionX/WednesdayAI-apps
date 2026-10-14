/**
 * Gateway speech-to-text capture over the `talk.session` relay methods.
 *
 * Pure logic — no gateway-socket ownership — so the controller (and the smoke
 * script) hand in any requester with `request()`; the WednesdayAI gateway
 * allows exactly one transcription session per connection.
 *
 * The controller pushes every 16 kHz PCM16 mic chunk here while connected;
 * begin() opens a transcription session carrying the last PREROLL_MS of
 * audio, then live chunks append through one ordered drain per utterance:
 * at most one append in flight, at most MAX_APPEND_BYTES decoded bytes per
 * frame. The gateway returns the session id before its provider connects, so nothing
 * is appended until the matching `talk.event` `session.ready` arrives;
 * `finish()` called before then waits for ready inside the same
 * STT_RESULT_TIMEOUT_MS budget measured from the finish call. `finish()`
 * closes the session and awaits the gateway transcript, resolving null on
 * session.error, an empty transcript, or that deadline.
 *
 * Leak safety: every successful create ends in exactly one close — via
 * finish, abort (including the auto-abort at MAX_CAPTURE_MS), dispose, or a
 * create or append that lands after an abort/dispose; a capture that
 * reaches idle without having sent close sends it in settle(). A failed
 * append closes the session, reports once, and makes that utterance's
 * finish resolve null — unless the server already retired the session with
 * session.error/session.closed, in which case streaming stops, no close is
 * sent, and a later finish settles from the cached terminal. After a close
 * the capture is fenced until the server's `session.closed` arrives (or
 * the fence times out): begin is ignored, because the gateway retires the
 * drained session asynchronously and a create in that window would fail
 * with CONFLICT. The fence also covers a create that was still in flight
 * when the capture settled: it holds until that create lands, its session
 * (if any) is retired. A create that lands after its utterance was
 * cancelled or already finished is stale: its session is closed exactly
 * once and never opened. Once finish starts the capture is no longer
 * active, so a later question cannot consume another utterance's
 * transcript, and a terminal event that arrived before finish settles it
 * immediately from the cache. Continuations resumed after an await
 * re-check the utterance identity, so a stale capture can never touch the
 * fields or timers of its replacement. LC3 or non-16 kHz chunks never
 * reach appendAudio. finish pads real-audio utterances with 500 ms of
 * trailing silence before close: the relay's endpointing otherwise drops
 * clips that end on speech. `talk.event` payloads are parsed defensively:
 * anything without a string `type` and `sessionId`, or
 * naming another session, is ignored.
 */

import type {AudioChunkData} from "@mentra/miniapp/background"

import {concatBase64} from "../gateway/encoding"
import {isRecord} from "../gateway/types"

/** Mic audio kept in memory before the wake word, flushed with the capture. */
export const PREROLL_MS = 1500
/** How often buffered live chunks are appended to the open session. */
export const AUDIO_FLUSH_MS = 250
/** How long finish() waits for the gateway transcript after closing. */
export const STT_RESULT_TIMEOUT_MS = 6000
/** Hard cap on one capture; exceeding it aborts the session. */
export const MAX_CAPTURE_MS = 20000
/** Max decoded PCM bytes per appendAudio frame: 3 s of PCM16@16 kHz, about a
 * quarter of the gateway's 512 KiB base64 frame limit. */
export const MAX_APPEND_BYTES = 96_000
/** Digital silence padded before close so relay endpointing keeps a last word
 * that would otherwise be cut off (live E2E). */
export const TRAILING_SILENCE_MS = 500
/** Decoded bytes of that tail (16 kHz PCM16 = 32 bytes per ms). */
const TRAILING_SILENCE_BYTES = TRAILING_SILENCE_MS * 32

export interface SttRequester {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
}

export interface GatewaySttCaptureOptions {
  requester: SttRequester
  /** Injectable clock for pre-roll timestamps. Defaults to Date.now. */
  now?: () => number
  /** Delivery problems only; never timeouts, empty transcripts or session.error. */
  onError?: (message: string) => void
}

export type CaptureState = "idle" | "opening" | "open" | "closing"

interface RingEntry {
  at: number
  data: string
}

/** The settled result of talk.session.create; never rejects. */
type CreateOutcome = {ok: true; sessionId: string} | {ok: false; message: string}

/** Global `setTimeout` handle; the runtime is the owner of this shape. */
type TimerHandle = ReturnType<typeof setTimeout>

export class GatewaySttCapture {
  private stateValue: CaptureState = "idle"
  /** Bumped by begin(); lets a create that lands late be recognized as stale. */
  private utterance = 0
  private readonly ring: RingEntry[] = []
  private pending: string[] = []
  /** Serializes appends: at most one in flight, drained in queue order. */
  private appendChain: Promise<void> = Promise.resolve()
  /** This utterance buffered at least one real audio chunk (for the tail). */
  private sawAudio = false
  private sessionId: string | null = null
  /** The session a close request was sent for; one close per session id. */
  private closedSessionId: string | null = null
  private abortRequested = false
  private disposed = false
  /** Set once the matching talk.event session.ready has been seen. */
  private readySeen = false
  private readyWaiter: Promise<void> | null = null
  private signalReady: (() => void) | null = null
  /** Server retired the session with session.closed; settle() must not close again. */
  private closedByServer = false
  /** Sessions closed locally whose drain the server has not confirmed via session.closed. */
  private readonly fencedSessions = new Map<string, TimerHandle>()
  /** A create was in flight when the capture settled: begin stays fenced until it retires. */
  private pendingCreateFence = false
  private pendingFenceTimer: TimerHandle | null = null
  /** This utterance's finish ran and settled; its late create is stale. */
  private finishSettled = false
  private createPromise: Promise<CreateOutcome> | null = null
  private finishPromise: Promise<string | null> | null = null
  private resolveFinish: ((value: string | null) => void) | null = null
  /** Last transcript.done text for this session, kept until finish can use it. */
  private transcriptText: string | null = null
  private terminalSeen = false
  private flushTimer: TimerHandle | null = null
  private maxTimer: TimerHandle | null = null
  private terminalTimer: TimerHandle | null = null
  private readonly requester: SttRequester
  private readonly now: () => number
  private readonly onError?: (message: string) => void

  constructor(options: GatewaySttCaptureOptions) {
    this.requester = options.requester
    this.now = options.now ?? Date.now
    this.onError = options.onError
  }

  get state(): CaptureState {
    return this.stateValue
  }

  /** True while a session is being opened or streamed to and finish has not started. */
  get active(): boolean {
    return this.finishPromise === null && (this.stateValue === "opening" || this.stateValue === "open")
  }

  /** Buffer a mic chunk; drops anything the gateway cannot transcribe. */
  pushChunk(chunk: AudioChunkData): void {
    if (this.disposed || !chunk.data) return
    if (chunk.format !== undefined && chunk.format !== "pcm_s16le") return
    if (chunk.sampleRate !== undefined && chunk.sampleRate !== 16000) return
    const at = this.now()
    this.ring.push({at, data: chunk.data})
    const cutoff = at - PREROLL_MS
    while (this.ring.length > 0 && this.ring[0].at < cutoff) this.ring.shift()
    // A session the server retired (session.error/session.closed) collects
    // no further audio; its cached terminal settles a later finish.
    if ((this.stateValue === "opening" || this.stateValue === "open") && !this.terminalSeen) {
      this.sawAudio = true
      this.pending.push(chunk.data)
    }
  }

  /** Open a transcription session seeded with the pre-roll. Ignored unless idle. */
  begin(sessionKey: string): void {
    // A fenced capture means the server is still draining a previous session
    // — or a create is still in flight; a create now would fail with CONFLICT.
    if (this.disposed || this.pendingCreateFence || this.fencedSessions.size > 0 || this.stateValue !== "idle") {
      return
    }
    this.utterance += 1
    const utterance = this.utterance
    this.abortRequested = false
    this.finishSettled = false
    this.sawAudio = false
    this.readySeen = false
    this.readyWaiter = null
    this.signalReady = null
    this.closedByServer = false
    // The chain is scoped to the utterance: a retired utterance's queued
    // drains discard themselves via their bound identity, and their queue
    // positions must not delay this one's first flush.
    this.appendChain = Promise.resolve()
    this.stateValue = "opening"
    // The ring is only pruned on arrival; drop anything the gap since the last
    // chunk pushed past the pre-roll window before seeding this capture.
    const cutoff = this.now() - PREROLL_MS
    while (this.ring.length > 0 && this.ring[0].at < cutoff) this.ring.shift()
    this.pending = this.ring.map((entry) => entry.data)
    this.maxTimer = setTimeout(() => this.abort(), MAX_CAPTURE_MS)
    const createPromise = this.requestCreate(sessionKey)
    this.createPromise = createPromise
    void createPromise.then((outcome) => this.onCreateOutcome(outcome, utterance))
  }

  /** Close the session and resolve with the gateway transcript (or null). */
  finish(): Promise<string | null> {
    if (this.finishPromise) return this.finishPromise
    if (this.stateValue === "idle") return Promise.resolve(null)
    const promise = new Promise<string | null>((resolve) => {
      this.resolveFinish = resolve
    })
    this.finishPromise = promise
    if (this.terminalSeen || this.transcriptText !== null) {
      // A terminal event already landed (provider failure, server close, or
      // an early transcript): the outcome is known — no readiness wait, no
      // final flush, no deadline. settle() skips the close when the server
      // already retired the session. (Return the local: settle nulls the
      // field on its way out.)
      this.trySettleFromTerminal()
      return promise
    }
    // The transcript budget starts here — including any wait for
    // session.ready — so it is armed before runFinish's first await. The
    // timeout also closes: an utterance that never became ready still owns
    // a server session.
    this.terminalTimer = setTimeout(() => {
      this.requestClose(this.sessionId)
      this.settle(null)
    }, STT_RESULT_TIMEOUT_MS)
    void this.runFinish(this.utterance)
    return this.finishPromise
  }

  /** Cancel the capture; a pending finish resolves null. */
  abort(): void {
    if (this.disposed) return
    if (this.stateValue === "opening") {
      this.abortRequested = true
      this.clearTimer("maxTimer")
      this.settle(null)
      return
    }
    if (this.stateValue === "open") {
      // The server may already have retired the session; never close it again.
      if (!this.closedByServer) this.requestClose(this.sessionId)
      this.settle(null)
      return
    }
    if (this.stateValue === "closing") {
      // The close request is already out; cancel the wait without a second
      // close and make later events for the session irrelevant.
      this.settle(null)
    }
  }

  /** Stop forever: close any known session; pushChunk/begin become no-ops. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ring.length = 0
    if (this.stateValue === "open") {
      // The server may already have retired the session; never close it again.
      if (!this.closedByServer) this.requestClose(this.sessionId)
    } else if (this.stateValue === "opening") {
      this.abortRequested = true
      this.clearTimer("maxTimer")
    }
    this.settle(null)
    // A disposed capture never begins again: drop every fence and its timers.
    this.clearAllFences()
  }

  /** Feed a `talk.event` payload; ignores malformed frames and other sessions. */
  onTalkEvent(payload: unknown): void {
    if (!isRecord(payload)) return
    const {type, sessionId} = payload
    if (typeof type !== "string" || typeof sessionId !== "string") return
    // The server's close retires that session's fence, whether or not this
    // capture still tracks the session locally.
    if (type === "session.closed") this.retireFence(sessionId)
    if (this.sessionId === null || sessionId !== this.sessionId) return
    if (type === "session.ready") {
      this.onSessionReady()
      return
    }
    if (type === "transcript.done") {
      const eventPayload = payload.payload
      this.transcriptText = isRecord(eventPayload) && typeof eventPayload.text === "string" ? eventPayload.text : null
    } else if (type === "session.error" || type === "session.closed") {
      this.terminalSeen = true
      if (type === "session.closed") this.closedByServer = true
      // The server removed the session: stop periodic streaming and drop
      // buffered audio — appending again would only be rejected.
      this.clearTimer("flushTimer")
      this.pending = []
    } else {
      return
    }
    this.trySettleFromTerminal()
  }

  private requestCreate(sessionKey: string): Promise<CreateOutcome> {
    return this.requester
      .request<{sessionId?: unknown}>("talk.session.create", {
        sessionKey,
        mode: "transcription",
        transport: "gateway-relay",
        brain: "none",
      })
      .then(
        (result): CreateOutcome => {
          const sessionId = isRecord(result) && typeof result.sessionId === "string" ? result.sessionId : null
          return sessionId
            ? {ok: true, sessionId}
            : {ok: false, message: "transcription session create returned no session id"}
        },
        (error: unknown): CreateOutcome =>
          ({ok: false, message: error instanceof Error ? error.message : String(error)}),
      )
  }

  /** True while this utterance still owns the capture: not replaced,
   * aborted, disposed, or already finished. */
  private isCurrent(utterance: number): boolean {
    return utterance === this.utterance && !this.abortRequested && !this.disposed && !this.finishSettled
  }

  private onCreateOutcome(outcome: CreateOutcome, utterance: number): void {
    if (utterance !== this.utterance) {
      // Stale create (abort/dispose landed, or a newer begin won): still
      // close its session — the gateway allows one transcription session at
      // a time, and its drain fences the next begin.
      if (outcome.ok) this.requestClose(outcome.sessionId)
      return
    }
    this.createPromise = null
    // The pending fence existed only to block begin until this create
    // settled; a success fences its own session below, a failure has none.
    this.clearPendingFence()
    if (!outcome.ok) {
      // A create landing after its finish already settled (the requester's
      // own timeout) must not report: the question was answered long ago.
      if (this.isCurrent(utterance)) this.onError?.(outcome.message)
      this.settle(null)
      return
    }
    if (!this.isCurrent(utterance)) {
      // Cancelled while the create was in flight, or the utterance already
      // finished (deadline or otherwise): the create is stale — close the
      // fresh session exactly once and never stream audio into it.
      this.requestClose(outcome.sessionId)
      this.settle(null)
      return
    }
    this.sessionId = outcome.sessionId
    this.stateValue = "open"
  }

  private async runFinish(utterance: number): Promise<void> {
    // The 20 s cap governs audio collection only; the transcript wait has
    // its own deadline armed by finish().
    this.clearTimer("maxTimer")
    const createPromise = this.createPromise
    if (createPromise) {
      await createPromise
      // A settle (abort/dispose) or a newer begin invalidates this continuation.
      if (utterance !== this.utterance || this.finishPromise === null) return
    }
    // Stop periodic flushes and push whatever is still buffered before closing.
    this.clearTimer("flushTimer")
    if (!this.readySeen) {
      if (this.readyWaiter === null) {
        this.readyWaiter = new Promise<void>((resolve) => {
          this.signalReady = resolve
        })
      }
      await this.readyWaiter
      if (utterance !== this.utterance || this.finishPromise === null) return
    }
    // One ordered drain: waits for any in-flight append, then appends the
    // rest in bounded frames — nothing is sent after the close below. When
    // this utterance carried audio, the drain ends with a frame of digital
    // silence: the relay's endpointing drops clips that end on speech
    // (live E2E), the tail keeps the last word.
    await this.flushOnce(this.sawAudio)
    if (utterance !== this.utterance || this.finishPromise === null) return
    this.stateValue = "closing"
    this.requestClose(this.sessionId)
    this.trySettleFromTerminal()
  }

  /** The provider connected: signal a waiting finish and start streaming. */
  private onSessionReady(): void {
    this.readySeen = true
    const signal = this.signalReady
    this.signalReady = null
    this.readyWaiter = null
    signal?.()
    this.startStreaming(this.utterance)
  }

  /** First buffered flush plus the periodic flush cadence. */
  private startStreaming(utterance: number): void {
    if (this.stateValue !== "open" || this.flushTimer !== null || this.finishPromise !== null) return
    void this.flushOnce().then(() => {
      if (
        utterance === this.utterance &&
        this.stateValue === "open" &&
        this.finishPromise === null &&
        !this.terminalSeen
      ) {
        this.scheduleFlush()
      }
    })
  }

  private trySettleFromTerminal(): void {
    if (this.finishPromise === null) return
    if (this.transcriptText !== null) {
      const text = this.transcriptText.trim()
      this.settle(text ? text : null)
      return
    }
    if (this.terminalSeen) this.settle(null)
  }

  /**
   * Queue one bounded drain of the buffer behind any in-flight append. The
   * returned promise resolves when this drain (and every append queued
   * before it) has settled — finish awaits it, so close is only ever sent
   * after all queued audio was appended.
   */
  private flushOnce(withTail = false): Promise<void> {
    // Bind the queued drain to the utterance and session it was queued for:
    // a queue position can outlive both (terminal settlement, replacement).
    const utterance = this.utterance
    const sessionId = this.sessionId
    if (sessionId === null) return this.appendChain
    const run = this.appendChain.then(() => this.drainPending(utterance, sessionId, withTail))
    // drainPending handles its own failures; keep the shared chain alive.
    this.appendChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Send the buffered audio as ordered frames of at most MAX_APPEND_BYTES.
   * Bound to the utterance and session at queue time: a drain whose utterance
   * was replaced (or whose session was settled/retired) discards itself. With
   * `withTail`, one frame of digital silence follows the last real chunk.
   */
  private async drainPending(utterance: number, sessionId: string, withTail = false): Promise<void> {
    if (utterance !== this.utterance || sessionId !== this.sessionId || this.terminalSeen) return
    while (this.pending.length > 0 || withTail) {
      // A settle (abort/dispose) or a terminal event invalidates this drain;
      // never touch a replacement capture's buffer or a retired session.
      if (utterance !== this.utterance || sessionId !== this.sessionId || this.terminalSeen) return
      // Real audio drained: emit the endpointing tail once — after the last
      // real chunk, before the close that follows this drain.
      if (this.pending.length === 0) {
        withTail = false
        this.pending.push(btoa("\0".repeat(TRAILING_SILENCE_BYTES)))
      }
      // Whole chunks only — a batch takes chunks until the byte budget is
      // full; a lone chunk larger than the budget is never split.
      const batch: string[] = []
      let batchBytes = 0
      while (this.pending.length > 0) {
        const next = this.pending[0]
        // Decoded byte count of canonical base64 (exact with or without padding).
        const nextBytes = Math.floor((next.length * 3) / 4)
        if (batch.length > 0 && batchBytes + nextBytes > MAX_APPEND_BYTES) break
        batch.push(this.pending.shift()!)
        batchBytes += nextBytes
      }
      try {
        await this.requester.request("talk.session.appendAudio", {
          sessionId,
          audioBase64: concatBase64(batch),
        })
      } catch (error) {
        // A rejection from an utterance that already ended (abort/dispose/re-begin)
        // must not touch the capture that replaced it.
        if (utterance !== this.utterance || sessionId !== this.sessionId) return
        // A rejection for a session the server retired: its cached terminal
        // settles a later finish — no close, no error, no fence.
        if (this.terminalSeen) return
        // This utterance is broken: report once, close the session exactly once,
        // and resolve any pending finish with null instead of a transcript.
        this.requestClose(sessionId)
        this.onError?.(error instanceof Error ? error.message : String(error))
        this.settle(null)
        return
      }
    }
  }

  private scheduleFlush(): void {
    this.flushTimer = setTimeout(() => {
      const utterance = this.utterance
      void this.flushOnce().then(() => {
        if (
          utterance === this.utterance &&
          this.stateValue === "open" &&
          this.finishPromise === null &&
          !this.terminalSeen
        ) {
          this.scheduleFlush()
        }
      })
    }, AUDIO_FLUSH_MS)
  }

  private requestClose(sessionId: string | null): void {
    if (sessionId === null || sessionId === this.closedSessionId) return
    this.closedSessionId = sessionId
    // The close ack races the server's transcription drain, which keeps the
    // session until commitInput finishes: fence begin until session.closed —
    // never after dispose, where begin is gone and no timer may outlive it.
    if (!this.disposed) this.fenceSession(sessionId)
    void this.requester.request("talk.session.close", {sessionId}).catch(() => {})
  }

  /** Fence one closed session until session.closed (or its own timeout). */
  private fenceSession(sessionId: string): void {
    if (this.fencedSessions.has(sessionId)) return
    this.fencedSessions.set(
      sessionId,
      setTimeout(() => {
        this.fencedSessions.delete(sessionId)
      }, STT_RESULT_TIMEOUT_MS),
    )
  }

  private retireFence(sessionId: string): void {
    const timer = this.fencedSessions.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.fencedSessions.delete(sessionId)
  }

  /** Fence begin until the in-flight create settles (or the timeout). */
  private armPendingFence(): void {
    this.pendingCreateFence = true
    this.pendingFenceTimer = setTimeout(() => {
      this.pendingFenceTimer = null
      this.pendingCreateFence = false
    }, STT_RESULT_TIMEOUT_MS)
  }

  private clearPendingFence(): void {
    if (this.pendingFenceTimer !== null) {
      clearTimeout(this.pendingFenceTimer)
      this.pendingFenceTimer = null
    }
    this.pendingCreateFence = false
  }

  private clearAllFences(): void {
    for (const timer of this.fencedSessions.values()) clearTimeout(timer)
    this.fencedSessions.clear()
    this.clearPendingFence()
  }

  /** End the utterance: clear every timer and field, resolve finish, go idle. */
  private settle(value: string | null): void {
    const resolve = this.resolveFinish
    if (resolve !== null) this.finishSettled = true
    this.clearTimer("flushTimer")
    this.clearTimer("maxTimer")
    this.clearTimer("terminalTimer")
    // Leak safety: reaching idle without a close request still owns a server
    // session — unless the server already retired it. (The fence spans
    // settle on purpose: it ends on session.closed or its timeout.)
    if (!this.closedByServer) this.requestClose(this.sessionId)
    const signal = this.signalReady
    this.signalReady = null
    this.readyWaiter = null
    signal?.()
    if (this.createPromise !== null && !this.disposed) {
      // The create is still in flight: fence the next begin until it settles
      // and its session (if any) retires — racing it would fail with CONFLICT.
      this.armPendingFence()
    }
    this.pending = []
    this.sessionId = null
    this.closedSessionId = null
    this.createPromise = null
    this.transcriptText = null
    this.terminalSeen = false
    this.closedByServer = false
    this.finishPromise = null
    this.resolveFinish = null
    this.stateValue = "idle"
    resolve?.(value)
  }

  private clearTimer(timer: "flushTimer" | "maxTimer" | "terminalTimer"): void {
    if (this[timer] !== null) {
      clearTimeout(this[timer])
      this[timer] = null
    }
  }
}
