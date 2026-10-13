/**
 * Head-tilt detection from accelerometer samples: a held pitch above
 * TILT_UP_DEG fires "up", a held pitch at or below TILT_DOWN_DEG fires "down".
 */
import type {AccelData} from "@mentra/miniapp/background"

export const TILT_UP_DEG = 25
export const TILT_DOWN_DEG = 15
export const TILT_HOLD_MS = 300
/** Flip to -1 if device check V2 shows the glance firing on head-down. */
export const PITCH_SIGN = 1

export function pitchDegrees(sample: {x: number; y: number; z: number}): number {
  return (PITCH_SIGN * Math.atan2(sample.y, Math.sqrt(sample.x * sample.x + sample.z * sample.z)) * 180) / Math.PI
}

export type TiltEvent = "up" | "down"

export interface TiltDetectorOptions {
  upDeg?: number
  downDeg?: number
  holdMs?: number
}

export class TiltDetector {
  private readonly upDeg: number
  private readonly downDeg: number
  private readonly holdMs: number
  private up = false
  private candidateSince: number | null = null
  /** Last accepted sample timestamp; a lower one means the clock stepped back. */
  private lastTimestamp: number | null = null

  constructor(options: TiltDetectorOptions = {}) {
    this.upDeg = options.upDeg ?? TILT_UP_DEG
    this.downDeg = options.downDeg ?? TILT_DOWN_DEG
    this.holdMs = options.holdMs ?? TILT_HOLD_MS
  }

  onSample(sample: AccelData): TiltEvent | null {
    const {x, y, z, timestamp} = sample
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(timestamp)) {
      return null
    }
    // A backwards clock step restarts the hold in the new time domain.
    const steppedBack = this.lastTimestamp !== null && timestamp < this.lastTimestamp
    this.lastTimestamp = timestamp

    if (!this.up) {
      if (pitchDegrees(sample) >= this.upDeg) {
        if (steppedBack) this.candidateSince = timestamp
        else this.candidateSince ??= timestamp
        if (timestamp - this.candidateSince >= this.holdMs) {
          this.up = true
          this.candidateSince = null
          return "up"
        }
      } else {
        this.candidateSince = null
      }
      return null
    }

    if (pitchDegrees(sample) <= this.downDeg) {
      if (steppedBack) this.candidateSince = timestamp
      else this.candidateSince ??= timestamp
      if (timestamp - this.candidateSince >= this.holdMs) {
        this.up = false
        this.candidateSince = null
        return "down"
      }
    } else {
      this.candidateSince = null
    }
    return null
  }

  reset(): void {
    this.up = false
    this.candidateSince = null
    this.lastTimestamp = null
  }
}
