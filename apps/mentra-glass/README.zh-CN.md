---
audience: user | admin | developer
component: apps/mentra-glass
sources:
  - package.json
  - miniapp.json
  - vitest.config.ts
  - src/shared/channels.ts
  - src/gateway/constants.ts
  - src/gateway/setup-code.ts
  - src/background/AssistantController.ts
  - src/background/tilt.ts
  - src/background/glance.ts
  - src/background/notifications.ts
  - src/background/notificationPresenter.ts
  - src/background/gatewayStt.ts
  - src/background/glassesView.ts
  - scripts/smoke-gateway.ts
generated: 2026-10-14
---

# MentraOS 显示眼镜上的 WednesdayAI

[English](README.md) · [简体中文](README.zh-CN.md)

说出你的 WednesdayAI 唤醒词（例如"Hey Wednesday, what's on my
calendar?"），你自己 WednesdayAI 网关的回答就会以流式方式显示在
MentraOS 显示眼镜上（Even Realities G1/G2、Vuzix、Mentra 显示眼镜）。

这是一个后台（background）Mentra 小应用，可以和其他小应用（Captions、
Translation 等）同时运行，只在回答期间占用显示。

## For Users（用户）

### 环境要求

- 已连接显示眼镜的 Mentra App。
- 一个认识 `openclaw-mentra-node` 客户端的 WednesdayAI 网关
  （带有 mentra node 引导配置文件的 WednesdayAI-core），手机可以通过
  `wss://`（例如 Tailscale Serve）或 tailnet IP 访问。
- 若使用本机（on-device）唤醒监听：需要在
  Mentra App -> Settings -> Transcription 下载离线语音模型。
- 使用眼镜通知：需要 Android 通知权限。

### 安装（侧载）

Mentra Miniapp SDK 应用目前还不能通过 Mentra 小应用商店分发，只能侧载。

```sh
npm install            # 在仓库根目录执行
cd apps/mentra-glass
bun run dev            # 开发模式：在 Mentra App -> Settings ->
                       # Miniapp Developer Settings -> Scan Miniapp QR Code
                       # 扫描打印出的二维码
bun run release        # 独立安装：打印 miniapp://release 二维码
```

在 Mentra App 中停用 "Mentra AI"，保证只有一个助手应答。

### 与网关配对

1. 在网关主机上运行 `wednesdayai qr --client openclaw-mentra-node`。
2. 在 Mentra App 中打开 WednesdayAI 小应用，点击 **Scan setup QR**
   （或粘贴 setup code 后点击 **Pair**）。
3. 状态会显示 **Connected** 和网关的唤醒词。

### 使用唤醒词

说出唤醒词（例如 "Hey Wednesday"）加上你的问题。眼镜会先显示
**Listening…**，然后 **Thinking…**，随后流式显示回答。回答会在 15 秒后
自动清除（显示 **Offline** 时为 4 秒）。如果只说唤醒词，小应用会监听
8 秒等待后续问题。

唤醒词来自网关，管理员修改后会实时更新。唤醒词之后的问题由你的
WednesdayAI 网关转写；如果网关无法转写，则使用 Mentra 的转写结果。

### 抬头速览

- 抬头会显示时间、连接状态和排队通知数，持续 5 秒；低头即隐藏。
- 它不会遮挡回答。
- 眼镜自带的抬头仪表盘也可能出现；MentraOS 无法关闭它。

### 眼镜通知

- 仅支持 Android。
- 在手机菜单中勾选应用。
- 通知一次显示一条，每条按 160 字符分页，每 4 秒翻一页，之后显示
  下一条。
- 最多 20 条通知排队等待；超过后最早的一条会被丢弃。
- 停用 Mentra Notify 以免重复显示。
- 在 iOS 上由眼镜固件自行显示通知。

### 设置

- **Agent**：使用网关默认，或从 `agents.list` 中选择。当网关使用单一
  全局会话时不可选。
- **Wake listening**：本机（私密，需要离线模型）或 Mentra 云
  （更准确）。
- **Question transcription**：WednesdayAI 网关或 Mentra。若网关无法
  转写，则使用 Mentra 的转写结果。
- **Glasses notifications**：选择哪些 Android 应用可以在眼镜上显示
  通知。
- **Mic test**：显示最近的转写内容，检查唤醒检测听到了什么。

### 故障排查

- **"Mentra AI answers instead"（Mentra AI 抢先回答）** — 在 Mentra App
  中停用 Mentra AI，保证只有一个助手监听。
- 不要把 WednesdayAI 固定在眼镜菜单中：在菜单里选择它会停止助手
  （#16）。
- **"No speech heard in 10 s. On-device mode needs the offline model: Mentra
  App → Settings → Transcription."** — 下载离线语音模型，或将唤醒监听
  切换到 Mentra 云。
- **"Insecure gateway URL. Use Tailscale Serve (wss://) or the tailnet IP."**
  — 配对 URL 不是安全的 `wss://` 网关，或 `ws://` 地址不在
  localhost/loopback 和 Tailscale 网段（`100.64.0.0/10`）内。用
  `wednesdayai qr --client openclaw-mentra-node --url <wss-or-tailnet-gateway-url>`
  生成新的配对码并重新扫描。
- **"Pairing needs repair — scan the setup code again"** — 网关拒绝了
  存储的设备令牌。重新扫描新的 setup code。
- **Offline** — 小应用会以退避策略自动重连（最长 15 秒一次）。若持续
  离线，检查网关是否在运行、手机能否访问。

### 隐私说明

配对状态、设备令牌和设置保存在小应用的 session storage 中，当前宿主
使用未加密的 MMKV，而不是手机 Keychain/Keystore。网关 URL 必须是
`wss://`，`ws://` 仅限 localhost/loopback 或 Tailscale 网段。

开启网关转写后，手机在连接期间会在内存中保留最近 1.5 秒的麦克风
音频。只有从唤醒词稍前（最多 1.5 秒的缓冲音频）到问题结束的音频会
发送到你的网关。通知文本不会离开手机。

## For Administrators（管理员）

### 签发配对码

在网关主机上：

```sh
wednesdayai qr --client openclaw-mentra-node
```

这会签发一个携带 `openclaw-mentra-node` 引导配置文件的 setup code。
引导配对会自动批准；引导令牌只能使用一次，首次连接后小应用会改用
持久化的设备令牌。

已知问题（[WednesdayAI-core#1022](https://github.com/ExpansionX/WednesdayAI-core/issues/1022)）：
通过 Tailscale serve 提供的网关上，新设备首次连接不会自动批准。手机会显示
配对错误，网关会列出一个待处理请求。用 `wednesdayai devices approve
<requestId>` 批准它（参见 `wednesdayai devices list`），然后扫描新的
setup code。之后的重连使用设备令牌，无需再次批准。

### 授予的权限范围

该客户端获得一个有界的 operator 配置文件：

- 角色：`operator`
- 权限：`operator.read`、`operator.write`

这是宽泛的 operator 权限，不是最小授权：覆盖聊天、会话读取、agents、
唤醒词以及其他 operator 读写方法（比 user client 的窄会话权限更宽）。
不授予 admin、pairing、approvals、`talk.secrets`，也没有 node 角色。

问题转写使用现有 `operator.write` 权限下的 `talk.session.*`。它需要
网关上有转写 provider；否则用户会看到一次 "WednesdayAI transcription
unavailable"，然后使用 Mentra 的转写结果。

### 管理设备与唤醒词

- 查看/吊销已配对眼镜：`wednesdayai devices`（例如 `devices list`）。
  吊销设备令牌会阻止后续重连——眼镜必须重新配对才能再次连接。它
  **不会**断开已经建立的连接：已连接的眼镜在断开前仍持有会话。要
  结束正在进行的会话，请从小应用界面 Unpair（或停用应用），必要时
  重启网关。
- 实时修改唤醒词：
  `wednesdayai gateway call voicewake.set --params '{"triggers":["wednesday"]}'`。
  已连接的眼镜无需重启即可收到变更。

### 网络

网关必须能被手机通过 `wss://`（例如在网关主机上使用 Tailscale Serve）
或 tailnet IP 访问。`ws://` 仅接受 localhost/loopback 和 Tailscale
`100.64.0.0/10` 网段；其他地址会被小应用拒绝。

### 令牌存储注意事项

设备令牌和设备身份密钥保存在小应用的 session storage 中，当前宿主
使用未加密的 MMKV，而不是 Keychain/Keystore。MentraOS 目前还没有
面向小应用的安全存储 API（已作为 finding issue 上报）。手机丢失时：
先用 `wednesdayai devices` 吊销设备（阻止重连），然后重启网关以断开
仍然存活的会话，因为仅吊销不会终止已有连接。

## For Developers（开发者）

### 目录结构

- `src/gateway/`：可移植的 WednesdayAI 网关客户端（配对、Ed25519 设备
  身份、v3 device-auth 签名、连接/退避、聊天 run 跟踪、session key
  路由）。纯 TypeScript；此处禁止 import `@mentra/*`。
- `src/background/`：唤醒检测（`wake.ts`）、抬头速览（`tilt.ts`、
  `glance.ts`）、通知队列与分页展示（`notifications.ts`、
  `notificationPresenter.ts`）、网关问题转写（`gatewayStt.ts`）、眼镜渲染
  （`glassesView.ts`），以及把 SDK session 接到网关客户端、并决定当前
  由哪一帧（助手、通知、速览）占用眼镜的 `AssistantController.ts`。
- `src/ui/`：手机端设置菜单（配对、agent、唤醒 STT 模式、问题转写
  模式、通知应用、麦克风测试）。
- `src/shared/channels.ts`：类型化的 UI <-> 后台通道。
- `scripts/smoke-gateway.ts`：针对真实网关的免设备冒烟测试。

### 命令

| 命令                                                             | 用途                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm run glass:test`（仓库根目录）或 `npm test`                  | 单元测试（vitest）                                                                                        |
| `npm run glass:coverage`（仓库根目录）或 `npm run test:coverage` | 带 v8 覆盖率的测试；`src/gateway`、`src/background` 和 `src/ui/App.tsx` 阈值 80%（排除测试文件和 `src/background/index.ts`） |
| `npm run glass:typecheck`（仓库根目录）或 `npm run typecheck`    | 对 `src/` 和 `scripts/` 运行 `tsc --noEmit`                                                               |
| `bun run build`                                                  | 在 `dist/` 生成生产包                                                                                     |
| `bun run dev`                                                    | 开发模式，打印侧载二维码                                                                                  |
| `bun run release`                                                | 构建、打包并提供 `miniapp://release` 安装二维码                                                           |
| `bun run smoke:gateway -- --setup-code <code>`                   | 免设备检查：配对、读取唤醒词和 agents、发送 `chat.send`、用存储的设备令牌重连                             |

冒烟测试的 setup code 用
`wednesdayai qr --client openclaw-mentra-node --setup-code-only` 获取。
加上 `--stt-pcm <文件>`（原始 PCM16 LE、16 kHz、单声道）时，工具还会把
该文件通过网关转写并打印 `stt:` 转写结果，端到端验证 `talk.session.*`。
工具会打印 `connected`、唤醒词、agents、每个流式分块一行 `delta`、
回答的 `final:`（或 `error:`）以及 `pong=yes|no`，最后打印
`reconnected via deviceToken`。退出码 0 验证的是配对、RPC 访问、聊天
终止事件路由和设备令牌重连——**不代表**模型回答成功：聊天出错或回答
不含 "pong" 时仍会退出 0。请通过输出中的 `final:` 和 `pong=yes` 确认
回答检查。

### 架构

`AssistantController` 订阅 session 转写（按唤醒监听设置选择带
`forceLocal` 的本机 sherpa STT 或 Mentra 云）。唤醒匹配在转写文本上
进行（`src/background/wake.ts`）；匹配后通过 `GatewayConnection`
（`src/gateway/connection.ts`）向 `src/gateway/sessions.ts` 解析出的会话
发送 `chat.send`，聊天事件更新 `ChatRun`（`src/gateway/chat.ts`），并由
`GlassesView`（`src/background/glassesView.ts`）渲染到眼镜。

问题转写选择网关（`querySttMode: "gateway"`）时，连接期间麦克风音频会
流入 `GatewaySttCapture`（`src/background/gatewayStt.ts`）：它打开一个
携带最近 1.5 秒预滚（pre-roll）的 `talk.session`，把实时音频按不超过
`MAX_APPEND_BYTES`（96,000 字节解码后，约 16 kHz PCM16 的 3 秒）的有序
帧追加，close 后最多等 6 秒拿转写结果，一次采集上限 20 秒。close 前会给
携带过音频的采集补 500 毫秒数字静音，否则中继的端点检测会切掉以语音
结尾的片段。网关转写与
Mentra 转写都到达时以网关为准；网关无法转写时每次 hello 只警告一次
（"WednesdayAI transcription unavailable: …"），改用 Mentra 的转写
结果。

同一时刻只有一帧占用显示：助手帧优先于通知页，通知页优先于抬头速览
（`tilt.ts`、`glance.ts` —— 抬头超过 25° 保持 300 毫秒显示，低头低于
15° 隐藏）。被允许的通知进入 `NotificationPresenter` 队列
（`notifications.ts`、`notificationPresenter.ts`：每页 160 字符，每页
接受后显示 4 秒，队列 20 条），只在没有助手帧时显示。UI 与后台只通过
`src/shared/channels.ts` 中的类型化通道通信（包括逐应用勾选通知白名单
的 `notifications:allow`）；后台在每次变更时推送状态快照。

### 约束与已知限制

- 后台是裸 JavaScript 引擎，不是浏览器也不是 Node：`src/background/`
  和 `src/gateway/` 中不得使用 `window`、`document`、`performance`、
  `crypto.subtle`、`crypto.randomUUID`、`URL`/`URLSearchParams`、Node
  内置模块或 `process`。Ed25519/SHA 来自 `@noble/ed25519` +
  `@noble/hashes`。
- 测试与源码同目录，命名为 `src/**/*.test.ts(x)`（vitest），阈值在
  `vitest.config.ts` 中。覆盖率包含 `src/ui/App.tsx`，由
  `src/ui/App.test.tsx` 覆盖：该文件用 `@vitest-environment happy-dom`
  注释按文件启用 happy-dom（依赖 `@testing-library/react`、
  `@testing-library/dom`、`happy-dom`）。控制器测试只在假计时器下运行：
  其 `flush()` 辅助函数就是 `vi.advanceTimersByTimeAsync(0)`，在真实
  计时器下会抛错。
- 存储键 `wai.identity.v1`、`wai.gateway.v1`、`wai.deviceAuth.v1`、
  `wai.settings.v1`、`wai.notificationApps.v1` 保存在普通 session
  storage 中（见管理员注意事项）。
- 仅支持侧载分发（MentraOS 3.0 不对 Miniapp SDK 应用提供商店分发）。
- 已知限制以 `[finding]` issue 形式记录在
  `ExpansionX/WednesdayAI-apps`（#1–#16）。
