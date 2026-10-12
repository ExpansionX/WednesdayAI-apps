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
})
