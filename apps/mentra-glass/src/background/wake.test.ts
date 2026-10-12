import {describe, expect, it} from "vitest"

import {matchWake, normalizeSpeech, WakeTracker, WAKE_GREETINGS} from "./wake"

const TRIGGERS = ["wednesday", "computer"]

/** Tracker with an injectable clock so duplicate suppression can be exercised. */
function trackerWithClock() {
  let nowMs = 0
  const tracker = new WakeTracker({now: () => nowMs})
  tracker.setTriggers(TRIGGERS)
  return {
    tracker,
    advance(ms: number) {
      nowMs += ms
    },
  }
}

describe("normalizeSpeech", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeSpeech("  Hey,   Wednesday!  ")).toBe("hey wednesday")
  })

  it("keeps apostrophes inside words", () => {
    expect(normalizeSpeech("What's the time?")).toBe("what's the time")
  })
})

describe("matchWake", () => {
  it("matches a trigger after a greeting and returns the remaining query", () => {
    expect(matchWake("Hey, Wednesday, what's the time?", TRIGGERS)).toEqual({
      query: "what's the time?",
    })
  })

  it("matches a trigger directly with no greeting", () => {
    expect(matchWake("Computer, set a timer", TRIGGERS)).toEqual({query: "set a timer"})
  })

  it("ignores text where the trigger is not the first word", () => {
    expect(matchWake("what day is wednesday", TRIGGERS)).toBeNull()
  })

  it("returns an empty query when only the wake word was spoken", () => {
    expect(matchWake("hey wednesday", TRIGGERS)).toEqual({query: ""})
  })

  it("does not skip two words before the trigger", () => {
    expect(matchWake("um wednesday timer", TRIGGERS)).toBeNull()
  })

  it("tries longer triggers first", () => {
    expect(matchWake("wednesday prime status", ["wednesday", "wednesday prime"])).toEqual({
      query: "status",
    })
  })

  it("exposes the greeting word list used for the one-word skip", () => {
    expect(WAKE_GREETINGS).toContain("okay")
  })
})

describe("WakeTracker", () => {
  it("sends the query when a final transcript carries the full phrase", () => {
    const {tracker} = trackerWithClock()
    expect(tracker.onTranscript({text: "Hey, Wednesday, what's the time?", isFinal: true})).toEqual({
      type: "send",
      query: "what's the time?",
    })
  })

  it("ignores transcripts that merely mention a trigger", () => {
    const {tracker} = trackerWithClock()
    expect(tracker.onTranscript({text: "what day is wednesday", isFinal: true})).toEqual({
      type: "none",
    })
  })

  it("waits for the query when the wake word is alone, then sends it", () => {
    const {tracker} = trackerWithClock()
    expect(tracker.onTranscript({text: "Hey Wednesday", isFinal: true})).toEqual({
      type: "listening",
    })
    expect(tracker.onTranscript({text: "set a timer", isFinal: true})).toEqual({
      type: "send",
      query: "set a timer",
    })
  })

  it("emits listening once per interim utterance and cancels when the phrase never arrives", () => {
    const {tracker} = trackerWithClock()
    expect(tracker.onTranscript({text: "hey wednesday", isFinal: false})).toEqual({
      type: "listening",
    })
    expect(tracker.onTranscript({text: "hey wednesday", isFinal: false})).toEqual({type: "none"})
    expect(tracker.onTranscript({text: "hey wendy", isFinal: true})).toEqual({type: "cancel"})
  })

  it("suppresses a duplicate send within 1500 ms but allows it after", () => {
    const {tracker, advance} = trackerWithClock()
    const phrase = "hey wednesday, what's the time?"
    expect(tracker.onTranscript({text: phrase, isFinal: true})).toEqual({
      type: "send",
      query: "what's the time?",
    })
    advance(1000)
    expect(tracker.onTranscript({text: phrase, isFinal: true})).toEqual({type: "none"})
    advance(1000)
    expect(tracker.onTranscript({text: phrase, isFinal: true})).toEqual({
      type: "send",
      query: "what's the time?",
    })
  })

  it("drops a pending wait when cancelAwait is called", () => {
    const {tracker} = trackerWithClock()
    expect(tracker.onTranscript({text: "hey wednesday", isFinal: true})).toEqual({
      type: "listening",
    })
    tracker.cancelAwait()
    expect(tracker.onTranscript({text: "set a timer", isFinal: true})).toEqual({type: "none"})
  })

  it("still sends a different query inside the duplicate window", () => {
    const {tracker, advance} = trackerWithClock()
    expect(tracker.onTranscript({text: "hey wednesday, what's the time?", isFinal: true})).toEqual({
      type: "send",
      query: "what's the time?",
    })
    advance(500)
    expect(tracker.onTranscript({text: "computer, set a timer", isFinal: true})).toEqual({
      type: "send",
      query: "set a timer",
    })
  })
})
