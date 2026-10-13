/**
 * Body lines for the head-tilt glance frame: the current time, the gateway
 * connection status, and the queued notification count when there is one.
 */
import type {ConnectionState} from "../gateway/types"

const LABELS: Record<ConnectionState, string> = {
  connected: "Ready",
  connecting: "Connecting…",
  offline: "Offline",
  unpaired: "Not paired",
  repair_required: "Pairing needs repair",
}

export function glanceBody(now: Date, state: ConnectionState, queued: number): string {
  const hh = String(now.getHours()).padStart(2, "0")
  const mm = String(now.getMinutes()).padStart(2, "0")
  const lines = [`${hh}:${mm}`, LABELS[state]]
  if (queued > 0) lines.push(queued === 1 ? "1 notification" : `${queued} notifications`)
  return lines.join("\n")
}
