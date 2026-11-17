import {describe, expect, it} from "vitest"

import {
  GATEWAY_MIN_NODE_PROTOCOL_VERSION,
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  minimumProtocolVersion,
} from "./constants"

// Role-aware client bounds (plan protocol-v4 §6 P2): the glasses miniapp advertises [3, 4]
// independent of the server admission floors; the P4 window later raises the minimum.
describe("gateway protocol constants", () => {
  it("advertise the client range [3, 4]", () => {
    expect(GATEWAY_PROTOCOL_VERSION).toBe(4)
    expect(GATEWAY_MIN_PROTOCOL_VERSION).toBe(3)
    expect(GATEWAY_MIN_NODE_PROTOCOL_VERSION).toBe(3)
    expect(GATEWAY_MIN_PROTOCOL_VERSION).toBeLessThanOrEqual(GATEWAY_PROTOCOL_VERSION)
  })

  it("map the socket role onto the role-aware minimum", () => {
    // Compare against the constants, not literals: when the P4 window splits the two
    // minimums, this still pins node-role sockets to the node floor.
    expect(minimumProtocolVersion("node", "node")).toBe(GATEWAY_MIN_NODE_PROTOCOL_VERSION)
    expect(minimumProtocolVersion("operator", "ui")).toBe(GATEWAY_MIN_PROTOCOL_VERSION)
    expect(minimumProtocolVersion("Node ", "node")).toBe(GATEWAY_MIN_NODE_PROTOCOL_VERSION)
  })
})
