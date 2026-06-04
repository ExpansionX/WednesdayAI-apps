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
