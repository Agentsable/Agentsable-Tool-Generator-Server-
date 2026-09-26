import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
    exclude: ["node_modules/**", "local-deno-server/**"],
    globals: true,
    setupFiles: [],
    // 21 files x ~1s each, yet the parallel run took 942s and 7 workers timed out
    // before starting: every fork re-transformed the graph from scratch. One
    // on-disk cache, shared across workers and runs.
    fsModuleCache: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
