import {describe, expect, it} from "vitest"

import {base64UrlEncode} from "./encoding"
import {assertSecureGatewayUrl, normalizeGatewayUrl, parseSetupInput} from "./setup-code"

function setupCode(payload: Record<string, unknown>): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
}

describe("parseSetupInput", () => {
  it("parses the base64url setup code from wednesdayai qr", () => {
    expect(parseSetupInput(setupCode({url: "wss://g.example.ts.net", bootstrapToken: "b"}))).toEqual({
      url: "wss://g.example.ts.net",
      bootstrapToken: "b",
    })
  })

  it("parses a QR URL that carries the setup code", () => {
    const code = setupCode({url: "wss://g.example.ts.net", bootstrapToken: "b", expiresAtMs: Date.now() + 60_000})
    expect(parseSetupInput(`https://relay.example/scan?setupCode=${code}`)).toEqual({
      url: "wss://g.example.ts.net",
      bootstrapToken: "b",
    })
  })

  it("rejects plain ws:// LAN addresses", () => {
    expect(() => parseSetupInput(setupCode({url: "ws://192.168.1.5:18789", bootstrapToken: "b"}))).toThrow(
      "Insecure gateway URL. Use Tailscale Serve (wss://) or the tailnet IP.",
    )
  })

  it("accepts ws:// addresses in the Tailscale CGNAT range", () => {
    expect(parseSetupInput(setupCode({url: "ws://100.101.102.103:18789", bootstrapToken: "b"}))).toEqual({
      url: "ws://100.101.102.103:18789",
      bootstrapToken: "b",
    })
  })

  it("accepts ws:// loopback addresses", () => {
    expect(parseSetupInput(setupCode({url: "ws://localhost:18789", bootstrapToken: "b"})).url).toBe(
      "ws://localhost:18789",
    )
  })

  it("rejects expired setup codes", () => {
    expect(() =>
      parseSetupInput(setupCode({url: "wss://g.example.ts.net", bootstrapToken: "b", expiresAtMs: Date.now() - 1})),
    ).toThrow("Setup code expired. Generate a new one.")
  })

  it("requires a bootstrap token", () => {
    expect(() => parseSetupInput(setupCode({url: "wss://g.example.ts.net"}))).toThrow(
      "Setup code has no bootstrap token. Run: wednesdayai qr --client openclaw-mentra-node",
    )
  })

  it("rejects unrecognised input", () => {
    expect(() => parseSetupInput("not a setup code")).toThrow("Unrecognised setup code")
    expect(() => parseSetupInput("")).toThrow("Unrecognised setup code")
  })
})

describe("assertSecureGatewayUrl", () => {
  it("accepts wss:// anywhere", () => {
    expect(() => assertSecureGatewayUrl("wss://g.example.ts.net")).not.toThrow()
  })

  it("rejects plain ws:// to a non-local host", () => {
    expect(() => assertSecureGatewayUrl("ws://g.example.ts.net")).toThrow(
      "Insecure gateway URL. Use Tailscale Serve (wss://) or the tailnet IP.",
    )
  })

  it("rejects non-ws schemes", () => {
    expect(() => assertSecureGatewayUrl("http://localhost")).toThrow(
      "Insecure gateway URL. Use Tailscale Serve (wss://) or the tailnet IP.",
    )
  })

  it("judges the host the socket will dial, not userinfo, backslash or look-alike tricks", () => {
    const insecure = "Insecure gateway URL. Use Tailscale Serve (wss://) or the tailnet IP."
    expect(() => assertSecureGatewayUrl("ws://100.64.0.1@evil.example:18789")).toThrow(insecure)
    expect(() => assertSecureGatewayUrl("ws://evil.example\\@127.0.0.1/")).toThrow(insecure)
    expect(() => assertSecureGatewayUrl("ws://127.0.0.1.evil.example")).toThrow(insecure)
    expect(() => assertSecureGatewayUrl("ws://127.0.0.1%2eevil.example")).toThrow(insecure)
    expect(() => assertSecureGatewayUrl("ws://[::1]:18789")).not.toThrow()
  })
})

describe("normalizeGatewayUrl", () => {
  it("lowercases scheme and host and strips trailing slashes", () => {
    expect(normalizeGatewayUrl("WSS://Gw.Example.ts.net:18789/")).toBe("wss://gw.example.ts.net:18789")
  })
})
