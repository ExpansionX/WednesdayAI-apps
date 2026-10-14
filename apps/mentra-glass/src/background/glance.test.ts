import {describe, expect, it} from "vitest"

import {glanceBody} from "./glance"

const NOW = new Date(2026, 9, 13, 9, 5)

describe("glanceBody", () => {
  it("shows the time and the connected status", () => {
    expect(glanceBody(NOW, "connected", 0)).toBe("09:05\nReady")
  })

  it("shows a singular count line when offline", () => {
    expect(glanceBody(NOW, "offline", 1)).toBe("09:05\nOffline\n1 notification")
  })

  it("shows a plural count line when unpaired", () => {
    expect(glanceBody(NOW, "unpaired", 3)).toBe("09:05\nNot paired\n3 notifications")
  })

  it("labels every connection state", () => {
    expect(glanceBody(NOW, "connecting", 0)).toBe("09:05\nConnecting…")
    expect(glanceBody(NOW, "repair_required", 0)).toBe("09:05\nPairing needs repair")
  })
})
