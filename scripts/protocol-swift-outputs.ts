/**
 * Every Swift file `npm run contracts:gen` writes, repo-relative.
 *
 * `contracts:check` diffs exactly this list, and `protocol-swift-outputs.test.ts` fails when the
 * package.json script and this list drift apart. The `apps/shared/OpenClawKit` copy was generated
 * but absent from the check, so a drift in it alone passed the codegen gate.
 */
export const SWIFT_MODEL_OUTPUT_PATHS = [
  "apps/macos/Sources/OpenClawProtocol/GatewayModels.swift",
  "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift",
] as const;
