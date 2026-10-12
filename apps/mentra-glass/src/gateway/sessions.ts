/**
 * Session routing helpers matching the gateway's own formats
 * (WednesdayAI `src/routing/session-key.ts` and the `agents.list` result).
 */

export type SessionScope = "per-sender" | "global"

export type AgentSummary = {
  id: string
  name?: string
}

export type AgentsInfo = {
  defaultId: string
  mainKey: string
  scope: SessionScope
  agents: AgentSummary[]
}

export function agentOptions(result: {agents: AgentSummary[]}): {id: string; label: string}[] {
  return result.agents.map((agent) => ({id: agent.id, label: agent.name ?? agent.id}))
}

export function resolveSessionKey(params: {
  agentId: string | null
  agents: AgentsInfo | null
  mainSessionKey: string | null
}): string {
  if (params.agents?.scope === "global") return "global"
  if (params.agentId && params.agents?.agents.some((agent) => agent.id === params.agentId)) {
    return `agent:${params.agentId}:${params.agents.mainKey}`
  }
  return (
    params.mainSessionKey ??
    (params.agents ? `agent:${params.agents.defaultId}:${params.agents.mainKey}` : "agent:main:main")
  )
}
