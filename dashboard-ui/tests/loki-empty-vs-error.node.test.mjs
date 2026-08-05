/**
 * Regression test: an EMPTY result and a FAILED read must never render the same.
 *
 * THE BUG. loki-run-manager.js, loki-fleet.js and loki-audit-viewer.js all
 * rendered their zero-rows branch BEFORE checking this._error:
 *
 *     } else if (runs.length === 0) {
 *       content = '<div class="empty-state">No runs found.</div>';
 *
 * A failed fetch leaves _runs empty, so a blind panel rendered "No runs
 * found." / "No registered builds." / "No audit entries found matching
 * filters." -- reporting a healthy idle system while actually having read
 * nothing. That is a monitoring surface reporting health when it cannot see.
 *
 * WHY THE ASSERTIONS ARE NEGATIVE. Asserting only that the error text appears
 * would pass with the bug still present, because before the fix BOTH the empty
 * string and an error banner rendered together. The load-bearing assertion is
 * that the error render does NOT contain the empty-state sentence.
 *
 * This exercises the REAL component classes against a minimal DOM stub, which
 * is this project's runnable harness pattern (see loki-dashboard-grid.test.js;
 * the jest/jsdom suites do not run under ESM here).
 *
 * Run with: node --test dashboard-ui/tests/loki-empty-vs-error.node.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// -- Minimal DOM stubs, installed before the component modules are imported.
const fakeClassList = { contains: () => false, add() {}, remove() {}, toggle() {} };
globalThis.document = {
  body: { classList: fakeClassList },
  documentElement: { classList: fakeClassList, dataset: {}, style: { setProperty() {} } },
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
};

class FakeHTMLElement {
  constructor() {
    this._shadow = null;
  }
  attachShadow() {
    this._shadow = {
      innerHTML: '',
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    return this._shadow;
  }
  get shadowRoot() { return this._shadow; }
  getAttribute() { return null; }
  hasAttribute() { return false; }
  setAttribute() {}
  removeAttribute() {}
}

globalThis.HTMLElement = FakeHTMLElement;
globalThis.customElements = {
  _defined: new Map(),
  define(name, ctor) { this._defined.set(name, ctor); },
  get(name) { return this._defined.get(name); },
};
globalThis.window = globalThis.window || {
  location: { origin: 'http://localhost:57374' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.getComputedStyle = globalThis.getComputedStyle || (() => ({ getPropertyValue: () => '' }));
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

let LokiRunManager, LokiFleet, LokiAuditViewer;

before(async () => {
  ({ LokiRunManager } = await import('../components/loki-run-manager.js'));
  ({ LokiFleet } = await import('../components/loki-fleet.js'));
  ({ LokiAuditViewer } = await import('../components/loki-audit-viewer.js'));
});

/** Mount a component with a stubbed API client whose _get behaves as told. */
function mount(Ctor, getImpl) {
  const el = new Ctor();
  el.attachShadow({ mode: 'open' });
  el._api = { _get: getImpl, _post: async () => ({}) };
  el._loading = false;
  return el;
}

/**
 * Render output with the <style> block stripped.
 *
 * Load-bearing: the stylesheet defines `.error-state { ... }` on EVERY render
 * regardless of branch, so a bare `innerHTML.includes('error-state')` is true
 * even when no error element was emitted. Asserting against the markup only is
 * what makes the negative assertions mean anything.
 */
const html = (el) => el.shadowRoot.innerHTML.replace(/<style>[\s\S]*?<\/style>/g, '');

// The exact sentences that must NOT appear when the fetch failed.
const CASES = [
  {
    name: 'loki-run-manager',
    get Ctor() { return LokiRunManager; },
    emptySentence: 'No runs found.',
    errorTitle: 'Could not load runs',
    emptyPayload: { runs: [] },
  },
  {
    name: 'loki-fleet',
    get Ctor() { return LokiFleet; },
    emptySentence: 'No registered builds.',
    errorTitle: 'Could not load the fleet',
    emptyPayload: [],
  },
  {
    name: 'loki-audit-viewer',
    get Ctor() { return LokiAuditViewer; },
    emptySentence: 'No audit entries found matching filters.',
    errorTitle: 'Could not load the audit log',
    emptyPayload: { entries: [] },
  },
];

describe('empty state vs error state are distinguishable', () => {
  for (const c of CASES) {
    it(`${c.name}: a failed read does NOT render the empty-state sentence`, async () => {
      const el = mount(c.Ctor, async () => { throw new Error('ECONNREFUSED'); });
      await el._loadData();
      const out = html(el);

      // THE load-bearing assertion. Before the fix this failed: the empty
      // sentence rendered even though the fetch threw.
      assert.ok(
        !out.includes(c.emptySentence),
        `${c.name}: rendered "${c.emptySentence}" after a FAILED fetch -- ` +
        `a blind panel is claiming an empty result`);

      // And it must positively say it could not read.
      assert.ok(out.includes(c.errorTitle), `${c.name}: missing error title`);
      assert.ok(out.includes('ECONNREFUSED'), `${c.name}: error detail not surfaced`);
      assert.ok(out.includes('error-state'), `${c.name}: no distinct error-state element`);
      // role="status" (polite), NOT role="alert". These panels poll every 5s
      // and render() replaces innerHTML wholesale, so a persistent outage
      // re-creates this node forever; an assertive region would interrupt a
      // screen-reader user every 5 seconds for the whole outage.
      assert.ok(out.includes('role="status"'), `${c.name}: error not announced to a11y`);
      assert.ok(!out.includes('role="alert"'), `${c.name}: assertive role re-fires on every poll`);
    });

    it(`${c.name}: a genuinely empty read renders empty, not an error`, async () => {
      const el = mount(c.Ctor, async () => c.emptyPayload);
      await el._loadData();
      const out = html(el);

      assert.ok(out.includes(c.emptySentence), `${c.name}: missing empty-state sentence`);
      assert.ok(!out.includes('error-state'), `${c.name}: empty result rendered as an error`);
      assert.ok(!out.includes(c.errorTitle), `${c.name}: empty result claimed a read failure`);
    });
  }

  it('an empty payload WITH a server reason renders that reason verbatim', async () => {
    const reason = 'no .loki directory at /tmp/nowhere/.loki';
    const el = mount(LokiRunManager, async () => ({
      runs: [],
      reason,
      source: ['.loki/trust/events.jsonl', '.loki/state/session.json'],
    }));
    await el._loadData();
    const out = html(el);

    assert.ok(out.includes(reason), 'the server-supplied reason was dropped');
    assert.ok(out.includes('.loki/trust/events.jsonl'), 'the source was not named');
    assert.ok(!out.includes('error-state'), 'an empty-with-reason is not an error');
  });

  it('an empty payload WITHOUT a reason says so rather than implying health', async () => {
    const el = mount(LokiRunManager, async () => ({ runs: [] }));
    await el._loadData();
    assert.ok(
      html(el).includes('The server did not state a reason.'),
      'a reasonless empty result must admit the reason is unknown');
  });

  it('provenance from the last success is NOT shown next to a later error', async () => {
    let fail = false;
    const el = mount(LokiRunManager, async () => {
      if (fail) throw new Error('EHOSTUNREACH');
      return { runs: [], reason: 'stale reason from an earlier success', source: ['old/path.jsonl'] };
    });

    await el._loadData();
    assert.ok(html(el).includes('stale reason from an earlier success'));

    fail = true;
    await el._loadData();
    const out = html(el);
    assert.ok(!out.includes('stale reason from an earlier success'),
      'a reason from the previous SUCCESS was shown beside a read failure');
    assert.ok(!out.includes('old/path.jsonl'), 'stale source shown beside a read failure');
  });

  it('an error clears once an identical payload is read successfully again', async () => {
    // Regression for the dataHash short-circuit: `if (hash === last) return;`
    // ran BEFORE `this._error = null`, so a recovered fetch returning the same
    // bytes left the panel permanently claiming it could not read.
    let fail = false;
    const el = mount(LokiRunManager, async () => {
      if (fail) throw new Error('ETIMEDOUT');
      return { runs: [] };
    });

    await el._loadData();          // success, hash recorded
    fail = true;
    await el._loadData();          // failure
    assert.ok(html(el).includes('Could not load runs'));

    fail = false;
    await el._loadData();          // identical payload returns
    const out = html(el);
    assert.ok(!out.includes('Could not load runs'),
      'error survived a successful refetch of an identical payload');
    assert.ok(out.includes('No runs found.'), 'recovered state did not render');
  });
});
