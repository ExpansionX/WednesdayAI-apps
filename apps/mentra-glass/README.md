---
audience: user | admin | developer
component: apps/mentra-glass
sources:
  - package.json
  - miniapp.json
  - vitest.config.ts
  - src/shared/channels.ts
  - src/gateway/constants.ts
  - src/gateway/setup-code.ts
  - src/background/AssistantController.ts
  - src/background/tilt.ts
  - src/background/glance.ts
  - src/background/notifications.ts
  - src/background/notificationPresenter.ts
  - src/background/gatewayStt.ts
  - src/background/glassesView.ts
  - scripts/smoke-gateway.ts
generated: 2026-10-14
---

# WednesdayAI for MentraOS glasses

[English](README.md) · [简体中文](README.zh-CN.md)

Say your WednesdayAI wake word (for example "Hey Wednesday, what's on my
calendar?") and the answer from your own WednesdayAI gateway streams onto your
MentraOS display glasses (Even Realities G1/G2, Vuzix, Mentra display glasses).

It is a background Mentra miniapp, so it runs alongside your other miniapps
(Captions, Translation, ...) and only takes the display while it is answering.

## For Users

### Requirements

- Mentra App with display glasses connected.
- A WednesdayAI gateway that knows the `openclaw-mentra-node` client
  (WednesdayAI-core with the mentra node bootstrap profile), reachable from the
  phone over `wss://` (for example Tailscale Serve) or the tailnet IP.
- For on-device wake listening: the offline speech model, downloaded in
  Mentra App -> Settings -> Transcription.
- For glasses notifications: Android notification access.

### Install (sideload)

Mentra Miniapp SDK apps are not distributed through the Mentra Miniapp Store
yet, so installs are sideloaded.

```sh
npm install            # from the repo root
cd apps/mentra-glass
bun run dev            # live development: scan the printed QR in
                       # Mentra App -> Settings -> Miniapp Developer Settings -> Scan Miniapp QR Code
bun run release        # standalone install: prints a miniapp://release QR
```

In the Mentra App, stop "Mentra AI" so only one assistant answers.

### Pair with your gateway

1. On the gateway host run `wednesdayai qr --client openclaw-mentra-node`.
2. Open the WednesdayAI miniapp in the Mentra App and tap **Scan setup QR**
   (or paste the setup code and tap **Pair**).
3. The status shows **Connected** and your gateway's wake words.

### Using the wake word

Say your wake word (for example "Hey Wednesday") followed by your question.
The glasses show **Listening…**, then **Thinking…**, then the streamed
answer. The answer clears itself after 15 seconds (4 seconds when the
miniapp shows **Offline**). If you say just the wake word, the miniapp
listens for 8 seconds for the question to follow.

Wake words come from the gateway and update live when your administrator
changes them. A wake word heard split into two or three words ("open claw"
for "openclaw") still matches, and when one wake word starts another
("wednesday" and "wednesday prime") the longer one wins. After the wake
word, the question is transcribed by your WednesdayAI gateway; if it
cannot, Mentra's transcript is used. When the gateway transcript starts
with the wake word again, the miniapp strips it before sending — unless
Mentra's own transcript already kept it.

### Head-tilt glance

- Tilting your head up shows the time, the connection status and the number
  of queued notifications for 5 seconds; it hides when you look down.
- It never covers an answer.
- The glasses' own tilt dashboard may also appear; MentraOS cannot turn it
  off.

### Glasses notifications

- Android only.
- Tick apps in the phone menu.
- Notifications show one at a time, in 160-character pages that advance
  every 4 seconds, then the next.
- Up to 20 notifications wait their turn; beyond that the oldest waiting
  one is dropped.
- Stop Mentra Notify to avoid duplicates.
- On iOS the glasses firmware shows notifications itself.

### Settings

- **Agent**: the gateway default, or any agent from `agents.list`. Disabled
  when the gateway uses one global session.
- **Wake listening**: on-device (private, needs the offline model) or Mentra
  cloud (more accurate).
- **Question transcription**: WednesdayAI gateway or Mentra. If the gateway
  cannot transcribe, Mentra's transcript is used.
- **Glasses notifications**: choose which Android apps may show
  notifications on the glasses.
- **Mic test**: shows the last transcripts so you can check what the wake
  detector hears.

### Troubleshooting

- **"Mentra AI answers instead"** — stop Mentra AI in the Mentra App so only
  one assistant listens.
- Do not pin WednesdayAI in the glasses menu: selecting it there stops the
  assistant (#16).
- **"No speech heard in 10 s. On-device mode needs the offline model: Mentra
  App → Settings → Transcription."** — download the offline speech model, or
  switch wake listening to Mentra cloud.
- **"Insecure gateway URL. Use Tailscale Serve (wss://) or the tailnet IP."**
  — the pairing URL was not a secure `wss://` gateway, or a plain `ws://`
  address outside localhost/loopback and the Tailscale range
  (`100.64.0.0/10`). Generate a new code with
  `wednesdayai qr --client openclaw-mentra-node --url <wss-or-tailnet-gateway-url>`
  and scan it.
- **"Pairing needs repair — scan the setup code again"** — the gateway
  rejected the stored device token. Scan a fresh setup code.
- **Offline** — the miniapp reconnects with backoff (up to 15 s between
  tries). If it stays offline, check that the gateway is running and
  reachable from the phone.
- **"Gateway sent an empty reply"** — the gateway's `chat.send` reply
  carried no payload. Retry the question; if it repeats, check the
  gateway logs.
- **On iOS the assistant hears the wrong microphone** — pinning the
  microphone from the miniapp has no effect on iOS; the Mentra App
  decides: Mentra App → Microphone → Preferred microphone (Automatic
  ranks the glasses first).

### Privacy note

Pairing state, the device token and settings live in the miniapp's session
storage, backed by unencrypted MMKV in the current host — not the phone
Keychain/Keystore. The gateway URL must be `wss://`, or `ws://` only for
localhost/loopback or the Tailscale range.

With gateway transcription on, the phone keeps the last 1.5 seconds of
microphone audio in memory while connected. It sends audio to your gateway
only from just before the wake word (up to 1.5 seconds of buffered audio)
to the end of your question. Notification text never leaves the phone.

## For Administrators

### Issue a pairing code

On the gateway host:

```sh
wednesdayai qr --client openclaw-mentra-node
```

This issues a setup code carrying the `openclaw-mentra-node` bootstrap
profile. Bootstrap pairing auto-approves; the bootstrap token is single-use
and the miniapp switches to a durable device token after the first connect.

Known issue ([WednesdayAI-core#1022](https://github.com/ExpansionX/WednesdayAI-core/issues/1022)):
on a gateway served through Tailscale serve, the first connect of a new
device does not auto-approve. The phone shows a pairing error and the gateway
lists a pending request. Approve it with `wednesdayai devices approve
<requestId>` (see `wednesdayai devices list`), then scan a new setup code.
Later reconnects use the device token and need no approval.

### Granted scopes

The client gets a bounded operator profile:

- Role: `operator`
- Scopes: `operator.read`, `operator.write`

These are the broad operator scopes, not the narrowest possible grant: they
cover chat, session reads, agents, wake words and the other operator
read/write methods (broader than the user client's narrow session scopes).
They grant no admin, pairing, approvals, `talk.secrets`, and no node role.

Question transcription uses `talk.session.*` under the existing
`operator.write` scope. It needs a transcription provider on the gateway;
otherwise the user sees "WednesdayAI transcription unavailable" once and
Mentra's transcript is used.

Known issue ([WednesdayAI-core#1023](https://github.com/ExpansionX/WednesdayAI-core/issues/1023)):
the gateway does not wait for the provider's final transcript when the
session closes. A very short question can come back empty, and Mentra's
transcript is used for it.

### Manage devices and wake words

- List/revoke paired glasses: `wednesdayai devices` (e.g. `devices list`).
  Revoking the device token blocks later reconnects — the glasses must
  re-pair to connect again. It does **not** close a connection that is
  already live: an actively connected pair of glasses keeps its session
  until it disconnects. To end a live session, unpair from the miniapp UI
  (or stop the app) and restart the gateway if needed.
- Change wake words live:
  `wednesdayai gateway call voicewake.set --params '{"triggers":["wednesday"]}'`.
  Connected glasses pick the change up without a restart.

### Network

The gateway must be reachable from the phone over `wss://` (for example
Tailscale Serve on the gateway host) or the tailnet IP. Plain `ws://` is
accepted only for localhost/loopback and the Tailscale `100.64.0.0/10`
range; anything else is rejected by the miniapp.

### Token storage caveat

The device token and the device identity key are stored in the miniapp's
session storage, backed by unencrypted MMKV in the current host — not
Keychain/Keystore. MentraOS has no secure-storage API for miniapps yet
(tracked upstream as a finding issue). If a phone is lost: revoke the device
with `wednesdayai devices` (this blocks reconnects), and restart the gateway
to drop any still-live session, since revocation alone does not terminate an
existing connection.

## For Developers

### Layout

- `src/gateway/`: portable WednesdayAI gateway client (pairing, Ed25519
  device identity, v3 device-auth signature, connection/backoff, chat run
  tracking, session-key routing). Pure TypeScript; never import `@mentra/*`
  here.
- `src/background/`: wake detection (`wake.ts`), the head-tilt glance
  (`tilt.ts`, `glance.ts`), the notification queue and paged presenter
  (`notifications.ts`, `notificationPresenter.ts`), gateway question
  transcription (`gatewayStt.ts`), glasses rendering (`glassesView.ts`),
  and `AssistantController.ts`, which wires the SDK session to the gateway
  client and owns which frame (assistant, notification, glance) is on the
  glasses.
- `src/ui/`: phone settings menu (pairing, agent, wake STT mode, question
  transcription mode, notification apps, mic test).
- `src/shared/channels.ts`: typed UI <-> background channels.
- `scripts/smoke-gateway.ts`: device-free smoke test against a real gateway.
- `scripts/build-flags.ts` (with `build-flags.test.ts`): build-time flags;
  `build.ts` uses its trace gate to inline `MENTRA_PUBLIC_TRACE`.

### Commands

| Command                                                         | Purpose                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run glass:test` (repo root) or `npm test`                  | unit tests (vitest)                                                                                                                                                                                                                  |
| `npm run glass:coverage` (repo root) or `npm run test:coverage` | tests with v8 coverage; 80% thresholds on `src/gateway`, `src/background` and `src/ui/App.tsx` (excluding tests and `src/background/index.ts`)                                                                                       |
| `npm run glass:typecheck` (repo root) or `npm run typecheck`    | `tsc --noEmit` for `src/` and `scripts/`                                                                                                                                                                                             |
| `bun run build`                                                 | production bundles in `dist/`                                                                                                                                                                                                        |
| `bun run dev`                                                   | live development with sideload QR                                                                                                                                                                                                    |
| `MENTRA_PUBLIC_TRACE=1 bun run dev`                             | dev mode that prints a `[trace]` line per transcript, wake decision, gateway transcript, `chat.send` and glasses frame; only the exact value `1` enables it, and `release`/`pack` builds force trace off even if the variable is set |
| `bun run release`                                               | build, pack, serve a `miniapp://release` install QR                                                                                                                                                                                  |
| `bun run smoke:gateway -- --setup-code <code>`                  | device-free check: pairs, reads wake words and agents, sends `chat.send`, reconnects with the stored device token                                                                                                                    |

Get a setup code for the smoke test with
`wednesdayai qr --client openclaw-mentra-node --setup-code-only`. With
`--stt-pcm <file>` (raw PCM16 LE, 16 kHz, mono) the tool also streams the
file through gateway transcription and prints the `stt:` transcript,
exercising `talk.session.*` end to end. The smoke
tool prints `connected`, the wake triggers, the agents, one `delta` line per
stream chunk, `final:` (or `error:`) plus `pong=yes|no` for the reply, and
finally `reconnected via deviceToken`. Exit 0 verifies pairing, RPC access,
chat terminal-event routing and device-token reconnect — **not** a
successful model reply: a chat error or a reply without "pong" still exits 0. Confirm the answer check by reading `final:` and `pong=yes` in the
output.

On a gateway behind Tailscale Serve the first pairing of a new device
needs approval ([WednesdayAI-core#1022](https://github.com/ExpansionX/WednesdayAI-core/issues/1022)),
so the first run fails at `pair`. Run with `--state-file <file>` to keep the
smoke device identity, approve the pending request
(`wednesdayai devices list`, then `wednesdayai devices approve <requestId>`),
and rerun with a new setup code and the same `--state-file`. Remove the
smoke device afterwards with `wednesdayai devices remove <deviceId>`.

### Architecture

`AssistantController` subscribes to session transcription (on-device sherpa
STT with `forceLocal`, or the Mentra cloud, per the wake-listening setting).
Wake matching runs on the transcript (`src/background/wake.ts`): a
trigger heard split into up to three transcript words ("open claw" for
"openclaw") still matches, the longest trigger span at a position wins,
and `resolveAndSend` strips repeated leading wake words from the gateway
transcript only when Mentra's query has no wake word. A match
sends `chat.send` through `GatewayConnection` (`src/gateway/connection.ts`)
to the session resolved by `src/gateway/sessions.ts`, and chat events update
a `ChatRun` (`src/gateway/chat.ts`) rendered on the glasses via
`GlassesView` (`src/background/glassesView.ts`).

With question transcription on the gateway (`querySttMode: "gateway"`), mic
audio streams into `GatewaySttCapture` (`src/background/gatewayStt.ts`)
while connected: it opens a `talk.session` carrying the last 1.5 s of
pre-roll, appends live audio in ordered frames of at most `MAX_APPEND_BYTES`
(96,000 decoded bytes, about 3 s of PCM16 at 16 kHz), waits up to 6 s for
the transcript after close, and aborts a capture at 20 s. The gateway
transcript wins over Mentra's when both arrive; a gateway that cannot
transcribe warns once per hello ("WednesdayAI transcription unavailable:
…") and Mentra's transcript is used.

One frame owns the display at a time: assistant frames outrank notification
pages, which outrank the head-tilt glance (`tilt.ts`, `glance.ts` — tilt-up
holds 300 ms above 25° to show, look-down below 15° to hide). Allowed
notifications queue in `NotificationPresenter` (`notifications.ts`,
`notificationPresenter.ts`: 160-character pages, 4 s per accepted page,
queue of 20) and show only when no assistant frame is up. The UI and the
background talk only through the typed channels in `src/shared/channels.ts`
(including `notifications:allow` for per-app allowlist ticks); the
background pushes a state snapshot on every change.

### Constraints and known limits

- The background is a bare JavaScript engine, not a browser or Node: no
  `window`, `document`, `performance`, `crypto.subtle`,
  `crypto.randomUUID`, `URL`/`URLSearchParams`, Node built-ins or
  `process` in `src/background/` or `src/gateway/`. Ed25519/SHA come from
  `@noble/ed25519` + `@noble/hashes`.
- Tests are colocated as `src/**/*.test.ts(x)` (vitest); thresholds live in
  `vitest.config.ts`. Coverage includes `src/ui/App.tsx` through
  `src/ui/App.test.tsx`, which opts its file into happy-dom with a
  `@vitest-environment happy-dom` comment (deps `@testing-library/react`,
  `@testing-library/dom`, `happy-dom`). Controller tests run under fake
  timers only: their `flush()` helper is `vi.advanceTimersByTimeAsync(0)`,
  which throws under real timers.
- Storage keys `wai.identity.v1`, `wai.gateway.v1`, `wai.deviceAuth.v1`,
  `wai.settings.v1`, `wai.notificationApps.v1` sit in plain session storage
  (see the admin caveat).
- Sideload distribution only (MentraOS 3.0 does not store-distribute Miniapp
  SDK apps).
- Open limitations are tracked as `[finding]` issues in
  `ExpansionX/WednesdayAI-apps` (#1–#16).
