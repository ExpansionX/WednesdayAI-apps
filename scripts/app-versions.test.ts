import { describe, expect, it } from "vitest";
import { deriveBuildNumber, stampAndroid, stampPlist, stampProjectYml } from "./app-versions.ts";

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

describe("stampProjectYml", () => {
  const yml = [
    "    properties:",
    '        CFBundleShortVersionString: "0.1.15"',
    '        CFBundleVersion: "115"',
    "  another:",
    '        CFBundleShortVersionString: "0.1.15"',
    '        CFBundleVersion: "115"',
  ].join("\n");

  it("stamps every target's version and build (multiple occurrences)", () => {
    const out = stampProjectYml(yml, "0.1.40", 140);
    expect(out).not.toContain('"0.1.15"');
    expect(out).not.toContain('"115"');
    expect([...out.matchAll(/CFBundleShortVersionString: "0\.1\.40"/g)]).toHaveLength(2);
    expect([...out.matchAll(/CFBundleVersion: "140"/g)]).toHaveLength(2);
  });

  it("throws fail-loud when the version keys are absent (format changed)", () => {
    expect(() => stampProjectYml("targets:\n  app:\n", "0.1.40", 140)).toThrow();
  });
});
