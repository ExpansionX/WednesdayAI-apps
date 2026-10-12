/**
 * Portions Copyright (c) 2026 solavrc.
 * Ported from openclaw-even-g2-node (MIT License).
 */

import * as ed25519 from "@noble/ed25519"
import {sha256, sha512} from "@noble/hashes/sha2.js"

import {IDENTITY_STORAGE_KEY} from "./constants"
import {base64UrlDecode, base64UrlEncode} from "./encoding"
import type {KeyValueStore} from "./types"

// Pure-JS SHA-512 wiring: `crypto.subtle` throws in the MentraOS background runtime.
ed25519.hashes.sha512 = sha512
ed25519.hashes.sha512Async = (message) => Promise.resolve(sha512(message))

export type GatewayIdentity = {
  deviceId: string
  publicKeyB64u: string
  privateKeyB64u: string
  createdAtMs: number
}

export function sha256Hex(bytes: Uint8Array): string {
  return [...sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function loadIdentity(store: KeyValueStore): Promise<GatewayIdentity | null> {
  const raw = await store.get(IDENTITY_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<GatewayIdentity> | null
    if (!parsed?.publicKeyB64u || !parsed.privateKeyB64u || !parsed.deviceId) return null
    // deviceId must stay the sha256 fingerprint of the public key so the
    // gateway's `fingerprintPublicKey` check keeps matching; rewrite stale records.
    const identity: GatewayIdentity = {
      deviceId: sha256Hex(base64UrlDecode(parsed.publicKeyB64u)),
      publicKeyB64u: parsed.publicKeyB64u,
      privateKeyB64u: parsed.privateKeyB64u,
      createdAtMs: typeof parsed.createdAtMs === "number" ? parsed.createdAtMs : Date.now(),
    }
    if (identity.deviceId !== parsed.deviceId) {
      await store.set(IDENTITY_STORAGE_KEY, JSON.stringify(identity))
    }
    return identity
  } catch {
    return null
  }
}

export async function loadOrCreateIdentity(store: KeyValueStore): Promise<GatewayIdentity> {
  const loaded = await loadIdentity(store)
  if (loaded) return loaded
  const privateKey = ed25519.utils.randomSecretKey()
  const publicKey = await ed25519.getPublicKeyAsync(privateKey)
  const identity: GatewayIdentity = {
    deviceId: sha256Hex(publicKey),
    publicKeyB64u: base64UrlEncode(publicKey),
    privateKeyB64u: base64UrlEncode(privateKey),
    createdAtMs: Date.now(),
  }
  await store.set(IDENTITY_STORAGE_KEY, JSON.stringify(identity))
  return identity
}

export async function signPayload(identity: GatewayIdentity, payload: string): Promise<string> {
  const message = new TextEncoder().encode(payload)
  const signature = await ed25519.signAsync(message, base64UrlDecode(identity.privateKeyB64u))
  return base64UrlEncode(signature)
}
