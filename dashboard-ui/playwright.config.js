import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  timeout: 15000,
  retries: 1,
  use: {
    baseURL: 'http://127.0.0.1:57374',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 2400 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
