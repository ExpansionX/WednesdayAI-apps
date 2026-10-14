# WednesdayAI 应用

WednesdayAI 的原生、桌面与眼镜客户端应用。这些应用连接 WednesdayAI 网关；网关、CLI 与插件 SDK 位于 [WednesdayAI-core](https://github.com/ExpansionX/WednesdayAI-core) 仓库。

| 应用 | 路径 | 说明 |
| --- | ---- | ---- |
| iOS | [`apps/ios`](apps/ios/README.md) | iPhone 客户端（超级 alpha），以 `role: node` 接入 |
| Android | [`apps/android`](apps/android/README.md) | Kotlin + Jetpack Compose 客户端（极度 alpha） |
| macOS | [`apps/macos`](apps/macos/README.md) | 带签名与打包脚本的桌面客户端 |
| OpenClawKit | [`apps/shared/OpenClawKit`](apps/shared/OpenClawKit) | iOS 与 macOS 应用共用的 Swift 包 |
| Swabble | [`apps/shared/Swabble`](apps/shared/Swabble/README.md) | 基于 Speech.framework 的唤醒词 hook 守护进程（macOS 26） |
| Mentra 眼镜 | [`apps/mentra-glass`](apps/mentra-glass/README.md) | 适用于 MentraOS 显示眼镜的 WednesdayAI 助手 |

## 契约：core 的变更如何到达各应用

应用协议代码是生成的，不要手改：

- `apps/shared/contracts/CORE_VERSION` 固定本仓库同步到的 WednesdayAI-core 版本。
- `npm run contracts:sync -- --version <semver|latest>` 从固定版本的 `wednesdayai` npm 发布包下载 `dist/contracts/*` 到 `apps/shared/contracts/`（含 `contracts/fixtures/` 下的原生 exec 测试夹具），重新生成 Swift 协议模型，并把应用版本号盖为同步的 core 版本。
- `npm run contracts:check` 在已提交的 Swift 与同步契约不一致时失败。
- 每周的机器人 PR（`contracts-sync.yml`）保持本仓库与 core 发布同步。

构建与测试命令：

```bash
npm install                 # npm workspaces，Node >= 24
npm run contracts:check     # 校验生成的 Swift 与同步契约一致
npm run test:scripts        # 运行 scripts/ 的契约与版本 vitest 测试
npm run glass:typecheck && npm run glass:test
npm run ios:ci              # 为模拟器构建 iOS
npm run android:test        # Gradle 单元测试
npm run mac:package         # 构建并签名 dist/OpenClaw.app
```

Swift 格式化与静态检查：`npm run format:swift` 与 `npm run lint:swift`。

从 WednesdayAI-core 引入的源码保留其 MIT 声明，见 [`LICENSE-OPENCLAW`](LICENSE-OPENCLAW)。

[English](README.md)
