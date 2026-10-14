import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_STAMPERS, APP_VERSION_TARGETS, deriveBuildNumber } from "./app-versions.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = path.join(repoRoot, "apps/shared/contracts");
const coreVersion = fs.readFileSync(path.join(contractsDir, "CORE_VERSION"), "utf8").trim();

type HostEnvSecurityPolicy = {
  blockedKeys: string[];
  blockedOverrideKeys?: string[];
  blockedPrefixes: string[];
};

type SchemaLike = {
  anyOf?: Array<SchemaLike>;
  properties?: Record<string, unknown>;
  const?: unknown;
};

// Mirrors the schema-walking logic in core's cron-protocol-conformance test: delivery is either
// an object whose `mode` is a union of consts, or a union of objects each pinning `mode`.
function extractDeliveryModes(schema: SchemaLike): string[] {
  const modeSchema = schema.properties?.mode as SchemaLike | undefined;
  const directModes = (modeSchema?.anyOf ?? [])
    .map((entry) => entry?.const)
    .filter((value): value is string => typeof value === "string");
  if (directModes.length > 0) {
    return directModes;
  }

  const unionModes = (schema.anyOf ?? [])
    .map((entry) => {
      const mode = entry.properties?.mode as SchemaLike | undefined;
      return mode?.const;
    })
    .filter((value): value is string => typeof value === "string");

  return Array.from(new Set(unionModes));
}

function parseSwiftStringArray(source: string, marker: string): string[] {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escapedMarker}[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\]`, "m");
  const match = source.match(re);
  if (!match) {
    throw new Error(`Failed to parse Swift array for marker: ${marker}`);
  }
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (m) => m[1]);
}

describe("synced contracts", () => {
  it("host env policy: generated Swift matches synced JSON", () => {
    const policy = JSON.parse(
      fs.readFileSync(path.join(contractsDir, "host-env-security-policy.json"), "utf8"),
    ) as HostEnvSecurityPolicy;
    const generatedSource = fs.readFileSync(
      path.join(repoRoot, "apps/macos/Sources/OpenClaw/HostEnvSecurityPolicy.generated.swift"),
      "utf8",
    );
    const sanitizerSource = fs.readFileSync(
      path.join(repoRoot, "apps/macos/Sources/OpenClaw/HostEnvSanitizer.swift"),
      "utf8",
    );

    const swiftBlockedKeys = parseSwiftStringArray(generatedSource, "static let blockedKeys");
    const swiftBlockedOverrideKeys = parseSwiftStringArray(
      generatedSource,
      "static let blockedOverrideKeys",
    );
    const swiftBlockedPrefixes = parseSwiftStringArray(generatedSource, "static let blockedPrefixes");

    expect(swiftBlockedKeys).toEqual(policy.blockedKeys);
    expect(swiftBlockedOverrideKeys).toEqual(policy.blockedOverrideKeys ?? []);
    expect(swiftBlockedPrefixes).toEqual(policy.blockedPrefixes);

    expect(sanitizerSource).toContain(
      "private static let blockedKeys = HostEnvSecurityPolicy.blockedKeys",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedOverrideKeys = HostEnvSecurityPolicy.blockedOverrideKeys",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedPrefixes = HostEnvSecurityPolicy.blockedPrefixes",
    );
  });

  it("cron delivery modes in schema exist as Swift cases", () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(contractsDir, "gateway-protocol.schema.json"), "utf8"),
    );
    const delivery = (schema.definitions?.CronJob?.properties?.delivery ?? {}) as SchemaLike;
    const modes = extractDeliveryModes(delivery);
    expect(modes.length).toBeGreaterThan(0);

    const content = fs.readFileSync(
      path.join(repoRoot, "apps/macos/Sources/OpenClaw/CronModels.swift"),
      "utf8",
    );
    for (const mode of modes) {
      const pattern = new RegExp(`\\bcase\\s+${mode}\\b`);
      expect(pattern.test(content), `CronModels.swift missing case ${mode}`).toBe(true);
    }
  });

  it("cron status shape", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "apps/macos/Sources/OpenClaw/GatewayConnection.swift"),
      "utf8",
    );
    expect(content.includes("struct CronSchedulerStatus")).toBe(true);
    expect(content.includes("let jobs:")).toBe(true);
  });

  it("generated Swift declares the schema protocol version", () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(contractsDir, "gateway-protocol.schema.json"), "utf8"),
    );
    const declaration = `public let GATEWAY_PROTOCOL_VERSION = ${schema["x-protocol-version"]}`;
    for (const relPath of [
      "apps/macos/Sources/OpenClawProtocol/GatewayModels.swift",
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift",
    ]) {
      const content = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
      expect(content.includes(declaration), `${relPath} missing ${declaration}`).toBe(true);
    }
  });
});

describe("app versions match CORE_VERSION", () => {
  it("every declared target exactly matches its stamper output for the synced core version", () => {
    const build = deriveBuildNumber(coreVersion);
    for (const [relPath, stamp] of Object.entries(APP_STAMPERS)) {
      const committed = fs.readFileSync(path.join(repoRoot, relPath), "utf8"); // throws if a declared target is missing
      // A stamper is idempotent on correctly stamped content and rewrites any drifted
      // version/build field, so exact equality proves the file is stamped to CORE_VERSION
      // including build numbers and versionCode — a substring check would miss 0.4.110 vs
      // 0.4.11 or an off-by-one CFBundleVersion.
      expect(
        committed,
        `${relPath} is not exactly its stamped content for ${coreVersion}`,
      ).toBe(stamp(committed, coreVersion, build));
    }
  });

  it("the xcodegen source (project.yml) carries no stale version or build number", () => {
    const yml = fs.readFileSync(path.join(repoRoot, "apps/ios/project.yml"), "utf8");
    const build = String(deriveBuildNumber(coreVersion));
    const versionMatches = [...yml.matchAll(/CFBundleShortVersionString: "([^"]*)"/g)];
    const buildMatches = [...yml.matchAll(/CFBundleVersion: "([^"]*)"/g)];
    // Fail loud if the declarations vanish entirely, otherwise a zero-match yml would pass.
    expect(
      versionMatches.length,
      "project.yml must declare CFBundleShortVersionString",
    ).toBeGreaterThan(0);
    expect(buildMatches.length, "project.yml must declare CFBundleVersion").toBeGreaterThan(0);
    const staleVersions = versionMatches.map((m) => m[1]).filter((v) => v !== coreVersion);
    const staleBuilds = buildMatches.map((m) => m[1]).filter((v) => v !== build);
    expect(staleVersions, `stale iOS versions in project.yml: ${staleVersions.join(", ")}`).toEqual(
      [],
    );
    expect(
      staleBuilds,
      `stale iOS build numbers in project.yml: ${staleBuilds.join(", ")}`,
    ).toEqual([]);
  });
});

// ADR 0004 meta-test: the set of derived locations must equal what stampAppVersions manages, so
// a new version-bearing file cannot silently drift out of sync.
describe("derived-location coverage", () => {
  it("no version-bearing iOS file is unmanaged", () => {
    const pattern = '<key>CFBundleShortVersionString</key>|CFBundleShortVersionString: "';
    const versioned = execFileSync(
      "git",
      ["grep", "-lE", pattern, "--", "apps/ios"],
      { cwd: repoRoot, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    const unmanaged = versioned.filter((relPath) => !APP_VERSION_TARGETS.includes(relPath));
    expect(
      unmanaged,
      `wire these into APP_VERSION_TARGETS in scripts/app-versions.ts: ${unmanaged.join(", ")}`,
    ).toEqual([]);
  });
});

describe("contracts sync", () => {
  it("fails before writing when the source is missing a fixture", () => {
    const stage = mkdtempSync(path.join(os.tmpdir(), "contracts-sync-test-"));
    try {
      for (const [file, source] of [
        ["gateway-protocol.schema.json", contractsDir],
        ["host-env-security-policy.json", contractsDir],
        [
          "tool-display.json",
          path.join(repoRoot, "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources"),
        ],
      ] as const) {
        copyFileSync(path.join(source, file), path.join(stage, file));
      }
      const coreVersionBefore = fs.readFileSync(path.join(contractsDir, "CORE_VERSION"), "utf8");
      const run = spawnSync(
        "node",
        [
          "--import",
          "tsx",
          "scripts/contracts-sync.ts",
          "--from-dir",
          stage,
          "--core-version",
          coreVersionBefore.trim(),
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "does not ship dist/contracts/fixtures/exec-allowlist-shell-parser-parity.json",
      );
      expect(fs.readFileSync(path.join(contractsDir, "CORE_VERSION"), "utf8")).toBe(
        coreVersionBefore,
      );
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
