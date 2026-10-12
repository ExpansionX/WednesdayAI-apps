import {describe, expect, it} from "vitest"

import {applyChatEvent, bindServerRunId, startRun} from "./chat"

function chatEvent(state: string, text: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "k1",
    sessionKey: "agent:main:main",
    seq: 1,
    state,
    ...(text === null ? {} : {message: {role: "assistant", content: [{type: "text", text}]}}),
    ...extra,
  }
}

describe("applyChatEvent", () => {
  it("replaces cumulative delta text instead of appending", () => {
    const run = startRun("k1")
    expect(applyChatEvent(run, chatEvent("delta", "Hel"))).not.toBeNull()
    applyChatEvent(run, chatEvent("delta", "Hello"))
    expect(run.text).toBe("Hello")
    expect(run.state).toBe("streaming")
  })

  it("ignores events for other runs", () => {
    const run = startRun("k1")
    expect(applyChatEvent(run, {...chatEvent("delta", "Hello"), runId: "other-run"})).toBeNull()
    expect(run.text).toBe("")
    expect(run.state).toBe("thinking")
  })

  it("applies events that arrive under the bound server runId", () => {
    const run = startRun("k1")
    bindServerRunId(run, "srv-1")
    bindServerRunId(run, "srv-1")
    expect(applyChatEvent(run, {...chatEvent("final", "Done"), runId: "srv-1"})).not.toBeNull()
    expect(run.state).toBe("final")
    expect(run.text).toBe("Done")
  })

  it("keeps the previous text when a final event has no text", () => {
    const run = startRun("k1")
    applyChatEvent(run, chatEvent("delta", "partial"))
    applyChatEvent(run, {...chatEvent("final", null), message: {role: "assistant", content: []}})
    expect(run.state).toBe("final")
    expect(run.text).toBe("partial")
  })

  it("surfaces the gateway error message", () => {
    const run = startRun("k1")
    applyChatEvent(run, {...chatEvent("error", null), errorMessage: "model blew up"})
    expect(run.state).toBe("error")
    expect(run.error).toBe("model blew up")
  })

  it("defaults a missing error message", () => {
    const run = startRun("k1")
    applyChatEvent(run, chatEvent("error", null))
    expect(run.state).toBe("error")
    expect(run.error).toBe("Request failed")
  })

  it("marks aborted runs", () => {
    const run = startRun("k1")
    applyChatEvent(run, chatEvent("aborted", null))
    expect(run.state).toBe("aborted")
  })

  it("ignores payloads that are not objects", () => {
    const run = startRun("k1")
    expect(applyChatEvent(run, null)).toBeNull()
    expect(applyChatEvent(run, "delta")).toBeNull()
  })
})
