/**
 * Loki Mode Unified Style System
 *
 * Provides consistent styling across all contexts:
 * - Browser (standalone)
 * - VS Code webview (light/dark/high-contrast)
 * - CLI-embedded HTML
 *
 * @version 1.0.0
 */

// =============================================================================
// THEME DEFINITIONS
// =============================================================================

/**
 * Complete theme definitions with all CSS custom properties
 * Themes: light, dark, high-contrast, vscode-light, vscode-dark
 */
export const THEMES = {
  // Standard light theme (Autonomi cream/editorial)
  light: {
    // Background layers
    '--loki-bg-primary': '#FFFEFB',
    '--loki-bg-secondary': '#F8F4F0',
    '--loki-bg-tertiary': '#ECEAE3',
    '--loki-bg-card': '#ffffff',
    '--loki-bg-hover': '#F3EFE9',
    '--loki-bg-active': '#E6E2DA',
    '--loki-bg-overlay': 'rgba(32, 21, 21, 0.5)',

    // Accent colors (violet)
    '--loki-accent': '#553DE9',
    '--loki-accent-hover': '#4432c4',
    '--loki-accent-active': '#3828a0',
    '--loki-accent-light': '#7B6BF0',
    '--loki-accent-muted': 'rgba(85, 61, 233, 0.10)',

    // Text hierarchy
    '--loki-text-primary': '#201515',
    '--loki-text-secondary': '#36342E',
    '--loki-text-muted': '#939084',
    '--loki-text-disabled': '#C5C0B1',
    '--loki-text-inverse': '#ffffff',

    // Border colors (warm)
    '--loki-border': '#ECEAE3',
    '--loki-border-light': '#C5C0B1',
    '--loki-border-focus': '#553DE9',

    // Status colors - semantic
    '--loki-success': '#1FC5A8',
    '--loki-success-muted': 'rgba(31, 197, 168, 0.12)',
    '--loki-warning': '#D4A03C',
    '--loki-warning-muted': 'rgba(212, 160, 60, 0.12)',
    '--loki-error': '#C45B5B',
    '--loki-error-muted': 'rgba(196, 91, 91, 0.12)',
    '--loki-info': '#2F71E3',
    '--loki-info-muted': 'rgba(47, 113, 227, 0.12)',

    // Legacy aliases (for backwards compatibility)
    '--loki-green': '#1FC5A8',
    '--loki-green-muted': 'rgba(31, 197, 168, 0.12)',
    '--loki-yellow': '#D4A03C',
    '--loki-yellow-muted': 'rgba(212, 160, 60, 0.12)',
    '--loki-red': '#C45B5B',
    '--loki-red-muted': 'rgba(196, 91, 91, 0.12)',
    '--loki-blue': '#2F71E3',
    '--loki-blue-muted': 'rgba(47, 113, 227, 0.12)',
    '--loki-purple': '#553DE9',
    '--loki-purple-muted': 'rgba(85, 61, 233, 0.10)',

    // Model-specific colors
    '--loki-opus': '#d97706',
    '--loki-sonnet': '#553DE9',
    '--loki-haiku': '#1FC5A8',

    // Shadow definitions
    '--loki-shadow-sm': '0 1px 2px rgba(32, 21, 21, 0.04)',
    '--loki-shadow-md': '0 4px 6px rgba(32, 21, 21, 0.06)',
    '--loki-shadow-lg': '0 10px 15px rgba(32, 21, 21, 0.08)',
    '--loki-shadow-focus': '0 0 0 3px rgba(85, 61, 233, 0.25)',
  },

  // Standard dark theme (Autonomi midnight/Agent View)
  dark: {
    // Background layers (deep midnight purple)
    '--loki-bg-primary': '#1A0F2E',
    '--loki-bg-secondary': '#140B24',
    '--loki-bg-tertiary': '#251842',
    '--loki-bg-card': '#1F1338',
    '--loki-bg-hover': '#2A1F4A',
    '--loki-bg-active': '#352A55',
    '--loki-bg-overlay': 'rgba(20, 11, 36, 0.85)',

    // Accent colors (violet, brighter for dark bg)
    '--loki-accent': '#7B6BF0',
    '--loki-accent-hover': '#9488F5',
    '--loki-accent-active': '#6258D0',
    '--loki-accent-light': '#9488F5',
    '--loki-accent-muted': 'rgba(123, 107, 240, 0.18)',

    // Text hierarchy
    '--loki-text-primary': '#F0ECF8',
    '--loki-text-secondary': '#C0B8D0',
    '--loki-text-muted': '#8B7FA8',
    '--loki-text-disabled': '#5A4E78',
    '--loki-text-inverse': '#1A0F2E',

    // Border colors
    '--loki-border': '#2A1F3E',
    '--loki-border-light': '#3D3060',
    '--loki-border-focus': '#7B6BF0',

    // Status colors - semantic
    '--loki-success': '#2ED8B6',
    '--loki-success-muted': 'rgba(46, 216, 182, 0.18)',
    '--loki-warning': '#E8B84A',
    '--loki-warning-muted': 'rgba(232, 184, 74, 0.18)',
    '--loki-error': '#E07070',
    '--loki-error-muted': 'rgba(224, 112, 112, 0.18)',
    '--loki-info': '#5A9CF5',
    '--loki-info-muted': 'rgba(90, 156, 245, 0.18)',

    // Legacy aliases
    '--loki-green': '#2ED8B6',
    '--loki-green-muted': 'rgba(46, 216, 182, 0.18)',
    '--loki-yellow': '#E8B84A',
    '--loki-yellow-muted': 'rgba(232, 184, 74, 0.18)',
    '--loki-red': '#E07070',
    '--loki-red-muted': 'rgba(224, 112, 112, 0.18)',
    '--loki-blue': '#5A9CF5',
    '--loki-blue-muted': 'rgba(90, 156, 245, 0.18)',
    '--loki-purple': '#9488F5',
    '--loki-purple-muted': 'rgba(148, 136, 245, 0.18)',

    // Model colors
    '--loki-opus': '#f59e0b',
    '--loki-sonnet': '#7B6BF0',
    '--loki-haiku': '#2ED8B6',

    // Shadows (subtle glows on dark)
    '--loki-shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.4)',
    '--loki-shadow-md': '0 4px 12px rgba(0, 0, 0, 0.5)',
    '--loki-shadow-lg': '0 10px 25px rgba(0, 0, 0, 0.6)',
    '--loki-shadow-focus': '0 0 0 3px rgba(123, 107, 240, 0.30)',
  },

  // High contrast theme (accessibility)
  'high-contrast': {
    // Background layers - pure black/white
    '--loki-bg-primary': '#000000',
    '--loki-bg-secondary': '#0a0a0a',
    '--loki-bg-tertiary': '#141414',
    '--loki-bg-card': '#0a0a0a',
    '--loki-bg-hover': '#1a1a1a',
    '--loki-bg-active': '#242424',
    '--loki-bg-overlay': 'rgba(0, 0, 0, 0.9)',

    // High contrast accent (purple)
    '--loki-accent': '#c084fc',
    '--loki-accent-hover': '#d8b4fe',
    '--loki-accent-active': '#e9d5ff',
    '--loki-accent-light': '#d8b4fe',
    '--loki-accent-muted': 'rgba(192, 132, 252, 0.25)',

    // High contrast text
    '--loki-text-primary': '#ffffff',
    '--loki-text-secondary': '#e0e0e0',
    '--loki-text-muted': '#b0b0b0',
    '--loki-text-disabled': '#666666',
    '--loki-text-inverse': '#000000',

    // High contrast borders
    '--loki-border': '#ffffff',
    '--loki-border-light': '#cccccc',
    '--loki-border-focus': '#c084fc',

    // High contrast status colors
    '--loki-success': '#4ade80',
    '--loki-success-muted': 'rgba(74, 222, 128, 0.25)',
    '--loki-warning': '#fde047',
    '--loki-warning-muted': 'rgba(253, 224, 71, 0.25)',
    '--loki-error': '#f87171',
    '--loki-error-muted': 'rgba(248, 113, 113, 0.25)',
    '--loki-info': '#60a5fa',
    '--loki-info-muted': 'rgba(96, 165, 250, 0.25)',

    // Legacy aliases
    '--loki-green': '#4ade80',
    '--loki-green-muted': 'rgba(74, 222, 128, 0.25)',
    '--loki-yellow': '#fde047',
    '--loki-yellow-muted': 'rgba(253, 224, 71, 0.25)',
    '--loki-red': '#f87171',
    '--loki-red-muted': 'rgba(248, 113, 113, 0.25)',
    '--loki-blue': '#60a5fa',
    '--loki-blue-muted': 'rgba(96, 165, 250, 0.25)',
    '--loki-purple': '#c084fc',
    '--loki-purple-muted': 'rgba(192, 132, 252, 0.25)',

    // Model colors
    '--loki-opus': '#fbbf24',
    '--loki-sonnet': '#818cf8',
    '--loki-haiku': '#34d399',

    // High contrast shadows (using outlines instead)
    '--loki-shadow-sm': 'none',
    '--loki-shadow-md': 'none',
    '--loki-shadow-lg': 'none',
    '--loki-shadow-focus': '0 0 0 3px #c084fc',
  },

  // VS Code Light theme - maps VS Code variables
  'vscode-light': {
    '--loki-bg-primary': 'var(--vscode-editor-background, #ffffff)',
    '--loki-bg-secondary': 'var(--vscode-sideBar-background, #f3f3f3)',
    '--loki-bg-tertiary': 'var(--vscode-input-background, #ffffff)',
    '--loki-bg-card': 'var(--vscode-editor-background, #ffffff)',
    '--loki-bg-hover': 'var(--vscode-list-hoverBackground, #e8e8e8)',
    '--loki-bg-active': 'var(--vscode-list-activeSelectionBackground, #0060c0)',
    '--loki-bg-overlay': 'rgba(0, 0, 0, 0.4)',

    '--loki-accent': 'var(--vscode-focusBorder, #0066cc)',
    '--loki-accent-hover': 'var(--vscode-button-hoverBackground, #0055aa)',
    '--loki-accent-active': 'var(--vscode-button-background, #007acc)',
    '--loki-accent-light': 'var(--vscode-focusBorder, #0066cc)',
    '--loki-accent-muted': 'var(--vscode-editor-selectionBackground, rgba(0, 102, 204, 0.2))',

    '--loki-text-primary': 'var(--vscode-foreground, #333333)',
    '--loki-text-secondary': 'var(--vscode-descriptionForeground, #717171)',
    '--loki-text-muted': 'var(--vscode-disabledForeground, #a0a0a0)',
    '--loki-text-disabled': 'var(--vscode-disabledForeground, #cccccc)',
    '--loki-text-inverse': 'var(--vscode-button-foreground, #ffffff)',

    '--loki-border': 'var(--vscode-widget-border, #c8c8c8)',
    '--loki-border-light': 'var(--vscode-widget-border, #e0e0e0)',
    '--loki-border-focus': 'var(--vscode-focusBorder, #0066cc)',

    '--loki-success': 'var(--vscode-testing-iconPassed, #388a34)',
    '--loki-success-muted': 'rgba(56, 138, 52, 0.15)',
    '--loki-warning': 'var(--vscode-editorWarning-foreground, #bf8803)',
    '--loki-warning-muted': 'rgba(191, 136, 3, 0.15)',
    '--loki-error': 'var(--vscode-errorForeground, #e51400)',
    '--loki-error-muted': 'rgba(229, 20, 0, 0.15)',
    '--loki-info': 'var(--vscode-editorInfo-foreground, #1a85ff)',
    '--loki-info-muted': 'rgba(26, 133, 255, 0.15)',

    '--loki-green': 'var(--vscode-testing-iconPassed, #388a34)',
    '--loki-green-muted': 'rgba(56, 138, 52, 0.15)',
    '--loki-yellow': 'var(--vscode-editorWarning-foreground, #bf8803)',
    '--loki-yellow-muted': 'rgba(191, 136, 3, 0.15)',
    '--loki-red': 'var(--vscode-errorForeground, #e51400)',
    '--loki-red-muted': 'rgba(229, 20, 0, 0.15)',
    '--loki-blue': 'var(--vscode-editorInfo-foreground, #1a85ff)',
    '--loki-blue-muted': 'rgba(26, 133, 255, 0.15)',
    '--loki-purple': '#9333ea',
    '--loki-purple-muted': 'rgba(147, 51, 234, 0.15)',

    '--loki-opus': '#d97706',
    '--loki-sonnet': '#4f46e5',
    '--loki-haiku': '#059669',

    '--loki-shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.05)',
    '--loki-shadow-md': '0 2px 4px rgba(0, 0, 0, 0.1)',
    '--loki-shadow-lg': '0 4px 8px rgba(0, 0, 0, 0.15)',
    '--loki-shadow-focus': '0 0 0 2px var(--vscode-focusBorder, #0066cc)',
  },

  // VS Code Dark theme
  'vscode-dark': {
    '--loki-bg-primary': 'var(--vscode-editor-background, #1e1e1e)',
    '--loki-bg-secondary': 'var(--vscode-sideBar-background, #252526)',
    '--loki-bg-tertiary': 'var(--vscode-input-background, #3c3c3c)',
    '--loki-bg-card': 'var(--vscode-editor-background, #1e1e1e)',
    '--loki-bg-hover': 'var(--vscode-list-hoverBackground, #2a2d2e)',
    '--loki-bg-active': 'var(--vscode-list-activeSelectionBackground, #094771)',
    '--loki-bg-overlay': 'rgba(0, 0, 0, 0.6)',

    '--loki-accent': 'var(--vscode-focusBorder, #007fd4)',
    '--loki-accent-hover': 'var(--vscode-button-hoverBackground, #1177bb)',
    '--loki-accent-active': 'var(--vscode-button-background, #0e639c)',
    '--loki-accent-light': 'var(--vscode-focusBorder, #007fd4)',
    '--loki-accent-muted': 'var(--vscode-editor-selectionBackground, rgba(0, 127, 212, 0.25))',

    '--loki-text-primary': 'var(--vscode-foreground, #cccccc)',
    '--loki-text-secondary': 'var(--vscode-descriptionForeground, #9d9d9d)',
    '--loki-text-muted': 'var(--vscode-disabledForeground, #6b6b6b)',
    '--loki-text-disabled': 'var(--vscode-disabledForeground, #4d4d4d)',
    '--loki-text-inverse': 'var(--vscode-button-foreground, #ffffff)',

    '--loki-border': 'var(--vscode-widget-border, #454545)',
    '--loki-border-light': 'var(--vscode-widget-border, #5a5a5a)',
    '--loki-border-focus': 'var(--vscode-focusBorder, #007fd4)',

    '--loki-success': 'var(--vscode-testing-iconPassed, #89d185)',
    '--loki-success-muted': 'rgba(137, 209, 133, 0.2)',
    '--loki-warning': 'var(--vscode-editorWarning-foreground, #cca700)',
    '--loki-warning-muted': 'rgba(204, 167, 0, 0.2)',
    '--loki-error': 'var(--vscode-errorForeground, #f48771)',
    '--loki-error-muted': 'rgba(244, 135, 113, 0.2)',
    '--loki-info': 'var(--vscode-editorInfo-foreground, #75beff)',
    '--loki-info-muted': 'rgba(117, 190, 255, 0.2)',

    '--loki-green': 'var(--vscode-testing-iconPassed, #89d185)',
    '--loki-green-muted': 'rgba(137, 209, 133, 0.2)',
    '--loki-yellow': 'var(--vscode-editorWarning-foreground, #cca700)',
    '--loki-yellow-muted': 'rgba(204, 167, 0, 0.2)',
    '--loki-red': 'var(--vscode-errorForeground, #f48771)',
    '--loki-red-muted': 'rgba(244, 135, 113, 0.2)',
    '--loki-blue': 'var(--vscode-editorInfo-foreground, #75beff)',
    '--loki-blue-muted': 'rgba(117, 190, 255, 0.2)',
    '--loki-purple': '#c084fc',
    '--loki-purple-muted': 'rgba(192, 132, 252, 0.2)',

    '--loki-opus': '#f59e0b',
    '--loki-sonnet': '#818cf8',
    '--loki-haiku': '#34d399',

    '--loki-shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.3)',
    '--loki-shadow-md': '0 2px 4px rgba(0, 0, 0, 0.4)',
    '--loki-shadow-lg': '0 4px 8px rgba(0, 0, 0, 0.5)',
    '--loki-shadow-focus': '0 0 0 2px var(--vscode-focusBorder, #007fd4)',
  },
};

// =============================================================================
// DESIGN TOKENS
// =============================================================================

/**
 * Consistent spacing scale (in pixels)
 */
export const SPACING = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  '2xl': '32px',
  '3xl': '48px',
};

/**
 * Consistent border radius scale
 */
export const RADIUS = {
  none: '0',
  sm: '2px',
  md: '4px',
  lg: '5px',
  xl: '5px',
  full: '9999px',
};

/**
 * Typography scale
 */
export const TYPOGRAPHY = {
  fontFamily: {
    sans: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    serif: "'DM Serif Display', Georgia, 'Times New Roman', serif",
    mono: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
  },
  fontSize: {
    xs: '10px',
    sm: '11px',
    base: '12px',
    md: '13px',
    lg: '14px',
    xl: '16px',
    '2xl': '18px',
    '3xl': '24px',
  },
  fontWeight: {
    normal: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
  lineHeight: {
    tight: '1.25',
    normal: '1.5',
    relaxed: '1.75',
  },
};

/**
 * Animation timings
 */
export const ANIMATION = {
  duration: {
    fast: '100ms',
    normal: '200ms',
    slow: '300ms',
    slower: '500ms',
  },
  easing: {
    default: 'cubic-bezier(0.4, 0, 0.2, 1)',
    in: 'cubic-bezier(0.4, 0, 1, 1)',
    out: 'cubic-bezier(0, 0, 0.2, 1)',
    bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  },
};

/**
 * Responsive breakpoints
 */
export const BREAKPOINTS = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
};

/**
 * Z-index scale
 */
export const Z_INDEX = {
  base: '0',
  dropdown: '100',
  sticky: '200',
  modal: '300',
  popover: '400',
  tooltip: '500',
  toast: '600',
};

// =============================================================================
// KEYBOARD SHORTCUTS
// =============================================================================

/**
 * Unified keyboard shortcuts across all contexts
 */
export const KEYBOARD_SHORTCUTS = {
  // Navigation
  'navigation.nextItem': { key: 'ArrowDown', modifiers: [] },
  'navigation.prevItem': { key: 'ArrowUp', modifiers: [] },
  'navigation.nextSection': { key: 'Tab', modifiers: [] },
  'navigation.prevSection': { key: 'Tab', modifiers: ['Shift'] },
  'navigation.confirm': { key: 'Enter', modifiers: [] },
  'navigation.cancel': { key: 'Escape', modifiers: [] },

  // Actions
  'action.refresh': { key: 'r', modifiers: ['Meta'] },
  'action.search': { key: 'k', modifiers: ['Meta'] },
  'action.save': { key: 's', modifiers: ['Meta'] },
  'action.close': { key: 'w', modifiers: ['Meta'] },

  // Theme
  'theme.toggle': { key: 'd', modifiers: ['Meta', 'Shift'] },

  // Tasks
  'task.create': { key: 'n', modifiers: ['Meta'] },
  'task.complete': { key: 'Enter', modifiers: ['Meta'] },

  // View
  'view.toggleLogs': { key: 'l', modifiers: ['Meta', 'Shift'] },
  'view.toggleMemory': { key: 'm', modifiers: ['Meta', 'Shift'] },
};

// =============================================================================
// ARIA PATTERNS
// =============================================================================

/**
 * Common ARIA patterns for accessibility
 */
export const ARIA_PATTERNS = {
  // Button patterns
  button: {
    role: 'button',
    tabIndex: 0,
  },

  // Tab patterns
  tablist: {
    role: 'tablist',
  },
  tab: {
    role: 'tab',
    ariaSelected: false,
    tabIndex: -1,
  },
  tabpanel: {
    role: 'tabpanel',
    tabIndex: 0,
  },

  // List patterns
  list: {
    role: 'list',
  },
  listitem: {
    role: 'listitem',
  },

  // Live regions
  livePolite: {
    ariaLive: 'polite',
    ariaAtomic: true,
  },
  liveAssertive: {
    ariaLive: 'assertive',
    ariaAtomic: true,
  },

  // Dialog patterns
  dialog: {
    role: 'dialog',
    ariaModal: true,
  },
  alertdialog: {
    role: 'alertdialog',
    ariaModal: true,
  },

  // Status patterns
  status: {
    role: 'status',
    ariaLive: 'polite',
  },
  alert: {
    role: 'alert',
    ariaLive: 'assertive',
  },

  // Log pattern
  log: {
    role: 'log',
    ariaLive: 'polite',
    ariaRelevant: 'additions',
  },
};

// =============================================================================
// CSS GENERATION
// =============================================================================

/**
 * Generate CSS custom properties from a theme
 * @param {string} themeName - Theme name
 * @returns {string} CSS string
 */
export function generateThemeCSS(themeName) {
  const theme = THEMES[themeName];
  if (!theme) return '';

  return Object.entries(theme)
    .map(([key, value]) => `${key}: ${value};`)
    .join('\n    ');
}

/**
 * Generate complete CSS variables string including design tokens
 */
export function generateTokensCSS() {
  return `
    /* Spacing */
    --loki-space-xs: ${SPACING.xs};
    --loki-space-sm: ${SPACING.sm};
    --loki-space-md: ${SPACING.md};
    --loki-space-lg: ${SPACING.lg};
    --loki-space-xl: ${SPACING.xl};
    --loki-space-2xl: ${SPACING['2xl']};
    --loki-space-3xl: ${SPACING['3xl']};

    /* Border Radius */
    --loki-radius-none: ${RADIUS.none};
    --loki-radius-sm: ${RADIUS.sm};
    --loki-radius-md: ${RADIUS.md};
    --loki-radius-lg: ${RADIUS.lg};
    --loki-radius-xl: ${RADIUS.xl};
    --loki-radius-full: ${RADIUS.full};

    /* Typography */
    --loki-font-sans: ${TYPOGRAPHY.fontFamily.sans};
    --loki-font-serif: ${TYPOGRAPHY.fontFamily.serif};
    --loki-font-mono: ${TYPOGRAPHY.fontFamily.mono};
    --loki-text-xs: ${TYPOGRAPHY.fontSize.xs};
    --loki-text-sm: ${TYPOGRAPHY.fontSize.sm};
    --loki-text-base: ${TYPOGRAPHY.fontSize.base};
    --loki-text-md: ${TYPOGRAPHY.fontSize.md};
    --loki-text-lg: ${TYPOGRAPHY.fontSize.lg};
    --loki-text-xl: ${TYPOGRAPHY.fontSize.xl};
    --loki-text-2xl: ${TYPOGRAPHY.fontSize['2xl']};
    --loki-text-3xl: ${TYPOGRAPHY.fontSize['3xl']};

    /* Animation */
    --loki-duration-fast: ${ANIMATION.duration.fast};
    --loki-duration-normal: ${ANIMATION.duration.normal};
    --loki-duration-slow: ${ANIMATION.duration.slow};
    --loki-easing-default: ${ANIMATION.easing.default};
    --loki-transition: ${ANIMATION.duration.normal} ${ANIMATION.easing.default};

    /* Z-Index */
    --loki-z-dropdown: ${Z_INDEX.dropdown};
    --loki-z-sticky: ${Z_INDEX.sticky};
    --loki-z-modal: ${Z_INDEX.modal};
    --loki-z-popover: ${Z_INDEX.popover};
    --loki-z-tooltip: ${Z_INDEX.tooltip};
    --loki-z-toast: ${Z_INDEX.toast};

    /* Glass effect */
    --loki-glass-bg: rgba(255, 255, 255, 0.03);
    --loki-glass-border: rgba(255, 255, 255, 0.06);
    --loki-glass-blur: blur(12px);
  `;
}

/**
 * Generate base styles shared across all components
 */
export const BASE_STYLES = `
  /* Reset and base */
  :host {
    font-family: var(--loki-font-sans);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    box-sizing: border-box;
    color: var(--loki-text-primary);
  }

  :host *, :host *::before, :host *::after {
    box-sizing: border-box;
  }

  /* Monospace utility */
  .mono {
    font-family: var(--loki-font-mono);
  }

  /* Focus visible outline */
  :focus-visible {
    outline: 2px solid var(--loki-border-focus);
    outline-offset: 2px;
  }

  :focus:not(:focus-visible) {
    outline: none;
  }

  /* Button base */
  .btn {
    padding: var(--loki-space-sm) var(--loki-space-md);
    border-radius: var(--loki-radius-md);
    font-size: var(--loki-text-md);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--loki-transition);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--loki-space-xs);
    border: 1px solid transparent;
    text-decoration: none;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }

  .btn-primary {
    background: var(--loki-accent);
    color: var(--loki-text-inverse);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--loki-accent-hover);
  }

  .btn-primary:active:not(:disabled) {
    background: var(--loki-accent-active);
  }

  .btn-secondary {
    background: var(--loki-bg-tertiary);
    color: var(--loki-text-primary);
    border-color: var(--loki-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--loki-bg-hover);
    border-color: var(--loki-border-light);
  }

  .btn-ghost {
    background: transparent;
    color: var(--loki-text-secondary);
  }

  .btn-ghost:hover:not(:disabled) {
    background: var(--loki-bg-hover);
    color: var(--loki-text-primary);
  }

  .btn-danger {
    background: var(--loki-error);
    color: var(--loki-text-inverse);
  }

  .btn-danger:hover:not(:disabled) {
    background: var(--loki-red);
    filter: brightness(1.1);
  }

  /* Button sizes */
  .btn-sm {
    padding: var(--loki-space-xs) var(--loki-space-sm);
    font-size: var(--loki-text-sm);
  }

  .btn-lg {
    padding: var(--loki-space-md) var(--loki-space-lg);
    font-size: var(--loki-text-lg);
  }

  /* Status indicators (rectangle style) */
  .status-dot {
    width: 12px;
    height: 6px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .status-dot.active {
    background: var(--loki-success);
    animation: pulse 2s infinite;
  }
  .status-dot.idle { background: var(--loki-text-muted); }
  .status-dot.paused { background: var(--loki-warning); }
  .status-dot.stopped { background: var(--loki-error); }
  .status-dot.error { background: var(--loki-error); }
  .status-dot.offline { background: var(--loki-text-muted); }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* Card base */
  .card {
    background: var(--loki-bg-card);
    border: 1px solid var(--loki-border);
    border-radius: var(--loki-radius-xl);
    padding: var(--loki-space-lg);
    transition: all var(--loki-transition);
  }

  .card:hover {
    border-color: var(--loki-border-light);
  }

  .card-interactive {
    cursor: pointer;
  }

  .card-interactive:hover {
    transform: translateY(-1px);
    box-shadow: var(--loki-shadow-md);
  }

  /* Input base */
  .input {
    width: 100%;
    padding: var(--loki-space-sm) var(--loki-space-md);
    background: var(--loki-bg-tertiary);
    border: 1px solid var(--loki-border);
    border-radius: var(--loki-radius-md);
    font-size: var(--loki-text-base);
    color: var(--loki-text-primary);
    transition: all var(--loki-transition);
  }

  .input::placeholder {
    color: var(--loki-text-muted);
  }

  .input:hover:not(:disabled) {
    border-color: var(--loki-border-light);
  }

  .input:focus {
    outline: none;
    border-color: var(--loki-border-focus);
    box-shadow: var(--loki-shadow-focus);
  }

  .input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Badge */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px var(--loki-space-sm);
    border-radius: var(--loki-radius-sm);
    font-size: var(--loki-text-xs);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .badge-success {
    background: var(--loki-success-muted);
    color: var(--loki-success);
  }

  .badge-warning {
    background: var(--loki-warning-muted);
    color: var(--loki-warning);
  }

  .badge-error {
    background: var(--loki-error-muted);
    color: var(--loki-error);
  }

  .badge-info {
    background: var(--loki-info-muted);
    color: var(--loki-info);
  }

  .badge-neutral {
    background: var(--loki-bg-tertiary);
    color: var(--loki-text-secondary);
  }

  /* Empty state */
  .empty-state {
    text-align: center;
    padding: var(--loki-space-xl);
    color: var(--loki-text-muted);
    font-size: var(--loki-text-base);
  }

  /* Loading spinner */
  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--loki-border);
    border-top-color: var(--loki-accent);
    border-radius: var(--loki-radius-full);
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Scrollbar */
  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  ::-webkit-scrollbar-track {
    background: var(--loki-bg-primary);
    border-radius: var(--loki-radius-sm);
  }

  ::-webkit-scrollbar-thumb {
    background: var(--loki-border);
    border-radius: var(--loki-radius-sm);
  }

  ::-webkit-scrollbar-thumb:hover {
    background: var(--loki-border-light);
  }

  /* Screen reader only */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Responsive utilities */
  @media (max-width: ${BREAKPOINTS.md}) {
    .hide-mobile { display: none !important; }
  }

  @media (min-width: ${BREAKPOINTS.md}) {
    .hide-desktop { display: none !important; }
  }
`;

// =============================================================================
// THEME MANAGER
// =============================================================================

/**
 * Unified Theme Manager for all contexts
 */
export class UnifiedThemeManager {
  static STORAGE_KEY = 'loki-theme';
  static CONTEXT_KEY = 'loki-context';

  /**
   * Detect current context
   * @returns {'browser'|'vscode'|'cli'} Current context
   */
  static detectContext() {
    // Check for VS Code webview
    if (typeof acquireVsCodeApi !== 'undefined' ||
        document.body.classList.contains('vscode-body') ||
        getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background')) {
      return 'vscode';
    }

    // Check for CLI context (could be via env var or data attribute)
    if (document.documentElement.dataset.lokiContext === 'cli') {
      return 'cli';
    }

    return 'browser';
  }

  /**
   * Detect VS Code theme type
   * @returns {'light'|'dark'|'high-contrast'|null}
   */
  static detectVSCodeTheme() {
    const body = document.body;

    if (body.classList.contains('vscode-high-contrast')) {
      return 'high-contrast';
    }
    if (body.classList.contains('vscode-dark')) {
      return 'dark';
    }
    if (body.classList.contains('vscode-light')) {
      return 'light';
    }

    // Fallback: check background color
    const bgColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--vscode-editor-background');
    if (bgColor) {
      const rgb = bgColor.match(/\d+/g);
      if (rgb) {
        const brightness = (parseInt(rgb[0]) * 299 + parseInt(rgb[1]) * 587 + parseInt(rgb[2]) * 114) / 1000;
        return brightness > 128 ? 'light' : 'dark';
      }
    }

    return null;
  }

  /**
   * Get the appropriate theme based on context
   * @returns {string} Theme name
   */
  static getTheme() {
    const context = UnifiedThemeManager.detectContext();

    if (context === 'vscode') {
      const vsTheme = UnifiedThemeManager.detectVSCodeTheme();
      if (vsTheme === 'high-contrast') return 'high-contrast';
      return vsTheme === 'dark' ? 'vscode-dark' : 'vscode-light';
    }

    // v7.90.1: the dashboard is LIGHT-ONLY. Dark mode was removed (it looked
    // worse), so the browser/CLI context always resolves to light regardless of
    // OS preference or any previously-saved dark choice. (VS Code context above
    // still follows the editor, which is correct for the embedded views.)
    return 'light';
  }

  /**
   * Set theme
   * @param {string} theme - Theme name
   */
  static setTheme(theme) {
    if (!THEMES[theme]) {
      console.warn(`Unknown theme: ${theme}`);
      return;
    }

    localStorage.setItem(UnifiedThemeManager.STORAGE_KEY, theme);
    document.documentElement.setAttribute('data-loki-theme', theme);

    // Dispatch event for components
    window.dispatchEvent(new CustomEvent('loki-theme-change', {
      detail: { theme, context: UnifiedThemeManager.detectContext() }
    }));
  }

  /**
   * Toggle between light and dark theme
   * @returns {string} New theme
   */
  static toggle() {
    // v7.90.1: dark mode removed. Toggle is a no-op in the light-only dashboard
    // (kept callable for any legacy caller); VS Code context follows the editor.
    const current = UnifiedThemeManager.getTheme();
    if (current.startsWith('vscode')) return current;
    UnifiedThemeManager.setTheme('light');
    return 'light';
  }

  /**
   * Get CSS variables for current theme
   * @param {string} theme - Optional theme override
   * @returns {object} CSS variables
   */
  static getVariables(theme = null) {
    const t = theme || UnifiedThemeManager.getTheme();
    return THEMES[t] || THEMES.light;
  }

  /**
   * Generate complete CSS for a theme
   * @param {string} theme - Theme name
   * @returns {string} CSS string
   */
  static generateCSS(theme = null) {
    const t = theme || UnifiedThemeManager.getTheme();
    return `
      :host {
        ${generateThemeCSS(t)}
        ${generateTokensCSS()}
      }
      ${BASE_STYLES}
    `;
  }

  /**
   * Initialize theme system
   */
  static init() {
    const theme = UnifiedThemeManager.getTheme();
    document.documentElement.setAttribute('data-loki-theme', theme);

    // Listen for system preference changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!localStorage.getItem(UnifiedThemeManager.STORAGE_KEY)) {
        UnifiedThemeManager.setTheme(UnifiedThemeManager.getTheme());
      }
    });

    // VS Code theme change observer
    if (UnifiedThemeManager.detectContext() === 'vscode') {
      const observer = new MutationObserver(() => {
        const newTheme = UnifiedThemeManager.getTheme();
        document.documentElement.setAttribute('data-loki-theme', newTheme);
        window.dispatchEvent(new CustomEvent('loki-theme-change', {
          detail: { theme: newTheme, context: 'vscode' }
        }));
      });

      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class']
      });
    }
  }
}

// =============================================================================
// KEYBOARD HANDLER
// =============================================================================

/**
 * Unified keyboard shortcut handler
 */
export class KeyboardHandler {
  constructor() {
    this._handlers = new Map();
    this._enabled = true;
  }

  /**
   * Register a keyboard shortcut handler
   * @param {string} action - Action name from KEYBOARD_SHORTCUTS
   * @param {Function} handler - Handler function
   */
  register(action, handler) {
    const shortcut = KEYBOARD_SHORTCUTS[action];
    if (!shortcut) {
      console.warn(`Unknown keyboard action: ${action}`);
      return;
    }

    this._handlers.set(action, { shortcut, handler });
  }

  /**
   * Unregister a handler
   * @param {string} action - Action name
   */
  unregister(action) {
    this._handlers.delete(action);
  }

  /**
   * Enable/disable keyboard handling
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = enabled;
  }

  /**
   * Handle a keyboard event
   * @param {KeyboardEvent} event
   * @returns {boolean} Whether the event was handled
   */
  handleEvent(event) {
    if (!this._enabled) return false;

    for (const [action, { shortcut, handler }] of this._handlers) {
      if (this._matchesShortcut(event, shortcut)) {
        event.preventDefault();
        event.stopPropagation();
        handler(event);
        return true;
      }
    }

    return false;
  }

  /**
   * Check if event matches shortcut
   * @param {KeyboardEvent} event
   * @param {object} shortcut
   * @returns {boolean}
   */
  _matchesShortcut(event, shortcut) {
    const key = event.key.toLowerCase();
    const modifiers = shortcut.modifiers || [];

    if (key !== shortcut.key.toLowerCase()) return false;

    const hasCtrl = modifiers.includes('Ctrl') || modifiers.includes('Meta');
    const hasShift = modifiers.includes('Shift');
    const hasAlt = modifiers.includes('Alt');

    const ctrlMatch = (event.ctrlKey || event.metaKey) === hasCtrl;
    const shiftMatch = event.shiftKey === hasShift;
    const altMatch = event.altKey === hasAlt;

    return ctrlMatch && shiftMatch && altMatch;
  }

  /**
   * Attach to an element
   * @param {HTMLElement} element
   */
  attach(element) {
    if (!this._boundHandler) {
      this._boundHandler = (e) => this.handleEvent(e);
    }
    element.addEventListener('keydown', this._boundHandler);
  }

  /**
   * Detach from an element
   * @param {HTMLElement} element
   */
  detach(element) {
    if (this._boundHandler) {
      element.removeEventListener('keydown', this._boundHandler);
    }
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  THEMES,
  SPACING,
  RADIUS,
  TYPOGRAPHY,
  ANIMATION,
  BREAKPOINTS,
  Z_INDEX,
  KEYBOARD_SHORTCUTS,
  ARIA_PATTERNS,
  BASE_STYLES,
  generateThemeCSS,
  generateTokensCSS,
  UnifiedThemeManager,
  KeyboardHandler,
};
