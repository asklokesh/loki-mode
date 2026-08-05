/**
 * node:test coverage for core/loki-freshness.js and its one wired consumer.
 *
 * Run: npm install && node --test tests/loki-freshness.node.test.mjs
 *
 * Proves the three properties the utility exists for:
 *   1. fresh data is NOT marked stale, old data IS.
 *   2. server-supplied freshness_s takes precedence over client receive time.
 *   3. unmeasured age renders UNKNOWN, never 0.
 *
 * Plus an end-to-end reachability check: <loki-run-manager> is booted against
 * a stubbed API in jsdom and its rendered header is read back, so this fails
 * if the utility is ever orphaned from the surface that calls it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Hard import, matching tests/loki-poll-registry.node.test.mjs. This was
// briefly an optional import that SKIPPED when jsdom was absent, and that is
// the wrong trade here: the reachability assertion below is the only thing
// standing between this utility and the orphaned-code defect it was written to
// avoid, and a skip reports green while measuring nothing. Requiring the
// devDependency makes a missing one loud. Run `npm install` in dashboard-ui/.
import { JSDOM } from 'jsdom';

import {
  dataFreshness,
  freshnessLabel,
  freshnessText,
  serverFreshnessS,
  freshestRowS,
  DEFAULT_STALE_AFTER_S,
} from '../core/loki-freshness.js';

const NOW = 1_700_000_000_000;

test('fresh data is not stale, old data is', () => {
  const fresh = dataFreshness({ payload: { freshness_s: 5 } });
  assert.equal(fresh.known, true);
  assert.equal(fresh.ageS, 5);
  assert.equal(fresh.isStale, false);

  const old = dataFreshness({ payload: { freshness_s: DEFAULT_STALE_AFTER_S + 1 } });
  assert.equal(old.isStale, true);
  assert.match(freshnessText(old), /STALE/);

  // Boundary: at the threshold is stale, one second under is not.
  assert.equal(dataFreshness({ payload: { freshness_s: DEFAULT_STALE_AFTER_S } }).isStale, true);
  assert.equal(dataFreshness({ payload: { freshness_s: DEFAULT_STALE_AFTER_S - 1 } }).isStale, false);
});

test('server freshness_s beats client receive time', () => {
  // The response landed one second ago, but the FILE it was read from is
  // forty minutes old. The server's number is the one that must win: a
  // prompt delivery of stale facts is still stale.
  const f = dataFreshness({
    payload: { runs: [], freshness_s: 2400 },
    receivedAtMs: NOW - 1000,
    nowMs: NOW,
  });
  assert.equal(f.source, 'server');
  assert.equal(f.ageS, 2400);
  assert.equal(f.isStale, true);

  // Without a server number, receive time is used and is LABELLED as such.
  const c = dataFreshness({ payload: { runs: [] }, receivedAtMs: NOW - 4000, nowMs: NOW });
  assert.equal(c.source, 'client');
  assert.equal(c.ageS, 4);
  assert.match(freshnessText(c), /receive time/);

  // freshness_s === 0 is a real measurement and must not fall through to the
  // client clock just because 0 is falsy.
  const zero = dataFreshness({ payload: { freshness_s: 0 }, receivedAtMs: NOW - 999999, nowMs: NOW });
  assert.equal(zero.source, 'server');
  assert.equal(zero.ageS, 0);
});

test('unmeasured age is UNKNOWN, never zero', () => {
  const none = dataFreshness({});
  assert.equal(none.known, false);
  assert.equal(none.ageS, null);
  assert.equal(none.source, 'none');
  // Not false: "I cannot tell" is not "it is fine".
  assert.equal(none.isStale, null);
  assert.equal(freshnessLabel(none), 'unknown');
  assert.equal(freshnessText(none), 'Data age unknown');

  // The readers emit freshness_s: null deliberately when they could not
  // measure a file. That must stay unmeasured, not become 0.
  assert.equal(serverFreshnessS({ freshness_s: null }), null);
  assert.equal(serverFreshnessS({ freshness_s: -3 }), null);
  assert.equal(serverFreshnessS({ freshness_s: 'old' }), null);
  assert.equal(dataFreshness({ payload: { freshness_s: null } }).known, false);

  // A backwards client clock reports 0, not a negative age that would compare
  // as fresh forever.
  assert.equal(dataFreshness({ receivedAtMs: NOW + 60000, nowMs: NOW }).ageS, 0);
});

test('freshest row wins, regardless of sort order', () => {
  // api_runs.list_runs sorts by started_at descending, which orders runs by
  // when they BEGAN, not by which was written to most recently. Reading row[0]
  // would report 3600 here and over-state staleness on a table whose second
  // run is live.
  const rows = [
    { id: 'old-long-running', freshness_s: 3600 },
    { id: 'recent', freshness_s: 12 },
  ];
  assert.equal(freshestRowS(rows), 12);
  // Order-independent.
  assert.equal(freshestRowS([...rows].reverse()), 12);
  // Rows without a usable value are skipped, not counted as 0.
  assert.equal(freshestRowS([{ id: 'a' }, { freshness_s: null }, { freshness_s: 45 }]), 45);
  assert.equal(freshestRowS([{ id: 'a' }, { id: 'b' }]), null);
  assert.equal(freshestRowS([]), null);
  assert.equal(freshestRowS(null), null);
});

test('labels bucket by magnitude', () => {
  assert.equal(freshnessLabel({ known: true, ageS: 12 }), '12s ago');
  assert.equal(freshnessLabel({ known: true, ageS: 240 }), '4m ago');
  assert.equal(freshnessLabel({ known: true, ageS: 7200 }), '2h ago');
  assert.equal(freshnessLabel({ known: true, ageS: 172800 }), '2d ago');
});

// --- end-to-end: the utility is actually reachable from a rendered surface --

test('loki-run-manager renders the age and the stale marker', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><main id="main-content">' +
    '<div class="section-page active" id="page-runs"></div></main></body></html>',
    { url: 'http://localhost:57374/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.customElements = dom.window.customElements;
  global.CustomEvent = dom.window.CustomEvent;
  global.MutationObserver = dom.window.MutationObserver;
  global.localStorage = dom.window.localStorage;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  // jsdom ships no matchMedia; the theme manager probes it on construction.
  global.matchMedia = dom.window.matchMedia
    || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  dom.window.matchMedia = global.matchMedia;
  global.fetch = async () => { throw new Error('no network in this test'); };

  // Importing the module registers the custom element; createElement is the
  // path the real page takes (LokiElement attaches its own shadow root).
  await import('../components/loki-run-manager.js');

  const el = dom.window.document.createElement('loki-run-manager');
  // Stub the API so nothing touches the network; the shape mirrors the
  // filesystem fallback in dashboard/api_v2.list_runs, where each row carries
  // freshness_s from dashboard/api_runs._row.
  // A RUNNING run: the stale marker is scoped to one, because an idle
  // workspace whose last run finished days ago is not an alert condition.
  let rows = [{ id: 1, status: 'running', freshness_s: 30 }];
  el._api = { _get: async () => rows, _post: async () => ({}) };

  const read = () => el.shadowRoot.getElementById('freshness');

  // Before any load: UNKNOWN, and specifically not "0s ago".
  el.render();
  assert.equal(read().dataset.source, 'none');
  assert.equal(read().dataset.stale, 'unknown');
  assert.equal(read().textContent, 'Data age unknown');

  // Fresh server-side age: rendered, not marked stale.
  await el._loadData();
  assert.equal(read().dataset.source, 'server');
  assert.equal(read().dataset.stale, 'false');
  assert.equal(read().textContent, 'Updated 30s ago');

  // A run that still claims RUNNING while its files have not moved in an hour
  // is the actionable case: something says it is working and is not writing.
  rows = [{ id: 1, status: 'running', freshness_s: 3600 }];
  await el._loadData();
  assert.equal(read().dataset.stale, 'true');
  assert.match(read().textContent, /1h ago - STALE/);

  // The SAME age on a finished run is not an alert. The age still renders --
  // suppressing the marker must not suppress the measurement.
  rows = [{ id: 1, status: 'completed', freshness_s: 3600 }];
  await el._loadData();
  assert.equal(read().dataset.stale, 'false');
  assert.equal(read().textContent, 'Updated 1h ago');

  // Freshest row wins over sort order: api_runs sorts newest-STARTED first,
  // so a long-lived run can sort above the row that was actually just written.
  rows = [
    { id: 9, status: 'running', freshness_s: 4000 },
    { id: 10, status: 'completed', freshness_s: 7 },
  ];
  await el._loadData();
  assert.equal(read().textContent, 'Updated 7s ago');
  assert.equal(read().dataset.stale, 'false');

  // THE ACTUAL PRODUCTION SHAPE. freshness_s exists ONLY on rows from
  // dashboard/api_runs._row, and that reader passes .loki/session.json's
  // status straight through -- it is not required to be the SQL store's
  // "running". It does always mark the live run `current: true`, and it
  // hardcodes historical rows to "unknown". Keying only on the status string
  // would leave the marker inert on the one route that has a real file age.
  rows = [{ id: 'run-1', status: 'in_progress', current: true, freshness_s: 3600 }];
  await el._loadData();
  assert.equal(read().dataset.stale, 'true',
    'the filesystem route must be able to fire the marker');

  // A historical row from the same reader: status "unknown", not current.
  // Old, but not an alert -- and the age still renders.
  rows = [{ id: 'run-0', status: 'unknown', current: false, freshness_s: 3600 }];
  await el._loadData();
  assert.equal(read().dataset.stale, 'false');
  assert.equal(read().textContent, 'Updated 1h ago');

  // A payload with no freshness_s at all falls back to receive time and says
  // so, rather than silently presenting a client clock as a file age.
  rows = [{ id: 1, status: 'completed' }];
  await el._loadData();
  assert.equal(read().dataset.source, 'client');
  assert.match(read().textContent, /receive time/);

  // THE DEDUPE TRAP. This component short-circuits on a byte-identical run
  // list to avoid re-rendering the table. Age is the one thing that keeps
  // moving while the payload does not, so the dedupe must not swallow the
  // freshness update -- a run table frozen for an hour is precisely what the
  // stale marker exists to announce. Feed the SAME rows twice with the clock
  // advanced and assert the age still climbs.
  const realNow = Date.now;
  try {
    let t = realNow();
    Date.now = () => t;
    rows = [{ id: 7, status: 'running' }];
    await el._loadData();
    const first = read().textContent;

    // ...but it must ALSO not rebuild the shadow DOM to do it. render()
    // reassigns innerHTML wholesale, which on a scrolling table destroys the
    // user's scroll position, selection and focus every poll. Holding a
    // reference to a live node proves the update was a patch and not a
    // rebuild: a rebuilt tree would replace this node with a new one.
    const spanBefore = read();
    const tableBefore = el.shadowRoot.querySelector('.runs-table-wrapper');

    // Same bytes, five minutes later.
    t += 300_000;
    await el._loadData();

    assert.notEqual(read().textContent, first,
      'identical payload must still refresh the rendered age');
    assert.equal(read().dataset.stale, 'true');
    assert.match(read().textContent, /5m ago/);
    assert.equal(read(), spanBefore,
      'unchanged data must patch the freshness node, not rebuild the tree');
    assert.equal(el.shadowRoot.querySelector('.runs-table-wrapper'), tableBefore,
      'unchanged data must not rebuild the scrolling run table');
  } finally {
    Date.now = realNow;
  }
});
