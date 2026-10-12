import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"

import {GatewayConnection, type GatewayConnectionOptions} from "./connection"
import {DEVICE_AUTH_STORAGE_KEY, GATEWAY_STORAGE_KEY, IDENTITY_STORAGE_KEY} from "./constants"
import {isRecord, type ConnectionState, type KeyValueStore} from "./types"

// The fake satisfies the DOM WebSocket members the connection touches; TS cannot
// unify the event handler types, so the cast lives in this one named boundary.
function asWebSocket(socket: FakeWebSocket): WebSocket {
  return socket as unknown as WebSocket
}

class FakeWebSocket {
  static all: FakeWebSocket[] = []

  readyState = 0
  sent: string[] = []
  onopen: ((event?: unknown) => void) | null = null
  onmessage: ((event: {data: unknown}) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  onclose: ((event: {reason?: string}) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.all.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  // "Server side" driver for the tests.

  sendFrame(frame: unknown): void {
    this.onmessage?.({data: JSON.stringify(frame)})
  }

  closeFromServer(reason = ""): void {
    this.readyState = 3
    this.onclose?.({reason})
  }
}

class ThrowingSendSocket extends FakeWebSocket {
  override send(): void {
    throw new Error("pipe broken")
  }
}

class UnclosableSocket extends FakeWebSocket {
  override close(): void {
    throw new Error("already dead")
  }
}

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.all.at(-1)
  if (!socket) throw new Error("no socket was created")
  return socket
}

function connectParams(socket: FakeWebSocket): Record<string, unknown> | null {
  for (const text of socket.sent) {
    const frame: unknown = JSON.parse(text)
    if (isRecord(frame) && frame.method === "connect" && isRecord(frame.params)) {
      return frame.params
    }
  }
  return null
}

function requestIdFor(socket: FakeWebSocket, method: string): string {
  for (const text of socket.sent) {
    const frame: unknown = JSON.parse(text)
    if (isRecord(frame) && frame.method === method && typeof frame.id === "string") {
      return frame.id
    }
  }
  throw new Error(`no request frame sent for ${method}`)
}

function memoryStore(): KeyValueStore {
  const values = new Map<string, string>()
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

async function storedValue(store: KeyValueStore, key: string): Promise<unknown> {
  const raw = await store.get(key)
  return raw ? JSON.parse(raw) : null
}

async function flush(): Promise<void> {
  // Deep enough for a full challenge→identity→sign→send chain of awaited
  // promises (noble signing plus the shared identity promise hop).
  for (let index = 0; index < 60; index += 1) {
    await Promise.resolve()
  }
}

function deferred(): {promise: Promise<void>; resolve: () => void} {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return {promise, resolve}
}

/** Delays one storage key's reads or writes until the gate resolves, to test
 *  lifecycle races while a storage operation is in flight. */
function gatedStore(base: KeyValueStore, key: string, gate: Promise<void>, mode: "read" | "write"): KeyValueStore {
  return {
    async get(innerKey) {
      if (mode === "read" && innerKey === key) await gate
      return base.get(innerKey)
    },
    async set(innerKey, value) {
      if (mode === "write" && innerKey === key) await gate
      return base.set(innerKey, value)
    },
    delete: (innerKey) => base.delete(innerKey),
  }
}

const GATEWAY_URL = "wss://gw.example.ts.net"
const NOW_MS = 1_700_000_000_000

function challenge(socket: FakeWebSocket, nonce: string): void {
  socket.sendFrame({type: "event", event: "connect.challenge", payload: {nonce}})
}

function helloPayload(auth: unknown): unknown {
  return {
    type: "hello-ok",
    protocol: 3,
    snapshot: {sessionDefaults: {mainKey: "main", mainSessionKey: "agent:main:main", scope: "per-sender"}},
    auth,
  }
}

type Harness = {
  store: KeyValueStore
  states: ConnectionState[]
  options: GatewayConnectionOptions
}

function makeHarness(store: KeyValueStore = memoryStore()): Harness {
  const states: ConnectionState[] = []
  const options: GatewayConnectionOptions = {
    store,
    clientVersion: "0.1.0",
    modelIdentifier: "Even G2",
    createWebSocket: (url) => asWebSocket(new FakeWebSocket(url)),
    now: () => NOW_MS,
    onStateChange: (state) => {
      states.push(state)
    },
  }
  return {store, states, options}
}

type ConnectedSession = {
  connection: GatewayConnection
  socket: FakeWebSocket
}

async function connectWithBootstrap(options: GatewayConnectionOptions, nonce: string): Promise<ConnectedSession> {
  const connection = new GatewayConnection(options)
  await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
  const socket = latestSocket()
  challenge(socket, nonce)
  await flush()
  socket.sendFrame({type: "res", id: "__connect__", ok: true, payload: helloPayload(null)})
  await flush()
  return {connection, socket}
}

describe("GatewayConnection", () => {
  beforeEach(() => {
    FakeWebSocket.all = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("stays unpaired when nothing is stored", async () => {
    const {options, states} = makeHarness()
    const connection = new GatewayConnection(options)
    await connection.start()
    expect(connection.state).toBe("unpaired")
    expect(states).toEqual(["unpaired"])
    expect(FakeWebSocket.all).toHaveLength(0)
  })

  it("sends the connect handshake only after the challenge", async () => {
    const {options} = makeHarness()
    const connection = new GatewayConnection(options)
    await connection.pair({url: `${GATEWAY_URL}:18789/`, bootstrapToken: "boot-1"})
    const socket = latestSocket()
    expect(socket.url).toBe(`${GATEWAY_URL}:18789`)
    expect(connection.state).toBe("connecting")
    expect(socket.sent).toEqual([])
    challenge(socket, "n-1")
    await flush()
    expect(connectParams(socket)).toMatchObject({
      minProtocol: 3,
      maxProtocol: 3,
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      caps: [],
      locale: "en-US",
      userAgent: "WednesdayAI-MentraGlass/0.1.0",
      client: {
        id: "openclaw-mentra-node",
        displayName: "MentraOS glasses",
        version: "0.1.0",
        platform: "mentraos",
        mode: "ui",
        deviceFamily: "glasses",
        modelIdentifier: "Even G2",
      },
      auth: {bootstrapToken: "boot-1"},
      device: {
        nonce: "n-1",
        signedAt: NOW_MS,
        id: expect.any(String),
        publicKey: expect.any(String),
        signature: expect.any(String),
      },
    })
  })

  it("stores the operator token from hello and reconnects with the device token", async () => {
    const {store, options, states} = makeHarness()
    const onHello = vi.fn()
    options.onHello = onHello
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    socket.sendFrame({
      type: "res",
      id: "__connect__",
      ok: true,
      payload: helloPayload({
        deviceTokens: [
          {deviceToken: "op-tok", role: "operator", scopes: ["operator.read", "operator.write"], issuedAtMs: 42},
        ],
      }),
    })
    await flush()
    expect(connection.state).toBe("connected")
    expect(states).toEqual(["connecting", "connected"])
    expect(onHello).toHaveBeenCalledWith({mainSessionKey: "agent:main:main"})
    expect(await storedValue(store, DEVICE_AUTH_STORAGE_KEY)).toEqual({
      [GATEWAY_URL]: {token: "op-tok", role: "operator", scopes: ["operator.read", "operator.write"], issuedAtMs: 42},
    })

    connection.stop()
    const reconnection = new GatewayConnection(options)
    await reconnection.start()
    const secondSocket = latestSocket()
    expect(secondSocket).not.toBe(socket)
    challenge(secondSocket, "n-2")
    await flush()
    expect(connectParams(secondSocket)).toMatchObject({auth: {deviceToken: "op-tok"}})
    const auth = connectParams(secondSocket)?.auth
    expect(isRecord(auth) && "bootstrapToken" in auth).toBe(false)
  })

  it("enters repair_required without reconnecting when the device token is rejected", async () => {
    const store = memoryStore()
    await store.set(GATEWAY_STORAGE_KEY, JSON.stringify({url: GATEWAY_URL}))
    await store.set(
      DEVICE_AUTH_STORAGE_KEY,
      JSON.stringify({[GATEWAY_URL]: {token: "stale-tok", role: "operator", scopes: [], issuedAtMs: 1}}),
    )
    const {options} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.start()
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    socket.sendFrame({
      type: "res",
      id: "__connect__",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Invalid device token",
        details: {code: "AUTH_DEVICE_TOKEN_MISMATCH", authReason: "device-token-mismatch"},
      },
    })
    await flush()
    expect(connection.state).toBe("repair_required")
    expect(connection.lastError).toBe("Invalid device token")
    expect(await storedValue(store, DEVICE_AUTH_STORAGE_KEY)).toEqual({})
    const socketCount = FakeWebSocket.all.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(FakeWebSocket.all).toHaveLength(socketCount)
    expect(connection.state).toBe("repair_required")
  })

  it("keeps the device token and retries with backoff when auth is rate-limited", async () => {
    const store = memoryStore()
    await store.set(GATEWAY_STORAGE_KEY, JSON.stringify({url: GATEWAY_URL}))
    await store.set(
      DEVICE_AUTH_STORAGE_KEY,
      JSON.stringify({[GATEWAY_URL]: {token: "tok", role: "operator", scopes: [], issuedAtMs: 1}}),
    )
    const {options} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.start()
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    // The gateway rate-limits before verifying the device token, so this is
    // transient: the credential must survive and the retry must reuse it.
    socket.sendFrame({
      type: "res",
      id: "__connect__",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized: too many failed authentication attempts (retry later)",
        details: {code: "AUTH_RATE_LIMITED", authReason: "rate_limited"},
      },
    })
    await flush()
    expect(connection.state).toBe("offline")
    expect(connection.retryInMs).toBe(1000)
    expect(connection.lastError).toBe("unauthorized: too many failed authentication attempts (retry later)")
    expect(await storedValue(store, DEVICE_AUTH_STORAGE_KEY)).toEqual({
      [GATEWAY_URL]: {token: "tok", role: "operator", scopes: [], issuedAtMs: 1},
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.all).toHaveLength(2)
    challenge(latestSocket(), "n-2")
    await flush()
    expect(connectParams(latestSocket())).toMatchObject({auth: {deviceToken: "tok"}})
  })

  it("keeps the device token for detail codes that do not implicate the credential", async () => {
    const store = memoryStore()
    const storedAuth = {[GATEWAY_URL]: {token: "tok", role: "operator", scopes: [], issuedAtMs: 1}}
    await store.set(GATEWAY_STORAGE_KEY, JSON.stringify({url: GATEWAY_URL}))
    await store.set(DEVICE_AUTH_STORAGE_KEY, JSON.stringify(storedAuth))
    const {options} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.start()
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    // Shared-token configuration errors contain "token" but say nothing about
    // our device credential; only the structured code decides.
    socket.sendFrame({
      type: "res",
      id: "__connect__",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Invalid gateway token",
        details: {code: "AUTH_TOKEN_MISMATCH", authReason: "token_mismatch"},
      },
    })
    await flush()
    expect(connection.state).toBe("offline")
    expect(connection.retryInMs).toBe(1000)
    expect(await storedValue(store, DEVICE_AUTH_STORAGE_KEY)).toEqual(storedAuth)
  })

  it("schedules a 1000 ms retry after the socket closes", async () => {
    const {options, states} = makeHarness()
    const {connection, socket} = await connectWithBootstrap(options, "n-1")
    expect(connection.state).toBe("connected")
    socket.closeFromServer("socket closed")
    expect(socket.readyState).toBe(3)
    expect(connection.state).toBe("offline")
    expect(connection.retryInMs).toBe(1000)
    expect(states).toContain("offline")
    expect(FakeWebSocket.all).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.all).toHaveLength(2)
    expect(latestSocket().url).toBe(GATEWAY_URL)
    expect(connection.state).toBe("connecting")
  })

  it("goes offline with backoff when the challenge never arrives", async () => {
    const {options} = makeHarness()
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    await vi.advanceTimersByTimeAsync(10_000)
    expect(connection.state).toBe("offline")
    expect(connection.retryInMs).toBe(1000)
    expect(connection.lastError).toBe("Timed out waiting for the gateway challenge")
    expect(FakeWebSocket.all).toHaveLength(1)
  })

  it("routes gateway events and resolves requests with responses", async () => {
    const {options} = makeHarness()
    const onEvent = vi.fn()
    options.onEvent = onEvent
    const {connection, socket} = await connectWithBootstrap(options, "n-1")
    socket.sendFrame({type: "event", event: "voicewake.changed", payload: {triggers: ["wednesday"]}})
    expect(onEvent).toHaveBeenCalledWith("voicewake.changed", {triggers: ["wednesday"]})

    const pending = connection.request<{triggers: string[]}>("voicewake.get", {})
    await flush()
    expect(/^[0-9a-f]{16}$/.test(requestIdFor(socket, "voicewake.get"))).toBe(true)
    socket.sendFrame({
      type: "res",
      id: requestIdFor(socket, "voicewake.get"),
      ok: true,
      payload: {triggers: ["wednesday"]},
    })
    await expect(pending).resolves.toEqual({triggers: ["wednesday"]})
  })

  it("rejects requests with GatewayRequestError when the gateway answers an error", async () => {
    const {options} = makeHarness()
    const {connection, socket} = await connectWithBootstrap(options, "n-1")
    const pending = connection.request("agents.list")
    const assertion = expect(pending).rejects.toMatchObject({
      name: "GatewayRequestError",
      code: "PERMISSION_DENIED",
      message: "missing scope",
    })
    await flush()
    socket.sendFrame({
      type: "res",
      id: requestIdFor(socket, "agents.list"),
      ok: false,
      error: {code: "PERMISSION_DENIED", message: "missing scope"},
    })
    await assertion
  })

  it("rejects a request that times out", async () => {
    const {options} = makeHarness()
    const {connection} = await connectWithBootstrap(options, "n-1")
    const pending = connection.request("agents.list", {}, 50)
    const assertion = expect(pending).rejects.toMatchObject({code: "timeout"})
    await vi.advanceTimersByTimeAsync(50)
    await assertion
  })

  it("forgets the gateway but keeps the identity", async () => {
    const {store, options} = makeHarness()
    const {connection} = await connectWithBootstrap(options, "n-1")
    const identity = await storedValue(store, IDENTITY_STORAGE_KEY)
    expect(identity).not.toBeNull()
    await connection.forget()
    expect(await store.get(GATEWAY_STORAGE_KEY)).toBeNull()
    expect(await store.get(DEVICE_AUTH_STORAGE_KEY)).toBeNull()
    expect(await storedValue(store, IDENTITY_STORAGE_KEY)).toEqual(identity)
    expect(connection.state).toBe("unpaired")
    expect(connection.gatewayUrl).toBeNull()

    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-2"})
    const socket = latestSocket()
    challenge(socket, "n-3")
    await flush()
    expect(connectParams(socket)).toMatchObject({auth: {bootstrapToken: "boot-2"}})
  })

  it("opens no socket when stop() lands during start's storage read", async () => {
    const base = memoryStore()
    await base.set(GATEWAY_STORAGE_KEY, JSON.stringify({url: GATEWAY_URL}))
    await base.set(
      DEVICE_AUTH_STORAGE_KEY,
      JSON.stringify({[GATEWAY_URL]: {token: "tok", role: "operator", scopes: [], issuedAtMs: 1}}),
    )
    const gate = deferred()
    const store = gatedStore(base, GATEWAY_STORAGE_KEY, gate.promise, "read")
    const {options, states} = makeHarness(store)
    const connection = new GatewayConnection(options)
    const starting = connection.start()
    connection.stop()
    gate.resolve()
    await starting
    await flush()
    expect(FakeWebSocket.all).toHaveLength(0)
    expect(states).toEqual([])
    expect(connection.state).toBe("unpaired")
  })

  it("opens no socket when forget() lands during start's storage read", async () => {
    const base = memoryStore()
    await base.set(GATEWAY_STORAGE_KEY, JSON.stringify({url: GATEWAY_URL}))
    await base.set(
      DEVICE_AUTH_STORAGE_KEY,
      JSON.stringify({[GATEWAY_URL]: {token: "tok", role: "operator", scopes: [], issuedAtMs: 1}}),
    )
    const gate = deferred()
    const store = gatedStore(base, GATEWAY_STORAGE_KEY, gate.promise, "read")
    const {options, states} = makeHarness(store)
    const connection = new GatewayConnection(options)
    const starting = connection.start()
    // forget() resets `stopped`, so only the lifecycle generation can abort the
    // suspended start: reconnecting to the just-forgotten gateway would be wrong.
    await connection.forget()
    gate.resolve()
    await starting
    await flush()
    expect(FakeWebSocket.all).toHaveLength(0)
    expect(states).toEqual(["unpaired"])
    expect(connection.state).toBe("unpaired")
  })

  it("leaves no token in storage when forget() lands during hello persistence", async () => {
    const base = memoryStore()
    const gate = deferred()
    const store = gatedStore(base, DEVICE_AUTH_STORAGE_KEY, gate.promise, "write")
    const {options, states} = makeHarness(store)
    const onHello = vi.fn()
    options.onHello = onHello
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    socket.sendFrame({
      type: "res",
      id: "__connect__",
      ok: true,
      payload: helloPayload({
        deviceTokens: [
          {deviceToken: "op-tok", role: "operator", scopes: ["operator.read", "operator.write"], issuedAtMs: 42},
        ],
      }),
    })
    await flush()
    // The hello save is suspended mid-write; Unpair must win and the save must
    // not resurrect the token afterwards.
    const forgetting = connection.forget()
    gate.resolve()
    await forgetting
    await flush()
    expect(await store.get(DEVICE_AUTH_STORAGE_KEY)).toBeNull()
    expect(await store.get(GATEWAY_STORAGE_KEY)).toBeNull()
    expect(connection.state).toBe("unpaired")
    expect(states).not.toContain("connected")
    expect(onHello).not.toHaveBeenCalled()
  })

  it("announces connected only after the hello credential is persisted", async () => {
    const base = memoryStore()
    const gate = deferred()
    const store = gatedStore(base, DEVICE_AUTH_STORAGE_KEY, gate.promise, "write")
    const {options} = makeHarness(store)
    const onHello = vi.fn()
    options.onHello = onHello
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    socket.sendFrame({
      type: "res",
      id: "__connect__",
      ok: true,
      payload: helloPayload({
        deviceTokens: [
          {deviceToken: "op-tok", role: "operator", scopes: ["operator.read", "operator.write"], issuedAtMs: 42},
        ],
      }),
    })
    await flush()
    expect(connection.state).toBe("connecting")
    expect(onHello).not.toHaveBeenCalled()
    gate.resolve()
    await flush()
    expect(connection.state).toBe("connected")
    expect(onHello).toHaveBeenCalledTimes(1)
    expect(await storedValue(store, DEVICE_AUTH_STORAGE_KEY)).toEqual({
      [GATEWAY_URL]: {token: "op-tok", role: "operator", scopes: ["operator.read", "operator.write"], issuedAtMs: 42},
    })
  })

  it("does not resurrect the pairing URL when forget() lands during pair's storage write", async () => {
    const base = memoryStore()
    const gate = deferred()
    const store = gatedStore(base, GATEWAY_STORAGE_KEY, gate.promise, "write")
    const {options, states} = makeHarness(store)
    const connection = new GatewayConnection(options)
    const pairing = connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    // forget() invalidates the reserved pairing generation and queues its
    // deletes behind the suspended URL write.
    const forgetting = connection.forget()
    gate.resolve()
    await Promise.all([pairing, forgetting])
    await flush()
    expect(await store.get(GATEWAY_STORAGE_KEY)).toBeNull()
    expect(await store.get(DEVICE_AUTH_STORAGE_KEY)).toBeNull()
    expect(FakeWebSocket.all).toHaveLength(0)
    expect(connection.state).toBe("unpaired")
    expect(states).toEqual(["unpaired"])
  })

  it("does not let a pending retry for the old gateway win over a new pairing", async () => {
    const base = memoryStore()
    const gate = deferred()
    let gateUrlWrites = false
    const store: KeyValueStore = {
      get: (key) => base.get(key),
      async set(key, value) {
        if (gateUrlWrites && key === GATEWAY_STORAGE_KEY) await gate.promise
        await base.set(key, value)
      },
      delete: (key) => base.delete(key),
    }
    const {options} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-a"})
    latestSocket().closeFromServer("network lost")
    expect(connection.state).toBe("offline")
    expect(connection.retryInMs).toBe(1000)

    gateUrlWrites = true
    const pairing = connection.pair({url: "wss://other.example.ts.net", bootstrapToken: "boot-b"})
    // The old gateway's retry comes due while the new URL write is suspended.
    await vi.advanceTimersByTimeAsync(1500)
    gate.resolve()
    await pairing
    await flush()

    expect(FakeWebSocket.all.map((socket) => socket.url)).toEqual([GATEWAY_URL, "wss://other.example.ts.net"])
    expect(connection.gatewayUrl).toBe("wss://other.example.ts.net")
    expect(await storedValue(store, GATEWAY_STORAGE_KEY)).toEqual({url: "wss://other.example.ts.net"})
  })

  it("retries with the persisted device token when the socket drops during hello persistence", async () => {
    const base = memoryStore()
    const gate = deferred()
    const store = gatedStore(base, DEVICE_AUTH_STORAGE_KEY, gate.promise, "write")
    const {options} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    socket.sendFrame({
      type: "res",
      id: "__connect__",
      ok: true,
      payload: helloPayload({
        deviceTokens: [
          {deviceToken: "op-tok", role: "operator", scopes: ["operator.read", "operator.write"], issuedAtMs: 42},
        ],
      }),
    })
    await flush()
    // The hello save is still in flight when the transport drops.
    socket.closeFromServer("dropped")
    expect(connection.state).toBe("offline")
    await vi.advanceTimersByTimeAsync(1000)
    const second = latestSocket()
    expect(second).not.toBe(socket)
    challenge(second, "n-2")
    await flush()
    // The retry waits for the in-flight commit before choosing credentials, so
    // it must not authenticate with the already-consumed bootstrap token.
    expect(connectParams(second)).toBeNull()
    gate.resolve()
    await flush()
    expect(connectParams(second)).toMatchObject({auth: {deviceToken: "op-tok"}})
    const auth = connectParams(second)?.auth
    expect(isRecord(auth) && "bootstrapToken" in auth).toBe(false)
    second.sendFrame({type: "res", id: "__connect__", ok: true, payload: helloPayload(null)})
    await flush()
    // Pairing survives the drop.
    expect(connection.state).toBe("connected")
    expect(await storedValue(base, DEVICE_AUTH_STORAGE_KEY)).toEqual({
      [GATEWAY_URL]: {token: "op-tok", role: "operator", scopes: ["operator.read", "operator.write"], issuedAtMs: 42},
    })
  })

  it("goes offline with a retry when the identity read rejects before any challenge", async () => {
    const base = memoryStore()
    const store: KeyValueStore = {
      get: (key) => (key === IDENTITY_STORAGE_KEY ? Promise.reject(new Error("storage boom")) : base.get(key)),
      set: (key, value) => base.set(key, value),
      delete: (key) => base.delete(key),
    }
    const {options} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    await flush()
    expect(FakeWebSocket.all).toHaveLength(1)
    expect(connection.state).toBe("offline")
    expect(connection.retryInMs).toBe(1000)
    expect(connection.lastError).toBe("Failed to load the device identity")
    // The retry starts a fresh identity load (the rejected promise is not kept)
    // and backs off again; still no challenge was ever delivered.
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(FakeWebSocket.all).toHaveLength(2)
    expect(connection.state).toBe("offline")
    expect(connection.retryInMs).toBe(2000)
    expect(latestSocket().sent).toEqual([])
  })

  it("shares one identity read with the watchdog active before it resolves", async () => {
    const base = memoryStore()
    let identityReads = 0
    const gate = deferred()
    // Delay only the FIRST identity read so later attempts prove sharing.
    const store: KeyValueStore = {
      async get(key) {
        if (key === IDENTITY_STORAGE_KEY) {
          identityReads += 1
          if (identityReads === 1) await gate.promise
        }
        return base.get(key)
      },
      set: (key, value) => base.set(key, value),
      delete: (key) => base.delete(key),
    }
    const {options} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    // Warm-up and the challenge handler await one shared read; no connect frame
    // can be built while it is blocked.
    expect(identityReads).toBe(1)
    expect(connectParams(socket)).toBeNull()
    expect(connection.state).toBe("connecting")
    // The watchdog is already armed while the read is blocked.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(connection.state).toBe("offline")
    expect(connection.lastError).toBe("Timed out waiting for the gateway challenge")
    // Unblock the shared read; the retry must not re-read the identity.
    gate.resolve()
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    const second = latestSocket()
    expect(second).not.toBe(socket)
    expect(identityReads).toBe(1)
    challenge(second, "n-2")
    await flush()
    expect(connectParams(second)).toMatchObject({auth: {bootstrapToken: "boot-1"}})
    second.sendFrame({type: "res", id: "__connect__", ok: true, payload: helloPayload(null)})
    await flush()
    expect(connection.state).toBe("connected")
    // No stale timeout armed by the late read may drop the connected socket.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(connection.state).toBe("connected")
    expect(FakeWebSocket.all).toHaveLength(2)
  })

  it("rejects in-flight requests when pairing replaces the socket", async () => {
    const {options} = makeHarness()
    const {connection, socket} = await connectWithBootstrap(options, "n-1")
    const pending = connection.request("agents.list")
    const assertion = expect(pending).rejects.toMatchObject({
      name: "GatewayRequestError",
      code: "replaced",
    })
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-2"})
    await assertion
    expect(latestSocket()).not.toBe(socket)
    expect(connection.state).toBe("connecting")
  })

  it("reconnects to the previous gateway when the new pairing URL cannot be saved", async () => {
    const base = memoryStore()
    let failUrlWrite = false
    const store: KeyValueStore = {
      get: (key) => base.get(key),
      async set(key, value) {
        if (failUrlWrite && key === GATEWAY_STORAGE_KEY) throw new Error("disk full")
        return base.set(key, value)
      },
      delete: (key) => base.delete(key),
    }
    const {options} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    const first = latestSocket()
    challenge(first, "n-1")
    await flush()
    first.sendFrame({
      type: "res",
      id: "__connect__",
      ok: true,
      payload: helloPayload({deviceTokens: [{deviceToken: "op-tok", role: "operator", scopes: [], issuedAtMs: 1}]}),
    })
    await flush()
    expect(connection.state).toBe("connected")

    failUrlWrite = true
    await expect(connection.pair({url: "wss://other.example.ts.net", bootstrapToken: "boot-2"})).rejects.toThrow(
      "disk full",
    )
    // The failed pairing invalidated the old socket's generation, so the old
    // gateway is reopened instead of leaving a deaf "connected" socket.
    const second = latestSocket()
    expect(second).not.toBe(first)
    expect(second.url).toBe(GATEWAY_URL)
    challenge(second, "n-2")
    await flush()
    expect(connectParams(second)).toMatchObject({auth: {deviceToken: "op-tok"}})
    second.sendFrame({type: "res", id: "__connect__", ok: true, payload: helloPayload(null)})
    await flush()
    expect(connection.state).toBe("connected")
    expect(await storedValue(base, GATEWAY_STORAGE_KEY)).toEqual({url: GATEWAY_URL})
  })

  it.each([GATEWAY_STORAGE_KEY, DEVICE_AUTH_STORAGE_KEY])(
    "reports unpaired and still deletes the other key when deleting %s fails",
    async (failingKey) => {
      const base = memoryStore()
      const store: KeyValueStore = {
        get: (key) => base.get(key),
        set: (key, value) => base.set(key, value),
        async delete(key) {
          if (key === failingKey) throw new Error("storage busy")
          return base.delete(key)
        },
      }
      const {options} = makeHarness(store)
      const {connection} = await connectWithBootstrap(options, "n-1")
      await base.set(DEVICE_AUTH_STORAGE_KEY, "{}")
      await expect(connection.forget()).rejects.toThrow("storage busy")
      expect(connection.state).toBe("unpaired")
      const otherKey = failingKey === GATEWAY_STORAGE_KEY ? DEVICE_AUTH_STORAGE_KEY : GATEWAY_STORAGE_KEY
      expect(await base.get(otherKey)).toBeNull()
    },
  )

  it("stays unpaired when a gateway URL is stored but no device token exists", async () => {
    const store = memoryStore()
    await store.set(GATEWAY_STORAGE_KEY, JSON.stringify({url: GATEWAY_URL}))
    const {options, states} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.start()
    expect(connection.state).toBe("unpaired")
    expect(states).toEqual(["unpaired"])
    expect(FakeWebSocket.all).toHaveLength(0)
  })

  it.each([
    ["invalid JSON", "not json"],
    ["a non-object payload", "[]"],
    ["a blank url", JSON.stringify({url: "   "})],
  ])("treats a stored gateway record that is %s as unpaired", async (_label, raw) => {
    const store = memoryStore()
    await store.set(GATEWAY_STORAGE_KEY, raw)
    const {options, states} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.start()
    expect(connection.state).toBe("unpaired")
    expect(states).toEqual(["unpaired"])
    expect(FakeWebSocket.all).toHaveLength(0)
  })

  it.each([
    ["invalid JSON", "not json"],
    ["a non-object payload", "[]"],
  ])("treats a stored auth map that is %s as no credentials", async (_label, raw) => {
    const store = memoryStore()
    await store.set(GATEWAY_STORAGE_KEY, JSON.stringify({url: GATEWAY_URL}))
    await store.set(DEVICE_AUTH_STORAGE_KEY, raw)
    const {options, states} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.start()
    expect(connection.state).toBe("unpaired")
    expect(states).toEqual(["unpaired"])
    expect(FakeWebSocket.all).toHaveLength(0)
  })

  it("persists a top-level hello deviceToken and reconnects with it", async () => {
    const {store, options} = makeHarness()
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    // No deviceTokens[] and no role/issuedAtMs: the hello-entry defaults apply.
    socket.sendFrame({
      type: "res",
      id: "__connect__",
      ok: true,
      payload: helloPayload({deviceToken: "top-tok", scopes: ["operator.read"]}),
    })
    await flush()
    expect(connection.state).toBe("connected")
    expect(await storedValue(store, DEVICE_AUTH_STORAGE_KEY)).toEqual({
      [GATEWAY_URL]: {token: "top-tok", role: "operator", scopes: ["operator.read"], issuedAtMs: 0},
    })

    connection.stop()
    const reconnection = new GatewayConnection(options)
    await reconnection.start()
    const second = latestSocket()
    challenge(second, "n-2")
    await flush()
    expect(connectParams(second)).toMatchObject({auth: {deviceToken: "top-tok"}})
    // start() while a socket is live is a no-op, not a second handshake.
    const socketCount = FakeWebSocket.all.length
    await reconnection.start()
    expect(FakeWebSocket.all).toHaveLength(socketCount)
  })

  it("falls back to the top-level deviceToken when deviceTokens[] has no operator entry", async () => {
    const {store, options} = makeHarness()
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    socket.sendFrame({
      type: "res",
      id: "__connect__",
      ok: true,
      payload: helloPayload({
        deviceTokens: [{deviceToken: "admin-tok", role: "admin", scopes: ["operator.admin"], issuedAtMs: 1}],
        deviceToken: "fallback-tok",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        issuedAtMs: 9,
      }),
    })
    await flush()
    expect(connection.state).toBe("connected")
    expect(await storedValue(store, DEVICE_AUTH_STORAGE_KEY)).toEqual({
      [GATEWAY_URL]: {
        token: "fallback-tok",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        issuedAtMs: 9,
      },
    })
  })

  it("connects without persisting a hello auth entry whose token is blank", async () => {
    const {store, options} = makeHarness()
    const onHello = vi.fn()
    options.onHello = onHello
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    socket.sendFrame({
      type: "res",
      id: "__connect__",
      ok: true,
      // No snapshot either: the session defaults are reported as null.
      payload: {type: "hello-ok", protocol: 3, auth: {deviceTokens: [{deviceToken: "   ", role: "operator"}]}},
    })
    await flush()
    expect(connection.state).toBe("connected")
    expect(onHello).toHaveBeenCalledWith({mainSessionKey: null})
    expect(await store.get(DEVICE_AUTH_STORAGE_KEY)).toBeNull()
  })

  it("rejects in-flight requests with 'disconnected' when the server closes the socket", async () => {
    const {options} = makeHarness()
    const {connection, socket} = await connectWithBootstrap(options, "n-1")
    const pending = connection.request("agents.list")
    const assertion = expect(pending).rejects.toMatchObject({name: "GatewayRequestError", code: "disconnected"})
    socket.closeFromServer("server restart")
    await assertion
  })

  it("rejects in-flight requests with 'stopped' when stop() runs", async () => {
    const {options} = makeHarness()
    const {connection} = await connectWithBootstrap(options, "n-1")
    const pending = connection.request("agents.list")
    const assertion = expect(pending).rejects.toMatchObject({name: "GatewayRequestError", code: "stopped"})
    connection.stop()
    await assertion
  })

  it("refuses requests before the connection is established", async () => {
    const {options} = makeHarness()
    const connection = new GatewayConnection(options)
    await expect(connection.request("agents.list")).rejects.toMatchObject({
      name: "GatewayRequestError",
      code: "not_connected",
    })
  })

  it("rejects a request whose frame cannot be sent", async () => {
    const {options} = makeHarness()
    const {connection, socket} = await connectWithBootstrap(options, "n-1")
    socket.send = () => {
      throw new Error("pipe broken")
    }
    await expect(connection.request("agents.list")).rejects.toMatchObject({
      name: "GatewayRequestError",
      code: "disconnected",
      message: "Failed to send to the gateway",
    })
  })

  it("goes offline with a retry when the WebSocket cannot even be created", async () => {
    const {options} = makeHarness()
    let explode = true
    options.createWebSocket = (url) => {
      if (explode) throw new Error("no network")
      return asWebSocket(new FakeWebSocket(url))
    }
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    expect(connection.state).toBe("offline")
    expect(connection.retryInMs).toBe(1000)
    expect(connection.lastError).toBe("no network")
    expect(FakeWebSocket.all).toHaveLength(0)
    explode = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(connection.state).toBe("connecting")
    expect(FakeWebSocket.all).toHaveLength(1)
    challenge(latestSocket(), "n-1")
    await flush()
    expect(connectParams(latestSocket())).toMatchObject({auth: {bootstrapToken: "boot-1"}})
  })

  it("reports a generic failure when the WebSocket factory throws a non-Error", async () => {
    const {options} = makeHarness()
    options.createWebSocket = () => {
      throw "boom"
    }
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    expect(connection.state).toBe("offline")
    expect(connection.retryInMs).toBe(1000)
    expect(connection.lastError).toBe("Failed to open WebSocket")
  })

  it("goes offline with a retry when the socket reports an error", async () => {
    const {options} = makeHarness()
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    latestSocket().onerror?.()
    expect(connection.state).toBe("offline")
    expect(connection.retryInMs).toBe(1000)
    expect(connection.lastError).toBe("Gateway connection failed")
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.all).toHaveLength(2)
  })

  it("ignores malformed, non-string and unknown frames without disturbing the session", async () => {
    const {options} = makeHarness()
    const onEvent = vi.fn()
    options.onEvent = onEvent
    const {connection, socket} = await connectWithBootstrap(options, "n-1")
    socket.onmessage?.({data: "not json"})
    socket.onmessage?.({data: 42})
    socket.onmessage?.({data: "[1, 2]"})
    socket.onmessage?.({data: JSON.stringify({type: "ping"})})
    socket.onmessage?.({data: JSON.stringify({type: "event"})})
    socket.onmessage?.({data: JSON.stringify({type: "res", ok: true, payload: {}})})
    expect(connection.state).toBe("connected")
    expect(onEvent).not.toHaveBeenCalled()
    // The session still works afterwards.
    const pending = connection.request("voicewake.get", {})
    await flush()
    socket.sendFrame({type: "res", id: requestIdFor(socket, "voicewake.get"), ok: true, payload: {triggers: []}})
    await expect(pending).resolves.toEqual({triggers: []})
  })

  it("ignores a challenge without a nonce and lets the watchdog fire", async () => {
    const {options} = makeHarness()
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    const socket = latestSocket()
    socket.sendFrame({type: "event", event: "connect.challenge", payload: {signature: "x"}})
    await flush()
    socket.onmessage?.({data: JSON.stringify({type: "event", event: "connect.challenge", payload: "junk"})})
    await flush()
    expect(connectParams(socket)).toBeNull()
    expect(connection.state).toBe("connecting")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(connection.state).toBe("offline")
    expect(connection.lastError).toBe("Timed out waiting for the gateway challenge")
  })

  it("goes offline when answering the challenge fails", async () => {
    const base = memoryStore()
    const store: KeyValueStore = {
      get: (key) => (key === DEVICE_AUTH_STORAGE_KEY ? Promise.reject(new Error("auth read boom")) : base.get(key)),
      set: (key, value) => base.set(key, value),
      delete: (key) => base.delete(key),
    }
    const {options} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    challenge(latestSocket(), "n-1")
    await flush()
    expect(connection.state).toBe("offline")
    expect(connection.retryInMs).toBe(1000)
    expect(connection.lastError).toBe("Failed to answer the gateway challenge")
  })

  it("drops to offline when the connect frame cannot be sent and retries on a fresh socket", async () => {
    const {options} = makeHarness()
    let failSends = true
    options.createWebSocket = (url) => asWebSocket(failSends ? new ThrowingSendSocket(url) : new FakeWebSocket(url))
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    challenge(latestSocket(), "n-1")
    await flush()
    expect(connection.state).toBe("offline")
    expect(connection.lastError).toBe("Failed to send to the gateway")
    failSends = false
    await vi.advanceTimersByTimeAsync(1000)
    challenge(latestSocket(), "n-2")
    await flush()
    expect(connectParams(latestSocket())).toMatchObject({auth: {bootstrapToken: "boot-1"}})
    latestSocket().sendFrame({type: "res", id: "__connect__", ok: true, payload: helloPayload(null)})
    await flush()
    expect(connection.state).toBe("connected")
  })

  it("enters repair_required when the hello credential cannot be saved", async () => {
    const base = memoryStore()
    const store: KeyValueStore = {
      get: (key) => base.get(key),
      async set(key, value) {
        if (key === DEVICE_AUTH_STORAGE_KEY) throw new Error("disk full")
        return base.set(key, value)
      },
      delete: (key) => base.delete(key),
    }
    const {options} = makeHarness(store)
    const onHello = vi.fn()
    options.onHello = onHello
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    socket.sendFrame({
      type: "res",
      id: "__connect__",
      ok: true,
      payload: helloPayload({
        deviceTokens: [{deviceToken: "op-tok", role: "operator", scopes: ["operator.read"], issuedAtMs: 1}],
      }),
    })
    await flush()
    expect(connection.state).toBe("repair_required")
    expect(connection.lastError).toBe("Failed to save gateway credentials")
    expect(onHello).not.toHaveBeenCalled()
    // No reconnect is scheduled from repair_required.
    const socketCount = FakeWebSocket.all.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(FakeWebSocket.all).toHaveLength(socketCount)
  })

  it("asks for repair when a reconnecting challenge has no credential left", async () => {
    const {options} = makeHarness()
    // Bootstrap pairing succeeds but the gateway issues no device token.
    const {connection, socket} = await connectWithBootstrap(options, "n-1")
    socket.closeFromServer("network lost")
    await vi.advanceTimersByTimeAsync(1000)
    const second = latestSocket()
    expect(second).not.toBe(socket)
    challenge(second, "n-2")
    await flush()
    expect(connectParams(second)).toBeNull()
    expect(connection.state).toBe("repair_required")
    expect(connection.lastError).toBe("No gateway credential. Scan the setup code again.")
    const socketCount = FakeWebSocket.all.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(FakeWebSocket.all).toHaveLength(socketCount)
  })

  it("caps the reconnect backoff at 15000 ms", async () => {
    const {options} = makeHarness()
    const {connection} = await connectWithBootstrap(options, "n-1")
    const delays: Array<number | null> = []
    for (let round = 0; round < 6; round += 1) {
      latestSocket().closeFromServer("flaky link")
      delays.push(connection.retryInMs)
      await vi.advanceTimersByTimeAsync(connection.retryInMs ?? 0)
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000])
  })

  it("falls back through the connect-error message chain and keeps the credential", async () => {
    const store = memoryStore()
    await store.set(GATEWAY_STORAGE_KEY, JSON.stringify({url: GATEWAY_URL}))
    const storedAuth = {[GATEWAY_URL]: {token: "tok", role: "operator", scopes: [], issuedAtMs: 1}}
    await store.set(DEVICE_AUTH_STORAGE_KEY, JSON.stringify(storedAuth))
    const {options} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.start()

    let nonce = 0
    const failWith = async (error: unknown, expectedMessage: string) => {
      nonce += 1
      challenge(latestSocket(), `n-${nonce}`)
      await flush()
      latestSocket().sendFrame({type: "res", id: "__connect__", ok: false, ...(error === null ? {} : {error})})
      await flush()
      expect(connection.state).toBe("offline")
      expect(connection.lastError).toBe(expectedMessage)
      // The backoff grows across rounds; the cap test pins the magnitudes.
      await vi.advanceTimersByTimeAsync(connection.retryInMs ?? 0)
    }

    await failWith(null, "Gateway connect failed") // no error field at all
    await failWith({code: "INVALID_REQUEST"}, "INVALID_REQUEST") // no message, no details
    await failWith({code: 7, message: null}, "Gateway connect failed") // non-string fields
    await failWith({message: "boom", details: "junk"}, "boom") // non-record details
    await failWith({message: "why", details: {code: 5}}, "why") // non-string details.code
    // A transient classification: the stored device token survived every failure.
    expect(await storedValue(store, DEVICE_AUTH_STORAGE_KEY)).toEqual(storedAuth)
    challenge(latestSocket(), `n-${nonce + 1}`)
    await flush()
    expect(connectParams(latestSocket())).toMatchObject({auth: {deviceToken: "tok"}})

    // An empty message with a credential-rejection details.code still means repair.
    nonce += 2
    challenge(latestSocket(), `n-${nonce}`)
    await flush()
    latestSocket().sendFrame({
      type: "res",
      id: "__connect__",
      ok: false,
      error: {message: "", details: {code: "DEVICE_AUTH_INVALID"}},
    })
    await flush()
    expect(connection.state).toBe("repair_required")
    expect(connection.lastError).toBe("DEVICE_AUTH_INVALID")
    expect(await storedValue(store, DEVICE_AUTH_STORAGE_KEY)).toEqual({})
  })

  it("rejects a gateway error response that carries no error body", async () => {
    const {options} = makeHarness()
    const {connection, socket} = await connectWithBootstrap(options, "n-1")
    const pending = connection.request("agents.list")
    const assertion = expect(pending).rejects.toMatchObject({
      name: "GatewayRequestError",
      code: "request_failed",
      message: "Request failed",
    })
    await flush()
    socket.sendFrame({type: "res", id: requestIdFor(socket, "agents.list"), ok: false})
    await assertion
  })

  it("uses the gateway error code as the message when a request error has no message", async () => {
    const {options} = makeHarness()
    const {connection, socket} = await connectWithBootstrap(options, "n-1")
    const pending = connection.request("agents.list")
    const assertion = expect(pending).rejects.toMatchObject({
      name: "GatewayRequestError",
      code: "PERMISSION_DENIED",
      message: "PERMISSION_DENIED",
    })
    await flush()
    socket.sendFrame({
      type: "res",
      id: requestIdFor(socket, "agents.list"),
      ok: false,
      error: {code: "PERMISSION_DENIED"},
    })
    await assertion
  })

  it("falls back to a generic message when the close event carries no reason", async () => {
    const {options} = makeHarness()
    const {connection, socket} = await connectWithBootstrap(options, "n-1")
    socket.onclose?.({})
    expect(connection.state).toBe("offline")
    expect(connection.lastError).toBe("Gateway connection closed")
    expect(connection.retryInMs).toBe(1000)
  })

  it("aborts a start whose auth read is overtaken by forget()", async () => {
    const base = memoryStore()
    await base.set(GATEWAY_STORAGE_KEY, JSON.stringify({url: GATEWAY_URL}))
    const authRaw = JSON.stringify({[GATEWAY_URL]: {token: "tok", role: "operator", scopes: [], issuedAtMs: 1}})
    await base.set(DEVICE_AUTH_STORAGE_KEY, authRaw)
    const gate = deferred()
    // The blocked auth read replays the credentials captured before forget():
    // only the post-read generation guard may abort this start. A store that
    // re-reads base after the gate would let forget()'s deletion mask a missing
    // guard instead.
    const store: KeyValueStore = {
      get: async (key) => {
        if (key !== DEVICE_AUTH_STORAGE_KEY) return base.get(key)
        await gate.promise
        return authRaw
      },
      set: (key, value) => base.set(key, value),
      delete: (key) => base.delete(key),
    }
    const {options, states} = makeHarness(store)
    const connection = new GatewayConnection(options)
    const starting = connection.start()
    // Let the gateway URL read land so start() is parked inside the gated auth
    // read before forget() invalidates the lifecycle generation.
    await flush()
    await connection.forget()
    gate.resolve()
    await starting
    await flush()
    expect(FakeWebSocket.all).toHaveLength(0)
    expect(connection.state).toBe("unpaired")
    expect(states).toEqual(["unpaired"])
  })

  it("never answers a challenge once the socket dropped mid-credential-read", async () => {
    const base = memoryStore()
    await base.set(
      DEVICE_AUTH_STORAGE_KEY,
      JSON.stringify({[GATEWAY_URL]: {token: "tok", role: "operator", scopes: [], issuedAtMs: 1}}),
    )
    const gate = deferred()
    const store = gatedStore(base, DEVICE_AUTH_STORAGE_KEY, gate.promise, "read")
    const {options} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    challenge(latestSocket(), "n-1")
    await flush()
    expect(connectParams(latestSocket())).toBeNull()
    latestSocket().closeFromServer("dropped")
    gate.resolve()
    await flush()
    // The read resumed on a dead socket: no connect frame may go out.
    expect(latestSocket().sent).toEqual([])
    expect(connection.state).toBe("offline")
  })

  it("reconnects with a stored auth record that has junk metadata fields", async () => {
    const store = memoryStore()
    await store.set(GATEWAY_STORAGE_KEY, JSON.stringify({url: GATEWAY_URL}))
    await store.set(DEVICE_AUTH_STORAGE_KEY, JSON.stringify({[GATEWAY_URL]: {token: "tok", scopes: "oops"}}))
    const {options} = makeHarness(store)
    const connection = new GatewayConnection(options)
    await connection.start()
    challenge(latestSocket(), "n-1")
    await flush()
    expect(connectParams(latestSocket())).toMatchObject({auth: {deviceToken: "tok"}})
  })

  it("connects when the hello payload is not even an object", async () => {
    const {options} = makeHarness()
    const onHello = vi.fn()
    options.onHello = onHello
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    const socket = latestSocket()
    challenge(socket, "n-1")
    await flush()
    socket.sendFrame({type: "res", id: "__connect__", ok: true, payload: "junk"})
    await flush()
    expect(connection.state).toBe("connected")
    expect(onHello).toHaveBeenCalledWith({mainSessionKey: null})
    expect(await options.store.get(DEVICE_AUTH_STORAGE_KEY)).toBeNull()
  })

  it("enters repair_required when a bootstrap handshake is rejected outright", async () => {
    const {options} = makeHarness()
    const connection = new GatewayConnection(options)
    await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
    challenge(latestSocket(), "n-1")
    await flush()
    latestSocket().sendFrame({
      type: "res",
      id: "__connect__",
      ok: false,
      error: {code: "INVALID_REQUEST", message: "auth required", details: {code: "AUTH_REQUIRED"}},
    })
    await flush()
    expect(connection.state).toBe("repair_required")
    expect(connection.lastError).toBe("auth required")
    // The bootstrap token was the only credential; nothing was stored to delete.
    expect(await options.store.get(DEVICE_AUTH_STORAGE_KEY)).toBeNull()
  })

  it("connects with the ambient WebSocket, wall clock and no optional fields", async () => {
    const previous = globalThis.WebSocket
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    try {
      const options: GatewayConnectionOptions = {
        store: memoryStore(),
        clientVersion: "0.1.0",
      }
      const connection = new GatewayConnection(options)
      const before = Date.now()
      await connection.pair({url: GATEWAY_URL, bootstrapToken: "boot-1"})
      challenge(latestSocket(), "n-1")
      await flush()
      const params = connectParams(latestSocket())
      expect(isRecord(params?.client) && "modelIdentifier" in params.client).toBe(false)
      const device = params?.device as Record<string, unknown>
      expect(device.signedAt).toBeGreaterThanOrEqual(before)
      expect(device.signedAt).toBeLessThanOrEqual(Date.now())
      latestSocket().sendFrame({type: "res", id: "__connect__", ok: true, payload: helloPayload(null)})
      await flush()
      expect(connection.state).toBe("connected")
    } finally {
      globalThis.WebSocket = previous
    }
  })

  it("survives a socket that refuses to close when stopping", async () => {
    const {options} = makeHarness()
    const onEvent = vi.fn()
    options.onEvent = onEvent
    options.createWebSocket = (url) => asWebSocket(new UnclosableSocket(url))
    const {connection, socket} = await connectWithBootstrap(options, "n-1")
    expect(() => connection.stop()).not.toThrow()

    // The unclosable socket must be fully detached: no handlers left, and late
    // frames or a close cause no events, no reconnect and no state change.
    expect(socket.onopen).toBeNull()
    expect(socket.onmessage).toBeNull()
    expect(socket.onerror).toBeNull()
    expect(socket.onclose).toBeNull()
    socket.sendFrame({type: "event", event: "chat", payload: {runId: "late"}})
    socket.closeFromServer("late close")
    await flush()
    await vi.advanceTimersByTimeAsync(15000)
    expect(onEvent).not.toHaveBeenCalled()
    expect(connection.state).toBe("connected")
    expect(connection.retryInMs).toBeNull()
  })
})
