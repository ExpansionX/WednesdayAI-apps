import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"

import type {MiniappSession, RenderElement} from "@mentra/miniapp/background"

import {FINAL_HIDE_MS, GlassesView} from "./glassesView"

/**
 * Minimal display host: records every render call and answers with a
 * configurable arbitration status ("blocked" = another background app owns
 * the display lock and dropped the frame).
 */
class FakeDisplayHost {
  readonly calls: Array<RenderElement[] | "clear"> = []
  elementStatus: "displayed" | "blocked" = "displayed"
  capabilities = {display: {width: 576, height: 288}}
  readonly display = {
    render: async (elements: RenderElement[]) => {
      if (elements.length === 0) {
        this.calls.push("clear")
        return {status: "displayed" as const}
      }
      this.calls.push(elements)
      return {status: this.elementStatus}
    },
  }

  /** The `text` of the body element of the last element frame, if any. */
  lastBodyText(): string | null {
    for (let index = this.calls.length - 1; index >= 0; index -= 1) {
      const call = this.calls[index]
      if (call === "clear") continue
      const body = call.find((element) => "id" in element && element.id === "wai-body")
      if (body && "text" in body) return String(body.text)
    }
    return null
  }
}

function asSession(host: FakeDisplayHost): MiniappSession {
  return host as unknown as MiniappSession
}

function finalFrame(body = "Answer"): {phase: "final"; agentLabel: string; body: string} {
  return {phase: "final", agentLabel: "default", body}
}

describe("GlassesView", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("re-renders live frames every 5 s to hold the background lock", async () => {
    const host = new FakeDisplayHost()
    const view = new GlassesView(asSession(host))
    view.show({phase: "thinking", agentLabel: "default", body: "query"})
    await vi.advanceTimersByTimeAsync(0)
    expect(host.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4999)
    expect(host.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(host.calls).toHaveLength(2)
    view.dispose()
  })

  it("coalesces a show issued while a render is still in flight", async () => {
    // First render never resolves until released; the throttle timestamp must
    // be taken when the render is issued, not when its promise settles.
    let releaseFirst: () => void = () => {}
    const firstSettled = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const calls: Array<RenderElement[] | "clear"> = []
    const render = async (elements: RenderElement[]) => {
      calls.push(elements)
      if (calls.length === 1) await firstSettled
      return {status: "displayed" as const}
    }
    const view = new GlassesView({display: {render}} as unknown as MiniappSession)

    view.show({phase: "thinking", agentLabel: "default", body: "first"})
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(100)
    view.show({phase: "thinking", agentLabel: "default", body: "second"})
    // Only 100 ms since the first render was issued: still throttled.
    await vi.advanceTimersByTimeAsync(299)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    const body = (calls.at(1) as RenderElement[] | undefined)?.find(
      (element) => "id" in element && element.id === "wai-body",
    )
    expect(body && "text" in body && body.text).toBe("second")

    releaseFirst()
    await vi.advanceTimersByTimeAsync(0)
    view.dispose()
  })

  it("auto-hides a displayed final frame 15 s after its show", async () => {
    const host = new FakeDisplayHost()
    const view = new GlassesView(asSession(host))
    view.show(finalFrame())
    await vi.advanceTimersByTimeAsync(0)
    expect(host.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(FINAL_HIDE_MS - 1)
    expect(host.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(host.calls.at(-1)).toBe("clear")
    view.dispose()
  })

  it("auto-hides a displayed offline frame after 4 s", async () => {
    const host = new FakeDisplayHost()
    const view = new GlassesView(asSession(host))
    view.show({phase: "offline", agentLabel: "default", body: "Connection lost"})
    await vi.advanceTimersByTimeAsync(0)
    expect(host.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3999)
    expect(host.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(host.calls.at(-1)).toBe("clear")
    view.dispose()
  })

  it("a replacement shown from onShown outlives the previous frame's auto-clear", async () => {
    const host = new FakeDisplayHost()
    let view: GlassesView | null = null
    view = new GlassesView(asSession(host), {
      onShown: (vm) => {
        // The controller reacts to the final frame landing by taking the
        // display with a live frame, mid-renderFrame of the final one.
        if (vm.phase === "final") {
          view!.show({phase: "thinking", agentLabel: "default", body: "Working on it"})
        }
      },
    })
    view.show(finalFrame("Answer"))
    await vi.advanceTimersByTimeAsync(0)
    // The final frame's renderFrame armed its 15 s auto-clear after the
    // replacement took over: that stale timer must not wipe the live frame.
    await vi.advanceTimersByTimeAsync(FINAL_HIDE_MS + 6000)
    expect(host.calls).not.toContain("clear")
    expect(host.lastBodyText()).toBe("Working on it")
    view!.dispose()
  })

  it("retries blocked terminal frames and keeps the auto-hide deadline fixed", async () => {
    const host = new FakeDisplayHost()
    host.elementStatus = "blocked"
    const view = new GlassesView(asSession(host))
    view.show(finalFrame("Answer held by another app"))
    // First attempt is throttled forward, then blocked; retries follow at 1 s.
    await vi.advanceTimersByTimeAsync(0)
    expect(host.calls).toHaveLength(1)
    expect(host.lastBodyText()).toBe("Answer held by another app")
    await vi.advanceTimersByTimeAsync(1000)
    expect(host.calls).toHaveLength(2)
    // Still blocked all the way to the deadline: retries continue, the frame
    // is never dropped and never lives past first show + 15 s.
    await vi.advanceTimersByTimeAsync(FINAL_HIDE_MS - 1001)
    const retried = host.calls.filter((call) => call !== "clear")
    expect(retried.length).toBeGreaterThanOrEqual(14)
    expect(host.calls).not.toContain("clear")
    // Deadline expiry clears even though the last attempts were blocked.
    await vi.advanceTimersByTimeAsync(1)
    expect(host.calls.at(-1)).toBe("clear")
    const total = host.calls.length
    await vi.advanceTimersByTimeAsync(30000)
    expect(host.calls).toHaveLength(total)
  })

  it("stops retrying once a blocked terminal frame is displayed, and still auto-hides on time", async () => {
    const host = new FakeDisplayHost()
    host.elementStatus = "blocked"
    const view = new GlassesView(asSession(host))
    view.show(finalFrame())
    await vi.advanceTimersByTimeAsync(3000)
    expect(host.calls.length).toBeGreaterThanOrEqual(2)
    host.elementStatus = "displayed"
    await vi.advanceTimersByTimeAsync(1000)
    expect(host.calls.at(-1)).not.toBe("clear")
    const afterDisplayed = host.calls.length
    // A displayed terminal frame schedules nothing but its clear: no retries.
    await vi.advanceTimersByTimeAsync(10999)
    expect(host.calls.length).toBe(afterDisplayed)
    expect(host.calls).not.toContain("clear")
    // Deadline expiry adds exactly one clear at first show + 15 s.
    await vi.advanceTimersByTimeAsync(1)
    expect(host.calls.at(-1)).toBe("clear")
    expect(host.calls.length).toBe(afterDisplayed + 1)
    view.dispose()
  })

  it("stops all renders after dispose, including live heartbeats", async () => {
    const host = new FakeDisplayHost()
    const view = new GlassesView(asSession(host))
    view.show({phase: "streaming", agentLabel: "default", body: "partial"})
    await vi.advanceTimersByTimeAsync(0)
    expect(host.calls).toHaveLength(1)
    view.dispose()
    const total = host.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(host.calls).toHaveLength(total)
  })

  it("clears immediately on hide and cancels pending work", async () => {
    const host = new FakeDisplayHost()
    const view = new GlassesView(asSession(host))
    view.show(finalFrame())
    view.hide()
    expect(host.calls).toEqual(["clear"])
    const total = host.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(host.calls).toHaveLength(total)
  })

  it("omits the body element when a frame has no body text", async () => {
    const host = new FakeDisplayHost()
    const view = new GlassesView(asSession(host))
    view.show({phase: "listening", agentLabel: "default", body: ""})
    await vi.advanceTimersByTimeAsync(0)

    expect(host.calls).toHaveLength(1)
    const frame = host.calls[0] as RenderElement[]
    expect(frame).toHaveLength(1)
    const header = frame[0]!
    expect("id" in header && header.id).toBe("wai-header")
    view.dispose()
  })

  it("cancels the previous frame's auto-clear when a new frame takes over", async () => {
    const host = new FakeDisplayHost()
    const view = new GlassesView(asSession(host))
    view.show(finalFrame("Old answer"))
    await vi.advanceTimersByTimeAsync(0)

    // A live frame arrives while the final's auto-clear is still pending.
    view.show({phase: "thinking", agentLabel: "default", body: "new question"})
    await vi.advanceTimersByTimeAsync(400)
    expect(host.lastBodyText()).toBe("new question")

    // The old frame's deadline passes: the new frame must survive it.
    await vi.advanceTimersByTimeAsync(20000)
    expect(host.calls).not.toContain("clear")
    expect(host.lastBodyText()).toBe("new question")
    view.dispose()
  })
})

describe("GlassesView glance and notification frames", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("glance frame auto-clears after 5 s and reports onAutoClear once", async () => {
    const host = new FakeDisplayHost()
    const onAutoClear = vi.fn()
    const view = new GlassesView(asSession(host), {onAutoClear})
    view.show({phase: "glance", agentLabel: "Main", body: "14:05\nReady"})
    await vi.advanceTimersByTimeAsync(0)
    expect(host.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4999)
    expect(host.calls).not.toContain("clear")
    await vi.advanceTimersByTimeAsync(1)
    expect(host.calls.at(-1)).toBe("clear")
    expect(onAutoClear).toHaveBeenCalledTimes(1)
    view.dispose()
  })

  it("notification frame auto-clears after 6 s", async () => {
    const host = new FakeDisplayHost()
    const onAutoClear = vi.fn()
    const view = new GlassesView(asSession(host), {onAutoClear})
    view.show({phase: "notification", agentLabel: "", header: "Messages · Alice", body: "hi"})
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5999)
    expect(host.calls).not.toContain("clear")
    await vi.advanceTimersByTimeAsync(1)
    expect(host.calls.at(-1)).toBe("clear")
    expect(onAutoClear).toHaveBeenCalledTimes(1)
    view.dispose()
  })

  it("re-anchors a blocked notification frame's auto-clear at its first accepted render", async () => {
    const host = new FakeDisplayHost()
    host.elementStatus = "blocked"
    const onAutoClear = vi.fn()
    const view = new GlassesView(asSession(host), {onAutoClear})
    view.show({phase: "notification", agentLabel: "", header: "Messages · Alice", body: "hi"})
    await vi.advanceTimersByTimeAsync(0) // first attempt: blocked
    await vi.advanceTimersByTimeAsync(3000) // retries at +1 s..+3 s: still blocked
    host.elementStatus = "displayed"
    await vi.advanceTimersByTimeAsync(1000) // accepted ~4 s after show
    expect(host.calls).not.toContain("clear")
    // Not cleared at show + 6 s — only at acceptance + 6 s.
    await vi.advanceTimersByTimeAsync(5999)
    expect(host.calls).not.toContain("clear")
    await vi.advanceTimersByTimeAsync(1)
    expect(host.calls.at(-1)).toBe("clear")
    expect(onAutoClear).toHaveBeenCalledTimes(1)
    view.dispose()
  })

  it("header override replaces the default header", async () => {
    const host = new FakeDisplayHost()
    const view = new GlassesView(asSession(host))
    view.show({phase: "notification", agentLabel: "", header: "Messages · Alice", body: "hi"})
    await vi.advanceTimersByTimeAsync(0)
    const frame = host.calls[0] as RenderElement[]
    const header = frame.find((element) => "id" in element && element.id === "wai-header")
    expect(header && "text" in header && header.text).toBe("Messages · Alice")
    view.dispose()
  })

  it("glance and notification bodies window from the start, final from the end", async () => {
    const host = new FakeDisplayHost()
    const view = new GlassesView(asSession(host))
    for (const phase of ["glance", "notification"] as const) {
      view.show({phase, agentLabel: "x", body: "b"})
      await vi.advanceTimersByTimeAsync(400)
      const frame = host.calls.at(-1) as RenderElement[]
      const body = frame.find((element) => "id" in element && element.id === "wai-body")
      const window = body && "style" in body && body.style
      expect(window && "textWindow" in window && window.textWindow).toBe("start")
    }
    view.show(finalFrame())
    await vi.advanceTimersByTimeAsync(400)
    const frame = host.calls.at(-1) as RenderElement[]
    const body = frame.find((element) => "id" in element && element.id === "wai-body")
    const window = body && "style" in body && body.style
    expect(window && "textWindow" in window && window.textWindow).toBe("end")
    view.dispose()
  })

  it("hide() does not report onAutoClear", async () => {
    const host = new FakeDisplayHost()
    const onAutoClear = vi.fn()
    const view = new GlassesView(asSession(host), {onAutoClear})
    view.show(finalFrame())
    await vi.advanceTimersByTimeAsync(0)
    view.hide()
    await vi.advanceTimersByTimeAsync(20000)
    expect(onAutoClear).not.toHaveBeenCalled()
  })

  it("reports accepted renders through onShown and skips blocked ones", async () => {
    const host = new FakeDisplayHost()
    const shown: string[] = []
    host.elementStatus = "blocked"
    const view = new GlassesView(asSession(host), {onShown: (vm) => shown.push(vm.phase)})
    view.show({phase: "notification", agentLabel: "", header: "Messages · Alice", body: "hi"})
    await vi.advanceTimersByTimeAsync(0)
    expect(host.calls).toHaveLength(1)
    // Blocked by the host's display lock: nothing is reported yet.
    expect(shown).toEqual([])
    host.elementStatus = "displayed"
    await vi.advanceTimersByTimeAsync(1000)
    expect(shown).toEqual(["notification"])
    // Live-frame heartbeats report every accepted render too.
    view.show({phase: "thinking", agentLabel: "default", body: "q"})
    await vi.advanceTimersByTimeAsync(400)
    expect(shown).toEqual(["notification", "thinking"])
    view.dispose()
  })
})
