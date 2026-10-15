/**
 * AssistantController — owns the glasses-side assistant.
 *
 * Wires the gateway connection (pairing, requests, chat events), wake-word
 * tracking over speech-to-text transcripts, gateway question transcription
 * (the mic's own audio via talk.session, falling back to Mentra's
 * transcript), the glasses display — assistant frames, the head-tilt glance,
 * and allowlisted phone notifications — persisted settings, and the phone UI
 * menu (see src/ui/App.tsx + src/shared/channels.ts). One instance lives for
 * the whole background JSContext; session.on("disconnect") tears everything
 * down, marking the controller disposed so async continuations cannot paint
 * into a dead session.
 */

import type {AccelData, MiniappSession, PhoneNotificationData} from "@mentra/miniapp/background"
import manifest from "../../miniapp.json"

import {applyChatEvent, bindServerRunId, startRun} from "../gateway/chat"
import type {ChatRun} from "../gateway/chat"
import {NOTIFICATION_APPS_STORAGE_KEY, SETTINGS_STORAGE_KEY} from "../gateway/constants"
import {uuidV4} from "../gateway/encoding"
import {GatewayConnection} from "../gateway/connection"
import {parseSetupInput, parseUrlParts} from "../gateway/setup-code"
import {agentOptions, resolveSessionKey} from "../gateway/sessions"
import type {AgentsInfo} from "../gateway/sessions"
import type {ConnectionState, KeyValueStore} from "../gateway/types"
import type {Channels, GlassSettings, NotificationAppOption, StateSnapshot} from "../shared/channels"
import {glanceBody} from "./glance"
import {notificationFromEvent} from "./notifications"
import type {QueuedNotification} from "./notifications"
import {NotificationPresenter} from "./notificationPresenter"
import {GlassesView} from "./glassesView"
import type {GlassesViewModel} from "./glassesView"
import {GatewaySttCapture} from "./gatewayStt"
import {TiltDetector} from "./tilt"
import {trace} from "./trace"
import {dropLeadingWakes, findWake, matchWake, WakeTracker} from "./wake"
import type {WakeAction} from "./wake"

const CLIENT_VERSION = manifest.version
const DEFAULT_SETTINGS: GlassSettings = {
  wakeSttMode: "local",
  agentId: null,
  querySttMode: "gateway",
  notificationApps: [],
}

/** Trimmed, non-empty, de-duplicated package names in first-seen order. */
function sanitizeNotificationApps(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== "string") continue
    const name = entry.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
  }
  return [...seen]
}

/** Seen notification apps kept in state and storage, newest first. */
const MAX_SEEN_APPS = 50
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
  /** Live while gateway question transcription may stream mic audio. */
  private audioUnsub: (() => void) | null = null
  private listeningTimer: TimerHandle | null = null
  /** True while the listening frame is the newest frame shown; guards the window's hide. */
  private listeningFrameUp = false
  private micTestTimer: TimerHandle | null = null
  /** Which frame owns the display: assistant frames outrank notifications, which outrank the glance. */
  private displayOwner: "assistant" | "notification" | "glance" | null = null
  private readonly tilt = new TiltDetector()
  private readonly notifications: NotificationPresenter
  private seenApps: NotificationAppOption[] = []
  /** JSON of the seen-app list in the last pushed state snapshot. */
  private seenAppsPushed: string | null = null
  /** JSON of the most recently requested seen-app write; a failure resets it. */
  private seenAppsWriteRequested: string | null = null
  /** Gateway transcription of the spoken question; Mentra's transcript is the fallback. */
  private readonly stt: GatewaySttCapture
  /** One "transcription unavailable" warning per gateway hello. */
  private sttWarned = false
  /** Bumped per spoken question; a stale finish() must not send. */
  private sendToken = 0
  /** True while resolveAndSend awaits the gateway transcript of a painted query. */
  private awaitingTranscript = false

  private settings: GlassSettings = {...DEFAULT_SETTINGS}
  private triggers: string[] = []
  /** Bumped by voicewake.changed; guards onHello's voicewake.get hydration. */
  private wakeRevision = 0
  private agents: Array<{id: string; label: string}> = []
  private agentsInfo: AgentsInfo | null = null
  private mainSessionKey: string | null = null
  /** Controller-side notice; preferred over the connection's lastError. */
  private notice: string | null = null
  private currentRun: ChatRun | null = null
  private micTestEnabled = false

  constructor(session: MiniappSession<Channels>, options: AssistantControllerOptions = {}) {
    this.session = session
    // SimpleStorage's get/set/delete satisfy the portable KeyValueStore shape.
    this.store = session.storage
    this.view = new GlassesView(session, {
      onAutoClear: () => this.onDisplayAutoClear(),
      onShown: (vm) => {
        if (vm.phase === "notification") this.notifications.onShown()
      },
    })
    this.notifications = new NotificationPresenter(
      {
        canShow: () => this.displayOwner === null || this.displayOwner === "glance",
        show: (vm) => {
          this.displayOwner = "notification"
          this.listeningFrameUp = false
          this.view.show(vm)
        },
        hide: () => {
          this.displayOwner = null
          this.view.hide()
        },
      },
      () => this.pushState(),
    )
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
    this.stt = new GatewaySttCapture({
      requester: this.connection,
      onError: (message) => this.onSttError(message),
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // Register cancellation before the first await: a disconnect during the
    // initial settings read must not leave a half-started controller behind.
    this.unsubs.push(this.session.on("disconnect", () => this.dispose()))

    await this.loadSettings()
    if (this.disposed) return
    await this.loadSeenApps()
    if (this.disposed) return
    this.registerUiHandlers()
    this.subscribeTranscription()
    this.unsubs.push(this.session.imu.onAccel((data) => this.onAccel(data)))
    this.unsubs.push(this.session.phone.notifications.on((data) => this.onPhoneNotification(data)))
    this.unsubs.push(
      this.session.phone.notifications.onDismissed((data) => this.notifications.dismiss(data.notificationId)),
    )
    this.syncAudioSubscription()

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
    if (this.audioUnsub) {
      this.audioUnsub()
      this.audioUnsub = null
    }
    // Closes any open transcription session before the connection goes down.
    this.stt.dispose()
    for (const unsub of this.unsubs.splice(0)) {
      unsub()
    }
    this.connection.stop()
    // Stops the page timer and drops queued state; the surface is left as is.
    this.notifications.dispose()
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
    trace("connection", {state})
    this.syncAudioSubscription()
    this.pushState()
    if (state === "connected" || state === "connecting") return
    const run = this.currentRun
    const runIsLive = run !== null && run.state !== "final" && run.state !== "error" && run.state !== "aborted"
    // A painted query awaiting its gateway transcript is a live frame too:
    // the drop means it can never be answered, so finish it like a run.
    if (!runIsLive && !this.awaitingTranscript) return
    this.currentRun = null
    if (state === "unpaired") {
      this.releaseDisplay()
      return
    }
    if (state === "offline") {
      this.showFrame({
        phase: "offline",
        agentLabel: this.agentLabel(),
        body: this.connection.lastError ?? "WednesdayAI is not connected",
      })
      return
    }
    this.showFrame({
      phase: "error",
      agentLabel: this.agentLabel(),
      body: this.connection.lastError ?? "Pairing needs repair — scan the setup code again",
    })
  }

  /**
   * Keep the mic subscription exactly when gateway question transcription
   * wants it: 16 kHz PCM streams into the capture only while the gateway is
   * up and the mode selects it. Losing the subscription also cancels any
   * capture in flight, so a dropped gateway can never hold a talk session.
   */
  private syncAudioSubscription(): void {
    const wanted = !this.disposed && this.settings.querySttMode === "gateway" && this.connection.state === "connected"
    if (wanted && this.audioUnsub === null) {
      this.audioUnsub = this.session.mic.onAudioChunk((chunk) => this.stt.pushChunk(chunk))
      return
    }
    if (!wanted && this.audioUnsub !== null) {
      this.audioUnsub()
      this.audioUnsub = null
      this.stt.abort()
    }
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
        querySttMode: parsed.querySttMode === "mentra" ? "mentra" : "gateway",
        notificationApps: sanitizeNotificationApps(parsed.notificationApps),
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
    const appsChanged = patch.notificationApps !== undefined
    const sttModeChanged = patch.querySttMode !== undefined && patch.querySttMode !== this.settings.querySttMode
    this.settings = {
      wakeSttMode: patch.wakeSttMode ?? this.settings.wakeSttMode,
      agentId: patch.agentId !== undefined ? patch.agentId : this.settings.agentId,
      querySttMode: patch.querySttMode ?? this.settings.querySttMode,
      notificationApps: appsChanged ? sanitizeNotificationApps(patch.notificationApps) : this.settings.notificationApps,
    }
    try {
      await this.saveSettings()
    } catch (err) {
      this.pushError(errorMessage(err, "Could not save settings"))
    }
    if (this.disposed) return
    if (appsChanged) {
      this.notifications.retain((notification) => this.settings.notificationApps.includes(notification.packageName))
    }
    if (modeChanged) {
      this.subscribeTranscription()
      // The silence window restarts with the new subscription: a timer armed
      // under the old mode must not fire across it.
      if (this.micTestEnabled) this.armMicTestTimer()
    }
    if (sttModeChanged) this.syncAudioSubscription()
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
    trace("heard", {final: data.isFinal, text: data.text})
    if (this.micTestEnabled) {
      this.session.ui.send("mictest:transcript", {text: data.text, isFinal: data.isFinal})
      this.armMicTestTimer()
    }
    this.handleWakeAction(this.tracker.onTranscript(data))
  }

  private handleWakeAction(action: WakeAction): void {
    if (action.type !== "none") trace("wake", action)
    switch (action.type) {
      case "listening": {
        this.showFrame({phase: "listening", agentLabel: this.agentLabel(), body: ""})
        this.armListeningWindow()
        // The capture carries the mic's pre-roll only when it is streaming.
        if (this.audioUnsub !== null) this.stt.begin(this.sessionKey())
        return
      }
      case "cancel":
        this.listeningFrameUp = false
        this.stopListeningTimer()
        // Cancellation must not turn a pending transcript wait into a
        // Mentra-fallback send: stale the await before the abort settles it.
        this.sendToken += 1
        this.stt.abort()
        this.releaseDisplay()
        return
      case "send":
        this.stopListeningTimer()
        void this.resolveAndSend(action.query)
        return
      case "none":
        return
    }
  }

  /**
   * Show a frame through the listening-window guard: a non-listening frame
   * takes the display away from the listening frame, so the window's expiry
   * must no longer hide it. A notification on screen is requeued at the
   * front (without hiding) and resumes when an assistant path frees the
   * display.
   */
  private showFrame(vm: GlassesViewModel): void {
    // Streaming repaints every delta; the final frame carries the whole answer.
    if (vm.phase !== "streaming") trace("display", {phase: vm.phase, body: vm.body})
    if (this.displayOwner === "notification") this.notifications.interrupt()
    this.listeningFrameUp = vm.phase === "listening"
    this.displayOwner = "assistant"
    this.view.show(vm)
  }

  /**
   * Give the display back: clear the glasses and let a queued notification
   * step in. Every assistant-side hide of a live frame goes through here.
   * A showing notification keeps the display: the presenter owns that frame,
   * so stale assistant state — a finished or failed run still held in
   * currentRun, a connection drop mid-pages — must not cut it off. Its page
   * timer would keep advancing with nothing on the glasses, and pump() could
   * not restore a frame the presenter still considers showing.
   */
  private releaseDisplay(): void {
    if (this.displayOwner === "notification") return
    this.displayOwner = null
    this.view.hide()
    this.notifications.pump()
  }

  /** A terminal frame auto-cleared itself: the display is free again. */
  private onDisplayAutoClear(): void {
    const wasNotification = this.displayOwner === "notification"
    this.displayOwner = null
    if (wasNotification) {
      // The host gave up on the notification's frame (blocked past its
      // window) before its pages finished: requeue it at the front so it is
      // shown again rather than lost, and let it restart right away.
      this.notifications.interrupt()
    }
    this.notifications.pump()
  }

  // ── Glance + notifications ──────────────────────────────────────────────

  /** Head-tilt events: up shows the glance, down gives the display back. */
  private onAccel(data: AccelData): void {
    if (this.disposed) return
    const event = this.tilt.onSample(data)
    if (event === "up") {
      // A glance never takes the display from an assistant frame.
      if (this.displayOwner !== null && this.displayOwner !== "glance") return
      this.displayOwner = "glance"
      this.listeningFrameUp = false
      this.view.show({
        phase: "glance",
        agentLabel: this.agentLabel(),
        body: glanceBody(new Date(), this.connection.state, this.notifications.queued),
      })
      return
    }
    if (event === "down" && this.displayOwner === "glance") this.releaseDisplay()
  }

  private onPhoneNotification(data: PhoneNotificationData): void {
    if (this.disposed) return
    const item = notificationFromEvent(data)
    if (!item) return
    const seenChanged = this.recordSeenApp(item)
    // The snapshot exposes the seen list and the queued count only: a
    // repost that edits queued content changes neither, so nothing is
    // pushed.
    const queuedBefore = this.notifications.queued
    if (this.settings.notificationApps.includes(item.packageName)) this.notifications.add(item)
    if (seenChanged || this.notifications.queued !== queuedBefore) this.pushState()
  }

  /**
   * Move the app to the front of the seen list, cap it; true when the list
   * differs from the last pushed snapshot, which is what decides the state
   * push. The write compares against the most recently requested one — a
   * failed write resets that marker — so a repost retries a failed write
   * without pushing an unchanged snapshot, and a change that lands while an
   * older write is pending is both pushed and re-requested.
   */
  private recordSeenApp(item: QueuedNotification): boolean {
    const entry: NotificationAppOption = {packageName: item.packageName, app: item.app}
    const rest = this.seenApps.filter((seen) => seen.packageName !== entry.packageName)
    const next = [entry, ...rest]
    if (next.length > MAX_SEEN_APPS) next.length = MAX_SEEN_APPS
    this.seenApps = next
    const snapshot = JSON.stringify(next)
    if (snapshot !== this.seenAppsWriteRequested) {
      this.seenAppsWriteRequested = snapshot
      void this.saveSeenApps(snapshot)
    }
    if (snapshot === this.seenAppsPushed) return false
    this.seenAppsPushed = snapshot
    return true
  }

  private async saveSeenApps(snapshot: string): Promise<void> {
    try {
      await this.store.set(NOTIFICATION_APPS_STORAGE_KEY, snapshot)
    } catch (err) {
      // Reset only if no newer write superseded this one: the next
      // notification then retries it.
      if (this.seenAppsWriteRequested === snapshot) this.seenAppsWriteRequested = null
      this.pushError(errorMessage(err, "Could not save notification apps"))
    }
  }

  private async loadSeenApps(): Promise<void> {
    try {
      const raw = await this.store.get(NOTIFICATION_APPS_STORAGE_KEY)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          const apps: NotificationAppOption[] = []
          for (const entry of parsed) {
            if (typeof entry !== "object" || entry === null) continue
            const candidate = entry as {packageName?: unknown; app?: unknown}
            if (typeof candidate.packageName !== "string" || !candidate.packageName) continue
            if (typeof candidate.app !== "string" || !candidate.app) continue
            apps.push({packageName: candidate.packageName, app: candidate.app})
            if (apps.length >= MAX_SEEN_APPS) break
          }
          this.seenApps = apps
          // Storage already holds this list: no write is pending for it.
          this.seenAppsWriteRequested = JSON.stringify(apps)
        }
      }
    } catch {
      this.seenApps = []
    }
    // start() pushes this list right after the load: intake compares
    // against that snapshot.
    this.seenAppsPushed = JSON.stringify(this.seenApps)
  }

  private armListeningWindow(): void {
    this.stopListeningTimer()
    this.listeningTimer = setTimeout(() => {
      this.listeningTimer = null
      // The await window expires regardless of what owns the display now —
      // a stale bare wake word must not swallow the next utterance. But only
      // clear the glasses if the listening frame still owns them; a newer
      // frame (a run, offline, …) survives this timeout.
      this.tracker.cancelAwait()
      // Same as cancel: a stale pending wait must not fall back to a send.
      this.sendToken += 1
      this.stt.abort()
      if (this.listeningFrameUp) {
        this.listeningFrameUp = false
        this.releaseDisplay()
      }
    }, LISTENING_WINDOW_MS)
  }

  private stopListeningTimer(): void {
    if (this.listeningTimer !== null) {
      clearTimeout(this.listeningTimer)
      this.listeningTimer = null
    }
  }

  // ── Chat sends ──────────────────────────────────────────────────────────

  /**
   * Send the spoken question, preferring the gateway's transcript of the mic
   * audio over Mentra's. The Mentra query is painted while the transcript is
   * awaited, so a gateway that cannot transcribe only costs a short delay.
   * A transcript that lands after a disconnect, a disposal, or a newer send
   * sends nothing and paints nothing.
   */
  private async resolveAndSend(mentraQuery: string): Promise<void> {
    const token = ++this.sendToken
    if (!this.stt.active) {
      await this.sendQuery(mentraQuery)
      return
    }
    // Retire the previous run the way sendQuery replaces it: its late deltas
    // and terminal event must not repaint over this question's frame while
    // the transcript is awaited.
    this.currentRun = null
    this.showFrame({phase: "thinking", agentLabel: this.agentLabel(), body: mentraQuery})
    this.awaitingTranscript = true
    const text = await this.stt.finish()
    this.awaitingTranscript = false
    trace("gateway-stt", {transcript: text, mentra: mentraQuery})
    if (this.disposed || token !== this.sendToken || this.connection.state !== "connected") return
    const gatewayQuery = text ? findWake(text, this.triggers)?.query : undefined
    // A wake word repeated in the gateway transcript is a retry, unless
    // Mentra's query starts with one too ("wednesday, computer science …").
    const repeatedWake = gatewayQuery !== undefined && matchWake(mentraQuery, this.triggers) === null
    const query = (repeatedWake ? dropLeadingWakes(gatewayQuery, this.triggers) : gatewayQuery)?.trim() || mentraQuery
    await this.sendQuery(query)
  }

  private async sendQuery(query: string): Promise<void> {
    if (this.disposed) return
    if (this.connection.state !== "connected") {
      this.showFrame({
        phase: "offline",
        agentLabel: this.agentLabel(),
        body: "WednesdayAI is not connected",
      })
      return
    }
    const idempotencyKey = uuidV4()
    trace("chat.send", {sessionKey: this.sessionKey(), message: query})
    const run = startRun(idempotencyKey)
    this.currentRun = run
    this.showFrame({phase: "thinking", agentLabel: this.agentLabel(), body: query})
    let result: ChatSendResult
    try {
      result = await this.connection.request<ChatSendResult>("chat.send", {
        sessionKey: this.sessionKey(),
        message: query,
        idempotencyKey,
      })
    } catch (err) {
      trace("chat.send-failed", {error: errorMessage(err, "Request failed")})
      // A newer send owns the glasses (or the controller is disposing); don't
      // overwrite it with a stale error.
      if (!this.disposed && this.currentRun === run) {
        this.showFrame({
          phase: "error",
          agentLabel: this.agentLabel(),
          body: errorMessage(err, "Request failed"),
        })
      }
      return
    }
    if (this.disposed || this.currentRun !== run) return
    trace("chat.send-ok", {runId: result?.runId ?? null, aborted: result?.aborted ?? false})
    // Response payloads arrive unvalidated; an empty one must not leave Thinking up.
    if (typeof result !== "object" || result === null) {
      this.currentRun = null
      this.showFrame({phase: "error", agentLabel: this.agentLabel(), body: "Gateway sent an empty reply"})
      return
    }
    if (typeof result.runId === "string" && result.runId) {
      bindServerRunId(run, result.runId)
      return
    }
    // No runId: the gateway only acknowledged — a spoken stop phrase aborts
    // the active run and replies without starting a new one. Finish the
    // frame instead of hanging on Thinking.
    this.currentRun = null
    this.showFrame({
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
      // No "thinking" case: applyChatEvent never produces that state.
      case "streaming":
        this.showFrame({phase: "streaming", agentLabel, body: run.text})
        return
      case "final":
        this.showFrame({phase: "final", agentLabel, body: run.text || "(no reply)"})
        return
      case "error":
        // run.error is `string | null` and TS cannot see applyChatEvent's
        // guarantee of a non-empty message, so the fallback stays.
        this.showFrame({phase: "error", agentLabel, body: run.error || "Request failed"})
        return
      case "aborted":
        this.showFrame({phase: "final", agentLabel, body: "Stopped"})
        return
    }
  }

  // ── Gateway events ──────────────────────────────────────────────────────

  private onGatewayEvent(event: string, payload: unknown): void {
    if (this.disposed) return
    if (event === "voicewake.changed") {
      const triggers = (payload as VoicewakeGetResult | null)?.triggers
      if (Array.isArray(triggers)) {
        this.wakeRevision += 1
        this.setTriggers(triggers)
        this.pushState()
      }
      return
    }
    if (event === "chat") {
      this.onChatEvent(payload)
      return
    }
    if (event === "talk.event") {
      this.stt.onTalkEvent(payload)
    }
  }

  private onChatEvent(payload: unknown): void {
    // Disposal is handled by onGatewayEvent's guard; a post-dispose currentRun
    // is null regardless.
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
    // A reconnect is a fresh gateway process: transcription may work again.
    this.sttWarned = false
    const revisionBeforeHydration = this.wakeRevision
    try {
      const result = await this.connection.request<VoicewakeGetResult>("voicewake.get", {})
      // A voicewake.changed that landed while the request was in flight is
      // newer than this snapshot; applying it would resurrect stale words.
      if (this.wakeRevision === revisionBeforeHydration) {
        this.setTriggers(Array.isArray(result.triggers) ? result.triggers : [])
      }
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
    trace("triggers", {triggers})
    this.triggers = triggers
    this.tracker.setTriggers(triggers)
  }

  /** One warning per hello: the gateway said why it cannot transcribe. */
  private onSttError(message: string): void {
    if (this.sttWarned) return
    this.sttWarned = true
    this.pushError(`WednesdayAI transcription unavailable: ${message}. Using Mentra transcription.`)
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
    // Every caller guarantees the mic test is enabled.
    this.stopMicTestTimer()
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
        // Unpairing tears the gateway socket down the same way re-pairing
        // replaces it: retire any live frame first, or a pending
        // transcription falls back to a send on a dead one.
        this.retireAssistantFrame()
        void Promise.resolve(this.connection.forget()).then(
          () => this.pushState(),
          (err: unknown) => {
            this.pushError(errorMessage(err, "Unpair failed"))
            this.pushState()
          },
        )
      }),
    )
    this.unsubs.push(
      this.session.ui.on("settings:set", (patch) => {
        void this.updateSettings(patch)
      }),
    )
    this.unsubs.push(
      this.session.ui.on("notifications:allow", ({packageName, enabled}) => {
        // One app per intent: checkboxes build on the background's own list,
        // so a snapshot racing a tick can never drop another app's choice.
        const name = packageName.trim()
        if (!name) return
        const has = this.settings.notificationApps.includes(name)
        if (enabled === has) return
        void this.updateSettings({
          notificationApps: enabled
            ? [...this.settings.notificationApps, name]
            : this.settings.notificationApps.filter((existing) => existing !== name),
        })
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

  /**
   * Retire any live assistant frame before the gateway socket is replaced
   * (re-pairing) or torn down (unpair): a run or painted query bound to the
   * old socket can never finish — its live frame would heartbeat the 10 s
   * display lock forever — and a pending transcription must not fall back
   * to a chat.send on a dead one.
   */
  private retireAssistantFrame(): void {
    const hadFrame = this.currentRun !== null || this.listeningFrameUp || this.awaitingTranscript
    this.sendToken += 1
    this.awaitingTranscript = false
    this.stt.abort()
    this.currentRun = null
    this.listeningFrameUp = false
    if (hadFrame) this.releaseDisplay()
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
    // Pairing replaces the gateway socket: retire the live frame first.
    this.retireAssistantFrame()
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
      settings: {...this.settings, notificationApps: [...this.settings.notificationApps]},
      micTestEnabled: this.micTestEnabled,
      lastError: this.notice ?? this.connection.lastError,
      seenNotificationApps: this.seenApps.map((seen) => ({...seen})),
      queuedNotifications: this.notifications.queued,
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
    trace("error", {message})
    if (this.disposed) return
    this.session.ui.send("error", {message})
  }
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}
