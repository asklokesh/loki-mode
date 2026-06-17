/**
 * Regression test for the fullscreen Escape-key listener leak in
 * loki-dashboard-grid.js.
 *
 * Before the fix, the Escape handler was an anonymous closure added inside
 * render() on every render while a widget was fullscreen, and it only removed
 * itself when Escape was actually pressed. render() runs repeatedly (slot
 * MutationObserver, theme changes, toggles), so handlers stacked, and closing
 * fullscreen via the backdrop left one orphaned on document forever.
 *
 * This test exercises the REAL component class against a minimal document /
 * customElements / HTMLElement stub (the project's runnable harness pattern is
 * the DOM-free `node --test` runner, see ui-components.test.js -- the jest /
 * jsdom suites do not run under ESM in this environment). It asserts the
 * single-handler invariant across repeated renders, the backdrop-close path,
 * and disconnect teardown by counting document keydown listeners.
 *
 * Run with: node --test dashboard-ui/tests/loki-dashboard-grid.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// -- Minimal DOM stubs so importing the component module does not crash and so
// -- we can count document-level keydown listeners. Installed on globalThis
// -- before the component module is imported.
const keydownListeners = new Set();

const fakeClassList = { contains: () => false, add() {}, remove() {}, toggle() {} };
const fakeDocument = {
  body: { classList: fakeClassList },
  documentElement: { classList: fakeClassList, dataset: {}, style: { setProperty() {} } },
  addEventListener(type, fn) {
    if (type === 'keydown') keydownListeners.add(fn);
  },
  removeEventListener(type, fn) {
    if (type === 'keydown') keydownListeners.delete(fn);
  },
  querySelector: () => null,
};

class FakeHTMLElement {
  constructor() {
    this._shadow = null;
    this.children = [];
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
}

const fakeCustomElements = {
  _defined: new Map(),
  define(name, ctor) { this._defined.set(name, ctor); },
  get(name) { return this._defined.get(name); },
};

globalThis.document = fakeDocument;
globalThis.HTMLElement = FakeHTMLElement;
globalThis.customElements = fakeCustomElements;
// loki-theme.js (LokiElement base) may touch window/matchMedia at import time.
globalThis.window = globalThis.window || {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.getComputedStyle = globalThis.getComputedStyle || (() => ({ getPropertyValue: () => '' }));
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

let LokiDashboardGrid;

before(async () => {
  ({ LokiDashboardGrid } = await import('../components/loki-dashboard-grid.js'));
});

function makeGrid() {
  const el = new LokiDashboardGrid();
  el.attachShadow({ mode: 'open' });
  // render() reads many sub-render helpers; stub render's DOM side effects by
  // overriding the parts that need real nodes is unnecessary here -- the leak
  // logic lives at the tail of render(). Guard by no-op'ing getElementById
  // results (already returns null) so attach handlers are skipped safely.
  return el;
}

describe('loki-dashboard-grid Escape-listener lifecycle', () => {
  it('does not stack duplicate document keydown listeners across re-renders while fullscreen', () => {
    keydownListeners.clear();
    const el = makeGrid();
    el._fullscreenWidget = 'widget-1';

    el.render();
    el.render();
    el.render();

    assert.ok(keydownListeners.size <= 1, `expected <=1 keydown listener, got ${keydownListeners.size}`);
    assert.notEqual(el._escHandler, null);
  });

  it('removes the Escape listener when fullscreen is closed (backdrop path)', () => {
    keydownListeners.clear();
    const el = makeGrid();

    el._fullscreenWidget = 'widget-1';
    el.render();
    assert.equal(keydownListeners.size, 1);

    el._fullscreenWidget = null;
    el.render();

    assert.equal(keydownListeners.size, 0);
    assert.equal(el._escHandler, null);
  });

  it('removes the Escape listener on disconnect', () => {
    keydownListeners.clear();
    const el = makeGrid();
    el._fullscreenWidget = 'widget-1';
    el.render();
    assert.equal(keydownListeners.size, 1);

    el.disconnectedCallback();

    assert.equal(keydownListeners.size, 0);
    assert.equal(el._escHandler, null);
  });
});
