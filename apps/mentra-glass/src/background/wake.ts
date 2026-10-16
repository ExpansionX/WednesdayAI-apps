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

const WAKE_GREETINGS = ["hey", "hi", "ok", "okay", "hello"]

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
 * Lowercase, fold final sigma (its form depends on casing context, so "ΟΣ"
 * and "ος" must compare equal), replace punctuation (keeping letters, numbers,
 * whitespace and intra-word apostrophes) with spaces, collapse whitespace, trim.
 */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/ς/g, "σ")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** A word token from the original transcript, lowercased for matching. */
interface SourceToken {
  token: string
  /** Offset in the original text just past this token's last character. */
  end: number
}

/** Word characters: exactly the classes `normalizeSpeech` keeps (letters,
 * numbers, intra-word apostrophes); every other rune separates tokens. */
const WORD_TOKEN_RE = /[\p{L}\p{N}']+/gu

/** Tokenize the original text, keeping each token's end offset so the query
 * can be sliced from the original, not the punctuation-collapsed, text. Each
 * source word goes through `normalizeSpeech`, exactly like the triggers, so
 * case folding that adds combining marks ("İ" → "i̇") splits identically. */
function tokenizeWithEndOffsets(text: string): SourceToken[] {
  const tokens: SourceToken[] = []
  for (const match of text.matchAll(WORD_TOKEN_RE)) {
    const end = match.index + match[0].length
    for (const token of normalizeSpeech(match[0]).split(" ")) {
      if (token) tokens.push({token, end})
    }
  }
  return tokens
}

/**
 * Find a trigger phrase at the start of `text` (optionally after one
 * greeting word) and return the remaining query. Matching runs on the
 * normalized tokens; the query is cut from the original text right after
 * the last matched token, so punctuation and spacing survive. Longer
 * triggers win, so "wednesday prime" beats "wednesday" when both are
 * configured. A trigger word heard split in two or three ("open claw" for
 * "openclaw") still matches. Returns null when no trigger matches.
 */
export function matchWake(text: string, triggers: string[]): {query: string} | null {
  const tokens = tokenizeWithEndOffsets(text)
  const end = leadingWakeEnd(tokens, triggers)
  return end < 0 ? null : {query: queryAfterToken(tokens, text, end)}
}

/** Token index just past a trigger at the start of `tokens` (optionally
 * after one greeting word), or -1. */
function leadingWakeEnd(tokens: SourceToken[], triggers: string[]): number {
  if (tokens.length === 0) return -1
  const tokenized = tokenizeTriggers(triggers)
  const consumed = longestMatchAt(tokens, tokenized, 0)
  if (consumed >= 0) return consumed
  if (tokens.length < 2 || !WAKE_GREETINGS.includes(tokens[0].token)) return -1
  const afterGreeting = longestMatchAt(tokens, tokenized, 1)
  return afterGreeting < 0 ? -1 : 1 + afterGreeting
}

/** True when `text` starts with a wake phrase set off by punctuation
 * ("Wednesday, what time"): a spoken address, not the start of a phrase
 * such as "computer science". */
export function leadsWithPunctuatedWake(text: string, triggers: string[]): boolean {
  const tokens = tokenizeWithEndOffsets(text)
  const end = leadingWakeEnd(tokens, triggers)
  return end >= 0 && /^\s*\p{P}/u.test(text.slice(tokens[end - 1].end))
}

/** Triggers through the transcript tokenizer, so casing context matches exactly. */
function tokenizeTriggers(triggers: string[]): string[][] {
  return triggers
    .map((trigger) => tokenizeWithEndOffsets(trigger).map(({token}) => token))
    .filter((tokens) => tokens.length > 0)
}

/** The most transcript tokens any trigger consumes at `at`, or -1. The
 * longest span wins, so "wednesday prime" beats "wednesday" however the
 * transcript split them. */
function longestMatchAt(tokens: SourceToken[], triggers: string[][], at: number): number {
  let best = -1
  for (const trigger of triggers) best = Math.max(best, matchedLengthAt(tokens, trigger, at))
  return best
}

/** Cut the query from the original text right after the last matched token,
 * dropping the leading run of whitespace and punctuation. */
function queryAfterToken(tokens: SourceToken[], text: string, consumed: number): string {
  return text.slice(tokens[consumed - 1].end).replace(/^[\s\p{P}]+/u, "")
}

/**
 * Like `matchWake`, but the trigger may start at any token, not just the
 * first (or after one greeting). The earliest start position wins; at that
 * position the longest span wins. Returns null when no trigger matches.
 */
export function findWake(text: string, triggers: string[]): {query: string} | null {
  const tokens = tokenizeWithEndOffsets(text)
  const tokenized = tokenizeTriggers(triggers)
  for (let start = 0; start < tokens.length; start++) {
    const consumed = longestMatchAt(tokens, tokenized, start)
    if (consumed >= 0) return {query: queryAfterToken(tokens, text, start + consumed)}
  }
  return null
}

/** Strip wake phrases (with optional greeting) from the start of `query`:
 * a transcript spanning a bare wake word and the retry ("computer?
 * computer, what time is it") repeats it. Each match consumes at least one
 * token, so the loop terminates. */
export function dropLeadingWakes(query: string, triggers: string[]): string {
  let rest = query
  for (let again = matchWake(rest, triggers); again; again = matchWake(rest, triggers)) rest = again.query
  return rest
}

/** Speech-to-text may split one trigger word ("openclaw" heard as "open claw"). */
const MAX_SPLIT_PARTS = 3

/**
 * Match the trigger tokens at `at`, each one either as a single transcript
 * token or as up to MAX_SPLIT_PARTS consecutive tokens that join to it.
 * Returns the number of transcript tokens consumed, or -1.
 */
function matchedLengthAt(tokens: SourceToken[], trigger: string[], at: number): number {
  let pos = at
  for (const part of trigger) {
    let joined = ""
    let parts = 0
    while (parts < MAX_SPLIT_PARTS && pos + parts < tokens.length && joined.length < part.length) {
      joined += tokens[pos + parts].token
      parts += 1
    }
    if (joined !== part) return -1
    pos += parts
  }
  return pos - at
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
