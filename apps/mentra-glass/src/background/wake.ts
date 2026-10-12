/**
 * Wake-word matching over MentraOS speech-to-text transcripts.
 *
 * Pure logic — no @mentra imports — so it is unit-testable with vitest and
 * portable across the background JSContext runtimes (iOS-JSC / QuickJS).
 *
 * Speech arrives as interim (partial) and final transcripts. A wake phrase is
 * an optional greeting ("hey", "ok", …) followed by one of the configured
 * trigger phrases; everything after the trigger is the query. When only the
 * wake word was heard, the tracker waits (awaiting) for the next transcript
 * to arrive as the query.
 */

export const WAKE_GREETINGS = ["hey", "hi", "ok", "okay", "hello"]

export type WakeAction = {type: "none"} | {type: "listening"} | {type: "send"; query: string} | {type: "cancel"}

export interface WakeTranscript {
  text: string
  isFinal: boolean
}

export interface WakeTrackerOptions {
  /** Injectable clock for duplicate-send suppression. Defaults to Date.now. */
  now?: () => number
}

/** A repeated identical query inside this window is a double-fire, not a new ask. */
const DUPLICATE_QUERY_WINDOW_MS = 1500

/**
 * Lowercase, replace punctuation (keeping letters, numbers, whitespace and
 * intra-word apostrophes) with spaces, collapse whitespace, trim.
 */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Find a trigger phrase at the start of `text` (optionally after one
 * greeting word) and return the remaining query. Longer triggers win, so
 * "wednesday prime" beats "wednesday" when both are configured. Returns
 * null when no trigger matches.
 */
export function matchWake(text: string, triggers: string[]): {query: string} | null {
  const normalized = normalizeSpeech(text)
  if (!normalized) return null
  const tokens = normalized.split(" ")
  const words = text.trim().split(/\s+/)

  // Tokenize once, longest trigger first so "wednesday prime" wins over "wednesday".
  const tokenized = triggers
    .map((trigger) => normalizeSpeech(trigger).split(" ").filter(Boolean))
    .sort((a, b) => b.length - a.length)
  for (const triggerTokens of tokenized) {
    if (triggerTokens.length === 0) continue

    let start = -1
    if (startsWithAt(tokens, triggerTokens, 0)) {
      start = 0
    } else if (tokens.length > 1 && WAKE_GREETINGS.includes(tokens[0]) && startsWithAt(tokens, triggerTokens, 1)) {
      start = 1
    }
    if (start < 0) continue

    const consumed = start + triggerTokens.length
    const query = words
      .slice(consumed)
      .join(" ")
      .replace(/^[\s,.:;!?-]+/, "")
    return {query}
  }
  return null
}

function startsWithAt(tokens: string[], prefix: string[], at: number): boolean {
  if (tokens.length - at < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (tokens[at + i] !== prefix[i]) return false
  }
  return true
}

/**
 * Tracks wake state across interim and final transcripts of one session.
 *
 * - Interim: while idle, an initial match emits "listening" once per
 *   utterance so the glasses can show the listening frame early.
 * - Final: a match with a query sends it; a bare wake word enters the
 *   awaiting state; the next non-matching final transcript is the query.
 *   A non-matching final right after an interim "listening" cancels instead
 *   (the user changed their mind mid-sentence).
 */
export class WakeTracker {
  private triggers: string[] = []
  private readonly now: () => number
  private awaiting = false
  private interimMatched = false
  private freshUtterance = true
  private lastSentQuery: string | null = null
  private lastSentAtMs = -Infinity

  constructor({now = Date.now}: WakeTrackerOptions = {}) {
    this.now = now
  }

  setTriggers(triggers: string[]): void {
    this.triggers = [...triggers]
  }

  /** Drop the awaiting state — used when the listening window expires. */
  cancelAwait(): void {
    this.awaiting = false
    this.interimMatched = false
    this.freshUtterance = true
  }

  onTranscript({text, isFinal}: WakeTranscript): WakeAction {
    if (this.freshUtterance) {
      this.interimMatched = false
      this.freshUtterance = false
    }
    if (isFinal) this.freshUtterance = true

    const trimmed = text.trim()
    const match = matchWake(text, this.triggers)

    if (!isFinal) {
      if (match && !this.awaiting && !this.interimMatched) {
        this.interimMatched = true
        return {type: "listening"}
      }
      return {type: "none"}
    }

    if (match) {
      this.awaiting = false
      this.interimMatched = false
      if (match.query) {
        return this.emitSend(match.query)
      }
      this.awaiting = true
      return {type: "listening"}
    }

    if (this.awaiting) {
      if (!trimmed) return {type: "none"}
      this.awaiting = false
      this.interimMatched = false
      return this.emitSend(trimmed)
    }
    if (this.interimMatched) {
      this.interimMatched = false
      return {type: "cancel"}
    }
    return {type: "none"}
  }

  private emitSend(query: string): WakeAction {
    const atMs = this.now()
    if (query === this.lastSentQuery && atMs - this.lastSentAtMs < DUPLICATE_QUERY_WINDOW_MS) {
      return {type: "none"}
    }
    this.lastSentQuery = query
    this.lastSentAtMs = atMs
    return {type: "send", query}
  }
}
