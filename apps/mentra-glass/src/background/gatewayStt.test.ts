import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"

import type {AudioChunkData} from "@mentra/miniapp/background"

import {
  AUDIO_FLUSH_MS,
  GatewaySttCapture,
  MAX_CAPTURE_MS,
  PREROLL_MS,
  STT_RESULT_TIMEOUT_MS,
} from "./gatewayStt"

const CREATE_RESULT = {sessionId: "s1", audio: {inputEncoding: "pcm16", inputSampleRateHz: 16000, channels: 1}}

/** Base64 for a byte list. */
function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
}

/** Decode an appended audioBase64 payload back to bytes. */
function decoded(audioBase64: string): number[] {
  return [...atob(audioBase64)].map((char) => char.charCodeAt(0))
}

/** Two-byte PCM chunk whose first byte is `index`; natural timestamp is index * 100 ms. */
function chunkAt(index: number, overrides: Partial<AudioChunkData> = {}): AudioChunkData {
  return {data: b64([index, 255 - index]), format: "pcm_s16le", sampleRate: 16000, ...overrides}
}

/** Expected bytes for chunks `from`..`to`: each contributes [i, 255-i]. */
function preRollBytes(from: number, to: number): number[] {
  const bytes: number[] = []
  for (let index = from; index <= to; index += 1) bytes.push(index, 255 - index)
  return bytes
}

type Deferred<T> = {promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void}

/** The app's TS lib is ES2022 — no Promise.withResolvers. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const pending = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise: pending, resolve, reject}
}

interface AppendAudioParams {
  sessionId: string
  audioBase64: string
}

class FakeRequester {
  readonly calls: Array<{method: string; params: unknown}> = []
  private readonly responders: Record<string, () => unknown> = {}

  respond(method: string, answer: () => unknown): void {
    this.responders[method] = answer
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({method, params})
    const responder = this.responders[method]
    if (!responder) return {} as T
    return responder() as T
  }

  callsOf<P = unknown>(method: string): Array<{method: string; params: P}> {
    return this.calls.filter((call): call is {method: string; params: P} => call.method === method)
  }

  appends(): Array<{method: string; params: AppendAudioParams}> {
    return this.callsOf<AppendAudioParams>("talk.session.appendAudio")
  }
}

function harness() {
  const requester = new FakeRequester()
  const errors: string[] = []
  let nowMs = 0
  const capture = new GatewaySttCapture({
    requester,
    now: () => nowMs,
    onError: (message) => errors.push(message),
  })
  /** begin() with the create responder installed, then settle it: capture opens. */
  const open = async (sessionKey = "sk-1") => {
    requester.respond("talk.session.create", () => CREATE_RESULT)
    capture.begin(sessionKey)
    await vi.advanceTimersByTimeAsync(0)
    capture.onTalkEvent({type: "session.ready", sessionId: "s1"})
    await vi.advanceTimersByTimeAsync(0)
  }
  return {requester, errors, capture, setNow: (ms: number) => void (nowMs = ms), open}
}

describe("GatewaySttCapture", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("uses the planned timing values", () => {
    expect(PREROLL_MS).toBe(1500)
    expect(AUDIO_FLUSH_MS).toBe(250)
    expect(STT_RESULT_TIMEOUT_MS).toBe(6000)
    expect(MAX_CAPTURE_MS).toBe(20000)
  })

  it("creates a transcription session with the exact params", async () => {
    const {requester, capture, open} = harness()
    await open()
    expect(requester.callsOf("talk.session.create")).toEqual([
      {
        method: "talk.session.create",
        params: {sessionKey: "sk-1", mode: "transcription", transport: "gateway-relay", brain: "none"},
      },
    ])
    expect(capture.state).toBe("open")
    expect(capture.active).toBe(true)
    capture.dispose()
  })

  it("sends the last 1.5 s of pre-roll in the first append", async () => {
    const {requester, capture, setNow, open} = harness()
    for (let index = 0; index <= 20; index += 1) {
      setNow(index * 100)
      capture.pushChunk(chunkAt(index))
    }
    setNow(2000)
    await open()
    const appends = requester.appends()
    expect(appends).toHaveLength(1)
    expect(appends[0]!.params.sessionId).toBe("s1")
    expect(decoded(appends[0]!.params.audioBase64)).toEqual(preRollBytes(5, 20))
    capture.dispose()
  })

  it("batches live chunks every 250 ms", async () => {
    const {requester, capture, setNow, open} = harness()
    await open()
    setNow(100)
    capture.pushChunk(chunkAt(1))
    setNow(200)
    capture.pushChunk(chunkAt(2))
    await vi.advanceTimersByTimeAsync(250)
    expect(requester.appends()).toHaveLength(1)
    expect(decoded(requester.appends()[0]!.params.audioBase64)).toEqual(preRollBytes(1, 2))
    setNow(400)
    capture.pushChunk(chunkAt(4))
    await vi.advanceTimersByTimeAsync(250)
    expect(requester.appends()).toHaveLength(2)
    expect(decoded(requester.appends()[1]!.params.audioBase64)).toEqual(preRollBytes(4, 4))
    await vi.advanceTimersByTimeAsync(250)
    expect(requester.appends()).toHaveLength(2)
    capture.dispose()
  })

  it("ignores lc3 and non-16k chunks", async () => {
    const {requester, capture, setNow, open} = harness()
    capture.pushChunk(chunkAt(9, {format: "lc3"}))
    capture.pushChunk(chunkAt(8, {sampleRate: 8000}))
    capture.pushChunk({data: b64([7, 248])})
    capture.pushChunk({data: "", format: "pcm_s16le", sampleRate: 16000})
    setNow(100)
    await open()
    const appends = requester.appends()
    expect(appends).toHaveLength(1)
    expect(decoded(appends[0]!.params.audioBase64)).toEqual(preRollBytes(7, 7))
    capture.pushChunk(chunkAt(6, {format: "lc3"}))
    capture.pushChunk(chunkAt(5, {sampleRate: 8000}))
    await vi.advanceTimersByTimeAsync(250)
    expect(requester.appends()).toHaveLength(1)
    capture.dispose()
  })

  it("finish closes the session and resolves the transcript.done text", async () => {
    const {requester, capture, open} = harness()
    await open()
    capture.pushChunk(chunkAt(1))
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.state).toBe("closing")
    expect(capture.active).toBe(false)
    expect(requester.appends()).toHaveLength(1)
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    capture.onTalkEvent({type: "transcript.done", sessionId: "s1", payload: {text: "  hello world "}})
    expect(await done).toBe("hello world")
    expect(capture.state).toBe("idle")
    expect(capture.active).toBe(false)
  })

  it("keeps an early transcript and resolves it when finish arrives", async () => {
    const {capture, open} = harness()
    await open()
    capture.onTalkEvent({type: "transcript.done", sessionId: "s1", payload: {text: "early answer"}})
    expect(capture.state).toBe("open")
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(await done).toBe("early answer")
    expect(capture.state).toBe("idle")
  })

  it("finish resolves null on session.error", async () => {
    const {capture, errors, open} = harness()
    await open()
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    capture.onTalkEvent({type: "session.error", sessionId: "s1", payload: {}})
    expect(await done).toBeNull()
    expect(errors).toEqual([])
  })

  it("finish resolves null on session.closed without a transcript", async () => {
    const {capture, open} = harness()
    await open()
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    expect(await done).toBeNull()
  })

  it("finish resolves null on an empty transcript", async () => {
    const {capture, open} = harness()
    await open()
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    capture.onTalkEvent({type: "transcript.done", sessionId: "s1", payload: {text: "   "}})
    expect(await done).toBeNull()
  })

  it("finish resolves null after 6000 ms without a terminal event", async () => {
    const {capture, errors, open} = harness()
    await open()
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(5999)
    expect(capture.state).toBe("closing")
    await vi.advanceTimersByTimeAsync(1)
    expect(await done).toBeNull()
    expect(capture.state).toBe("idle")
    expect(errors).toEqual([])
  })

  it("create failure resolves finish with null and reports onError", async () => {
    const {requester, capture, errors} = harness()
    const create = deferred<unknown>()
    requester.respond("talk.session.create", () => create.promise)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    create.reject(new Error("no active transcription provider"))
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toEqual(["no active transcription provider"])
    expect(await capture.finish()).toBeNull()
    expect(capture.state).toBe("idle")
    expect(requester.callsOf("talk.session.close")).toHaveLength(0)
  })

  it("treats a create result without a session id as a failure", async () => {
    const {requester, capture, errors} = harness()
    requester.respond("talk.session.create", () => ({noSessionId: true}))
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toHaveLength(1)
    expect(await capture.finish()).toBeNull()
    expect(capture.state).toBe("idle")
    expect(requester.callsOf("talk.session.create")).toHaveLength(1)
  })

  it("abort while opening closes the session once created", async () => {
    const {requester, capture, open} = harness()
    const create = deferred<unknown>()
    requester.respond("talk.session.create", () => create.promise)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    const done = capture.finish()
    capture.abort()
    expect(await done).toBeNull()
    create.resolve(CREATE_RESULT)
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    expect(requester.appends()).toHaveLength(0)
    expect(capture.state).toBe("idle")
    expect(capture.active).toBe(false)
  })

  it("abort while open closes the session and resolves a pending finish with null", async () => {
    const {requester, capture, open} = harness()
    await open()
    const done = capture.finish()
    capture.abort()
    expect(await done).toBeNull()
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    expect(capture.state).toBe("idle")
  })

  it("dispose closes an open session", async () => {
    const {requester, capture, open} = harness()
    await open()
    capture.dispose()
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    expect(capture.state).toBe("idle")
    capture.begin("sk-2")
    capture.pushChunk(chunkAt(1))
    await vi.advanceTimersByTimeAsync(500)
    expect(requester.callsOf("talk.session.create")).toHaveLength(1)
  })

  it("dispose while opening closes the session once created", async () => {
    const {requester, capture, open} = harness()
    const create = deferred<unknown>()
    requester.respond("talk.session.create", () => create.promise)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    capture.dispose()
    create.resolve(CREATE_RESULT)
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    expect(requester.appends()).toHaveLength(0)
    expect(capture.state).toBe("idle")
  })

  it("begin is ignored unless idle", async () => {
    const {requester, capture, open} = harness()
    await open()
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(1)
    capture.onTalkEvent({type: "transcript.done", sessionId: "s1", payload: {text: "hi"}})
    expect(await done).toBe("hi")
  })

  it("events for another session and malformed frames are ignored", async () => {
    const {capture, open} = harness()
    await open()
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    capture.onTalkEvent({type: "transcript.done", sessionId: "s2", payload: {text: "other"}})
    capture.onTalkEvent("garbage")
    capture.onTalkEvent(null)
    capture.onTalkEvent({type: "transcript.done"})
    capture.onTalkEvent({sessionId: "s1"})
    capture.onTalkEvent({type: 7, sessionId: "s1"})
    expect(capture.state).toBe("closing")
    capture.onTalkEvent({type: "transcript.done", sessionId: "s1", payload: {text: "mine"}})
    expect(await done).toBe("mine")
  })

  it("auto-aborts after 20 s without finish", async () => {
    const {requester, capture, open} = harness()
    await open()
    await vi.advanceTimersByTimeAsync(MAX_CAPTURE_MS)
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    expect(capture.state).toBe("idle")
    expect(capture.active).toBe(false)
  })

  it("abort while closing resolves the pending finish and ignores later events", async () => {
    const {requester, capture, open} = harness()
    await open()
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.state).toBe("closing")
    capture.abort()
    expect(capture.state).toBe("idle")
    expect(await done).toBeNull()
    expect(requester.callsOf("talk.session.close")).toHaveLength(1)
    capture.onTalkEvent({type: "transcript.done", sessionId: "s1", payload: {text: "late"}})
    expect(capture.state).toBe("idle")
  })

  it("a stale finish does not touch the replacement capture", async () => {
    const {requester, capture} = harness()
    const createA = deferred<unknown>()
    requester.respond("talk.session.create", () => createA.promise)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    const finishA = capture.finish()
    capture.abort()
    expect(await finishA).toBeNull()
    const createB = deferred<unknown>()
    requester.respond("talk.session.create", () => createB.promise)
    capture.begin("sk-2")
    const finishB = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    createA.resolve(CREATE_RESULT)
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.state).toBe("opening")
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    createB.resolve({sessionId: "s2", audio: CREATE_RESULT.audio})
    await vi.advanceTimersByTimeAsync(0)
    capture.onTalkEvent({type: "session.ready", sessionId: "s2"})
    await vi.advanceTimersByTimeAsync(0)
    // finishB is pending, so B's own flow closes its session and waits for the transcript.
    expect(capture.state).toBe("closing")
    capture.onTalkEvent({type: "transcript.done", sessionId: "s2", payload: {text: "fresh"}})
    expect(await finishB).toBe("fresh")
    expect(requester.callsOf("talk.session.close")).toHaveLength(2)
  })

  it("an append rejection from an earlier capture does not fail the new one", async () => {
    const {requester, capture, errors, setNow, open} = harness()
    const stuckAppend = deferred<unknown>()
    requester.respond("talk.session.appendAudio", () => stuckAppend.promise)
    await open()
    setNow(100)
    capture.pushChunk(chunkAt(1))
    await vi.advanceTimersByTimeAsync(250)
    capture.abort()
    // B's own flushes succeed; only A's in-flight append is left stuck.
    requester.respond("talk.session.appendAudio", () => ({}))
    // The server retires A's session, lifting the begin fence.
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    const createB = deferred<unknown>()
    requester.respond("talk.session.create", () => createB.promise)
    capture.begin("sk-2")
    createB.resolve({sessionId: "s2", audio: CREATE_RESULT.audio})
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.state).toBe("open")
    stuckAppend.reject(new Error("stale append rejected"))
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toEqual([])
    expect(capture.state).toBe("open")
    requester.respond("talk.session.appendAudio", () => ({}))
    setNow(300)
    capture.pushChunk(chunkAt(3))
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    capture.onTalkEvent({type: "transcript.done", sessionId: "s2", payload: {text: "ok"}})
    expect(await done).toBe("ok")
  })

  it("an append failure that lands during closing resolves finish with null", async () => {
    const {requester, capture, errors, open} = harness()
    const stuckAppend = deferred<unknown>()
    requester.respond("talk.session.appendAudio", () => stuckAppend.promise)
    await open()
    capture.pushChunk(chunkAt(1))
    await vi.advanceTimersByTimeAsync(250)
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.state).toBe("closing")
    stuckAppend.reject(new Error("append rejected"))
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.state).toBe("idle")
    expect(await done).toBeNull()
    expect(errors).toEqual(["append rejected"])
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
  })

  it("prunes expired pre-roll when begin starts the capture", async () => {
    const {requester, capture, setNow, open} = harness()
    setNow(0)
    capture.pushChunk(chunkAt(0))
    setNow(2000)
    await open()
    expect(requester.appends()).toHaveLength(0)
    setNow(2100)
    capture.pushChunk(chunkAt(21))
    await vi.advanceTimersByTimeAsync(250)
    expect(requester.appends()).toHaveLength(1)
    expect(decoded(requester.appends()[0]!.params.audioBase64)).toEqual(preRollBytes(21, 21))
    capture.dispose()
  })

  // ── session.ready gating (F1) ────────────────────────────────────────────

  it("buffers audio until session.ready, then flushes pre-roll and live chunks", async () => {
    const {requester, capture, setNow} = harness()
    for (let index = 0; index <= 10; index += 1) {
      setNow(index * 100)
      capture.pushChunk(chunkAt(index))
    }
    setNow(1000)
    requester.respond("talk.session.create", () => CREATE_RESULT)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    // The gateway returns the session id before the provider connects.
    expect(capture.state).toBe("open")
    expect(requester.appends()).toHaveLength(0)
    setNow(1100)
    capture.pushChunk(chunkAt(11))
    await vi.advanceTimersByTimeAsync(1000)
    expect(requester.appends()).toHaveLength(0)
    capture.onTalkEvent({type: "session.ready", sessionId: "s1"})
    await vi.advanceTimersByTimeAsync(0)
    const appends = requester.appends()
    expect(appends).toHaveLength(1)
    expect(decoded(appends[0]!.params.audioBase64)).toEqual(preRollBytes(0, 11))
    capture.dispose()
  })

  it("finish before session.ready waits for ready, then flushes and closes", async () => {
    const {requester, capture, setNow} = harness()
    setNow(0)
    capture.pushChunk(chunkAt(0))
    setNow(100)
    requester.respond("talk.session.create", () => CREATE_RESULT)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(100)
    expect(capture.state).toBe("open")
    expect(requester.callsOf("talk.session.close")).toHaveLength(0)
    capture.onTalkEvent({type: "session.ready", sessionId: "s1"})
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.appends()).toHaveLength(1)
    expect(decoded(requester.appends()[0]!.params.audioBase64)).toEqual(preRollBytes(0, 0))
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    capture.onTalkEvent({type: "transcript.done", sessionId: "s1", payload: {text: " ready now "}})
    expect(await done).toBe("ready now")
  })

  it("closes the session and resolves null when session.ready never arrives", async () => {
    const {requester, capture, errors} = harness()
    requester.respond("talk.session.create", () => CREATE_RESULT)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(STT_RESULT_TIMEOUT_MS)
    expect(await done).toBeNull()
    expect(errors).toEqual([])
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    expect(capture.state).toBe("idle")
  })

  it("resolves null when the session closes before becoming ready, without a close request", async () => {
    const {requester, capture} = harness()
    requester.respond("talk.session.create", () => CREATE_RESULT)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    expect(await done).toBeNull()
    expect(capture.state).toBe("idle")
    expect(requester.callsOf("talk.session.close")).toHaveLength(0)
  })

  // ── finishing excludes the capture from new questions (F3) ───────────────

  it("is no longer active once finish starts, even while the create is in flight", async () => {
    const {requester, capture} = harness()
    const create = deferred<unknown>()
    requester.respond("talk.session.create", () => create.promise)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.active).toBe(true)
    const done = capture.finish()
    expect(capture.active).toBe(false)
    create.resolve(CREATE_RESULT)
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.active).toBe(false)
    capture.onTalkEvent({type: "transcript.done", sessionId: "s1", payload: {text: "hi"}})
    expect(await done).toBe("hi")
    expect(capture.active).toBe(false)
  })

  // ── capture deadline vs transcript deadline (F5) ─────────────────────────

  it("a finish near the capture limit is not cut off by the 20 s deadline", async () => {
    const {requester, capture, open} = harness()
    await open()
    await vi.advanceTimersByTimeAsync(MAX_CAPTURE_MS - 1000)
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.state).toBe("closing")
    await vi.advanceTimersByTimeAsync(2000)
    capture.onTalkEvent({type: "transcript.done", sessionId: "s1", payload: {text: "late but valid"}})
    expect(await done).toBe("late but valid")
    expect(requester.callsOf("talk.session.close")).toHaveLength(1)
  })

  // ── server-session fence after abort (F6) ────────────────────────────────

  it("fences begin until session.closed arrives after an abort", async () => {
    const {requester, capture, errors, open} = harness()
    await open()
    capture.abort()
    expect(capture.state).toBe("idle")
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    // The server still owns the drained session: a create now would CONFLICT.
    expect(requester.callsOf("talk.session.create")).toHaveLength(1)
    expect(errors).toEqual([])
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(2)
    capture.dispose()
  })

  it("lifts the fence when the post-abort drain times out", async () => {
    const {requester, capture, open} = harness()
    await open()
    capture.abort()
    await vi.advanceTimersByTimeAsync(STT_RESULT_TIMEOUT_MS - 1)
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    capture.begin("sk-3")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(2)
    capture.dispose()
  })

  it("a fenced begin after finish waits for session.closed too", async () => {
    const {requester, capture, open} = harness()
    await open()
    const done = capture.finish()
    capture.onTalkEvent({type: "transcript.done", sessionId: "s1", payload: {text: "answer"}})
    expect(await done).toBe("answer")
    expect(capture.state).toBe("idle")
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(1)
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(2)
    capture.dispose()
  })
})
