import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * The suite runs against a production build with the in-memory store, which is
 * exactly the zero-dependency path a new contributor gets from `pnpm dev`: no
 * database, no queue, no external accounts, and a worker embedded in the web
 * process. That makes the E2E run reproducible in CI without service containers.
 */
const PORT = Number(process.env["E2E_PORT"] ?? 3100);
const baseURL = process.env["E2E_BASE_URL"] ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.e2e\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env["E2E_BASE_URL"]
    ? undefined
    : {
        command: `pnpm --filter @dataflow-studio/web run start -- -p ${PORT}`,
        url: `${baseURL}/api/v1/health`,
        reuseExistingServer: !process.env["CI"],
        timeout: 180_000,
        env: {
          NODE_ENV: "production",
          AUTH_MODE: "local",
          LOG_LEVEL: "warn",
          PORT: String(PORT),
        },
      },
});
