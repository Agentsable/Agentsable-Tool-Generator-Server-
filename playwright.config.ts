import { defineConfig, devices } from "@playwright/test";

const APP_PORT = 5188;
const RUNNER_PORT = 8088;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `vite dev --port ${APP_PORT} --host 127.0.0.1`,
      url: `http://127.0.0.1:${APP_PORT}/`,
      reuseExistingServer: true,
      timeout: 180_000,
      env: { TGS_RUNNER_URL: `http://127.0.0.1:${RUNNER_PORT}` },
    },
    {
      command: `deno run --allow-net --allow-read --allow-env --allow-write server.ts`,
      cwd: "local-deno-server",
      url: `http://127.0.0.1:${RUNNER_PORT}/health`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: { TGS_RUNNER_PORT: String(RUNNER_PORT) },
    },
  ],
});

export { APP_PORT, RUNNER_PORT };
