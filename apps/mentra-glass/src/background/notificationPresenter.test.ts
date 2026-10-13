import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"

import type {GlassesViewModel} from "./glassesView"

import {NOTIFICATION_PAGE_MS, NotificationPresenter} from "./notificationPresenter"
import type {NotificationSurface} from "./notificationPresenter"
import type {QueuedNotification} from "./notifications"

/**
 * Recording surface whose availability the test toggles. `autoAccept`
 * mirrors a host that accepts the render: the frame counts as shown the
 * moment `show` runs. Set it to false to simulate MentraOS's display lock
 * dropping the frame, then call the presenter's onShown() when it lands.
 */
class RecordingSurface implements NotificationSurface {
  allowed = true
  autoAccept = true
  readonly shown: GlassesViewModel[] = []
  hideCalls = 0
  onShown: (() => void) | null = null

  canShow(): boolean {
    return this.allowed
  }

  show(vm: GlassesViewModel): void {
    this.shown.push(vm)
    if (this.autoAccept) this.onShown?.()
  }

  hide(): void {
    this.hideCalls += 1
  }
}

function entry(id: string, content: string, title = id.toUpperCase()): QueuedNotification {
  return {id, app: "Messages", packageName: "com.m", title, content}
}

/** Wires the surface's accepted-render callback to the presenter, as the controller does. */
function makePresenter(surface: RecordingSurface, onChange?: () => void): NotificationPresenter {
  const presenter = new NotificationPresenter(surface, onChange)
  surface.onShown = () => presenter.onShown()
  return presenter
}

describe("NotificationPresenter", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows notifications one at a time, paging each, then hides", () => {
    const surface = new RecordingSurface()
    const presenter = makePresenter(surface)
    presenter.add(entry("a", "hello"))
    presenter.add(entry("b", Array.from({length: 30}, () => "ninechars").join(" ")))
    presenter.add(entry("c", "bye"))
    expect(surface.shown.map((vm) => vm.header ?? "")).toEqual(["Messages · A"])
    expect(surface.shown[0]).toMatchObject({
      phase: "notification",
      agentLabel: "",
      body: "hello",
    })
    vi.advanceTimersByTime(NOTIFICATION_PAGE_MS)
    expect(surface.shown.map((vm) => vm.header ?? "")).toEqual(["Messages · A", "Messages · B (1/2)"])
    vi.advanceTimersByTime(NOTIFICATION_PAGE_MS)
    expect(surface.shown.map((vm) => vm.header ?? "")).toEqual([
      "Messages · A",
      "Messages · B (1/2)",
      "Messages · B (2/2)",
    ])
    vi.advanceTimersByTime(NOTIFICATION_PAGE_MS)
    expect(surface.shown.map((vm) => vm.header ?? "")).toEqual([
      "Messages · A",
      "Messages · B (1/2)",
      "Messages · B (2/2)",
      "Messages · C",
    ])
    expect(surface.hideCalls).toBe(0)
    vi.advanceTimersByTime(NOTIFICATION_PAGE_MS)
    expect(surface.hideCalls).toBe(1)
    expect(presenter.showing).toBe(false)
  })

  it("starts the page interval only once the host accepts the frame", () => {
    const surface = new RecordingSurface()
    surface.autoAccept = false
    const presenter = makePresenter(surface)
    presenter.add(entry("a", "hello"))
    expect(surface.shown).toHaveLength(1)
    // The host holds the display lock: the page stays and nothing advances.
    vi.advanceTimersByTime(3 * NOTIFICATION_PAGE_MS)
    expect(surface.shown).toHaveLength(1)
    expect(surface.shown[0]).toMatchObject({header: "Messages · A", body: "hello"})
    expect(presenter.showing).toBe(true)
    // The host accepts: only then does the reading interval run.
    presenter.onShown()
    vi.advanceTimersByTime(NOTIFICATION_PAGE_MS)
    expect(surface.hideCalls).toBe(1)
    expect(presenter.showing).toBe(false)
  })

  it("ignores a late shown report when nothing is on screen", () => {
    const surface = new RecordingSurface()
    surface.autoAccept = false
    const presenter = makePresenter(surface)
    presenter.onShown()
    vi.advanceTimersByTime(60000)
    expect(surface.shown).toHaveLength(0)
    expect(surface.hideCalls).toBe(0)
    // A second shown report for an already-running page must not stack timers.
    presenter.add(entry("a", "hello"))
    presenter.onShown()
    vi.advanceTimersByTime(NOTIFICATION_PAGE_MS)
    expect(surface.shown).toHaveLength(1)
    expect(surface.hideCalls).toBe(1)
  })

  it("waits while the surface is busy and resumes on pump", () => {
    const surface = new RecordingSurface()
    surface.allowed = false
    const presenter = makePresenter(surface)
    presenter.add(entry("a", "hello"))
    expect(surface.shown).toHaveLength(0)
    expect(presenter.queued).toBe(1)
    expect(presenter.showing).toBe(false)
    surface.allowed = true
    presenter.pump()
    expect(surface.shown).toHaveLength(1)
    expect(surface.shown[surface.shown.length - 1]).toMatchObject({header: "Messages · A", body: "hello"})
  })

  it("interrupt requeues the current notification at the front and restarts it at page 1", () => {
    const surface = new RecordingSurface()
    const presenter = makePresenter(surface)
    presenter.add(entry("b", Array.from({length: 30}, () => "ninechars").join(" ")))
    vi.advanceTimersByTime(NOTIFICATION_PAGE_MS)
    expect(surface.shown[surface.shown.length - 1].header).toBe("Messages · B (2/2)")
    presenter.interrupt()
    expect(surface.hideCalls).toBe(0)
    expect(presenter.showing).toBe(false)
    expect(presenter.queued).toBe(1)
    presenter.pump()
    expect(surface.shown[surface.shown.length - 1].header).toBe("Messages · B (1/2)")
  })

  it("interrupt while blocked leaves nothing running and restarts at page 1 on pump", () => {
    const surface = new RecordingSurface()
    surface.autoAccept = false
    const presenter = makePresenter(surface)
    presenter.add(entry("b", Array.from({length: 30}, () => "ninechars").join(" ")))
    presenter.interrupt()
    // The blocked render's acceptance lands after the interrupt: ignored.
    presenter.onShown()
    vi.advanceTimersByTime(3 * NOTIFICATION_PAGE_MS)
    expect(surface.shown).toHaveLength(1)
    presenter.pump()
    expect(surface.shown).toHaveLength(2)
    expect(surface.shown[1]!.header).toBe("Messages · B (1/2)")
  })

  it("dismissing the showing notification advances; dismissing a queued one removes it", () => {
    const surface = new RecordingSurface()
    const presenter = makePresenter(surface)
    presenter.add(entry("a", "hello"))
    presenter.add(entry("b", "from b"))
    presenter.add(entry("c", "from c"))
    expect(presenter.queued).toBe(2)
    presenter.dismiss("b")
    expect(presenter.queued).toBe(1)
    expect(surface.shown).toHaveLength(1)
    vi.advanceTimersByTime(NOTIFICATION_PAGE_MS)
    expect(surface.shown[surface.shown.length - 1].header).toBe("Messages · C")
    presenter.dismiss("c")
    expect(surface.hideCalls).toBe(1)
    expect(presenter.showing).toBe(false)
  })

  it("shows a title-only notification with the app as header and the title as body", () => {
    const surface = new RecordingSurface()
    const presenter = makePresenter(surface)
    presenter.add({id: "t1", app: "Messages", packageName: "com.m", title: "Hello there", content: ""})
    expect(surface.shown[surface.shown.length - 1]).toMatchObject({header: "Messages", body: "Hello there"})
  })

  it("counts queued notifications excluding the one on screen and reports changes", () => {
    const surface = new RecordingSurface()
    let changes = 0
    const presenter = makePresenter(surface, () => {
      changes += 1
    })
    presenter.add(entry("a", "hello"))
    presenter.add(entry("b", "from b"))
    presenter.add(entry("c", "from c"))
    expect(presenter.queued).toBe(2)
    expect(changes).toBe(3)
    vi.advanceTimersByTime(NOTIFICATION_PAGE_MS)
    expect(changes).toBe(4)
    presenter.dismiss("c")
    expect(changes).toBe(5)
  })

  it("a repost of the showing notification does not restart it", () => {
    const surface = new RecordingSurface()
    const presenter = makePresenter(surface)
    presenter.add(entry("a", "hello"))
    expect(surface.shown).toHaveLength(1)
    presenter.add({...entry("a", "updated"), title: "A2"})
    expect(surface.shown).toHaveLength(1)
    expect(presenter.queued).toBe(0)
    expect(presenter.showing).toBe(true)
  })

  it("a repost of a queued notification replaces it in place", () => {
    const surface = new RecordingSurface()
    const presenter = makePresenter(surface)
    presenter.add(entry("a", "hello"))
    presenter.add(entry("b", "old content"))
    presenter.add(entry("b", "new content"))
    expect(presenter.queued).toBe(1)
    vi.advanceTimersByTime(NOTIFICATION_PAGE_MS)
    expect(surface.shown[surface.shown.length - 1]).toMatchObject({header: "Messages · B", body: "new content"})
  })

  it("retain drops queued items and the on-screen item failing the filter", () => {
    const surface = new RecordingSurface()
    const presenter = makePresenter(surface)
    presenter.add(entry("a", "hello"))
    presenter.add(entry("b", "from b"))
    presenter.retain((kept) => kept.id !== "a")
    expect(presenter.showing).toBe(true)
    expect(surface.shown[surface.shown.length - 1].header).toBe("Messages · B")
    presenter.retain(() => false)
    expect(surface.hideCalls).toBe(1)
    expect(presenter.showing).toBe(false)
    expect(presenter.queued).toBe(0)
  })

  it("retain does not report a change when nothing was removed", () => {
    const surface = new RecordingSurface()
    let changes = 0
    const presenter = makePresenter(surface, () => {
      changes += 1
    })
    presenter.add(entry("a", "hello"))
    presenter.add(entry("b", "from b"))
    const before = changes
    presenter.retain(() => true)
    expect(changes).toBe(before)
    // An empty queue that keeps nothing also changed nothing.
    presenter.dispose()
    const fresh = makePresenter(surface, () => {
      changes += 1
    })
    const beforeFresh = changes
    fresh.retain(() => false)
    expect(changes).toBe(beforeFresh)
  })

  it("dispose stops the page timer and ignores later adds without hiding", () => {
    const surface = new RecordingSurface()
    const presenter = makePresenter(surface)
    presenter.add(entry("a", "hello"))
    presenter.dispose()
    expect(surface.hideCalls).toBe(0)
    presenter.add(entry("b", "from b"))
    presenter.pump()
    presenter.onShown()
    vi.advanceTimersByTime(60000)
    expect(surface.shown).toHaveLength(1)
    expect(presenter.queued).toBe(0)
    expect(presenter.showing).toBe(false)
  })
})
