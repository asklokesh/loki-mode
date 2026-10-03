// CPE-23: headless Playwright for the Control Plane UI. The spec starts its own loopback stub API
// (fixtures only, never a provider) and stops only the server it started. Run from packages/control-plane:
//   bunx playwright test -c ui/playwright.config.ts test/e2e/cp-ui.spec.ts
import { defineConfig } from "@playwright/test";

process.env.LOKI_NO_BROWSER = "1";

export default defineConfig({
  testDir: "../test/e2e",
  testMatch: "cp-ui.spec.ts",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: { headless: true, browserName: "chromium", colorScheme: "light" },
});
