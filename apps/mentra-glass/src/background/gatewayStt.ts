/**
 * Gateway speech-to-text capture over the `talk.session` relay methods.
 *
 * Pure logic — no gateway-socket ownership — so the controller (and the smoke
 * script) hand in any requester with `request()`; the WednesdayAI gateway
 * allows exactly one transcription session per connection.
 *
 * The controller pushes every 16 kHz PCM16 mic chunk here while connected;
 * `begin()` opens a transcription session carrying the last PREROLL_MS of
 * audio, then live chunks flush every AUDIO_FLUSH_MS. The gateway returns
 * the session id before its provider connects, so nothing is appended until
 * the matching `talk.event` `session.ready` arrives; `finish()` called
 * before then waits for ready inside the same STT_RESULT_TIMEOUT_MS budget
 * measured from the finish call. `finish()` closes the session and awaits
 * the gateway transcript, resolving null on session.error, an empty
 * transcript, or that deadline.
 *
 * Leak safety: every successful create ends in exactly one close — via
 * finish, abort (including the auto-abort at MAX_CAPTURE_MS), dispose, or a
 * create or append that lands after an abort/dispose; a capture that
 * reaches idle without having sent close sends it in settle(). A failed
 * append closes the session, reports once, and makes that utterance's
 * finish resolve null. After a close the capture is fenced until the
 * server's `session.closed` arrives (or the fence times out): begin is
 * ignored, because the gateway retires the drained session asynchronously
 * and a create in that window would fail with CONFLICT. Once finish starts
 * the capture is no longer active, so a later question cannot consume
 * another utterance's transcript. Continuations resumed after an await
 * re-check the utterance identity, so a stale capture can never touch the
 * fields or timers of its replacement. LC3 or non-16 kHz chunks never reach
 * appendAudio. `talk.event` payloads are parsed defensively: anything
 * without a string `type` and `sessionId`, or naming another session, is
 * ignored.
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
  /** A closed session awaiting the server's asynchronous drain (fence on begin). */
  private fencedSessionId: string | null = null
  private fenceTimer: TimerHandle | null = null
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
    if (this.stateValue === "opening" || this.stateValue === "open") this.pending.push(chunk.data)
  }

  /** Open a transcription session seeded with the pre-roll. Ignored unless idle. */
  begin(sessionKey: string): void {
    // A fenced capture means the server is still draining the previous
    // session; a create now would fail with CONFLICT.
    if (this.disposed || this.fencedSessionId !== null || this.stateValue !== "idle") return
    this.utterance += 1
    const utterance = this.utterance
    this.abortRequested = false
    this.readySeen = false
    this.readyWaiter = null
    this.signalReady = null
    this.closedByServer = false
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
    this.finishPromise = new Promise<string | null>((resolve) => {
      this.resolveFinish = resolve
    })
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
      this.requestClose(this.sessionId)
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
    this.clearFence()
    if (this.stateValue === "open") {
      this.requestClose(this.sessionId)
    } else if (this.stateValue === "opening") {
      this.abortRequested = true
      this.clearTimer("maxTimer")
    }
    this.settle(null)
  }

  /** Feed a `talk.event` payload; ignores malformed frames and other sessions. */
  onTalkEvent(payload: unknown): void {
    if (!isRecord(payload)) return
    const {type, sessionId} = payload
    if (typeof type !== "string" || typeof sessionId !== "string") return
    // The server's close of a fenced session ends the fence, whether or not
    // this capture still tracks that session locally.
    if (type === "session.closed" && sessionId === this.fencedSessionId) this.clearFence()
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

  private onCreateOutcome(outcome: CreateOutcome, utterance: number): void {
    if (utterance !== this.utterance) {
      // Stale create (abort/dispose landed, or a newer begin won): still
      // close its session — the gateway allows one transcription session at
      // a time, and its drain fences the next begin.
      if (outcome.ok) this.requestClose(outcome.sessionId)
      return
    }
    this.createPromise = null
    if (!outcome.ok) {
      if (!this.abortRequested && !this.disposed) this.onError?.(outcome.message)
      this.settle(null)
      return
    }
    if (this.abortRequested || this.disposed) {
      // Cancelled while the create was in flight: close the fresh session
      // exactly once and never stream audio into it.
      this.requestClose(outcome.sessionId)
      this.settle(null)
      return
    }
    this.sessionId = outcome.sessionId
    this.stateValue = "open"
    // The gateway discards audio until the provider connects; hold the
    // pre-roll until its session.ready event arrives. (Defensive: ready
    // cannot normally outrun the create response on one connection.)
    if (this.readySeen) this.startStreaming(utterance)
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
    await this.flushOnce()
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
      if (utterance === this.utterance && this.stateValue === "open" && this.finishPromise === null) {
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

  /** Send the buffered audio as one append; clears the buffer up front. */
  private async flushOnce(): Promise<void> {
    const utterance = this.utterance
    const sessionId = this.sessionId
    if (sessionId === null || this.pending.length === 0) return
    const audioBase64 = concatBase64(this.pending)
    this.pending = []
    try {
      await this.requester.request("talk.session.appendAudio", {sessionId, audioBase64})
    } catch (error) {
      // A rejection from an utterance that already ended (abort/dispose/re-begin)
      // must not touch the capture that replaced it.
      if (utterance !== this.utterance || sessionId !== this.sessionId) return
      // This utterance is broken: report once, close the session exactly once,
      // and resolve any pending finish with null instead of a transcript.
      this.requestClose(sessionId)
      this.onError?.(error instanceof Error ? error.message : String(error))
      this.settle(null)
    }
  }

  private scheduleFlush(): void {
    this.flushTimer = setTimeout(() => {
      const utterance = this.utterance
      void this.flushOnce().then(() => {
        if (utterance === this.utterance && this.stateValue === "open") this.scheduleFlush()
      })
    }, AUDIO_FLUSH_MS)
  }

  private requestClose(sessionId: string | null): void {
    if (sessionId === null || sessionId === this.closedSessionId) return
    this.closedSessionId = sessionId
    // The close ack races the server's transcription drain, which keeps the
    // session until commitInput finishes: fence begin until session.closed.
    this.clearFence()
    this.fencedSessionId = sessionId
    this.fenceTimer = setTimeout(() => this.clearFence(), STT_RESULT_TIMEOUT_MS)
    void this.requester.request("talk.session.close", {sessionId}).catch(() => {})
  }

  private clearFence(): void {
    if (this.fenceTimer !== null) {
      clearTimeout(this.fenceTimer)
      this.fenceTimer = null
    }
    this.fencedSessionId = null
  }

  /** End the utterance: clear every timer and field, resolve finish, go idle. */
  private settle(value: string | null): void {
    const resolve = this.resolveFinish
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
