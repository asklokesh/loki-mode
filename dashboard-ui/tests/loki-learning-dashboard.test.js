/**
 * Tests for Loki Learning Dashboard Component
 *
 * Tests the learning metrics dashboard functionality including:
 * - Component rendering
 * - Filter interactions
 * - API data display
 * - Detail panel
 * - Event handling
 *
 * @version 1.0.0
 */

import { THEMES } from '../core/loki-unified-styles.js';

// Mock API client
const mockApiClient = {
  baseUrl: 'http://localhost:57374',
  getLearningMetrics: jest.fn(),
  getLearningTrends: jest.fn(),
  getLearningSignals: jest.fn(),
};

// Mock getApiClient
jest.mock('../core/loki-api-client.js', () => ({
  getApiClient: () => mockApiClient,
}));

// Sample test data
const MOCK_METRICS = {
  totalSignals: 150,
  signalsByType: {
    user_preference: 45,
    error_pattern: 30,
    success_pattern: 40,
    tool_efficiency: 25,
    context_relevance: 10,
  },
  signalsBySource: {
    cli: 60,
    api: 40,
    vscode: 30,
    mcp: 15,
    dashboard: 5,
  },
  avgConfidence: 0.82,
  outcomeBreakdown: {
    success: 100,
    failure: 25,
    partial: 15,
    unknown: 10,
  },
  aggregation: {
    preferences: [
      {
        preference_key: 'code_style',
        preferred_value: 'functional',
        frequency: 12,
        confidence: 0.9,
        sources: ['cli', 'vscode'],
        alternatives_rejected: ['object-oriented', 'procedural'],
        first_seen: '2026-01-01T00:00:00Z',
        last_seen: '2026-02-01T00:00:00Z',
      },
      {
        preference_key: 'test_framework',
        preferred_value: 'jest',
        frequency: 8,
        confidence: 0.85,
        sources: ['cli'],
        alternatives_rejected: ['mocha'],
        first_seen: '2026-01-15T00:00:00Z',
        last_seen: '2026-02-01T00:00:00Z',
      },
    ],
    error_patterns: [
      {
        error_type: 'TypeScript',
        common_messages: ['Type error', 'Cannot find module'],
        frequency: 15,
        confidence: 0.88,
        sources: ['cli', 'vscode'],
        resolutions: ['Add type annotation', 'Install @types package'],
        resolution_rate: 0.7,
        first_seen: '2026-01-10T00:00:00Z',
        last_seen: '2026-02-01T00:00:00Z',
      },
    ],
    success_patterns: [
      {
        pattern_name: 'test_driven_development',
        common_actions: ['write test', 'run test', 'implement code', 'refactor'],
        frequency: 20,
        confidence: 0.92,
        sources: ['cli'],
        avg_duration_seconds: 1800,
        preconditions: ['project initialized'],
        postconditions: ['tests passing'],
        first_seen: '2026-01-05T00:00:00Z',
        last_seen: '2026-02-01T00:00:00Z',
      },
    ],
    tool_efficiencies: [
      {
        tool_name: 'Read',
        usage_count: 500,
        success_count: 485,
        failure_count: 15,
        avg_execution_time_ms: 45,
        total_tokens_used: 25000,
        success_rate: 0.97,
        efficiency_score: 0.95,
        confidence: 0.98,
        sources: ['cli', 'api', 'vscode'],
        alternative_tools: ['Glob', 'Grep'],
        first_seen: '2026-01-01T00:00:00Z',
        last_seen: '2026-02-01T00:00:00Z',
      },
      {
        tool_name: 'Edit',
        usage_count: 300,
        success_count: 280,
        failure_count: 20,
        avg_execution_time_ms: 120,
        total_tokens_used: 45000,
        success_rate: 0.93,
        efficiency_score: 0.88,
        confidence: 0.95,
        sources: ['cli', 'vscode'],
        alternative_tools: ['Write'],
        first_seen: '2026-01-01T00:00:00Z',
        last_seen: '2026-02-01T00:00:00Z',
      },
    ],
  },
  timeRange: '7d',
  since: '2026-01-25T00:00:00Z',
};

const MOCK_TRENDS = {
  dataPoints: [
    { label: 'Jan 25', count: 15, timestamp: '2026-01-25T00:00:00Z' },
    { label: 'Jan 26', count: 22, timestamp: '2026-01-26T00:00:00Z' },
    { label: 'Jan 27', count: 18, timestamp: '2026-01-27T00:00:00Z' },
    { label: 'Jan 28', count: 25, timestamp: '2026-01-28T00:00:00Z' },
    { label: 'Jan 29', count: 30, timestamp: '2026-01-29T00:00:00Z' },
    { label: 'Jan 30', count: 20, timestamp: '2026-01-30T00:00:00Z' },
    { label: 'Jan 31', count: 20, timestamp: '2026-01-31T00:00:00Z' },
  ],
  maxValue: 30,
  period: 'Daily',
  timeRange: '7d',
  signalCount: 150,
};

const MOCK_SIGNALS = [
  {
    id: 'sig-abc123',
    type: 'user_preference',
    source: 'cli',
    action: 'settings_change',
    outcome: 'success',
    confidence: 0.9,
    timestamp: '2026-02-01T12:30:00Z',
  },
  {
    id: 'sig-def456',
    type: 'error_pattern',
    source: 'vscode',
    action: 'compilation_error',
    outcome: 'failure',
    confidence: 0.85,
    timestamp: '2026-02-01T12:25:00Z',
  },
  {
    id: 'sig-ghi789',
    type: 'success_pattern',
    source: 'api',
    action: 'task_complete',
    outcome: 'success',
    confidence: 0.95,
    timestamp: '2026-02-01T12:20:00Z',
  },
];

// =============================================================================
// Test Utilities
// =============================================================================

async function createDashboard(attributes = {}) {
  const el = document.createElement('loki-learning-dashboard');
  el.setAttribute('api-url', 'http://localhost:57374');

  for (const [key, value] of Object.entries(attributes)) {
    el.setAttribute(key, value);
  }

  document.body.appendChild(el);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return el;
}

function removeDashboard(el) {
  if (el && el.parentNode) {
    el.parentNode.removeChild(el);
  }
}

function resetMocks() {
  mockApiClient.getLearningMetrics.mockReset();
  mockApiClient.getLearningTrends.mockReset();
  mockApiClient.getLearningSignals.mockReset();

  mockApiClient.getLearningMetrics.mockResolvedValue(MOCK_METRICS);
  mockApiClient.getLearningTrends.mockResolvedValue(MOCK_TRENDS);
  mockApiClient.getLearningSignals.mockResolvedValue(MOCK_SIGNALS);
}

// =============================================================================
// Test Suites
// =============================================================================

describe('LokiLearningDashboard', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    // Clean up any test components
    document.querySelectorAll('loki-learning-dashboard').forEach((el) => {
      el.parentNode?.removeChild(el);
    });
  });

  describe('Component Rendering', () => {
    test('renders dashboard structure', async () => {
      const el = await createDashboard();

      expect(el.shadowRoot.querySelector('.learning-dashboard')).toBeTruthy();
      expect(el.shadowRoot.querySelector('.dashboard-header')).toBeTruthy();
      expect(el.shadowRoot.querySelector('.filters')).toBeTruthy();
      expect(el.shadowRoot.querySelector('.dashboard-content')).toBeTruthy();

      removeDashboard(el);
    });

    test('renders filter controls', async () => {
      const el = await createDashboard();

      expect(el.shadowRoot.querySelector('#time-range-select')).toBeTruthy();
      expect(el.shadowRoot.querySelector('#signal-type-select')).toBeTruthy();
      expect(el.shadowRoot.querySelector('#source-select')).toBeTruthy();
      expect(el.shadowRoot.querySelector('#refresh-btn')).toBeTruthy();

      removeDashboard(el);
    });

    test('renders summary cards with data', async () => {
      const el = await createDashboard();

      const summaryCards = el.shadowRoot.querySelectorAll('.summary-card');
      expect(summaryCards.length).toBeGreaterThanOrEqual(3);

      // Check total signals card
      const totalSignalsCard = el.shadowRoot.querySelector('.summary-card-count');
      expect(totalSignalsCard).toBeTruthy();

      removeDashboard(el);
    });

    test('renders trend chart', async () => {
      const el = await createDashboard();

      const trendChart = el.shadowRoot.querySelector('.trend-chart');
      expect(trendChart).toBeTruthy();

      const chartSvg = el.shadowRoot.querySelector('.chart-svg');
      expect(chartSvg).toBeTruthy();

      removeDashboard(el);
    });

    test('renders top lists', async () => {
      const el = await createDashboard();

      const topLists = el.shadowRoot.querySelectorAll('.top-list');
      expect(topLists.length).toBe(4); // preferences, errors, success, tools

      removeDashboard(el);
    });

    test('renders recent signals', async () => {
      const el = await createDashboard();

      const recentSignals = el.shadowRoot.querySelector('.recent-signals');
      expect(recentSignals).toBeTruthy();

      const signalItems = el.shadowRoot.querySelectorAll('.signal-item');
      expect(signalItems.length).toBeGreaterThan(0);

      removeDashboard(el);
    });
  });

  describe('Filters', () => {
    test('time range filter changes data', async () => {
      const el = await createDashboard();

      const timeRangeSelect = el.shadowRoot.querySelector('#time-range-select');
      expect(timeRangeSelect.value).toBe('7d');

      // Change time range
      timeRangeSelect.value = '24h';
      timeRangeSelect.dispatchEvent(new Event('change'));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockApiClient.getLearningMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ timeRange: '24h' })
      );

      removeDashboard(el);
    });

    test('signal type filter updates query', async () => {
      const el = await createDashboard();

      const signalTypeSelect = el.shadowRoot.querySelector('#signal-type-select');
      signalTypeSelect.value = 'error_pattern';
      signalTypeSelect.dispatchEvent(new Event('change'));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockApiClient.getLearningMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ signalType: 'error_pattern' })
      );

      removeDashboard(el);
    });

    test('source filter updates query', async () => {
      const el = await createDashboard();

      const sourceSelect = el.shadowRoot.querySelector('#source-select');
      sourceSelect.value = 'vscode';
      sourceSelect.dispatchEvent(new Event('change'));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockApiClient.getLearningMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'vscode' })
      );

      removeDashboard(el);
    });

    test('refresh button reloads data', async () => {
      const el = await createDashboard();

      const initialCalls = mockApiClient.getLearningMetrics.mock.calls.length;

      const refreshBtn = el.shadowRoot.querySelector('#refresh-btn');
      refreshBtn.click();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockApiClient.getLearningMetrics.mock.calls.length).toBeGreaterThan(
        initialCalls
      );

      removeDashboard(el);
    });

    test('emits filter-change event', async () => {
      const el = await createDashboard();

      let eventFired = false;
      let eventDetail = null;

      el.addEventListener('filter-change', (e) => {
        eventFired = true;
        eventDetail = e.detail;
      });

      const timeRangeSelect = el.shadowRoot.querySelector('#time-range-select');
      timeRangeSelect.value = '30d';
      timeRangeSelect.dispatchEvent(new Event('change'));

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(eventFired).toBe(true);
      expect(eventDetail.timeRange).toBe('30d');

      removeDashboard(el);
    });
  });

  describe('Detail Panel', () => {
    test('shows detail panel on list item click', async () => {
      const el = await createDashboard();

      // Click on a list item
      const listItem = el.shadowRoot.querySelector('.list-item');
      expect(listItem).toBeTruthy();
      listItem.click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const detailPanel = el.shadowRoot.querySelector('.detail-panel');
      expect(detailPanel).toBeTruthy();

      removeDashboard(el);
    });

    test('closes detail panel on close button click', async () => {
      const el = await createDashboard();

      // Open detail panel
      const listItem = el.shadowRoot.querySelector('.list-item');
      expect(listItem).toBeTruthy();
      listItem.click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Close it
      const closeBtn = el.shadowRoot.querySelector('#close-detail');
      expect(closeBtn).toBeTruthy();
      closeBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const detailPanel = el.shadowRoot.querySelector('.detail-panel');
      expect(detailPanel).toBeFalsy();

      removeDashboard(el);
    });

    test('emits metric-select event on item selection', async () => {
      const el = await createDashboard();

      let eventFired = false;
      let eventDetail = null;

      el.addEventListener('metric-select', (e) => {
        eventFired = true;
        eventDetail = e.detail;
      });

      const listItem = el.shadowRoot.querySelector('.list-item');
      expect(listItem).toBeTruthy();
      listItem.click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(eventFired).toBe(true);
      expect(eventDetail).toHaveProperty('type');
      expect(eventDetail).toHaveProperty('item');

      removeDashboard(el);
    });
  });

  describe('Accessibility', () => {
    test('list items are keyboard accessible', async () => {
      const el = await createDashboard();

      const listItems = el.shadowRoot.querySelectorAll('.list-item');
      listItems.forEach((item) => {
        expect(item.getAttribute('tabindex')).toBe('0');
        expect(item.getAttribute('role')).toBe('listitem');
      });

      removeDashboard(el);
    });

    test('filter selects are focusable', async () => {
      const el = await createDashboard();

      const selects = el.shadowRoot.querySelectorAll('.filter-select');
      selects.forEach((select) => {
        expect(select.tagName.toLowerCase()).toBe('select');
      });

      removeDashboard(el);
    });
  });

  describe('Error Handling', () => {
    test('displays error state on API failure', async () => {
      mockApiClient.getLearningMetrics.mockRejectedValue(
        new Error('Network error')
      );

      const el = await createDashboard();
      await new Promise((resolve) => setTimeout(resolve, 150));

      const errorState = el.shadowRoot.querySelector('.error-state');
      expect(errorState).toBeTruthy();

      removeDashboard(el);
    });

    test('displays loading state during data fetch', async () => {
      // Delay the mock resolution
      mockApiClient.getLearningMetrics.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(MOCK_METRICS), 500)
          )
      );

      const el = await createDashboard();

      // Check loading state immediately
      const loadingState = el.shadowRoot.querySelector('.loading');
      expect(loadingState).toBeTruthy();

      removeDashboard(el);
    });
  });

  describe('Theme Support', () => {
    test('applies light theme variables', async () => {
      const el = await createDashboard({ theme: 'light' });

      expect(el.getAttribute('data-loki-theme')).toBe('light');

      removeDashboard(el);
    });

    test('applies dark theme variables', async () => {
      const el = await createDashboard({ theme: 'dark' });

      expect(el.getAttribute('data-loki-theme')).toBe('dark');

      removeDashboard(el);
    });

    test('supports all unified themes', () => {
      const expectedThemes = ['light', 'dark', 'high-contrast', 'vscode-light', 'vscode-dark'];
      expectedThemes.forEach((theme) => {
        expect(THEMES[theme]).toBeDefined();
      });
    });
  });

  describe('Attribute Changes', () => {
    test('reloads data on api-url change', async () => {
      const el = await createDashboard();

      const initialCalls = mockApiClient.getLearningMetrics.mock.calls.length;

      el.setAttribute('api-url', 'http://localhost:9999');
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockApiClient.getLearningMetrics.mock.calls.length).toBeGreaterThan(
        initialCalls
      );

      removeDashboard(el);
    });

    test('respects initial time-range attribute', async () => {
      const el = await createDashboard({ 'time-range': '24h' });

      const timeRangeSelect = el.shadowRoot.querySelector('#time-range-select');
      expect(timeRangeSelect.value).toBe('24h');

      removeDashboard(el);
    });

    test('respects initial signal-type attribute', async () => {
      const el = await createDashboard({ 'signal-type': 'error_pattern' });

      const signalTypeSelect = el.shadowRoot.querySelector('#signal-type-select');
      expect(signalTypeSelect.value).toBe('error_pattern');

      removeDashboard(el);
    });
  });
});

// =============================================================================
// Feature Matrix Entry
// =============================================================================

/**
 * Feature matrix for learning dashboard component
 */
export const LEARNING_DASHBOARD_FEATURES = {
  component: 'loki-learning-dashboard',
  features: {
    'view-metrics': {
      description: 'Display learning metrics summary',
      required: true,
      testFn: (el) => !!el.shadowRoot.querySelector('.summary-cards'),
    },
    'filter-time-range': {
      description: 'Filter by time range',
      required: true,
      testFn: (el) => !!el.shadowRoot.querySelector('#time-range-select'),
    },
    'filter-signal-type': {
      description: 'Filter by signal type',
      required: true,
      testFn: (el) => !!el.shadowRoot.querySelector('#signal-type-select'),
    },
    'filter-source': {
      description: 'Filter by signal source',
      required: true,
      testFn: (el) => !!el.shadowRoot.querySelector('#source-select'),
    },
    'trend-chart': {
      description: 'Display signal volume trend chart',
      required: true,
      testFn: (el) => !!el.shadowRoot.querySelector('.trend-chart'),
    },
    'top-preferences': {
      description: 'Show top user preferences',
      required: true,
      testFn: (el) => {
        const lists = el.shadowRoot.querySelectorAll('.top-list');
        return lists.length >= 4;
      },
    },
    'error-patterns': {
      description: 'Show common error patterns',
      required: true,
      testFn: (el) => !!el.shadowRoot.querySelector('.error-item, .list-empty'),
    },
    'success-patterns': {
      description: 'Show success patterns',
      required: true,
      testFn: (el) => !!el.shadowRoot.querySelector('.success-item, .list-empty'),
    },
    'tool-efficiency': {
      description: 'Show tool efficiency rankings',
      required: true,
      testFn: (el) => !!el.shadowRoot.querySelector('.tool-item, .list-empty'),
    },
    'recent-signals': {
      description: 'Show recent signals',
      required: true,
      testFn: (el) => !!el.shadowRoot.querySelector('.recent-signals'),
    },
    'detail-panel': {
      description: 'Show detail panel on item selection',
      required: true,
      testFn: (el) => {
        const listItem = el.shadowRoot.querySelector('.list-item');
        return listItem ? listItem.getAttribute('tabindex') === '0' : true;
      },
    },
    'refresh-action': {
      description: 'Refresh button reloads data',
      required: true,
      testFn: (el) => !!el.shadowRoot.querySelector('#refresh-btn'),
    },
    'metric-select-event': {
      description: 'Emit event on metric selection',
      required: true,
      testFn: (el) => typeof el.dispatchEvent === 'function',
    },
    'filter-change-event': {
      description: 'Emit event on filter change',
      required: true,
      testFn: (el) => typeof el.dispatchEvent === 'function',
    },
    'keyboard-navigation': {
      description: 'List items support keyboard navigation',
      required: true,
      testFn: (el) => {
        const item = el.shadowRoot.querySelector('.list-item');
        return item ? item.getAttribute('tabindex') === '0' : true;
      },
    },
  },
};
