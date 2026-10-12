/**
 * Portions Copyright (c) 2026 solavrc.
 * Ported from openclaw-even-g2-node (MIT License).
 */

import {base64UrlDecode} from "./encoding"
import {isRecord} from "./types"

const SETUP_CODE_QUERY_PARAMS = ["setupCode", "gatewayUrl", "relayUrl", "relay"]

const INSECURE_GATEWAY_URL_MESSAGE = "Insecure gateway URL. Use Tailscale Serve (wss://) or the tailnet IP."

/**
 * Splits `scheme://host[:port]/...` without the WHATWG `URL` class, which the
 * MentraOS background runtime does not provide. Returns null for text that is
 * not an absolute URL, and for any authority outside plain host/IP/port
 * characters (userinfo, backslashes, percent-escapes, whitespace): native
 * WebSocket stacks (OkHttp, URLSession) parse those differently, so the host
 * validated here could differ from the host actually dialled.
 */
export function parseUrlParts(value: string): {scheme: string; host: string; hostname: string; query: string} | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(value.trim())
  if (!match) return null
  const authority = match[2]!.toLowerCase()
  if (/[\\\s]/.test(match[3]!)) return null
  // Exactly `host[:port]` or `[ipv6][:port]`; anything else is refused.
  const host = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::\d*)?$/.exec(authority)
  if (!host) return null
  const hostname = host[1] ?? host[2]!
  return {scheme: match[1]!.toLowerCase(), host: authority, hostname, query: match[4] ?? ""}
}

function queryParam(query: string, key: string): string | null {
  for (const pair of query.split("&")) {
    const separator = pair.indexOf("=")
    if (separator === -1 || pair.slice(0, separator) !== key) continue
    try {
      return decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, " "))
    } catch {
      return null
    }
  }
  return null
}

/** Extracts the setup-code payload from any QR text (bare code, or a URL carrying it as a query param). */
function setupCodeFromQrValue(value: string): string {
  const trimmed = value.trim()
  const parts = parseUrlParts(trimmed)
  if (!parts) return trimmed
  for (const key of SETUP_CODE_QUERY_PARAMS) {
    const found = queryParam(parts.query, key)
    if (found) return found
  }
  return trimmed
}

// UTF-8 decoding without TextDecoder: it is not in the MentraOS polyfill list.
function utf8Decode(bytes: Uint8Array): string {
  let out = ""
  for (let index = 0; index < bytes.length;) {
    const lead = bytes[index]!
    if (lead < 0x80) {
      out += String.fromCharCode(lead)
      index += 1
      continue
    }
    let codePoint: number
    let extra: number
    if (lead >= 0xf0) {
      codePoint = lead & 0x07
      extra = 3
    } else if (lead >= 0xe0) {
      codePoint = lead & 0x0f
      extra = 2
    } else {
      codePoint = lead & 0x1f
      extra = 1
    }
    for (let offset = 1; offset <= extra; offset += 1) {
      codePoint = (codePoint << 6) | (bytes[index + offset]! & 0x3f)
    }
    index += extra + 1
    if (codePoint > 0xffff) {
      codePoint -= 0x10000
      out += String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff))
    } else {
      out += String.fromCharCode(codePoint)
    }
  }
  return out
}

function decodeSetupCodeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(utf8Decode(base64UrlDecode(value)))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isTailscaleCgnatIpv4(hostname: string): boolean {
  const parts = hostname.split(".")
  if (parts.length !== 4) return false
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false
    const octet = Number(part)
    if (octet > 255) return false
    octets.push(octet)
  }
  return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127
}

/**
 * `wss:` is always allowed; plain `ws:` only for loopback or the Tailscale
 * CGNAT range (100.64.0.0/10), where traffic never leaves the tailnet.
 */
export function assertSecureGatewayUrl(url: string): void {
  const parsed = parseUrlParts(url)
  if (!parsed) throw new Error(INSECURE_GATEWAY_URL_MESSAGE)
  if (parsed.scheme === "wss") return
  if (parsed.scheme !== "ws") throw new Error(INSECURE_GATEWAY_URL_MESSAGE)
  const hostname = parsed.hostname
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return
  if (isTailscaleCgnatIpv4(hostname)) return
  throw new Error(INSECURE_GATEWAY_URL_MESSAGE)
}

/** Lowercases scheme and host and strips the trailing slash; used as the token-map key. */
export function normalizeGatewayUrl(url: string): string {
  const trimmed = url.trim()
  const schemeEnd = trimmed.indexOf("://")
  if (schemeEnd === -1) return trimmed.replace(/\/+$/, "")
  const scheme = trimmed.slice(0, schemeEnd).toLowerCase()
  const afterScheme = trimmed.slice(schemeEnd + 3)
  const pathStart = afterScheme.indexOf("/")
  const authority = pathStart === -1 ? afterScheme : afterScheme.slice(0, pathStart)
  const path = pathStart === -1 ? "" : afterScheme.slice(pathStart)
  return `${scheme}://${authority.toLowerCase()}${path}`.replace(/\/+$/, "")
}

/**
 * Accepts either the `wednesdayai qr` setup code (base64url JSON
 * `{url, bootstrapToken, expiresAtMs?}`) or any URL/QR text carrying one.
 */
export function parseSetupInput(raw: string): {url: string; bootstrapToken: string} {
  const candidate = setupCodeFromQrValue(raw)
  const trimmed = candidate.trim()
  const payload = trimmed && !/^wss?:\/\//i.test(trimmed) ? decodeSetupCodeJson(trimmed) : null
  const urlField = payload && typeof payload.url === "string" ? payload.url.trim() : ""
  const url = urlField || (/^wss?:\/\//i.test(trimmed) ? trimmed : "")
  if (!url) throw new Error("Unrecognised setup code")
  const bootstrapToken = payload && typeof payload.bootstrapToken === "string" ? payload.bootstrapToken.trim() : ""
  if (!bootstrapToken) {
    throw new Error("Setup code has no bootstrap token. Run: wednesdayai qr --client openclaw-mentra-node")
  }
  const expiresAtMs = payload && typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : null
  if (expiresAtMs !== null && expiresAtMs < Date.now()) {
    throw new Error("Setup code expired. Generate a new one.")
  }
  assertSecureGatewayUrl(url)
  return {url, bootstrapToken}
}
