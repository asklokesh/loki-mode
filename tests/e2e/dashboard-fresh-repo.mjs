#!/usr/bin/env node
/*
 * dashboard-fresh-repo.mjs -- integrated, COLD-repo dashboard UX harness.
 *
 * Why this exists (v7.18.0): the v7.17.x verification ran the dashboard against
 * a SEEDED temp project, in ISOLATION (component screenshots), so it never hit
 * the real first-time-user experience and shipped three classes of bug:
 *   - cold-repo 404 flood + AbortError spam (no .loki data exists yet),
 *   - long LLM-backed calls aborting at the client's 10s default,
 *   - iframe pages (trust/cost/proofs) whose theme clashed with the cream SPA.
 * As of v7.90.1 the product is light-only: the manual Dark toggle was removed
 * and the trust iframe is pinned to ?theme=light (dashboard/static/index.html
 * line ~15911), so both the SPA and the iframe stay on the same cream
 * background. This harness reproduces the ACTUAL user path: a fresh repo with
 * NO .loki, the full SPA in a real browser, panels visited adjacent, the trust
 * iframe checked for theme consistency (light-only). It asserts the absence of
 * the symptoms (console 404/AbortError on cold load; theme mismatch) and the
 * light-only invariant, which is what static greps + seeded tests could not
 * catch.
 *
 * Usage:  node tests/e2e/dashboard-fresh-repo.mjs
 * Requires: a dashboard server already running on $LOKI_DASH_URL (default
 *   http://127.0.0.1:57374) whose active project is a FRESH repo with no .loki.
 *   The caller is responsible for starting/stopping that server; this script
 *   only drives the browser so it stays composable with local-ci and CI.
 * Exit: 0 = all assertions pass; 1 = at least one failed; 2 = setup error.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
// Resolve playwright from dashboard-ui/node_modules regardless of CWD, so the
// harness runs the same from local-ci, CI, or a manual invocation. dashboard-ui
// is the package that owns the playwright devDependency.
const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pwPath = process.env.LOKI_PLAYWRIGHT_PATH ||
  resolve(__dir, '..', '..', 'dashboard-ui', 'node_modules', 'playwright');
const { chromium } = require(pwPath);

const BASE = process.env.LOKI_DASH_URL || 'http://127.0.0.1:57374';
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' -- ' + detail : ''}`);
}

// A console message we treat as a cold-repo regression. 404s on data endpoints
// and unhandled AbortErrors are exactly the symptoms users reported.
function isRegressionConsole(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  if (t.includes('failed to load resource') && t.includes('404')) return true;
  if (t.includes('aborterror')) return true;
  if (t.includes('uncaught (in promise)')) return true;
  return false;
}

async function readCssVar(frameOrPage, name) {
  return frameOrPage.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name
  );
}

async function main() {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.error('setup error: cannot launch chromium: ' + e.message);
    process.exit(2);
  }
  const page = await browser.newPage();

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && isRegressionConsole(m.text())) {
      consoleErrors.push(m.text());
    }
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  // 404s surface as failed responses even when caught; track data-endpoint 404s.
  const http404 = [];
  page.on('response', (r) => {
    if (r.status() === 404 && r.url().includes('/api/')) http404.push(r.url());
  });

  // 1. Cold load of the SPA must not flood console errors or data-endpoint 404s.
  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    record('SPA cold load reachable', false, e.message);
    await browser.close();
    summarize();
    return;
  }
  record('SPA cold load reachable', true, 'loaded ' + BASE);

  // 2. Visit the data panels that previously 404-flooded on a fresh repo.
  const panels = ['overview', 'wiki', 'cost', 'trust', 'council', 'quality'];
  for (const p of panels) {
    try {
      await page.evaluate((id) => {
        const nav = document.querySelector('.nav-link[data-section="' + id + '"]');
        if (nav) nav.click();
      }, p);
      await page.waitForTimeout(700);
    } catch (e) { /* navigation best-effort */ }
  }
  // Specifically click the wiki section tabs (the original 404 source).
  try {
    await page.evaluate(() => {
      const nav = document.querySelector('.nav-link[data-section="wiki"]');
      if (nav) nav.click();
    });
    await page.waitForTimeout(400);
    const wb = await page.$('loki-wiki-browser');
    if (wb) {
      for (const tab of ['architecture', 'modules', 'data-flow']) {
        await page.evaluate((t) => {
          const el = document.querySelector('loki-wiki-browser');
          const btn = el && el.shadowRoot &&
            el.shadowRoot.querySelector('.tab[data-tab="' + t + '"]');
          if (btn) btn.click();
        }, tab);
        await page.waitForTimeout(300);
      }
    }
  } catch (e) { /* best-effort */ }

  await page.waitForTimeout(800);
  record('no cold-repo console regressions', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 4).join(' | ') : 'clean');
  record('no /api/ 404s on cold load', http404.length === 0,
    http404.length ? http404.slice(0, 4).join(' | ') : 'clean');

  // 3. Theme consistency (light-only since v7.90.1): SPA + trust iframe must
  //    share a light background on default load, and the iframe must STAY cream
  //    after SPA interaction (the Dark toggle was removed; the iframe is pinned
  //    to ?theme=light). This asserts the light-only invariant holds.
  try {
    await page.evaluate(() => {
      const nav = document.querySelector('.nav-link[data-section="trust"]');
      if (nav) nav.click();
    });
    await page.waitForTimeout(1500); // iframe lazy-loads on open
    const frame = page.frames().find((f) => f.url().includes('/trust'));
    if (!frame) {
      record('trust iframe present', false, 'no /trust frame found');
    } else {
      record('trust iframe present', true, frame.url());
      const spaBgLight = await readCssVar(page, '--loki-bg-primary');
      const frameBgLight = await readCssVar(frame, '--bg');
      // Light SPA primary is #FAFAF7; the iframe maps --bg to the same cream.
      const lightOk = /fafaf7/i.test(frameBgLight) && /fafaf7/i.test(spaBgLight);
      record('light theme: iframe matches SPA cream', lightOk,
        `spa=${spaBgLight} iframe=${frameBgLight}`);

      // Light-only invariant (v7.90.1): there is no Dark toggle to click, and
      // the iframe is pinned to ?theme=light. Re-visit the trust section to
      // exercise a repeat interaction, then confirm the iframe --bg is STILL
      // the cream #FAFAF7 (it never drifts to a dark theme).
      await page.evaluate(() => {
        const overview = document.querySelector('.nav-link[data-section="overview"]');
        if (overview) overview.click();
      });
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const nav = document.querySelector('.nav-link[data-section="trust"]');
        if (nav) nav.click();
      });
      await page.waitForTimeout(1500);
      const frame2 = page.frames().find((f) => f.url().includes('/trust'));
      const frameBgAfter = frame2 ? await readCssVar(frame2, '--bg') : '';
      const stayLightOk = /fafaf7/i.test(frameBgAfter);
      record('light-only: iframe stays cream after interaction', stayLightOk,
        `iframe(after re-open)=${frameBgAfter}`);
    }
  } catch (e) {
    record('theme consistency check', false, e.message);
  }

  await browser.close();
  summarize();
}

function summarize() {
  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log('=== fresh-repo integrated harness ===');
  console.log(`passed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + ' :: ' + f.detail));
    process.exit(1);
  }
  console.log('all integrated cold-repo assertions passed.');
  process.exit(0);
}

main().catch((e) => { console.error('harness error: ' + e.message); process.exit(2); });
