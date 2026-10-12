/**
 * Typed channel registry — single source of truth for the names + payload
 * shapes that flow between this miniapp's background JSContext and its UI
 * WebView. Both halves import this file at build time; the bundler inlines
 * the declarations so there's no runtime cross-boundary I/O.
 *
 * All channels here are broadcast (`session.ui.send` / `mentra.send` with
 * `mentra.on` / `session.ui.on`); the assistant UI never needs request/
 * response RPC — the background pushes a full state snapshot instead.
 */

import type {ConnectionState} from "../gateway/types"
import type {MentraTyped} from "@mentra/miniapp/ui"

export interface GlassSettings {
  wakeSttMode: "local" | "cloud"
  agentId: string | null
}

export interface AgentOption {
  id: string
  label: string
}

export interface StateSnapshot {
  connection: ConnectionState
  gatewayHost: string | null
  retryInMs: number | null
  triggers: string[]
  agents: AgentOption[]
  defaultAgentId: string | null
  sessionScope: "per-sender" | "global" | null
  settings: GlassSettings
  /** Whether the microphone test is currently forwarding transcripts. */
  micTestEnabled: boolean
  lastError: string | null
}

export interface Channels {
  // ── UI → background ─────────────────────────────────────────────────────

  /** Ask the background to push a fresh "state" snapshot. */
  "state:get": Record<string, never>
  /** Open the phone QR scanner and pair with the scanned setup code. */
  "pair:scan": Record<string, never>
  /** Pair from a pasted setup code (QR text or base64url setup JSON). */
  "pair:code": {code: string}
  /** Forget the gateway pairing (the identity key is kept). */
  "pair:forget": Record<string, never>
  /** Patch settings; omitted fields stay unchanged. */
  "settings:set": {wakeSttMode?: "local" | "cloud"; agentId?: string | null}
  /** Enable or disable the microphone test. */
  "mictest:set": {enabled: boolean}

  // ── background → UI ─────────────────────────────────────────────────────

  /** Full state snapshot, pushed on every change and on WebView open. */
  state: StateSnapshot
  /** Transcript forwarded while the mic test is enabled. */
  "mictest:transcript": {text: string; isFinal: boolean}
  /** One-off error for the dismissible banner. */
  error: {message: string}
}

declare global {
  // Augment the `mentra` global from @mentra/miniapp/ui with this miniapp's
  // typed channel registry so authors get compile-time enforcement on every
  // mentra.send / mentra.on call without re-declaring it.
  // eslint-disable-next-line no-var
  var mentra: MentraTyped<Channels>
}
