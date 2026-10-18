---
workstream: glasses-platform
doc_type: plan
title: "Device session key: route glasses turns to the linked person's direct session"
status: draft
id: 2026-10-15-device-session-key
created: 2026-10-15
updated: 2026-10-15
authors: [agent]
---

# Device Session Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired device linked to a person in `session.identityLinks` learns, at connect, the session key the gateway routes that person's direct messages to (for example `agent:main:direct:davidrudduck`), and the glasses miniapp sends `chat.send` there instead of `agent:main:main`.

**Architecture:** WednesdayAI-core computes the key per connection from the verified device id with the existing routing function `buildAgentPeerSessionKey`, and returns it as an optional `snapshot.sessionDefaults.deviceSessionKey` in hello-ok. The miniapp prefers it over `mainSessionKey`. Nothing changes for unlinked devices, non-device clients or gateways without the field.

**Tech Stack:** core: TypeScript, TypeBox protocol schema, vitest, pnpm. apps: TypeScript miniapp (bun build, vitest), npm.

**Spec:** this document. The evidence is in "Findings" below (core `main` @ `657febdd26`, apps `main` @ `4176fd93`). The live trace that found the problem is in [dev-docs/logs/2026-10-15-glasses-trace-and-wake-fix.md](../../../../logs/2026-10-15-glasses-trace-and-wake-fix.md).

## Findings

All core paths are relative to the WednesdayAI-core root.

1. The miniapp picks the session key itself. `chat.send` requires `sessionKey` (`src/gateway/protocol/schema/logs-chat.ts:40-44`); the gateway canonicalizes aliases but never derives a key. The miniapp uses hello-ok `snapshot.sessionDefaults.mainSessionKey` (apps `apps/mentra-glass/src/gateway/connection.ts:646-648`, `apps/mentra-glass/src/gateway/sessions.ts:24-37`).
2. On `chat.send`, `identityLinks` attributes the turn but does not choose its session. A device turn's sender is `device:<id>` (`src/gateway/server-methods/chat-turn.ts:45-51`), which feeds workspace lanes and actor identity. The turn runs in whatever `sessionKey` the client sent. (Inbound channel routing does use `identityLinks` through `buildAgentPeerSessionKey`.)
3. hello-ok is built per connection: `buildGatewaySnapshot()` runs per connect (`src/gateway/server/ws-connection/message-handler.ts:1294`). The snapshot is never broadcast afterwards; later events are narrow (`presence`, `health`, `chat`, `voicewake.changed`). A per-device field in `sessionDefaults` reaches only that connection. The device id is checked against its public key at `message-handler.ts:877-881` and its signature at `:899-913`. The pairing lookup (`:1139-1140`) runs only inside `if (device && devicePublicKey && !skipPairing)` (`:973-988`). Trusted-proxy Control UI and local backend self-connections skip pairing (`src/gateway/server/ws-connection/connect-policy.ts:35-60`). A signed device is therefore not necessarily a paired one.
4. The proposed key uses the inputs a gateway turn has without a stored route: channel `webchat` (`INTERNAL_MESSAGE_CHANNEL`, `src/utils/message-channel.ts:17`) and no account id. When the session has a deliverable route, `OriginatingChannel`, `AccountId` and the recipient come from it instead (`chat-turn.ts:264-282`). `Provider`/`Surface` stay `webchat` (`:292-293`). With those webchat inputs, `device:<id>` linked as `DavidRudduck` gives these keys from `buildAgentPeerSessionKey` (`src/routing/session-key.ts:213-272`):
   - per-peer: `agent:main:direct:davidrudduck`
   - per-channel-peer: `agent:main:webchat:direct:davidrudduck`
   - per-account-channel-peer: `agent:main:webchat:default:direct:davidrudduck`
   - main: `agent:main:main`

   The canonical key is lowercased. Core has no per-agent `dmScope`; `resolveAgentRoute` reads `cfg.session.dmScope` once (`src/routing/resolve-route.ts:556-612`).
5. `session.identityLinks` and `session.dmScope` hot-reload with no restart and no client event (`src/gateway/config-reload-plan.ts:86`; `session.storage` is the exception and needs a restart, `:66`). A key computed at connect goes stale until the client reconnects.
6. `chat.send` accepts any key for `operator.write`. Send policy (`src/gateway/server-methods/chat.ts:1471-1481`), validation, leaf guards and workspace-lane checks apply, but none ties a direct key to the sender's identity. This plan does not widen that.
7. Contracts: the TypeBox schema is snapshotted to `src/gateway/protocol/gateway-protocol.schema.json` by `pnpm protocol:gen`, and guarded by `pnpm protocol:check`. It ships in `dist/contracts` (ADR 0101). WednesdayAI-apps pulls it with `npm run contracts:sync -- --version <core release>`, which regenerates Swift.

## Global Constraints

- The new field is optional and additive. `mainSessionKey`, its value and every existing hello-ok field stay unchanged.
- The field is present only when all hold: the connection has a verified, paired device id; `session.scope` is not `global`; `session.dmScope` is set and not `main`; and `device:<id>` resolves to a canonical identity through `session.identityLinks`.
- Build the value only with `buildAgentPeerSessionKey`, never hand-formatted. Use: `agentId` = default agent, `mainKey` = `cfg.session.mainKey`, `channel` = `INTERNAL_MESSAGE_CHANNEL`, `accountId` = undefined, `peerKind` = `"direct"`, `peerId` = `toDeviceSenderId(deviceId)`, `dmScope` = `cfg.session.dmScope`, `identityLinks` = `cfg.session.identityLinks`, `peerIdOrigin` = `"sender"`. Without `dmScope` and `identityLinks` the builder returns `agent:main:main` or the raw `direct:device:<id>` bucket.
- Core conventions: commit through `scripts/committer`; never hand-edit the root `CHANGELOG.md` (release-please); log through `createSubsystemLogger`; cite repo-root-relative paths.
- Apps conventions: gateway client id `openclaw-mentra-node`; no `process` in `src/background/` or `src/gateway/`; every `README.md` change is mirrored in `README.zh-CN.md`; never hand-edit `apps/shared/contracts/*`.
- No AI co-author trailers on any commit or PR.

## Review Focus

1. **Config edited while connected.** An admin adds the `identityLinks` entry while the glasses are online. Expected: the next hello-ok, after a reconnect, carries the key, with no gateway restart. Pinned in Task 2.
2. **Direct bucket that already has a Telegram route.** This is established in the code. The steps:
   1. `chat-turn.ts:265-282` reads the stored route, and `:291-297` sets `OriginatingChannel` to `telegram`.
   2. `dispatchInboundMessage` (`src/auto-reply/dispatch.ts:56-89`) passes it on to `dispatchReplyFromConfig`.
   3. There, `shouldRouteToOriginating` is true (`src/auto-reply/reply/dispatch-from-config.ts:352-360`).
   4. The final reply goes out through `routeReply` → `deliverOutboundPayloads` (`dispatch-from-config.ts:615-646`, `src/auto-reply/reply/route-reply.ts:134-166`).

   So a glasses question in `agent:main:direct:davidrudduck` also posts its reply to Telegram. The `chat.send` `deliver` param does not disable this. **Decided (user, 2026-10-16):** keep core's existing behaviour. By default, a reply mirrors to the person's linked channels (Telegram, `/v2/client` chat, …); any policy change belongs to WednesdayAI-core configuration, not to this plan or this repository. Pinned in Task 2's e2e at the `routeReply` seam.
3. **The user picked a non-default agent in the miniapp.** Expected: `agent:<picked>:direct:davidrudduck`, not the default agent's bucket and not `agent:<picked>:main`. Pinned in Task 4.
4. **Connections without a paired device**: shared token, password, Control UI, trusted-proxy or backend self-connections that skip pairing, and devices that are not linked. Expected: no field. Pinned in Task 2.
5. **Older gateway.** The miniapp connects to a gateway without the field. Expected: today's behaviour, `mainSessionKey`. Pinned in Task 4.

---

## Part 1: WednesdayAI-core

### Task 1: `resolveDeviceSessionKey`

**Files:**
- Modify: `src/gateway/server/health-state.ts` (new export; it already imports `resolveDefaultAgentId` and `normalizeMainKey`. `src/routing/session-key.ts` cannot host it: `src/agents/agent-scope.ts:7-12` imports `session-key.ts`, which would make a cycle)
- Test: `src/gateway/server/health-state.test.ts` (new)

**Interfaces:**
- Produces: `resolveDeviceSessionKey(params: { cfg: OpenClawConfig; deviceId: string }): string | undefined`. Returns undefined unless the config conditions in Global Constraints hold. Pairing is the caller's responsibility (Task 2).

- [ ] **Step 1: Write the failing tests.** Use identityLinks `{ DavidRudduck: ["device:dev-1"] }` and default agent `main`:
  - `dmScope: "per-peer"` returns `"agent:main:direct:davidrudduck"`.
  - `"per-channel-peer"` returns `"agent:main:webchat:direct:davidrudduck"`.
  - `"per-account-channel-peer"` returns `"agent:main:webchat:default:direct:davidrudduck"`.
  - `"main"` and unset return `undefined`; `scope: "global"` returns `undefined`.
  - Device `dev-2` (unlinked) returns `undefined`.
  - Default agent `ops` (agents list) with per-peer returns `"agent:ops:direct:davidrudduck"`.
- [ ] **Step 2:** `pnpm vitest run src/gateway/server/health-state.test.ts` fails (not exported).
- [ ] **Step 3: Implement.** First check linkage with `resolveCanonicalIdentity({ identityLinks, channel: INTERNAL_MESSAGE_CHANNEL, senderId: toDeviceSenderId(deviceId) })`. A bare `device:<id>` entry matches under any channel. Then call `buildAgentPeerSessionKey` with every Global Constraints argument. The linkage check comes first because the builder returns a raw `direct:device:<id>` bucket for an unlinked peer.
- [ ] **Step 4:** The same command passes.
- [ ] **Step 5:** `scripts/committer "feat(gateway): resolve a linked device's direct session key" src/gateway/server/health-state.ts src/gateway/server/health-state.test.ts`

### Task 2: `deviceSessionKey` in hello-ok

**Files:**
- Modify: `src/gateway/protocol/schema/snapshot.ts:28-36` (`SessionDefaultsSchema`: `deviceSessionKey: Type.Optional(NonEmptyString)`)
- Modify: `src/gateway/server/health-state.ts:17` (`buildGatewaySnapshot(opts?: { deviceId?: string }): Snapshot` sets `sessionDefaults.deviceSessionKey` from Task 1 when defined)
- Modify: `src/gateway/server/ws-connection/message-handler.ts:1294`. Pass `device.id` only when the pairing lookup inside the `!skipPairing` branch (`:973-988`, `:1139-1140`) confirmed a paired device whose public key matches. Pass `undefined` otherwise, including every skipped-pairing path.
- Regenerate: `src/gateway/protocol/gateway-protocol.schema.json` (`pnpm protocol:gen`)
- Test: `src/gateway/server.mentra-bootstrap-connect.test.ts`, `src/gateway/server.chat-send-workspace-lane.e2e.test.ts`

**Interfaces:**
- Consumes: `resolveDeviceSessionKey` (Task 1).
- Produces (wire): `hello-ok.snapshot.sessionDefaults.deviceSessionKey?: string`.

- [ ] **Step 1: Write the failing tests** in `server.mentra-bootstrap-connect.test.ts`, with `session: { dmScope: "per-peer", identityLinks: { Alice: ["device:<test device id>"] } }`:
  - The linked device's hello-ok has `sessionDefaults.deviceSessionKey === "agent:main:direct:alice"` and `mainSessionKey === "agent:main:main"`.
  - An unlinked device's hello-ok has no `deviceSessionKey`.
  - A token-only client with no device has no `deviceSessionKey`.
  - A signed but unpaired device admitted through a pairing bypass (trusted-proxy Control UI or backend self-connection), and listed in `identityLinks`, has no `deviceSessionKey`.
  - Connect unlinked, write config adding the link, wait for the reload, reconnect: the second hello-ok has the key (Review Focus 1).
- [ ] **Step 2: Write the failing e2e test** in `server.chat-send-workspace-lane.e2e.test.ts`:
  - `chat.send` with the returned key succeeds, and the run's `canonicalIdentity` is `"Alice"`.
  - With the bucket pre-seeded with a Telegram `deliveryContext`, assert that the glasses reply is delivered to Telegram (`routeReply` → `deliverOutboundPayloads` called once with the Telegram route), per Review Focus 2.
- [ ] **Step 3:** Both test files fail.
- [ ] **Step 4: Implement** the schema field, the `buildGatewaySnapshot` option and the call site. Then run `pnpm protocol:gen`.
- [ ] **Step 5:** Both test files pass, and `pnpm protocol:check` is clean.
- [ ] **Step 6:** `scripts/committer "feat(gateway): send linked devices their direct session key in hello-ok" <files above>`

### Task 3: Docs

**Files:**
- Modify: `docs/gateway/protocol.md` (the `sessionDefaults.deviceSessionKey` field and when it is present)
- Modify: `docs/concepts/session.md` (identityLinks section: a linked `device:<id>` gets its direct key at connect; config changes apply on reconnect)
- Modify: `docs/platforms/mentra-glass.md` (setup: `wednesdayai devices list --json` → `deviceId`; add `"device:<deviceId>"` to the person's `session.identityLinks` entry; `session.dmScope` must not be `main`; reconnect the glasses)
- Create: `dev-docs/logs/<date>-device-session-key.md` with `workstream: mentra-node-client-profile`; link it from `dev-docs/CHANGELOG.md` and from the workstream README `staging_pointers`

- [ ] **Step 1:** Write the docs. The human `devices list` table shows the display name in the `Device` column (`src/cli/devices-cli.ts:269`), so the docs must say to use `--json` (`:222-224`).
- [ ] **Step 2:** Run the repo's docs lint (`pnpm lint:docs` or the markdownlint-cli2 script in `package.json`). It must be clean.
- [ ] **Step 3:** `scripts/committer "docs(gateway): document deviceSessionKey and device identity links" <files>`
- [ ] **Step 4:** Open a PR, merge, and cut a core release (release-please).

## Part 2: WednesdayAI-apps (after the core release)

### Task 4: Miniapp uses `deviceSessionKey`

**Files:**
- Modify: `apps/mentra-glass/src/gateway/connection.ts:63,433,646-648` (hello hook `{mainSessionKey: string | null; deviceSessionKey: string | null}`, read leniently like `readMainSessionKey`)
- Modify: `apps/mentra-glass/src/gateway/sessions.ts:24-37`
- Modify: `apps/mentra-glass/src/background/AssistantController.ts` (`onHello` stores the key; `sessionKey()` passes it)
- Modify: `apps/mentra-glass/README.md`, `README.zh-CN.md` (admin: link the glasses device in `identityLinks`)
- Sync: `npm run contracts:sync -- --version <core release>`
- Test: `apps/mentra-glass/src/gateway/sessions.test.ts`, `connection.test.ts`

**Interfaces:**
- Consumes (wire): `snapshot.sessionDefaults.deviceSessionKey?: string` (Task 2).
- Produces: `resolveSessionKey(params: {agentId: string | null; agents: AgentsInfo | null; mainSessionKey: string | null; deviceSessionKey: string | null}): string`. The checks run in this order:
  1. `scope === "global"` → `"global"`.
  2. A known `agentId` with a `deviceSessionKey` starting `agent:<defaultId>:` → `agent:<agentId>:<rest>`.
  3. A known `agentId` → `agent:<agentId>:<mainKey>`.
  4. Otherwise `deviceSessionKey ?? mainSessionKey ?? fallback`.

- [ ] **Step 1: Write the failing tests:**
  - `sessions.test.ts`:
    - With `deviceSessionKey: "agent:main:direct:davidrudduck"` and no agent picked → that key.
    - Agent `ops` picked → `"agent:ops:direct:davidrudduck"`.
    - Global scope → `"global"`.
    - `deviceSessionKey: null` → today's results, with the existing cases unchanged.
  - `connection.test.ts`:
    - A hello with `sessionDefaults.deviceSessionKey` calls `onHello` with it.
    - A hello without it → `deviceSessionKey: null`.
- [ ] **Step 2:** `npm run glass:test` fails on the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm run glass:typecheck && npm run glass:test` pass, and `npm run contracts:check` is clean.
- [ ] **Step 5: Live check.** Run `MENTRA_PUBLIC_TRACE=1 bun run dev` and pair. Then say "Computer, what time is it": the `chat.send` trace shows `"sessionKey":"agent:main:direct:davidrudduck"`.
- [ ] **Step 6:** Commit `feat(mentra-glass): send to the linked person's direct session`. Add the dev log + CHANGELOG entry per `dev-docs/` conventions, then open a PR.

## Out of scope

- Binding `chat.send` direct keys to the sender's identity (Finding 6). This is pre-existing and applies to every `operator.write` client.
- Pushing a new key to connected clients when config changes (Finding 5). Reconnect is enough for a setup-time link.
