import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"

import type {MiniappSession, RenderElement} from "@mentra/miniapp/background"
import type {GatewayConnection} from "../gateway/connection"
import {base64UrlEncode} from "../gateway/encoding"
import {DEVICE_AUTH_STORAGE_KEY, GATEWAY_STORAGE_KEY, SETTINGS_STORAGE_KEY} from "../gateway/constants"
import type {ConnectionState, KeyValueStore} from "../gateway/types"
import type {Channels, StateSnapshot} from "../shared/channels"

import {AssistantController, type ConnectionHooks} from "./AssistantController"

const GATEWAY_HOST = "wss://gw.example.ts.net"

/** In-memory KeyValueStore matching session.storage's portable shape. */
function memoryStore(seed?: Record<string, string>): KeyValueStore {
  const values = new Map(Object.entries(seed ?? {}))
  return {
    async get(key) {
      return values.get(key) ?? null
    },
    async set(key, value) {
      values.set(key, value)
    },
    async delete(key) {
      values.delete(key)
    },
  }
}

/**
 * Minimal global WebSocket stand-in for the real default connection: records
 * the dialed URL, performs no I/O.
 */
class RecordingWebSocket {
  static all: RecordingWebSocket[] = []

  onopen: unknown = null
  onmessage: unknown = null
  onerror: unknown = null
  onclose: unknown = null

  constructor(readonly url: string) {
    RecordingWebSocket.all.push(this)
  }
}

/**
 * Background-side session fake: storage, transcription with captured
 * subscriptions, display render with scripted arbitration results, the UI
 * bus (send/on/onOpen/onClose), scanQr and the disconnect hook.
 */
class FakeSession {
  readonly storage: KeyValueStore
  readonly capabilities = {display: {width: 576, height: 288}}
  readonly renders: RenderElement[][] = []
  /** Arbitration result per element render, consumed in order. */
  renderStatuses: Array<"displayed" | "blocked"> = []
  readonly uiSends: Array<{channel: string; payload: unknown}> = []
  readonly openHandlers: Array<() => void> = []
  readonly closeHandlers: Array<() => void> = []
  readonly disconnectHandlers: Array<() => void> = []
  readonly scanQr = vi.fn(async () => ({cancelled: true, data: ""}))

  private readonly uiHandlers = new Map<string, Array<(payload: unknown) => void>>()
  private readonly transcriptEntries: Array<{
    handler: (data: {text: string; isFinal: boolean}) => void
    options: {forceLocal?: boolean} | undefined
  }> = []

  constructor(seed?: Record<string, string>, store?: KeyValueStore) {
    this.storage = store ?? memoryStore(seed)
  }

  readonly display = {
    render: async (elements: RenderElement[]) => {
      this.renders.push(elements)
      return {status: this.renderStatuses.shift() ?? ("displayed" as const)}
    },
  }

  readonly system = {scanQr: this.scanQr}

  readonly ui = {
    isOpen: () => true,
    onOpen: (cb: () => void) => {
      this.openHandlers.push(cb)
      return () => {}
    },
    onClose: (cb: () => void) => {
      this.closeHandlers.push(cb)
      return () => {}
    },
    on: (channel: string, cb: (payload: unknown) => void) => {
      const list = this.uiHandlers.get(channel) ?? []
      list.push(cb)
      this.uiHandlers.set(channel, list)
      return () => {
        this.uiHandlers.set(
          channel,
          (this.uiHandlers.get(channel) ?? []).filter((handler) => handler !== cb),
        )
      }
    },
    send: (channel: string, payload: unknown) => {
      this.uiSends.push({channel, payload})
    },
  }

  readonly transcription = {
    on: (handler: (data: {text: string; isFinal: boolean}) => void, options?: {forceLocal?: boolean}) => {
      const entry = {handler, options}
      this.transcriptEntries.push(entry)
      return () => {
        const index = this.transcriptEntries.indexOf(entry)
        if (index >= 0) this.transcriptEntries.splice(index, 1)
      }
    },
  }

  on(event: string, cb: () => void): () => void {
    if (event === "disconnect") this.disconnectHandlers.push(cb)
    return () => {}
  }

  // ── Test drivers ────────────────────────────────────────────────────────

  transcript(text: string, isFinal: boolean): void {
    for (const entry of [...this.transcriptEntries]) entry.handler({text, isFinal})
  }

  uiMessage(channel: string, payload: unknown): void {
    for (const handler of [...(this.uiHandlers.get(channel) ?? [])]) handler(payload)
  }

  transcriptSubscriptions(): Array<{forceLocal?: boolean}> {
    return this.transcriptEntries.map((entry) => entry.options ?? {})
  }
}

/** Duck-typed GatewayConnection with scripted request responses. */
class FakeConnection {
  hooks: ConnectionHooks | null = null
  state: ConnectionState = "connected"
  gatewayUrl: string | null = GATEWAY_HOST
  retryInMs: number | null = null
  lastError: string | null = null
  readonly requests: Array<{method: string; params: unknown}> = []

  private readonly responders = new Map<string, (params: unknown) => unknown>()

  respond(method: string, responder: (params: unknown) => unknown): void {
    this.responders.set(method, responder)
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({method, params})
    const responder = this.responders.get(method)
    if (!responder) throw new Error(`no responder stubbed for ${method}`)
    return await responder(params)
  }

  readonly startCalls: number[] = []

  async start(): Promise<void> {
    this.startCalls.push(1)
  }
  forgetError: Error | null = null
  readonly pairCalls: Array<{url: string; bootstrapToken: string}> = []
  /** When set, pair() rejects with this value (Error or not). */
  pairError: unknown = null
  async pair(setup: {url: string; bootstrapToken: string}): Promise<void> {
    this.pairCalls.push(setup)
    if (this.pairError) throw this.pairError
    // The real connection re-points at the paired gateway; the snapshot reads it.
    this.gatewayUrl = setup.url
  }
  async forget(): Promise<void> {
    this.state = "unpaired"
    if (this.forgetError) throw this.forgetError
  }
  stop(): void {}

  // ── Test drivers ────────────────────────────────────────────────────────

  setState(state: ConnectionState, lastError: string | null = null): void {
    this.state = state
    this.lastError = lastError
    this.hooks?.onStateChange(state, {retryInMs: this.retryInMs, lastError: this.lastError})
  }

  emitEvent(event: string, payload: unknown): void {
    this.hooks?.onEvent(event, payload)
  }

  hello(mainSessionKey: string | null): void {
    void this.hooks?.onHello({mainSessionKey})
  }
}

function stubGateway(
  connection: FakeConnection,
  agents: {defaultId: string; mainKey: string; scope: "per-sender" | "global"} = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
  },
): void {
  connection.respond("voicewake.get", () => ({triggers: ["wednesday"]}))
  connection.respond("agents.list", () => ({
    ...agents,
    agents: [{id: "main", name: "Main"}],
  }))
}

/** Narrows a logged request's params; the controller sent an object. */
function recordParams(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {}
}

function makeController(session: FakeSession, connection = new FakeConnection()): AssistantController {
  return new AssistantController(session as unknown as MiniappSession<Channels>, {
    createConnection: (hooks) => {
      connection.hooks = hooks
      return connection as unknown as GatewayConnection
    },
  })
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}

async function startAssistant(session: FakeSession, connection: FakeConnection): Promise<AssistantController> {
  stubGateway(connection)
  const controller = makeController(session, connection)
  await controller.start()
  connection.hello("agent:main:main")
  await flush()
  return controller
}

function bodyTexts(session: FakeSession): string[] {
  return session.renders.map((elements) => {
    for (const element of elements) {
      if (element.type === "text" && element.id === "wai-body") return element.text
    }
    return ""
  })
}

function headerTexts(session: FakeSession): string[] {
  return session.renders.map((elements) => {
    for (const element of elements) {
      if (element.type === "text" && element.id === "wai-header") return element.text
    }
    return ""
  })
}

function lastSnapshot(session: FakeSession): StateSnapshot {
  for (let index = session.uiSends.length - 1; index >= 0; index -= 1) {
    const send = session.uiSends[index]
    if (send.channel !== "state") continue
    const payload = send.payload
    if (typeof payload === "object" && payload !== null && "settings" in payload) {
      // The controller serialized its own StateSnapshot; the fake lost the type.
      return payload as StateSnapshot
    }
  }
  throw new Error("no state snapshot was pushed")
}

function errorMessages(session: FakeSession): string[] {
  const messages: string[] = []
  for (const send of session.uiSends) {
    if (send.channel !== "error") continue
    const payload = send.payload
    if (
      typeof payload === "object" &&
      payload !== null &&
      "message" in payload &&
      typeof payload.message === "string"
    ) {
      messages.push(payload.message)
    }
  }
  return messages
}

/** Drives a wake transcript through to the chat.send request in flight. */
async function ask(
  session: FakeSession,
  connection: FakeConnection,
  query: string,
  responder?: (params: unknown) => unknown,
): Promise<void> {
  if (responder) connection.respond("chat.send", responder)
  session.transcript(`hey wednesday ${query}`, true)
  await flush()
}

describe("AssistantController", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("routes a wake transcript to chat.send with the resolved sessionKey and renders streamed deltas", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-1", status: "started"}))
    await startAssistant(session, connection)

    await ask(session, connection, "what is two plus two")

    const send = connection.requests.find((request) => request.method === "chat.send")
    const params = recordParams(send?.params)
    expect(params).toMatchObject({
      sessionKey: "agent:main:main",
      message: "what is two plus two",
    })
    expect(typeof params.idempotencyKey).toBe("string")

    await vi.advanceTimersByTimeAsync(0)
    expect(bodyTexts(session)).toEqual(["what is two plus two"])
    expect(headerTexts(session).at(-1)).toContain("Thinking")

    connection.emitEvent("chat", {
      runId: "srv-run-1",
      state: "delta",
      message: {content: [{type: "text", text: "Four"}]},
    })
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    expect(bodyTexts(session).at(-1)).toBe("Four")

    connection.emitEvent("chat", {
      runId: "srv-run-1",
      state: "final",
      message: {content: [{type: "text", text: "Four"}]},
    })
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    expect(bodyTexts(session).at(-1)).toBe("Four")

    // The final frame clears itself 15 s later.
    await vi.advanceTimersByTimeAsync(15000)
    expect(session.renders.at(-1)).toEqual([])
  })

  it("finishes the frame with an offline notice and stops heartbeats when the gateway drops mid-run", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-1"}))
    await startAssistant(session, connection)

    await ask(session, connection, "tell me a story")
    connection.emitEvent("chat", {
      runId: "srv-run-1",
      state: "delta",
      message: {content: [{type: "text", text: "Once upon"}]},
    })
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    const streamedRenders = session.renders.length

    connection.setState("offline")
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    expect(headerTexts(session).at(-1)).toContain("Offline")
    expect(bodyTexts(session).at(-1)).toBe("WednesdayAI is not connected")

    // The run is invalidated: heartbeats stop and late events are ignored.
    await vi.advanceTimersByTimeAsync(10000)
    expect(session.renders.length).toBe(streamedRenders + 2) // offline frame + its clear
    connection.emitEvent("chat", {
      runId: "srv-run-1",
      state: "final",
      message: {content: [{type: "text", text: "late"}]},
    })
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    expect(session.renders.length).toBe(streamedRenders + 2)
  })

  it("does not subscribe or connect when disconnect lands during the initial settings read", async () => {
    // new Promise(executor): the app's TS lib is ES2022 — no Promise.withResolvers.
    let releaseSettings: ((value: string | null) => void) | undefined
    const pendingSettings = new Promise<string | null>((resolve) => {
      releaseSettings = resolve
    })
    const store: KeyValueStore = {
      get: (key) => (key === SETTINGS_STORAGE_KEY ? pendingSettings : Promise.resolve(null)),
      set: async () => {},
      delete: async () => {},
    }
    const session = new FakeSession(undefined, store)
    const connection = new FakeConnection()

    const starting = makeController(session, connection).start()
    // The disconnect hook is registered synchronously, before the first await.
    for (const handler of [...session.disconnectHandlers]) handler()
    releaseSettings?.(null)
    await flush()
    await starting

    expect(session.transcriptSubscriptions()).toEqual([])
    expect(connection.startCalls).toEqual([])
    expect(session.uiSends).toEqual([])
  })

  it("stops all renders and pending-send effects once disconnected", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    // new Promise(executor): the app's TS lib is ES2022 — no Promise.withResolvers.
    let release: ((value: unknown) => void) | undefined
    connection.respond(
      "chat.send",
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    await startAssistant(session, connection)

    await ask(session, connection, "hello there")
    await vi.advanceTimersByTimeAsync(0)
    expect(session.renders.length).toBe(1) // thinking frame

    for (const handler of [...session.disconnectHandlers]) handler()
    await flush()
    const rendersAtDispose = session.renders.length
    const sendsAtDispose = session.uiSends.length
    expect(session.transcriptSubscriptions()).toEqual([])

    release?.({runId: "srv-1"})
    await flush()
    await vi.advanceTimersByTimeAsync(60000)
    expect(session.renders.length).toBe(rendersAtDispose)
    expect(session.uiSends.length).toBe(sendsAtDispose)
  })

  it("does not paint an error frame when a send rejects after disposal", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    // new Promise(executor): the app's TS lib is ES2022 — no Promise.withResolvers.
    let reject: ((err: unknown) => void) | undefined
    connection.respond(
      "chat.send",
      () =>
        new Promise((_resolve, rejectFn) => {
          reject = rejectFn
        }),
    )
    await startAssistant(session, connection)

    await ask(session, connection, "hello there")
    await vi.advanceTimersByTimeAsync(0)

    for (const handler of [...session.disconnectHandlers]) handler()
    await flush()
    const rendersAtDispose = session.renders.length

    reject?.(new Error("Connection stopped"))
    await flush()
    await vi.advanceTimersByTimeAsync(60000)
    expect(session.renders.length).toBe(rendersAtDispose)
  })

  it("finishes thinking when chat.send only acknowledges a spoken stop", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    await ask(session, connection, "stop", () => ({ok: true, aborted: true, runIds: ["srv-1"]}))
    expect(recordParams(connection.requests.at(-1)?.params).message).toBe("stop")

    await vi.advanceTimersByTimeAsync(400)
    expect(bodyTexts(session).at(-1)).toBe("Stopped")
    // "Stopped" is a terminal frame: it auto-hides instead of holding the lock.
    await vi.advanceTimersByTimeAsync(15000)
    expect(session.renders.at(-1)).toEqual([])

    // A stop with nothing running says so instead of hanging too.
    const session2 = new FakeSession()
    const connection2 = new FakeConnection()
    await startAssistant(session2, connection2)
    await ask(session2, connection2, "stop", () => ({ok: true, aborted: false, runIds: []}))
    await vi.advanceTimersByTimeAsync(400)
    expect(bodyTexts(session2).at(-1)).toBe("Nothing to stop")
  })

  it("retries a blocked final frame and still auto-hides at its deadline", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-1"}))
    await startAssistant(session, connection)

    // thinking + streaming render fine; the final frame is dropped once.
    session.renderStatuses = ["displayed", "displayed", "blocked", "displayed"]
    await ask(session, connection, "what is two plus two")
    await vi.advanceTimersByTimeAsync(0) // thinking
    connection.emitEvent("chat", {
      runId: "srv-run-1",
      state: "delta",
      message: {content: [{type: "text", text: "Fou"}]},
    })
    await flush()
    await vi.advanceTimersByTimeAsync(400) // streaming
    connection.emitEvent("chat", {
      runId: "srv-run-1",
      state: "final",
      message: {content: [{type: "text", text: "Four"}]},
    })
    await flush()
    await vi.advanceTimersByTimeAsync(400) // blocked attempt
    const blockedRenders = session.renders.length
    expect(bodyTexts(session).at(-1)).toBe("Four")

    await vi.advanceTimersByTimeAsync(1000) // retry lands
    expect(session.renders.length).toBe(blockedRenders + 1)
    expect(bodyTexts(session).at(-1)).toBe("Four")

    // The deadline is anchored at the frame's first show, not the retry.
    await vi.advanceTimersByTimeAsync(15000)
    expect(session.renders.at(-1)).toEqual([])
    const total = session.renders.length
    await vi.advanceTimersByTimeAsync(30000)
    expect(session.renders.length).toBe(total)
  })

  it("restarts the mic-test silence watchdog when the STT mode changes", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    session.uiMessage("mictest:set", {enabled: true})
    await flush()
    // 9 s of silence, then switch to cloud: a stale timer would fire at t10.
    await vi.advanceTimersByTimeAsync(9000)
    session.uiMessage("settings:set", {wakeSttMode: "cloud"})
    await flush()
    expect(session.transcriptSubscriptions().at(-1)).toEqual({forceLocal: false})

    await vi.advanceTimersByTimeAsync(11000)
    expect(errorMessages(session)).toEqual([])

    // Back to on-device: the silence window restarts from the new subscription.
    session.uiMessage("settings:set", {wakeSttMode: "local"})
    await flush()
    expect(session.transcriptSubscriptions().at(-1)).toEqual({forceLocal: true})
    await vi.advanceTimersByTimeAsync(9999)
    expect(errorMessages(session)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(errorMessages(session)).toHaveLength(1)
    expect(errorMessages(session)[0]).toContain("offline model")
  })

  it("disables the mic test when the phone UI closes", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    session.uiMessage("mictest:set", {enabled: true})
    await flush()
    session.transcript("testing", false)
    expect(session.uiSends.filter((send) => send.channel === "mictest:transcript")).toHaveLength(1)

    for (const handler of [...session.closeHandlers]) handler()
    await flush()
    session.transcript("after close", false)
    expect(session.uiSends.filter((send) => send.channel === "mictest:transcript")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(errorMessages(session)).toEqual([])
  })

  it("clears the saved-agent notice when a valid agent is selected", async () => {
    const session = new FakeSession({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({wakeSttMode: "local", agentId: "gone"}),
    })
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    expect(lastSnapshot(session).lastError).toContain("Saved agent gone no longer exists")

    session.uiMessage("settings:set", {agentId: "main"})
    await flush()
    const snapshot = lastSnapshot(session)
    expect(snapshot.settings.agentId).toBe("main")
    expect(snapshot.lastError).toBeNull()
    const stored = JSON.parse((await session.storage.get(SETTINGS_STORAGE_KEY)) ?? "{}") as {agentId?: string}
    expect(stored.agentId).toBe("main")
  })

  it("tells the user when Unpair cannot delete the stored credentials", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)
    connection.forgetError = new Error("storage busy")

    session.uiMessage("pair:forget", {})
    await flush()

    expect(errorMessages(session)).toEqual(["storage busy"])
    expect(lastSnapshot(session).connection).toBe("unpaired")
  })

  it("retires the active run when pairing a different gateway", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-a"}))
    await startAssistant(session, connection)

    await ask(session, connection, "tell me a story")
    connection.emitEvent("chat", {
      runId: "srv-run-a",
      state: "delta",
      message: {content: [{type: "text", text: "Once upon"}]},
    })
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    const rendersBeforePair = session.renders.length

    const setupCode = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({url: "wss://other.example.ts.net", bootstrapToken: "boot"})),
    )
    session.uiMessage("pair:code", {code: setupCode})
    await flush()
    connection.setState("connected")

    // The old run's frame is retired: no heartbeats renew the display lock.
    await vi.advanceTimersByTimeAsync(20000)
    expect(session.renders.length).toBe(rendersBeforePair + 1) // the retire render([])
    expect(session.renders.at(-1)).toEqual([])

    // Late events from the old gateway's run are ignored.
    connection.emitEvent("chat", {
      runId: "srv-run-a",
      state: "final",
      message: {content: [{type: "text", text: "late"}]},
    })
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(session.renders.length).toBe(rendersBeforePair + 1)
  })

  it("keeps a newer run frame when the listening window expires", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-1"}))
    await startAssistant(session, connection)

    await ask(session, connection, "tell me a story")
    connection.emitEvent("chat", {
      runId: "srv-run-1",
      state: "delta",
      message: {content: [{type: "text", text: "Once upon"}]},
    })
    await flush()
    await vi.advanceTimersByTimeAsync(400)

    // Bare wake phrase during the active run: a listening frame + 8 s window.
    session.transcript("hey wednesday", true)
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    expect(headerTexts(session).at(-1)).toContain("Listening")

    // The run finishes while the window is armed; its final frame replaces it.
    connection.emitEvent("chat", {
      runId: "srv-run-1",
      state: "final",
      message: {content: [{type: "text", text: "A story"}]},
    })
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    expect(bodyTexts(session).at(-1)).toBe("A story")

    // The window expires: cancelAwait only — A's final frame survives…
    await vi.advanceTimersByTimeAsync(8000)
    expect(bodyTexts(session).at(-1)).toBe("A story")
    // …until its own 15 s auto-hide.
    await vi.advanceTimersByTimeAsync(8000)
    expect(session.renders.at(-1)).toEqual([])
  })

  it("keeps voicewake.changed triggers over a racing voicewake.get hydration", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    // new Promise(executor): the app's TS lib is ES2022 — no Promise.withResolvers.
    let releaseGet: ((value: unknown) => void) | undefined
    connection.respond(
      "voicewake.get",
      () =>
        new Promise((resolve) => {
          releaseGet = resolve
        }),
    )
    connection.respond("agents.list", () => ({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender" as const,
      agents: [{id: "main", name: "Main"}],
    }))
    await makeController(session, connection).start()
    connection.hello("agent:main:main")
    await flush()
    expect(connection.requests.some((request) => request.method === "voicewake.get")).toBe(true)

    connection.emitEvent("voicewake.changed", {triggers: ["jarvis"]})
    await flush()
    expect(lastSnapshot(session).triggers).toEqual(["jarvis"])

    // The hydration snapshot is stale: it must not overwrite the newer event.
    releaseGet?.({triggers: ["wednesday"]})
    await flush()
    expect(lastSnapshot(session).triggers).toEqual(["jarvis"])

    connection.respond("chat.send", () => ({runId: "srv-1"}))
    session.transcript("hey jarvis what time is it", true)
    await flush()
    const send = connection.requests.find((request) => request.method === "chat.send")
    expect(recordParams(send?.params).message).toBe("what time is it")
  })

  it("reports micTestEnabled in state snapshots", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)
    expect(lastSnapshot(session).micTestEnabled).toBe(false)

    session.uiMessage("mictest:set", {enabled: true})
    await flush()
    expect(lastSnapshot(session).micTestEnabled).toBe(true)

    // Closing the phone UI disables the mic test; the snapshot reports it.
    for (const handler of [...session.closeHandlers]) handler()
    await flush()
    expect(lastSnapshot(session).micTestEnabled).toBe(false)
  })

  it("opens the gateway socket from stored pairing on startup", async () => {
    const store = memoryStore({
      [GATEWAY_STORAGE_KEY]: JSON.stringify({url: GATEWAY_HOST}),
      [DEVICE_AUTH_STORAGE_KEY]: JSON.stringify({
        [GATEWAY_HOST]: {token: "tok", role: "operator", scopes: [], issuedAtMs: 1},
      }),
    })
    const session = new FakeSession(undefined, store)
    RecordingWebSocket.all = []
    const previous = globalThis.WebSocket
    globalThis.WebSocket = RecordingWebSocket as unknown as typeof WebSocket
    try {
      const controller = new AssistantController(session as unknown as MiniappSession<Channels>)
      await controller.start()
      await flush()

      // start() must boot the stored pairing through the real connection:
      // one socket dialing the stored gateway, announced to the phone UI.
      expect(RecordingWebSocket.all).toHaveLength(1)
      expect(RecordingWebSocket.all[0]?.url).toBe(GATEWAY_HOST)
      const snapshot = lastSnapshot(session)
      expect(snapshot.connection).toBe("connecting")
      expect(snapshot.gatewayHost).toBe("gw.example.ts.net")
    } finally {
      globalThis.WebSocket = previous
    }
  })

  it("falls back to default settings when the stored settings cannot be read", async () => {
    const store: KeyValueStore = {
      get: (key) =>
        key === SETTINGS_STORAGE_KEY ? Promise.reject(new Error("storage corrupted")) : Promise.resolve(null),
      set: async () => {},
      delete: async () => {},
    }
    const session = new FakeSession(undefined, store)
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    expect(session.transcriptSubscriptions().at(-1)).toEqual({forceLocal: true})
    expect(lastSnapshot(session).settings).toEqual({
      wakeSttMode: "local",
      agentId: null,
      querySttMode: "gateway",
      notificationApps: [],
    })
  })

  it("warns when settings cannot be saved but still applies them", async () => {
    const base = memoryStore()
    const store: KeyValueStore = {
      get: (key) => base.get(key),
      set: (key, value) =>
        key === SETTINGS_STORAGE_KEY ? Promise.reject(new Error("disk full")) : base.set(key, value),
      delete: (key) => base.delete(key),
    }
    const session = new FakeSession(undefined, store)
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    session.uiMessage("settings:set", {wakeSttMode: "cloud"})
    await flush()

    expect(errorMessages(session)).toEqual(["disk full"])
    expect(lastSnapshot(session).settings).toEqual({
      wakeSttMode: "cloud",
      agentId: null,
      querySttMode: "gateway",
      notificationApps: [],
    })
    expect(session.transcriptSubscriptions().at(-1)).toEqual({forceLocal: false})
  })

  it("persists the wake STT mode when it changes", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    session.uiMessage("settings:set", {wakeSttMode: "cloud"})
    await flush()

    expect(session.transcriptSubscriptions().at(-1)).toEqual({forceLocal: false})
    const stored = JSON.parse((await session.storage.get(SETTINGS_STORAGE_KEY)) ?? "{}") as {wakeSttMode?: string}
    expect(stored.wakeSttMode).toBe("cloud")
  })

  it("defaults query transcription to the gateway and no notification apps", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    const settings = lastSnapshot(session).settings
    expect(settings.querySttMode).toBe("gateway")
    expect(settings.notificationApps).toEqual([])
  })

  it("persists querySttMode and notificationApps", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    session.uiMessage("settings:set", {querySttMode: "mentra", notificationApps: ["com.whatsapp"]})
    await flush()

    const stored = JSON.parse((await session.storage.get(SETTINGS_STORAGE_KEY)) ?? "{}") as {
      querySttMode?: string
      notificationApps?: string[]
    }
    expect(stored.querySttMode).toBe("mentra")
    expect(stored.notificationApps).toEqual(["com.whatsapp"])

    const restarted = new FakeSession(undefined, session.storage)
    await startAssistant(restarted, connection)
    const settings = lastSnapshot(restarted).settings
    expect(settings.querySttMode).toBe("mentra")
    expect(settings.notificationApps).toEqual(["com.whatsapp"])
  })

  it("sanitizes stored settings", async () => {
    const store = memoryStore({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({querySttMode: "bogus", notificationApps: [1, "a", "a", ""]}),
    })
    const session = new FakeSession(undefined, store)
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    const settings = lastSnapshot(session).settings
    expect(settings.querySttMode).toBe("gateway")
    expect(settings.notificationApps).toEqual(["a"])
  })

  it("routes to the selected agent, shows its name, and persists the choice", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-1"}))
    await startAssistant(session, connection)
    connection.respond("agents.list", () => ({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender" as const,
      agents: [
        {id: "main", name: "Main"},
        {id: "ops", name: "Ops bot"},
      ],
    }))
    connection.hello("agent:main:main")
    await flush()

    session.uiMessage("settings:set", {agentId: "ops"})
    await flush()
    const stored = JSON.parse((await session.storage.get(SETTINGS_STORAGE_KEY)) ?? "{}") as {agentId?: string}
    expect(stored.agentId).toBe("ops")

    await ask(session, connection, "status report")
    const send = connection.requests.find((request) => request.method === "chat.send")
    expect(recordParams(send?.params).sessionKey).toBe("agent:ops:main")

    await vi.advanceTimersByTimeAsync(0)
    expect(headerTexts(session).at(-1)).toBe("WednesdayAI · Ops bot — Thinking…")
  })

  it("routes to the gateway default when the saved agent no longer exists", async () => {
    const session = new FakeSession({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({wakeSttMode: "local", agentId: "gone"}),
    })
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-1"}))
    await startAssistant(session, connection)
    expect(lastSnapshot(session).lastError).toContain("Saved agent gone no longer exists")

    await ask(session, connection, "how late is it")
    const send = connection.requests.find((request) => request.method === "chat.send")
    expect(recordParams(send?.params).sessionKey).toBe("agent:main:main")
  })

  it("routes to the global session when the gateway uses one shared session", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-1"}))
    await startAssistant(session, connection)
    connection.respond("agents.list", () => ({
      defaultId: "main",
      mainKey: "main",
      scope: "global" as const,
      agents: [{id: "main", name: "Main"}],
    }))
    connection.hello("agent:main:main")
    await flush()

    await ask(session, connection, "what is two plus two")
    const send = connection.requests.find((request) => request.method === "chat.send")
    expect(recordParams(send?.params).sessionKey).toBe("global")
  })

  it("shows an offline frame instead of sending when the gateway is down", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)
    connection.setState("offline")

    session.transcript("hey wednesday what is two plus two", true)
    await flush()
    await vi.advanceTimersByTimeAsync(400)

    expect(connection.requests.some((request) => request.method === "chat.send")).toBe(false)
    expect(headerTexts(session).at(-1)).toContain("Offline")
    expect(bodyTexts(session).at(-1)).toBe("WednesdayAI is not connected")
  })

  it("shows the gateway's failure on the glasses when chat.send rejects", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => {
      throw new Error("Gateway queue is full")
    })
    await startAssistant(session, connection)

    await ask(session, connection, "tell me a joke")
    await vi.advanceTimersByTimeAsync(400)

    expect(headerTexts(session).at(-1)).toContain("Error")
    expect(bodyTexts(session).at(-1)).toBe("Gateway queue is full")
  })

  it("shows the run's error message when the gateway reports a failed run", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-1"}))
    await startAssistant(session, connection)

    await ask(session, connection, "what is two plus two")
    connection.emitEvent("chat", {runId: "srv-run-1", state: "error", errorMessage: "Model timed out"})
    await flush()
    await vi.advanceTimersByTimeAsync(400)

    expect(headerTexts(session).at(-1)).toContain("Error")
    expect(bodyTexts(session).at(-1)).toBe("Model timed out")
  })

  it("shows Stopped when the gateway aborts the run", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-1"}))
    await startAssistant(session, connection)

    await ask(session, connection, "tell me a story")
    connection.emitEvent("chat", {runId: "srv-run-1", state: "aborted"})
    await flush()
    await vi.advanceTimersByTimeAsync(400)

    expect(bodyTexts(session).at(-1)).toBe("Stopped")
  })

  it("clears the glasses when pairing is lost mid-run", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-1"}))
    await startAssistant(session, connection)

    await ask(session, connection, "tell me a story")
    await vi.advanceTimersByTimeAsync(0)
    const rendersBefore = session.renders.length

    connection.setState("unpaired")
    await flush()

    expect(session.renders.length).toBe(rendersBefore + 1)
    expect(session.renders.at(-1)).toEqual([])
  })

  it("asks for repair on the glasses when the connection needs re-pairing", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-1"}))
    await startAssistant(session, connection)

    await ask(session, connection, "tell me a story")
    await vi.advanceTimersByTimeAsync(0)
    connection.setState("repair_required", "bootstrap token rejected")
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    expect(headerTexts(session).at(-1)).toContain("Error")
    expect(bodyTexts(session).at(-1)).toBe("bootstrap token rejected")

    // Without a connection error the frame tells the user what to do.
    const session2 = new FakeSession()
    const connection2 = new FakeConnection()
    connection2.respond("chat.send", () => ({runId: "srv-run-2"}))
    await startAssistant(session2, connection2)
    await ask(session2, connection2, "tell me another")
    await vi.advanceTimersByTimeAsync(0)
    connection2.setState("repair_required")
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    expect(bodyTexts(session2).at(-1)).toBe("Pairing needs repair — scan the setup code again")
  })

  it("hides the listening frame when the user changes their mind mid-utterance", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    session.transcript("hey wednesday", false)
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    expect(headerTexts(session).at(-1)).toContain("Listening")

    session.transcript("hey wendy", true)
    await flush()
    expect(session.renders.at(-1)).toEqual([])
    expect(connection.requests.some((request) => request.method === "chat.send")).toBe(false)

    // The window timer is gone: no stray hide arrives later.
    const total = session.renders.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(session.renders.length).toBe(total)
  })

  it("expires the listening window: the frame hides and the next utterance is not a query", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    session.transcript("hey wednesday", true)
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    expect(headerTexts(session).at(-1)).toContain("Listening")

    await vi.advanceTimersByTimeAsync(8000)
    expect(session.renders.at(-1)).toEqual([])

    // The await was cancelled: a later unrelated sentence stays unrelated.
    session.transcript("set a timer", true)
    await flush()
    expect(connection.requests.some((request) => request.method === "chat.send")).toBe(false)
  })

  it("cancels the listening window when the query arrives", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.respond("chat.send", () => ({runId: "srv-run-1"}))
    await startAssistant(session, connection)

    session.transcript("hey wednesday", true)
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    session.transcript("set a timer", true)
    await flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(headerTexts(session).at(-1)).toContain("Thinking")

    // The expired window must not clear the live run frame.
    await vi.advanceTimersByTimeAsync(8000)
    expect(session.renders.at(-1)).not.toEqual([])

    connection.emitEvent("chat", {
      runId: "srv-run-1",
      state: "final",
      message: {content: [{type: "text", text: "Done"}]},
    })
    await flush()
    await vi.advanceTimersByTimeAsync(400)
    expect(bodyTexts(session).at(-1)).toBe("Done")
  })

  it("keeps wake matching idle when voicewake.get fails at hello", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    // Only agents.list has a responder: voicewake.get rejects.
    connection.respond("agents.list", () => ({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender" as const,
      agents: [{id: "main", name: "Main"}],
    }))
    await makeController(session, connection).start()
    connection.hello("agent:main:main")
    await flush()

    // The failure is contained: agents still load.
    expect(lastSnapshot(session).agents).toEqual([{id: "main", label: "Main"}])

    // No hydrated triggers: speech does not fire the assistant.
    session.transcript("hey wednesday what time is it", true)
    await flush()
    expect(connection.requests.some((request) => request.method === "chat.send")).toBe(false)
  })

  it("answers wake queries with the hello's main session when agents.list fails", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    // Only voicewake.get has a responder: agents.list rejects.
    connection.respond("voicewake.get", () => ({triggers: ["wednesday"]}))
    await makeController(session, connection).start()
    // Non-default key: a controller that drops the hello's session and falls
    // back to the agent:main:main default must fail this test.
    connection.hello("agent:ops:custom-main")
    await flush()

    const snapshot = lastSnapshot(session)
    expect(snapshot.agents).toEqual([])
    expect(snapshot.defaultAgentId).toBeNull()

    connection.respond("chat.send", () => ({runId: "srv-run-1"}))
    await ask(session, connection, "what time is it")
    const send = connection.requests.find((request) => request.method === "chat.send")
    expect(recordParams(send?.params).sessionKey).toBe("agent:ops:custom-main")
  })

  it("keeps the connection when the QR scan is cancelled", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    session.uiMessage("pair:scan", {})
    await flush()

    expect(connection.pairCalls).toEqual([])
    expect(errorMessages(session)).toEqual([])
    expect(lastSnapshot(session).connection).toBe("connected")
  })

  it("pairs with the setup code carried by the scanned QR URL", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)
    const setupCode = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({url: "wss://scanned.example.ts.net", bootstrapToken: "boot-1"})),
    )
    // A scanner hands over the QR's full text: a relay URL carrying the code,
    // not the bare setup code.
    session.scanQr.mockResolvedValue({
      cancelled: false,
      data: `https://relay.example/pair?setupCode=${setupCode}`,
    })

    session.uiMessage("pair:scan", {})
    await flush()

    // The scanned text must be parsed before pairing: the connection receives
    // the decoded gateway and token, not the raw QR payload.
    expect(connection.pairCalls).toEqual([{url: "wss://scanned.example.ts.net", bootstrapToken: "boot-1"}])
    // Pairing is consumer-visible: the snapshot reports the scanned gateway.
    expect(lastSnapshot(session).connection).toBe("connected")
    expect(lastSnapshot(session).gatewayHost).toBe("scanned.example.ts.net")
  })

  it("does not pair when the session disconnects during the QR scan", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)
    const setupCode = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({url: "wss://late.example.ts.net", bootstrapToken: "boot-2"})),
    )
    session.scanQr.mockImplementation(async () => {
      for (const handler of [...session.disconnectHandlers]) handler()
      return {cancelled: false, data: setupCode}
    })

    session.uiMessage("pair:scan", {})
    await flush()

    expect(connection.pairCalls).toEqual([])
  })

  it("reports a failed QR scan without pairing", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)
    session.scanQr.mockRejectedValue(new Error("camera unavailable"))

    session.uiMessage("pair:scan", {})
    await flush()

    expect(errorMessages(session)).toEqual(["camera unavailable"])
    expect(connection.pairCalls).toEqual([])
  })

  it("rejects an unrecognised setup code without touching the connection", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    await startAssistant(session, connection)

    session.uiMessage("pair:code", {code: "hello world"})
    await flush()

    expect(errorMessages(session)).toEqual(["Unrecognised setup code"])
    expect(connection.pairCalls).toEqual([])
  })

  it("reports a pairing failure that is not an Error as a plain failure", async () => {
    const session = new FakeSession()
    const connection = new FakeConnection()
    connection.pairError = "gateway socket refused"
    await startAssistant(session, connection)
    const setupCode = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({url: "wss://gw.example.ts.net", bootstrapToken: "boot-3"})),
    )

    session.uiMessage("pair:code", {code: setupCode})
    await flush()

    expect(errorMessages(session)).toEqual(["Pairing failed"])
    expect(lastSnapshot(session).connection).toBe("connected")
  })
})
