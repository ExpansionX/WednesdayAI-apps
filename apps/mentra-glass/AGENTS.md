# apps/mentra-glass

WednesdayAI assistant for MentraOS display glasses. A `type: "background"`
Mentra miniapp: it listens for the gateway's wake words in speech-to-text
transcripts, sends the spoken question to the user's WednesdayAI gateway with
`chat.send`, and streams the reply onto the glasses display.

## Layout

- `src/gateway/`: portable WednesdayAI gateway client (pairing, Ed25519 device
  identity, v3 device-auth signature, connection/backoff, chat run tracking,
  session-key routing). Pure TypeScript; never import `@mentra/*` here.
- `src/background/`: wake detection (`wake.ts`), glasses rendering
  (`glassesView.ts`), and `AssistantController.ts`, which wires the SDK session
  to the gateway client.
- `src/ui/`: phone settings menu (pairing, agent, wake STT mode, mic test).
- `src/shared/channels.ts`: typed UI <-> background channels.
- `scripts/smoke-gateway.ts`: device-free smoke test against a real gateway.

## Rules

- Gateway client id is `openclaw-mentra-node`; the gateway must ship the
  matching bootstrap profile (operator role, `operator.read` + `operator.write`).
- Glasses subscriptions, `session.*` calls and durable state live in
  `src/background/`. React and DOM live in `src/ui/`. The layers share data
  only through the channels in `src/shared/channels.ts`.
- The background is a bare JavaScript engine, not a browser or Node. Do not use
  `window`, `document`, `performance`, `crypto.subtle`, `crypto.randomUUID`,
  Node built-ins, or `process` in `src/background/` or `src/gateway/`. Use
  `setTimeout`, `crypto.getRandomValues`, `btoa`/`atob`, `TextEncoder`.
- Ed25519/SHA come from `@noble/ed25519` + `@noble/hashes` because
  `crypto.subtle` throws in the MentraOS background runtime.
- Tests are colocated as `src/**/*.test.ts` (vitest) and must cover behaviour
  that a consumer would notice.
- `URL`/`URLSearchParams` do not exist in the background runtime (the build
  guard rejects them). Parse URLs with `parseUrlParts` in
  `src/gateway/setup-code.ts`.
- Format with `npx prettier --write "src/**/*.{ts,tsx}" "scripts/*.ts"`
  (`.prettierrc.json`: no semicolons, no bracket spacing, width 120).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run glass:test` (repo root) or `npm test` | vitest |
| `npm run glass:typecheck` (repo root) or `npm run typecheck` | `tsc --noEmit` |
| `bun run build` | bundles `dist/background/index.js` and `dist/ui/` |
| `bun run dev` | dev server with sideload QR |
| `bun run release` | build, pack, serve a `miniapp://release` install QR |
| `bun run smoke:gateway -- --setup-code <code>` | pair + chat against a gateway |
