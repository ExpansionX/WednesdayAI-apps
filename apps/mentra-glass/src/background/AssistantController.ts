/**
 * AssistantController — owns the glasses-side assistant.
 *
 * Wires the gateway connection (pairing, requests, chat events), wake-word
 * tracking over speech-to-text transcripts, the glasses display, persisted
 * settings, and the phone UI menu (see src/ui/App.tsx +
 * src/shared/channels.ts). One instance lives for the whole background
 * JSContext; session.on("disconnect") tears everything down, marking the
 * controller disposed so async continuations cannot paint into a dead
 * session.
 */

import type {MiniappSession} from "@mentra/miniapp/background"
import manifest from "../../miniapp.json"

import {applyChatEvent, bindServerRunId, startRun} from "../gateway/chat"
import type {ChatRun} from "../gateway/chat"
import {SETTINGS_STORAGE_KEY} from "../gateway/constants"
import {uuidV4} from "../gateway/encoding"
import {GatewayConnection} from "../gateway/connection"
import {parseSetupInput, parseUrlParts} from "../gateway/setup-code"
import {agentOptions, resolveSessionKey} from "../gateway/sessions"
import type {AgentsInfo} from "../gateway/sessions"
import type {ConnectionState, KeyValueStore} from "../gateway/types"
import type {Channels, GlassSettings, StateSnapshot} from "../shared/channels"
import {GlassesView} from "./glassesView"
import {WakeTracker} from "./wake"
import type {WakeAction} from "./wake"

const CLIENT_VERSION = manifest.version
const DEFAULT_SETTINGS: GlassSettings = {wakeSttMode: "local", agentId: null}
/** How long the listening frame stays up when no query follows the wake word. */
const LISTENING_WINDOW_MS = 8000
/** Mic test: silence window before the on-device model hint is shown. */
const MICTEST_SILENCE_MS = 10000
const MICTEST_LOCAL_HINT =
  "No speech heard in 10 s. On-device mode needs the offline model: Mentra App → Settings → Transcription."

interface VoicewakeGetResult {
  triggers?: string[]
}

interface ChatSendResult {
  /** Present when the gateway started (or queued) a run for this request. */
  runId?: string
  status?: string
  /**
   * Stop-phrase acknowledgement: a spoken "stop" aborts the active run and
   * returns `{ok, aborted, runIds}` without starting a new one, so there is
   * no `runId` to bind.
   */
  aborted?: boolean
}

/** Global `setTimeout` handle; the runtime is the owner of this shape. */
type TimerHandle = ReturnType<typeof setTimeout>

/** Callbacks the controller registers on its gateway connection. */
export interface ConnectionHooks {
  onStateChange: (state: ConnectionState, info: {retryInMs: number | null; lastError: string | null}) => void
  onEvent: (event: string, payload: unknown) => void
  onHello: (hello: {mainSessionKey: string | null}) => void
}

export interface AssistantControllerOptions {
  /**
   * Test seam: build the gateway connection instead of the real one. The
   * real build wires the same hooks into `GatewayConnection`.
   */
  createConnection?: (hooks: ConnectionHooks) => GatewayConnection
}

export class AssistantController {
  private readonly session: MiniappSession<Channels>
  private readonly store: KeyValueStore
  private readonly view: GlassesView
  private readonly tracker = new WakeTracker()
  private readonly connection: GatewayConnection

  private started = false
  private disposed = false
  private readonly unsubs: Array<() => void> = []
  private transcriptionUnsub: (() => void) | null = null
  private listeningTimer: TimerHandle | null = null
  private micTestTimer: TimerHandle | null = null

  private settings: GlassSettings = {...DEFAULT_SETTINGS}
  private triggers: string[] = []
  private agents: Array<{id: string; label: string}> = []
  private agentsInfo: AgentsInfo | null = null
  private mainSessionKey: string | null = null
  /** Controller-side notice; preferred over the connection's lastError. */
  private notice: string | null = null
  private currentRun: ChatRun | null = null
  private currentQuery = ""
  private micTestEnabled = false

  constructor(session: MiniappSession<Channels>, options: AssistantControllerOptions = {}) {
    this.session = session
    // SimpleStorage's get/set/delete satisfy the portable KeyValueStore shape.
    this.store = session.storage
    this.view = new GlassesView(session)
    const hooks: ConnectionHooks = {
      onStateChange: (state) => this.onConnectionState(state),
      onEvent: (event: string, payload: unknown) => this.onGatewayEvent(event, payload),
      onHello: (hello: {mainSessionKey: string | null}) => {
        void this.onHello(hello)
      },
    }
    const createConnection =
      options.createConnection ??
      ((connectionHooks: ConnectionHooks) =>
        new GatewayConnection({
          store: this.store,
          clientVersion: CLIENT_VERSION,
          ...connectionHooks,
        }))
    this.connection = createConnection(hooks)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // Register cancellation before the first await: a disconnect during the
    // initial settings read must not leave a half-started controller behind.
    this.unsubs.push(this.session.on("disconnect", () => this.dispose()))

    await this.loadSettings()
    if (this.disposed) return
    this.registerUiHandlers()
    this.subscribeTranscription()

    void Promise.resolve(this.connection.start()).catch(() => {
      // Connection failures surface through onStateChange → pushState.
    })
    this.pushState()
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private dispose(): void {
    if (this.disposed) return
    // Invalidate first: connection teardown and any in-flight continuation
    // must see the controller as gone before it rejects their requests.
    this.disposed = true
    this.stopListeningTimer()
    this.stopMicTestTimer()
    if (this.transcriptionUnsub) {
      this.transcriptionUnsub()
      this.transcriptionUnsub = null
    }
    for (const unsub of this.unsubs.splice(0)) {
      unsub()
    }
    this.connection.stop()
    // Cancels GlassesView's heartbeat/auto-clear timers without rendering:
    // outbound render requests would only queue against the dead session.
    this.view.dispose()
    this.currentRun = null
    this.started = false
  }

  /**
   * Connection transitions. A drop (offline/repair_required/unpaired) with a
   * live run must finish the frame: the run's terminal event is not replayed
   * after reconnect, so Thinking/Streaming would otherwise renew the 10 s
   * background display lock forever.
   */
  private onConnectionState(state: ConnectionState): void {
    if (this.disposed) return
    this.pushState()
    if (state === "connected" || state === "connecting") return
    const run = this.currentRun
    if (!run || run.state === "final" || run.state === "error" || run.state === "aborted") return
    this.currentRun = null
    if (state === "unpaired") {
      this.view.hide()
      return
    }
    if (state === "offline") {
      this.view.show({
        phase: "offline",
        agentLabel: this.agentLabel(),
        body: this.connection.lastError ?? "WednesdayAI is not connected",
      })
      return
    }
    this.view.show({
      phase: "error",
      agentLabel: this.agentLabel(),
      body: this.connection.lastError ?? "Pairing needs repair — scan the setup code again",
    })
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  private async loadSettings(): Promise<void> {
    try {
      const raw = await this.store.get(SETTINGS_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<GlassSettings> | null
      if (!parsed || typeof parsed !== "object") return
      this.settings = {
        wakeSttMode: parsed.wakeSttMode === "cloud" ? "cloud" : "local",
        agentId: typeof parsed.agentId === "string" ? parsed.agentId : null,
      }
    } catch {
      this.settings = {...DEFAULT_SETTINGS}
    }
  }

  private async saveSettings(): Promise<void> {
    await this.store.set(SETTINGS_STORAGE_KEY, JSON.stringify(this.settings))
  }

  private async updateSettings(patch: Partial<GlassSettings>): Promise<void> {
    if (this.disposed) return
    const modeChanged = patch.wakeSttMode !== undefined && patch.wakeSttMode !== this.settings.wakeSttMode
    const agentChanged = patch.agentId !== undefined
    this.settings = {
      wakeSttMode: patch.wakeSttMode ?? this.settings.wakeSttMode,
      agentId: patch.agentId !== undefined ? patch.agentId : this.settings.agentId,
    }
    try {
      await this.saveSettings()
    } catch (err) {
      this.pushError(errorMessage(err, "Could not save settings"))
    }
    if (this.disposed) return
    if (modeChanged) {
      this.subscribeTranscription()
      // The silence window restarts with the new subscription: a timer armed
      // under the old mode must not fire across it.
      if (this.micTestEnabled) this.armMicTestTimer()
    }
    if (agentChanged) this.refreshAgentNotice()
    this.pushState()
  }

  // ── Transcription + wake ────────────────────────────────────────────────

  private subscribeTranscription(): void {
    if (this.transcriptionUnsub) {
      this.transcriptionUnsub()
      this.transcriptionUnsub = null
    }
    const forceLocal = this.settings.wakeSttMode === "local"
    this.transcriptionUnsub = this.session.transcription.on((data) => this.onTranscript(data), {forceLocal})
  }

  private onTranscript(data: {text: string; isFinal: boolean}): void {
    if (this.micTestEnabled) {
      this.session.ui.send("mictest:transcript", {text: data.text, isFinal: data.isFinal})
      this.armMicTestTimer()
    }
    this.handleWakeAction(this.tracker.onTranscript(data))
  }

  private handleWakeAction(action: WakeAction): void {
    switch (action.type) {
      case "listening": {
        this.view.show({phase: "listening", agentLabel: this.agentLabel(), body: ""})
        this.armListeningWindow()
        return
      }
      case "cancel":
        this.stopListeningTimer()
        this.view.hide()
        return
      case "send":
        this.stopListeningTimer()
        void this.sendQuery(action.query)
        return
      case "none":
        return
    }
  }

  private armListeningWindow(): void {
    this.stopListeningTimer()
    this.listeningTimer = setTimeout(() => {
      this.listeningTimer = null
      this.tracker.cancelAwait()
      this.view.hide()
    }, LISTENING_WINDOW_MS)
  }

  private stopListeningTimer(): void {
    if (this.listeningTimer !== null) {
      clearTimeout(this.listeningTimer)
      this.listeningTimer = null
    }
  }

  // ── Chat sends ──────────────────────────────────────────────────────────

  private async sendQuery(query: string): Promise<void> {
    if (this.disposed) return
    if (this.connection.state !== "connected") {
      this.view.show({
        phase: "offline",
        agentLabel: this.agentLabel(),
        body: "WednesdayAI is not connected",
      })
      return
    }
    const idempotencyKey = uuidV4()
    const run = startRun(idempotencyKey)
    this.currentRun = run
    this.currentQuery = query
    this.view.show({phase: "thinking", agentLabel: this.agentLabel(), body: query})
    let result: ChatSendResult
    try {
      result = await this.connection.request<ChatSendResult>("chat.send", {
        sessionKey: this.sessionKey(),
        message: query,
        idempotencyKey,
      })
    } catch (err) {
      // A newer send owns the glasses (or the controller is disposing); don't
      // overwrite it with a stale error.
      if (!this.disposed && this.currentRun === run) {
        this.view.show({
          phase: "error",
          agentLabel: this.agentLabel(),
          body: errorMessage(err, "Request failed"),
        })
      }
      return
    }
    if (this.disposed || this.currentRun !== run) return
    if (typeof result.runId === "string" && result.runId) {
      bindServerRunId(run, result.runId)
      return
    }
    // No runId: the gateway only acknowledged — a spoken stop phrase aborts
    // the active run and replies without starting a new one. Finish the
    // frame instead of hanging on Thinking.
    this.currentRun = null
    this.view.show({
      phase: "final",
      agentLabel: this.agentLabel(),
      body: result.aborted ? "Stopped" : "Nothing to stop",
    })
  }

  private sessionKey(): string {
    return resolveSessionKey({
      agentId: this.settings.agentId,
      agents: this.agentsInfo,
      mainSessionKey: this.mainSessionKey,
    })
  }

  private showRun(run: ChatRun): void {
    const agentLabel = this.agentLabel()
    switch (run.state) {
      case "thinking":
        this.view.show({phase: "thinking", agentLabel, body: this.currentQuery})
        return
      case "streaming":
        this.view.show({phase: "streaming", agentLabel, body: run.text})
        return
      case "final":
        this.view.show({phase: "final", agentLabel, body: run.text || "(no reply)"})
        return
      case "error":
        this.view.show({phase: "error", agentLabel, body: run.error || "Request failed"})
        return
      case "aborted":
        this.view.show({phase: "final", agentLabel, body: "Stopped"})
        return
    }
  }

  // ── Gateway events ──────────────────────────────────────────────────────

  private onGatewayEvent(event: string, payload: unknown): void {
    if (this.disposed) return
    if (event === "voicewake.changed") {
      const triggers = (payload as VoicewakeGetResult | null)?.triggers
      if (Array.isArray(triggers)) {
        this.setTriggers(triggers)
        this.pushState()
      }
      return
    }
    if (event === "chat") {
      this.onChatEvent(payload)
    }
  }

  private onChatEvent(payload: unknown): void {
    if (this.disposed) return
    const run = this.currentRun
    if (!run) return
    const updated = applyChatEvent(run, payload)
    if (!updated) return
    this.currentRun = updated
    this.showRun(updated)
  }

  private async onHello(hello: {mainSessionKey: string | null}): Promise<void> {
    if (this.disposed) return
    this.mainSessionKey = hello.mainSessionKey
    try {
      const result = await this.connection.request<VoicewakeGetResult>("voicewake.get", {})
      this.setTriggers(Array.isArray(result.triggers) ? result.triggers : [])
    } catch {
      // Keep whatever triggers we have; wake matching stays as configured.
    }
    try {
      const result = await this.connection.request<AgentsInfo>("agents.list", {})
      this.agents = agentOptions(result)
      this.agentsInfo = result
      this.refreshAgentNotice()
    } catch {
      // Keep the cached agent list.
    }
    this.pushState()
  }

  private setTriggers(triggers: string[]): void {
    this.triggers = triggers
    this.tracker.setTriggers(triggers)
  }

  private refreshAgentNotice(): void {
    const saved = this.settings.agentId
    if (saved && !this.agents.some((agent) => agent.id === saved)) {
      this.notice = `Saved agent ${saved} no longer exists; using default`
    } else if (this.notice !== null && this.notice.startsWith("Saved agent ")) {
      this.notice = null
    }
  }

  private agentLabel(): string {
    const saved = this.settings.agentId
    if (saved) {
      const agent = this.agents.find((candidate) => candidate.id === saved)
      if (agent) return agent.label
    }
    return "default"
  }

  // ── Mic test ────────────────────────────────────────────────────────────

  private setMicTest(enabled: boolean): void {
    this.micTestEnabled = enabled
    if (enabled) {
      this.armMicTestTimer()
    } else {
      this.stopMicTestTimer()
    }
    this.pushState()
  }

  private armMicTestTimer(): void {
    this.stopMicTestTimer()
    if (!this.micTestEnabled) return
    this.micTestTimer = setTimeout(() => {
      this.micTestTimer = null
      if (this.micTestEnabled && this.settings.wakeSttMode === "local") {
        this.pushError(MICTEST_LOCAL_HINT)
      }
    }, MICTEST_SILENCE_MS)
  }

  private stopMicTestTimer(): void {
    if (this.micTestTimer !== null) {
      clearTimeout(this.micTestTimer)
      this.micTestTimer = null
    }
  }

  // ── UI bus ──────────────────────────────────────────────────────────────

  private registerUiHandlers(): void {
    this.unsubs.push(this.session.ui.onOpen(() => this.pushState()))
    // The mic test exists only for the phone UI: closing it must stop
    // transcript forwarding and cancel the silence timer, or the background
    // keeps listening with no one watching.
    this.unsubs.push(this.session.ui.onClose(() => this.setMicTest(false)))
    this.unsubs.push(this.session.ui.on("state:get", () => this.pushState()))
    this.unsubs.push(
      this.session.ui.on("pair:scan", () => {
        void this.pairScan()
      }),
    )
    this.unsubs.push(
      this.session.ui.on("pair:code", ({code}) => {
        void this.pairWithCode(code)
      }),
    )
    this.unsubs.push(
      this.session.ui.on("pair:forget", () => {
        void Promise.resolve(this.connection.forget()).then(
          () => this.pushState(),
          () => this.pushState(),
        )
      }),
    )
    this.unsubs.push(
      this.session.ui.on("settings:set", (patch) => {
        void this.updateSettings(patch)
      }),
    )
    this.unsubs.push(this.session.ui.on("mictest:set", ({enabled}) => this.setMicTest(enabled)))
  }

  private async pairScan(): Promise<void> {
    let result
    try {
      result = await this.session.system.scanQr({
        title: "Pair WednesdayAI",
        hint: "Scan the QR from: wednesdayai qr --client openclaw-mentra-node",
      })
    } catch (err) {
      this.pushError(errorMessage(err, "QR scan failed"))
      return
    }
    if (result.cancelled) {
      this.pushState()
      return
    }
    if (this.disposed) return
    await this.pairWithCode(result.data)
  }

  private async pairWithCode(code: string): Promise<void> {
    let setup
    try {
      setup = parseSetupInput(code)
    } catch (err) {
      this.pushError(errorMessage(err, "Unrecognised setup code"))
      this.pushState()
      return
    }
    try {
      await this.connection.pair(setup)
    } catch (err) {
      this.pushError(errorMessage(err, "Pairing failed"))
    }
    if (this.disposed) return
    this.pushState()
  }

  // ── State snapshot ──────────────────────────────────────────────────────

  private snapshot(): StateSnapshot {
    return {
      connection: this.connection.state,
      gatewayHost: this.gatewayHost(),
      retryInMs: this.connection.retryInMs,
      triggers: [...this.triggers],
      agents: this.agents.map((agent) => ({...agent})),
      defaultAgentId: this.agentsInfo?.defaultId ?? null,
      sessionScope: this.agentsInfo?.scope ?? null,
      settings: {...this.settings},
      lastError: this.notice ?? this.connection.lastError,
    }
  }

  private gatewayHost(): string | null {
    const url = this.connection.gatewayUrl
    if (!url) return null
    return parseUrlParts(url)?.host ?? url
  }

  private pushState(): void {
    if (this.disposed) return
    this.session.ui.send("state", this.snapshot())
  }

  private pushError(message: string): void {
    if (this.disposed) return
    this.session.ui.send("error", {message})
  }
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}
