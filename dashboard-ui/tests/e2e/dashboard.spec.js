// @ts-check
import { test, expect } from '@playwright/test';

// Shared: wait for the dashboard to fully initialize by checking a key component
async function waitForDashboard(page) {
  await page.goto('/');
  // Wait for the first component to render inside shadow DOM (proves JS loaded and executed)
  await expect(page.locator('loki-session-control .panel-title')).toBeVisible({ timeout: 10000 });
}

// ============================================================================
// API Endpoint Tests
// ============================================================================

test.describe('API Endpoints', () => {
  test('GET /health returns healthy', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('healthy');
  });

  test('GET /api/status returns session state', async ({ request }) => {
    const res = await request.get('/api/status');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('status');
    expect(data).toHaveProperty('version');
    expect(data).toHaveProperty('uptime_seconds');
    expect(data).toHaveProperty('phase');
    expect(data).toHaveProperty('iteration');
    expect(data).toHaveProperty('complexity');
    expect(data).toHaveProperty('mode');
    expect(data).toHaveProperty('provider');
    expect(data.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('GET /api/tasks returns array', async ({ request }) => {
    const res = await request.get('/api/tasks');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(data[0]).toHaveProperty('id');
      expect(data[0]).toHaveProperty('title');
      expect(data[0]).toHaveProperty('status');
    }
  });

  test('GET /api/memory/summary returns structure', async ({ request }) => {
    const res = await request.get('/api/memory/summary');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('episodic');
    expect(data).toHaveProperty('semantic');
    expect(data).toHaveProperty('procedural');
    expect(data).toHaveProperty('tokenEconomics');
  });

  test('GET /api/memory/* endpoints return 200', async ({ request }) => {
    for (const path of ['index', 'timeline', 'episodes', 'patterns', 'skills', 'economics']) {
      const res = await request.get(`/api/memory/${path}`);
      expect(res.status()).toBe(200);
    }
  });

  test('GET /api/learning/metrics returns metrics', async ({ request }) => {
    const res = await request.get('/api/learning/metrics');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('totalSignals');
    expect(data).toHaveProperty('signalsByType');
    expect(data).toHaveProperty('signalsBySource');
    expect(typeof data.totalSignals).toBe('number');
  });

  test('GET /api/learning/* endpoints return 200', async ({ request }) => {
    for (const path of ['trends', 'signals', 'aggregation', 'preferences', 'tools']) {
      const res = await request.get(`/api/learning/${path}`);
      expect(res.status()).toBe(200);
    }
  });

  test('GET /api/logs returns array', async ({ request }) => {
    const res = await request.get('/api/logs');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

// ============================================================================
// Dashboard Page Load
// ============================================================================

test.describe('Dashboard Page', () => {
  test('loads without JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await waitForDashboard(page);
    expect(errors).toEqual([]);
  });

  test('has Loki Mode title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Loki Mode/);
  });
});

// ============================================================================
// System Status Sidebar
// ============================================================================

test.describe('System Status Sidebar', () => {
  test('shows System Status with labels and buttons', async ({ page }) => {
    await waitForDashboard(page);

    const sidebar = page.locator('loki-session-control');
    await expect(sidebar).toBeVisible();

    // Title
    await expect(sidebar.locator('.panel-title')).toHaveText('System Status');

    // At least 3 status labels (Mode, Phase, Complexity, etc.)
    const labels = sidebar.locator('.status-label');
    expect(await labels.count()).toBeGreaterThanOrEqual(3);

    // Pause or Resume button, plus Stop
    const hasPause = await sidebar.locator('button#pause-btn').isVisible().catch(() => false);
    const hasResume = await sidebar.locator('button#resume-btn').isVisible().catch(() => false);
    expect(hasPause || hasResume).toBe(true);
    await expect(sidebar.locator('button#stop-btn')).toBeVisible();

    // Connection status
    const connStatus = sidebar.locator('.connection-status');
    await expect(connStatus).toBeVisible();
    const text = await connStatus.textContent();
    expect(text).toMatch(/Connected|Disconnected/);
  });
});

// ============================================================================
// Task Queue Board
// ============================================================================

test.describe('Task Queue', () => {
  test('shows kanban board with 4 columns', async ({ page }) => {
    await waitForDashboard(page);

    const board = page.locator('loki-task-board');
    await expect(board).toBeVisible();
    await expect(board.locator('.board-title')).toHaveText('Task Queue');

    // 4 columns
    const columns = board.locator('.kanban-column');
    await expect(columns).toHaveCount(4);

    const titleTexts = await board.locator('.kanban-column-title').allTextContents();
    expect(titleTexts.some(t => t.includes('Pending'))).toBe(true);
    expect(titleTexts.some(t => t.includes('In Progress'))).toBe(true);
    expect(titleTexts.some(t => t.includes('In Review'))).toBe(true);
    expect(titleTexts.some(t => t.includes('Completed'))).toBe(true);
  });

  test('has refresh and add task buttons', async ({ page }) => {
    await waitForDashboard(page);

    await expect(page.locator('loki-task-board button#refresh-btn')).toBeVisible();
    await expect(page.locator('loki-task-board .add-task-btn').first()).toBeVisible();
  });

  test('shows task cards when tasks exist', async ({ page, request }) => {
    const tasks = await (await request.get('/api/tasks')).json();
    if (tasks.length > 0) {
      await waitForDashboard(page);
      const cards = page.locator('loki-task-board .task-card');
      await expect(cards.first()).toBeVisible();
    }
  });
});

// ============================================================================
// Log Stream
// ============================================================================

test.describe('Log Stream', () => {
  test('renders with terminal controls', async ({ page }) => {
    await waitForDashboard(page);

    const logs = page.locator('loki-log-stream');
    await expect(logs).toBeVisible({ timeout: 10000 });

    // Terminal header
    const header = logs.locator('.terminal-title');
    await expect(header).toBeVisible();

    // Controls
    await expect(logs.locator('button#auto-scroll-btn')).toBeVisible();
    await expect(logs.locator('select#level-select')).toBeVisible();
    await expect(logs.locator('button#clear-btn')).toBeVisible();
    await expect(logs.locator('button#download-btn')).toBeVisible();
  });

  test('shows log entries or empty state', async ({ page }) => {
    await waitForDashboard(page);

    const logs = page.locator('loki-log-stream');
    await expect(logs).toBeVisible({ timeout: 10000 });
    const logLines = logs.locator('.log-line');
    const emptyState = logs.locator('.log-empty');
    const hasContent = (await logLines.count()) > 0 || await emptyState.isVisible().catch(() => false);
    expect(hasContent).toBe(true);
  });
});

// ============================================================================
// Memory Browser
// ============================================================================

test.describe('Memory Browser', () => {
  test('shows 4 tabs with memory categories', async ({ page }) => {
    await waitForDashboard(page);

    const memory = page.locator('loki-memory-browser');
    await expect(memory).toBeVisible();

    // Title
    await expect(memory.locator('.browser-title')).toHaveText('Memory System');

    // 4 tabs
    const tabs = memory.locator('.tab');
    await expect(tabs).toHaveCount(4);
    const tabTexts = await tabs.allTextContents();
    expect(tabTexts.some(t => t.includes('Summary'))).toBe(true);
    expect(tabTexts.some(t => t.includes('Episodes'))).toBe(true);
    expect(tabTexts.some(t => t.includes('Patterns'))).toBe(true);
    expect(tabTexts.some(t => t.includes('Skills'))).toBe(true);

    // Summary cards
    const cardTitles = memory.locator('.summary-card-title');
    const texts = await cardTitles.allTextContents();
    expect(texts.some(t => t.includes('Episodic'))).toBe(true);
    expect(texts.some(t => t.includes('Semantic'))).toBe(true);
    expect(texts.some(t => t.includes('Procedural'))).toBe(true);
  });

  test('has consolidate and refresh buttons', async ({ page }) => {
    await waitForDashboard(page);

    await expect(page.locator('loki-memory-browser button#consolidate-btn')).toBeVisible();
    await expect(page.locator('loki-memory-browser button#refresh-btn')).toBeVisible();
  });
});

// ============================================================================
// Learning Metrics Dashboard
// ============================================================================

test.describe('Learning Metrics', () => {
  test('shows dashboard with filters and cards', async ({ page }) => {
    await waitForDashboard(page);

    const learning = page.locator('loki-learning-dashboard');
    await expect(learning).toBeVisible({ timeout: 10000 });

    // Title
    const title = learning.locator('.dashboard-title');
    await expect(title).toBeVisible();

    // Filter selects
    await expect(learning.locator('select#time-range-select')).toBeVisible();
    await expect(learning.locator('select#signal-type-select')).toBeVisible();
    await expect(learning.locator('select#source-select')).toBeVisible();

    // Summary card with Total Signals
    const cardTitles = learning.locator('.summary-card-title');
    const texts = await cardTitles.allTextContents();
    expect(texts.some(t => t.includes('Total Signals'))).toBe(true);
  });

  test('shows trend chart and signals section', async ({ page }) => {
    await waitForDashboard(page);

    const learning = page.locator('loki-learning-dashboard');
    await expect(learning).toBeVisible({ timeout: 10000 });

    // Trend chart
    const chart = learning.locator('.trend-chart');
    await expect(chart).toBeVisible();

    // Recent signals
    const signalsTitle = learning.locator('.signals-title');
    await expect(signalsTitle).toBeVisible();
  });

  test('shows signal count matching API', async ({ page, request }) => {
    const metrics = await (await request.get('/api/learning/metrics')).json();
    if (metrics.totalSignals > 0) {
      await waitForDashboard(page);
      const counts = page.locator('loki-learning-dashboard .summary-card-count');
      const texts = await counts.allTextContents();
      expect(texts.some(c => c.includes(String(metrics.totalSignals)))).toBe(true);
    }
  });
});

// ============================================================================
// Cross-Component Integration
// ============================================================================

test.describe('Integration', () => {
  test('no API errors during page load', async ({ page }) => {
    const failedRequests = [];
    page.on('response', res => {
      if (res.status() >= 400 && res.url().includes('/api/')) {
        failedRequests.push(`${res.status()} ${res.url()}`);
      }
    });
    await waitForDashboard(page);
    await page.waitForTimeout(2000);
    expect(failedRequests).toEqual([]);
  });

  test('all 6 main components render', async ({ page }) => {
    await waitForDashboard(page);

    for (const tag of ['loki-session-control', 'loki-task-board', 'loki-log-stream', 'loki-memory-browser', 'loki-learning-dashboard', 'loki-council-dashboard']) {
      await expect(page.locator(tag)).toBeVisible({ timeout: 10000 });
    }
  });

  test('refresh button works without crashing', async ({ page }) => {
    await waitForDashboard(page);

    const refreshBtn = page.locator('loki-task-board button#refresh-btn');
    if (await refreshBtn.isVisible()) {
      await refreshBtn.click();
      await page.waitForTimeout(1000);
      await expect(page.locator('loki-task-board')).toBeVisible();
    }
  });
});

// =============================================================================
// Completion Council
// =============================================================================
test.describe('Completion Council', () => {
  test('GET /api/council/state returns council state', async ({ request }) => {
    const response = await request.get('/api/council/state');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty('enabled');
  });

  test('GET /api/council/verdicts returns verdicts', async ({ request }) => {
    const response = await request.get('/api/council/verdicts');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty('verdicts');
    expect(data).toHaveProperty('details');
  });

  test('GET /api/council/convergence returns data points', async ({ request }) => {
    const response = await request.get('/api/council/convergence');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty('dataPoints');
    expect(Array.isArray(data.dataPoints)).toBeTruthy();
  });

  test('GET /api/council/report returns report', async ({ request }) => {
    const response = await request.get('/api/council/report');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty('report');
  });

  test('POST /api/council/force-review creates signal file', async ({ request }) => {
    const response = await request.post('/api/council/force-review');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBeTruthy();
  });

  test('GET /api/agents returns agents array', async ({ request }) => {
    const response = await request.get('/api/agents');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('council dashboard component renders', async ({ page }) => {
    await waitForDashboard(page);
    const council = page.locator('loki-council-dashboard');
    await expect(council).toBeVisible({ timeout: 10000 });

    // Check shadow DOM renders title
    const title = council.locator('.title');
    await expect(title).toContainText('Completion Council');
  });

  test('council dashboard shows tabs', async ({ page }) => {
    await waitForDashboard(page);
    const council = page.locator('loki-council-dashboard');
    await expect(council).toBeVisible({ timeout: 10000 });

    // Check tabs exist
    const tabs = council.locator('.tab');
    await expect(tabs).toHaveCount(4);
  });
});
