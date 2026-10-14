import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./changelog-to-html.sh", import.meta.url));

function runChangelogToHtml(changelog: string, version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "changelog-to-html-"));
  try {
    const file = join(dir, "CHANGELOG.md");
    writeFileSync(file, changelog);
    return execFileSync("bash", [SCRIPT, version, file], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CHANGELOG = `## [1.2.3](https://github.com/ExpansionX/WednesdayAI-core/compare/v1.2.2...v1.2.3) (2026-08-20)

### Features

- release-please feature entry

## [1.2.2](https://github.com/ExpansionX/WednesdayAI-core/compare/v1.2.1...v1.2.2) (2026-07-23)

- previous release-please entry

## 1.1.0

- legacy heading entry

## 1.0.0

- oldest entry
`;

describe("changelog-to-html.sh", () => {
  it("extracts a release-please bracketed heading section", () => {
    const html = runChangelogToHtml(CHANGELOG, "1.2.3");
    expect(html).toContain("<h2>OpenClaw 1.2.3</h2>");
    expect(html).toContain("release-please feature entry");
    expect(html).not.toContain("previous release-please entry");
    expect(html).not.toContain("legacy heading entry");
  });

  it("extracts a legacy unbracketed heading section", () => {
    const html = runChangelogToHtml(CHANGELOG, "1.1.0");
    expect(html).toContain("<h2>OpenClaw 1.1.0</h2>");
    expect(html).toContain("legacy heading entry");
    expect(html).not.toContain("oldest entry");
    expect(html).not.toContain("release-please feature entry");
  });

  it("falls back to default notes for an unknown version", () => {
    const html = runChangelogToHtml(CHANGELOG, "9.9.9");
    expect(html).toContain("<h2>OpenClaw 9.9.9</h2>");
    expect(html).toContain("Latest OpenClaw update.");
    expect(html).not.toContain("release-please feature entry");
  });
});
