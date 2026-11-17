/**
 * Generator tests for the gateway protocol v3 → v4 transition (workstream protocol-v4, P2).
 *
 * Fixtures are frozen snapshots:
 * - `gateway-protocol.v3.schema.json` mirrors the currently synced
 *   `apps/shared/contracts/gateway-protocol.schema.json` (x-protocol-version 3);
 * - `gateway-protocol.v4.schema.json` is the v4 preview contract emitted by WednesdayAI-core
 *   P1 (`src/gateway/protocol/gateway-protocol.v4.schema.json`, branch
 *   davidrudduck/protocol-v4-p1), so the generator is validated against the final union +
 *   hello shapes before `contracts:sync` switches to a v4 core release.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderGatewayModels, type GatewayProtocolSchema } from "./protocol-gen-swift.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3Schema = JSON.parse(
  readFileSync(
    path.join(repoRoot, "scripts/fixtures/protocol/gateway-protocol.v3.schema.json"),
    "utf8",
  ),
) as GatewayProtocolSchema;
const v4Schema = JSON.parse(
  readFileSync(
    path.join(repoRoot, "scripts/fixtures/protocol/gateway-protocol.v4.schema.json"),
    "utf8",
  ),
) as GatewayProtocolSchema;

describe("role-aware protocol constants", () => {
  it("emits client bounds [3, 4] even when the synced schema still says 3", () => {
    const out = renderGatewayModels(v3Schema);
    // The client range is independent of the synced schema version and of the server
    // admission floors (plan protocol-v4 §6 P2), so a v3-era snapshot must not drag the
    // advertised maximum back to 3.
    expect(out).toContain("public let GATEWAY_PROTOCOL_VERSION = 4");
    expect(out).toContain("public let GATEWAY_MIN_PROTOCOL_VERSION = 3");
    expect(out).toContain("public let GATEWAY_MIN_NODE_PROTOCOL_VERSION = 3");
    expect(out).not.toContain("public let GATEWAY_PROTOCOL_VERSION = 3");
  });

  it("emits the same bounds from the v4 preview snapshot", () => {
    const out = renderGatewayModels(v4Schema);
    expect(out).toContain("public let GATEWAY_PROTOCOL_VERSION = 4");
    expect(out).toContain("public let GATEWAY_MIN_PROTOCOL_VERSION = 3");
    expect(out).toContain("public let GATEWAY_MIN_NODE_PROTOCOL_VERSION = 3");
  });

  it("prefers explicit bounds declared in the synced contract", () => {
    const out = renderGatewayModels({
      ...v4Schema,
      "x-protocol-min-version": 4,
      "x-protocol-max-version": 5,
      "x-protocol-min-node-version": 3,
    });
    expect(out).toContain("public let GATEWAY_PROTOCOL_VERSION = 5");
    expect(out).toContain("public let GATEWAY_MIN_PROTOCOL_VERSION = 4");
    expect(out).toContain("public let GATEWAY_MIN_NODE_PROTOCOL_VERSION = 3");
  });
});

describe("discriminated unions", () => {
  it("emits the v4 ChatEvent union with its four arms and an unknown fallback", () => {
    const out = renderGatewayModels(v4Schema);
    expect(out).toContain("public enum ChatEvent: Codable, Sendable {");
    expect(out).toContain("    case delta(ChatDeltaEvent)");
    expect(out).toContain("    case final(ChatFinalEvent)");
    expect(out).toContain("    case aborted(ChatAbortedEvent)");
    expect(out).toContain("    case error(ChatErrorEvent)");
    expect(out).toContain("    case unknown(state: String, raw: [String: AnyCodable])");
    // Decode switches on the shared `state` tag; unmatched tags land in `unknown`.
    expect(out).toContain('case "delta": self = try .delta(ChatDeltaEvent(from: decoder))');
    expect(out).toContain('case "error": self = try .error(ChatErrorEvent(from: decoder))');
  });

  it("declares the four ChatEvent arm structs", () => {
    const out = renderGatewayModels(v4Schema);
    for (const name of [
      "ChatDeltaEvent",
      "ChatFinalEvent",
      "ChatAbortedEvent",
      "ChatErrorEvent",
    ]) {
      expect(out).toContain(`public struct ${name}: Codable, Sendable`);
    }
  });

  it("keeps deltaText and replace on the delta arm", () => {
    const out = renderGatewayModels(v4Schema);
    expect(out).toContain("public let deltatext: String");
    expect(out).toContain("public let replace: Bool?");
  });

  it("keeps the v3 ChatEvent as a struct (v3 has no ChatEvent union)", () => {
    const out = renderGatewayModels(v3Schema);
    expect(out).toContain("public struct ChatEvent: Codable, Sendable");
    expect(out).not.toContain("public enum ChatEvent");
  });

  it("skips unions without a shared const tag (cron id/jobId params stay unemitted)", () => {
    const out = renderGatewayModels(v3Schema);
    expect(out).not.toContain("public enum CronUpdateParams");
    expect(out).not.toContain("public enum CronRunParams");
  });

  it("emits structs for union arms that are not named definitions", () => {
    const out = renderGatewayModels({
      ...v4Schema,
      definitions: {
        WidgetEvent: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "a"],
              properties: { kind: { const: "a", type: "string" }, a: { type: "string" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "b"],
              properties: { kind: { const: "b", type: "string" }, b: { type: "integer" } },
            },
          ],
        },
      },
    });
    expect(out).toContain("public enum WidgetEvent: Codable, Sendable {");
    expect(out).toContain("    case a(WidgetEventA)");
    expect(out).toContain("    case b(WidgetEventB)");
    expect(out).toContain("public struct WidgetEventA: Codable, Sendable {");
    expect(out).toContain("public struct WidgetEventB: Codable, Sendable {");
  });
});

describe("hello-ok transition fields", () => {
  it("emits pluginSurfaceUrls on the v3-era HelloOk so canvas readers compile pre-sync", () => {
    const out = renderGatewayModels(v3Schema);
    expect(out).toContain("public let pluginsurfaceurls: [String: AnyCodable]?");
  });

  it("keeps canvasHostUrl on the v4-era HelloOk so legacy readers compile post-sync", () => {
    const out = renderGatewayModels(v4Schema);
    expect(out).toContain("public let canvashosturl: String?");
    expect(out).toContain("public let pluginsurfaceurls: [String: AnyCodable]?");
  });
});

describe("regressions", () => {
  it("still emits the GatewayFrame enum and the v3 ChatEvent cumulative fields", () => {
    const out = renderGatewayModels(v3Schema);
    expect(out).toContain("public enum GatewayFrame: Codable, Sendable {");
    expect(out).toContain("public struct ChatEvent: Codable, Sendable");
    expect(out).toContain("public let state: AnyCodable");
    expect(out).toContain("public let message: AnyCodable?");
  });

  it("still emits the ErrorCode enum from x-error-codes", () => {
    const out = renderGatewayModels(v4Schema);
    expect(out).toContain('case recoveryNotReady = "RECOVERY_NOT_READY"');
  });
});
