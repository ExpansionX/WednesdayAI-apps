/**
 * Portions Copyright (c) 2026 solavrc.
 * Ported from openclaw-even-g2-node (MIT License): challenge handshake,
 * v3 device auth, token persistence and reconnect policy.
 */

import {
  CLIENT_DISPLAY_NAME,
  CLIENT_ID,
  CLIENT_MODE,
  CLIENT_PLATFORM,
  DEVICE_AUTH_STORAGE_KEY,
  DEVICE_FAMILY,
  GATEWAY_STORAGE_KEY,
  PROTOCOL_VERSION,
  ROLE,
  SCOPES,
} from "./constants"
import {buildDeviceAuthPayloadV3} from "./device-auth"
import {randomHex} from "./encoding"
import {loadOrCreateIdentity, signPayload, type GatewayIdentity} from "./identity"
import {normalizeGatewayUrl} from "./setup-code"
import {isRecord, type ConnectionState, type KeyValueStore} from "./types"

export type GatewayErrorDetails = {
  code?: string
  [extra: string]: unknown
}

export type GatewayErrorShape = {
  code?: string
  message?: string
  details?: GatewayErrorDetails
}

/** Thrown when a request fails: gateway `ok:false`, timeout, or a dropped socket. */
export class GatewayRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "GatewayRequestError"
  }
}

export type StoredDeviceAuth = {
  token: string
  role: string
  scopes: string[]
  issuedAtMs: number
}

export type GatewayConnectionOptions = {
  store: KeyValueStore
  clientVersion: string
  modelIdentifier?: string
  createWebSocket?: (url: string) => WebSocket
  now?: () => number
  onStateChange?: (state: ConnectionState, info: {retryInMs: number | null; lastError: string | null}) => void
  onEvent?: (event: string, payload: unknown) => void
  onHello?: (hello: {mainSessionKey: string | null}) => void
}

type PendingRequest = {
  resolve: (payload: unknown) => void
  reject: (error: GatewayRequestError) => void
  timer: TimerHandle
}

type HelloAuth = {token: string; role: string; scopes: string[]; issuedAtMs: number}

const CONNECT_REQUEST_ID = "__connect__"
const CHALLENGE_TIMEOUT_MS = 10000
const MAX_BACKOFF_MS = 15000

/** Global `setTimeout` handle; the runtime is the owner of this shape. */
type TimerHandle = ReturnType<typeof setTimeout>

export class GatewayConnection {
  private connectionState: ConnectionState = "unpaired"
  private gatewayUrlValue: string | null = null
  private retryInMsValue: number | null = null
  private lastErrorValue: string | null = null
  private identityPromise: Promise<GatewayIdentity> | null = null
  private socket: WebSocket | null = null
  private bootstrapToken: string | null = null
  private attempt = 0
  private generation = 0
  private stopped = false
  private retryTimer: TimerHandle | null = null
  private challengeTimer: TimerHandle | null = null
  private credentialQueue: Promise<void> = Promise.resolve()
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly options: GatewayConnectionOptions) {}

  get state(): ConnectionState {
    return this.connectionState
  }

  get gatewayUrl(): string | null {
    return this.gatewayUrlValue
  }

  get retryInMs(): number | null {
    return this.retryInMsValue
  }

  get lastError(): string | null {
    return this.lastErrorValue
  }

  /** Reconnects from storage; stays `unpaired` when nothing is stored. */
  async start(): Promise<void> {
    if (this.socket || this.retryTimer) return
    this.stopped = false
    const generation = this.generation
    const url = await this.loadGatewayUrl()
    if (this.stopped || generation !== this.generation) return
    if (!url) {
      this.setState("unpaired")
      return
    }
    const auth = await this.loadStoredAuth(url)
    if (this.stopped || generation !== this.generation) return
    if (!auth) {
      this.setState("unpaired")
      return
    }
    this.bootstrapToken = null
    this.attempt = 0
    this.open(url)
  }

  /** Persists the gateway URL, keeps the bootstrap token in memory only, then connects. */
  async pair(setup: {url: string; bootstrapToken: string}): Promise<void> {
    this.stopped = false
    // Reserve the lifecycle generation up front: stop/forget or a newer pair
    // during the storage work invalidates this attempt instead of racing it.
    const generation = ++this.generation
    // A retry scheduled for the previous gateway must not fire during the
    // storage await and open the old URL under a newer generation.
    this.clearRetryTimer()
    // Same queue as forget()/token commit: a forget queued behind this write
    // deletes it, and this write queued behind a forget rechecks its generation
    // and skips, so the URL can never resurrect after Unpair.
    try {
      await this.withCredentialLock(async () => {
        if (generation !== this.generation || this.stopped) return
        await this.options.store.set(GATEWAY_STORAGE_KEY, JSON.stringify({url: setup.url}))
      })
    } catch (error) {
      // The reserved generation already deafened the previous socket; reopen the
      // previous gateway instead of leaving a "connected" state nobody hears.
      const previous = this.gatewayUrlValue
      if (!this.stopped && generation === this.generation && previous) this.open(previous)
      throw error
    }
    if (this.stopped || generation !== this.generation) return
    this.bootstrapToken = setup.bootstrapToken
    this.attempt = 0
    this.open(normalizeGatewayUrl(setup.url))
  }

  /** Drops the pairing and tokens; the device identity survives for re-pairing. */
  async forget(): Promise<void> {
    // Invalidate in-flight start/pair/hello work before touching storage so a
    // late credential write cannot resurrect what this method deletes.
    const generation = ++this.generation
    this.stopped = false
    this.clearRetryTimer()
    this.clearChallengeTimer()
    this.rejectAllPending(new GatewayRequestError("Gateway forgotten", "forgotten"))
    this.teardownSocket()
    this.bootstrapToken = null
    this.gatewayUrlValue = null
    this.retryInMsValue = null
    this.lastErrorValue = null
    this.attempt = 0
    // Try both deletions even if one fails; the in-memory teardown above already
    // happened, so the reported state must say unpaired either way.
    const failure = await this.withCredentialLock(async () => {
      let firstError: unknown = null
      for (const key of [GATEWAY_STORAGE_KEY, DEVICE_AUTH_STORAGE_KEY]) {
        try {
          await this.options.store.delete(key)
        } catch (error) {
          firstError ??= error
        }
      }
      return firstError
    })
    // A newer lifecycle operation (pair/stop/another forget) owns the state now.
    if (generation === this.generation) this.setState("unpaired")
    if (failure !== null) throw failure
  }

  /** Stops I/O and timers without changing the reported state. */
  stop(): void {
    this.stopped = true
    this.generation += 1
    this.clearRetryTimer()
    this.clearChallengeTimer()
    this.rejectAllPending(new GatewayRequestError("Connection stopped", "stopped"))
    this.teardownSocket()
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    const socket = this.socket
    if (!socket || this.connectionState !== "connected") {
      throw new GatewayRequestError("Not connected to the gateway", "not_connected")
    }
    const id = randomHex(8)
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new GatewayRequestError(`Gateway request timed out after ${timeoutMs} ms`, "timeout"))
      }, timeoutMs)
      this.pending.set(id, {resolve: resolve as (payload: unknown) => void, reject, timer})
      try {
        socket.send(JSON.stringify({type: "req", id, method, ...(params === undefined ? {} : {params})}))
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new GatewayRequestError("Failed to send to the gateway", "disconnected"))
      }
    })
  }

  private open(url: string): void {
    if (this.stopped) return
    this.clearRetryTimer()
    this.clearChallengeTimer()
    // Replacing a live socket (pairing over an active connection) must fail its
    // in-flight requests: their responses can only ever arrive on the old socket.
    this.rejectAllPending(new GatewayRequestError("Connection replaced by a newer pairing", "replaced"))
    this.teardownSocket()
    this.gatewayUrlValue = url
    this.setState("connecting")
    let socket: WebSocket
    try {
      socket = (this.options.createWebSocket ?? ((wsUrl) => new WebSocket(wsUrl)))(url)
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : "Failed to open WebSocket")
      return
    }
    const generation = ++this.generation
    this.socket = socket
    socket.onopen = () => {}
    socket.onmessage = (event) => {
      this.handleMessageData(event.data, generation)
    }
    socket.onerror = () => {
      this.handleTransportDrop(generation, "Gateway connection failed")
    }
    socket.onclose = (event) => {
      this.handleSocketClose(generation, typeof event?.reason === "string" ? event.reason : "")
    }
    // Arm the handshake watchdog before any await: the challenge can arrive while
    // identity storage is still being read, and a stale identity load must never
    // arm a timeout against a newer socket.
    this.armChallengeTimer(generation)
    // The warm-up must never surface as an unhandled rejection: route failures
    // through the generation-guarded transport drop (offline + backoff).
    this.ensureIdentity().catch(() => {
      this.handleTransportDrop(generation, "Failed to load the device identity")
    })
  }

  /** One shared identity load per connection: the challenge handler and socket
   *  warm-up must never race two storage reads into two different identities. */
  private ensureIdentity(): Promise<GatewayIdentity> {
    this.identityPromise ??= loadOrCreateIdentity(this.options.store).then(undefined, (error: unknown) => {
      this.identityPromise = null
      throw error
    })
    return this.identityPromise
  }

  private handleMessageData(data: unknown, generation: number): void {
    if (generation !== this.generation || typeof data !== "string") return
    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    if (!isRecord(frame)) return
    if (frame.type === "res") {
      this.handleResponse(frame, generation)
      return
    }
    if (frame.type === "event" && typeof frame.event === "string") {
      if (frame.event === "connect.challenge") {
        void this.handleChallenge(frame.payload, generation).catch(() => {
          this.handleTransportDrop(generation, "Failed to answer the gateway challenge")
        })
        return
      }
      this.options.onEvent?.(frame.event, frame.payload)
    }
  }

  private handleResponse(frame: Record<string, unknown>, generation: number): void {
    if (frame.id !== CONNECT_REQUEST_ID) {
      this.resolvePending(frame)
      return
    }
    this.clearChallengeTimer()
    if (frame.ok === true) {
      void this.handleHello(frame.payload, generation)
      return
    }
    this.handleConnectError(readGatewayError(frame.error))
  }

  private resolvePending(frame: Record<string, unknown>): void {
    const id = typeof frame.id === "string" ? frame.id : ""
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (frame.ok === true) {
      pending.resolve(frame.payload)
      return
    }
    const error = readGatewayError(frame.error)
    pending.reject(
      new GatewayRequestError(
        error?.message ?? error?.code ?? "Request failed",
        error?.code ?? "request_failed",
        error?.details,
      ),
    )
  }

  private async handleChallenge(payload: unknown, generation: number): Promise<void> {
    const nonce = readStringField(payload, "nonce")
    const url = this.gatewayUrlValue
    if (!nonce || !url) return
    const identity = await this.ensureIdentity()
    if (generation !== this.generation || !this.socket) return
    // Wait out any in-flight credential commit (a hello save racing a transport
    // drop) before choosing credentials: the retry must authenticate with the
    // just-persisted device token, not the already-consumed bootstrap token.
    await this.credentialQueue
    if (generation !== this.generation || !this.socket) return
    // Credential order: stored device token first, then the in-memory bootstrap token.
    const stored = await this.loadStoredAuth(url)
    const token = stored?.token ?? this.bootstrapToken
    if (generation !== this.generation || !this.socket) return
    if (!token) {
      this.teardownSocket()
      this.retryInMsValue = null
      this.setState("repair_required", {lastError: "No gateway credential. Scan the setup code again."})
      return
    }
    const signedAt = this.now()
    const signature = await signPayload(
      identity,
      buildDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId: CLIENT_ID,
        clientMode: CLIENT_MODE,
        role: ROLE,
        scopes: SCOPES,
        signedAtMs: signedAt,
        token,
        nonce,
        platform: CLIENT_PLATFORM,
        deviceFamily: DEVICE_FAMILY,
      }),
    )
    if (generation !== this.generation || !this.socket) return
    this.send(generation, {
      type: "req",
      id: CONNECT_REQUEST_ID,
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: CLIENT_ID,
          displayName: CLIENT_DISPLAY_NAME,
          version: this.options.clientVersion,
          platform: CLIENT_PLATFORM,
          mode: CLIENT_MODE,
          deviceFamily: DEVICE_FAMILY,
          ...(this.options.modelIdentifier ? {modelIdentifier: this.options.modelIdentifier} : {}),
        },
        role: ROLE,
        scopes: [...SCOPES],
        caps: [] as string[],
        auth: stored ? {deviceToken: token} : {bootstrapToken: token},
        locale: "en-US",
        userAgent: `WednesdayAI-MentraGlass/${this.options.clientVersion}`,
        device: {
          id: identity.deviceId,
          publicKey: identity.publicKeyB64u,
          signature,
          signedAt,
          nonce,
        },
      },
    })
  }

  private async handleHello(payload: unknown, generation: number): Promise<void> {
    const auth = helloDeviceAuth(payload)
    if (auth) {
      try {
        // Commit the new credential before trusting the connection: the gateway
        // has already consumed a one-use bootstrap token by now, so a failed or
        // interrupted save must not announce a pairing the next start cannot use.
        await this.commitStoredAuth(auth, generation)
      } catch {
        if (generation !== this.generation || this.stopped || !this.socket) return
        this.teardownSocket()
        this.bootstrapToken = null
        this.retryInMsValue = null
        this.setState("repair_required", {lastError: "Failed to save gateway credentials"})
        return
      }
    }
    if (generation !== this.generation || this.stopped || !this.socket) return
    this.bootstrapToken = null
    this.attempt = 0
    this.retryInMsValue = null
    this.lastErrorValue = null
    this.setState("connected")
    this.options.onHello?.({mainSessionKey: readMainSessionKey(payload)})
  }

  private handleConnectError(error: GatewayErrorShape | undefined): void {
    const message = error?.message || error?.details?.code || error?.code || "Gateway connect failed"
    if (isCredentialRejection(error)) {
      this.teardownSocket()
      if (this.gatewayUrlValue) void this.deleteStoredAuth(this.gatewayUrlValue)
      this.bootstrapToken = null
      this.rejectAllPending(new GatewayRequestError(message, "connect_rejected", error))
      this.retryInMsValue = null
      this.setState("repair_required", {lastError: message})
      return
    }
    // Transient (e.g. AUTH_RATE_LIMITED, decided before the token is verified) or
    // unknown detail codes keep both credentials and go through reconnect backoff.
    this.scheduleReconnect(message)
  }

  private handleTransportDrop(generation: number, message: string): void {
    if (generation !== this.generation || !this.socket) return
    this.teardownSocket()
    this.scheduleReconnect(message)
  }

  private handleSocketClose(generation: number, reason: string): void {
    if (generation !== this.generation || !this.socket) return
    this.teardownSocket()
    this.scheduleReconnect(reason || "Gateway connection closed")
  }

  private scheduleReconnect(message: string): void {
    if (this.stopped || !this.gatewayUrlValue) return
    this.teardownSocket()
    this.clearChallengeTimer()
    this.rejectAllPending(new GatewayRequestError(message, "disconnected"))
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempt, 4))
    this.attempt += 1
    this.retryInMsValue = delay
    this.lastErrorValue = message
    this.setState("offline")
    const url = this.gatewayUrlValue
    const generation = this.generation
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (generation !== this.generation || this.stopped) return
      this.retryInMsValue = null
      this.open(url)
    }, delay)
  }

  private send(generation: number, frame: unknown): void {
    const socket = this.socket
    if (!socket || generation !== this.generation) return
    try {
      socket.send(JSON.stringify(frame))
    } catch {
      this.handleTransportDrop(generation, "Failed to send to the gateway")
    }
  }

  private armChallengeTimer(generation: number): void {
    this.clearChallengeTimer()
    this.challengeTimer = setTimeout(() => {
      this.challengeTimer = null
      if (generation !== this.generation || !this.socket) return
      this.handleTransportDrop(generation, "Timed out waiting for the gateway challenge")
    }, CHALLENGE_TIMEOUT_MS)
  }

  private teardownSocket(): void {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close(1000, "client closing connection")
    } catch {
      // The socket may already be dead; nothing to recover.
    }
  }

  private rejectAllPending(error: GatewayRequestError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private setState(state: ConnectionState, info?: {lastError?: string}): void {
    this.connectionState = state
    if (info && "lastError" in info) this.lastErrorValue = info.lastError ?? null
    this.options.onStateChange?.(state, {retryInMs: this.retryInMsValue, lastError: this.lastErrorValue})
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private clearChallengeTimer(): void {
    if (this.challengeTimer === null) return
    clearTimeout(this.challengeTimer)
    this.challengeTimer = null
  }

  private async loadGatewayUrl(): Promise<string | null> {
    const raw = await this.options.store.get(GATEWAY_STORAGE_KEY)
    if (!raw) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed) || typeof parsed.url !== "string" || !parsed.url.trim()) return null
      return normalizeGatewayUrl(parsed.url)
    } catch {
      return null
    }
  }

  private async loadStoredAuth(url: string): Promise<StoredDeviceAuth | null> {
    const entry = (await this.loadAuthMap())[url]
    if (!isRecord(entry) || typeof entry.token !== "string" || !entry.token) return null
    return {
      token: entry.token,
      role: typeof entry.role === "string" ? entry.role : ROLE,
      scopes: readStringArray(entry.scopes),
      issuedAtMs: typeof entry.issuedAtMs === "number" ? entry.issuedAtMs : 0,
    }
  }

  private async loadAuthMap(): Promise<Record<string, unknown>> {
    const raw = await this.options.store.get(DEVICE_AUTH_STORAGE_KEY)
    if (!raw) return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  /**
   * Serializes credential storage operations. A hello save queued behind
   * `forget()` rechecks its generation inside the lock, so a late save can
   * never write a token back after Unpair deleted it.
   */
  private withCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.credentialQueue.then(operation, operation)
    this.credentialQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async commitStoredAuth(auth: HelloAuth, generation: number): Promise<void> {
    const url = this.gatewayUrlValue
    if (!url) return
    await this.withCredentialLock(async () => {
      if (generation !== this.generation || this.stopped) return
      const map = await this.loadAuthMap()
      map[url] = {token: auth.token, role: auth.role, scopes: auth.scopes, issuedAtMs: auth.issuedAtMs}
      await this.options.store.set(DEVICE_AUTH_STORAGE_KEY, JSON.stringify(map))
    })
  }

  private async deleteStoredAuth(url: string): Promise<void> {
    await this.withCredentialLock(async () => {
      const map = await this.loadAuthMap()
      if (!(url in map)) return
      delete map[url]
      await this.options.store.set(DEVICE_AUTH_STORAGE_KEY, JSON.stringify(map))
    })
  }
}

function readGatewayError(value: unknown): GatewayErrorShape | undefined {
  if (!isRecord(value)) return undefined
  return {
    code: typeof value.code === "string" ? value.code : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
    ...(isRecord(value.details) ? {details: readErrorDetails(value.details)} : {}),
  }
}

function readErrorDetails(details: Record<string, unknown>): GatewayErrorDetails {
  return {
    ...details,
    code: typeof details.code === "string" ? details.code : undefined,
  }
}

function readStringField(value: unknown, key: string): string {
  if (!isRecord(value)) return ""
  const field = value[key]
  return typeof field === "string" ? field : ""
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function readMainSessionKey(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  const defaults = isRecord(payload.snapshot) ? payload.snapshot.sessionDefaults : undefined
  const key = isRecord(defaults) ? defaults.mainSessionKey : undefined
  return typeof key === "string" && key ? key : null
}

function readHelloAuthEntry(entry: unknown): HelloAuth | null {
  if (!isRecord(entry)) return null
  const token = entry.deviceToken
  if (typeof token !== "string" || !token.trim()) return null
  return {
    token: token.trim(),
    role: typeof entry.role === "string" && entry.role ? entry.role : ROLE,
    scopes: readStringArray(entry.scopes),
    issuedAtMs: typeof entry.issuedAtMs === "number" ? entry.issuedAtMs : 0,
  }
}

/** Prefers the `deviceTokens[]` entry for our role, else the top-level `auth.deviceToken`. */
function helloDeviceAuth(payload: unknown): HelloAuth | null {
  if (!isRecord(payload)) return null
  const auth = payload.auth
  if (!isRecord(auth)) return null
  if (Array.isArray(auth.deviceTokens)) {
    for (const entry of auth.deviceTokens) {
      if (!isRecord(entry) || entry.role !== ROLE) continue
      const picked = readHelloAuthEntry(entry)
      if (picked) return picked
    }
  }
  return readHelloAuthEntry(auth)
}

/**
 * `details.code` values (WednesdayAI `src/gateway/protocol/connect-error-details.ts`)
 * that mean the presented credential is invalid, revoked or otherwise unusable:
 * deleting the stored token and asking the user to re-pair is the only remedy.
 * Everything else — `AUTH_RATE_LIMITED` (decided before the device token is even
 * verified, `auth-context.ts:187-203`), tailnet identity problems, gateway
 * configuration — keeps both credentials and falls through to reconnect backoff.
 */
const REPAIR_DETAIL_CODES: Record<string, true> = {
  AUTH_REQUIRED: true,
  AUTH_UNAUTHORIZED: true,
  AUTH_DEVICE_TOKEN_MISMATCH: true,
  PAIRING_REQUIRED: true,
  CLIENT_DEVICE_CREDENTIAL_REQUIRED: true,
  DEVICE_IDENTITY_REQUIRED: true,
  DEVICE_AUTH_INVALID: true,
  DEVICE_AUTH_DEVICE_ID_MISMATCH: true,
  DEVICE_AUTH_SIGNATURE_EXPIRED: true,
  DEVICE_AUTH_NONCE_REQUIRED: true,
  DEVICE_AUTH_NONCE_MISMATCH: true,
  DEVICE_AUTH_SIGNATURE_INVALID: true,
  DEVICE_AUTH_PUBLIC_KEY_INVALID: true,
  bootstrap_token_invalid: true,
  bootstrap_token_expired: true,
  bootstrap_token_consumed: true,
  bootstrap_token_device_mismatch: true,
  bootstrap_profile_violation: true,
}

function isCredentialRejection(error: GatewayErrorShape | undefined): boolean {
  const code = error?.details?.code
  return code !== undefined && REPAIR_DETAIL_CODES[code] === true
}
