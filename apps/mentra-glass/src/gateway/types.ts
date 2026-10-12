/**
 * Storage abstraction over `session.storage` (string key/value) so the
 * gateway client stays portable across the MentraOS background runtime,
 * tests, and the bun smoke tool.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** Canonical object guard for untrusted JSON frames; fields stay `unknown` until checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Lifecycle reported to the UI/controller:
 * - unpaired: no gateway URL or no device token — needs a setup code
 * - connecting: socket open, waiting for challenge/handshake
 * - connected: handshake ok, requests allowed
 * - offline: transport dropped, reconnecting with backoff
 * - repair_required: gateway rejected the credential — re-pair needed
 */
export type ConnectionState = "unpaired" | "connecting" | "connected" | "offline" | "repair_required"
