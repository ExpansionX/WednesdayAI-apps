/**
 * Background JSContext entry point. The MentraOS host loads this file
 * inside a per-miniapp JSContext (iOS-JSC / Android-QuickJS) and calls
 * the `registerMiniapp` handler once CONNECT completes.
 *
 * The assistant runs as a `type: "background"` miniapp: it stays alive
 * alongside the foreground standard app, listens for the wake word via
 * on-device or cloud STT, and renders answers on the glasses. All logic
 * lives in AssistantController; the handler only constructs and starts it.
 */

import {registerMiniapp} from "@mentra/miniapp/background"
import type {Channels} from "../shared/channels"
import {AssistantController} from "./AssistantController"

registerMiniapp<Channels>((session) => {
  void new AssistantController(session).start()
})
