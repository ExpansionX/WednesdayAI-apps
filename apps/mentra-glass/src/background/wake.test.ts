import {describe, expect, it} from "vitest"

import {findWake, matchWake, normalizeSpeech, WakeTracker} from "./wake"

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

  it("does not drop the word after fused punctuation", () => {
    // "Hey,Wednesday," collapses to two normalized tokens, but the query must
    // be cut from the original text, keeping "what".
    expect(matchWake("Hey,Wednesday, what time is it?", TRIGGERS)).toEqual({
      query: "what time is it?",
    })
  })

  it("slices the query at token end offsets, not whitespace words", () => {
    // "wednesday-prime" is one whitespace word but two matched tokens; the
    // query starts right after the token "prime".
    expect(matchWake("wednesday-prime status", ["wednesday prime"])).toEqual({query: "status"})
  })

  it("matches triggers whose lowercase form gains combining marks", () => {
    // "İ".toLowerCase() is "i" + U+0307; trigger and transcript must normalize alike.
    expect(matchWake("Hey İris, lights on", ["İris"])).toEqual({query: "lights on"})
  })

  it("matches Greek triggers regardless of final-sigma casing context", () => {
    expect(matchWake("ΟΣ:Α lights on", ["ΟΣ:Α"])).toEqual({query: "lights on"})
    expect(matchWake("Hey ΟΣ:Α lights on", ["οσ:α"])).toEqual({query: "lights on"})
    expect(matchWake("Hey ΟΣ.Α lights on", ["ος α"])).toEqual({query: "lights on"})
  })

  it("treats non-ASCII punctuation after the trigger as an empty query", () => {
    expect(matchWake("Hey Wednesday…", TRIGGERS)).toEqual({query: ""})
    expect(matchWake("Hey Wednesday， what time is it", TRIGGERS)).toEqual({query: "what time is it"})
  })

  it("ignores an empty trigger instead of matching everything", () => {
    // An empty trigger would otherwise match at index 0 with nothing
    // consumed, crashing the query slice on a missing token.
    expect(matchWake("hey there", [""])).toBeNull()
    expect(matchWake("wednesday hello", ["", "wednesday"])).toEqual({query: "hello"})
  })

  it("does not treat a bare greeting as a wake word", () => {
    expect(matchWake("hey", TRIGGERS)).toBeNull()
    expect(matchWake("hello", TRIGGERS)).toBeNull()
  })

  it("does not match when the utterance is shorter than the trigger phrase", () => {
    expect(matchWake("hey", ["hey wednesday"])).toBeNull()
    expect(matchWake("hey computer", ["hey computer go"])).toBeNull()
  })
})

describe("findWake", () => {
  it("finds the trigger after filler words and returns the rest as the query", () => {
    expect(findWake("so anyway hey wednesday what time is it", ["wednesday"])).toEqual({
      query: "what time is it",
    })
  })

  it("returns null when no trigger appears anywhere", () => {
    expect(findWake("nothing here", ["wednesday"])).toBeNull()
  })

  it("prefers the longest trigger at the earliest match position", () => {
    expect(findWake("ok wednesday prime go", ["wednesday", "wednesday prime"])).toEqual({query: "go"})
  })

  it("returns null for an empty or punctuation-only transcript", () => {
    expect(findWake("", TRIGGERS)).toBeNull()
    expect(findWake("?! ... ?", TRIGGERS)).toBeNull()
  })

  it("ignores triggers with no word characters", () => {
    expect(findWake("hey there", ["!!!", ""])).toBeNull()
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

  it("keeps waiting when an empty final transcript lands during the await window", () => {
    const {tracker} = trackerWithClock()
    expect(tracker.onTranscript({text: "hey wednesday", isFinal: true})).toEqual({
      type: "listening",
    })
    // An STT glitch delivers an empty final; it must neither send nor cancel.
    expect(tracker.onTranscript({text: "   ", isFinal: true})).toEqual({type: "none"})
    expect(tracker.onTranscript({text: "set a timer", isFinal: true})).toEqual({
      type: "send",
      query: "set a timer",
    })
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
