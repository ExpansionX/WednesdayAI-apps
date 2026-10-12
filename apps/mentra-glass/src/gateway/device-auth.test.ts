import * as ed25519 from "@noble/ed25519"
import {sha256} from "@noble/hashes/sha2.js"
import {describe, expect, it} from "vitest"

import {buildDeviceAuthPayloadV3} from "./device-auth"
import {base64UrlDecode} from "./encoding"
import {IDENTITY_STORAGE_KEY} from "./constants"
import {loadOrCreateIdentity, signPayload} from "./identity"
import type {KeyValueStore} from "./types"

function sha256Hex(bytes: Uint8Array): string {
  return [...sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function memoryStore(): KeyValueStore {
  const values = new Map<string, string>()
  return {
    async get(key) {
      return values.get(key) ?? null
    },
    async set(key, value) {
      values.set(key, value)
    },
    async delete(key) {
      values.delete(key)
    },
  }
}

describe("buildDeviceAuthPayloadV3", () => {
  it("matches the gateway payload byte for byte, trimming and ASCII-lowercasing metadata", () => {
    expect(
      buildDeviceAuthPayloadV3({
        deviceId: "d",
        clientId: "openclaw-mentra-node",
        clientMode: "ui",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        signedAtMs: 1700000000000,
        token: "t",
        nonce: "n",
        platform: " MentraOS ",
        deviceFamily: "Glasses",
      }),
    ).toBe("v3|d|openclaw-mentra-node|ui|operator|operator.read,operator.write|1700000000000|t|n|mentraos|glasses")
  })

  it("renders a missing token as an empty field", () => {
    const payload = buildDeviceAuthPayloadV3({
      deviceId: "d",
      clientId: "openclaw-mentra-node",
      clientMode: "ui",
      role: "operator",
      scopes: ["operator.read"],
      signedAtMs: 1,
      nonce: "n",
    })
    expect(payload.endsWith("|n||")).toBe(true)
  })
})

describe("identity", () => {
  it("derives deviceId from the sha256 of the raw public key", async () => {
    const identity = await loadOrCreateIdentity(memoryStore())
    expect(identity.deviceId).toBe(sha256Hex(base64UrlDecode(identity.publicKeyB64u)))
  })

  it("reuses the stored identity instead of minting a new one", async () => {
    const store = memoryStore()
    const first = await loadOrCreateIdentity(store)
    const second = await loadOrCreateIdentity(store)
    expect(second).toEqual(first)
  })

  it("signs payloads that verify against the public key", async () => {
    const identity = await loadOrCreateIdentity(memoryStore())
    const payload =
      "v3|d|openclaw-mentra-node|ui|operator|operator.read,operator.write|1700000000000|t|n|mentraos|glasses"
    const message = new TextEncoder().encode(payload)
    const signature = base64UrlDecode(await signPayload(identity, payload))
    const publicKey = base64UrlDecode(identity.publicKeyB64u)
    await expect(ed25519.verifyAsync(signature, message, publicKey)).resolves.toBe(true)
    const tampered = new TextEncoder().encode(`${payload}x`)
    await expect(ed25519.verifyAsync(signature, tampered, publicKey)).resolves.toBe(false)
  })
})

describe("identity recovery from a corrupt stored record", () => {
  it("regenerates the identity when the stored record is corrupt JSON", async () => {
    const store = memoryStore()
    await store.set(IDENTITY_STORAGE_KEY, "{oops")
    const identity = await loadOrCreateIdentity(store)
    expect(identity.deviceId).toBe(sha256Hex(base64UrlDecode(identity.publicKeyB64u)))
    // The fresh identity is persisted for the next load.
    const stored = JSON.parse((await store.get(IDENTITY_STORAGE_KEY))!)
    expect(stored.publicKeyB64u).toBe(identity.publicKeyB64u)
  })

  it("regenerates the identity when the stored record is missing required fields", async () => {
    const store = memoryStore()
    await store.set(IDENTITY_STORAGE_KEY, JSON.stringify({publicKeyB64u: "QUJD", createdAtMs: 5}))
    const identity = await loadOrCreateIdentity(store)
    expect(identity.publicKeyB64u).not.toBe("QUJD")
    expect(identity.privateKeyB64u).toBeTruthy()
    expect(identity.createdAtMs).toBeGreaterThan(5)
  })

  it("repairs a stored record whose deviceId is stale and backfills createdAtMs", async () => {
    const store = memoryStore()
    const original = await loadOrCreateIdentity(store)
    await store.set(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({
        publicKeyB64u: original.publicKeyB64u,
        privateKeyB64u: original.privateKeyB64u,
        deviceId: "stale",
      }),
    )
    const beforeRepairMs = Date.now()
    const repaired = await loadOrCreateIdentity(store)
    // Same key pair, but the fingerprint is recomputed from the public key...
    expect(repaired.publicKeyB64u).toBe(original.publicKeyB64u)
    expect(repaired.deviceId).toBe(original.deviceId)
    // ...the missing createdAtMs is backfilled with the repair time...
    expect(repaired.createdAtMs).toBeGreaterThanOrEqual(beforeRepairMs)
    // ...and the repaired record is written back complete, timestamp included.
    expect(JSON.parse((await store.get(IDENTITY_STORAGE_KEY))!)).toStrictEqual(repaired)
    expect(await loadOrCreateIdentity(store)).toStrictEqual(repaired)
  })

  it("regenerates the identity when the stored keys are not valid base64url", async () => {
    const store = memoryStore()
    await store.set(IDENTITY_STORAGE_KEY, JSON.stringify({deviceId: "d", publicKeyB64u: "!!!", privateKeyB64u: "###"}))
    const identity = await loadOrCreateIdentity(store)
    expect(identity.publicKeyB64u).not.toBe("!!!")
    expect(identity.deviceId).toBe(sha256Hex(base64UrlDecode(identity.publicKeyB64u)))
  })
})
