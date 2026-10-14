# AGENTS.md

Guidelines for coding agents working in `WednesdayAI-apps`.

## Conventions

- Commits follow Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`), imperative mood.
- Never add AI co-author trailers or "Generated with" lines to commits or PR bodies.
- The user-facing product name is "WednesdayAI".
- Gateway client ids use the `openclaw-` prefix (for example `openclaw-mentra-node`).
- Any change to `README.md` requires the matching change in `README.zh-CN.md`.
- npm workspaces with hoisted installs (`.npmrc`). Run `npm install` from the repo root.
- Engineering docs live in `dev-docs/` and follow the WednesdayAI-core `dev-docs/STRUCTURE.md` layout and frontmatter (workstreams in `dev-docs/workstreams/<name>/`).
- MentraOS host changes go in the `ExpansionX/MentraOS` fork (one `wai/<slug>` branch per hook, tests included, PR to upstream `dev`), never in this repo. See `dev-docs/workstreams/glasses-platform/`.

## Commands

Run from the repo root with npm (this repo has no pnpm):

- `npm run contracts:sync -- --version <semver|latest>` — sync client contracts from a `wednesdayai` core release, regenerate Swift, stamp app versions.
- `npm run contracts:gen` / `npm run contracts:check` — regenerate / verify generated Swift against synced contracts.
- `npm run test:scripts` — vitest over `scripts/**` (contracts, app versions).
- `npm run ios:build|ios:gen|ios:open|ios:run|ios:ci` — iOS app.
- `npm run android:assemble|android:install|android:run|android:test|android:lint|android:lint:android|android:format` — Android app.
- `npm run mac:package` / `npm run mac:restart` / `npm run mac:open` — macOS app.
- `npm run format:swift` / `npm run lint:swift` — Swift formatting and linting.

## Swift

- Swift 6 with SwiftUI. Use `@Observable` and `@Bindable`, not `ObservableObject` (proof: `apps/macos/Sources/OpenClaw/AppState.swift`).

## Generated files

Never hand-edit `apps/shared/contracts/*`, `GatewayModels.swift`, `HostEnvSecurityPolicy.generated.swift`, or app version fields (Info.plist, `project.yml`, Gradle version fields); run `npm run contracts:sync -- --version "$(cat apps/shared/contracts/CORE_VERSION)"` instead (or `-- --version <semver|latest>` to move to a different core release).

## Dependency pins

`apps/shared/Swabble/Package.swift` pins `steipete/commander` to exactly 0.2.1 because Peekaboo → AXorcist 0.1.0 requires Commander 0.2.1 in the macOS app graph. Do not bump it until that constraint lifts.

## Workspaces

| Path                     | Purpose                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| apps/mentra-glass | MentraOS background miniapp: WednesdayAI assistant on display glasses (bun build, vitest + coverage) |
| apps/ios | iPhone client (XcodeGen project; `npm run ios:build` / `ios:ci`) |
| apps/android | Kotlin + Jetpack Compose client (Gradle; `npm run android:*`) |
| apps/macos | Menu-bar/desktop client (SwiftPM; `npm run mac:package` / `mac:restart`) |
| apps/shared/OpenClawKit | Shared Swift package for iOS and macOS |
| apps/shared/Swabble | Wake-word daemon; lives at `apps/shared/Swabble` (moved from core `Swabble/`) |
| apps/shared/contracts | Synced core client contracts: `CORE_VERSION`, gateway protocol schema, host-env policy |
