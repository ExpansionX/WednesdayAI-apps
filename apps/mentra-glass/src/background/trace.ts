/**
 * Dev trace of the assistant's inputs and outputs: transcripts heard, wake
 * decisions, the gateway transcript, `chat.send` requests and replies, and
 * the frames painted on the glasses.
 *
 * Lines go to `console.log`, which `mentra-miniapp dev` forwards from the
 * phone to the laptop terminal. Off unless the bundle is built with
 * `MENTRA_PUBLIC_TRACE=1` (build.ts inlines it), so transcripts and answers
 * never reach the console of a normal build.
 */

declare const process: {env: {MENTRA_PUBLIC_TRACE?: string}}

const TRACE_ENABLED = process.env.MENTRA_PUBLIC_TRACE === "1"

export function trace(event: string, data: Record<string, unknown>): void {
  if (!TRACE_ENABLED) return
  console.log(`[trace] ${event} ${JSON.stringify(data)}`)
}
