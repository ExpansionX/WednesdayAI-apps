import {afterEach, describe, expect, it, vi} from "vitest"

/**
 * `TRACE_ENABLED` is read once at module load, so each test stubs the env,
 * resets the module registry, and re-imports `./trace` fresh.
 */
async function importTrace() {
  vi.resetModules()
  return await import("./trace")
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("trace", () => {
  it("logs one `[trace]` line with the event and JSON data when built with the flag", async () => {
    vi.stubEnv("MENTRA_PUBLIC_TRACE", "1")
    const {trace} = await importTrace()
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    trace("wake.decided", {trigger: "wednesday", query: "time"})

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('[trace] wake.decided {"trigger":"wednesday","query":"time"}')
  })

  it("logs nothing when the flag is unset (normal build)", async () => {
    vi.stubEnv("MENTRA_PUBLIC_TRACE", "")
    const {trace} = await importTrace()
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    trace("wake.decided", {trigger: "wednesday"})

    expect(log).not.toHaveBeenCalled()
  })

  it('logs nothing for a near-miss flag value — the gate is exactly "1"', async () => {
    vi.stubEnv("MENTRA_PUBLIC_TRACE", "true")
    const {trace} = await importTrace()
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    trace("wake.decided", {trigger: "wednesday"})

    expect(log).not.toHaveBeenCalled()
  })
})
