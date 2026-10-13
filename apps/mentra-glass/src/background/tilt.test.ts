import {describe, expect, it} from "vitest"

import {PITCH_SIGN, pitchDegrees, TiltDetector, TILT_DOWN_DEG, TILT_HOLD_MS, TILT_UP_DEG} from "./tilt"

/** Sample pitched `deg` above level, at time `ts`. */
function sample(deg: number, ts: number) {
  const rad = (deg * Math.PI) / 180
  return {x: 0, y: Math.sin(rad), z: Math.cos(rad), timestamp: ts}
}

describe("pitchDegrees", () => {
  it("converts a tilted sample to degrees", () => {
    expect(pitchDegrees(sample(30, 0))).toBeCloseTo(30, 5)
  })
})

describe("TiltDetector", () => {
  it("uses the documented defaults", () => {
    expect(TILT_UP_DEG).toBe(25)
    expect(TILT_DOWN_DEG).toBe(15)
    expect(TILT_HOLD_MS).toBe(300)
    expect(PITCH_SIGN).toBe(1)
  })

  it("emits up once after the hold", () => {
    const d = new TiltDetector()
    expect(d.onSample(sample(30, 0))).toBeNull()
    expect(d.onSample(sample(30, 100))).toBeNull()
    expect(d.onSample(sample(30, 200))).toBeNull()
    expect(d.onSample(sample(30, 300))).toBe("up")
    expect(d.onSample(sample(30, 400))).toBeNull()
  })

  it("emits down after the hold below the down threshold", () => {
    const d = new TiltDetector()
    expect(d.onSample(sample(30, 0))).toBeNull()
    expect(d.onSample(sample(30, 300))).toBe("up")
    expect(d.onSample(sample(20, 400))).toBeNull()
    expect(d.onSample(sample(10, 500))).toBeNull()
    expect(d.onSample(sample(10, 600))).toBeNull()
    expect(d.onSample(sample(10, 700))).toBeNull()
    expect(d.onSample(sample(10, 800))).toBe("down")
  })

  it("restarts the hold when the pitch dips below the up threshold", () => {
    const d = new TiltDetector()
    expect(d.onSample(sample(30, 0))).toBeNull()
    expect(d.onSample(sample(30, 100))).toBeNull()
    expect(d.onSample(sample(20, 200))).toBeNull()
    expect(d.onSample(sample(30, 300))).toBeNull()
    expect(d.onSample(sample(30, 400))).toBeNull()
    expect(d.onSample(sample(30, 500))).toBeNull()
    expect(d.onSample(sample(30, 600))).toBe("up")
  })

  it("ignores non-finite samples without resetting", () => {
    const d = new TiltDetector()
    expect(d.onSample(sample(30, 0))).toBeNull()
    expect(d.onSample({x: NaN, y: 0, z: 1, timestamp: 100})).toBeNull()
    expect(d.onSample(sample(30, 300))).toBe("up")
  })

  it("reset clears the tilt state", () => {
    const d = new TiltDetector()
    expect(d.onSample(sample(30, 0))).toBeNull()
    d.reset()
    expect(d.onSample(sample(30, 100))).toBeNull()
    expect(d.onSample(sample(30, 400))).toBe("up")
  })

  it("accepts custom thresholds", () => {
    const d = new TiltDetector({upDeg: 10, holdMs: 50})
    expect(d.onSample(sample(15, 0))).toBeNull()
    expect(d.onSample(sample(15, 50))).toBe("up")
  })
})
