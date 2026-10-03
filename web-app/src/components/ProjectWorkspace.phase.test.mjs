// S-230: buildPhase returned 'idle' whenever the session was not building, so
// the 'complete' branch (and the Replay Build button gated on it) was
// unreachable, and any unrecognized phase string was labelled 'building'.
// The pure deriveBuildPhase() helper is extracted and executed; the wiring is
// checked on the source.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./ProjectWorkspace.tsx', import.meta.url), 'utf8');

const HELPER_SIG = 'function deriveBuildPhase(isBuilding: boolean, rawStatus: string): string {';

function loadHelper() {
  const start = src.indexOf(HELPER_SIG);
  assert.ok(start >= 0, 'deriveBuildPhase helper not found');
  const end = src.indexOf('\n}\n', start);
  const js = src.slice(start, end + 3).replace(HELPER_SIG, 'function deriveBuildPhase(isBuilding, rawStatus) {');
  return new Function(`${js}; return deriveBuildPhase;`)();
}

test('a completed session that is no longer building is complete (Replay Build reachable)', () => {
  const f = loadHelper();
  assert.equal(f(false, 'completed'), 'complete');
  assert.equal(f(false, 'fulfilled'), 'complete');
});

test('a non-building session with no completion is idle', () => {
  const f = loadHelper();
  assert.equal(f(false, 'stopped'), 'idle');
  assert.equal(f(false, ''), 'idle');
});

test('an unrecognized phase is not labelled building', () => {
  const f = loadHelper();
  assert.notEqual(f(true, 'frobnicating'), 'building');
});

test('known running phases still map', () => {
  const f = loadHelper();
  assert.equal(f(true, 'planning'), 'planning');
  assert.equal(f(true, 'council review'), 'reviewing');
  assert.equal(f(true, 'verify'), 'testing');
  assert.equal(f(true, 'building'), 'building');
  assert.equal(f(true, 'running'), 'building');
  assert.equal(f(true, ''), 'building');
});

test('buildPhase memo delegates to the helper', () => {
  assert.match(src, /const buildPhase = useMemo\(\s*\(\) => deriveBuildPhase\(isBuilding,/);
});
