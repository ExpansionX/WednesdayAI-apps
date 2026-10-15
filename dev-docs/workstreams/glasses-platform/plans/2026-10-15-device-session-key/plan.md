---
workstream: glasses-platform
doc_type: plan
title: "Device session key: route glasses turns to the linked person's direct session"
status: proposed
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

1. The miniapp picks the session key itself. `chat.send` requires `sessionKey` (`src/gateway/protocol/schema/logs-chat.ts:40-44`); the gateway never derives one. The miniapp uses hello-ok `snapshot.sessionDefaults.mainSessionKey` (apps `src/gateway/connection.ts:646-648`, `src/gateway/sessions.ts:24-37`).
2. `identityLinks` attributes turns; it does not choose sessions. A device turn's sender is `device:<id>` (`src/gateway/server-methods/chat-turn.ts:45-51`). It feeds workspace lanes and actor identity only. The turn runs in whatever `sessionKey` the client sent.
3. hello-ok is built per connection: `buildGatewaySnapshot()` runs per connect (`src/gateway/server/ws-connection/message-handler.ts:1294`). The snapshot is never broadcast afterwards; later events are narrow (`presence`, `health`, `chat`, `voicewake.changed`). A per-device field in `sessionDefaults` reaches only that connection. The verified `device.id` is in scope there (`message-handler.ts:890-894`, `:1139-1140`).
4. Gateway client turns use channel `webchat` (`INTERNAL_MESSAGE_CHANNEL`, `src/utils/message-channel.ts:17`) and no account id (`chat-turn.ts:264-281`). For `device:<id>` linked as `DavidRudduck`, `buildAgentPeerSessionKey` (`src/routing/session-key.ts:213-272`) yields `agent:main:direct:davidrudduck` (per-peer), `agent:main:webchat:direct:davidrudduck` (per-channel-peer), `agent:main:webchat:default:direct:davidrudduck` (per-account-channel-peer) and `agent:main:main` (main). The canonical key is lowercased.
5. `session.*` is hot-reloaded with no restart and no client event (`src/gateway/config-reload-plan.ts:84`). A key computed at connect goes stale until the client reconnects.
6. `chat.send` already accepts any key for `operator.write`. Only `resolveSendPolicy` gates it (`src/gateway/server-methods/chat.ts:1471-1481`). Nothing ties a direct key to the sender. This plan does not widen that.
7. Contracts: the TypeBox schema is snapshotted to `src/gateway/protocol/gateway-protocol.schema.json` by `pnpm protocol:gen`, and guarded by `pnpm protocol:check`. It ships in `dist/contracts` (ADR 0101). WednesdayAI-apps pulls it with `npm run contracts:sync -- --version <core release>`, which regenerates Swift.

## Global Constraints

- The new field is optional and additive. `mainSessionKey`, its value and every existing hello-ok field stay unchanged.
- The field is present only when all hold: the connection has a verified, paired device id; `session.scope` is not `global`; `session.dmScope` is set and not `main`; and `device:<id>` resolves to a canonical identity through `session.identityLinks`.
- Build the value only with `buildAgentPeerSessionKey`, never hand-formatted. Use: `agentId` = default agent, `channel` = `INTERNAL_MESSAGE_CHANNEL`, `accountId` = undefined, `peerKind` = `"direct"`, `peerId` = `toDeviceSenderId(deviceId)`, `peerIdOrigin` = `"sender"`.
- Core conventions: commit through `scripts/committer`; never hand-edit the root `CHANGELOG.md` (release-please); log through `createSubsystemLogger`; cite repo-root-relative paths.
- Apps conventions: gateway client id `openclaw-mentra-node`; no `process` in `src/background/` or `src/gateway/`; every `README.md` change is mirrored in `README.zh-CN.md`; never hand-edit `apps/shared/contracts/*`.
- No AI co-author trailers on any commit or PR.

## Review Focus

1. **Config edited while connected.** An admin adds the `identityLinks` entry while the glasses are online. Expected: the next hello-ok, after a reconnect, carries the key, with no gateway restart. Pinned in Task 2.
2. **Direct bucket that already has a Telegram route.** `chat-turn.ts:264-281` sets `OriginatingChannel` to the stored route when one exists. [INFERENCE, unverified] A glasses question in `agent:main:direct:davidrudduck` may also post its reply to Telegram. Expected: decide and pin it. Either mirroring is intended (one conversation), or device turns must not route out. Pinned in Task 2's e2e.
3. **The user picked a non-default agent in the miniapp.** Expected: `agent:<picked>:direct:davidrudduck`, not the default agent's bucket and not `agent:<picked>:main`. Pinned in Task 4.
4. **Connections without a device** (shared token, password, Control UI) and devices that are not linked. Expected: no field. Pinned in Task 2.
5. **Older gateway.** The miniapp connects to a gateway without the field. Expected: today's behaviour, `mainSessionKey`. Pinned in Task 4.

---

## Part 1: WednesdayAI-core

### Task 1: `resolveDeviceSessionKey`

**Files:**
- Modify: `src/routing/session-key.ts` (new export next to `toDeviceSenderId`)
- Test: `src/routing/session-key.test.ts` (new `describe("resolveDeviceSessionKey")`)

**Interfaces:**
- Produces: `resolveDeviceSessionKey(params: { cfg: OpenClawConfig; deviceId: string }): string | undefined`. Returns undefined unless all Global Constraints conditions hold. It is placed in `src/routing/` because it is pure config + routing; if `resolveDefaultAgentId` (`src/agents/agent-scope.ts`) cannot be imported there without a cycle, place it in `src/gateway/server/health-state.ts` instead.

- [ ] **Step 1: Write the failing tests.** Use identityLinks `{ DavidRudduck: ["device:dev-1"] }` and default agent `main`:
  - `dmScope: "per-peer"` returns `"agent:main:direct:davidrudduck"`.
  - `"per-channel-peer"` returns `"agent:main:webchat:direct:davidrudduck"`.
  - `"per-account-channel-peer"` returns `"agent:main:webchat:default:direct:davidrudduck"`.
  - `"main"` and unset return `undefined`; `scope: "global"` returns `undefined`.
  - Device `dev-2` (unlinked) returns `undefined`.
  - Default agent `ops` (agents list) with per-peer returns `"agent:ops:direct:davidrudduck"`.
- [ ] **Step 2:** `pnpm vitest run src/routing/session-key.test.ts -t resolveDeviceSessionKey` fails (not exported).
- [ ] **Step 3: Implement.** Check linkage with `resolveCanonicalIdentity({ identityLinks, channel: INTERNAL_MESSAGE_CHANNEL, senderId: toDeviceSenderId(deviceId) })`, then call `buildAgentPeerSessionKey` with the constraint values. Linkage must be checked first because the builder returns a raw `direct:device:<id>` bucket for an unlinked peer.
- [ ] **Step 4:** The same command passes.
- [ ] **Step 5:** `scripts/committer "feat(routing): resolve a linked device's direct session key" src/routing/session-key.ts src/routing/session-key.test.ts`

### Task 2: `deviceSessionKey` in hello-ok

**Files:**
- Modify: `src/gateway/protocol/schema/snapshot.ts:28-36` (`SessionDefaultsSchema`: `deviceSessionKey: Type.Optional(NonEmptyString)`)
- Modify: `src/gateway/server/health-state.ts:17` (`buildGatewaySnapshot(opts?: { deviceId?: string }): Snapshot` sets `sessionDefaults.deviceSessionKey` from Task 1 when defined)
- Modify: `src/gateway/server/ws-connection/message-handler.ts:1294` (pass the verified, paired `device?.id`)
- Regenerate: `src/gateway/protocol/gateway-protocol.schema.json` (`pnpm protocol:gen`)
- Test: `src/gateway/server.mentra-bootstrap-connect.test.ts`, `src/gateway/server.chat-send-workspace-lane.e2e.test.ts`

**Interfaces:**
- Consumes: `resolveDeviceSessionKey` (Task 1).
- Produces (wire): `hello-ok.snapshot.sessionDefaults.deviceSessionKey?: string`.

- [ ] **Step 1: Write the failing tests** in `server.mentra-bootstrap-connect.test.ts`, with `session: { dmScope: "per-peer", identityLinks: { Alice: ["device:<test device id>"] } }`:
  - The linked device's hello-ok has `sessionDefaults.deviceSessionKey === "agent:main:direct:alice"` and `mainSessionKey === "agent:main:main"`.
  - An unlinked device's hello-ok has no `deviceSessionKey`.
  - A token-only client with no device has no `deviceSessionKey`.
  - Connect unlinked, write config adding the link, wait for the reload, reconnect: the second hello-ok has the key (Review Focus 1).
- [ ] **Step 2: Write the failing e2e test** in `server.chat-send-workspace-lane.e2e.test.ts`:
  - `chat.send` with the returned key succeeds, and the run's `canonicalIdentity` is `"Alice"`.
  - With the bucket pre-seeded with a Telegram `deliveryContext`, assert the decided behaviour for Review Focus 2: either the reply goes to Telegram, or it does not.
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

- [ ] **Step 1:** Write the docs. In the human `devices list` table the `Device` column shows the display name, so the docs must say to use `--json` (`src/cli/devices-cli.ts:263`).
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
