/**
 * Device-free smoke test against a real WednesdayAI gateway.
 *
 *   bun run smoke:gateway -- --setup-code <code> [--stt-pcm <file>]
 *
 * Get a code with `wednesdayai qr --client openclaw-mentra-node --setup-code-only`.
 * Pairs with the bootstrap token, reads wake words and agents, sends one chat
 * turn, optionally transcribes a raw PCM file over a gateway talk session
 * (--stt-pcm: PCM16 LE, 16 kHz, mono), then reconnects with the stored device
 * token. Exits 1 on the first failing step.
 */

import manifest from "../miniapp.json"
import {GatewaySttCapture} from "../src/background/gatewayStt"
import {applyChatEvent, bindServerRunId, startRun} from "../src/gateway/chat"
import type {ChatRun} from "../src/gateway/chat"
import {GatewayConnection} from "../src/gateway/connection"
import type {GatewayConnectionOptions} from "../src/gateway/connection"
import {uuidV4} from "../src/gateway/encoding"
import {parseSetupInput} from "../src/gateway/setup-code"
import {resolveSessionKey} from "../src/gateway/sessions"
import type {AgentsInfo} from "../src/gateway/sessions"
import type {ConnectionState, KeyValueStore} from "../src/gateway/types"

const STEP_TIMEOUT_MS = 20_000
const CHAT_TIMEOUT_MS = 120_000
const STT_TIMEOUT_MS = 60_000

const codeIndex = process.argv.indexOf("--setup-code")
const setupCode = codeIndex === -1 ? undefined : process.argv[codeIndex + 1]
if (!setupCode) {
  console.error("usage: bun run smoke:gateway -- --setup-code <code> [--stt-pcm <file>]")
  process.exit(2)
}

const sttPcmIndex = process.argv.indexOf("--stt-pcm")
const sttPcmPath = sttPcmIndex === -1 ? undefined : process.argv[sttPcmIndex + 1]
if (sttPcmIndex !== -1 && !sttPcmPath) {
  console.error("usage: --stt-pcm requires a path to a raw PCM16 LE, 16 kHz, mono file")
  process.exit(2)
}

const memory = new Map<string, string>()
const store: KeyValueStore = {
  get: async (key) => memory.get(key) ?? null,
  set: async (key, value) => void memory.set(key, value),
  delete: async (key) => void memory.delete(key),
}

let step = "parse setup code"

function fail(message: string): never {
  console.error(`FAILED at step "${step}": ${message}`)
  process.exit(1)
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

/** Opens a connection that records the auth kind of each connect frame it sends. */
function openConnection(handlers: Pick<GatewayConnectionOptions, "onEvent">) {
  const connectAuthKinds: string[] = []
  const hello = Promise.withResolvers<{mainSessionKey: string | null}>()
  const connection = new GatewayConnection({
    store,
    clientVersion: manifest.version,
    createWebSocket: (url) => {
      const socket = new WebSocket(url)
      const send = socket.send.bind(socket)
      socket.send = (data) => {
        if (typeof data === "string") {
          const frame = JSON.parse(data) as {method?: string; params?: {auth?: Record<string, unknown>}}
          if (frame.method === "connect") connectAuthKinds.push(Object.keys(frame.params?.auth ?? {}).join(","))
        }
        send(data)
      }
      return socket
    },
    onStateChange: (state: ConnectionState, info) => {
      if (state === "repair_required") hello.reject(new Error(`repair_required: ${info.lastError ?? "unknown"}`))
      if (state === "offline") hello.reject(new Error(`offline: ${info.lastError ?? "socket closed"}`))
    },
    onHello: hello.resolve,
    onEvent: handlers.onEvent,
  })
  return {connection, connected: hello.promise, connectAuthKinds}
}

let run: ChatRun | null = null
const chatDone = Promise.withResolvers<ChatRun>()
let deltaCount = 0
/** Set during the talk-transcription step so talk.event frames reach the capture. */
let talkEventHandler: ((payload: unknown) => void) | null = null

try {
  const setup = parseSetupInput(setupCode)

  step = "pair"
  const first = openConnection({
    onEvent: (event, payload) => {
      if (event === "talk.event" && talkEventHandler) talkEventHandler(payload)
      if (event !== "chat" || !run) return
      const next = applyChatEvent(run, payload)
      if (!next) return
      run = next
      if (next.state === "streaming") console.log(`delta ${++deltaCount} chars=${next.text.length}`)
      if (next.state === "final" || next.state === "error" || next.state === "aborted") chatDone.resolve(next)
    },
  })
  await first.connection.pair(setup)
  const {mainSessionKey} = await withTimeout(first.connected, STEP_TIMEOUT_MS, "hello")
  if (!first.connectAuthKinds[0]?.includes("bootstrapToken"))
    fail(`first connect used auth ${first.connectAuthKinds[0]}`)
  console.log("connected")
  console.log(`mainSessionKey=${mainSessionKey}`)

  step = "voicewake.get"
  const wake = await first.connection.request<{triggers: string[]}>("voicewake.get", {})
  console.log(`triggers=${JSON.stringify(wake.triggers)}`)

  step = "agents.list"
  const agents = await first.connection.request<AgentsInfo>("agents.list", {})
  console.log(`agents=${agents.agents.map((agent) => agent.id).join(",")}`)

  step = "chat.send"
  const idempotencyKey = uuidV4()
  run = startRun(idempotencyKey)
  const sessionKey = resolveSessionKey({agentId: null, agents, mainSessionKey})
  console.log(`sessionKey=${sessionKey}`)
  const sent = await first.connection.request<{runId?: string; status?: string}>("chat.send", {
    sessionKey,
    message: "Reply with exactly: pong",
    idempotencyKey,
  })
  if (sent.runId) bindServerRunId(run, sent.runId)
  const finished = await withTimeout(chatDone.promise, CHAT_TIMEOUT_MS, "chat final/error event")
  if (finished.state === "final") {
    console.log(`final: ${finished.text}`)
    // A gateway without model credentials still finalises with its warning text; that proves
    // routing, not a model reply.
    console.log(`pong=${/\bpong\b/i.test(finished.text) ? "yes" : "no"}`)
  } else if (finished.state === "error") console.log(`error: ${finished.error}`)
  else fail(`run ended ${finished.state}`)

  if (sttPcmPath) {
    step = "talk transcription"
    const pcm = new Uint8Array(await Bun.file(sttPcmPath).arrayBuffer())
    if (pcm.byteLength % 2 !== 0) {
      console.error("usage: --stt-pcm file must be raw PCM16 LE, 16 kHz, mono (even byte length)")
      process.exit(2)
    }
    const capture = new GatewaySttCapture({requester: first.connection})
    talkEventHandler = (payload) => capture.onTalkEvent(payload)
    capture.begin(sessionKey)
    const sliceBytes = 3200
    for (let offset = 0; offset < pcm.byteLength; offset += sliceBytes) {
      const slice = pcm.subarray(offset, Math.min(offset + sliceBytes, pcm.byteLength))
      let binary = ""
      for (let index = 0; index < slice.length; index += 1) binary += String.fromCharCode(slice[index]!)
      capture.pushChunk({data: btoa(binary), format: "pcm_s16le", sampleRate: 16000})
      const sleep = Promise.withResolvers<void>()
      setTimeout(sleep.resolve, 100)
      await sleep.promise
    }
    let transcript: string | null
    try {
      transcript = await withTimeout(capture.finish(), STT_TIMEOUT_MS, "gateway transcript")
    } finally {
      // A timeout must not leak the capture or its talk events.
      talkEventHandler = null
      capture.dispose()
    }
    if (!transcript) fail("gateway transcription returned nothing")
    console.log(`stt: ${transcript}`)
  }

  step = "reconnect"
  first.connection.stop()
  const second = openConnection({})
  await second.connection.start()
  await withTimeout(second.connected, STEP_TIMEOUT_MS, "hello on reconnect")
  if (second.connectAuthKinds[0] !== "deviceToken") fail(`reconnect used auth ${second.connectAuthKinds[0]}`)
  console.log("reconnected via deviceToken")
  second.connection.stop()
  process.exit(0)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
