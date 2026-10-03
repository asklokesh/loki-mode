/**
 * PO-DASH-HONEST-1 (S-223): the notification triggers panel must not say
 * "No triggers configured" when the trigger read failed. A genuine empty list
 * keeps the sentence.
 *
 * Run with: node --test dashboard-ui/tests/loki-notification-triggers-error.node.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

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
  constructor() { this._shadow = null; }
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

let Cls;
before(async () => {
  const mod = await import('../components/loki-notification-center.js');
  Cls = Object.values(mod).find((v) => typeof v === 'function' && v.prototype && v.prototype._loadTriggers);
});

const EMPTY = 'No triggers configured';

function mount(respond) {
  const el = new Cls();
  el.attachShadow({ mode: 'open' });
  globalThis.fetch = async () => respond();
  return el;
}

describe('notification triggers: unreadable vs empty', () => {
  it('error payload does not render the empty sentence', async () => {
    const el = mount(() => ({ ok: true, json: async () => ({ triggers: null, error: 'unreadable' }) }));
    await el._loadTriggers();
    const out = el._renderTriggerList();
    assert.ok(!out.includes(EMPTY), 'rendered empty sentence after a failed read');
    assert.ok(/could not|unreadable|unavailable/i.test(out), 'no error text shown');
  });

  it('http failure does not render the empty sentence', async () => {
    const el = mount(() => ({ ok: false, json: async () => ({}) }));
    await el._loadTriggers();
    assert.ok(!el._renderTriggerList().includes(EMPTY));
  });

  it('genuine empty list keeps the sentence', async () => {
    const el = mount(() => ({ ok: true, json: async () => ({ triggers: [] }) }));
    await el._loadTriggers();
    assert.ok(el._renderTriggerList().includes(EMPTY));
  });
});
