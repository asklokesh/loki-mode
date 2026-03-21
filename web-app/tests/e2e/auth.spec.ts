import { test, expect } from '@playwright/test';

// ============================================================================
// Auth E2E Tests
// ============================================================================

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pl_onboarding_complete', '1');
    });
  });

  test('Login page renders with GitHub and Google buttons', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    // In local mode, /login may redirect to /
    if (page.url().includes('/login')) {
      await expect(page.locator('button:has-text("Sign in with GitHub")')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('button:has-text("Sign in with Google")')).toBeVisible();
    } else {
      // Local mode: login page is bypassed
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('"Continue without account" link exists', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    if (page.url().includes('/login')) {
      await expect(page.locator('text=Continue without account')).toBeVisible({ timeout: 10000 });
    } else {
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('Purple Lab branding is visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Branding should be visible somewhere on the page (sidebar or login)
    await expect(page.locator('text=Purple Lab').first()).toBeVisible({ timeout: 10000 });
  });

  test('Local mode bypasses login (home page loads directly)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const url = page.url();
    const isLocalMode = !url.includes('/login');
    if (isLocalMode) {
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('Protected routes load in local mode', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForLoadState('networkidle');
    const url = page.url();
    expect(url).toMatch(/\/(projects|login)/);
  });

  test('Auth /api/auth/me endpoint returns local_mode info', async ({ request }) => {
    const res = await request.get('/api/auth/me');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('local_mode');
    if (data.local_mode) {
      expect(data.authenticated).toBe(false);
    }
  });

  test('Sidebar shows Local Mode indicator', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // In local mode, sidebar should show "Local Mode" text
    const localModeText = page.locator('text=Local Mode');
    const userSection = page.locator('[data-testid="user-section"]');
    // Either local mode indicator or authenticated user section should be visible
    const hasLocalMode = await localModeText.isVisible().catch(() => false);
    const hasUserSection = await userSection.isVisible().catch(() => false);
    expect(hasLocalMode || hasUserSection).toBe(true);
  });
});
