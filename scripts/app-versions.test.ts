import { describe, expect, it } from "vitest";
import { buildBuildInfo, FORK_BASE } from "./version-derive.ts";

describe("buildBuildInfo", () => {
  it("includes version, commit, channel, forkBase and an ISO builtAt", () => {
    const info = buildBuildInfo({
      version: "0.1.39",
      commit: "abc1234",
      channel: "dev",
      builtAt: "2026-06-04T00:00:00.000Z",
    });
    expect(info).toEqual({
      version: "0.1.39",
      commit: "abc1234",
      channel: "dev",
      forkBase: FORK_BASE,
      builtAt: "2026-06-04T00:00:00.000Z",
    });
  });

  it("defaults channel to 'dev' when unset", () => {
    expect(buildBuildInfo({ version: "0.1.39", commit: null, builtAt: "t" }).channel).toBe("dev");
  });
});

import { deriveBuildNumber } from "./version-derive.ts";

describe("deriveBuildNumber", () => {
  it("reproduces the existing convention (0.1.15 -> 115)", () => {
    expect(deriveBuildNumber("0.1.15")).toBe(115);
  });
  it("is monotonic across versions", () => {
    expect(deriveBuildNumber("0.1.39")).toBe(139);
    expect(deriveBuildNumber("0.2.0")).toBe(200);
    expect(deriveBuildNumber("1.0.0")).toBe(10000);
  });
  it("throws when minor or patch exceed the two-digit range", () => {
    expect(() => deriveBuildNumber("0.1.100")).toThrow();
    expect(() => deriveBuildNumber("0.100.0")).toThrow();
  });
  it("throws on a non-SemVer string", () => {
    expect(() => deriveBuildNumber("nope")).toThrow();
  });
});

import { stampAndroid, stampPlist } from "./version-derive.ts";

describe("stampAndroid", () => {
  it("rewrites versionName and versionCode", () => {
    const input = `    versionCode = 115\n    versionName = "0.1.15"\n`;
    expect(stampAndroid(input, "0.1.40", 240)).toBe(
      `    versionCode = 240\n    versionName = "0.1.40"\n`,
    );
  });
});

describe("stampPlist", () => {
  it("rewrites CFBundleShortVersionString and CFBundleVersion", () => {
    const input = [
      "<key>CFBundleShortVersionString</key>",
      "<string>0.1.15</string>",
      "<key>CFBundleVersion</key>",
      "<string>115</string>",
    ].join("\n");
    const out = stampPlist(input, "0.1.40", 240);
    expect(out).toContain("<key>CFBundleShortVersionString</key>\n<string>0.1.40</string>");
    expect(out).toContain("<key>CFBundleVersion</key>\n<string>240</string>");
  });
});

describe("fail-loud stampers", () => {
  it("stampAndroid throws if versionName/versionCode are not both present", () => {
    expect(() => stampAndroid("no version here", "0.1.40", 140)).toThrow();
  });
  it("stampPlist throws if either key/string pair is missing", () => {
    const onlyShort = "<key>CFBundleShortVersionString</key>\n<string>0.1.15</string>";
    expect(() => stampPlist(onlyShort, "0.1.40", 140)).toThrow();
  });
});
