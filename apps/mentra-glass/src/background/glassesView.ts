/**
 * Glasses display renderer for the assistant.
 *
 * Owns the whole frame: a one-line status header plus a scrolling body.
 * Renders are throttled to ≥400 ms apart; live phases (listening, thinking,
 * streaming) re-render the same frame every 5 s to hold the 10 s background
 * display lock (MentraOS LocalDisplayManager renews the lock on every
 * render); final/error/offline/glance/notification frames auto-clear via
 * render ([]). A host that
 * drops a terminal frame ("blocked": another background app owns the display
 * lock) gets retries every 1 s inside the frame's visibility window; the
 * auto-hide deadline is anchored at the frame's first show() so retries never
 * extend it — except notification frames, whose deadline re-anchors at their
 * first accepted render so an accepted page keeps its full reading interval.
 * A generation counter makes any newer show()/hide()/dispose()
 * cancel older timers.
 */

import type {MiniappSession, RenderElement} from "@mentra/miniapp/background"

export type GlassesPhase =
  "listening" | "thinking" | "streaming" | "final" | "error" | "offline" | "glance" | "notification"

export interface GlassesViewModel {
  phase: GlassesPhase
  agentLabel: string
  body: string
  /** When set, replaces the whole header text instead of the built one. */
  header?: string
}

const STATUS_BY_PHASE: Record<GlassesPhase, string> = {
  listening: "Listening…",
  thinking: "Thinking…",
  streaming: "",
  final: "",
  error: "Error",
  offline: "Offline",
  glance: "",
  notification: "",
}

const FALLBACK_WIDTH = 576
const FALLBACK_HEIGHT = 288
const HEADER_HEIGHT = 32
const BODY_TOP = 36
const MIN_RENDER_INTERVAL_MS = 400
const LIVE_HEARTBEAT_MS = 5000
/** Visibility of final/error frames; also their retry window when blocked. */
export const FINAL_HIDE_MS = 15000
const OFFLINE_HIDE_MS = 4000
/** Visibility of a head-tilt glance frame. */
export const GLANCE_HIDE_MS = 5000
/** Visibility of a notification frame. */
export const NOTIFICATION_HIDE_MS = 6000

export interface GlassesViewOptions {
  /** Called right after a terminal frame auto-clears itself. */
  onAutoClear?: () => void
  /**
   * Called when the host accepted a render of the current frame (status
   * "displayed"). Blocked renders — another background app holds the display
   * lock — are not reported; the retry that gets accepted is. Lets a caller
   * time something to the frame actually being on the glasses.
   */
  onShown?: (vm: GlassesViewModel) => void
}
/** Global `setTimeout` handle; the runtime is the owner of this shape. */
type TimerHandle = ReturnType<typeof setTimeout>
/** Retry cadence for terminal frames the host reports as "blocked". */
const TERMINAL_RETRY_MS = 1000

export class GlassesView {
  private readonly session: MiniappSession
  private generation = 0
  private lastRenderAt = 0
  /** Next render attempt: throttle wait, live heartbeat, or blocked retry. */
  private renderTimer: TimerHandle | null = null
  /** Scheduled auto-clear for the current terminal frame. */
  private clearTimer: TimerHandle | null = null
  /** Absolute auto-hide deadline for the current terminal frame. */
  private clearDeadline = 0
  /** When the current frame's show() ran; anchors its auto-hide deadline. */
  private frameShownAt = 0
  /** Set once the current notification frame's deadline was re-anchored at its first accepted render. */
  private acceptAnchored = false
  private current: GlassesViewModel | null = null
  private readonly onAutoClear?: () => void
  private readonly onShown?: (vm: GlassesViewModel) => void

  constructor(session: MiniappSession, options: GlassesViewOptions = {}) {
    this.session = session
    this.onAutoClear = options.onAutoClear
    this.onShown = options.onShown
  }

  /** Show a frame (throttled) and schedule its heartbeat or auto-clear. */
  show(vm: GlassesViewModel): void {
    const generation = ++this.generation
    this.stopTimers()
    this.current = vm
    this.frameShownAt = Date.now()
    this.acceptAnchored = false
    const waitMs = Math.max(0, MIN_RENDER_INTERVAL_MS - (Date.now() - this.lastRenderAt))
    this.renderTimer = setTimeout(() => {
      if (generation === this.generation) void this.renderFrame(generation)
    }, waitMs)
  }

  /** Clear the glasses immediately and cancel all pending work. */
  hide(): void {
    this.generation++
    this.stopTimers()
    this.current = null
    void this.session.display.render([])
  }

  /**
   * Cancel all pending work without touching the host: the session is going
   * away, and renders would only queue outbound requests against a dead one.
   */
  dispose(): void {
    this.generation++
    this.stopTimers()
    this.current = null
  }

  private async renderFrame(generation: number): Promise<void> {
    const vm = this.current
    if (!vm || generation !== this.generation) return
    // Throttle from the moment the render is issued: a slow or superseded
    // render must not let the next frame slip past the ≥400 ms floor.
    this.lastRenderAt = Date.now()
    const result = await this.session.display.render(this.elements(vm))
    if (generation !== this.generation) return
    // The host accepted the frame: it is actually on the glasses now.
    if (result.status !== "blocked") this.onShown?.(vm)

    if (vm.phase === "listening" || vm.phase === "thinking" || vm.phase === "streaming") {
      // The heartbeat re-renders the same frame, which also retries a
      // "blocked" result until the display lock is reclaimed.
      this.scheduleRender(generation, LIVE_HEARTBEAT_MS)
      return
    }
    // Terminal frames get one auto-hide deadline, anchored at the frame's
    // first show() so blocked retries never extend it. While the host reports
    // "blocked" (another background app owns the lock and drops the frame),
    // retry inside that window instead of losing the answer.
    const hideMs =
      vm.phase === "offline"
        ? OFFLINE_HIDE_MS
        : vm.phase === "glance"
          ? GLANCE_HIDE_MS
          : vm.phase === "notification"
            ? NOTIFICATION_HIDE_MS
            : FINAL_HIDE_MS
    if (this.clearTimer === null) {
      this.clearDeadline = this.frameShownAt + hideMs
      this.scheduleClear(generation, Math.max(0, this.clearDeadline - Date.now()))
    }
    // A notification frame's reading interval (NotificationPresenter.onShown)
    // starts only when the host accepts the frame, so re-anchor its auto-hide
    // deadline at the first accepted render: a page accepted after blocked
    // retries keeps its full interval instead of being cleared mid-read and
    // restarted from page 1. Until acceptance the show()-anchored deadline
    // still bounds the retries.
    if (vm.phase === "notification" && result.status !== "blocked" && !this.acceptAnchored) {
      this.acceptAnchored = true
      this.clearDeadline = Date.now() + hideMs
      this.scheduleClear(generation, hideMs)
    }
    if (result.status === "blocked" && Date.now() + TERMINAL_RETRY_MS <= this.clearDeadline) {
      this.scheduleRender(generation, TERMINAL_RETRY_MS)
    }
  }

  private scheduleRender(generation: number, delayMs: number): void {
    this.stopRenderTimer()
    this.renderTimer = setTimeout(() => {
      if (generation === this.generation) void this.renderFrame(generation)
    }, delayMs)
  }

  private scheduleClear(generation: number, delayMs: number): void {
    this.stopClearTimer()
    this.clearTimer = setTimeout(() => {
      if (generation !== this.generation) return
      this.current = null
      this.clearTimer = null
      this.clearDeadline = 0
      void this.session.display.render([])
      this.onAutoClear?.()
    }, delayMs)
  }

  private stopTimers(): void {
    this.stopRenderTimer()
    this.stopClearTimer()
  }

  private stopRenderTimer(): void {
    if (this.renderTimer !== null) {
      clearTimeout(this.renderTimer)
      this.renderTimer = null
    }
  }

  private stopClearTimer(): void {
    if (this.clearTimer !== null) {
      clearTimeout(this.clearTimer)
      this.clearTimer = null
    }
  }

  private elements(vm: GlassesViewModel): RenderElement[] {
    const display = this.session.capabilities?.display
    const width = display?.width ?? FALLBACK_WIDTH
    const height = display?.height ?? FALLBACK_HEIGHT
    const status = STATUS_BY_PHASE[vm.phase]
    const header = vm.header ?? `WednesdayAI · ${vm.agentLabel}${status ? " — " + status : ""}`
    const elements: RenderElement[] = [
      {
        type: "text",
        id: "wai-header",
        box: {x: 0, y: 0, w: width, h: HEADER_HEIGHT},
        text: header,
        style: {maxLines: 1, overflow: "ellipsis"},
      },
    ]
    if (vm.body) {
      const windowsFromStart = vm.phase === "glance" || vm.phase === "notification"
      elements.push({
        type: "text",
        id: "wai-body",
        box: {x: 0, y: BODY_TOP, w: width, h: Math.max(1, height - BODY_TOP)},
        text: vm.body,
        style: {
          textWindow: windowsFromStart ? "start" : "end",
          overflow: "clip",
          breakMode: "word",
        },
      })
    }
    return elements
  }
}
