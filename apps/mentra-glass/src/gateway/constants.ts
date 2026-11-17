/** Client identity advertised in the gateway `connect` handshake. */
export const CLIENT_ID = "openclaw-mentra-node"
export const CLIENT_DISPLAY_NAME = "MentraOS glasses"
export const CLIENT_MODE = "ui"
export const CLIENT_PLATFORM = "mentraos"
export const DEVICE_FAMILY = "glasses"
export const ROLE = "operator"
export const SCOPES = ["operator.read", "operator.write"]
// Role-aware client bounds (plan protocol-v4 §6 P2): this socket is an operator socket, so it
// advertises [GATEWAY_MIN_PROTOCOL_VERSION, GATEWAY_PROTOCOL_VERSION] = [3, 4]. The bounds are
// client capabilities, independent of the synced schema version and of server admission
// floors; the P4 window later raises the minimum. Hand-written — bump manually with the
// generator counterparts in WednesdayAI-apps (Swift) and GatewayProtocol.kt (Android).
export const GATEWAY_PROTOCOL_VERSION = 4
export const GATEWAY_MIN_PROTOCOL_VERSION = 3
export const GATEWAY_MIN_NODE_PROTOCOL_VERSION = 3

/** Mirrors upstream OpenClawKit's `minimumProtocolVersion(role:mode:)`: node RPC frames stayed
 * compatible across v3/v4, so node-role sockets keep the node minimum; other roles ride the
 * client minimum. */
export function minimumProtocolVersion(role: string, clientMode: string): number {
  return role.trim().toLowerCase() === "node" && clientMode.trim().toLowerCase() === "node"
    ? GATEWAY_MIN_NODE_PROTOCOL_VERSION
    : GATEWAY_MIN_PROTOCOL_VERSION
}

/** `session.storage` keys. Values are JSON-encoded. */
export const IDENTITY_STORAGE_KEY = "wai.identity.v1"
export const GATEWAY_STORAGE_KEY = "wai.gateway.v1"
export const DEVICE_AUTH_STORAGE_KEY = "wai.deviceAuth.v1"
export const SETTINGS_STORAGE_KEY = "wai.settings.v1"
export const NOTIFICATION_APPS_STORAGE_KEY = "wai.notificationApps.v1"
