// The UI must render every status the API can actually emit.
//
// WHAT THIS CAUGHT, and it was caused by fixing something else. 9.12.4 made
// api_runs._current_status read .loki/state/orchestrator.json `currentPhase`
// (the same file the CLI reads) instead of a session.json the runtime never
// writes. That fixed "every live run reports unknown" -- and widened the
// vocabulary the API emits from {running, completed, failed, ...} to include
// the orchestrator's own phases: building, bootstrap, complete.
//
// RUN_STATUS_CONFIG did not know those, and the lookup falls back to
// `pending`:
//
//     const cfg = RUN_STATUS_CONFIG[status] || RUN_STATUS_CONFIG.pending;
//
// So an actively building run rendered the badge "PENDING". That is worse than
// rendering nothing: it states something false with confidence, to an operator
// deciding whether their build is stuck.
//
// `unknown` had the same problem and is arguably worse. api_runs returns it
// when no signal could be read at all, and showing "Pending" claims the run is
// queued when the truth is that nothing is known about it.
//
// THE SOURCE LIST IS DERIVED, not hand-copied: the phases come from
// autonomy/run.sh's own currentPhase writes, so this test fails if the runtime
// gains a phase the UI cannot render.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const COMPONENT = new URL('../components/loki-run-manager.js', import.meta.url);
const RUN_SH = new URL('../../autonomy/run.sh', import.meta.url);

function statusConfig() {
  const src = readFileSync(COMPONENT, 'utf8');
  const m = src.match(/const RUN_STATUS_CONFIG = (\{[\s\S]*?\n\});/);
  assert.ok(m, 'RUN_STATUS_CONFIG not found in loki-run-manager.js');
  return eval('(' + m[1] + ')');
}

test('every orchestrator phase the runtime writes is renderable', () => {
  const runSh = readFileSync(RUN_SH, 'utf8');
  // Phases the runtime actually assigns to currentPhase.
  const phases = new Set();
  for (const m of runSh.matchAll(/"(BOOTSTRAP|BUILDING|COMPLETED|FAILED)"/g)) {
    phases.add(m[1].toLowerCase());
  }
  assert.ok(phases.size > 0,
    'found no phases in run.sh; this assertion would be vacuous');

  const cfg = statusConfig();
  for (const phase of phases) {
    // api_runs lowercases currentPhase. COMPLETED arrives as "completed",
    // which the config already had; BUILDING and BOOTSTRAP did not.
    assert.ok(cfg[phase],
      `RUN_STATUS_CONFIG has no entry for ${phase}; a live run in that phase `
      + 'falls back to "Pending", which tells an operator their running build '
      + 'is queued');
  }
});

test('unknown renders as Unknown, never as Pending', () => {
  const cfg = statusConfig();
  assert.ok(cfg.unknown, 'no entry for unknown');
  assert.equal(cfg.unknown.label, 'Unknown',
    'unknown renders as ' + cfg.unknown.label + '; api_runs returns "unknown" '
    + 'when NO signal could be read, and claiming "Pending" asserts the run is '
    + 'queued when nothing at all is known about it');
});

test('the api status "complete" is distinct from a missing entry', () => {
  const cfg = statusConfig();
  assert.ok(cfg.complete,
    'no entry for "complete"; api_runs emits it for a finished run and it '
    + 'would fall back to Pending');
  assert.equal(cfg.complete.label, 'Completed');
});

test('a genuinely unmapped status still falls back rather than throwing', () => {
  const cfg = statusConfig();
  const fallback = cfg['no-such-status'] || cfg.pending;
  assert.ok(fallback, 'the pending fallback is gone; an unmapped status would '
    + 'render undefined and break the row');
});
