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
