/**
 * Regression test for the spec-textarea focus loss in loki-session-control.js.
 *
 * render() fires every 3s from the status poll (both the success and the
 * server-down paths). It rebuilds shadowRoot.innerHTML wholesale, which
 * destroys and recreates the "Start a build from a spec" textarea. Before the
 * fix, a user composing a multi-line spec lost focus and cursor position on
 * every poll, making the browser PRD-input unusable for anything longer than a
 * one-liner. The fix captures the active element + selection before the
 * innerHTML write and restores focus + caret afterward.
 *
 * This exercises the REAL component class against the project's DOM-free
 * `node --test` harness (the jest/jsdom suites do not run under ESM here).
 *
 * Run with: node --test dashboard-ui/tests/loki-session-control-focus.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// -- Minimal DOM stubs so the component module imports and constructs.
const fakeClassList = { contains: () => false, add() {}, remove() {}, toggle() {} };
globalThis.document = {
  body: { classList: fakeClassList },
  documentElement: { classList: fakeClassList, dataset: {}, style: { setProperty() {} } },
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  // The component's _escapeHtml() uses createElement('div').textContent ->
  // innerHTML. Emulate that escaping so render() does not crash off-DOM.
  createElement() {
    return {
      _text: '',
      set textContent(v) {
        this._text = String(v)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      },
      get innerHTML() { return this._text; },
    };
  },
};

class FakeHTMLElement {
  constructor() {
    this._shadow = null;
    this.children = [];
  }
  attachShadow() {
    this._shadow = {
      innerHTML: '',
      activeElement: null,
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
  dispatchEvent() { return true; }
}

globalThis.HTMLElement = FakeHTMLElement;
globalThis.customElements = { _d: new Map(), define(n, c) { this._d.set(n, c); }, get(n) { return this._d.get(n); } };
globalThis.window = globalThis.window || {
  location: { origin: 'http://localhost:57374' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.getComputedStyle = globalThis.getComputedStyle || (() => ({ getPropertyValue: () => '' }));
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

let LokiSessionControl;

before(async () => {
  ({ LokiSessionControl } = await import('../components/loki-session-control.js'));
});

function makeControl() {
  const el = new LokiSessionControl();
  el.attachShadow({ mode: 'open' });
  // Keep the component offline so the Start control (spec textarea) is rendered
  // (canStart === true when not running and not paused).
  el._status = { ...el._status, mode: 'offline' };
  return el;
}

describe('loki-session-control spec-textarea focus preservation across render()', () => {
  it('restores focus and caret to the spec input when it was focused before a re-render', () => {
    const el = makeControl();

    // The spec input that the NEXT render() will produce. _attachEventListeners
    // and the focus-restore both look it up by id, so return this spy node.
    let focused = false;
    let restoredRange = null;
    const nextInput = {
      id: 'spec-input',
      disabled: false,
      focus() { focused = true; },
      setSelectionRange(start, end) { restoredRange = [start, end]; },
      addEventListener() {},
    };

    // Simulate: the user has the textarea focused with the caret at offset 7.
    el.shadowRoot.activeElement = { id: 'spec-input', selectionStart: 7, selectionEnd: 7 };
    // After the innerHTML rebuild, getElementById('spec-input') returns the new node.
    el.shadowRoot.getElementById = (id) => (id === 'spec-input' ? nextInput : null);

    el.render();

    assert.equal(focused, true, 'expected the new spec input to be re-focused');
    assert.deepEqual(restoredRange, [7, 7], 'expected the caret/selection to be restored');
  });

  it('does not touch focus when the spec input was not the active element', () => {
    const el = makeControl();

    let focused = false;
    const nextInput = {
      id: 'spec-input',
      disabled: false,
      focus() { focused = true; },
      setSelectionRange() {},
      addEventListener() {},
    };

    // Active element is something else (or nothing).
    el.shadowRoot.activeElement = { id: 'some-other-field' };
    el.shadowRoot.getElementById = (id) => (id === 'spec-input' ? nextInput : null);

    el.render();

    assert.equal(focused, false, 'must not steal focus to the spec input on an unrelated render');
  });
});
