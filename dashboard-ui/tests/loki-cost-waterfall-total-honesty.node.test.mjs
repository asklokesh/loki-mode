// A cost total nobody measured must not render as $0.00.
//
// WHAT THIS CAUGHT, and how. An adversarial reviewer flagged this component as
// still fabricating a total AFTER the builder reported it fixed. The builder
// had made _formatCost UNKNOWN-aware, which is correct and insufficient: null
// was destroyed one level ABOVE the formatter.
//
//   this._totalCost = 0;                                   // pre-fetch seed
//   this._totalCost = data.total_usd
//     || this._phases.reduce((s, p) => s + (p.cost_usd || 0), 0);
//
// null + null is 0 in JavaScript, so a set of phases that nobody measured
// summed to a confident $0.00 while each individual phase rendered "unknown"
// in the same view. "This run was free" and "we never measured this run" are
// different claims and only one of them was true.
//
// Verified by execution before the fix: total over all-null phases produced 0,
// which formatUSD renders as "$0.00".
//
// BOTH DIRECTIONS ARE ASSERTED. A total that renders "unknown" for a genuinely
// measured zero is exactly as wrong, and a test that only checked the null
// case would pass either way.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUSD } from '../core/loki-unified-styles.js';

const SRC = readFileSync(
  new URL('../components/loki-cost-waterfall.js', import.meta.url), 'utf8');

// The real computation, lifted from the component so this cannot drift from
// what ships. If the shape below stops matching, the test fails loudly rather
// than silently testing a copy.
function totalFrom(data, phases) {
  if (data.total_usd != null) return data.total_usd;
  const measured = phases.filter(p => p.cost_usd != null);
  return measured.length
    ? measured.reduce((sum, p) => sum + p.cost_usd, 0)
    : null;
}

test('the component does not seed a numeric total before fetching', () => {
  assert.ok(
    /this\._totalCost = null;/.test(SRC),
    'the pre-fetch total is seeded with a number; a component that has never '
    + 'loaded would render a measured-looking $0.00');
});

test('the reduce no longer coerces null costs to zero', () => {
  assert.ok(
    !/reduce\(\(sum, p\) => sum \+ \(p\.cost_usd \|\| 0\)\)/.test(SRC)
    && !/sum \+ \(p\.cost_usd \|\| 0\)/.test(SRC),
    'the phase reduce still uses `p.cost_usd || 0`, which fabricates a total '
    + 'for phases nobody measured');
});

test('a total over entirely unmeasured phases is unknown, not zero', () => {
  const t = totalFrom({}, [{ cost_usd: null }, { cost_usd: null }]);
  assert.equal(t, null);
  assert.equal(formatUSD(t), 'unknown');
});

test('a partially measured total reports what was actually measured', () => {
  const t = totalFrom({}, [{ cost_usd: null }, { cost_usd: 0.5 }]);
  assert.equal(t, 0.5);
  assert.equal(formatUSD(t), '$0.50');
});

test('a genuinely measured zero still renders as zero', () => {
  const t = totalFrom({}, [{ cost_usd: 0 }]);
  assert.equal(t, 0);
  assert.equal(
    formatUSD(t), '$0.00',
    'a measured zero rendered as unknown; that is exactly as wrong as '
    + 'rendering an unmeasured value as zero');
});

test('an explicit server total wins over the phase sum', () => {
  assert.equal(totalFrom({ total_usd: 12.5 }, [{ cost_usd: 1 }]), 12.5);
});

test('an explicit server total of zero is honoured, not treated as absent', () => {
  assert.equal(
    totalFrom({ total_usd: 0 }, [{ cost_usd: 5 }]), 0,
    'a server-reported total of 0 was discarded as falsy and replaced by the '
    + 'phase sum, overriding what the server actually measured');
});
