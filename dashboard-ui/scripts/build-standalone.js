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
  <meta name="theme-color" content="#8b5cf6">
  <title>Loki Mode Dashboard</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32'><path d='M16 6C8 6 2 16 2 16s6 10 14 10 14-10 14-10S24 6 16 6z' fill='none' stroke='%237c3aed' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><circle cx='16' cy='16' r='5' fill='%237c3aed'/><circle cx='16' cy='16' r='2' fill='%23fff'/></svg>">
  <style>
    /* CSS Reset and Base Styles */
    :root {
      /* Light theme (default) */
      --loki-bg-primary: #fafafa;
      --loki-bg-secondary: #f4f4f5;
      --loki-bg-tertiary: #e4e4e7;
      --loki-bg-card: #ffffff;
      --loki-bg-hover: #f0f0f3;
      --loki-text-primary: #18181b;
      --loki-text-secondary: #52525b;
      --loki-text-muted: #a1a1aa;
      --loki-accent: #7c3aed;
      --loki-accent-hover: #6d28d9;
      --loki-border: #e4e4e7;
      --loki-border-light: #d4d4d8;
      --loki-success: #16a34a;
      --loki-warning: #ca8a04;
      --loki-error: #dc2626;
      --loki-info: #2563eb;
      --loki-transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --loki-bg-primary: #09090b;
        --loki-bg-secondary: #0c0c0f;
        --loki-bg-tertiary: #111114;
        --loki-bg-card: #18181b;
        --loki-bg-hover: #1f1f23;
        --loki-text-primary: #fafafa;
        --loki-text-secondary: #a1a1aa;
        --loki-text-muted: #52525b;
        --loki-accent: #8b5cf6;
        --loki-accent-hover: #a78bfa;
        --loki-border: rgba(255, 255, 255, 0.06);
        --loki-border-light: rgba(255, 255, 255, 0.1);
        --loki-success: #22c55e;
        --loki-warning: #eab308;
        --loki-error: #ef4444;
        --loki-info: #3b82f6;
      }
    }

    [data-loki-theme="light"] {
      --loki-bg-primary: #fafafa;
      --loki-bg-secondary: #f4f4f5;
      --loki-bg-tertiary: #e4e4e7;
      --loki-bg-card: #ffffff;
      --loki-bg-hover: #f0f0f3;
      --loki-text-primary: #18181b;
      --loki-text-secondary: #52525b;
      --loki-text-muted: #a1a1aa;
      --loki-accent: #7c3aed;
      --loki-accent-hover: #6d28d9;
      --loki-border: #e4e4e7;
      --loki-border-light: #d4d4d8;
      --loki-success: #16a34a;
      --loki-warning: #ca8a04;
      --loki-error: #dc2626;
      --loki-info: #2563eb;
    }

    [data-loki-theme="dark"] {
      --loki-bg-primary: #09090b;
      --loki-bg-secondary: #0c0c0f;
      --loki-bg-tertiary: #111114;
      --loki-bg-card: #18181b;
      --loki-bg-hover: #1f1f23;
      --loki-text-primary: #fafafa;
      --loki-text-secondary: #a1a1aa;
      --loki-text-muted: #52525b;
      --loki-accent: #8b5cf6;
      --loki-accent-hover: #a78bfa;
      --loki-border: rgba(255, 255, 255, 0.06);
      --loki-border-light: rgba(255, 255, 255, 0.1);
      --loki-success: #22c55e;
      --loki-warning: #eab308;
      --loki-error: #ef4444;
      --loki-info: #3b82f6;
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
      grid-template-columns: 240px 1fr;
      grid-template-rows: 1fr;
      min-height: 100vh;
    }

    @media (max-width: 768px) {
      .dashboard-layout {
        grid-template-columns: 1fr;
      }
      .sidebar { display: none; }
      .sidebar.mobile-open {
        display: flex;
        position: fixed;
        left: 0; top: 0; bottom: 0;
        width: 240px;
        z-index: 100;
      }
    }

    /* Sidebar */
    .sidebar {
      display: flex;
      flex-direction: column;
      background: var(--loki-bg-card);
      border-right: 1px solid var(--loki-border);
      overflow-y: auto;
    }

    .sidebar-logo {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 20px 16px 16px;
    }

    .logo-icon {
      width: 28px;
      height: 28px;
      background: linear-gradient(135deg, #8b5cf6, #6d28d9);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 12px;
      color: white;
    }

    .logo-text {
      font-size: 14px;
      font-weight: 600;
      color: var(--loki-text-primary);
    }

    /* Navigation */
    .nav-links {
      display: flex;
      flex-direction: column;
      padding: 8px;
      gap: 2px;
      flex: 1;
    }

    .nav-link {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      color: var(--loki-text-secondary);
      cursor: pointer;
      transition: all 0.15s ease;
      border: 1px solid transparent;
      background: none;
      text-align: left;
      width: 100%;
      font-family: inherit;
    }

    .nav-link:hover {
      color: var(--loki-text-primary);
      background: var(--loki-bg-hover);
    }

    .nav-link.active {
      color: var(--loki-accent);
      background: rgba(124, 58, 237, 0.08);
      border-color: rgba(124, 58, 237, 0.12);
    }

    .nav-link svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      stroke-width: 2;
      fill: none;
      flex-shrink: 0;
    }

    /* Sidebar footer */
    .sidebar-footer {
      padding: 12px;
      border-top: 1px solid var(--loki-border);
    }

    .sidebar-controls {
      display: flex;
      gap: 6px;
      align-items: center;
      padding: 8px 4px 0;
    }

    .theme-toggle, .api-btn {
      padding: 5px 10px;
      background: var(--loki-bg-tertiary);
      border: 1px solid var(--loki-border);
      border-radius: 6px;
      font-size: 11px;
      color: var(--loki-text-secondary);
      cursor: pointer;
      transition: all var(--loki-transition);
      font-family: inherit;
    }

    .theme-toggle:hover, .api-btn:hover {
      background: var(--loki-bg-hover);
      color: var(--loki-text-primary);
    }

    .api-url-input {
      padding: 5px 8px;
      background: var(--loki-bg-card);
      border: 1px solid var(--loki-border);
      border-radius: 6px;
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--loki-text-primary);
      flex: 1;
      min-width: 0;
    }

    .api-url-input:focus {
      outline: none;
      border-color: var(--loki-accent);
    }

    /* Main Content */
    .main-content {
      padding: 24px 28px;
      overflow-y: auto;
      height: 100vh;
      scroll-behavior: smooth;
    }

    /* Section pages */
    .section-page {
      padding-bottom: 32px;
    }

    .section-page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-top: 4px;
    }

    .section-page-title {
      font-size: 20px;
      font-weight: 600;
      color: var(--loki-text-primary);
    }

    /* Overview handled by <loki-overview> shadow DOM */

    /* Offline Banner */
    .offline-banner {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: var(--loki-warning);
      color: #18181b;
      padding: 8px 16px;
      text-align: center;
      font-size: 13px;
      font-weight: 500;
      display: none;
      z-index: 999;
    }

    .offline-banner.show {
      display: block;
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

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.2); }

    /* Keyboard Shortcuts Help Overlay */
    .shortcuts-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }

    .shortcuts-overlay.visible {
      display: flex;
    }

    .shortcuts-dialog {
      background: var(--loki-bg-card);
      border: 1px solid var(--loki-border);
      border-radius: 12px;
      padding: 24px;
      max-width: 480px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }

    .shortcuts-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--loki-border);
    }

    .shortcuts-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--loki-text-primary);
    }

    .shortcuts-close {
      background: none;
      border: none;
      color: var(--loki-text-muted);
      cursor: pointer;
      padding: 4px;
      font-size: 18px;
      line-height: 1;
    }

    .shortcuts-close:hover {
      color: var(--loki-text-primary);
    }

    .shortcuts-group {
      margin-bottom: 16px;
    }

    .shortcuts-group-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--loki-text-muted);
      margin-bottom: 8px;
    }

    .shortcut-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 0;
    }

    .shortcut-keys {
      display: flex;
      gap: 4px;
    }

    .shortcut-key {
      display: inline-block;
      padding: 2px 8px;
      background: var(--loki-bg-tertiary);
      border: 1px solid var(--loki-border);
      border-radius: 4px;
      font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--loki-text-primary);
      min-width: 24px;
      text-align: center;
    }

    .shortcut-desc {
      font-size: 13px;
      color: var(--loki-text-secondary);
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
    <!-- Sidebar -->
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-logo">
        <button class="mobile-menu-btn" id="mobile-menu-btn" aria-label="Toggle menu">
          <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none">
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="6" x2="21" y2="6"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
        <div class="logo-icon">L</div>
        <span class="logo-text">Loki Mode</span>
      </div>

      <nav class="nav-links">
        <button class="nav-link active" data-section="overview" id="nav-overview">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Overview
        </button>
        <button class="nav-link" data-section="tasks" id="nav-tasks">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          Tasks
        </button>
        <button class="nav-link" data-section="logs" id="nav-logs">
          <svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Logs
        </button>
        <button class="nav-link" data-section="memory" id="nav-memory">
          <svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>
          Memory
        </button>
        <button class="nav-link" data-section="learning" id="nav-learning">
          <svg viewBox="0 0 24 24"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
          Learning
        </button>
        <button class="nav-link" data-section="council" id="nav-council">
          <svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
          Council
        </button>
        <button class="nav-link" data-section="cost" id="nav-cost">
          <svg viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
          Cost
        </button>
        <button class="nav-link" data-section="checkpoint" id="nav-checkpoint">
          <svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Checkpoints
        </button>
        <button class="nav-link" data-section="context" id="nav-context">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          Context
        </button>
        <button class="nav-link" data-section="notifications" id="nav-notifications">
          <svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
          Notifications
          <span class="notification-badge" id="notif-badge" style="display:none;background:var(--loki-red);color:#fff;font-size:10px;padding:1px 5px;border-radius:8px;margin-left:4px;">0</span>
        </button>
      </nav>

      <div class="sidebar-footer">
        <loki-session-control id="session-control"></loki-session-control>
        <div class="sidebar-controls">
          <input type="text" class="api-url-input" id="api-url" placeholder="API URL">
          <button class="api-btn" id="connect-btn">Go</button>
          <button class="theme-toggle" id="theme-toggle" title="Toggle theme (T)">
            <svg id="theme-icon-sun" width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" style="display:none"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            <svg id="theme-icon-moon" width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" style="display:none"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
            <span id="theme-label">Dark</span>
          </button>
        </div>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="main-content" id="main-content">
      <!-- Overview (default) -->
      <div class="section-page" id="page-overview">
        <loki-overview id="overview"></loki-overview>
      </div>

      <!-- Task Board -->
      <div class="section-page" id="page-tasks">
        <div class="section-page-header">
          <h2 class="section-page-title">Tasks</h2>
        </div>
        <loki-task-board id="task-board"></loki-task-board>
      </div>

      <!-- Log Stream -->
      <div class="section-page" id="page-logs">
        <div class="section-page-header">
          <h2 class="section-page-title">Logs</h2>
        </div>
        <loki-log-stream id="log-stream" auto-scroll max-lines="500"></loki-log-stream>
      </div>

      <!-- Memory Browser -->
      <div class="section-page" id="page-memory">
        <div class="section-page-header">
          <h2 class="section-page-title">Memory</h2>
        </div>
        <loki-memory-browser id="memory-browser" tab="summary"></loki-memory-browser>
      </div>

      <!-- Learning Dashboard -->
      <div class="section-page" id="page-learning">
        <div class="section-page-header">
          <h2 class="section-page-title">Learning Metrics</h2>
        </div>
        <loki-learning-dashboard id="learning-dashboard" time-range="7d"></loki-learning-dashboard>
      </div>

      <!-- Completion Council -->
      <div class="section-page" id="page-council">
        <div class="section-page-header">
          <h2 class="section-page-title">Completion Council</h2>
        </div>
        <loki-council-dashboard id="council-dashboard"></loki-council-dashboard>
      </div>

      <!-- Cost Dashboard -->
      <div class="section-page" id="page-cost">
        <div class="section-page-header">
          <h2 class="section-page-title">Cost</h2>
        </div>
        <loki-cost-dashboard id="cost-dashboard"></loki-cost-dashboard>
      </div>

      <!-- Checkpoints -->
      <div class="section-page" id="page-checkpoint">
        <div class="section-page-header">
          <h2 class="section-page-title">Checkpoints</h2>
        </div>
        <loki-checkpoint-viewer id="checkpoint-viewer"></loki-checkpoint-viewer>
      </div>

      <!-- Context Window Tracking -->
      <div class="section-page" id="page-context">
        <div class="section-page-header">
          <h2 class="section-page-title">Context Window</h2>
        </div>
        <loki-context-tracker id="context-tracker"></loki-context-tracker>
      </div>

      <!-- Notifications -->
      <div class="section-page" id="page-notifications">
        <div class="section-page-header">
          <h2 class="section-page-title">Notifications</h2>
        </div>
        <loki-notification-center id="notification-center"></loki-notification-center>
      </div>
    </main>
  </div>

  <!-- Keyboard Shortcuts Help Overlay -->
  <div class="shortcuts-overlay" id="shortcuts-overlay">
    <div class="shortcuts-dialog">
      <div class="shortcuts-header">
        <span class="shortcuts-title">Keyboard Shortcuts</span>
        <button class="shortcuts-close" id="shortcuts-close" aria-label="Close">&times;</button>
      </div>
      <div class="shortcuts-group">
        <div class="shortcuts-group-title">Navigation</div>
        <div class="shortcut-row"><span class="shortcut-desc">Overview</span><span class="shortcut-keys"><kbd class="shortcut-key">1</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Tasks</span><span class="shortcut-keys"><kbd class="shortcut-key">2</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Logs</span><span class="shortcut-keys"><kbd class="shortcut-key">3</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Memory</span><span class="shortcut-keys"><kbd class="shortcut-key">4</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Learning</span><span class="shortcut-keys"><kbd class="shortcut-key">5</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Council</span><span class="shortcut-keys"><kbd class="shortcut-key">6</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Cost</span><span class="shortcut-keys"><kbd class="shortcut-key">7</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Checkpoints</span><span class="shortcut-keys"><kbd class="shortcut-key">8</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Context</span><span class="shortcut-keys"><kbd class="shortcut-key">9</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Notifications</span><span class="shortcut-keys"><kbd class="shortcut-key">0</kbd></span></div>
      </div>
      <div class="shortcuts-group">
        <div class="shortcuts-group-title">Session</div>
        <div class="shortcut-row"><span class="shortcut-desc">Pause session</span><span class="shortcut-keys"><kbd class="shortcut-key">p</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Resume session</span><span class="shortcut-keys"><kbd class="shortcut-key">r</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Stop session</span><span class="shortcut-keys"><kbd class="shortcut-key">s</kbd></span></div>
      </div>
      <div class="shortcuts-group">
        <div class="shortcuts-group-title">General</div>
        <div class="shortcut-row"><span class="shortcut-desc">Toggle theme</span><span class="shortcut-keys"><kbd class="shortcut-key">t</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Focus API URL</span><span class="shortcut-keys"><kbd class="shortcut-key">/</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Show shortcuts</span><span class="shortcut-keys"><kbd class="shortcut-key">?</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Close overlay</span><span class="shortcut-keys"><kbd class="shortcut-key">Esc</kbd></span></div>
      </div>
    </div>
  </div>

  <!-- Inlined JavaScript Bundle -->
  <script>
${bundleCode}

// Initialize dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  // Initialize the dashboard with auto-detect
  var initResult = LokiDashboard.init({ autoDetectContext: true });
  console.log('Loki Dashboard initialized:', initResult);

  // Theme toggle functionality
  var themeToggle = document.getElementById('theme-toggle');
  var themeLabel = document.getElementById('theme-label');

  var sunIcon = document.getElementById('theme-icon-sun');
  var moonIcon = document.getElementById('theme-icon-moon');

  function updateThemeUI() {
    var theme = LokiDashboard.UnifiedThemeManager.getTheme();
    var isDark = theme.includes('dark') || theme === 'high-contrast';
    themeLabel.textContent = isDark ? 'Light' : 'Dark';
    if (sunIcon) sunIcon.style.display = isDark ? 'inline' : 'none';
    if (moonIcon) moonIcon.style.display = isDark ? 'none' : 'inline';
  }

  themeToggle.addEventListener('click', function() {
    LokiDashboard.UnifiedThemeManager.toggle();
    updateThemeUI();
  });

  window.addEventListener('loki-theme-change', function() {
    updateThemeUI();
  });

  updateThemeUI();

  // API URL configuration - auto-detect from current server
  var apiUrlInput = document.getElementById('api-url');
  var connectBtn = document.getElementById('connect-btn');
  var detectedUrl = window.location.origin;
  apiUrlInput.value = detectedUrl;

  function updateComponentsApiUrl(apiUrl) {
    var components = [
      'overview',
      'task-board',
      'session-control',
      'log-stream',
      'memory-browser',
      'learning-dashboard',
      'council-dashboard',
      'cost-dashboard',
      'checkpoint-viewer',
      'context-tracker',
      'notification-center'
    ];
    components.forEach(function(id) {
      var el = document.getElementById(id);
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

  if (!navigator.onLine) {
    document.getElementById('offline-banner').classList.add('show');
  }

  // Mobile menu toggle
  var mobileMenuBtn = document.getElementById('mobile-menu-btn');
  var sidebar = document.getElementById('sidebar');

  mobileMenuBtn.addEventListener('click', function() {
    sidebar.classList.toggle('mobile-open');
  });

  document.addEventListener('click', function(e) {
    if (window.innerWidth <= 768 &&
        sidebar.classList.contains('mobile-open') &&
        !sidebar.contains(e.target) &&
        !mobileMenuBtn.contains(e.target)) {
      sidebar.classList.remove('mobile-open');
    }
  });

  // --- Section Navigation ---
  var navLinks = document.querySelectorAll('.nav-link');
  var mainContent = document.getElementById('main-content');

  function switchSection(sectionId) {
    var pageEl = document.getElementById('page-' + sectionId);
    if (pageEl) {
      pageEl.scrollIntoView({ behavior: 'smooth' });
    }
    navLinks.forEach(function(link) { link.classList.remove('active'); });
    var navEl = document.querySelector('.nav-link[data-section="' + sectionId + '"]');
    if (navEl) navEl.classList.add('active');
    localStorage.setItem('loki-active-section', sectionId);
  }

  navLinks.forEach(function(link) {
    link.addEventListener('click', function() {
      switchSection(link.dataset.section);
      // Close mobile sidebar
      if (window.innerWidth <= 768) {
        sidebar.classList.remove('mobile-open');
      }
    });
  });

  // IntersectionObserver to track active section on scroll
  var sectionPages = document.querySelectorAll('.section-page');
  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting && entry.intersectionRatio > 0.3) {
        var sectionId = entry.target.id.replace('page-', '');
        navLinks.forEach(function(link) { link.classList.remove('active'); });
        var navEl = document.querySelector('.nav-link[data-section="' + sectionId + '"]');
        if (navEl) navEl.classList.add('active');
      }
    });
  }, { root: mainContent, threshold: 0.3 });

  sectionPages.forEach(function(page) { observer.observe(page); });

  // Keyboard shortcuts: Cmd/Ctrl + 1-7
  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && ((e.key >= '1' && e.key <= '9') || e.key === '0')) {
      e.preventDefault();
      var sections = ['overview', 'tasks', 'logs', 'memory', 'learning', 'council', 'cost', 'checkpoint', 'context', 'notifications'];
      var idx = e.key === '0' ? 9 : parseInt(e.key) - 1;
      if (idx < sections.length) switchSection(sections[idx]);
    }
  });

  // --- Keyboard Shortcuts (Issue #18) ---
  var shortcutsOverlay = document.getElementById('shortcuts-overlay');
  var shortcutsClose = document.getElementById('shortcuts-close');

  function toggleShortcutsOverlay() {
    shortcutsOverlay.classList.toggle('visible');
  }

  function closeShortcutsOverlay() {
    shortcutsOverlay.classList.remove('visible');
  }

  shortcutsClose.addEventListener('click', closeShortcutsOverlay);

  // Close overlay when clicking outside the dialog
  shortcutsOverlay.addEventListener('click', function(e) {
    if (e.target === shortcutsOverlay) {
      closeShortcutsOverlay();
    }
  });

  document.addEventListener('keydown', function(e) {
    // Skip shortcuts when typing in input, textarea, or select elements
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
      // Allow Escape to blur input fields
      if (e.key === 'Escape') {
        e.target.blur();
      }
      return;
    }

    // Skip if modifier keys are held (let browser defaults work)
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    var sections = ['overview', 'tasks', 'logs', 'memory', 'learning', 'council', 'cost', 'checkpoint'];

    switch (e.key) {
      // Section navigation: 1-8
      case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8':
        e.preventDefault();
        switchSection(sections[parseInt(e.key) - 1]);
        break;

      // Help overlay
      case '?':
        e.preventDefault();
        toggleShortcutsOverlay();
        break;

      // Close overlays
      case 'Escape':
        if (shortcutsOverlay.classList.contains('visible')) {
          e.preventDefault();
          closeShortcutsOverlay();
        }
        break;

      // Focus API URL input
      case '/':
        e.preventDefault();
        apiUrlInput.focus();
        apiUrlInput.select();
        break;

      // Theme toggle
      case 't':
        e.preventDefault();
        LokiDashboard.UnifiedThemeManager.toggle();
        updateThemeUI();
        break;

      // Session controls
      case 'p':
        e.preventDefault();
        var sessionCtrl = document.getElementById('session-control');
        if (sessionCtrl) {
          var pauseBtn = sessionCtrl.shadowRoot && sessionCtrl.shadowRoot.getElementById('pause-btn');
          if (pauseBtn && !pauseBtn.disabled) {
            pauseBtn.click();
          }
        }
        break;

      case 'r':
        e.preventDefault();
        var sessionCtrl2 = document.getElementById('session-control');
        if (sessionCtrl2) {
          var resumeBtn = sessionCtrl2.shadowRoot && sessionCtrl2.shadowRoot.getElementById('resume-btn');
          if (resumeBtn) {
            resumeBtn.click();
          }
        }
        break;

      case 's':
        e.preventDefault();
        var sessionCtrl3 = document.getElementById('session-control');
        if (sessionCtrl3) {
          var stopBtn = sessionCtrl3.shadowRoot && sessionCtrl3.shadowRoot.getElementById('stop-btn');
          if (stopBtn && !stopBtn.disabled) {
            if (window.confirm('Are you sure you want to stop the session?')) {
              stopBtn.click();
            }
          }
        }
        break;
    }
  });

  // Restore last section from localStorage
  var savedSection = localStorage.getItem('loki-active-section');
  if (savedSection) {
    setTimeout(function() { switchSection(savedSection); }, 100);
  }

  // Add initial log entry and verify connection
  setTimeout(function() {
    var logStream = document.getElementById('log-stream');
    if (logStream && logStream.addLog) {
      logStream.addLog('Dashboard initialized', 'success');
      logStream.addLog('Connecting to ' + detectedUrl + '...', 'info');
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

  // Overview cards are now handled by the <loki-overview> component
  // which polls /api/status reactively via the unified API client.
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
