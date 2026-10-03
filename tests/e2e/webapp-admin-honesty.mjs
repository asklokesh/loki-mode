#!/usr/bin/env node
/*
 * webapp-admin-honesty.mjs -- moat P7 in a real browser: the Admin console and
 * the Templates page show only what an endpoint measured.
 *
 * WHAT THIS CATCHES. /admin rendered invented numbers as if they were read:
 * "24 users", "$201.00 Monthly Cost", a 94% build-success ring, a system-health
 * list with fake latencies (including the removed Gemini provider), a
 * builds-per-user chart, twenty fake audit rows for alex@company.com, and five
 * tabs (Users, Analytics, Governance, Audit Trail, Compliance) that fell back to
 * sample data whenever no prop was passed -- which was always. The Templates
 * page printed "2847 uses" and star ratings for every template, random for any
 * template not in a hardcoded table.
 *
 * WHY A BROWSER. The moat scanner reads source for sample-fallback shapes; it
 * cannot see an unconditional fake (`useState(generateOverviewCards)`), and it
 * cannot prove the real endpoints actually reach the page. This drives the
 * BUILT bundle against a seeded server with KNOWN values, so each assertion has
 * a correct answer fixed in advance:
 *   - audit-log.json holds one `team.created` entry for `harness-team`
 *       -> the Audit Trail tab and the overview activity list must show it
 *   - no cost was recorded
 *       -> the overview cost card must say "Not recorded", never $0.00
 *   - no user directory, governance or compliance endpoint exists
 *       -> those tabs must say "Not connected", never render rows
 *   - a team created through the Teams page has exactly one audit entry
 *       -> its Activity tab shows that team.created entry, never invented
 *          rows and never the seeded harness-team entry of another team;
 *          an aborted audit-log, team-list or create request renders an
 *          error and adds no sample or local-only row
 *   - one receipt with an unrecorded cost and a $10 cap with no spend
 *       -> Metrics reads "Runs with cost 0 of 1 run with a receipt" and the
 *          budget "Not recorded"; the home page's How-it-works mockups are
 *          labelled Example with no 68% reading, and GitHub/npm counts read
 *          "--" when those APIs do not answer
 *
 * Usage: node tests/e2e/webapp-admin-honesty.mjs
 * Requires: a server on $LOKI_WEBAPP_URL serving the built web-app; see
 *   scripts/run-webapp-admin-honesty.sh, which boots and tears it down.
 * Exit: 0 = all assertions pass; 1 = at least one failed; 2 = setup error.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pwPath = process.env.LOKI_PLAYWRIGHT_PATH ||
  resolve(__dir, '..', '..', 'web-app', 'node_modules', 'playwright-core');

let chromium;
try {
  ({ chromium } = require(pwPath));
} catch {
  console.log('SKIP: playwright not installed -- admin honesty not measured');
  process.exit(0);
}

const BASE = (process.env.LOKI_WEBAPP_URL || 'http://127.0.0.1:57379').replace(/\/$/, '');
const results = [];
const record = (name, pass, detail = '') => results.push({ name, pass, detail });

// Every literal below was rendered by the pre-fix bundle. None of them can be
// produced by the seeded server, so any hit is fabricated data.
const FABRICATED = {
  overview: ['Monthly Cost', '$201.00', '+3 this month', 'Gemini Provider', 'Builds per User',
    'Alex C.', 'alex@company.com', '342 total builds'],
  users: ['Alex Chen', 'sarah@company.com', 'Jordan Lee'],
  analytics: ['124.50', '48.30', '298 passed', 'Discord Bot'],
  governance: ['Customer Portal v2', 'Main Platform', 'Marketing'],
  audit: ['admin@company.com', '192.168.1.10', 'ops@company.com'],
  compliance: ['AES-256', '100 requests/minute', 'MFA Enabled'],
};

async function dismissOverlays(page) {
  // Same first-run overlays the receipt-panel harness dismisses; bounded so a
  // new overlay fails visibly instead of hanging.
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
}

const mainText = (page) => page.evaluate(() => (document.querySelector('main') || document.body).innerText);

async function waitText(page, re, timeout = 15000) {
  try {
    await page.waitForFunction((src) => new RegExp(src, 'i').test(document.body.innerText), re.source, { timeout });
    return true;
  } catch {
    return false;
  }
}

function assertNoFabricated(tab, text) {
  const hits = FABRICATED[tab].filter((lit) => text.includes(lit));
  record(`${tab}: no fabricated sample values`, hits.length === 0, hits.join(', '));
}

async function openTab(page, label) {
  const btn = page.getByRole('button', { name: label, exact: true });
  if (await btn.count() === 0) return false;
  await btn.first().click();
  await page.waitForTimeout(500);
  return true;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));

  // --- 0. VACUITY GUARD: the seeded endpoints answer ------------------------
  await page.goto(`${BASE}/lab/admin`, { waitUntil: 'networkidle', timeout: 30000 });
  const seeded = await page.evaluate(async () => {
    const get = async (u) => { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch { return null; } };
    const audit = await get('/lab/api/audit-log');
    const cost = await get('/lab/api/cost');
    return {
      audit: Array.isArray(audit) ? audit.length : -1,
      costRecorded: cost ? cost.cost_recorded : 'no-response',
    };
  });
  if (seeded.audit < 1 || seeded.costRecorded !== false) {
    console.log(`SETUP ERROR: seed not served (audit=${seeded.audit}, cost_recorded=${seeded.costRecorded})`);
    await browser.close();
    process.exit(2);
  }
  record('the API serves the seeded audit log and an unrecorded cost', true,
    `audit entries=${seeded.audit}`);
  await dismissOverlays(page);

  // --- 1. Overview -----------------------------------------------------------
  const overviewUp = await waitText(page, /harness-team/);
  let text = await mainText(page);
  record('overview: recent activity comes from /api/audit-log', overviewUp && text.includes('harness-team'));
  record('overview: unrecorded cost reads "Not recorded", never $0.00',
    /Not recorded/.test(text) && !/\$0\.00/.test(text));
  assertNoFabricated('overview', text);

  // --- 2. Users --------------------------------------------------------------
  record('users tab exists', await openTab(page, 'Users'));
  text = await mainText(page);
  record('users: no directory endpoint reads "Not connected"', /Not connected/i.test(text));
  record('users: no invite control that would add a local-only row', !/Invite User/.test(text));
  assertNoFabricated('users', text);

  // --- 3. Analytics ----------------------------------------------------------
  record('analytics tab exists', await openTab(page, 'Analytics'));
  text = await mainText(page);
  record('analytics: unmeasured series read "Not recorded"', /Not recorded/i.test(text));
  record('analytics: no success-rate percentage from nothing', !/\d+%/.test(text));
  assertNoFabricated('analytics', text);

  // --- 4. Governance ---------------------------------------------------------
  record('governance tab exists', await openTab(page, 'Governance'));
  text = await mainText(page);
  record('governance: approvals read "Not connected"', /Not connected/i.test(text));
  for (const sub of ['Budgets', 'Templates']) {
    await openTab(page, sub);
    const t = await mainText(page);
    text += '\n' + t;
    record(`governance/${sub}: reads "Not connected"`, /Not connected/i.test(t));
  }
  assertNoFabricated('governance', text);

  // --- 5. Audit Trail --------------------------------------------------------
  record('audit tab exists', await openTab(page, 'Audit Trail'));
  const auditUp = await waitText(page, /team\.created/);
  text = await mainText(page);
  record('audit: rows come from /api/audit-log', auditUp && text.includes('harness-team'));
  assertNoFabricated('audit', text);

  // --- 6. Compliance ---------------------------------------------------------
  record('compliance tab exists', await openTab(page, 'Compliance'));
  text = await mainText(page);
  record('compliance: reads "Not connected"', /Not connected/i.test(text));
  record('compliance: no score gauge computed from zero checks', !/\d+%\s*Compliant/i.test(text));
  assertNoFabricated('compliance', text);

  // --- 7. Templates page: no invented usage stats -----------------------------
  await page.goto(`${BASE}/lab/templates`, { waitUntil: 'networkidle', timeout: 30000 });
  await dismissOverlays(page);
  // Vacuity guard: with zero templates there are no cards, and "no use counts"
  // would pass on an empty page.
  const nTemplates = await page.evaluate(async () => {
    try { const r = await fetch('/lab/api/templates'); const j = await r.json(); return Array.isArray(j) ? j.length : -1; } catch { return -1; }
  });
  const templatesUp = nTemplates > 0 && await waitText(page, /Featured/);
  text = await mainText(page);
  record('templates page renders template cards (check is not vacuous)', templatesUp, `api templates=${nTemplates}`);
  record('templates: no fabricated use counts', !/\b\d[\d.,]*k?\s+uses\b/i.test(text),
    (text.match(/\b\d[\d.,]*k?\s+uses\b/i) || [''])[0]);

  // --- 8. Teams page: Activity, error states, create -------------------------
  // The Teams page seeded every team's Activity tab with four invented rows
  // ("Invited viewer@example.com ... 1 day ago") in a fetch-less effect, swapped
  // in a sample "Engineering" team and sample audit rows whenever a request
  // failed, and added a local-only team row when POST /api/teams failed.
  const TEAM_FAKES = ['Invited viewer@example.com', 'Deployed to production', 'Created project "my-app"',
    'Updated RBAC settings', 'admin@example.com', 'dev@example.com', 'viewer@example.com',
    'editor@example.com', 'Engineering', 'member.invited'];
  const teamFakes = (t) => TEAM_FAKES.filter((lit) => t.includes(lit));
  const FRESH = 'harness-fresh-team';
  await page.goto(`${BASE}/lab/teams`, { waitUntil: 'networkidle', timeout: 30000 });
  await dismissOverlays(page);
  const createTeam = async (name) => {
    await page.getByRole('button', { name: 'New Team', exact: true }).first().click();
    await page.getByPlaceholder('Team name').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).first().click();
  };
  await createTeam(FRESH);
  const created = await waitText(page, new RegExp(`${FRESH}`));
  // Vacuity guard: the team exists on the SERVER, not only in page state.
  const stored = await page.evaluate(async (n) => {
    try { const r = await fetch('/lab/api/teams'); const j = await r.json(); return Array.isArray(j) && j.some((t) => t.name === n); } catch { return false; }
  }, FRESH);
  record('teams: a team created in the UI is stored by the server (check is not vacuous)', created && stored);
  record('teams activity tab exists', await openTab(page, 'Activity'));
  const activityUp = await waitText(page, /team\.created|No recent activity|Could not load activity/);
  text = await mainText(page);
  record('teams: a fresh team\'s Activity shows its own team.created entry from /api/audit-log',
    activityUp && text.includes('team.created') && text.includes(FRESH));
  record('teams: Activity never shows another team\'s entry (seeded harness-team)', !/\bharness-team\b/.test(text));
  record('teams: Activity shows no invented rows', teamFakes(text).length === 0, teamFakes(text).join(', '));

  // A failed audit read in the Roles tab is an error, never sample rows.
  await page.route('**/api/audit-log', (r) => r.abort());
  await openTab(page, 'Roles & Permissions');
  await openTab(page, 'Audit Log');
  const auditErr = await waitText(page, /Could not load the audit log/);
  text = await mainText(page);
  record('teams: a failed audit-log read renders an error, not sample audit rows',
    auditErr && teamFakes(text).length === 0, teamFakes(text).join(', '));
  await page.unroute('**/api/audit-log');

  // A failed create adds nothing.
  const before = await page.evaluate(() => (document.querySelector('main') || document.body).innerText);
  await page.route('**/api/teams', (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()));
  await createTeam('harness-never-stored');
  const createErr = await waitText(page, /Could not create team/);
  text = await mainText(page);
  record('teams: a failed create shows an error and adds no local-only team row',
    createErr && !text.includes('harness-never-stored') && before.includes(FRESH));
  await page.unroute('**/api/teams');

  // A failed team list is an error, never a sample team.
  await page.route('**/api/teams', (r) => r.abort());
  await page.goto(`${BASE}/lab/teams`, { waitUntil: 'networkidle', timeout: 30000 });
  await dismissOverlays(page);
  const listErr = await waitText(page, /Could not load teams/);
  text = await mainText(page);
  record('teams: a failed team list renders "Could not load teams", not a sample team',
    listErr && !/No teams yet/.test(text) && teamFakes(text).length === 0, teamFakes(text).join(', '));
  await page.unroute('**/api/teams');

  // --- 9. Metrics page: runs with cost, budget -------------------------------
  // The seed has one receipt whose cost was not recorded and a $10 cap with no
  // measured spend. "Runs with cost" counted receipts (1) instead of runs that
  // recorded a cost (0), and an unmeasured budget must read "Not recorded".
  await page.goto(`${BASE}/lab/metrics`, { waitUntil: 'networkidle', timeout: 30000 });
  await dismissOverlays(page);
  const metricsUp = await waitText(page, /Runs with cost/);
  const card = (label) => page.evaluate((l) => {
    const s = Array.from(document.querySelectorAll('span')).find((x) => x.innerText.trim() === l);
    const c = s && s.closest('.rounded-card');
    return c ? c.innerText.replace(/\s+/g, ' ').trim() : '';
  }, label);
  const runsCard = await card('Runs with cost');
  record('metrics: "Runs with cost" counts runs that recorded a cost, not receipts',
    metricsUp && /Runs with cost 0 of 1 run with a receipt/.test(runsCard), runsCard);
  const budgetCard = await card('Budget used');
  record('metrics: a cap with no measured spend reads "Not recorded", never 0%',
    /Not recorded/.test(budgetCard) && !/\b0%/.test(budgetCard) && !/\$0\.00/.test(budgetCard), budgetCard);

  // --- 10. Home page: labelled examples, no fetched-count zeros ----------------
  // HowItWorks drew a 68% progress bar with no label; OpenSourceStats showed
  // 0 stars / 0 forks whenever GitHub or npm did not answer.
  await page.route(/api\.github\.com|api\.npmjs\.org/, (r) => r.abort());
  await page.goto(`${BASE}/lab/`, { waitUntil: 'networkidle', timeout: 30000 });
  await dismissOverlays(page);
  const homeUp = await waitText(page, /How it works|GitHub Stars/);
  text = await mainText(page);
  record('home: the How-it-works mockups are labelled Example and show no 68% reading',
    // innerText applies the badge's uppercase transform, hence /i.
    homeUp && /\bexample\b/i.test(text) && !text.includes('68%'), `homeUp=${homeUp}`);
  const stats = await page.evaluate(() => ['GitHub Stars', 'Forks', 'Contributors'].map((l) => {
    const el = Array.from(document.querySelectorAll('div')).find((x) => x.childElementCount === 0 && x.innerText.trim() === l);
    return el && el.previousElementSibling ? el.previousElementSibling.innerText.trim() : 'MISSING';
  }));
  record('home: unreachable GitHub/npm counts read "--", never 0', stats.every((v) => v === '--'), stats.join(', '));
  await page.unroute(/api\.github\.com|api\.npmjs\.org/);

  record('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
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
