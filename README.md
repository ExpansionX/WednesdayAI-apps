# WednesdayAI apps

Native, desktop and glasses client apps for WednesdayAI. These apps connect to a WednesdayAI gateway; the gateway, CLI and plugin SDK live in the [WednesdayAI-core](https://github.com/ExpansionX/WednesdayAI-core) repository.

| App | Path | Description |
| --- | ---- | ----------- |
| iOS | [`apps/ios`](apps/ios/README.md) | iPhone client (super alpha), connects as a `role: node` |
| Android | [`apps/android`](apps/android/README.md) | Kotlin + Jetpack Compose client (extremely alpha) |
| macOS | [`apps/macos`](apps/macos/README.md) | Menu-bar/desktop client with signing and packaging scripts |
| OpenClawKit | [`apps/shared/OpenClawKit`](apps/shared/OpenClawKit) | Shared Swift package used by the iOS and macOS apps |
| Swabble | [`apps/shared/Swabble`](apps/shared/Swabble/README.md) | Speech.framework wake-word hook daemon (macOS 26) |
| Mentra glasses | [`apps/mentra-glass`](apps/mentra-glass/README.md) | WednesdayAI assistant for MentraOS display glasses |

## Contracts: how core changes reach the apps

App protocol code is generated, not hand-edited:

- `apps/shared/contracts/CORE_VERSION` pins the WednesdayAI-core version this repo is synced to.
- `npm run contracts:sync -- --version <semver|latest>` downloads `dist/contracts/*` from the pinned `wednesdayai` npm release into `apps/shared/contracts/` (including the native exec test fixtures under `contracts/fixtures/`), regenerates the Swift protocol models, and stamps app versions to the synced core version.
- `npm run contracts:check` fails if the committed Swift diverges from the synced contracts.
- A weekly bot PR (`contracts-sync.yml`) keeps this repo current with core releases.

Build and test commands:

```bash
npm install                 # npm workspaces, Node >= 24
npm run contracts:check     # verify generated Swift matches synced contracts
npm run test:scripts        # vitest over scripts/ contract and version tests
npm run glass:typecheck && npm run glass:test
npm run ios:ci              # build iOS for the simulator
npm run android:test        # Gradle unit tests
npm run mac:package         # build and sign dist/OpenClaw.app
```

Swift formatting and linting: `npm run format:swift` and `npm run lint:swift`.

The imported WednesdayAI-core sources keep their MIT notice in [`LICENSE-OPENCLAW`](LICENSE-OPENCLAW).

[简体中文](README.zh-CN.md)
