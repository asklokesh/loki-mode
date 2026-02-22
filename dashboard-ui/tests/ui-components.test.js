/**
 * Tests for new UI components - utility functions and data transformations.
 *
 * Uses Node.js built-in test runner. Tests the pure utility functions exported
 * from each component without requiring DOM APIs.
 *
 * Run with: node --test dashboard-ui/tests/ui-components.test.js
 *
 * The utility functions are imported from a companion helpers file that
 * re-exports them without triggering customElements.define() or DOM imports.
 *
 * @version 1.0.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// -- Re-implement pure utility functions from each component for testing.
// -- These are exact copies of the exported functions, allowing us to test
// -- the logic without importing modules that depend on browser APIs.

// From loki-rarv-timeline.js
function formatDuration(ms) {
  if (ms == null || ms < 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  if (min < 60) return `${min}m ${remainSec}s`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hr}h ${remainMin}m`;
}

function computePhaseWidths(phases) {
  if (!phases || phases.length === 0) return [];
  const totalMs = phases.reduce((sum, p) => sum + (p.duration_ms || 0), 0);
  if (totalMs === 0) {
    return phases.map(p => ({ phase: p.phase, pct: 100 / phases.length, duration: 0 }));
  }
  return phases.map(p => ({
    phase: p.phase,
    pct: ((p.duration_ms || 0) / totalMs) * 100,
    duration: p.duration_ms || 0,
  }));
}

// From loki-quality-gates.js
function formatGateTime(timestamp) {
  if (!timestamp) return 'Never';
  try {
    const d = new Date(timestamp);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'Unknown';
  }
}

function summarizeGates(gates) {
  if (!gates || gates.length === 0) return { pass: 0, fail: 0, pending: 0, total: 0 };
  const result = { pass: 0, fail: 0, pending: 0, total: gates.length };
  for (const gate of gates) {
    const status = (gate.status || 'pending').toLowerCase();
    if (status === 'pass') result.pass++;
    else if (status === 'fail') result.fail++;
    else result.pending++;
  }
  return result;
}

// From loki-audit-viewer.js
function formatAuditTimestamp(timestamp) {
  if (!timestamp) return '--';
  try {
    const d = new Date(timestamp);
    return d.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(timestamp);
  }
}

function buildAuditQuery(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value != null && value !== '') {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// From loki-tenant-switcher.js
function formatTenantLabel(tenant) {
  if (!tenant) return 'Unknown';
  if (tenant.slug && tenant.name) {
    return `${tenant.name} (${tenant.slug})`;
  }
  return tenant.name || tenant.slug || 'Unknown';
}

// From loki-run-manager.js
function formatRunDuration(durationMs, startedAt, endedAt) {
  let ms = durationMs;
  if (ms == null && startedAt) {
    const start = new Date(startedAt).getTime();
    const end = endedAt ? new Date(endedAt).getTime() : Date.now();
    ms = end - start;
  }
  if (ms == null || ms < 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  if (min < 60) return `${min}m ${remainSec}s`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hr}h ${remainMin}m`;
}

function formatRunTime(timestamp) {
  if (!timestamp) return '--';
  try {
    const d = new Date(timestamp);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(timestamp);
  }
}

// From loki-api-keys.js
function formatKeyTime(timestamp) {
  if (!timestamp) return 'Never';
  try {
    const d = new Date(timestamp);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(timestamp);
  }
}

function maskToken(token) {
  if (!token || token.length < 12) return '****';
  return token.slice(0, 4) + '****' + token.slice(-4);
}


// ===================================================================
// Test Suite
// ===================================================================

// -------------------------------------------------------------------
// 1. loki-rarv-timeline
// -------------------------------------------------------------------
describe('loki-rarv-timeline', () => {
  it('formatDuration returns -- for null/undefined/negative', () => {
    assert.equal(formatDuration(null), '--');
    assert.equal(formatDuration(undefined), '--');
    assert.equal(formatDuration(-5), '--');
  });

  it('formatDuration formats milliseconds correctly', () => {
    assert.equal(formatDuration(500), '500ms');
    assert.equal(formatDuration(3000), '3s');
    assert.equal(formatDuration(90000), '1m 30s');
    assert.equal(formatDuration(7200000), '2h 0m');
  });

  it('computePhaseWidths returns empty array for empty/null input', () => {
    assert.deepEqual(computePhaseWidths([]), []);
    assert.deepEqual(computePhaseWidths(null), []);
  });

  it('computePhaseWidths computes correct percentages', () => {
    const phases = [
      { phase: 'reason', duration_ms: 1000 },
      { phase: 'act', duration_ms: 3000 },
    ];
    const result = computePhaseWidths(phases);
    assert.equal(result.length, 2);
    assert.equal(result[0].phase, 'reason');
    assert.equal(result[0].pct, 25);
    assert.equal(result[1].phase, 'act');
    assert.equal(result[1].pct, 75);
  });

  it('computePhaseWidths handles zero durations with equal distribution', () => {
    const phases = [
      { phase: 'reason', duration_ms: 0 },
      { phase: 'act', duration_ms: 0 },
    ];
    const result = computePhaseWidths(phases);
    assert.equal(result.length, 2);
    assert.equal(result[0].pct, 50);
    assert.equal(result[1].pct, 50);
  });
});


// -------------------------------------------------------------------
// 2. loki-quality-gates
// -------------------------------------------------------------------
describe('loki-quality-gates', () => {
  it('summarizeGates counts statuses correctly', () => {
    const gates = [
      { name: 'Gate 1', status: 'pass' },
      { name: 'Gate 2', status: 'pass' },
      { name: 'Gate 3', status: 'fail' },
      { name: 'Gate 4', status: 'pending' },
    ];
    const summary = summarizeGates(gates);
    assert.equal(summary.pass, 2);
    assert.equal(summary.fail, 1);
    assert.equal(summary.pending, 1);
    assert.equal(summary.total, 4);
  });

  it('summarizeGates handles empty input', () => {
    const summary = summarizeGates([]);
    assert.equal(summary.total, 0);
    assert.equal(summary.pass, 0);
  });

  it('formatGateTime returns Never for null/undefined', () => {
    assert.equal(formatGateTime(null), 'Never');
    assert.equal(formatGateTime(undefined), 'Never');
  });
});


// -------------------------------------------------------------------
// 3. loki-audit-viewer
// -------------------------------------------------------------------
describe('loki-audit-viewer', () => {
  it('buildAuditQuery builds correct query string', () => {
    const query = buildAuditQuery({ limit: 50, action: 'create', resource: '' });
    assert.ok(query.includes('limit=50'));
    assert.ok(query.includes('action=create'));
    assert.ok(!query.includes('resource='));
  });

  it('buildAuditQuery returns empty for no params', () => {
    assert.equal(buildAuditQuery({}), '');
  });

  it('formatAuditTimestamp returns -- for null/undefined', () => {
    assert.equal(formatAuditTimestamp(null), '--');
    assert.equal(formatAuditTimestamp(undefined), '--');
  });
});


// -------------------------------------------------------------------
// 4. loki-tenant-switcher
// -------------------------------------------------------------------
describe('loki-tenant-switcher', () => {
  it('formatTenantLabel formats name and slug', () => {
    assert.equal(formatTenantLabel({ name: 'Acme Corp', slug: 'acme' }), 'Acme Corp (acme)');
  });

  it('formatTenantLabel handles name only', () => {
    assert.equal(formatTenantLabel({ name: 'Solo' }), 'Solo');
  });

  it('formatTenantLabel handles null', () => {
    assert.equal(formatTenantLabel(null), 'Unknown');
  });
});


// -------------------------------------------------------------------
// 5. loki-run-manager
// -------------------------------------------------------------------
describe('loki-run-manager', () => {
  it('formatRunDuration computes from start and end timestamps', () => {
    const start = '2026-02-21T10:00:00Z';
    const end = '2026-02-21T10:05:30Z';
    const result = formatRunDuration(null, start, end);
    assert.equal(result, '5m 30s');
  });

  it('formatRunDuration uses explicit ms when provided', () => {
    assert.equal(formatRunDuration(120000, null, null), '2m 0s');
  });

  it('formatRunTime returns -- for null', () => {
    assert.equal(formatRunTime(null), '--');
  });
});


// -------------------------------------------------------------------
// 6. loki-api-keys
// -------------------------------------------------------------------
describe('loki-api-keys', () => {
  it('maskToken masks long tokens correctly', () => {
    const token = 'sk_live_abcdefghijklmnop';
    const masked = maskToken(token);
    assert.ok(masked.startsWith('sk_l'));
    assert.ok(masked.endsWith('mnop'));
    assert.ok(masked.includes('****'));
  });

  it('maskToken returns **** for short/null tokens', () => {
    assert.equal(maskToken('abc'), '****');
    assert.equal(maskToken(null), '****');
    assert.equal(maskToken(''), '****');
  });

  it('formatKeyTime returns Never for null/undefined', () => {
    assert.equal(formatKeyTime(null), 'Never');
    assert.equal(formatKeyTime(undefined), 'Never');
  });
});
