/**
 * Chat run tracking against the gateway `chat` event stream.
 *
 * Gateway facts this encodes (WednesdayAI core):
 * - `chat.send` emits events whose `runId` equals the caller's `idempotencyKey`.
 * - `delta` message text is cumulative, so each event replaces the shown text.
 * - `error` events carry `errorMessage`; terminal states are final/aborted/error.
 */

import {isRecord} from "./types"

export type ChatRunState = "thinking" | "streaming" | "final" | "error" | "aborted"

export interface ChatRun {
  keys: string[]
  text: string
  state: ChatRunState
  error: string | null
}

export function startRun(idempotencyKey: string): ChatRun {
  return {keys: [idempotencyKey], text: "", state: "thinking", error: null}
}

/** The server echoes the idempotency key as runId, then may switch to its own id. */
export function bindServerRunId(run: ChatRun, runId: string): void {
  if (!runId || run.keys.includes(runId)) return
  run.keys.push(runId)
}

export function applyChatEvent(run: ChatRun, payload: unknown): ChatRun | null {
  if (!isRecord(payload)) return null
  const runId = payload.runId
  if (typeof runId !== "string" || !run.keys.includes(runId)) return null
  switch (payload.state) {
    case "delta":
    case "final": {
      // Delta text is cumulative: replace, never append.
      const text = chatEventText(payload.message)
      if (text) run.text = text
      run.state = payload.state === "delta" ? "streaming" : "final"
      break
    }
    case "error":
      run.state = "error"
      run.error =
        typeof payload.errorMessage === "string" && payload.errorMessage ? payload.errorMessage : "Request failed"
      break
    case "aborted":
      run.state = "aborted"
      break
    default:
      return null
  }
  return run
}

function chatEventText(message: unknown): string {
  if (!isRecord(message)) return ""
  const content = message.content
  if (!Array.isArray(content)) return ""
  let text = ""
  for (const item of content) {
    if (!isRecord(item)) continue
    if (item.type === "text" && typeof item.text === "string") text += item.text
  }
  return text
}
