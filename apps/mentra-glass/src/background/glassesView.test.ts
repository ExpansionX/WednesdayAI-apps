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
})
