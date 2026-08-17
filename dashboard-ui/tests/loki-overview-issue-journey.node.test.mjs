import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const fakeClassList = { contains: () => false, add() {}, remove() {}, toggle() {} };
globalThis.document = {
  body: { classList: fakeClassList },
  documentElement: { classList: fakeClassList, dataset: {}, style: { setProperty() {} } },
  addEventListener() {}, removeEventListener() {}, querySelector: () => null,
};

class FakeHTMLElement {
  attachShadow() {
    this._shadow = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
    return this._shadow;
  }
  get shadowRoot() { return this._shadow; }
  getAttribute() { return null; }
  hasAttribute() { return false; }
}

globalThis.HTMLElement = FakeHTMLElement;
globalThis.customElements = {
  _defined: new Map(),
  define(name, ctor) { this._defined.set(name, ctor); },
  get(name) { return this._defined.get(name); },
};
globalThis.window = {
  location: { origin: 'http://localhost:57374' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {}, removeEventListener() {},
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

let LokiOverview;
before(async () => ({ LokiOverview } = await import('../components/loki-overview.js')));

function mounted() {
  const el = new LokiOverview();
  el.attachShadow({ mode: 'open' });
  return el;
}

describe('overview issue-to-PR journey', () => {
  it('renders an honest cold-workspace state without fabricated zeroes', () => {
    const el = mounted();
    el._journeyState = 'empty';
    el.render();
    const out = el.shadowRoot.innerHTML;
    assert.match(out, /No issue-to-PR receipt yet/);
    assert.doesNotMatch(out, /0s to/);
    assert.doesNotMatch(out, /VERIFIED/);
    assert.doesNotMatch(out, /READY/);
  });

  it('distinguishes a failed receipt read from a genuinely empty workspace', () => {
    const el = mounted();
    el._journeyState = 'unavailable';
    el.render();
    const out = el.shadowRoot.innerHTML;
    assert.match(out, /evidence is unavailable/);
    assert.match(out, /No readiness claim can be made/);
    assert.doesNotMatch(out, /No issue-to-PR receipt yet/);
  });

  it('renders measured journey facts, proof gaps, and a recorded PR link', () => {
    const el = mounted();
    el._data.status = 'running';
    el._data.phase = 'VERIFY';
    el._journeyState = 'ready';
    el._journeyProof = {
      facts: { journey: {
        issue: { ref: 'owner/repo#42' },
        time_to_first_result_sec: 38,
        first_result_kind: 'proposed_solution_plan',
        first_result_verified_patch: false,
        pull_request: { state: 'opened', url: 'https://github.com/owner/repo/pull/43' },
      } },
      honesty: {
        headline: 'VERIFIED WITH GAPS',
        degraded: [{ item: 'security' }, { item: 'e2e_tests' }],
      },
    };
    el.render();
    const out = el.shadowRoot.innerHTML;
    assert.match(out, /38s to proposed solution/);
    assert.match(out, /Plan only, not a verified patch/);
    assert.match(out, /VERIFIED WITH GAPS/);
    assert.match(out, /2 recorded gaps/);
    assert.match(out, /href="https:\/\/github\.com\/owner\/repo\/pull\/43"/);
    assert.match(out, />Open PR</);
    assert.match(out, />VERIFY</);
  });

  it('does not treat a non-issue receipt as PR-ready', () => {
    const el = mounted();
    el._journeyState = 'ready';
    el._journeyProof = { facts: {}, honesty: { headline: 'VERIFIED' } };
    el.render();
    assert.match(el.shadowRoot.innerHTML, /Latest receipt is not an issue run/);
    assert.doesNotMatch(el.shadowRoot.innerHTML, /Open PR/);
  });

  it('never turns a non-web receipt URL into an interactive link', () => {
    const el = mounted();
    el._journeyState = 'ready';
    el._journeyProof = {
      facts: { journey: {
        issue: { ref: 'owner/repo#42' },
        pull_request: { state: 'opened', url: 'javascript:alert(1)' },
      } },
      honesty: { headline: 'NOT VERIFIED', degraded: [] },
    };
    el.render();
    assert.doesNotMatch(el.shadowRoot.innerHTML, /javascript:/);
    assert.doesNotMatch(el.shadowRoot.innerHTML, /Open PR/);
    assert.match(el.shadowRoot.innerHTML, /No public PR URL recorded/);
  });
});
