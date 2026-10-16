import {describe, expect, it} from "vitest"

import {traceDefine} from "./build-flags"

describe("traceDefine", () => {
  it("keeps the flag on in development when MENTRA_PUBLIC_TRACE=1", () => {
    expect(traceDefine({NODE_ENV: "development", MENTRA_PUBLIC_TRACE: "1"})).toBe('"1"')
  })

  it("keeps the flag on when NODE_ENV is unset (plain `npm run build`)", () => {
    expect(traceDefine({MENTRA_PUBLIC_TRACE: "1"})).toBe('"1"')
  })

  it("forces the flag off in production even with MENTRA_PUBLIC_TRACE=1", () => {
    expect(traceDefine({NODE_ENV: "production", MENTRA_PUBLIC_TRACE: "1"})).toBe('""')
  })

  it("forces the flag off when MENTRA_PUBLIC_TRACE is unset", () => {
    expect(traceDefine({NODE_ENV: "development"})).toBe('""')
  })

  it('forces the flag off for a near-miss flag value — the gate is exactly "1"', () => {
    expect(traceDefine({NODE_ENV: "development", MENTRA_PUBLIC_TRACE: "true"})).toBe('""')
  })
})
