/**
 * Gateway speech-to-text capture over the `talk.session` relay methods.
 *
 * Pure logic — no gateway-socket ownership — so the controller (and the smoke
 * script) hand in any requester with `request()`; the WednesdayAI gateway
 * allows exactly one transcription session per connection.
 *
 * The controller pushes every 16 kHz PCM16 mic chunk here while connected;
 * `begin()` opens a transcription session carrying the last PREROLL_MS of
 * audio, then live chunks flush every AUDIO_FLUSH_MS. `finish()` closes the
 * session and awaits the gateway transcript, resolving null on session.error,
 * an empty transcript, or the STT_RESULT_TIMEOUT_MS deadline.
 *
 * Leak safety: every successful create ends in exactly one close — via
 * finish, abort (including the auto-abort at MAX_CAPTURE_MS), dispose, or a
 * create that lands after an abort/dispose. LC3 or non-16 kHz chunks never
 * reach appendAudio. `talk.event` payloads are parsed defensively: anything
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
  private closeRequested = false
  private abortRequested = false
  private disposed = false
  private utteranceFailed = false
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

  /** True while a session is being opened or streamed to. */
  get active(): boolean {
    return this.stateValue === "opening" || this.stateValue === "open"
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
    if (this.disposed || this.stateValue !== "idle") return
    this.utterance += 1
    const utterance = this.utterance
    this.abortRequested = false
    this.stateValue = "opening"
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
    void this.runFinish()
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
    }
  }

  /** Stop forever: close any known session; pushChunk/begin become no-ops. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ring.length = 0
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
    if (this.sessionId === null || sessionId !== this.sessionId) return
    if (type === "transcript.done") {
      const eventPayload = payload.payload
      this.transcriptText = isRecord(eventPayload) && typeof eventPayload.text === "string" ? eventPayload.text : null
    } else if (type === "session.error" || type === "session.closed") {
      this.terminalSeen = true
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
      // Stale create (abort/dispose landed, or a newer begin won): still close
      // its session — the gateway allows one transcription session at a time.
      if (outcome.ok) {
        void this.requester.request("talk.session.close", {sessionId: outcome.sessionId}).catch(() => {})
      }
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
    void this.flushOnce().then(() => {
      if (this.stateValue === "open") this.scheduleFlush()
    })
  }

  private async runFinish(): Promise<void> {
    const createPromise = this.createPromise
    if (createPromise) {
      await createPromise
      if (!this.finishPromise) return
    }
    // Stop periodic flushes and push whatever is still buffered before closing.
    this.clearTimer("flushTimer")
    await this.flushOnce()
    if (!this.finishPromise) return
    if (this.utteranceFailed) {
      this.requestClose(this.sessionId)
      this.settle(null)
      return
    }
    this.stateValue = "closing"
    this.requestClose(this.sessionId)
    this.terminalTimer = setTimeout(() => this.settle(null), STT_RESULT_TIMEOUT_MS)
    this.trySettleFromTerminal()
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
    if (this.sessionId === null || this.pending.length === 0) return
    const audioBase64 = concatBase64(this.pending)
    this.pending = []
    try {
      await this.requester.request("talk.session.appendAudio", {sessionId: this.sessionId, audioBase64})
    } catch (error) {
      if (this.disposed || this.sessionId === null) return
      this.utteranceFailed = true
      this.onError?.(error instanceof Error ? error.message : String(error))
    }
  }

  private scheduleFlush(): void {
    this.flushTimer = setTimeout(() => {
      void this.flushOnce().then(() => {
        if (this.stateValue === "open") this.scheduleFlush()
      })
    }, AUDIO_FLUSH_MS)
  }

  private requestClose(sessionId: string | null): void {
    if (sessionId === null || this.closeRequested) return
    this.closeRequested = true
    void this.requester.request("talk.session.close", {sessionId}).catch(() => {})
  }

  /** End the utterance: clear every timer and field, resolve finish, go idle. */
  private settle(value: string | null): void {
    const resolve = this.resolveFinish
    this.clearTimer("flushTimer")
    this.clearTimer("maxTimer")
    this.clearTimer("terminalTimer")
    this.pending = []
    this.sessionId = null
    this.closeRequested = false
    this.createPromise = null
    this.transcriptText = null
    this.terminalSeen = false
    this.utteranceFailed = false
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
