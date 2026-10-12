import {describe, expect, it} from "vitest"

import {agentOptions, resolveSessionKey, type AgentsInfo} from "./sessions"

const agents: AgentsInfo = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [{id: "main", name: "Assistant"}, {id: "ops"}],
}

describe("resolveSessionKey", () => {
  it("routes to the global session when the gateway scope is global", () => {
    expect(
      resolveSessionKey({agentId: "ops", agents: {...agents, scope: "global"}, mainSessionKey: "agent:main:main"}),
    ).toBe("global")
  })

  it("builds the per-agent key for a selected agent", () => {
    expect(resolveSessionKey({agentId: "ops", agents, mainSessionKey: "agent:main:main"})).toBe("agent:ops:main")
  })

  it("falls back to the hello main session key for an unknown agent", () => {
    expect(resolveSessionKey({agentId: "ghost", agents, mainSessionKey: "agent:main:main"})).toBe("agent:main:main")
  })

  it("falls back to the gateway default agent when there is no hello key", () => {
    expect(resolveSessionKey({agentId: null, agents, mainSessionKey: null})).toBe("agent:main:main")
  })

  it("uses the offline default when nothing is known yet", () => {
    expect(resolveSessionKey({agentId: null, agents: null, mainSessionKey: null})).toBe("agent:main:main")
  })
})

describe("agentOptions", () => {
  it("labels agents by name, falling back to the id", () => {
    expect(agentOptions(agents)).toEqual([
      {id: "main", label: "Assistant"},
      {id: "ops", label: "ops"},
    ])
  })
})
