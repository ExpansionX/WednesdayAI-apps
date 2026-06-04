export const FORK_BASE = "openclaw@2026.3.2";

export type BuildChannel = "stable" | "dev";

export function buildBuildInfo(input: {
  version: string | null;
  commit: string | null;
  builtAt: string;
  channel?: BuildChannel;
}) {
  return {
    version: input.version,
    commit: input.commit,
    channel: input.channel ?? "dev",
    forkBase: FORK_BASE,
    builtAt: input.builtAt,
  };
}

export function deriveBuildNumber(version: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) {
    throw new Error(
      `Cannot derive build number from non-SemVer version: ${JSON.stringify(version)}`,
    );
  }
  const [, major, minor, patch] = m.map(Number);
  if (minor >= 100 || patch >= 100) {
    throw new Error(
      `Version ${version} exceeds the two-digit minor/patch range the build-number formula supports; ` +
        `revise the formula before releasing.`,
    );
  }
  return major * 10000 + minor * 100 + patch;
}

function replaceExactlyOnce(
  content: string,
  pattern: RegExp,
  replacement: string,
  label: string,
): string {
  const matches = content.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(
      `Version stamp for ${label} matched ${matches ? matches.length : 0} times (expected exactly 1). ` +
        `The target file format changed — fix the stamper, do not ship a stale version.`,
    );
  }
  return content.replace(pattern, replacement);
}

export function stampAndroid(content: string, version: string, buildNumber: number): string {
  let out = replaceExactlyOnce(
    content,
    /versionName = "[^"]*"/g,
    `versionName = "${version}"`,
    "android versionName",
  );
  out = replaceExactlyOnce(
    out,
    /versionCode = \d+/g,
    `versionCode = ${buildNumber}`,
    "android versionCode",
  );
  return out;
}

export function stampPlist(content: string, version: string, buildNumber: number): string {
  let out = replaceExactlyOnce(
    content,
    /(<key>CFBundleShortVersionString<\/key>\s*\n\s*<string>)[^<]*(<\/string>)/g,
    `$1${version}$2`,
    "plist CFBundleShortVersionString",
  );
  out = replaceExactlyOnce(
    out,
    /(<key>CFBundleVersion<\/key>\s*\n\s*<string>)[^<]*(<\/string>)/g,
    `$1${buildNumber}$2`,
    "plist CFBundleVersion",
  );
  return out;
}
