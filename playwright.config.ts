import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// E2E runs the real stack on dedicated ports so a concurrently running dev
// instance (web 5173 / backend 8787) is never touched. The backend gets its
// own CONFIG_PATH so tests never read or write the developer's data/config.json.
const backendPort = 8790;
const webPort = 5179;
const e2eConfigPath = join(tmpdir(), "termrail-e2e-config.json");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    // Use the system Chrome so the suite does not depend on downloading a
    // Playwright-managed browser (~200 MB) on a fresh Windows checkout.
    channel: "chrome",
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command:
        "npm run build --workspace @termrail/shared && npm run build --workspace @termrail/server && node server/dist/index.js",
      port: backendPort,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        PORT: String(backendPort),
        CONFIG_PATH: e2eConfigPath,
      },
    },
    {
      command:
        "npm run dev --workspace @termrail/web -- --port 5179 --strictPort",
      port: webPort,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        TERMRAIL_BACKEND_PORT: String(backendPort),
      },
    },
  ],
});
