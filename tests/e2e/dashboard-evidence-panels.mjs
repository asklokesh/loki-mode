#!/usr/bin/env node
/*
 * dashboard-evidence-panels.mjs -- the receipts / learnings / budget panels
 * render REAL data in a REAL browser.
 *
 * WHY THIS EXISTS. Each of the three panels shipped with a unit test that
 * drove an EXTRACTED function against a STUBBED fetch. Every one passed. Then
 * driving the served page against the live server rendered three empty panels,
 * and it took four attempts to establish that the page was fine and the
 * harness was lying:
 *
 *   - a brace-matching extractor counted { } inside strings and comments and
 *     truncated loadReceipts at 2680 of its bytes, mid-comment;
 *   - the stubbed fetch resolved a BARE ARRAY while all three endpoints return
 *     WRAPPER objects ({"proofs":[...]}, {"learnings":[...]}), so the stub was
 *     teaching the test a contract the server does not serve;
 *   - a hand-rolled `document` stub made the whole 720KB script block throw at
 *     runtime, which a bare try/catch reported as "block failed to evaluate".
 *
 * None of those are defects in the product. All three are defects in
 * substitutes for a browser. That is the point: for a rendering guarantee the
 * only non-vacuous harness is a real DOM against a real server, because every
 * cheaper stand-in was wrong in a way that pointed at the wrong file.
 *
 * THE LOAD-BEARING ASSERTIONS are the honesty ones, not the presence ones.
 * A panel that renders is worth little; a panel that renders an UNMEASURED
 * value as a confident zero is worse than no panel, because "$0.00" reads as
 * "this run was free" and "0 hits" reads as "this gate ran and never fired".
 * The receipt records those as UNKNOWN. The pixel has to keep the distinction
 * or the guarantee dies at the last inch. Tests 4 and 5 are that check, and
 * they are paired with a positive control (a genuine measured zero must still
 * print as zero) so the guard cannot pass by blanking everything.
 *
 * Usage:  node tests/e2e/dashboard-evidence-panels.mjs
 * Requires: a dashboard server on $LOKI_DASH_URL (default 127.0.0.1:57374)
 *   whose project has SEEDED .loki evidence -- the inverse of the cold-repo
 *   fixture in dashboard-fresh-repo.mjs. The caller boots and tears down the
 *   server; see scripts/run-dashboard-evidence-panels-harness.sh.
 * Exit: 0 = all assertions pass; 1 = at least one failed; 2 = setup error.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pwPath = process.env.LOKI_PLAYWRIGHT_PATH ||
  resolve(__dir, '..', '..', 'dashboard-ui', 'node_modules', 'playwright');
const { chromium } = require(pwPath);

const URL = process.env.LOKI_DASH_URL || 'http://127.0.0.1:57374';

const results = [];
const record = (name, pass, detail = '') => results.push({ name, pass, detail });

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });

  // --- 0. The endpoints actually have data ---------------------------------
  // A panel that renders nothing is CORRECT when there is nothing to render.
  // Without this the whole harness would pass vacuously against an empty
  // server, which is the exact failure mode the unit tests already had.
  const seeded = await page.evaluate(async () => {
    const get = async (u) => { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch { return null; } };
    const proofs = await get('/api/proofs');
    const learn = await get('/api/learnings');
    const budget = await get('/api/budget');
    return {
      proofs: (proofs && (proofs.proofs || proofs.receipts || (Array.isArray(proofs) ? proofs : []))) || [],
      learnings: (learn && (learn.learnings || (Array.isArray(learn) ? learn : []))) || [],
      budget,
    };
  });
  if (!seeded.proofs.length || !seeded.learnings.length) {
    console.error('SETUP ERROR: server has no seeded receipts/learnings; ' +
      'this harness cannot distinguish "renders nothing" from "nothing to render". ' +
      `proofs=${seeded.proofs.length} learnings=${seeded.learnings.length}`);
    await browser.close();
    process.exit(2);
  }
  record('fixture: server serves receipts and learnings',
    true, `proofs=${seeded.proofs.length} learnings=${seeded.learnings.length}`);

  // --- 1-3. Each loader populates its panel in a real DOM -------------------
  const panels = [
    ['loadReceipts', 'receipts-panel', 'receipts-list'],
    ['loadLearnings', 'learnings-panel', 'learnings-list'],
    ['loadBudget', 'budget-banner', 'budget-banner'],
  ];
  const rendered = {};
  for (const [fn, panelId, listId] of panels) {
    const r = await page.evaluate(async ([fn, panelId, listId]) => {
      if (typeof window[fn] !== 'function') return { missing: true };
      window[fn]();
      await new Promise((res) => setTimeout(res, 1500));
      const panel = document.getElementById(panelId);
      const list = document.getElementById(listId);
      return {
        missing: false,
        shown: panel ? getComputedStyle(panel).display !== 'none' : false,
        html: list ? (list.innerHTML || '') : '',
        text: list ? (list.textContent || '').replace(/\s+/g, ' ').trim() : '',
      };
    }, [fn, panelId, listId]);

    rendered[fn] = r;
    if (r.missing) {
      record(`${fn} populates ${listId}`, false, 'loader is not defined on window');
    } else {
      record(`${fn} populates ${listId}`, r.shown && r.text.length > 0,
        `shown=${r.shown} textLen=${r.text.length}`);
    }
  }

  // --- 4. THE GUARD: an unmeasured cost is never a fabricated zero ---------
  // Every receipt whose cost_usd is null must print "-". A "$0.00" there is a
  // claim the run was free. Asserted against the SERVER's own null count, so
  // it cannot pass by the panel rendering nothing at all.
  const nullCostReceipts = seeded.proofs.filter(
    (x) => x && (x.cost_usd === null || x.cost_usd === undefined)).length;
  const receiptText = (rendered.loadReceipts && rendered.loadReceipts.text) || '';
  // A dash count is NOT asserted: "-" also appears in the date, the file count
  // and the link text, so it discriminates only by accident of the fixture.
  // The negative is the whole guard.
  if (nullCostReceipts > 0) {
    record('an unmeasured receipt cost renders "-", not $0.00',
      !/\$0\.00/.test(receiptText),
      `${nullCostReceipts} receipts have null cost; ` +
      `hasZero=${/\$0\.00/.test(receiptText)}`);
  } else {
    // NOT a skip. This harness OWNS its fixture (see the runner heredoc), which
    // pins a null cost precisely so this guarantee is always exercised. A seed
    // edit that gives every receipt a measured cost would otherwise reduce nine
    // assertions to five and report PASS forever -- the grep-absence
    // false-green, arriving as a fixture change nobody reviewed as a test change.
    record('an unmeasured receipt cost renders "-", not $0.00', false,
      'FIXTURE DRIFT: no seeded receipt has a null cost, so the fabricated-zero ' +
      'guard was never exercised. Restore a null cost.usd in the runner seed.');
  }

  // --- 5. A verdict is reported as the receipt states it -------------------
  // NOT VERIFIED must survive to the pixel unsoftened. A UI that renders an
  // unverified run as neutral is the single most damaging thing this panel
  // could do, because the receipt is the product's whole claim.
  const serverVerdicts = seeded.proofs
    .map((x) => (x && (x.headline || x.final_verdict)) || '')
    .filter((v) => /NOT VERIFIED/i.test(v)).length;
  if (serverVerdicts > 0) {
    record('an unverified receipt still reads NOT VERIFIED in the UI',
      /NOT VERIFIED/i.test(receiptText),
      `${serverVerdicts} unverified receipts on the server; ` +
      `present in DOM=${/NOT VERIFIED/i.test(receiptText)}`);
  } else {
    record('an unverified receipt still reads NOT VERIFIED in the UI', false,
      'FIXTURE DRIFT: no seeded receipt is NOT VERIFIED, so the unsoftened-verdict ' +
      'guard was never exercised. Restore honesty.headline=NOT VERIFIED in the seed.');
  }

  // --- 6. POSITIVE CONTROL: a measured zero still prints as zero ----------
  // Pairs with test 4. Without it, a panel that rendered "-" for EVERYTHING
  // would pass the honesty guard while destroying the real numbers.
  const budgetText = (rendered.loadBudget && rendered.loadBudget.text) || '';
  const cost = seeded.budget && seeded.budget.current_cost;
  if (cost === 0) {
    record('a measured zero spend still renders as $0.00 (guard is not over-broad)',
      /\$0\.00/.test(budgetText), `budget text: ${budgetText.slice(0, 120)}`);
  } else {
    record('a measured zero spend still renders as $0.00 (guard is not over-broad)',
      false, `FIXTURE DRIFT: current_cost=${cost} is not zero, so the positive ` +
      'control was never exercised -- without it a panel that renders "-" for ' +
      'EVERYTHING passes the honesty guard while destroying the real numbers.');
  }

  // --- 7. An absent cap is stated, never implied ---------------------------
  // budget_limit null means NO CAP. Silence there reads as "a cap exists and
  // we are under it", which is the dangerous direction of the error.
  if (seeded.budget && (seeded.budget.budget_limit === null ||
      seeded.budget.budget_limit === undefined)) {
    record('no spend cap is stated plainly in the UI',
      /no spend cap/i.test(budgetText),
      `budget text: ${budgetText.slice(0, 120)}`);
  } else {
    record('no spend cap is stated plainly in the UI', false,
      `FIXTURE DRIFT: a cap is set (${seeded.budget && seeded.budget.budget_limit}), ` +
      'so the absent-cap wording was never exercised. The seed writes no budget ' +
      'file precisely to keep budget_limit null.');
  }

  // --- 8. Rendering the panels throws nothing ------------------------------
  record('no page errors while rendering the evidence panels',
    pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  await browser.close();
  summarize();
}

function summarize() {
  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log('=== evidence panels harness ===');
  results.forEach((r) => console.log(`  ${r.pass ? 'PASS' : 'FAIL'}: ${r.name}` +
    (r.detail ? `  [${r.detail}]` : '')));
  console.log(`passed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + ' :: ' + f.detail));
    process.exit(1);
  }
  console.log('all evidence-panel assertions passed.');
  process.exit(0);
}

main().catch((e) => { console.error('harness error: ' + e.message); process.exit(2); });
