/**
 * Portions Copyright (c) 2026 solavrc.
 * Ported from openclaw-even-g2-node (MIT License); device metadata
 * normalization mirrors WednesdayAI `src/gateway/device-metadata-normalization.ts`
 * byte for byte (trim + ASCII-lowercase only, so TS/Swift/Kotlin agree).
 */

export type DeviceAuthPayloadV3Params = {
  deviceId: string
  clientId: string
  clientMode: string
  role: string
  scopes: string[]
  signedAtMs: number
  token?: string
  nonce: string
  platform?: string
  deviceFamily?: string
}

function normalizeDeviceMetadataForAuth(value?: string): string {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32))
}

export function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    normalizeDeviceMetadataForAuth(params.platform),
    normalizeDeviceMetadataForAuth(params.deviceFamily),
  ].join("|")
}
