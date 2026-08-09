#!/usr/bin/env node
/*
 * webapp-receipt-panel.mjs -- the Evidence Receipt panel renders REAL data in a
 * REAL browser.
 *
 * WHY A BROWSER AND NOT A UNIT TEST. tests/e2e/dashboard-evidence-panels.mjs
 * records what happened the last time this was checked cheaply: three panels
 * each shipped with a unit test driving an extracted function against a stubbed
 * fetch, all passed, and the served page then rendered three EMPTY panels. The
 * stub resolved a BARE ARRAY while every endpoint returns a WRAPPER object, so
 * the test was teaching a contract the server does not serve. For a rendering
 * guarantee the only non-vacuous harness is a real DOM against a real server.
 *
 * THE LOAD-BEARING ASSERTIONS ARE THE HONESTY ONES, not the presence ones.
 * A panel that renders receipts but silently upgrades UNSIGNED to VERIFIED, or
 * prints $0.00 where the receipt records no cost, is worse than a panel that
 * renders nothing -- it looks like verification while asserting things nobody
 * proved. Tests 3, 4 and 5 are those checks, each paired against a fixture
 * whose correct answer is known in advance.
 *
 * Usage:  node tests/e2e/webapp-receipt-panel.mjs
 * Requires: a server on $LOKI_WEBAPP_URL (default 127.0.0.1:57378) serving the
 *   built web-app AND /api/proofs* from a project with SEEDED receipts. The
 *   caller boots and tears it down; see scripts/run-webapp-receipt-panel.sh.
 * Exit: 0 = all assertions pass; 1 = at least one failed; 2 = setup error.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pwPath = process.env.LOKI_PLAYWRIGHT_PATH ||
  resolve(__dir, '..', '..', 'dashboard-ui', 'node_modules', 'playwright');

let chromium;
try {
  ({ chromium } = require(pwPath));
} catch {
  console.log('SKIP: playwright not installed -- panel rendering not measured');
  process.exit(0);
}

// The bundle is built with Vite `base: '/lab/'` (web-app/vite.config.ts), so
// the SPA mounts at /lab/ and loading '/' renders a blank body with NO page
// error -- which is exactly how this harness first read as "the panel does not
// render" when the panel was fine.
const BASE = process.env.LOKI_WEBAPP_URL || 'http://127.0.0.1:57378';
// /metrics, not /: HomePage renders its dashboard column only while a build
// isRunning (HomePage:260), so the panel is unreachable there on a machine
// with no active session -- which is the state a user is in when they come
// looking for what a PAST build proved.
const URL = BASE.replace(/\/$/, '') + '/lab/metrics';

const results = [];
const record = (name, pass, detail = '') => results.push({ name, pass, detail });

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });

  // --- 0. VACUITY GUARD: the API actually has receipts ----------------------
  // A panel rendering nothing is CORRECT when there is nothing to render, so
  // without this every assertion below could pass against an empty server --
  // precisely the failure the unit tests already had.
  const seeded = await page.evaluate(async () => {
    const get = async (u) => {
      try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch { return null; }
    };
    const list = await get('/lab/api/proofs');
    const summary = await get('/lab/api/proofs/summary');
    return {
      count: (list && Array.isArray(list.proofs)) ? list.proofs.length : -1,
      total: summary ? summary.total_receipts : -1,
      unknown: summary ? summary.unknown : -1,
    };
  });
  if (seeded.count < 1) {
    console.log(`SETUP ERROR: /api/proofs returned ${seeded.count} receipts; nothing to render.`);
    await browser.close();
    process.exit(2);
  }
  record('the API serves seeded receipts (assertions are not vacuous)', true,
    `${seeded.count} receipts, summary total ${seeded.total}`);

  // Dismiss the first-run overlays. There are TWO -- a spec wizard ("Skip") and
  // a product tour ("Skip tour") -- and neither persists to localStorage, so a
  // fresh page always shows them. They render ABOVE the page while the panel is
  // present underneath the whole time, which is exactly how an earlier version
  // of this harness read "the panel does not render" when it did: the overlay
  // simply comes first in document.body.innerText.
  //
  // Clicked in a loop because dismissing one can reveal the other. Bounded, so
  // a future third overlay makes this fail visibly rather than hang.
  for (let i = 0; i < 6; i++) {
    const clicked = await page.evaluate(() => {
      const labels = [/^\s*skip tour\s*$/i, /^\s*skip\s*$/i, /^\s*got it!?\s*$/i, /^\s*dismiss\s*$/i];
      for (const re of labels) {
        const b = Array.from(document.querySelectorAll('button')).find((x) => re.test(x.innerText));
        if (b) { b.click(); return true; }
      }
      return false;
    });
    if (!clicked) break;
    await page.waitForTimeout(400);
  }
  // WAIT FOR THE ELEMENT, never a fixed sleep. EvidenceReceiptPanel is
  // code-split into its own lazily-loaded chunk (dist/assets/
  // EvidenceReceiptPanel-*.js), so it appears only after that chunk loads and
  // its two fetches resolve. A timeout-based wait made this harness report
  // "the panel does not render" intermittently while the panel was fine --
  // a flaky assertion about a correct product is worse than no assertion.
  let panelAppeared = true;
  try {
    await page.waitForFunction(
      () => /Evidence Receipts/i.test(document.body.innerText),
      { timeout: 20000 });
  } catch {
    panelAppeared = false;
  }
  const bodyText = await page.evaluate(() => document.body.innerText);

  // --- 1. The panel is on the page at all ----------------------------------
  record('the Evidence Receipts panel renders', panelAppeared,
    panelAppeared ? '' : 'lazy chunk never resolved within 20s');

  // --- 2. It renders the receipts, not an empty state ----------------------
  // Identified by run_id, not by headline: the backend buckets on an EXACT
  // "VERIFIED" match (dashboard/server.py), so a marker string appended to the
  // headline would push every fixture into the `unknown` bucket and silently
  // break test 3. The run_id is unique per fixture and is what a row shows.
  record('a seeded receipt is listed (not the empty state)',
    /no-cost-receipt|r-verified|r-unknown/i.test(bodyText),
    bodyText.slice(bodyText.search(/Evidence Receipts/i), bodyText.search(/Evidence Receipts/i) + 160));

  // --- 3. HONESTY: the unknown bucket is rendered, not hidden --------------
  // The summary endpoint refuses to count a receipt as verified when it cannot
  // prove it was. Hiding that bucket would launder "we do not know" into an
  // implied pass -- the single most damaging thing this panel could do.
  if (seeded.unknown > 0) {
    // Matched as "<n> unknown" (the strip's own legend format), NOT a bare
    // /unknown/ anywhere on the page. Mutation testing showed the loose regex
    // still passed with the bucket DELETED, because an expanded row renders
    // "unknown" for an absent cost -- the assertion was green for the wrong
    // reason, which is the failure mode this whole harness exists to catch.
    const strip = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll('h2'));
      const h = heads.find((e) => /Evidence Receipts/i.test(e.innerText || ''));
      const root = h && h.closest('section');
      return root ? root.innerText : '';
    });
    record('the unknown bucket is shown when the API reports one',
      new RegExp(`${seeded.unknown}\\s+unknown`, 'i').test(strip),
      `summary.unknown=${seeded.unknown}`);
  } else {
    record('skipped the unknown-bucket check: fixture reported none (not a pass)', true);
  }

  // --- 4. HONESTY: the aggregate does not claim to re-verify ---------------
  record('the summary states it is not re-verified here',
    /not re-verified here/i.test(bodyText));

  // --- 5. HONESTY: an absent cost reads unknown, never $0.00 ---------------
  // The fixture deliberately includes a receipt with NO cost recorded. A
  // fabricated zero in a verification surface is the confident wrong number
  // the receipt exists to prevent.
  const row = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const target = btns.find((b) => /no-cost-receipt/i.test(b.innerText));
    if (!target) return { found: false, text: '' };
    target.click();
    return { found: true, text: '' };
  });
  if (row.found) {
    await page.waitForTimeout(900);
    // SCOPED to the panel's own subtree, not document.body. The Metrics page
    // renders unrelated currency elsewhere, so a whole-page scan reported a
    // "fabricated $0.00" that belonged to another component entirely -- an
    // assertion that accuses the wrong file is worse than no assertion. The
    // same scoping keeps the UNCHECKED check below from passing on a "Not
    // checked" string that came from a different row.
    const expanded = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll('h2'));
      const h = heads.find((e) => /Evidence Receipts/i.test(e.innerText || ''));
      const root = h && h.closest('section');
      return root ? root.innerText : '';
    });
    const showsUnknown = /unknown/i.test(expanded);
    const showsFakeZero = /\$0\.00/.test(expanded);
    record('a receipt with no recorded cost shows unknown, never $0.00',
      showsUnknown && !showsFakeZero,
      `unknown=${showsUnknown} fabricatedZero=${showsFakeZero}`);
    // --- 6. An attested receipt reads UNCHECKED, not VERIFIED -------------
    // A browser cannot evaluate an Ed25519 signature. Claiming otherwise is
    // exactly the dishonesty this panel exists to prevent, so it must point at
    // the command that actually checks.
    record('an attested receipt is not claimed VERIFIED in-browser',
      !/\bVerified\b/.test(expanded) || /Not checked/i.test(expanded),
      'expanded row must not assert a signature it did not evaluate');
    record('the panel names the command that can verify it',
      /loki proof verify/i.test(expanded));
  } else {
    record('could not find the no-cost fixture row to expand', false,
      'fixture missing or the row label changed');
  }

  // --- 7. No uncaught page errors ------------------------------------------
  // A panel can render its shell and still throw while fetching, which leaves a
  // permanently-empty section that looks like "no data".
  record('no uncaught page errors', pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '));

  await browser.close();

  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
    if (!r.pass) failed++;
  }
  console.log(`\n  Passed: ${results.length - failed}   Failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`SETUP ERROR: ${e && e.message ? e.message : e}`);
  process.exit(2);
});
