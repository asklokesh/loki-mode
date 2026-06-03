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
  <meta name="theme-color" content="#553DE9">
  <title>Loki Mode Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32'><path d='M16 6C8 6 2 16 2 16s6 10 14 10 14-10 14-10S24 6 16 6z' fill='none' stroke='%23553DE9' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><circle cx='16' cy='16' r='5' fill='%23553DE9'/><circle cx='16' cy='16' r='2' fill='%23fff'/></svg>">
  <style>
    /* Loki Mode Design Language */
    :root {
      /* Light theme (default - cream/editorial) */
      --loki-bg-primary: #FAFAF7;
      --loki-bg-secondary: #F2F0EB;
      --loki-bg-tertiary: #E8E5DE;
      --loki-bg-card: rgba(255, 255, 255, 0.72);
      --loki-bg-hover: #EDEAE4;
      --loki-text-primary: #1A1614;
      --loki-text-secondary: #4A4640;
      --loki-text-muted: #8A857C;
      --loki-accent: #553DE9;
      --loki-accent-hover: #4432c4;
      --loki-accent-glow: rgba(85, 61, 233, 0.15);
      --loki-border: rgba(0, 0, 0, 0.08);
      --loki-border-light: rgba(0, 0, 0, 0.05);
      --loki-success: #1AAF95;
      --loki-warning: #C4922E;
      --loki-error: #C04848;
      --loki-info: #2F71E3;
      --loki-glass-bg: rgba(255, 255, 255, 0.55);
      --loki-glass-border: rgba(255, 255, 255, 0.35);
      --loki-glass-shadow: 0 4px 24px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
      --loki-transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --loki-bg-primary: #0F0B1A;
        --loki-bg-secondary: #150F24;
        --loki-bg-tertiary: #1E1533;
        --loki-bg-card: rgba(30, 21, 51, 0.72);
        --loki-bg-hover: #251C3D;
        --loki-text-primary: #F0ECF8;
        --loki-text-secondary: #B8B0C8;
        --loki-text-muted: #7B6FA0;
        --loki-accent: #7B6BF0;
        --loki-accent-hover: #9488F5;
        --loki-accent-glow: rgba(123, 107, 240, 0.2);
        --loki-border: rgba(255, 255, 255, 0.08);
        --loki-border-light: rgba(255, 255, 255, 0.04);
        --loki-success: #2ED8B6;
        --loki-warning: #E8B84A;
        --loki-error: #E07070;
        --loki-info: #5A9CF5;
        --loki-glass-bg: rgba(20, 14, 38, 0.65);
        --loki-glass-border: rgba(255, 255, 255, 0.08);
        --loki-glass-shadow: 0 4px 24px rgba(0, 0, 0, 0.25), 0 1px 2px rgba(0, 0, 0, 0.12);
      }
    }

    [data-loki-theme="light"] {
      --loki-bg-primary: #FAFAF7;
      --loki-bg-secondary: #F2F0EB;
      --loki-bg-tertiary: #E8E5DE;
      --loki-bg-card: rgba(255, 255, 255, 0.72);
      --loki-bg-hover: #EDEAE4;
      --loki-text-primary: #1A1614;
      --loki-text-secondary: #4A4640;
      --loki-text-muted: #8A857C;
      --loki-accent: #553DE9;
      --loki-accent-hover: #4432c4;
      --loki-accent-glow: rgba(85, 61, 233, 0.15);
      --loki-border: rgba(0, 0, 0, 0.08);
      --loki-border-light: rgba(0, 0, 0, 0.05);
      --loki-success: #1AAF95;
      --loki-warning: #C4922E;
      --loki-error: #C04848;
      --loki-info: #2F71E3;
      --loki-glass-bg: rgba(255, 255, 255, 0.55);
      --loki-glass-border: rgba(255, 255, 255, 0.35);
      --loki-glass-shadow: 0 4px 24px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
    }

    [data-loki-theme="dark"] {
      --loki-bg-primary: #0F0B1A;
      --loki-bg-secondary: #150F24;
      --loki-bg-tertiary: #1E1533;
      --loki-bg-card: rgba(30, 21, 51, 0.72);
      --loki-bg-hover: #251C3D;
      --loki-text-primary: #F0ECF8;
      --loki-text-secondary: #B8B0C8;
      --loki-text-muted: #7B6FA0;
      --loki-accent: #7B6BF0;
      --loki-accent-hover: #9488F5;
      --loki-accent-glow: rgba(123, 107, 240, 0.2);
      --loki-border: rgba(255, 255, 255, 0.08);
      --loki-border-light: rgba(255, 255, 255, 0.04);
      --loki-success: #2ED8B6;
      --loki-warning: #E8B84A;
      --loki-error: #E07070;
      --loki-info: #5A9CF5;
      --loki-glass-bg: rgba(20, 14, 38, 0.65);
      --loki-glass-border: rgba(255, 255, 255, 0.08);
      --loki-glass-shadow: 0 4px 24px rgba(0, 0, 0, 0.25), 0 1px 2px rgba(0, 0, 0, 0.12);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    ::selection {
      background: rgba(85, 61, 233, 0.18);
      color: var(--loki-text-primary);
    }

    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: var(--loki-bg-primary);
      color: var(--loki-text-primary);
      min-height: 100vh;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      transition: background var(--loki-transition), color var(--loki-transition);
      font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
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

    /* Sidebar - glass effect */
    .sidebar {
      display: flex;
      flex-direction: column;
      background: var(--loki-glass-bg);
      backdrop-filter: blur(16px) saturate(1.4);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
      border-right: 1px solid var(--loki-glass-border);
      overflow-y: auto;
    }

    .sidebar-logo {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 20px 16px 16px;
    }

    .logo-brand {
      font-family: 'DM Serif Display', Georgia, serif;
      font-size: 22px;
      font-weight: 400;
      color: var(--loki-text-primary);
      letter-spacing: -0.02em;
      line-height: 1.1;
    }

    .logo-subtitle {
      font-family: 'Inter', system-ui, sans-serif;
      font-size: 9px;
      color: var(--loki-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 500;
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
      padding: 9px 12px;
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
      background: var(--loki-accent-glow);
      border-color: rgba(85, 61, 233, 0.12);
      box-shadow: 0 0 0 1px var(--loki-accent-glow);
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
      background: var(--loki-bg-primary);
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
      box-shadow: 0 0 0 3px var(--loki-accent-glow);
    }

    /* v7.7.29 multi-project switcher */
    .project-switcher {
      margin-left: 14px;
      padding: 5px 10px;
      background: var(--loki-bg-primary);
      border: 1px solid var(--loki-border);
      border-radius: 6px;
      font-size: 12px;
      font-family: 'Inter', system-ui, sans-serif;
      color: var(--loki-text-primary);
      cursor: pointer;
      max-width: 280px;
    }
    .project-switcher:focus {
      outline: none;
      border-color: var(--loki-accent);
      box-shadow: 0 0 0 3px var(--loki-accent-glow);
    }
    /* v7.7.30 per-project stop list */
    .project-stop-list {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-left: 10px;
    }
    .project-stop-row {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px 3px 10px;
      background: var(--loki-bg-primary);
      border: 1px solid var(--loki-border);
      border-radius: 14px;
      font-size: 11px;
      font-family: 'Inter', system-ui, sans-serif;
      color: var(--loki-text-primary);
    }
    .project-stop-row .project-stop-name {
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .project-stop-row button {
      padding: 2px 8px;
      background: transparent;
      border: 1px solid var(--loki-border);
      border-radius: 10px;
      font-size: 11px;
      font-family: 'Inter', system-ui, sans-serif;
      color: var(--loki-text-secondary);
      cursor: pointer;
    }
    .project-stop-row button:hover:not(:disabled) {
      border-color: #d64545;
      color: #d64545;
    }
    .project-stop-row button:disabled {
      opacity: 0.6;
      cursor: default;
    }

    /* Main Content */
    .main-content {
      padding: 28px 32px;
      overflow-y: auto;
      height: 100vh;
    }

    /* Section pages - show/hide navigation */
    .section-page {
      display: none;
      padding-bottom: 32px;
      animation: fadeIn 0.2s ease-out;
    }

    .section-page.active {
      display: block;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .section-page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-top: 4px;
    }

    .section-page-title {
      font-family: 'DM Serif Display', Georgia, serif;
      font-size: 1.8rem;
      font-weight: 400;
      color: var(--loki-text-primary);
      letter-spacing: -0.02em;
    }

    /* Overview handled by <loki-overview> shadow DOM */

    /* Offline Banner */
    .offline-banner {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: var(--loki-warning);
      color: #201515;
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

    .budget-banner {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      padding: 8px 16px;
      text-align: center;
      font-size: 13px;
      font-weight: 600;
      display: none;
      z-index: 1000;
      color: #201515;
    }

    .budget-banner.show {
      display: block;
    }

    .budget-banner.warn {
      background: var(--loki-warning);
    }

    .budget-banner.exceeded {
      background: var(--loki-red);
      color: #fff;
    }

    .budget-banner a {
      color: inherit;
      text-decoration: underline;
      margin-left: 10px;
      font-weight: 600;
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
      background: var(--loki-glass-bg);
      backdrop-filter: blur(20px) saturate(1.4);
      -webkit-backdrop-filter: blur(20px) saturate(1.4);
      border: 1px solid var(--loki-glass-border);
      border-radius: 12px;
      padding: 24px;
      max-width: 480px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: var(--loki-glass-shadow);
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
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
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
      border-radius: 6px;
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

    /* USAGE.md markdown render styles */
    .usage-md { max-height: 480px; overflow: auto; padding: 12px; background: var(--loki-bg-secondary, #111); border-radius: 4px; color: var(--loki-text-primary, #eee); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; line-height: 1.6; }
    .usage-md h1 { font-size: 1.35rem; font-weight: 600; margin: 0.75em 0 0.4em; border-bottom: 1px solid var(--loki-border, #333); padding-bottom: 4px; }
    .usage-md h2 { font-size: 1.15rem; font-weight: 600; margin: 0.75em 0 0.4em; }
    .usage-md h3 { font-size: 1rem; font-weight: 600; margin: 0.65em 0 0.3em; }
    .usage-md p { margin: 0.4em 0; }
    .usage-md ul, .usage-md ol { margin: 0.4em 0 0.4em 1.5em; padding: 0; }
    .usage-md li { margin: 0.15em 0; }
    .usage-md pre { background: var(--loki-bg-tertiary, #0a0a0a); border: 1px solid var(--loki-border, #333); border-radius: 4px; padding: 10px 12px; overflow-x: auto; margin: 0.5em 0; }
    .usage-md pre code { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 11.5px; background: none; padding: 0; white-space: pre; }
    .usage-md code { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 11.5px; background: var(--loki-bg-tertiary, #0a0a0a); padding: 1px 4px; border-radius: 3px; }
    .usage-md blockquote { border-left: 3px solid var(--loki-accent, #553de9); margin: 0.5em 0; padding: 4px 12px; color: var(--loki-text-secondary, #888); }
    .usage-md hr { border: none; border-top: 1px solid var(--loki-border, #333); margin: 0.75em 0; }
    .usage-md strong { font-weight: 600; }
    .usage-md em { font-style: italic; }
    .usage-md a { color: var(--loki-accent, #553de9); text-decoration: none; }
    .usage-md a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <!-- Offline Banner -->
  <div class="offline-banner" id="offline-banner">
    Offline - showing cached data
  </div>

  <!-- Budget Banner (R3 anti-surprise-cost): persistent, visible on every
       page without opening the Cost panel. Amber at >=80% (warn), red at
       >=100% (exceeded). Driven by the existing WebSocket budget_status push
       and a polling fallback against /api/cost/timeline. -->
  <div class="budget-banner" id="budget-banner" role="status" aria-live="polite">
    <span id="budget-banner-text"></span>
    <a href="/cost" id="budget-banner-link">View cost</a>
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
        <span class="logo-brand">Loki Mode</span>
        <span class="logo-subtitle">powered by Autonomi</span>
        <!-- v7.7.29 multi-project switcher: lists projects running loki in
             different folders and switches which one the dashboard shows. -->
        <select class="project-switcher" id="project-switcher" title="Switch project" aria-label="Switch project">
          <option value="">All projects (current dir)</option>
        </select>
        <!-- v7.7.30 per-project stop: a compact list of running projects, each
             with a Stop button that gracefully halts that project's runner
             without affecting any other folder. Built at runtime; empty when
             no project is running. -->
        <div class="project-stop-list" id="project-stop-list" aria-label="Running projects"></div>
      </div>

      <nav class="nav-links">
        <button class="nav-link active" data-section="overview" id="nav-overview">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Overview
        </button>
        <button class="nav-link" data-section="insights" id="nav-insights">
          <svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Insights
        </button>
        <button class="nav-link" data-section="prd-checklist" id="nav-prd-checklist">
          <svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
          Spec Checklist
        </button>
        <button class="nav-link" data-section="app-runner" id="nav-app-runner">
          <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          App Runner
        </button>
        <button class="nav-link" data-section="council" id="nav-council">
          <svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
          Council
        </button>
        <button class="nav-link" data-section="quality" id="nav-quality">
          <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          Quality
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
        <button class="nav-link" data-section="migration" id="nav-migration">
          <svg viewBox="0 0 24 24"><path d="M4 14h6v6H4z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M14 4h6v6h-6z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M17 10v4h-4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 14v-4h4" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          Migration
        </button>
        <button class="nav-link" data-section="analytics" id="nav-analytics">
          <svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="20" x2="12" y2="4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="6" y1="20" x2="6" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          Analytics
        </button>
        <button class="nav-link" data-section="escalations" id="nav-escalations">
          <svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Escalations
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
      <!-- Overview + Tasks (combined) -->
      <div class="section-page active" id="page-overview">
        <loki-overview id="overview"></loki-overview>
        <loki-rarv-timeline id="rarv-timeline"></loki-rarv-timeline>
        <loki-session-diff id="session-diff"></loki-session-diff>
        <div style="margin-top: 28px;">
          <div class="section-page-header">
            <h2 class="section-page-title">Tasks</h2>
          </div>
          <loki-task-board id="task-board"></loki-task-board>
        </div>
      </div>

      <!-- Insights: Logs + Memory + Learning (combined) -->
      <div class="section-page" id="page-insights">
        <div class="section-page-header">
          <h2 class="section-page-title">Insights</h2>
        </div>
        <div style="display: grid; gap: 24px;">
          <div>
            <h3 style="font-family: 'DM Serif Display', Georgia, serif; font-size: 1.15rem; font-weight: 400; color: var(--loki-text-primary); margin-bottom: 12px;">Logs</h3>
            <loki-log-stream id="log-stream" auto-scroll max-lines="500"></loki-log-stream>
          </div>
          <div>
            <h3 style="font-family: 'DM Serif Display', Georgia, serif; font-size: 1.15rem; font-weight: 400; color: var(--loki-text-primary); margin-bottom: 12px;">Memory</h3>
            <loki-memory-browser id="memory-browser" tab="summary"></loki-memory-browser>
            <!-- v7.7.21 token economics tile: hit rate + tokens + top patterns -->
            <div id="memory-economics-tile" style="margin-top: 12px; background: var(--loki-bg-card, #1a1a1a); border: 1px solid var(--loki-border, #333); border-radius: 5px; padding: 12px;">
              <div style="font-size: 11px; color: var(--loki-text-muted, #888); margin-bottom: 8px;">Token Economics</div>
              <div id="memory-economics-metrics" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; font-size: 13px;">
                <div><span style="color: var(--loki-text-muted, #888);">Hit rate</span><br><strong id="econ-hit-rate">--</strong></div>
                <div><span style="color: var(--loki-text-muted, #888);">Total tokens</span><br><strong id="econ-total-tokens">--</strong></div>
                <div><span style="color: var(--loki-text-muted, #888);">Savings</span><br><strong id="econ-savings">--</strong></div>
              </div>
              <div id="memory-economics-top" style="margin-top: 10px; font-size: 12px; color: var(--loki-text-muted, #888);"></div>
            </div>
            <script>
              (function(){
                function loadEconomics(){
                  fetch('/api/memory/economics').then(function(r){ return r.json(); }).then(function(j){
                    var hr = document.getElementById('econ-hit-rate');
                    var tt = document.getElementById('econ-total-tokens');
                    var sv = document.getElementById('econ-savings');
                    var top = document.getElementById('memory-economics-top');
                    if (hr) hr.textContent = ((j.hit_rate || 0) * 100).toFixed(1) + '%';
                    if (tt) tt.textContent = (j.total_tokens || 0).toLocaleString();
                    if (sv) sv.textContent = (j.savings_percent || 0).toFixed(1) + '%';
                    if (top) {
                      var patterns = j.top_patterns || [];
                      // v7.7.21 council fix (Opus 1): build DOM with
                      // textContent (NOT innerHTML single-char escape) so
                      // agent/PRD-derived summaries cannot inject markup.
                      while (top.firstChild) top.removeChild(top.firstChild);
                      if (patterns.length === 0) {
                        top.textContent = 'No retrieval patterns yet. Run sessions to accumulate.';
                      } else {
                        var header = document.createElement('div');
                        header.style.marginBottom = '4px';
                        header.textContent = 'Top retrieved:';
                        top.appendChild(header);
                        patterns.slice(0, 5).forEach(function(p){
                          var row = document.createElement('div');
                          // textContent escapes everything; no markup injection.
                          row.textContent = (p.access_count || 0) + 'x · ' +
                            (p.summary || p.id || '');
                          top.appendChild(row);
                        });
                      }
                    }
                  }).catch(function(){ /* endpoint not available; tile stays at -- */ });
                }
                loadEconomics();
                setInterval(loadEconomics, 30000);
              })();
            </script>
          </div>
          <div>
            <h3 style="font-family: 'DM Serif Display', Georgia, serif; font-size: 1.15rem; font-weight: 400; color: var(--loki-text-primary); margin-bottom: 12px;">Memory Files</h3>
            <div id="memory-files-panel" style="background: var(--loki-bg-card, #1a1a1a); border: 1px solid var(--loki-border, #333); border-radius: 5px; padding: 12px;">
              <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px;" id="memory-files-tabs"></div>
              <div style="display: grid; grid-template-columns: minmax(220px, 320px) 1fr; gap: 12px; min-height: 280px;">
                <div id="memory-files-list" style="border: 1px solid var(--loki-border, #333); border-radius: 4px; padding: 8px; max-height: 480px; overflow-y: auto; font-size: 12px;">Loading...</div>
                <div id="memory-files-viewer" style="border: 1px solid var(--loki-border, #333); border-radius: 4px; padding: 12px; max-height: 480px; overflow: auto; font-family: 'JetBrains Mono', monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--loki-text-primary, #eee);">Select a file to view its contents.</div>
              </div>
            </div>
            <script>
              (function(){
                var TYPES = [
                  {id: 'root', label: 'Notes'},
                  {id: 'episodic', label: 'Episodes'},
                  {id: 'learnings', label: 'Learnings'},
                  {id: 'ledgers', label: 'Ledgers'},
                  {id: 'handoffs', label: 'Handoffs'},
                  {id: 'semantic', label: 'Semantic'},
                  {id: 'skills', label: 'Skills'}
                ];
                var state = {type: 'root', files: [], selected: null};
                var tabsEl = document.getElementById('memory-files-tabs');
                var listEl = document.getElementById('memory-files-list');
                var viewEl = document.getElementById('memory-files-viewer');
                function esc(s){ var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
                function fmtSize(n){ if (n < 1024) return n + ' B'; if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB'; return (n/1024/1024).toFixed(2) + ' MB'; }
                function fmtTime(ts){ try { return new Date(ts*1000).toLocaleString(); } catch(e){ return ''; } }
                function renderTabs(){
                  tabsEl.innerHTML = TYPES.map(function(t){
                    var active = t.id === state.type;
                    return '<button data-type="' + t.id + '" style="padding: 5px 10px; font-size: 11px; border-radius: 4px; border: 1px solid ' + (active ? 'var(--loki-accent, #553de9)' : 'var(--loki-border, #333)') + '; background: ' + (active ? 'var(--loki-accent, #553de9)' : 'transparent') + '; color: ' + (active ? '#fff' : 'var(--loki-text-primary, #ccc)') + '; cursor: pointer;">' + esc(t.label) + '</button>';
                  }).join('');
                  Array.prototype.forEach.call(tabsEl.querySelectorAll('button'), function(b){
                    b.addEventListener('click', function(){ loadType(b.getAttribute('data-type')); });
                  });
                }
                function renderList(){
                  if (!state.files.length){ listEl.innerHTML = '<div style="color: var(--loki-text-muted, #888); padding: 8px;">No files in this section.</div>'; return; }
                  listEl.innerHTML = state.files.map(function(f){
                    var active = state.selected && state.selected.path === f.path;
                    return '<div data-path="' + esc(f.path) + '" style="padding: 6px 8px; border-radius: 3px; cursor: pointer; margin-bottom: 2px; background: ' + (active ? 'var(--loki-accent, #553de9)' : 'transparent') + '; color: ' + (active ? '#fff' : 'inherit') + ';" title="' + esc(f.path) + '"><div style="font-weight: 500;">' + esc(f.name) + '</div><div style="font-size: 10px; color: ' + (active ? 'rgba(255,255,255,0.8)' : 'var(--loki-text-muted, #888)') + ';">' + fmtSize(f.size) + ' -- ' + esc(fmtTime(f.modified)) + '</div></div>';
                  }).join('');
                  Array.prototype.forEach.call(listEl.querySelectorAll('div[data-path]'), function(d){
                    d.addEventListener('click', function(){ loadFile(d.getAttribute('data-path')); });
                  });
                }
                function renderViewer(file){
                  if (!file){ viewEl.textContent = 'Select a file to view its contents.'; return; }
                  var header = file.name + '  (' + fmtSize(file.size) + (file.truncated ? ', truncated' : '') + ')\n' + file.path + '\n\n';
                  var body = file.content || '';
                  if (file.kind === 'json'){
                    try { body = JSON.stringify(JSON.parse(body), null, 2); } catch(e){ /* leave raw */ }
                  }
                  viewEl.textContent = header + body;
                }
                function loadType(t){
                  state.type = t; state.selected = null;
                  renderTabs(); renderViewer(null);
                  listEl.innerHTML = 'Loading...';
                  fetch('/api/memory/files?type=' + encodeURIComponent(t) + '&limit=500')
                    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                    .then(function(j){ state.files = (j && j.files) || []; renderList(); })
                    .catch(function(e){ listEl.innerHTML = '<div style="color: var(--loki-red, #e74c3c); padding: 8px;">Failed: ' + esc(e.message) + '</div>'; });
                }
                function loadFile(p){
                  state.selected = state.files.filter(function(f){ return f.path === p; })[0] || {path: p};
                  renderList();
                  viewEl.textContent = 'Loading ' + p + '...';
                  fetch('/api/memory/file?path=' + encodeURIComponent(p))
                    .then(function(r){ if (!r.ok) return r.json().then(function(j){ throw new Error(j.detail || ('HTTP ' + r.status)); }); return r.json(); })
                    .then(function(j){ renderViewer(j); })
                    .catch(function(e){ viewEl.textContent = 'Failed: ' + e.message; });
                }
                // Initialize when Insights becomes visible (or immediately if already visible)
                function init(){ renderTabs(); loadType('root'); }
                if (document.getElementById('page-insights')){ init(); }
                else { document.addEventListener('DOMContentLoaded', init); }
              })();
            </script>
          </div>
          <div>
            <h3 style="font-family: 'DM Serif Display', Georgia, serif; font-size: 1.15rem; font-weight: 400; color: var(--loki-text-primary); margin-bottom: 12px;">Learning Metrics</h3>
            <loki-learning-dashboard id="learning-dashboard" time-range="7d"></loki-learning-dashboard>
          </div>
          <!-- v7.7.1 F-1 follow-up: How to Run (USAGE.md) -->
          <div>
            <h3 style="font-family: 'DM Serif Display', Georgia, serif; font-size: 1.15rem; font-weight: 400; color: var(--loki-text-primary); margin-bottom: 12px;">How to Run (USAGE.md)</h3>
            <div id="usage-doc-panel" style="background: var(--loki-bg-card, #1a1a1a); border: 1px solid var(--loki-border, #333); border-radius: 5px; padding: 12px;">
              <div id="usage-doc-meta" style="font-size: 11px; color: var(--loki-text-muted, #888); margin-bottom: 8px;">Loading...</div>
              <div id="usage-doc-content" class="usage-md"></div>
            </div>
            <script>
              (function(){
                // Minimal markdown-to-HTML converter for USAGE.md content.
                // Handles: fenced code blocks, headings, horizontal rules,
                // blockquotes, unordered/ordered lists, inline bold/italic/code,
                // and paragraphs. Script tags are stripped from non-code text.
                function renderUsageMarkdown(md) {
                  if (!md) return '';
                  var lines = md.split('\n');
                  var html = '';
                  var i = 0;
                  var inList = null; // 'ul' or 'ol'

                  function escapeHtml(s) {
                    return s.replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(/"/g, '&quot;');
                  }

                  function closeList() {
                    if (inList) { html += '</' + inList + '>'; inList = null; }
                  }

                  function inlineFormat(s) {
                    // Escape HTML first (outside code spans)
                    // Process inline code spans before escaping the rest
                    var BT = '\x60'; // backtick -- avoid literal backtick inside template literal
                    var result = '';
                    var codeSpanRe = new RegExp('(' + BT + '[^' + BT + ']+' + BT + ')');
                    var chunks = s.split(codeSpanRe);
                    for (var ci = 0; ci < chunks.length; ci++) {
                      var ch = chunks[ci];
                      if (ch.charAt(0) === BT && ch.charAt(ch.length - 1) === BT && ch.length > 2) {
                        result += '<code>' + escapeHtml(ch.slice(1, -1)) + '</code>';
                      } else {
                        var esc = escapeHtml(ch);
                        // strip any residual <script tags that survived escaping (defensive)
                        esc = esc.replace(/&lt;script/gi, '&lt;sc​ript');
                        esc = esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                        esc = esc.replace(/__([^_]+)__/g, '<strong>$1</strong>');
                        esc = esc.replace(/\*([^*]+)\*/g, '<em>$1</em>');
                        esc = esc.replace(/_([^_]+)_/g, '<em>$1</em>');
                        // v7.7.11 XSS guard (Opus 1 council): only allow http/https/mailto/anchor/relative href.
                        // javascript: / data: / vbscript: are stripped to a plain code span so the URL stays visible
                        // but is not clickable. USAGE.md absorbs agent output + PRD text; treat as untrusted.
                        esc = esc.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_m, label, url){
                          var safe = /^(https?:\/\/|mailto:|#|\/(?!\/))/.test(url);
                          if (safe) return '<a href="' + url + '" rel="noopener noreferrer">' + label + '</a>';
                          return '<code>' + label + ' (' + url + ')</code>';
                        });
                        result += esc;
                      }
                    }
                    return result;
                  }

                  while (i < lines.length) {
                    var line = lines[i];

                    // Fenced code block (BT3 = three backticks)
                    var BT3 = '\x60\x60\x60';
                    if (line.slice(0, 3) === BT3) {
                      closeList();
                      var lang = line.slice(3).trim();
                      var codeLines = [];
                      i++;
                      while (i < lines.length && lines[i].slice(0, 3) !== BT3) {
                        codeLines.push(lines[i]);
                        i++;
                      }
                      var codeContent = escapeHtml(codeLines.join('\n'));
                      html += '<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' + codeContent + '</code></pre>';
                      i++;
                      continue;
                    }

                    // Headings
                    var hMatch = line.match(/^(#{1,6})\s+(.*)/);
                    if (hMatch) {
                      closeList();
                      var level = hMatch[1].length;
                      html += '<h' + level + '>' + inlineFormat(hMatch[2]) + '</h' + level + '>';
                      i++;
                      continue;
                    }

                    // Horizontal rule
                    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
                      closeList();
                      html += '<hr>';
                      i++;
                      continue;
                    }

                    // Blockquote
                    if (/^>/.test(line)) {
                      closeList();
                      html += '<blockquote>' + inlineFormat(line.replace(/^>\s?/, '')) + '</blockquote>';
                      i++;
                      continue;
                    }

                    // Unordered list
                    var ulMatch = line.match(/^(\s*[-*+])\s+(.*)/);
                    if (ulMatch) {
                      if (inList !== 'ul') { closeList(); html += '<ul>'; inList = 'ul'; }
                      html += '<li>' + inlineFormat(ulMatch[2]) + '</li>';
                      i++;
                      continue;
                    }

                    // Ordered list
                    var olMatch = line.match(/^\s*\d+\.\s+(.*)/);
                    if (olMatch) {
                      if (inList !== 'ol') { closeList(); html += '<ol>'; inList = 'ol'; }
                      html += '<li>' + inlineFormat(olMatch[1]) + '</li>';
                      i++;
                      continue;
                    }

                    // Blank line
                    if (line.trim() === '') {
                      closeList();
                      i++;
                      continue;
                    }

                    // Paragraph
                    closeList();
                    html += '<p>' + inlineFormat(line) + '</p>';
                    i++;
                  }

                  closeList();
                  return html;
                }

                function loadUsage(){
                  fetch('/api/usage').then(function(r){ return r.json(); }).then(function(j){
                    var meta = document.getElementById('usage-doc-meta');
                    var body = document.getElementById('usage-doc-content');
                    if (!meta || !body) return;
                    if (!j || !j.exists){
                      meta.textContent = 'USAGE.md not generated yet. Loki writes it at the end of each session.';
                      body.innerHTML = '';
                      return;
                    }
                    var size = j.size > 1024 ? (j.size/1024).toFixed(1) + ' KB' : j.size + ' B';
                    var when = j.mtime ? new Date(j.mtime*1000).toLocaleString() : '';
                    meta.textContent = j.path + '  (' + size + (j.truncated ? ', truncated' : '') + ', ' + when + ')';
                    body.innerHTML = renderUsageMarkdown(j.content || '');
                  }).catch(function(e){
                    var meta = document.getElementById('usage-doc-meta');
                    if (meta) meta.textContent = 'Failed to load USAGE.md: ' + (e && e.message ? e.message : 'unknown');
                  });
                }
                loadUsage();
                // Re-poll on interval so a fresh USAGE.md appears after a session.
                setInterval(loadUsage, 15000);
              })();
            </script>
          </div>
        </div>
      </div>

      <!-- Spec Checklist -->
      <div class="section-page" id="page-prd-checklist">
        <div class="section-page-header">
          <h2 class="section-page-title">Spec Checklist</h2>
        </div>
        <loki-checklist-viewer id="checklist-viewer"></loki-checklist-viewer>
      </div>

      <!-- App Runner -->
      <div class="section-page" id="page-app-runner">
        <div class="section-page-header">
          <h2 class="section-page-title">App Runner</h2>
        </div>
        <loki-app-status id="app-status"></loki-app-status>
      </div>

      <!-- Completion Council -->
      <div class="section-page" id="page-council">
        <div class="section-page-header">
          <h2 class="section-page-title">Completion Council</h2>
        </div>
        <loki-council-dashboard id="council-dashboard"></loki-council-dashboard>
        <loki-council-transcripts id="council-transcripts"></loki-council-transcripts>
      </div>

      <!-- Quality -->
      <div class="section-page" id="page-quality">
        <div class="section-page-header">
          <h2 class="section-page-title">Quality</h2>
        </div>
        <div style="display: grid; gap: 24px;">
          <loki-quality-score id="quality-score"></loki-quality-score>
          <loki-quality-gates id="quality-gates"></loki-quality-gates>
          <loki-prompt-optimizer id="prompt-optimizer"></loki-prompt-optimizer>
        </div>
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

      <!-- Migration -->
      <div class="section-page" id="page-migration">
        <div class="section-page-header">
          <h2 class="section-page-title">Migration</h2>
        </div>
        <loki-migration-dashboard id="migration-dashboard"></loki-migration-dashboard>
      </div>

      <!-- Analytics -->
      <div class="section-page" id="page-analytics">
        <div class="section-page-header">
          <h2 class="section-page-title">Analytics</h2>
        </div>
        <loki-analytics id="analytics-dashboard"></loki-analytics>
      </div>

      <!-- Escalations (handoff documents under .loki/escalations/) -->
      <div class="section-page" id="page-escalations">
        <div class="section-page-header">
          <h2 class="section-page-title">Escalations</h2>
        </div>
        <loki-escalations id="escalations-panel"></loki-escalations>
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
        <div class="shortcut-row"><span class="shortcut-desc">Insights</span><span class="shortcut-keys"><kbd class="shortcut-key">2</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Spec Checklist</span><span class="shortcut-keys"><kbd class="shortcut-key">3</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">App Runner</span><span class="shortcut-keys"><kbd class="shortcut-key">4</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Council</span><span class="shortcut-keys"><kbd class="shortcut-key">5</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Quality</span><span class="shortcut-keys"><kbd class="shortcut-key">6</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Cost</span><span class="shortcut-keys"><kbd class="shortcut-key">7</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Checkpoints</span><span class="shortcut-keys"><kbd class="shortcut-key">8</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Context</span><span class="shortcut-keys"><kbd class="shortcut-key">9</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Notifications</span><span class="shortcut-keys"><kbd class="shortcut-key">0</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Migration</span><span class="shortcut-keys"><kbd class="shortcut-key">m</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Analytics</span><span class="shortcut-keys"><kbd class="shortcut-key">a</kbd></span></div>
        <div class="shortcut-row"><span class="shortcut-desc">Escalations</span><span class="shortcut-keys"><kbd class="shortcut-key">e</kbd></span></div>
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

  // v7.7.29 multi-project switcher: populate from /api/running-projects and
  // switch the focused project via /api/focus. Fully best-effort; if the
  // endpoint is unavailable the dropdown simply stays at "All projects".
  (function initProjectSwitcher() {
    var sel = document.getElementById('project-switcher');
    if (!sel) return;
    var stopList = document.getElementById('project-stop-list');
    // v7.7.30: build a per-row Stop control for each running project using
    // createElement + textContent only (never innerHTML for project-supplied
    // strings), so a project name can never inject markup.
    function buildStopList(projects) {
      if (!stopList) return;
      while (stopList.firstChild) stopList.removeChild(stopList.firstChild);
      projects.forEach(function(p){
        if (p.running !== true) return;
        var row = document.createElement('div');
        row.className = 'project-stop-row';
        var name = document.createElement('span');
        name.className = 'project-stop-name';
        name.textContent = p.name || p.path || 'project';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Stop';
        if (p.id) btn.setAttribute('data-id', p.id);
        btn.addEventListener('click', function(){
          if (!p.id) return;
          btn.disabled = true;
          btn.textContent = 'Stopping...';
          fetch('/api/running-projects/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: p.id })
          })
            .then(function(){ refresh(); })
            .catch(function(){ btn.disabled = false; btn.textContent = 'Stop'; });
        });
        row.appendChild(name);
        row.appendChild(btn);
        stopList.appendChild(row);
      });
    }
    function refresh() {
      fetch('/api/running-projects')
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(data){
          if (!data || !Array.isArray(data.projects)) return;
          var current = sel.value;
          // Rebuild options: keep the "All projects" default first.
          sel.innerHTML = '';
          var optAll = document.createElement('option');
          optAll.value = ''; optAll.textContent = 'All projects (current dir)';
          sel.appendChild(optAll);
          data.projects.forEach(function(p){
            var o = document.createElement('option');
            o.value = p.path || '';
            var dot = p.running ? '* ' : '';   // running marker (ASCII)
            o.textContent = dot + (p.name || p.path || 'project');
            if (p.is_active) o.selected = true;
            sel.appendChild(o);
          });
          if (!data.active_project_dir && current === '') sel.value = '';
          buildStopList(data.projects);
        })
        .catch(function(){ /* offline / no endpoint: leave as-is */ });
    }
    sel.addEventListener('change', function(){
      var dir = sel.value;
      var req = dir
        ? fetch('/api/focus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_dir: dir }) })
        : fetch('/api/focus', { method: 'DELETE' });
      req.then(function(){
        // Reload so every panel re-fetches against the newly focused project.
        window.location.reload();
      }).catch(function(){ /* ignore */ });
    });
    refresh();
    setInterval(refresh, 15000);
  })();

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
      'checklist-viewer',
      'app-status',
      'council-dashboard',
      'cost-dashboard',
      'checkpoint-viewer',
      'context-tracker',
      'notification-center',
      'session-diff',
      'prompt-optimizer',
      'quality-score',
      'quality-gates',
      'rarv-timeline',
      'migration-dashboard',
      'analytics-dashboard',
      'escalations-panel',
      'council-transcripts'
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

  // R3 budget banner: a persistent, page-wide indicator so a user running an
  // overnight job sees the 80% budget warning WITHOUT opening the Cost panel.
  // It reuses the existing WebSocket push (budget_status -> api:budget_status
  // on the shared API client) and falls back to polling /api/cost/timeline.
  (function initBudgetBanner() {
    var banner = document.getElementById('budget-banner');
    var textEl = document.getElementById('budget-banner-text');
    if (!banner || !textEl) return;

    function renderBudget(b) {
      if (!b || (b.status !== 'warn' && b.status !== 'exceeded')) {
        banner.classList.remove('show', 'warn', 'exceeded');
        return;
      }
      // Honest copy: "Budget at 82% - hard stop at 100%."
      var pct = (b.percent_used === null || b.percent_used === undefined)
        ? null : Number(b.percent_used);
      var pctTxt = (pct === null || !isFinite(pct)) ? '' : Math.round(pct) + '%';
      var msg;
      if (b.status === 'exceeded') {
        msg = 'Budget cap reached' + (pctTxt ? ' (' + pctTxt + ')' : '') +
              '. The run is paused to prevent a surprise bill.';
      } else {
        msg = 'Budget at ' + (pctTxt || 'over 80%') + ' - hard stop at 100%.';
      }
      textEl.textContent = msg;
      banner.classList.remove('warn', 'exceeded');
      banner.classList.add('show', b.status);
    }

    // Polling fallback (the WS push is best-effort; polling guarantees the
    // banner is correct even on a freshly opened page or after a reconnect).
    function poll() {
      fetch('/api/cost/timeline', { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && d.budget) renderBudget(d.budget); })
        .catch(function () { /* offline / no endpoint: leave banner as-is */ });
    }
    poll();
    setInterval(poll, 15000);

    // Reuse the existing shared WebSocket client for the proactive push.
    try {
      var api = LokiDashboard.getApiClient({ baseUrl: window.location.origin });
      api.addEventListener('api:budget_status', function (e) {
        renderBudget(e && e.detail);
      });
      api.connect().catch(function () { /* polling fallback still covers it */ });
    } catch (err) { /* polling fallback still covers it */ }
  })();

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
    // Hide all section pages, show only the active one
    var allPages = document.querySelectorAll('.section-page');
    allPages.forEach(function(page) { page.classList.remove('active'); });
    var pageEl = document.getElementById('page-' + sectionId);
    if (pageEl) {
      pageEl.classList.add('active');
    }
    // Update nav active state
    navLinks.forEach(function(link) { link.classList.remove('active'); });
    var navEl = document.querySelector('.nav-link[data-section="' + sectionId + '"]');
    if (navEl) navEl.classList.add('active');
    // Scroll main content to top on section switch
    mainContent.scrollTop = 0;
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

  // Show the default section (overview) on load
  switchSection('overview');

  // Keyboard shortcuts: Cmd/Ctrl + 1-7
  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && ((e.key >= '1' && e.key <= '9') || e.key === '0')) {
      e.preventDefault();
      var sections = ['overview', 'insights', 'prd-checklist', 'app-runner', 'council', 'quality', 'cost', 'checkpoint', 'context', 'notifications', 'migration', 'analytics', 'escalations'];
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

    var sections = ['overview', 'insights', 'prd-checklist', 'app-runner', 'council', 'quality', 'cost', 'checkpoint', 'context', 'notifications', 'migration', 'analytics', 'escalations'];

    switch (e.key) {
      // Section navigation: 1-9, 0
      case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
        e.preventDefault();
        switchSection(sections[parseInt(e.key) - 1]);
        break;
      case '0':
        e.preventDefault();
        switchSection(sections[9]);
        break;

      // Migration page
      case 'm':
        e.preventDefault();
        switchSection('migration');
        break;

      // Analytics page
      case 'a':
        e.preventDefault();
        switchSection('analytics');
        break;

      // Escalations page
      case 'e':
        e.preventDefault();
        switchSection('escalations');
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

  // Restore last section from localStorage (overrides default overview)
  var savedSection = localStorage.getItem('loki-active-section');
  if (savedSection) {
    switchSection(savedSection);
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
