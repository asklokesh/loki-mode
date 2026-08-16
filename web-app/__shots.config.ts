import { defineConfig } from '@playwright/test';

/**
 * Deterministic config for the execution-cockpit spec.
 *
 * The existing playwright.config.ts points at a LIVE backend on :57375, so its
 * suite needs a real server and a real session. The cockpit spec mocks every
 * response with page.route(), so it only needs the built bundle served
 * statically -- `vite preview` does that with no new dependency.
 *
 * Kept as a separate config so running it cannot change how the existing suite
 * resolves its baseURL.
 *
 * Run: npx playwright test -c playwright.cockpit.config.ts
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /__shots\.spec\.ts/,
  timeout: 30000,
  retries: 0,
  webServer: {
    // `vite preview` serves dist/ at the configured base (/lab/). The explicit
    // --host is required: without it preview binds to localhost only and the
    // 127.0.0.1 readiness probe never resolves.
    command: 'npx vite preview --port 57380 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:57380/lab/',
    timeout: 60000,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://127.0.0.1:57380/lab',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
