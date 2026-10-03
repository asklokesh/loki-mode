// S-224 / BACKLOG 118: a partly priced run's cost is a lower bound
// (cost.cost_partial, efficiency_cost.py), but the receipt rendered "$1.20" and
// the Metrics cost trend labelled the run as if its cost were complete.
//
// Both files are TSX with browser-only imports, so plain `node --test` cannot
// import them. ponytail: the test lifts the Cost field's value expression out of
// EvidenceReceiptPanel.tsx and the costTrend memo body out of MetricsPage.tsx,
// strips types with node:module and evaluates them.
// Run: node --test web-app/src/components/EvidenceReceiptPanel.cost.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const panel = fs.readFileSync(new URL('./EvidenceReceiptPanel.tsx', import.meta.url), 'utf8');
const field = panel.indexOf('label="Cost"');
assert.ok(field >= 0, 'Cost field not found in EvidenceReceiptPanel.tsx');
const vStart = panel.indexOf('value={', field) + 'value={'.length;
const vEnd = panel.indexOf('}\n                />', vStart);
assert.ok(vStart > field && vEnd > vStart, 'Cost value expression not found');
const costText = (detail) =>
  new Function('detail', `return (${stripTypeScriptTypes(panel.slice(vStart, vEnd))});`)(detail);

const page = fs.readFileSync(new URL('../pages/MetricsPage.tsx', import.meta.url), 'utf8');
const memo = page.indexOf('const costTrend = useMemo(() => {');
assert.ok(memo >= 0, 'costTrend memo not found in MetricsPage.tsx');
const bStart = page.indexOf('{', memo + 'const costTrend = useMemo(() => '.length);
const bEnd = page.indexOf('\n  }, [timeline]);', bStart);
assert.ok(bEnd > bStart, 'costTrend memo body not found');
const costTrend = (timeline) =>
  new Function(`return (${stripTypeScriptTypes(`(timeline) => {${page.slice(bStart + 1, bEnd)}\n}`)});`)()(timeline);

test('receipt: cost_partial true renders a lower bound', () => {
  assert.equal(costText({ cost: { usd: 1.2, cost_partial: true } }), 'at least $1.20');
});

test('receipt: cost_partial absent or false keeps the exact cost', () => {
  assert.equal(costText({ cost: { usd: 1.2 } }), '$1.20');
  assert.equal(costText({ cost: { usd: 1.2, cost_partial: false } }), '$1.20');
});

test('receipt: an absent cost still reads unknown', () => {
  assert.equal(costText({}), 'unknown');
  assert.equal(costText({ cost: { cost_partial: true } }), 'unknown');
});

test('trend: a partial run carries (partial), a complete run does not', () => {
  const pts = costTrend({
    runs: [
      { run_id: 'run-aaaaaa', cost_usd: 1.2, cost_partial: true },
      { run_id: 'run-bbbbbb', cost_usd: 2.5 },
      { run_id: 'run-cccccc', cost_usd: 0.4, cost_partial: false },
      { run_id: 'run-dddddd', cost_usd: null, cost_partial: true },
    ],
  });
  assert.deepEqual(pts, [
    { label: 'aaaaaa (partial)', value: 1.2 },
    { label: 'bbbbbb', value: 2.5 },
    { label: 'cccccc', value: 0.4 },
  ]);
});
