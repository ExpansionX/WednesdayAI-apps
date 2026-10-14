// Sync client contracts from a WednesdayAI-core release into this repo (ADR 0097).
//
// Two source modes:
//   npm run contracts:sync -- --version <semver|latest>          (packs the `wednesdayai` npm tarball)
//   npm run contracts:sync -- --from-dir <dir> --core-version <semver>
//
// The sync validates the full contract set BEFORE writing anything: a core release that does not
// ship dist/contracts must fail without leaving a half-synced tree behind.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { stampAppVersions } from "./app-versions.ts";

const CONTRACTS_DIR = "apps/shared/contracts";
const TOOL_DISPLAY_TARGET = "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json";
const CONTRACT_FILES = [
  "gateway-protocol.schema.json",
  "host-env-security-policy.json",
  "tool-display.json",
] as const;

type Args = {
  version?: string;
  fromDir?: string;
  coreVersion?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--version":
        args.version = value;
        i++;
        break;
      case "--from-dir":
        args.fromDir = value;
        i++;
        break;
      case "--core-version":
        args.coreVersion = value;
        i++;
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        console.error(
          "Usage: node --import tsx scripts/contracts-sync.ts --version <semver|latest> | " +
            "--from-dir <dir> --core-version <semver>",
        );
        process.exit(1);
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function missingMessage(versionLabel: string, file: string): string {
  return (
    `wednesdayai@${versionLabel} does not ship dist/contracts/${file}; ` +
    "sync needs a core release that includes client contracts (ADR 0097)"
  );
}

function npmViewVersion(requested: string): string {
  const view = spawnSync("npm", ["view", `wednesdayai@${requested}`, "version", "--json"], {
    encoding: "utf8",
  });
  if (view.status !== 0 || !view.stdout) {
    fail(`npm view wednesdayai@${requested} failed: ${view.stderr ?? "unknown error"}`);
  }
  const exact = JSON.parse(view.stdout);
  if (typeof exact !== "string") {
    fail(`npm view wednesdayai@${requested} returned an unexpected value: ${view.stdout.trim()}`);
  }
  return exact;
}

function resolveSourceFromRegistry(
  requested: string,
  tmpDir: string,
): { sourceDir: string; exactVersion: string } {
  const exactVersion = npmViewVersion(requested);
  const pack = spawnSync(
    "npm",
    ["pack", `wednesdayai@${exactVersion}`, "--pack-destination", tmpDir],
    { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" },
  );
  if (pack.status !== 0) {
    fail(`npm pack wednesdayai@${exactVersion} failed`);
  }
  const tarballs = readdirSync(tmpDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    fail(`expected exactly one packed tarball in ${tmpDir}, found: ${tarballs.join(", ")}`);
  }
  // A tarball without dist/contracts makes tar exit non-zero; the validation below then reports
  // the first missing contract file with the canonical message.
  spawnSync("tar", ["-xzf", path.join(tmpDir, tarballs[0]), "-C", tmpDir, "package/dist/contracts"]);
  return { sourceDir: path.join(tmpDir, "package", "dist", "contracts"), exactVersion };
}

function validateContractsDir(sourceDir: string, versionLabel: string): void {
  for (const file of CONTRACT_FILES) {
    if (!existsSync(path.join(sourceDir, file))) {
      fail(missingMessage(versionLabel, file));
    }
  }
  const schema = JSON.parse(readFileSync(path.join(sourceDir, CONTRACT_FILES[0]), "utf8"));
  if (typeof schema["x-protocol-version"] !== "number") {
    fail(missingMessage(versionLabel, CONTRACT_FILES[0]));
  }
}

function applyContracts(sourceDir: string, exactVersion: string): void {
  const repoRoot = path.resolve(".");
  const contractsDir = path.join(repoRoot, CONTRACTS_DIR);
  mkdirSync(contractsDir, { recursive: true });
  mkdirSync(path.dirname(path.join(repoRoot, TOOL_DISPLAY_TARGET)), { recursive: true });
  copyFileSync(path.join(sourceDir, "gateway-protocol.schema.json"), path.join(contractsDir, "gateway-protocol.schema.json"));
  copyFileSync(path.join(sourceDir, "host-env-security-policy.json"), path.join(contractsDir, "host-env-security-policy.json"));
  copyFileSync(path.join(sourceDir, "tool-display.json"), path.join(repoRoot, TOOL_DISPLAY_TARGET));
  writeFileSync(path.join(contractsDir, "CORE_VERSION"), `${exactVersion}\n`);

  const stamped = stampAppVersions(exactVersion);
  console.log(
    `synced wednesdayai@${exactVersion}; copied ${CONTRACT_FILES.length} contracts, stamped ${stamped.length} app version files`,
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.fromDir && !args.coreVersion) {
    fail("--from-dir requires --core-version <semver>");
  }
  if (!args.fromDir && !args.version) {
    fail("pass --version <semver|latest> or --from-dir <dir> --core-version <semver>");
  }
  if (args.fromDir && args.version) {
    fail("pass either --version or --from-dir, not both");
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "contracts-sync-"));
  try {
    let sourceDir: string;
    let exactVersion: string;
    let versionLabel: string;
    if (args.fromDir) {
      sourceDir = path.resolve(args.fromDir);
      exactVersion = args.coreVersion as string;
      versionLabel = exactVersion;
    } else {
      versionLabel = args.version as string;
      const resolved = resolveSourceFromRegistry(versionLabel, tmpDir);
      sourceDir = resolved.sourceDir;
      exactVersion = resolved.exactVersion;
    }

    validateContractsDir(sourceDir, versionLabel);
    applyContracts(sourceDir, exactVersion);

    const gen = spawnSync("npm", ["run", "contracts:gen"], { stdio: "inherit" });
    if (gen.status !== 0) {
      console.error("contracts:gen failed; see output above");
      process.exitCode = gen.status ?? 1;
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
