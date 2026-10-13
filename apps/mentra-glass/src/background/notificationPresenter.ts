/**
 * Paged presenter for phone notifications on the glasses display.
 *
 * Shows one notification at a time: its body is split into pages of at most
 * NOTIFICATION_PAGE_CHARS. A page's NOTIFICATION_PAGE_MS reading interval
 * starts only when the host accepts the frame — the surface reports that
 * through onShown(), fed from GlassesView's render result — so a notification
 * held by MentraOS's display lock stays on its page (GlassesView retries the
 * blocked render) instead of being advanced or dropped sight unseen.
 * When the page interval ends the next page shows, then the next queued
 * notification starts, or the surface hides when none waits.
 * When the surface is busy (canShow() false) new notifications wait in the
 * queue; pump() retries. interrupt() requeues the on-screen notification at
 * the front without hiding, so an assistant frame can take the display and
 * the notification can resume at page 1. add() of a repost keeps the
 * on-screen copy as is and replaces a waiting copy in place; the controller
 * decides from its own exposed state whether intake needs a snapshot push.
 * dispose() stops
 * the page timer and ignores further work; it never calls surface.hide().
 * Queue changes outside add() report through onChange so the controller can
 * push state to the phone — and only actual changes do.
 */

import type {GlassesViewModel} from "./glassesView"

import {NOTIFICATION_PAGE_CHARS, NotificationQueue, paginate} from "./notifications"
import type {QueuedNotification} from "./notifications"

export const NOTIFICATION_PAGE_MS = 4000

export interface NotificationSurface {
  canShow(): boolean
  show(vm: GlassesViewModel): void
  hide(): void
}
/** Global `setTimeout` handle; the runtime is the owner of this shape. */
type TimerHandle = ReturnType<typeof setTimeout>

export class NotificationPresenter {
  private readonly surface: NotificationSurface
  private readonly onChange?: () => void
  private readonly queue = new NotificationQueue()
  private current: QueuedNotification | null = null
  private pages: string[] = []
  private pageIndex = 0
  private timer: TimerHandle | null = null
  private disposed = false
  private isShowing = false

  constructor(surface: NotificationSurface, onChange?: () => void) {
    this.surface = surface
    this.onChange = onChange
  }

  /** Waiting notifications, excluding the one on screen. */
  get queued(): number {
    return this.queue.size
  }

  get showing(): boolean {
    return this.isShowing
  }

  add(item: QueuedNotification): void {
    if (this.disposed) return
    // A repost of the notification on screen keeps it as is; no restart.
    if (this.isShowing && this.current?.id === item.id) return
    this.queue.enqueue(item)
    this.tryStart()
  }

  dismiss(id: string): void {
    if (this.disposed) return
    if (this.isShowing && this.current?.id === id) {
      this.advance()
      return
    }
    if (this.queue.remove(id)) this.onChange?.()
  }

  retain(keep: (item: QueuedNotification) => boolean): void {
    if (this.disposed) return
    const before = this.queue.size
    this.queue.retain(keep)
    const removed = this.queue.size !== before
    if (this.isShowing && this.current && !keep(this.current)) {
      this.advance()
      return
    }
    if (removed) this.onChange?.()
  }

  /** Requeue the on-screen notification at the front without hiding. */
  interrupt(): void {
    if (this.disposed || !this.isShowing || !this.current) return
    this.clearTimer()
    this.queue.unshift(this.current)
    this.current = null
    this.pages = []
    this.pageIndex = 0
    this.isShowing = false
    this.onChange?.()
  }

  /** Start the next notification when idle and the surface is free. */
  pump(): void {
    if (this.tryStart()) this.onChange?.()
  }

  /**
   * The host accepted the on-screen frame (GlassesView render status
   * "displayed"): start its reading interval. While the host reports the
   * render blocked, nothing runs here and the page simply stays.
   */
  onShown(): void {
    if (this.disposed || !this.isShowing || this.current === null || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.pageIndex + 1 < this.pages.length) {
        this.pageIndex += 1
        this.showPage()
        return
      }
      this.advance()
    }, NOTIFICATION_PAGE_MS)
  }

  /** Stop everything and drop all state; the surface is left as is. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer()
    this.current = null
    this.pages = []
    this.pageIndex = 0
    this.isShowing = false
    this.queue.retain(() => false)
  }

  /** Shift and show the next queued notification; false when nothing can start. */
  private tryStart(): boolean {
    if (this.disposed || this.isShowing) return false
    if (!this.surface.canShow()) return false
    const next = this.queue.shift()
    if (!next) return false
    this.startItem(next)
    return true
  }

  private startItem(item: QueuedNotification): void {
    this.current = item
    this.pages = paginate(item.content || item.title, NOTIFICATION_PAGE_CHARS)
    this.pageIndex = 0
    this.isShowing = true
    this.showPage()
  }

  private showPage(): void {
    const item = this.current
    if (!item) return
    const page = this.pages[this.pageIndex] ?? ""
    let header = item.content && item.title ? `${item.app} · ${item.title}` : item.app
    if (this.pages.length > 1) header += ` (${this.pageIndex + 1}/${this.pages.length})`
    // No timer here: onShown() starts the page interval once the host
    // accepts this render.
    this.surface.show({phase: "notification", agentLabel: "", header, body: page})
  }

  /** The current item is done: start the next queued one, or hide when none waits. */
  private advance(): void {
    this.clearTimer()
    this.current = null
    this.pages = []
    this.pageIndex = 0
    this.isShowing = false
    const next = this.queue.shift()
    if (next) {
      this.startItem(next)
    } else {
      this.surface.hide()
    }
    this.onChange?.()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
