import {defineConfig} from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Logic lives in gateway/ and background/. The React UI has no DOM test
      // setup, and background/index.ts only registers the controller.
      include: ["src/gateway/**/*.ts", "src/background/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/background/index.ts"],
      reporter: ["text", "text-summary"],
      thresholds: {statements: 80, branches: 80, functions: 80, lines: 80},
    },
  },
})
