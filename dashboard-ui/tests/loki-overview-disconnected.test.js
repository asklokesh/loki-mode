/**
 * A disconnected Overview must show ONE honest line, not a wall of nulls.
 *
 * THE DEFECT, from a real user screenshot: with the API unreachable the page
 * still painted fourteen stat cards reading "--", "0", "Not run",
 * "Not started", "Not evaluated", plus a RARV timeline and a Start Build form.
 * None of those values were measured -- they are the `|| '--'` fallbacks in
 * render(). A wall of nulls is indistinguishable from a real build that has
 * produced nothing, so the page asserted state it could not know.
 *
 * WHAT IS LOAD-BEARING: the assertion is the ABSENCE of stat cards, not the
 * presence of the message. A version that printed the honest line ABOVE the
 * same fourteen cards would satisfy a message-only check while leaving the
 * defect exactly as the user saw it.
 *
 * Run: node --test dashboard-ui/tests/loki-overview-disconnected.test.js
 */
// ESM, because dashboard-ui/package.json declares "type": "module".
// A require() here throws ReferenceError before a single assertion runs, which
// reports as one file-level failure and hides every real check below it.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'components', 'loki-overview.js');
const src = fs.readFileSync(SRC, 'utf8');

// Vacuity guard: every assertion below reads this file. An empty or truncated
// read would satisfy the negative checks while measuring nothing.
test('the component source was actually loaded', () => {
  assert.ok(src.length > 2000, `source too small to be real: ${src.length} bytes`);
  assert.ok(src.includes('class LokiOverview'), 'not the overview component');
});

test('a disconnected renderer exists', () => {
  assert.ok(
    src.includes('_renderDisconnected'),
    'no _renderDisconnected: a dead API still renders the full cockpit'
  );
});

test('the grid is gated on connection state, not rendered unconditionally', () => {
  // The gate must READ the connection flag in the render template. An
  // assignment without a read is a gate that guards nothing -- the same
  // mistake that left _data.connected tracked but unused before this fix.
  assert.match(
    src,
    /\$\{\s*!this\._data\.connected\s*\?\s*this\._renderDisconnected\(\)/,
    'the overview-grid is not gated on !this._data.connected'
  );
});

test('the honest line names the real remedy', () => {
  // A message that says "disconnected" and nothing else leaves the user stuck.
  assert.ok(
    src.includes('loki dashboard start'),
    'the disconnected state does not tell the user how to fix it'
  );
});

test('the disconnected branch emits NO stat cards', () => {
  // Extract the _renderDisconnected body and prove it contains none of the
  // card markup. This is the assertion that would fail on a version printing
  // the message above the same fourteen cards.
  const i = src.indexOf('_renderDisconnected() {');
  assert.ok(i > -1, '_renderDisconnected not found');
  const body = src.slice(i, src.indexOf('_renderJourney() {', i));
  assert.ok(body.length > 0, 'could not isolate the disconnected body');
  for (const marker of ['overview-card', 'card-value', 'overview-grid']) {
    assert.ok(
      !body.includes(marker),
      `the disconnected state still emits "${marker}" markup`
    );
  }
});

test('the connected path still renders every card (no regression)', () => {
  // Assert each required card INDIVIDUALLY, never a count: a threshold cannot
  // say WHICH card vanished and picks up slack it was never meant to have.
  for (const label of ['Session', 'Phase', 'Iteration', 'Provider',
                       'Agents running', 'Tasks', 'Uptime', 'Complexity']) {
    assert.ok(
      src.includes(`<div class="card-label">${label}</div>`),
      `the connected path lost the "${label}" card`
    );
  }
  for (const delegated of ['_renderChecklistCard', '_renderAppRunnerCard',
                           '_renderPlaywrightCard', '_renderCouncilGateCard']) {
    assert.ok(src.includes(`${delegated}()`), `lost the ${delegated} card`);
  }
});

test('the journey line is preserved inside the connected branch', () => {
  // _renderJourney already says one honest sentence when evidence is
  // unavailable. The gate must not swallow it.
  assert.ok(src.includes('this._renderJourney()'), 'the journey line was dropped');
});
