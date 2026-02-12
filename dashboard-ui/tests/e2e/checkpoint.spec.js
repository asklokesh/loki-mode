// @ts-check
import { test, expect } from '@playwright/test';

// Shared: wait for the dashboard to fully initialize by checking a key component
async function waitForDashboard(page) {
  await page.goto('/');
  await expect(page.locator('loki-session-control .panel-title')).toBeVisible({ timeout: 10000 });
}

// ============================================================================
// Checkpoint API Endpoint Tests
// ============================================================================

test.describe('Checkpoint API Endpoints', () => {
  test('GET /api/checkpoints returns 200 with array', async ({ request }) => {
    const res = await request.get('/api/checkpoints');
    expect(res.status()).toBe(200);
    const data = await res.json();
    // Response should be an array or an object with a checkpoints array
    const checkpoints = Array.isArray(data) ? data : data.checkpoints;
    expect(Array.isArray(checkpoints)).toBe(true);
  });

  test('GET /api/checkpoints with limit param works', async ({ request }) => {
    const res = await request.get('/api/checkpoints?limit=5');
    expect(res.status()).toBe(200);
    const data = await res.json();
    const checkpoints = Array.isArray(data) ? data : data.checkpoints;
    expect(Array.isArray(checkpoints)).toBe(true);
    expect(checkpoints.length).toBeLessThanOrEqual(5);
  });

  test('GET /api/checkpoints/{id} returns 404 for nonexistent', async ({ request }) => {
    const res = await request.get('/api/checkpoints/nonexistent-checkpoint-id-999');
    expect(res.status()).toBe(404);
  });

  test('GET /api/checkpoints/{id} rejects path traversal', async ({ request }) => {
    const res = await request.get('/api/checkpoints/../../etc/passwd');
    // Should return 404 or 400, never 200
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('POST /api/checkpoints creates checkpoint successfully', async ({ request }) => {
    const res = await request.post('/api/checkpoints', {
      data: { message: 'E2E test checkpoint' },
    });
    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('created_at');
  });

  test('POST /api/checkpoints with message field works', async ({ request }) => {
    const testMessage = 'Checkpoint with specific message for E2E';
    const res = await request.post('/api/checkpoints', {
      data: { message: testMessage },
    });
    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.message).toBe(testMessage);
  });
});

// ============================================================================
// Checkpoint Component Rendering Tests
// Requires: loki-checkpoint-viewer component registered in the dashboard
// ============================================================================

test.describe('Checkpoint Component', () => {
  test('checkpoint section accessible via sidebar navigation', async ({ page }) => {
    await waitForDashboard(page);

    // Click the checkpoint nav button
    const navBtn = page.locator('.nav-link[data-section="checkpoint"]');
    await expect(navBtn).toBeVisible();
    await navBtn.click();

    // Verify the checkpoint section is visible
    const section = page.locator('#page-checkpoint');
    await expect(section).toBeVisible({ timeout: 5000 });
  });

  test('component renders with header and create button', async ({ page }) => {
    await waitForDashboard(page);

    const viewer = page.locator('loki-checkpoint-viewer');
    await expect(viewer).toBeVisible({ timeout: 10000 });

    // Header title inside shadow DOM
    const title = viewer.locator('.title');
    await expect(title).toContainText('Checkpoints');

    // Count badge
    const badge = viewer.locator('.count-badge');
    await expect(badge).toBeVisible();

    // Create Checkpoint button
    const createBtn = viewer.locator('#create-btn');
    await expect(createBtn).toBeVisible();
    await expect(createBtn).toContainText('Create Checkpoint');
  });

  test('empty state shown when no checkpoints', async ({ page, request }) => {
    // Check if there are no checkpoints via API
    const res = await request.get('/api/checkpoints');
    const data = await res.json();
    const checkpoints = Array.isArray(data) ? data : (data.checkpoints || []);

    if (checkpoints.length === 0) {
      await waitForDashboard(page);
      const viewer = page.locator('loki-checkpoint-viewer');
      await expect(viewer).toBeVisible({ timeout: 10000 });

      const emptyState = viewer.locator('.empty-state');
      await expect(emptyState).toBeVisible();
      await expect(emptyState).toContainText('No checkpoints yet');
    }
  });

  test('create checkpoint button toggles inline form', async ({ page }) => {
    await waitForDashboard(page);

    const viewer = page.locator('loki-checkpoint-viewer');
    await expect(viewer).toBeVisible({ timeout: 10000 });

    // Click Create Checkpoint button
    const createBtn = viewer.locator('#create-btn');
    await createBtn.click();

    // Form should appear
    const form = viewer.locator('.create-form');
    await expect(form).toBeVisible({ timeout: 3000 });

    const input = viewer.locator('#checkpoint-message');
    await expect(input).toBeVisible();

    const submitBtn = viewer.locator('#submit-create-btn');
    await expect(submitBtn).toBeVisible();

    // Click again to cancel
    const cancelBtn = viewer.locator('#create-btn');
    await cancelBtn.click();

    // Form should disappear
    await expect(form).not.toBeVisible({ timeout: 3000 });
  });
});
