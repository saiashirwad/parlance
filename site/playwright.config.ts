import { defineConfig, devices } from "@playwright/test";

/** A live deploy to test instead of the local build: `PLAYGROUND_URL=https://... pnpm site:test`. */
const live = process.env.PLAYGROUND_URL;

/** Builds the static site and drives it in Chromium. `pnpm --filter @parlance/site test`. */
export default defineConfig({
  testDir: "tests",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: live ?? "http://localhost:4329", ...devices["Desktop Chrome"], viewport: { width: 1400, height: 860 } },
  webServer: live
    ? undefined
    : {
        // --ignore-lock keeps the server in the foreground, where Playwright can stop it.
        command: "pnpm build && pnpm preview --port 4329 --ignore-lock",
        url: "http://localhost:4329",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
