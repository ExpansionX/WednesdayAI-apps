import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"

import type {AudioChunkData} from "@mentra/miniapp/background"

import {
  AUDIO_FLUSH_MS,
  GatewaySttCapture,
  MAX_APPEND_BYTES,
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
    const {requester, capture} = harness()
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
    const {requester, capture} = harness()
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

  it("a create landing after dispose closes without arming any timer", async () => {
    const {requester, capture} = harness()
    const create = deferred<unknown>()
    requester.respond("talk.session.create", () => create.promise)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    capture.dispose()
    expect(requester.callsOf("talk.session.close")).toHaveLength(0)
    create.resolve(CREATE_RESULT)
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    expect(capture.state).toBe("idle")
    // The close still goes out, but no fence timer may outlive dispose.
    expect(vi.getTimerCount()).toBe(0)
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
    // The aborted create is still in flight: B is fenced until it settles
    // and its session retires.
    const createB = deferred<unknown>()
    requester.respond("talk.session.create", () => createB.promise)
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(1)
    createA.resolve(CREATE_RESULT)
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.state).toBe("idle")
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    // The fence holds until the server retires s1.
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(1)
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    capture.begin("sk-2")
    const finishB = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
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

  it("an append failure that lands while finish drains resolves finish with null", async () => {
    const {requester, capture, errors, open} = harness()
    const stuckAppend = deferred<unknown>()
    requester.respond("talk.session.appendAudio", () => stuckAppend.promise)
    await open()
    capture.pushChunk(chunkAt(1))
    await vi.advanceTimersByTimeAsync(250)
    const done = capture.finish()
    expect(capture.active).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    // finish waits for the in-flight append before it may close.
    expect(capture.state).toBe("open")
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

  // ── residual round: R-A late create, R-B terminal before finish, R-C pending fence ──

  it("a create landing after the finish deadline is stale: closed once, never opened", async () => {
    const {requester, capture} = harness()
    const create = deferred<unknown>()
    requester.respond("talk.session.create", () => create.promise)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(STT_RESULT_TIMEOUT_MS)
    expect(await done).toBeNull()
    expect(capture.state).toBe("idle")
    // The late create resolves now: close its session exactly once, never
    // transition to open, never flush.
    create.resolve(CREATE_RESULT)
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.state).toBe("idle")
    expect(capture.active).toBe(false)
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    expect(requester.appends()).toHaveLength(0)
    capture.pushChunk(chunkAt(1))
    await vi.advanceTimersByTimeAsync(250)
    expect(requester.appends()).toHaveLength(0)
  })

  it("resolves finish immediately when a terminal failure arrived before it", async () => {
    const {requester, capture, errors} = harness()
    requester.respond("talk.session.create", () => CREATE_RESULT)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    // The provider fails and the server retires the session before finish.
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    const done = capture.finish()
    // No readiness wait, no deadline: the outcome is already known.
    expect(capture.state).toBe("idle")
    expect(await done).toBeNull()
    expect(errors).toEqual([])
    // The server already retired the session: no close request goes out.
    expect(requester.callsOf("talk.session.close")).toHaveLength(0)
  })

  it("resolves finish with a transcript that arrived before it", async () => {
    const {requester, capture} = harness()
    requester.respond("talk.session.create", () => CREATE_RESULT)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    capture.onTalkEvent({type: "transcript.done", sessionId: "s1", payload: {text: "  early  "}})
    const done = capture.finish()
    expect(capture.state).toBe("idle")
    expect(await done).toBe("early")
    // The session still gets closed exactly once.
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
  })

  it("an aborted pending create fences begin until the create retires", async () => {
    const {requester, capture, errors} = harness()
    const create = deferred<unknown>()
    requester.respond("talk.session.create", () => create.promise)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    capture.abort()
    expect(capture.state).toBe("idle")
    // The first create is still in flight: a second create now would CONFLICT.
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(1)
    expect(errors).toEqual([])
    // The create lands: its session is closed and the fence keeps holding.
    create.resolve(CREATE_RESULT)
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(1)
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(2)
    capture.dispose()
  })

  it("the pending-create fence lifts after the timeout when the create never settles", async () => {
    const {requester, capture} = harness()
    const create = deferred<unknown>()
    requester.respond("talk.session.create", () => create.promise)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    capture.abort()
    await vi.advanceTimersByTimeAsync(STT_RESULT_TIMEOUT_MS - 1)
    capture.begin("sk-2")
    expect(requester.callsOf("talk.session.create")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    capture.begin("sk-3")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(2)
    capture.dispose()
  })

  it("a failed replacement create does not clear an older session's fence", async () => {
    const {requester, capture, errors} = harness()
    const createA = deferred<unknown>()
    const createB = deferred<unknown>()
    requester.respond("talk.session.create", () => createA.promise)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    capture.abort()
    // The pending fence times out; a new question starts B.
    await vi.advanceTimersByTimeAsync(STT_RESULT_TIMEOUT_MS)
    requester.respond("talk.session.create", () => createB.promise)
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(2)
    // A's late create lands: closed once, and its drain fences the capture.
    createA.resolve(CREATE_RESULT)
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    // B fails: that must lift only B's own pending fence, never A's.
    createB.reject(new Error("no active transcription provider"))
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toEqual(["no active transcription provider"])
    capture.begin("sk-3")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(2)
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    capture.begin("sk-3")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(3)
    capture.dispose()
  })

  it("abort and dispose never close a session the server already retired", async () => {
    const {requester, capture, open} = harness()
    await open()
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    capture.abort()
    expect(capture.state).toBe("idle")
    expect(requester.callsOf("talk.session.close")).toHaveLength(0)

    const second = harness()
    await second.open()
    second.capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    second.capture.dispose()
    expect(second.requester.callsOf("talk.session.close")).toHaveLength(0)
  })

  // ── A-01: no periodic re-arm once finish starts ──────────────────────────

  it("never appends after finish started, even with deferred acks and a late chunk", async () => {
    const {requester, capture, errors, setNow, open} = harness()
    const acks = [deferred<unknown>(), deferred<unknown>()]
    let appendIndex = 0
    requester.respond("talk.session.appendAudio", () => {
      // The gateway rejects every append once close has been requested.
      if (requester.callsOf("talk.session.close").length > 0) {
        return Promise.reject(new Error("Unknown realtime relay session"))
      }
      const ack = acks[appendIndex]
      appendIndex += 1
      return ack ? ack.promise : Promise.resolve({})
    })
    await open()
    setNow(100)
    capture.pushChunk(chunkAt(1))
    await vi.advanceTimersByTimeAsync(250)
    // The periodic append is in flight when finish starts.
    expect(requester.appends()).toHaveLength(1)
    setNow(300)
    capture.pushChunk(chunkAt(2))
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    acks[0]!.resolve({})
    await vi.advanceTimersByTimeAsync(0)
    // The final drain waited for the periodic append and is now in flight.
    expect(requester.appends()).toHaveLength(2)
    expect(decoded(requester.appends()[1]!.params.audioBase64)).toEqual(preRollBytes(2, 2))
    // A mic chunk arrives while the final append is still pending.
    setNow(400)
    capture.pushChunk(chunkAt(3))
    acks[1]!.resolve({})
    await vi.advanceTimersByTimeAsync(0)
    // The final drain picked up the late chunk before closing.
    expect(requester.appends()).toHaveLength(3)
    expect(decoded(requester.appends()[2]!.params.audioBase64)).toEqual(preRollBytes(3, 3))
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    // The transcript lands long after any stray periodic timer would fire.
    await vi.advanceTimersByTimeAsync(AUDIO_FLUSH_MS * 4)
    capture.onTalkEvent({type: "transcript.done", sessionId: "s1", payload: {text: "answer"}})
    expect(await done).toBe("answer")
    expect(requester.appends()).toHaveLength(3)
    expect(errors).toEqual([])
    capture.dispose()
  })

  // ── A-02: stop appending once the server retires the session ─────────────

  it("stops streaming when the server retires the session before finish", async () => {
    const {requester, capture, errors, setNow, open} = harness()
    const stuckAppend = deferred<unknown>()
    requester.respond("talk.session.appendAudio", () => stuckAppend.promise)
    await open()
    setNow(100)
    capture.pushChunk(chunkAt(1))
    await vi.advanceTimersByTimeAsync(250)
    expect(requester.appends()).toHaveLength(1)
    // The provider fails and the server removes the session before finish.
    capture.onTalkEvent({type: "session.error", sessionId: "s1", payload: {}})
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    // Mic chunks keep arriving for at least one flush interval.
    setNow(400)
    capture.pushChunk(chunkAt(4))
    setNow(600)
    capture.pushChunk(chunkAt(6))
    await vi.advanceTimersByTimeAsync(AUDIO_FLUSH_MS * 3)
    expect(requester.appends()).toHaveLength(1)
    // The in-flight append then rejects (session removed server-side).
    stuckAppend.reject(new Error("Unknown realtime relay session"))
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toEqual([])
    expect(requester.callsOf("talk.session.close")).toHaveLength(0)
    // finish() still resolves, from the cached terminal, without a close.
    expect(await capture.finish()).toBeNull()
    expect(requester.callsOf("talk.session.close")).toHaveLength(0)
    // No needless fence: a new begin is not blocked by the retired session.
    requester.respond("talk.session.create", () => ({sessionId: "s2", audio: CREATE_RESULT.audio}))
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.callsOf("talk.session.create")).toHaveLength(2)
    capture.dispose()
  })

  // ── A-03: bounded appends for the readiness backlog ──────────────────────

  it("drains the readiness backlog in frames of at most MAX_APPEND_BYTES", async () => {
    const {requester, capture, setNow} = harness()
    requester.respond("talk.session.create", () => CREATE_RESULT)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.state).toBe("open")
    expect(requester.appends()).toHaveLength(0)
    // 130 chunks x 3200 bytes = 416000 decoded bytes (13 s at 16 kHz PCM16) —
    // over the gateway's ~524288-character base64 frame limit in one frame.
    const expected: number[] = []
    for (let index = 0; index < 130; index += 1) {
      const bytes = Array.from({length: 3200}, (_, offset) => (index + offset) % 256)
      expected.push(...bytes)
      setNow(index * 100)
      capture.pushChunk({data: b64(bytes), format: "pcm_s16le", sampleRate: 16000})
    }
    expect(requester.appends()).toHaveLength(0)
    capture.onTalkEvent({type: "session.ready", sessionId: "s1"})
    await vi.advanceTimersByTimeAsync(0)
    const appends = requester.appends()
    expect(appends.length).toBeGreaterThan(1)
    for (const append of appends) {
      expect(decoded(append.params.audioBase64).length).toBeLessThanOrEqual(MAX_APPEND_BYTES)
    }
    expect(appends.flatMap((append) => decoded(append.params.audioBase64))).toEqual(expected)
    capture.dispose()
  })

  // ── A-04: no create-failure report after finish settled ──────────────────

  it("does not report a create error after finish already settled", async () => {
    const {requester, capture, errors} = harness()
    const create = deferred<unknown>()
    requester.respond("talk.session.create", () => create.promise)
    capture.begin("sk-1")
    await vi.advanceTimersByTimeAsync(0)
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(STT_RESULT_TIMEOUT_MS)
    expect(await done).toBeNull()
    expect(capture.state).toBe("idle")
    // The requester's own 30 s timeout lands after finish settled null.
    create.reject(new Error("request timed out after 30000 ms"))
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toEqual([])
    expect(capture.state).toBe("idle")
    expect(capture.active).toBe(false)
    expect(requester.callsOf("talk.session.close")).toHaveLength(0)
    // The capture is not revived by the late rejection.
    capture.pushChunk(chunkAt(1))
    await vi.advanceTimersByTimeAsync(AUDIO_FLUSH_MS)
    expect(requester.appends()).toHaveLength(0)
  })

  // ── A-02 residual: no timer re-arm after a terminal event ────────────────

  it("does not re-arm the periodic timer after a terminal event", async () => {
    const {requester, capture, errors, setNow, open} = harness()
    const ack = deferred<unknown>()
    requester.respond("talk.session.appendAudio", () => ack.promise)
    await open()
    setNow(100)
    capture.pushChunk(chunkAt(1))
    await vi.advanceTimersByTimeAsync(250)
    expect(requester.appends()).toHaveLength(1)
    // The server retires the session while the append is in flight.
    capture.onTalkEvent({type: "session.error", sessionId: "s1", payload: {}})
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    ack.resolve({})
    await vi.advanceTimersByTimeAsync(0)
    // Only the 20 s capture cap may remain: the drain's completion must not
    // re-arm the periodic cadence of a retired session.
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(AUDIO_FLUSH_MS * 4)
    expect(requester.appends()).toHaveLength(1)
    expect(errors).toEqual([])
    // A later finish still settles from the cached terminal.
    expect(await capture.finish()).toBeNull()
    expect(requester.callsOf("talk.session.close")).toHaveLength(0)
  })

  // ── P1: queued drains are bound to their utterance ───────────────────────

  it("a drain queued by finish never runs against a replacement utterance", async () => {
    const {requester, capture, errors, setNow, open} = harness()
    const ack = deferred<unknown>()
    requester.respond("talk.session.appendAudio", () => ack.promise)
    await open()
    setNow(100)
    capture.pushChunk(chunkAt(1))
    await vi.advanceTimersByTimeAsync(250)
    setNow(300)
    capture.pushChunk(chunkAt(2))
    // finish queues its final drain behind the in-flight append...
    const done = capture.finish()
    // ...but the server retires the session first and finish settles null.
    capture.onTalkEvent({type: "session.error", sessionId: "s1", payload: {}})
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    expect(await done).toBeNull()
    // finish pending + session.error settles at once; settle() closes unless
    // the server already did (session.closed lands a moment later).
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s1"}},
    ])
    // A replacement utterance opens s2 and buffers a chunk pre-ready.
    setNow(2000)
    requester.respond("talk.session.create", () => ({sessionId: "s2", audio: CREATE_RESULT.audio}))
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.state).toBe("open")
    setNow(2100)
    capture.pushChunk(chunkAt(3))
    // The old append resolves; the queued drain must discard itself.
    ack.resolve({})
    await vi.advanceTimersByTimeAsync(0)
    expect(requester.appends()).toHaveLength(1)
    expect(errors).toEqual([])
    // s2 streams normally once its provider is ready.
    capture.onTalkEvent({type: "session.ready", sessionId: "s2"})
    await vi.advanceTimersByTimeAsync(0)
    const appends = requester.appends()
    expect(appends).toHaveLength(2)
    expect(appends[1]!.params.sessionId).toBe("s2")
    expect(decoded(appends[1]!.params.audioBase64)).toEqual(preRollBytes(3, 3))
    capture.dispose()
  })

  // ── P2: the append chain does not outlive its utterance ──────────────────

  it("a new utterance does not wait behind a stuck append of a retired session", async () => {
    const {requester, capture, errors, setNow, open} = harness()
    const stuck = deferred<unknown>()
    let appendIndex = 0
    requester.respond("talk.session.appendAudio", () => {
      appendIndex += 1
      return appendIndex === 1 ? stuck.promise : Promise.resolve({})
    })
    await open()
    setNow(100)
    capture.pushChunk(chunkAt(1))
    await vi.advanceTimersByTimeAsync(250)
    // The first append never resolves (requester timeout); the server then
    // retires the session and the capture aborts.
    capture.onTalkEvent({type: "session.error", sessionId: "s1", payload: {}})
    capture.onTalkEvent({type: "session.closed", sessionId: "s1"})
    capture.abort()
    expect(capture.state).toBe("idle")
    // A replacement utterance opens s2 and must stream without waiting.
    // (Clock past the pre-roll window: the retired utterance's chunk is
    // pruned from the ring and must not re-seed the replacement.)
    setNow(3000)
    requester.respond("talk.session.create", () => ({sessionId: "s2", audio: CREATE_RESULT.audio}))
    capture.begin("sk-2")
    await vi.advanceTimersByTimeAsync(0)
    capture.onTalkEvent({type: "session.ready", sessionId: "s2"})
    await vi.advanceTimersByTimeAsync(0)
    setNow(3100)
    capture.pushChunk(chunkAt(2))
    await vi.advanceTimersByTimeAsync(AUDIO_FLUSH_MS)
    const appends = requester.appends()
    expect(appends).toHaveLength(2)
    expect(appends[1]!.params.sessionId).toBe("s2")
    expect(decoded(appends[1]!.params.audioBase64)).toEqual(preRollBytes(2, 2))
    expect(errors).toEqual([])
    // finish is not starved by the stuck append: it resolves with the transcript.
    const done = capture.finish()
    await vi.advanceTimersByTimeAsync(0)
    capture.onTalkEvent({type: "transcript.done", sessionId: "s2", payload: {text: "ok"}})
    expect(await done).toBe("ok")
    expect(requester.callsOf("talk.session.close")).toEqual([
      {method: "talk.session.close", params: {sessionId: "s2"}},
    ])
  })
})
