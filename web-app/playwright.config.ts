import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:57375',
    headless: true,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:57375',
          localStorage: [
            { name: 'pl_onboarding_complete', value: 'true' },
          ],
        },
      ],
    },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
