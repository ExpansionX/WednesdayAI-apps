/**
 * Production build script — two-output bundle.
 *
 * Two-layer miniapps ship TWO bundles in one zip:
 *   - dist/background/index.js     — JSContext entry, no DOM
 *   - dist/ui/index.html + assets  — WebView entry, full DOM
 *
 * Bun.build() handles both. The background bundle uses `format: "iife"`
 * because JSC + Zipline/QuickJS evaluate it as a classic script — any
 * top-level ESM `export` is a SyntaxError there. `@mentra/miniapp/background`
 * is bundled in (not external) because the JSContext has no module
 * resolver; the host's polyfill installs `__dispatch`/`__deliver` but
 * does NOT provide the SDK surface. The UI bundle uses target: "browser"
 * with no externals.
 *
 * Build-time env vars: any `MENTRA_PUBLIC_*` key in your shell or
 * miniapp-local `.env` gets inlined into both bundles via define.
 * Anything inlined into the UI bundle is visible in WebView network
 * requests and source maps — secrets MUST live behind your own backend
 * rather than in MENTRA_PUBLIC_*.
 *
 * Add bundler plugins (Tailwind, Vue, etc.) by pushing them into the
 * matching `plugins` array. For example, with Tailwind v4 (UI side only):
 *
 *     const tailwind = (await import("bun-plugin-tailwind")).default
 *     uiBuild.plugins.push(tailwind)
 *
 * Output goes to ./dist with the shape `mentra-miniapp release` expects.
 */

import {rm} from "fs/promises"
import {backgroundRuntimeGuardPlugin, reactSingletonPlugin} from "@mentra/miniapp-cli/build-helpers"

const distDir = "./dist"

// Wipe dist/ so old chunks don't accumulate across builds.
await rm(distDir, {recursive: true, force: true})

// Pick up MENTRA_PUBLIC_* env vars from the shell / .env. Bun loads .env
// from cwd automatically; we just need to forward the keys to define.
const define: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("MENTRA_PUBLIC_") && typeof v === "string") {
    define[`process.env.${k}`] = JSON.stringify(v)
  }
}
// The background reads MENTRA_PUBLIC_TRACE (src/background/trace.ts). Always
// inline it: an unset key would leave a bare `process` reference, which
// throws in the background JSContext. `pack`/`release` build with
// NODE_ENV=production; a trace flag left in the shell or .env must not ship
// transcripts to the console there.
const traceOn = process.env.NODE_ENV !== "production" && process.env.MENTRA_PUBLIC_TRACE === "1"
define["process.env.MENTRA_PUBLIC_TRACE"] = JSON.stringify(traceOn ? "1" : "")
// Pin NODE_ENV so an ambient-unset build (plain `npm run build`) does not
// bake React's development build into the UI bundle. Bun defaults
// process.env.NODE_ENV to "development" at build time; `pack`/`release`
// set NODE_ENV=production and `mentra-miniapp dev` inherits the ambient
// value, so an explicit NODE_ENV=development still yields dev React.
define["process.env.NODE_ENV"] = JSON.stringify(process.env.NODE_ENV ?? "production")

const backgroundResult = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: `${distDir}/background`,
  target: "browser",
  format: "iife",
  plugins: [backgroundRuntimeGuardPlugin(import.meta.url)],
  minify: false,
  define,
})

if (!backgroundResult.success) {
  console.error("Background build failed:")
  for (const log of backgroundResult.logs) console.error(log)
  process.exit(1)
}

const uiResult = await Bun.build({
  entrypoints: ["./src/ui/index.html"],
  outdir: `${distDir}/ui`,
  target: "browser",
  plugins: [reactSingletonPlugin(import.meta.url)],
  minify: true,
  define,
})

if (!uiResult.success) {
  console.error("UI build failed:")
  for (const log of uiResult.logs) console.error(log)
  process.exit(1)
}

// Silence on success — the dev-server's `reload →` line is the
// developer-facing confirmation. Failures already print via the
// .success branches above.
