import {describe, expect, it} from "vitest"

import {concatBase64} from "./encoding"

describe("concatBase64", () => {
  it("decodes to the concatenated bytes of every chunk", () => {
    const first = btoa(String.fromCharCode(1, 2, 3))
    const second = btoa(String.fromCharCode(4, 5))
    const joined = [...atob(concatBase64([first, second]))].map((char) => char.charCodeAt(0))
    expect(joined).toEqual([1, 2, 3, 4, 5])
  })

  it("returns an empty string for no chunks", () => {
    expect(concatBase64([])).toBe("")
  })
})
