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

  it("extracts the setup code from every supported QR query parameter", () => {
    const code = setupCode({url: "wss://g.example.ts.net", bootstrapToken: "b"})
    for (const key of ["setupCode", "gatewayUrl", "relayUrl", "relay"]) {
      expect(parseSetupInput(`https://relay.example/pair?${key}=${code}`)).toEqual({
        url: "wss://g.example.ts.net",
        bootstrapToken: "b",
      })
    }
  })

  it("finds the setup code param beside other params and a fragment", () => {
    const code = setupCode({url: "wss://g.example.ts.net", bootstrapToken: "b"})
    expect(parseSetupInput(`https://relay.example/pair?src=app&setupCode=${code}#pairing`)).toEqual({
      url: "wss://g.example.ts.net",
      bootstrapToken: "b",
    })
  })

  it("decodes percent-escaped setup codes and trims scanner noise", () => {
    const code = setupCode({url: "wss://g.example.ts.net", bootstrapToken: "b"})
    // encodeURIComponent is a no-op over the base64url alphabet, so escape the
    // first character by hand: a parser that skips percent-decoding must fail.
    const escaped = `%${code.charCodeAt(0).toString(16)}${code.slice(1)}`
    expect(parseSetupInput(`https://relay.example/pair?setupCode=${escaped}`)).toEqual({
      url: "wss://g.example.ts.net",
      bootstrapToken: "b",
    })
    expect(parseSetupInput(`\n  ${code}  \n`)).toEqual({url: "wss://g.example.ts.net", bootstrapToken: "b"})
  })

  it("round-trips non-ASCII bootstrap tokens through the manual UTF-8 decoder", () => {
    // é is a 2-byte, 中 a 3-byte and 🙂 a 4-byte UTF-8 sequence (surrogate pair).
    const token = "café-中-🙂"
    expect(parseSetupInput(setupCode({url: "wss://g.example.ts.net", bootstrapToken: token}))).toEqual({
      url: "wss://g.example.ts.net",
      bootstrapToken: token,
    })
  })

  it("treats an unreadable setupCode parameter as unrecognised input", () => {
    expect(() => parseSetupInput("https://relay.example/pair?setupCode=%zz")).toThrow("Unrecognised setup code")
  })

  it("asks for a fresh code when the QR carries a gateway URL but no setup code", () => {
    const message = "Setup code has no bootstrap token. Run: wednesdayai qr --client openclaw-mentra-node"
    // A bare ws/wss gateway URL is recognised as a URL, but carries no token.
    expect(() => parseSetupInput("wss://g.example.ts.net:18789/")).toThrow(message)
    // Any other URL without a setup-code param is not a setup code at all.
    expect(() => parseSetupInput("https://relay.example/pair?foo=bar")).toThrow("Unrecognised setup code")
  })

  it("rejects malformed base64 and non-object payloads as unrecognised", () => {
    const rawCode = (text: string): string => base64UrlEncode(new TextEncoder().encode(text))
    expect(() => parseSetupInput("not@@base64")).toThrow("Unrecognised setup code")
    expect(() => parseSetupInput(rawCode("[]"))).toThrow("Unrecognised setup code")
    expect(() => parseSetupInput(rawCode('{"url":5,"bootstrapToken":"b"}'))).toThrow("Unrecognised setup code")
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
    // A bracketed host must be a well-formed IPv6 literal; trailing text would
    // make the validated host differ from what a native stack dials (or rejects).
    expect(() => assertSecureGatewayUrl("ws://[::1")).toThrow(insecure)
    expect(() => assertSecureGatewayUrl("ws://[::1]evil.example")).toThrow(insecure)
    expect(() => assertSecureGatewayUrl("ws://[::1]:18789:1")).toThrow(insecure)
  })

  it("accepts ws:// loopback and the exact Tailscale CGNAT boundaries", () => {
    expect(() => assertSecureGatewayUrl("ws://localhost:18789")).not.toThrow()
    expect(() => assertSecureGatewayUrl("ws://127.0.0.1:18789")).not.toThrow()
    expect(() => assertSecureGatewayUrl("ws://100.64.0.0:18789")).not.toThrow()
    expect(() => assertSecureGatewayUrl("ws://100.127.255.255:18789")).not.toThrow()
  })

  it("rejects ws:// hosts just outside the Tailscale CGNAT range or malformed", () => {
    const insecure = "Insecure gateway URL. Use Tailscale Serve (wss://) or the tailnet IP."
    expect(() => assertSecureGatewayUrl("ws://100.63.255.255")).toThrow(insecure)
    expect(() => assertSecureGatewayUrl("ws://100.128.0.0")).toThrow(insecure)
    expect(() => assertSecureGatewayUrl("ws://100.64.0")).toThrow(insecure)
    expect(() => assertSecureGatewayUrl("ws://100.64.0.256")).toThrow(insecure)
  })
})

describe("normalizeGatewayUrl", () => {
  it("lowercases scheme and host and strips trailing slashes", () => {
    expect(normalizeGatewayUrl("WSS://Gw.Example.ts.net:18789/")).toBe("wss://gw.example.ts.net:18789")
  })

  it("leaves opaque scheme-less strings alone apart from trailing slashes", () => {
    expect(normalizeGatewayUrl("host.example:18789/")).toBe("host.example:18789")
  })
})
