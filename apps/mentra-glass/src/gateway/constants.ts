/** Client identity advertised in the gateway `connect` handshake. */
export const CLIENT_ID = "openclaw-mentra-node"
export const CLIENT_DISPLAY_NAME = "MentraOS glasses"
export const CLIENT_MODE = "ui"
export const CLIENT_PLATFORM = "mentraos"
export const DEVICE_FAMILY = "glasses"
export const ROLE = "operator"
export const SCOPES = ["operator.read", "operator.write"]
export const PROTOCOL_VERSION = 3

/** `session.storage` keys. Values are JSON-encoded. */
export const IDENTITY_STORAGE_KEY = "wai.identity.v1"
export const GATEWAY_STORAGE_KEY = "wai.gateway.v1"
export const DEVICE_AUTH_STORAGE_KEY = "wai.deviceAuth.v1"
export const SETTINGS_STORAGE_KEY = "wai.settings.v1"
export const NOTIFICATION_APPS_STORAGE_KEY = "wai.notificationApps.v1"
