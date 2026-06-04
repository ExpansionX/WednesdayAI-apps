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
