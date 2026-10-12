# WednesdayAI for MentraOS glasses

Say your WednesdayAI wake word (for example "Hey Wednesday, what's on my
calendar?") and the answer from your own WednesdayAI gateway streams onto your
MentraOS display glasses (Even Realities G1/G2, Vuzix, Mentra display glasses).

It is a background Mentra miniapp, so it runs alongside your other miniapps
(Captions, Translation, ...) and only takes the display while it is answering.

## Requirements

- Mentra App with display glasses connected.
- A WednesdayAI gateway that knows the `openclaw-mentra-node` client
  (WednesdayAI-core with the mentra node bootstrap profile), reachable from the
  phone over `wss://` (for example Tailscale Serve) or the tailnet IP.
- For on-device wake listening: the offline speech model, downloaded in
  Mentra App -> Settings -> Transcription.

## Install (sideload)

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

## Pair with your gateway

1. On the gateway host run `wednesdayai qr --client openclaw-mentra-node`.
2. Open the WednesdayAI miniapp in the Mentra App and tap **Scan setup QR**
   (or paste the setup code and tap **Pair**).
3. The status shows **Connected** and your gateway's wake words.

The miniapp gets a bounded operator token: `operator.read` and
`operator.write` only (chat, sessions, agents, wake words). No admin,
pairing, approvals, or node role.

## Settings

- **Agent**: the gateway default, or any agent from `agents.list`. Disabled
  when the gateway uses one global session.
- **Wake listening**: on-device (private, needs the offline model) or Mentra
  cloud (more accurate).
- **Mic test**: shows the last transcripts so you can check what the wake
  detector hears.

Wake words come from the gateway (`voicewake.get`) and update live when they
change (`voicewake.set`).

## Development

| Command | Purpose |
| --- | --- |
| `npm test` | unit tests (vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `bun run build` | production bundles in `dist/` |
| `bun run smoke:gateway -- --setup-code <code>` | device-free check: pairs, reads wake words and agents, sends `chat.send`, reconnects with the stored device token |

Get a setup code for the smoke test with
`wednesdayai qr --client openclaw-mentra-node --setup-code-only`.
