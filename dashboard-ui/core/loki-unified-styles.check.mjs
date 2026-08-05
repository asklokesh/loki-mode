/**
 * Runnable check for the unmeasured-metric formatters.
 *
 *   node dashboard-ui/core/loki-unified-styles.check.mjs
 *
 * Both directions are asserted for every formatter, because the two failure
 * modes are equally bad:
 *   - unmeasured rendered as 0   ("the run was free")
 *   - a measured 0 rendered as unknown ("we never counted")
 */
import assert from 'node:assert/strict';
import {
  UNKNOWN,
  formatMetric,
  formatUSD,
  formatTokens,
  formatDuration,
  formatPercent,
} from './loki-unified-styles.js';

// --- direction 1: unmeasured must NOT render as a number -------------------
for (const fn of [formatUSD, formatTokens, formatDuration, formatPercent]) {
  for (const absent of [null, undefined, NaN]) {
    const out = fn(absent);
    assert.equal(out, UNKNOWN, `${fn.name}(${String(absent)}) should be UNKNOWN, got ${out}`);
    assert.ok(!/\d/.test(out), `${fn.name}(${String(absent)}) must contain no digit, got ${out}`);
  }
}

// The marker must be a word, not a dash that could read as a value.
assert.ok(/^[a-z]+$/.test(UNKNOWN), 'UNKNOWN must be word-shaped');
assert.ok(!UNKNOWN.includes('-'), 'UNKNOWN must not be dash-shaped');

// --- direction 2: a measured 0 IS a reading and must render as one ---------
assert.equal(formatUSD(0), '$0.00');
assert.equal(formatTokens(0), '0');
assert.equal(formatDuration(0), '0ms');
assert.equal(formatPercent(0), '0.0%');

// --- ordinary readings pass through ---------------------------------------
assert.equal(formatUSD(12.5), '$12.50');
assert.equal(formatUSD(0.004), '<$0.01');
assert.equal(formatTokens(1500), '1.5K');
assert.equal(formatTokens(2_000_000), '2.00M');
assert.equal(formatDuration(1500), '1.5s');
assert.equal(formatDuration(90_000), '1m 30s');
assert.equal(formatPercent(99.95), '100.0%');

// --- formatMetric is the shared branch ------------------------------------
assert.equal(formatMetric(null), UNKNOWN);
assert.equal(formatMetric(0), '0');
assert.equal(formatMetric(0, (n) => n.toFixed(1)), '0.0');

console.log('loki-unified-styles formatters: all assertions passed');
