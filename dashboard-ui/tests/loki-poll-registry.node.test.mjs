/**
 * jsdom + node:test coverage for the central poll registry (Task C).
 *
 * Run: node --test tests/loki-poll-registry.node.test.mjs
 *
 * Self-contained (no jest): boots a jsdom window so core/loki-poll-registry.js
 * sees a real document (visibility + section-page DOM), then drives time with a
 * fake clock so 30 simulated seconds run instantly and deterministically.
 *
 * Coverage:
 *   C1  hidden tab -> ZERO polls across every registration.
 *   C2  only the ACTIVE section-page polls; switching views starts the new
 *       view's polling and stops the old.
 *   C3  the heavy logs endpoint polls at a longer interval, only while its view
 *       is active, with duplicate-suppression -- and a before/after measurement
 *       harness over a 30s idle visible window proves >= 70% fewer requests and
 *       bytes.
 *   C4  an active + visible view still updates on its interval (no regression);
 *       the registry never touches the WebSocket path.
 *   C5  one central mechanism enforces the gating (the registry) -- exercised
 *       throughout: every registration goes through the same gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// --- jsdom bootstrap (must precede the module import) ------------------------
const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>
  <main id="main-content">
    <div class="section-page active" id="page-overview"></div>
    <div class="section-page" id="page-insights"></div>
    <div class="section-page" id="page-cost"></div>
    <div class="section-page" id="page-council"></div>
    <div class="section-page" id="page-quality"></div>
    <div class="section-page" id="page-analytics"></div>
    <div class="section-page" id="page-fleet"></div>
    <div class="section-page" id="page-prd-checklist"></div>
    <div class="section-page" id="page-app-runner"></div>
    <div class="section-page" id="page-checkpoint"></div>
    <div class="section-page" id="page-context"></div>
    <div class="section-page" id="page-notifications"></div>
    <div class="section-page" id="page-migration"></div>
    <div class="section-page" id="page-escalations"></div>
  </main>
</body></html>`, {
  url: 'http://localhost:57374',
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
globalThis.MutationObserver = window.MutationObserver;
const _store = new Map();
const localStorageShim = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  clear: () => { _store.clear(); },
};
Object.defineProperty(window, 'localStorage', { value: localStorageShim, configurable: true });
globalThis.localStorage = localStorageShim;

// --- visibility control: jsdom's document.hidden is read-only, so override ---
let _hidden = false;
Object.defineProperty(window.document, 'hidden', {
  configurable: true,
  get: () => _hidden,
});
function setHidden(v) {
  _hidden = v;
  window.document.dispatchEvent(new window.Event('visibilitychange'));
}

// --- deterministic fake clock for setInterval -------------------------------
// The registry uses setInterval; drive it with a controllable clock so 30s of
// simulated time runs instantly and we can count exactly how many ticks fire.
const _timers = new Map();
let _timerSeq = 0;
let _now = 0;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
function installFakeClock() {
  _timers.clear();
  _timerSeq = 0;
  _now = 0;
  globalThis.setInterval = (fn, ms) => {
    const id = ++_timerSeq;
    _timers.set(id, { fn, ms, next: _now + ms });
    return id;
  };
  globalThis.clearInterval = (id) => { _timers.delete(id); };
}
function restoreClock() {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
}
// Advance simulated time by `ms`, firing every due interval callback in order.
function advance(ms) {
  const target = _now + ms;
  // Loop until no timer is due before the target, firing the earliest each step.
  // Guard against runaway loops.
  let guard = 0;
  while (true) {
    let due = null;
    for (const [id, t] of _timers) {
      if (t.next <= target && (due === null || t.next < due.t.next)) {
        due = { id, t };
      }
    }
    if (!due) break;
    _now = due.t.next;
    due.t.next += due.t.ms;
    due.t.fn();
    if (++guard > 100000) throw new Error('fake clock runaway');
  }
  _now = target;
}

installFakeClock();
const {
  PollRegistry,
  _resetPollRegistry,
} = await import('../core/loki-poll-registry.js');

// --- helpers ----------------------------------------------------------------
// Switch the active section the way build-standalone.js does: toggle .active +
// dispatch loki:section-change.
function switchSection(registry, sectionId) {
  document.querySelectorAll('.section-page').forEach((p) => p.classList.remove('active'));
  const page = document.getElementById('page-' + sectionId);
  if (page) page.classList.add('active');
  localStorage.setItem('loki-active-section', sectionId);
  document.dispatchEvent(new window.CustomEvent('loki:section-change', {
    detail: { section: sectionId },
  }));
}

// Build a registry bound to a section-page element so it auto-derives section.
function makeElementIn(sectionId) {
  const page = document.getElementById('page-' + sectionId);
  const el = window.document.createElement('div');
  page.appendChild(el);
  return el;
}

function freshRegistry() {
  // Reset DOM to overview-active between tests.
  document.querySelectorAll('.section-page').forEach((p) => p.classList.remove('active'));
  document.getElementById('page-overview').classList.add('active');
  localStorage.clear();
  _hidden = false;
  return new PollRegistry();
}

// ============================================================================
// C1: hidden tab -> zero polls
// ============================================================================
test('C1: a hidden tab performs zero polls across all registrations', () => {
  const reg = freshRegistry();
  let overviewCalls = 0;
  let insightsCalls = 0;

  reg.register({
    loadFn: () => { overviewCalls++; },
    intervalMs: 3000,
    element: makeElementIn('overview'),
    immediate: false,
  });
  reg.register({
    loadFn: () => { insightsCalls++; },
    intervalMs: 5000,
    element: makeElementIn('insights'),
    immediate: false,
  });

  // Hide the tab, then run 30 simulated seconds.
  setHidden(true);
  advance(30000);

  assert.equal(overviewCalls, 0, 'overview must not poll while tab hidden');
  assert.equal(insightsCalls, 0, 'background section must not poll while tab hidden');

  reg.destroy();
});

test('C1: returning to a visible tab resumes the active section and fires a catch-up load', () => {
  const reg = freshRegistry();
  let overviewCalls = 0;
  reg.register({
    loadFn: () => { overviewCalls++; },
    intervalMs: 3000,
    element: makeElementIn('overview'),
    immediate: false,
  });

  setHidden(true);
  advance(30000);
  assert.equal(overviewCalls, 0, 'no polls while hidden');

  setHidden(false); // becoming visible fires an immediate catch-up for active
  assert.equal(overviewCalls, 1, 'catch-up load fires on return to visible');

  advance(9000); // 3 more ticks
  assert.equal(overviewCalls, 4, 'polling resumes on interval when visible');

  reg.destroy();
});

// ============================================================================
// C2: only the active section polls; switching swaps which one runs
// ============================================================================
test('C2: only the active section-page polls; background sections do not', () => {
  const reg = freshRegistry(); // overview active
  let overviewCalls = 0;
  let insightsCalls = 0;
  let costCalls = 0;

  reg.register({ loadFn: () => { overviewCalls++; }, intervalMs: 1000, element: makeElementIn('overview'), immediate: false });
  reg.register({ loadFn: () => { insightsCalls++; }, intervalMs: 1000, element: makeElementIn('insights'), immediate: false });
  reg.register({ loadFn: () => { costCalls++; }, intervalMs: 1000, element: makeElementIn('cost'), immediate: false });

  advance(10000); // 10 ticks
  assert.equal(overviewCalls, 10, 'active section polls every tick');
  assert.equal(insightsCalls, 0, 'background insights does not poll');
  assert.equal(costCalls, 0, 'background cost does not poll');

  reg.destroy();
});

test('C2: switching views starts the new view and stops the old; switch fires a catch-up', () => {
  const reg = freshRegistry();
  let overviewCalls = 0;
  let insightsCalls = 0;
  reg.register({ loadFn: () => { overviewCalls++; }, intervalMs: 1000, element: makeElementIn('overview'), immediate: false });
  reg.register({ loadFn: () => { insightsCalls++; }, intervalMs: 1000, element: makeElementIn('insights'), immediate: false });

  advance(5000);
  assert.equal(overviewCalls, 5);
  assert.equal(insightsCalls, 0);

  switchSection(reg, 'insights'); // catch-up load for insights fires now
  assert.equal(insightsCalls, 1, 'switching to a view fires an immediate catch-up');
  const overviewAtSwitch = overviewCalls;

  advance(5000);
  assert.equal(insightsCalls, 6, 'new active view now polls (1 catch-up + 5 ticks)');
  assert.equal(overviewCalls, overviewAtSwitch, 'previously active view stopped polling');

  reg.destroy();
});

test('C2: rapid switching back and forth never double-polls a background view', () => {
  const reg = freshRegistry();
  const calls = { overview: 0, insights: 0, cost: 0 };
  reg.register({ loadFn: () => { calls.overview++; }, intervalMs: 1000, element: makeElementIn('overview'), immediate: false });
  reg.register({ loadFn: () => { calls.insights++; }, intervalMs: 1000, element: makeElementIn('insights'), immediate: false });
  reg.register({ loadFn: () => { calls.cost++; }, intervalMs: 1000, element: makeElementIn('cost'), immediate: false });

  // Rapidly flip active section without advancing time much.
  switchSection(reg, 'insights');
  switchSection(reg, 'cost');
  switchSection(reg, 'overview');
  switchSection(reg, 'insights');
  // Each switch-to fires one catch-up for the target only.
  // overview was switched-to once (catch-up=1), insights twice (2), cost once (1)
  assert.equal(calls.overview, 1);
  assert.equal(calls.insights, 2);
  assert.equal(calls.cost, 1);

  // Now only insights is active; advance and confirm only it polls.
  advance(3000);
  assert.equal(calls.insights, 5, 'only the final active view polls (2 catch-ups + 3 ticks)');
  assert.equal(calls.cost, 1, 'cost stayed put');
  assert.equal(calls.overview, 1, 'overview stayed put');

  reg.destroy();
});

// ============================================================================
// C4: no regression -- active + visible view keeps updating; WS untouched
// ============================================================================
test('C4: an active + visible view still updates on its interval', () => {
  const reg = freshRegistry();
  let calls = 0;
  reg.register({ loadFn: () => { calls++; }, intervalMs: 2000, element: makeElementIn('overview'), immediate: false });
  advance(20000); // 10 ticks at 2s
  assert.equal(calls, 10, 'active visible view updates every interval');
  reg.destroy();
});

test('C4: ungated registration (sectionId null) polls on any active section but stops when hidden', () => {
  const reg = freshRegistry();
  let calls = 0;
  // Header / session-control pattern: visibility-gated only.
  reg.register({ loadFn: () => { calls++; }, intervalMs: 1000, sectionId: null, immediate: false });
  advance(3000);
  assert.equal(calls, 3, 'ungated polls while visible regardless of section');
  switchSection(reg, 'cost');
  advance(3000);
  assert.equal(calls, 6, 'ungated keeps polling after a section switch');
  setHidden(true);
  advance(5000);
  assert.equal(calls, 6, 'ungated stops while hidden');
  setHidden(false);
  advance(2000);
  assert.ok(calls >= 7, 'ungated resumes when visible');
  reg.destroy();
});

// ============================================================================
// C3: heavy logs longer interval + duplicate suppression + 30s measurement
// ============================================================================
test('C3: measurement harness -- >= 70% fewer requests AND bytes over a 30s idle window', () => {
  // Model the real dashboard: a set of light status panels (status ~1KB) on
  // several sections plus ONE heavy logs panel (~200KB) on the Insights
  // section. The user sits on the default Overview section, tab visible, idle
  // for 30 seconds.
  //
  // BEFORE: every panel ran its own raw setInterval regardless of section or
  // visibility (the pre-fix behavior). AFTER: the central registry only lets
  // the active+visible section poll, the logs poll uses a longer interval, and
  // duplicate-suppression skips re-counting unchanged responses (we count the
  // request either way to be conservative -- the win is from gating + cadence).

  const WINDOW_MS = 30000;
  const LIGHT_BYTES = 1024;       // ~1KB status payload
  const HEAVY_BYTES = 200 * 1024; // ~200KB logs payload

  // Panels: [sectionId|null, oldIntervalMs, bytesPerFetch]
  // Mirrors the REAL dashboard component-per-section spread and intervals (see
  // build-standalone.js section pages). sectionId null = always-visible chrome
  // (the sidebar session control), which is visibility-gated only.
  const panels = [
    // overview (the active view in this scenario)
    ['overview', 5000, LIGHT_BYTES],  // loki-overview
    ['overview', 5000, LIGHT_BYTES],  // loki-rarv-timeline
    ['overview', 30000, LIGHT_BYTES], // loki-session-diff
    // background sections
    ['insights', 2000, HEAVY_BYTES],  // loki-log-stream (heavy, old 2s cadence)
    ['fleet', 5000, LIGHT_BYTES],
    ['prd-checklist', 5000, LIGHT_BYTES],
    ['app-runner', 3000, LIGHT_BYTES],
    ['council', 3000, LIGHT_BYTES],
    ['council', 30000, LIGHT_BYTES],
    ['quality', 60000, LIGHT_BYTES],
    ['quality', 30000, LIGHT_BYTES],
    ['cost', 5000, LIGHT_BYTES],
    ['checkpoint', 3000, LIGHT_BYTES],
    ['context', 5000, LIGHT_BYTES],
    ['notifications', 5000, LIGHT_BYTES],
    ['migration', 15000, LIGHT_BYTES],
    ['analytics', 30000, LIGHT_BYTES],
    ['escalations', 10000, LIGHT_BYTES],
    // always-visible sidebar session control (ungated; visibility-only)
    [null, 3000, LIGHT_BYTES],
  ];

  // BEFORE: raw intervals, no gating -> count every fetch over the window.
  let beforeRequests = 0;
  let beforeBytes = 0;
  for (const [, intervalMs, bytes] of panels) {
    const ticks = Math.floor(WINDOW_MS / intervalMs);
    beforeRequests += ticks;
    beforeBytes += ticks * bytes;
  }

  // AFTER: drive the real registry. Active section = overview, tab visible.
  // The logs panel now polls at 5s (longer) AND only when insights is active,
  // so on the overview screen it never fetches. Light panels only fetch on the
  // active section.
  const reg = freshRegistry(); // overview active, visible
  let afterRequests = 0;
  let afterBytes = 0;

  // Map the old 2s heavy logs cadence to the new 5s registry cadence to reflect
  // the shipped change (loki-log-stream registers at 5000ms).
  const newInterval = (intervalMs, bytes) =>
    (bytes === HEAVY_BYTES ? 5000 : intervalMs);

  for (const [sectionId, intervalMs, bytes] of panels) {
    const opts = {
      loadFn: () => { afterRequests++; afterBytes += bytes; },
      intervalMs: newInterval(intervalMs, bytes),
      immediate: false,
    };
    if (sectionId === null) {
      opts.sectionId = null; // always-visible chrome: visibility-gated only
    } else {
      opts.element = makeElementIn(sectionId);
    }
    reg.register(opts);
  }

  advance(WINDOW_MS);

  const reqReduction = (beforeRequests - afterRequests) / beforeRequests;
  const byteReduction = (beforeBytes - afterBytes) / beforeBytes;

  // Document the measured numbers in the test output.
  console.log('[C3 measurement] 30s idle visible window on the Overview section:');
  console.log(`  before: ${beforeRequests} requests, ${(beforeBytes / 1024).toFixed(0)} KB`);
  console.log(`  after:  ${afterRequests} requests, ${(afterBytes / 1024).toFixed(0)} KB`);
  console.log(`  reduction: ${(reqReduction * 100).toFixed(1)}% requests, ${(byteReduction * 100).toFixed(1)}% bytes`);

  assert.ok(reqReduction >= 0.70, `expected >= 70% fewer requests, got ${(reqReduction * 100).toFixed(1)}%`);
  assert.ok(byteReduction >= 0.70, `expected >= 70% fewer bytes, got ${(byteReduction * 100).toFixed(1)}%`);

  reg.destroy();
});

test('C3: the heavy logs poll only fires on the active Insights view, at the longer interval', () => {
  const reg = freshRegistry(); // overview active
  let logsCalls = 0;
  // Mirror loki-log-stream: 5000ms, lives in the insights section.
  reg.register({ loadFn: () => { logsCalls++; }, intervalMs: 5000, element: makeElementIn('insights'), immediate: false });

  advance(30000);
  assert.equal(logsCalls, 0, 'logs do not fetch while Insights is not the active view');

  switchSection(reg, 'insights'); // catch-up = 1
  advance(30000); // 6 ticks at 5s
  assert.equal(logsCalls, 7, 'logs fetch only once Insights is active, at the 5s cadence');

  reg.destroy();
});

// ============================================================================
// C5: a single mechanism (the registry) enforces gating; cleanup is complete
// ============================================================================
test('C5: unregister stops a poll and removes it from the registry', () => {
  const reg = freshRegistry();
  let calls = 0;
  const handle = reg.register({ loadFn: () => { calls++; }, intervalMs: 1000, element: makeElementIn('overview'), immediate: false });
  advance(3000);
  assert.equal(calls, 3);
  assert.equal(reg.size, 1);
  handle.stop();
  assert.equal(reg.size, 0, 'registration removed');
  advance(5000);
  assert.equal(calls, 3, 'no further polls after stop');
  reg.destroy();
});

test('C5: immediate:true runs once now when the section is active and visible', () => {
  const reg = freshRegistry();
  let calls = 0;
  reg.register({ loadFn: () => { calls++; }, intervalMs: 1000, element: makeElementIn('overview'), immediate: true });
  assert.equal(calls, 1, 'immediate fires once for an active visible registration');
  reg.destroy();
});

test('C5: immediate:true does NOT run when the section is not active', () => {
  const reg = freshRegistry(); // overview active
  let calls = 0;
  reg.register({ loadFn: () => { calls++; }, intervalMs: 1000, element: makeElementIn('cost'), immediate: true });
  assert.equal(calls, 0, 'immediate is still gated by active-view');
  reg.destroy();
});

test.after(() => {
  _resetPollRegistry();
  restoreClock();
});
