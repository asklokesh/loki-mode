#!/usr/bin/env node
/**
 * Build Standalone Dashboard HTML
 *
 * Generates a self-contained HTML file with all dashboard-ui components inlined.
 * Can be opened directly in a browser without a web server.
 *
 * Usage:
 *   node scripts/build-standalone.js [--minify] [--watch]
 *
 * Output:
 *   dist/loki-dashboard-standalone.html
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import esbuild from 'esbuild';

// Get script directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse arguments
const args = process.argv.slice(2);
const shouldMinify = args.includes('--minify') || !args.includes('--no-minify');
const watchMode = args.includes('--watch');

/**
 * Build standalone HTML dashboard
 */
async function buildStandalone() {
  const distDir = join(__dirname, '..', 'dist');
  const serverStaticDir = join(__dirname, '..', '..', 'dashboard', 'static');
  const entryPoint = join(__dirname, '..', 'index.js');

  // Ensure output directories exist
  for (const dir of [distDir, serverStaticDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  console.log('Building standalone dashboard...');

  // Build IIFE bundle in memory
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'iife',
    globalName: 'LokiDashboard',
    minify: shouldMinify,
    write: false,
    target: ['es2020'],
    logLevel: 'warning',
  });

  const bundleCode = result.outputFiles[0].text;
  const bundleSize = (bundleCode.length / 1024).toFixed(1);

  // Generate standalone HTML with inlined bundle
  const html = generateStandaloneHTML(bundleCode);

  // Write to BOTH locations - no manual copy step needed
  // 1. dist/ - for dashboard-ui npm package exports and VSCode
  const distPath = join(distDir, 'loki-dashboard-standalone.html');
  writeFileSync(distPath, html);

  // 2. dashboard/static/ - served directly by the Python API server
  const serverPath = join(serverStaticDir, 'index.html');
  writeFileSync(serverPath, html);

  console.log(`Built: dist/loki-dashboard-standalone.html (${bundleSize} KB)`);
  console.log(`Built: dashboard/static/index.html (${bundleSize} KB)`);

  return distPath;
}

/**
 * Generate complete standalone HTML
 * @param {string} bundleCode - Minified JavaScript bundle
 * @returns {string} Complete HTML document
 */
function generateStandaloneHTML(bundleCode) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Loki Mode Dashboard - Self-contained autonomous AI system monitor">
  <meta name="theme-color" content="#d97757">
  <title>Loki Mode Dashboard</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%23d97757' rx='15' width='100' height='100'/><text x='50' y='72' font-size='60' font-weight='bold' text-anchor='middle' fill='white'>L</text></svg>">
  <style>
    /* CSS Reset and Base Styles */
    :root {
      /* Light theme (default) */
      --loki-bg-primary: #faf9f0;
      --loki-bg-secondary: #f5f4eb;
      --loki-bg-tertiary: #eeeddf;
      --loki-bg-card: #ffffff;
      --loki-bg-hover: #f0efe6;
      --loki-text-primary: #1a1a1a;
      --loki-text-secondary: #5c5c5c;
      --loki-text-muted: #8a8a8a;
      --loki-accent: #d97757;
      --loki-accent-hover: #c56a4c;
      --loki-border: #e5e3de;
      --loki-border-light: #d4d2cb;
      --loki-success: #16a34a;
      --loki-warning: #ca8a04;
      --loki-error: #dc2626;
      --loki-info: #2563eb;
      --loki-transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --loki-bg-primary: #131314;
        --loki-bg-secondary: #1a1a1b;
        --loki-bg-tertiary: #232325;
        --loki-bg-card: #1e1e20;
        --loki-bg-hover: #2a2a2d;
        --loki-text-primary: #f5f5f5;
        --loki-text-secondary: #a1a1a6;
        --loki-text-muted: #6b6b70;
        --loki-accent: #d97757;
        --loki-accent-hover: #e08668;
        --loki-border: #2d2d30;
        --loki-border-light: #3d3d42;
        --loki-success: #22c55e;
        --loki-warning: #eab308;
        --loki-error: #ef4444;
        --loki-info: #3b82f6;
      }
    }

    [data-loki-theme="dark"] {
      --loki-bg-primary: #131314;
      --loki-bg-secondary: #1a1a1b;
      --loki-bg-tertiary: #232325;
      --loki-bg-card: #1e1e20;
      --loki-bg-hover: #2a2a2d;
      --loki-text-primary: #f5f5f5;
      --loki-text-secondary: #a1a1a6;
      --loki-text-muted: #6b6b70;
      --loki-accent: #d97757;
      --loki-accent-hover: #e08668;
      --loki-border: #2d2d30;
      --loki-border-light: #3d3d42;
      --loki-success: #22c55e;
      --loki-warning: #eab308;
      --loki-error: #ef4444;
      --loki-info: #3b82f6;
    }

    [data-loki-theme="light"] {
      --loki-bg-primary: #faf9f0;
      --loki-bg-secondary: #f5f4eb;
      --loki-bg-tertiary: #eeeddf;
      --loki-bg-card: #ffffff;
      --loki-bg-hover: #f0efe6;
      --loki-text-primary: #1a1a1a;
      --loki-text-secondary: #5c5c5c;
      --loki-text-muted: #8a8a8a;
      --loki-accent: #d97757;
      --loki-accent-hover: #c56a4c;
      --loki-border: #e5e3de;
      --loki-border-light: #d4d2cb;
      --loki-success: #16a34a;
      --loki-warning: #ca8a04;
      --loki-error: #dc2626;
      --loki-info: #2563eb;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--loki-bg-primary);
      color: var(--loki-text-primary);
      min-height: 100vh;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      transition: background var(--loki-transition), color var(--loki-transition);
    }

    /* Dashboard Layout */
    .dashboard-layout {
      display: grid;
      grid-template-columns: 280px 1fr;
      grid-template-rows: auto 1fr;
      min-height: 100vh;
    }

    @media (max-width: 768px) {
      .dashboard-layout {
        grid-template-columns: 1fr;
      }
      .sidebar {
        display: none;
      }
      .sidebar.mobile-open {
        display: block;
        position: fixed;
        left: 0;
        top: 0;
        bottom: 0;
        width: 280px;
        z-index: 100;
        background: var(--loki-bg-secondary);
      }
    }

    /* Header */
    .header {
      grid-column: 1 / -1;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 20px;
      background: var(--loki-bg-secondary);
      border-bottom: 1px solid var(--loki-border);
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .logo-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, var(--loki-accent), var(--loki-accent-hover));
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
      color: white;
    }

    .logo-text {
      font-size: 16px;
      font-weight: 600;
    }

    .header-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .theme-toggle, .api-btn {
      padding: 6px 12px;
      background: var(--loki-bg-tertiary);
      border: 1px solid var(--loki-border);
      border-radius: 6px;
      font-size: 12px;
      color: var(--loki-text-secondary);
      cursor: pointer;
      transition: all var(--loki-transition);
    }

    .theme-toggle:hover, .api-btn:hover {
      background: var(--loki-bg-hover);
      color: var(--loki-text-primary);
    }

    .api-url-input {
      padding: 6px 10px;
      background: var(--loki-bg-card);
      border: 1px solid var(--loki-border);
      border-radius: 6px;
      font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--loki-text-primary);
      width: 200px;
    }

    .api-url-input:focus {
      outline: none;
      border-color: var(--loki-accent);
    }

    /* Sidebar */
    .sidebar {
      padding: 16px;
      background: var(--loki-bg-secondary);
      border-right: 1px solid var(--loki-border);
      overflow-y: auto;
    }

    /* Main Content */
    .main-content {
      padding: 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* Section */
    .section {
      background: var(--loki-bg-card);
      border: 1px solid var(--loki-border);
      border-radius: 10px;
      padding: 16px;
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--loki-text-primary);
    }

    /* Offline Banner */
    .offline-banner {
      grid-column: 1 / -1;
      background: var(--loki-warning);
      color: #1a1a1a;
      padding: 8px 16px;
      text-align: center;
      font-size: 13px;
      font-weight: 500;
      display: none;
    }

    .offline-banner.show {
      display: block;
    }

    /* Grid layouts */
    .two-column {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }

    @media (max-width: 1024px) {
      .two-column {
        grid-template-columns: 1fr;
      }
    }

    /* Loading state */
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px;
      color: var(--loki-text-muted);
    }

    .loading::after {
      content: '';
      width: 20px;
      height: 20px;
      margin-left: 10px;
      border: 2px solid var(--loki-border);
      border-top-color: var(--loki-accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Mobile menu button */
    .mobile-menu-btn {
      display: none;
      padding: 8px;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--loki-text-primary);
    }

    @media (max-width: 768px) {
      .mobile-menu-btn {
        display: block;
      }
    }
  </style>
</head>
<body>
  <!-- Offline Banner -->
  <div class="offline-banner" id="offline-banner">
    Offline - showing cached data
  </div>

  <!-- Dashboard Layout -->
  <div class="dashboard-layout">
    <!-- Header -->
    <header class="header">
      <div class="logo">
        <button class="mobile-menu-btn" id="mobile-menu-btn" aria-label="Toggle menu">
          <svg width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none">
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="6" x2="21" y2="6"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
        <div class="logo-icon">L</div>
        <span class="logo-text">Loki Mode</span>
      </div>
      <div class="header-actions">
        <input type="text" class="api-url-input" id="api-url" placeholder="API URL">
        <button class="api-btn" id="connect-btn">Connect</button>
        <button class="theme-toggle" id="theme-toggle">
          <span id="theme-label">Theme</span>
        </button>
      </div>
    </header>

    <!-- Sidebar -->
    <aside class="sidebar" id="sidebar">
      <loki-session-control id="session-control"></loki-session-control>
    </aside>

    <!-- Main Content -->
    <main class="main-content">
      <!-- Task Board -->
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">Tasks</h2>
        </div>
        <loki-task-board id="task-board"></loki-task-board>
      </section>

      <!-- Two Column: Logs + Memory -->
      <div class="two-column">
        <!-- Log Stream -->
        <section class="section">
          <div class="section-header">
            <h2 class="section-title">Logs</h2>
          </div>
          <loki-log-stream id="log-stream" auto-scroll max-lines="100"></loki-log-stream>
        </section>

        <!-- Memory Browser -->
        <section class="section">
          <div class="section-header">
            <h2 class="section-title">Memory</h2>
          </div>
          <loki-memory-browser id="memory-browser" tab="summary"></loki-memory-browser>
        </section>
      </div>

      <!-- Learning Dashboard -->
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">Learning Metrics</h2>
        </div>
        <loki-learning-dashboard id="learning-dashboard" time-range="7d"></loki-learning-dashboard>
      </section>
    </main>
  </div>

  <!-- Inlined JavaScript Bundle -->
  <script>
${bundleCode}

// Initialize dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  // Initialize the dashboard with auto-detect
  const initResult = LokiDashboard.init({ autoDetectContext: true });
  console.log('Loki Dashboard initialized:', initResult);

  // Theme toggle functionality
  const themeToggle = document.getElementById('theme-toggle');
  const themeLabel = document.getElementById('theme-label');

  function updateThemeLabel() {
    const theme = LokiDashboard.UnifiedThemeManager.getTheme();
    themeLabel.textContent = theme.includes('dark') ? 'Light' : 'Dark';
  }

  themeToggle.addEventListener('click', function() {
    LokiDashboard.UnifiedThemeManager.toggle();
    updateThemeLabel();
  });

  // Initialize theme label
  updateThemeLabel();

  // API URL configuration - auto-detect from current server
  const apiUrlInput = document.getElementById('api-url');
  const connectBtn = document.getElementById('connect-btn');
  const detectedUrl = window.location.origin;
  apiUrlInput.value = detectedUrl;

  function updateComponentsApiUrl(apiUrl) {
    const components = [
      'task-board',
      'session-control',
      'log-stream',
      'memory-browser',
      'learning-dashboard'
    ];
    components.forEach(function(id) {
      const el = document.getElementById(id);
      if (el) el.setAttribute('api-url', apiUrl);
    });
    console.log('API URL updated:', apiUrl);
  }

  // Auto-connect to current server on load
  updateComponentsApiUrl(detectedUrl);

  connectBtn.addEventListener('click', function() {
    updateComponentsApiUrl(apiUrlInput.value);
  });

  // Offline detection
  window.addEventListener('online', function() {
    document.getElementById('offline-banner').classList.remove('show');
  });

  window.addEventListener('offline', function() {
    document.getElementById('offline-banner').classList.add('show');
  });

  // Check initial online status
  if (!navigator.onLine) {
    document.getElementById('offline-banner').classList.add('show');
  }

  // Mobile menu toggle
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const sidebar = document.getElementById('sidebar');

  mobileMenuBtn.addEventListener('click', function() {
    sidebar.classList.toggle('mobile-open');
  });

  // Close sidebar when clicking outside on mobile
  document.addEventListener('click', function(e) {
    if (window.innerWidth <= 768 &&
        sidebar.classList.contains('mobile-open') &&
        !sidebar.contains(e.target) &&
        !mobileMenuBtn.contains(e.target)) {
      sidebar.classList.remove('mobile-open');
    }
  });

  // Add initial log entry and verify connection
  setTimeout(function() {
    const logStream = document.getElementById('log-stream');
    if (logStream && logStream.addLog) {
      logStream.addLog('Dashboard initialized', 'success');
      logStream.addLog('Connecting to ' + detectedUrl + '...', 'info');
      // Verify API is reachable
      fetch(detectedUrl + '/health').then(function(r) {
        return r.json();
      }).then(function(data) {
        if (data.status === 'healthy') {
          logStream.addLog('Connected to API', 'success');
        }
      }).catch(function() {
        logStream.addLog('API not reachable at ' + detectedUrl, 'error');
      });
    }
  }, 500);
});
  </script>
</body>
</html>`;
}

/**
 * Watch mode for development
 */
async function watchBuild() {
  console.log('Watch mode enabled...');

  const distDir = join(__dirname, '..', 'dist');
  const entryPoint = join(__dirname, '..', 'index.js');

  const ctx = await esbuild.context({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'iife',
    globalName: 'LokiDashboard',
    minify: false,
    write: false,
    target: ['es2020'],
    logLevel: 'warning',
  });

  // Initial build
  await buildStandalone();

  // Watch for changes
  const result = await ctx.rebuild();
  console.log('Watching for changes... Press Ctrl+C to stop.');

  // Simple watch loop
  const chokidar = await import('chokidar').catch(() => null);
  if (chokidar) {
    const watcher = chokidar.watch([
      join(__dirname, '..', 'index.js'),
      join(__dirname, '..', 'core', '*.js'),
      join(__dirname, '..', 'components', '*.js'),
    ], {
      ignoreInitial: true,
    });

    watcher.on('change', async (path) => {
      console.log(`File changed: ${path}`);
      await buildStandalone();
    });
  } else {
    console.log('Note: Install chokidar for automatic rebuild on file changes');
    console.log('  npm install --save-dev chokidar');
  }
}

// Main execution
async function main() {
  const startTime = Date.now();

  try {
    if (watchMode) {
      await watchBuild();
    } else {
      await buildStandalone();
      const elapsed = Date.now() - startTime;
      console.log(`Build complete in ${elapsed}ms`);
    }
  } catch (error) {
    console.error('Build failed:', error.message);
    process.exit(1);
  }
}

main();
