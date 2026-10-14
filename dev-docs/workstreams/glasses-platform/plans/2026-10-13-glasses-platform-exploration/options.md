---
workstream: glasses-platform
doc_type: plan
title: "Owned Even Hub on Even G2: options and evidence"
status: active
id: 2026-10-13-glasses-platform-options
created: 2026-10-13
updated: 2026-10-13
authors: [agent]
---

# Owned Even Hub on Even G2: options and evidence

Supporting evidence for [plan.md](plan.md). Question: how far does WednesdayAI get toward an "owned Even Hub" (our AI, transcription, memory, home screen, notifications) on Even G2 as a MentraOS miniapp, and where is a MentraOS change needed? Calendar is out of scope.

## Baseline

Platform: iOS phone + Even G2 glasses, MentraOS app replacing the Even app.

Sources:

- MentraOS, **Apache-2.0** (`LICENSE:1-3`), `dev` @ `013ce86b47` (2026-10-12). Correction: the exploration handoff called MentraOS MIT; it is Apache-2.0.
- faceclaw: root license GPLv3 (`faceclaw/LICENSE:1-2`); `evenhub-extensions/` is MIT (`faceclaw/evenhub-extensions/LICENSE:1-3`).
- `openclaw-even-g2-node`: OpenClaw node running as an Even Hub `.ehpk` app.
- OcuClaw: https://www.ocuclaw.com/
- Glassly (closed source): https://glassly.ai
- Apple ANCS spec: https://developer.apple.com/library/archive/documentation/CoreBluetooth/Reference/AppleNotificationCenterServiceSpecification/Specification/Specification.html

Operator observations, 2026-10-13 (ground truth):

- The stock G2 firmware has a user setting for tilt-up to show the dashboard. Tilt-to-dashboard is a firmware feature.
- With the Even app removed, MentraOS drives the stock G2 firmware and overlays its own features on it. Some firmware features can be swapped through the stock protocol. Others need different firmware (faceclaw's path).
- iOS notifications reach the glasses the way they reach a smartwatch: iOS publishes Notification Centre items to paired BLE accessories (ANCS). The Even app added a filter for which apps reach the glasses. The firmware renderer shows one truncated block per notification, has no scroll and no way to see the full message, and flicks through several messages too fast to read.

Path key. Anchors below use the short names; all are MentraOS-repo-relative unless prefixed `faceclaw/`, `openclaw-even-g2-node/` or `WednesdayAI-core/`.

|Short name|Path|
|---|---|
|`G2.swift`|`mobile/modules/bluetooth-sdk/ios/Source/sgcs/G2.swift`|
|`G2.kt`|`mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/sgcs/G2.kt`|
|`G1.swift`|`mobile/modules/bluetooth-sdk/ios/Source/sgcs/G1.swift`|
|`DeviceManager.swift`, `DeviceStore.swift`, `Bridge.swift`|`mobile/modules/bluetooth-sdk/ios/Source/`|
|`NativeNotifications.swift`|`mobile/modules/bluetooth-sdk/ios/Source/NativeNotifications.swift`|
|`SherpaOnnx.swift`|`mobile/modules/bluetooth-sdk/ios/Packages/SherpaOnnx/SherpaOnnx.swift`|
|`LocalMiniappRuntime.ts`, `LocalDisplayManager.ts`, `SceneRenderer.ts`, `DeviceEventRouter.ts`, `MicStateCoordinator.ts`, `PhoneNotificationsSync.ts`|`mobile/modules/engine/src/services/`|
|`settings.ts`, `apps.ts`|`mobile/modules/engine/src/stores/`|
|`even-realities-g2.ts`|`mobile/modules/engine/src/types/capabilities/even-realities-g2.ts`|
|`engine/README.md`|`mobile/modules/engine/README.md`|
|`dashboard.ts`, `display.ts`, `imu.ts`, `phone.ts`, `mic.ts`|`mobile/modules/miniapp/src/modules/`|
|`MantleManager.ts`|`mobile/src/services/MantleManager.ts`|
|`super.tsx`, `glasses-menu.tsx`, `dashboard.tsx`|`mobile/src/app/miniapps/settings/`|
|`NativeNotificationSettings.tsx`|`mobile/src/components/settings/NativeNotificationSettings.tsx`|
|`NotificationListener.kt`|`mobile/modules/crust/android/src/main/java/com/mentra/crust/services/NotificationListener.kt`|
|`JSCRuntime.swift`|`mobile/modules/crust/ios/Source/JSCRuntime.swift`|
|`app.config.ts`|`mobile/app.config.ts`|

## How MentraOS sits on G2 firmware

The stock firmware owns the dashboard (time, widgets, tilt-to-dashboard, menu), notification rendering (ANCS direct from iOS, filtered by the Even app's whitelist), the "Hey Even" wake word, and sleep. MentraOS replaces the Even app on the phone. It configures firmware features over the stock protocol and renders miniapps into one EvenHub page.

|Firmware feature|Swappable from host (stock protocol)|Needs custom firmware|
|---|---|---|
|Dashboard widgets|Widget order + Schedule content today (`G2.swift:3321-3345,1042-1160`). News/Quicklist content needs protocol reverse-engineering.|Fully custom board (faceclaw Glanceboard, `faceclaw/app/apps/glanceboard/board.ts`).|
|Dashboard menu|Miniapp list + launch (`G2.swift:4148-4160,4581-4605`).|—|
|Tilt-to-dashboard|Angle today; the MentraOS angle control always sends switch = on (`G2.swift:4093-4110`). A switch-off builder exists but is unused (`G2.swift:718-745`).|Head-up event to the phone (`faceclaw/app/g2/events.ts:74-79`).|
|Notifications|On/off, popups vs history, 1-30 s duration, DND (`G2.swift:3942-3977`, `NativeNotifications.swift:4-26`).|Text relay to phone (`faceclaw/app/g2/ancs-client.ts:3-7`), scroll/queue renderer, whitelist editing from MentraOS (unsupported, `engine/README.md:195`).|
|"Hey Even"|On/off (`G2.swift:819-833`; disabled on connect at `:1983-1989`), built-in skills (`G2.swift:866-889`).|Suppressing the stock Even AI UI (faceclaw lease, `faceclaw/app/g2/dashboard-controller.ts:854-858`).|
|Sleep|None. [INFERENCE] The retained EvenHub page, heartbeat and IMU keepalive may prevent native low-power idle (`G2.swift:2088,14-19`); unmeasured.|Suspend on screen off (faceclaw, `faceclaw/app/ui/dashboard-settings.ts:679-685`).|

## Verdicts

|Q|Capability|Miniapp today|Confidence|Key evidence|Host change if wanted|Size|Upstream fit|
|---|---|---|---|---|---|---|---|
|Q1|Dashboard / home|**Partial.** The firmware dashboard stays. We can be a menu entry, but selecting it stops a running background app (#16). The hidden `view:"dashboard"` path is unverified on device.|med|#11, #16; [Q1 evidence](#q1-dashboard--home)|(i) widget content API writing a firmware slot (News/Quicklist RE + `dashboard.setContent` implementation); (ii) menu-selected event (#16); (iii) dashboard-owner setting for the view path|(i) ~150-250 LOC + RE, unverified; (ii) ~30-50 LOC; (iii) ~120-160 LOC|medium-high (fills a stubbed SDK API)|
|Q2|Tilt-to-wake|**Partial.** Tilt-to-dashboard is firmware-native and user-settable. Our own glance needs miniapp pitch detection from `onAccel`, because the firmware emits no tilt event. MentraOS cannot turn firmware tilt off, so coexistence with the firmware dashboard needs device testing (V2).|high on "no event"; med on latency and overlap with the firmware dashboard|#12; [Q2 evidence](#q2-tilt-to-wake)|G2 driver pitch estimator setting `headUp`; if V2 shows a conflict, a head-up switch setting|~35 LOC per platform; switch ~20 LOC per platform|high (G1/Nimo parity)|
|Q3|Wake word|**Yes via STT regex (shipped).** No acoustic KWS API is exposed to miniapps. [INFERENCE] A WebAssembly detector is not viable in the current background runtime (JavaScriptCore/QuickJS, no WebAssembly integration).|high on shipped and "not exposed"; med on WASM infeasibility|#3, #4; [Q3 evidence](#q3-wake-word)|(i) forward G2 firmware "Hey Even" `EVEN_AI_WAKE_UP` as a miniapp `wakeword` stream: re-enable it instead of disabling at `G2.swift:1983-1989`, and suppress the stock Even AI UI via CTRL (unverified on stock firmware); (ii) native sherpa-onnx KWS `session.wake` with custom keywords|(i) ~70-100 LOC per platform; (ii) ~150-250 LOC per platform|high (#4 proposal)|
|Q4|Idle blanking|**Partial.** The miniapp blanks via `durationMs`/`render([])`. There is no brightness or auto-off API. Blanking keeps the EvenHub page. [INFERENCE] The retained page and IMU keepalive may prevent native low-power idle; sleep state and battery cost need device measurement.|med|#14; [Q4 evidence](#q4-idle-blanking)|Page suspend-on-blank conflicts with the iOS IMU keepalive. Measure first; no patch proposed.|—|research|
|Q5|Widgets / multi-app|**No** for sharing between apps (one 10 s background lock, full-scene frames). **Yes** inside our own miniapp (compose our widgets in one frame).|high|#5; [Q5 evidence](#q5-widgets--multi-app)|Region compositor in `LocalDisplayManager`/`SceneRenderer` + manifest regions|~400-600 LOC|low-medium; **not pursued**|
|Q6|Messaging notifications|**Android yes** (stop Notify, own renderer). **iOS: no text reaches the phone**, because iOS sends notifications to the glasses over ANCS and the firmware renders them. The host can only tune the firmware renderer (popups vs history-only, 1-30 s, DND), and only globally: history-only applies to every app in the firmware whitelist. Truncation and no-scroll are firmware behaviour. Target iOS UX: gateway mirror (WhatsApp/Telegram) + our queue renderer. Turning firmware popups to history-only is an explicit trade-off: popups from non-mirrored apps stop too.|high|#13; [Q6 evidence](#q6-messaging-notifications)|None possible in host. Text relay needs custom firmware (rejected).|Core work (#8 + mirror)|n/a|

LOC sizes are estimates from reading the code, not prototypes.

## Evidence

### Q1 Dashboard / home

- G2 home is the firmware dashboard: `hasNativeDashboard: true`, `hasNativeNotifications: true` (`even-realities-g2.ts:91-92`). `showDashboard()` tears down the EvenHub page so the firmware dashboard shows (`G2.swift:3289-3306`).
- The host pushes widget order and display settings (`G2.swift:3321-3345`). WidgetType `1=News 2=Stock 3=Schedule 4=Quicklist 5=Health` (`G2.swift:1966-1981`).
- Only Schedule content builders exist (`DashboardProto`, `G2.swift:1042-1160`). News requests are commented out (`G2.swift:1991-2017`).
- Firmware menu: `menu_apps` (`settings.ts:635-640`) → `G2.setDashboardMenu` (`G2.swift:4148-4160`). The user picks entries in `glasses-menu.tsx:25-29`.
- Menu selection arrives as EvenHub cmd 17 → `sendMiniappSelected` (`G2.swift:4581-4605`). `DeviceEventRouter.ts:225-236` stops the app if running, else starts it (#16).
- `dashboard.setContent()` is a stub, "deferred in v1" (`dashboard.ts:1-26`). The runtime answers `NOT_IMPLEMENTED` (`LocalMiniappRuntime.ts:1605-1611`).
- Hidden path: `display.render(…, {view: "dashboard"})` (`display.ts:83,145`). `LocalDisplayManager.ts:316-320` passes dashboard frames straight through without arbitration. Native stores them and shows them when `headUp && contextualDashboard` (`DeviceManager.swift:1225-1240,1380-1400`; `contextual_dashboard` default true at `:234-236`).
- On G2, temple double-tap toggles `headUp` only when `use_native_dashboard` is false (`G2.swift:4804-4815`). It defaults true (`settings.ts:605-610`) and is only toggled in hidden Super Settings (`super.tsx:63-65`). Any app can write the dashboard view; last write wins.

### Q2 Tilt-to-wake

- Tilt-to-dashboard is a firmware feature (operator observation, 2026-10-13). The host only writes `setHeadUpSwitch`/`setHeadUpAngle` (`G2.swift:718-745,4093-4110`). User setting `head_up_angle`, default 45 (`settings.ts:612`; UI `dashboard.tsx:17`). The MentraOS angle control clamps to 0-60 and always sends switch = on (`G2.swift:4093-4110`), so it cannot turn firmware tilt off.
- G2 stock firmware sends no head-up event: none is parsed in `G2.swift`/`G2.kt`. G1 does send one (`G1.swift:1303-1313`).
- faceclaw's `HEAD_UP_EVENT: 12` is a custom-firmware extension (`faceclaw/app/g2/events.ts:74-79`). Stock events include `FOREGROUND_ENTER_EVENT: 4` and `FOREGROUND_EXIT_EVENT: 5` (`faceclaw/app/g2/events.ts:60-68`).
- G2 emits no head-position change from tilt. `headUp` changes only from temple double-tap when `use_native_dashboard` is off (`G2.swift:4804-4815`). That change does reach miniapps: `DeviceStore.swift:187-190` → `Bridge.sendHeadUp` (`Bridge.swift:83-85`) → `DeviceEventRouter.ts:203-208` → `head_position` stream (`LocalMiniappRuntime.ts:6333-6334`).
- `session.imu.onAccel` streams raw `{x,y,z}` in g (`imu.ts:21-28`). Subscribing auto-enables the IMU (`LocalMiniappRuntime.ts:3045-3051`). The IMU needs an active EvenHub page; pace codes 100-1000 (`G2.swift:4070-4090`).
- The host already runs an IMU keepalive at pace 1000 for iOS background BLE (`G2.swift:14-19`).
- [INFERENCE] Miniapp-side pitch detection is feasible without a host change. Sample rate per pace code and end-to-end latency are unmeasured (V2 in plan.md).

### Q3 Wake word

- Shipped: `apps/mentra-glass` detects its wake phrase by regex over Mentra STT transcripts (#10).
- G2 stock firmware has an on-glasses "Hey Even" wake word: sid 0x07 `EVEN_AI_WAKE_UP = 1` (`faceclaw/app/g2/events.ts:22-31`), delivered by stock firmware "regardless of CFW" (`faceclaw/app/ui/gestures.ts:68-71`). The keyword is Even's, not custom.
- MentraOS disables "Hey Even" on connect (`G2.swift:1983-1989`) and only logs sid 0x07 (`G2.swift:4497-4515`; Android `G2.kt:4768-4795`). It has builders for Even AI CONFIG/ASK/CTRL/SKILL (`G2.swift:808-890`).
- The stock firmware also opens its own Even AI UI on wake. faceclaw suppresses it with a custom-firmware lease (`faceclaw/app/g2/dashboard-controller.ts:854-858`). Whether a CTRL EXIT from the host suppresses it on stock firmware is unverified (V4).
- sherpa-onnx keyword-spotter config is vendored but not exposed (`SherpaOnnx.swift:1600-1634`, #4).

### Q4 Idle blanking

- The host clears only on `durationMs` expiry or `render([])` (`LocalDisplayManager.ts:577-584`).
- `clearDisplay()` blanks in place without ending the EvenHub page (`G2.swift:2630-2655`). A heartbeat every 10 s keeps the page alive (`G2.swift:2088`). `showDashboard()` does end the page while BLE stays connected (`G2.swift:3289-3306`).
- IMU keepalive at pace 1000 keeps iOS background BLE alive (`G2.swift:14-19`).
- No miniapp brightness or auto-off API.
- faceclaw: "Suspend EvenHub when screen off … significantly improves battery life" (`faceclaw/app/ui/dashboard-settings.ts:679-685`). On faceclaw this depends on its custom-firmware lease.
- [INFERENCE] The retained page and IMU keepalive may prevent native low-power idle. The firmware's sleep state and the battery cost are unmeasured (V5, #14).

### Q5 Widgets / multi-app

- Background miniapps run concurrently; only `standard` apps are one at a time (`apps.ts:434-441`). The core app is the single running standard app (`apps.ts:643-646`).
- Display: one background lock, 10 s, renewed per render (`LocalDisplayManager.ts:98,415-435`). A second background app gets `blocked`. The core app is blocked while a background app holds the lock (`LocalDisplayManager.ts:382-399`), and is restored on clear or expiry (`:441-470`).
- No region compositor: frames are full-scene replacements (`SceneRenderer.ts:327-331`).

### Q6 Messaging notifications

- Android: full title and body from `NotificationListener.kt:307-400` → `phone_notification` → default renderer `com.mentra.notify` (`MantleManager.ts:20,1229`).
- Miniapps receive the event before the Notify guard (`MantleManager.ts:1182` vs `:1195`) via `session.phone.notifications.on` (`phone.ts:51-53`), permission `READ_NOTIFICATIONS` (`LocalMiniappRuntime.ts:1980`). `onDismissed` is Android-only (`phone.ts:56-68`). So on Android a user can stop Notify and our miniapp still receives every notification.
- iOS + G2: the app connects with `CBConnectPeripheralOptionRequiresANCS` (`G2.swift:3987`). The glasses read ANCS themselves and render natively (operator observation, 2026-10-13). The host gets app identity only, with empty `title`/`content` (`G2.swift:4467-4494`). `engine/README.md:195`: full title/body, firmware app-filter editing and dismissal sync are unsupported on iOS. `PhoneNotificationsSync.ts:74` skips iOS.
- Firmware renderer controls: `notificationCtrl {notifEnable, autoDispEnable, dispTime, avoidDisturbEnable}` (`G2.swift:912-935`), applied at `G2.swift:3942-3977`. Settings are global (`PhoneNotificationsSync.ts:31-43`). Duration 1-30 s; `blockedApps` must be empty for ANCS (`NativeNotifications.swift:4-26`). UI in `NativeNotificationSettings.tsx:22-25,77-99`. The Even app's whitelist is preserved, not editable (`G2.swift:3976-3977`).
- The host can open the firmware notification panel (`showNotificationsPanel`, `G2.swift:3993-4020`) but cannot inject notifications: outbound `NOTIFICATION_IOS` returns errorCode 8 NOT_SUPPORT (`G2.swift:894-900`).
- No SDK scroll or paging API (`display.ts`). Scroll = timed re-renders at a cadence the miniapp chooses. The native reconcile loop is event-driven: each mutation wakes it immediately and bursts coalesce (`G2.swift:2096-2100,2139-2142`); a 100 ms idle tick handles periodic resends and retries (`G2.swift:2110-2135`). Text containers are forced to `isEventCapture: false` (`G2.swift:3469-3484`), so no firmware scroll.
- Truncation: the ANCS client (the glasses firmware) chooses the max attribute length (Apple ANCS spec). faceclaw's custom firmware requests title 128 B and message 512 B (`faceclaw/app/g2/ancs-client.ts:196-201`). The stock limit is unknown (V7).
- iOS full text without firmware changes must come from the gateway. WhatsApp supports personal linked-device mode (`WednesdayAI-core/docs/channels/whatsapp.md:97,125-134`). [INFERENCE] Inbound from senders outside `allowFrom` is dropped before the agent, so a mirror hook is new core work. Telegram is bot-only (`WednesdayAI-core/docs/channels/telegram.md:27-41`); personal chats need an MTProto user session (new). Delivery to the glasses needs #8.

### Runtime and audio facts

- Background miniapp runtime: iOS JavaScriptCore `JSContext` via `@mentra/crust` (`JSCRuntime.swift:56-79,170-172`); Android QuickJS (`mobile/modules/crust/README.md:4-6`). No `WebAssembly`/`wasm` reference anywhere in `mobile/modules/crust`.
- [INFERENCE] WASM KWS inside a background miniapp is not viable: JSC exposes WebAssembly only with JIT, iOS non-WebKit processes lack the JIT entitlement, and interpreted ONNX is too slow.
- Mic: G2 streams LC3 16 kHz mono, 10 ms / 40 B frames (`G2.swift:47,5190-5207`), decoded to PCM in `DeviceManager.swift:431-445`, forwarded to JS as base64 `audio_chunk` (`MantleManager.ts:1330-1348`). SDK `session.mic.onAudioChunk` (`mic.ts:52-54`). Subscribing makes the host send PCM (`MicStateCoordinator.ts:6-8,348-350`).
- Own STT from a miniapp is feasible: stream PCM to a gateway STT endpoint over the existing WebSocket. Cost: continuous mic and ~100 base64 bridge events/s (#15).

## Heavy end and peers

**faceclaw** is the heavy end. It replaces the Even app entirely: its own NativeScript app and BLE stack, custom firmware flashed over BLE (`faceclaw/app/g2/firmware-compat.ts:29`, `REQUIRED_FACECLAW_FIRMWARE_VERSION = 37`; stock validated to 2.3.2 at `:41-42`), and a re-implemented Even Hub runtime for `.ehpk` apps (`faceclaw/app/apps/evenhub/`). Android primary; iOS is a developer beta (`faceclaw/CHANGELOG:99-102`); Wear OS remote (`faceclaw/wear/`). License GPLv3, so no faceclaw code may be copied into MentraOS (Apache-2.0) or this repo. Features: Glanceboard 2x2/2x3 widget grid, head-tilt glance wake (`faceclaw/app/apps/glanceboard/glanceboard-settings.ts:98-105`), "Hey Even" intercept, iOS ANCS full text via firmware relay plus Android listener, sherpa-onnx STT, terminal mirror, navigation, music, Nightscout.

- Borrowable: protocol facts (clean-room reimplementation only), API ideas from the MIT-licensed `evenhub-extensions/`, Glanceboard and glance-on-tilt UX.
- Not borrowable, because each needs custom firmware: the head-up event, ANCS text relay with 512 B messages, the Even AI suppression lease, suspend-on-screen-off.

**openclaw-even-g2-node** runs as an Even Hub WebView app. Pain points:

- MentraOS fixes: background survival (Even Hub WebView state, WebSockets and `audioControl(true)` capture may not survive backgrounding, `openclaw-even-g2-node/docs/platform-notes.md:118-123,169-171`; MentraOS background miniapps run in a native JS runtime, `JSCRuntime.swift:56-79`), and the silent-`AudioContext` keep-alive hack (`openclaw-even-g2-node/src/keep-alive.ts:40-58`).
- MentraOS does not fix: one display owner at a time (MentraOS has its own lock, `LocalDisplayManager.ts:98`); the 576x288 canvas with no font control (`platform-notes.md:36-44`), which is firmware. Exit-dialog lifecycle quirks (`platform-notes.md:184-191`, `src/lifecycle.ts:44-62`) are Even Hub-specific and do not apply.

**OcuClaw** (https://www.ocuclaw.com/): agent plugin + Even Hub `.ehpk`, QR pairing. Borrowable ideas: structured LiveUI schemas, a tiny state glyph ("Speck"), natural text pacing, tap typing.

**Glassly** (https://glassly.ai, closed source): captions with diarization, navigation, notification popups with per-app toggles, custom durations and "hold during miniapps", assistant, terminal mirror, miniapp store, multiple glasses (G1/G2, Z100, Mentra).

|Feature|MentraOS miniapp now|+ upstream PRs|faceclaw (custom firmware)|Even Hub node|Glassly|
|---|---|---|---|---|---|
|Owned home|Partial: glance frame; firmware dashboard stays|Widget content in firmware slots (#11)|Yes (Glanceboard)|No (one app page)|Not stated|
|Tilt wake|Partial: miniapp pitch from `onAccel` (#12)|G2 head-up event from IMU pitch|Yes (firmware head-up event)|Not stated|Not stated|
|Wake word|STT regex (shipped)|"Hey Even" forwarding; sherpa KWS|Yes ("Hey Even" intercept)|Not stated|Not stated|
|Own STT|Yes via `onAudioChunk` (#15)|Same|Yes (sherpa-onnx)|Foreground only (capture may stop in background)|Yes (captions)|
|Notification text on iOS|No (app identity only)|No|Yes (firmware ANCS relay)|Not stated|Not stated|
|Notification scroll/queue|Android yes; iOS after gateway mirror (#13)|Same|Not stated|Not stated|Partial (per-app durations, hold during miniapps)|
|Multi-app widgets|Own frame only|Not pursued|Yes (Glanceboard, own compositor)|No|Not stated|
|Background operation|Yes (background miniapps)|Same|Yes (own app)|Best-effort (WebView may suspend)|Not stated|

## Fork strategy (Q7)

Paths:

- (a) Miniapp only, in `apps/mentra-glass`.
- (b) Upstream PR to `Mentra-Community/MentraOS`, opened from a branch of the `ExpansionX/MentraOS` fork.
- (c) Light fork: a distributed WednesdayAI-branded Mentra app.
- (d) Hard fork / custom firmware.

Merge-burden data (MentraOS `dev` @ `013ce86b47`):

- Repo-wide: 2523 commits in the 30 days to 2026-10-13. `mobile/modules/engine`: 234 commits/30d.
- Per-file commits in 30 days: `G2.swift` 2, `G2.kt` 3, `DeviceManager.swift` 19, `LocalDisplayManager.ts` 7, `LocalMiniappRuntime.ts` 59 (7375 lines), `mobile/modules/miniapp/src/protocol.ts` 17, `MantleManager.ts` 24.
- External PRs: 2 of the last 300 merged PRs came from forks. 15 fork PRs are open; the oldest since 2026-03-23.
- PRs target `dev` (`CONTRIBUTING.md:3`).
- A distributed iOS fork needs its own Apple team, bundle id, Mapbox token and Firebase setup: identity is hard-wired (`app.config.ts:8-36,177-180`; Mapbox at `:71-86`).
- License: Apache-2.0. A fork keeps LICENSE/NOTICE and marks changed files. GPLv3 faceclaw code is excluded.

|Gap|Path|Why|
|---|---|---|
|Q1 home|(a) spike, then (b)|The hidden view path costs nothing to test. The widget content API fills a stubbed SDK call.|
|Q2 tilt|(a) now, (b) later|`onAccel` works today. The driver estimator is ~35 LOC in low-churn files.|
|Q3 wake word|(a) shipped; (b) "Hey Even" forwarding first; sherpa KWS only if a custom keyword is needed|Forwarding is smaller and uses no phone audio until wake.|
|Q4 idle|(a) + measurement|No evidence yet that the cost justifies a host change.|
|Q5 widgets|(a) own-frame composition; (c)/(d) rejected|A compositor is large and unlikely upstream.|
|Q6 notifications|(a) Android + gateway mirror; (d) custom firmware rejected|The host cannot get iOS text on stock firmware.|

## Decision

Chosen: miniapp-first + upstream PRs through the `ExpansionX/MentraOS` fork. Device builds from the fork are personal only and never distributed.

Rejected:

- (c) Distributed light fork: own app identity, engine churn of 234 commits/30d, App Store review.
- (d) Hard fork / faceclaw-style custom firmware: brick risk, breaks stock OTA, GPLv3 code, iOS beta only.
- Region compositor: size vs upstream odds.

## Corrections

1. `WednesdayAI-core/dev-docs/workstreams/mentra-node-client-profile/plans/2026-10-13-mentra-glass-assistant/plan.md:19` says "There is no firmware or native wake-word engine". That holds for Mentra's own path but not for G2 hardware: the firmware has "Hey Even", which MentraOS disables on connect (`G2.swift:1983-1989`).
2. The exploration handoff listed #6 as "own STT". #6 is "Translation and notes via WednesdayAI". Own STT is filed as #15.
3. G2 tilt-up is a firmware feature (operator observation, 2026-10-13), not a missing one. What is missing is a tilt event to the phone.
