import {defineConfig} from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Logic lives in gateway/ and background/. src/ui/App.tsx is covered by
      // its DOM test (happy-dom, per-file environment); main.tsx only mounts.
      include: ["src/gateway/**/*.ts", "src/background/**/*.ts", "src/ui/App.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/background/index.ts"],
      reporter: ["text", "text-summary"],
      thresholds: {statements: 80, branches: 80, functions: 80, lines: 80},
    },
  },
})
