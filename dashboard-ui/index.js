/**
 * Loki Mode Dashboard UI Components
 *
 * Reusable web components for building Loki Mode dashboard interfaces.
 *
 * Usage:
 *   import { LokiTaskBoard, LokiSessionControl, LokiLogStream, LokiMemoryBrowser } from 'dashboard-ui';
 *
 *   // Or import individual components
 *   import 'dashboard-ui/components/loki-task-board.js';
 *
 *   // For unified styling across contexts
 *   import { UnifiedThemeManager, THEMES, BASE_STYLES } from 'dashboard-ui';
 */

// Core utilities - import for local use and re-export
import {
  LokiTheme,
  LokiElement,
  THEME_VARIABLES,
  COMMON_STYLES,
  UnifiedThemeManager,
  BASE_STYLES,
  KeyboardHandler,
  KEYBOARD_SHORTCUTS,
  ARIA_PATTERNS,
} from './core/loki-theme.js';
import { LokiApiClient, getApiClient, createApiClient, ApiEvents } from './core/loki-api-client.js';
import { LokiState, getState, createStore, STATE_CHANGE_EVENT } from './core/loki-state.js';

// Import unified styles directly for full access
import {
  THEMES,
  SPACING,
  RADIUS,
  TYPOGRAPHY,
  ANIMATION,
  BREAKPOINTS,
  Z_INDEX,
  generateThemeCSS,
  generateTokensCSS,
} from './core/loki-unified-styles.js';

// Re-export core utilities (legacy)
export { LokiTheme, LokiElement, THEME_VARIABLES, COMMON_STYLES };
export { LokiApiClient, getApiClient, createApiClient, ApiEvents };
export { LokiState, getState, createStore, STATE_CHANGE_EVENT };

// Re-export unified styles (recommended for new code)
export {
  UnifiedThemeManager,
  BASE_STYLES,
  KeyboardHandler,
  KEYBOARD_SHORTCUTS,
  ARIA_PATTERNS,
  THEMES,
  SPACING,
  RADIUS,
  TYPOGRAPHY,
  ANIMATION,
  BREAKPOINTS,
  Z_INDEX,
  generateThemeCSS,
  generateTokensCSS,
};

// Components
export { LokiOverview } from './components/loki-overview.js';
export { LokiTaskBoard } from './components/loki-task-board.js';
export { LokiSessionControl } from './components/loki-session-control.js';
export { LokiLogStream } from './components/loki-log-stream.js';
export { LokiMemoryBrowser } from './components/loki-memory-browser.js';
export { LokiLearningDashboard } from './components/loki-learning-dashboard.js';
export { LokiCouncilDashboard } from './components/loki-council-dashboard.js';
export { LokiCostDashboard } from './components/loki-cost-dashboard.js';
export { LokiCheckpointViewer } from './components/loki-checkpoint-viewer.js';
export { LokiContextTracker } from './components/loki-context-tracker.js';
export { LokiNotificationCenter } from './components/loki-notification-center.js';

// Version
export const VERSION = '1.3.0';

/**
 * Initialize all components with default configuration
 * @param {object} config - Configuration options
 * @param {string} config.apiUrl - API base URL
 * @param {string} config.theme - Theme name (light, dark, high-contrast, vscode-light, vscode-dark)
 * @param {boolean} config.autoDetectContext - Auto-detect VS Code/browser context (default: true)
 */
export function init(config = {}) {
  // Initialize theme system
  if (config.theme) {
    UnifiedThemeManager.setTheme(config.theme);
  } else if (config.autoDetectContext !== false) {
    // Auto-detect context and apply appropriate theme
    UnifiedThemeManager.init();
  } else {
    // Fall back to legacy init
    LokiTheme.init();
  }

  // Set global API URL if provided
  if (config.apiUrl) {
    getApiClient({ baseUrl: config.apiUrl });
  }

  return {
    theme: UnifiedThemeManager.getTheme(),
    context: UnifiedThemeManager.detectContext(),
  };
}

// Auto-register components when imported
const componentModules = [
  './components/loki-overview.js',
  './components/loki-task-board.js',
  './components/loki-session-control.js',
  './components/loki-log-stream.js',
  './components/loki-memory-browser.js',
  './components/loki-learning-dashboard.js',
  './components/loki-council-dashboard.js',
  './components/loki-cost-dashboard.js',
  './components/loki-checkpoint-viewer.js',
  './components/loki-context-tracker.js',
  './components/loki-notification-center.js',
];

// Components are registered via customElements.define in their respective files
