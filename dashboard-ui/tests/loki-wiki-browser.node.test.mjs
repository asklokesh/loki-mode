/**
 * jsdom + node:test coverage for the Loki Wiki Browser (Tasks F + D).
 *
 * Run: node --test tests/loki-wiki-browser.node.test.mjs
 *
 * Self-contained (no jest): boots a jsdom window, installs the browser globals
 * the component needs at class-definition time, then dynamically imports the
 * component. The API client is injected by overriding _setupApi on the
 * prototype, so each test fully controls the manifest-then-section ordering.
 *
 * Task F (first-load state machine): a section tab must never get stuck on
 * "Loading section..." -- the first click resolves to content, an honest error,
 * or an honest empty state, even when the manifest (_meta) is unresolved at
 * click time.
 *
 * Task D (mermaid render): Architecture / Data Flow sections that carry a
 * `diagram` field render an SVG via vendored mermaid, fall back to source +
 * prose on invalid mermaid, and work offline (no mermaid) by showing the source
 * rather than blanking or throwing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// --- jsdom bootstrap (must precede the component import) ----------------------
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
  url: 'http://localhost:57374',
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.customElements = window.customElements;
globalThis.Event = window.Event;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
// jsdom omits localStorage unless a backing file is given; LokiElement reads it
// in its constructor, so provide a minimal in-memory shim.
const _store = new Map();
const localStorageShim = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  clear: () => { _store.clear(); },
};
Object.defineProperty(window, 'localStorage', { value: localStorageShim, configurable: true });
globalThis.localStorage = localStorageShim;
window.matchMedia = window.matchMedia || (() => ({
  matches: false, addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
}));

const { LokiWikiBrowser } = await import('../components/loki-wiki-browser.js');
if (!customElements.get('loki-wiki-browser')) {
  customElements.define('loki-wiki-browser', LokiWikiBrowser);
}

// --- controllable API mock ---------------------------------------------------
function defer() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let metaDeferred;
let sectionResponders;
let getCalls;

const mockApi = {
  baseUrl: 'http://localhost:57374',
  _get(endpoint) {
    getCalls.push(endpoint);
    if (endpoint === '/api/wiki') return metaDeferred.promise;
    const m = endpoint.match(/^\/api\/wiki\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const responder = sectionResponders[id];
      if (responder) return responder();
      return Promise.reject(new Error('404 not found'));
    }
    return Promise.resolve({});
  },
  _post() { return Promise.resolve({}); },
};

// Inject the mock at the point the component would build its real client.
LokiWikiBrowser.prototype._setupApi = function _setupApi() {
  this._api = mockApi;
};

function resetEnv() {
  metaDeferred = defer();
  sectionResponders = {};
  getCalls = [];
  delete window.mermaid;
  document.body.innerHTML = '';
  document.head.querySelectorAll('script[data-loki-mermaid]').forEach((s) => s.remove());
}

function mount() {
  const el = document.createElement('loki-wiki-browser');
  document.body.appendChild(el); // fires connectedCallback -> _setupApi + _loadMeta
  return el;
}

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const GENERATED_META = {
  generated: true, project: 'demo', file_count: 12,
  sections: [{ title: 'Architecture', citation_count: 3 }],
};
const FRESH_META = { generated: false };
const ARCH_SECTION = {
  title: 'Architecture',
  body: 'Entry points flow into key modules.',
  citations: [{ file: 'autonomy/run.sh', line: 10253 }],
};
const VALID_MERMAID = 'flowchart TD\n  A[loki start] --> B[run.sh]\n  B --> C[(state)]';
const INVALID_MERMAID = 'flowchart TD\n  A[unterminated --> B[';

const countGets = (endpoint) => getCalls.filter((e) => e === endpoint).length;

// --- Task F ------------------------------------------------------------------

test('F1: first click with _meta UNRESOLVED ends in content, not infinite Loading', async () => {
  resetEnv();
  sectionResponders.architecture = () => Promise.resolve(ARCH_SECTION);
  const el = mount();
  await flush();
  // _meta still in flight -- click Architecture now (the original bug case).
  const sel = el._selectTab('architecture');
  metaDeferred.resolve(GENERATED_META);
  await sel;
  await flush();

  const html = el.shadowRoot.innerHTML;
  assert.ok(!html.includes('Loading section...'), 'must not be stuck on spinner');
  assert.ok(html.includes('Entry points flow into key modules.'), 'prose rendered');
  assert.ok(html.includes('autonomy/run.sh'), 'citation rendered');
});

test('F2: section fetch ERROR shows honest error + retry, not infinite spinner', async () => {
  resetEnv();
  sectionResponders.modules = () => Promise.reject(new Error('boom'));
  const el = mount();
  metaDeferred.resolve(GENERATED_META);
  await flush();
  await el._selectTab('modules');
  await flush();

  const html = el.shadowRoot.innerHTML;
  assert.ok(!html.includes('Loading section...'));
  assert.ok(html.includes('boom'), 'error message shown');
  assert.ok(html.includes('wiki-retry-btn'), 'retry offered');
  assert.equal(el._sectionState.modules, 'error');
});

test('F2b: manifest load failure is a terminal state, not an infinite wiki spinner', async () => {
  resetEnv();
  const el = mount();
  metaDeferred.reject(new Error('manifest down'));
  await flush();
  await el._selectTab('architecture');
  await flush();

  assert.equal(el._loading, false, 'meta load settled');
  assert.ok(!el.shadowRoot.innerHTML.includes('Loading section...'));
});

test('F4: fresh repo (generated:false) shows honest empty state, not a stuck spinner', async () => {
  resetEnv();
  const el = mount();
  const sel = el._selectTab('architecture'); // click before meta resolves
  metaDeferred.resolve(FRESH_META);
  await sel;
  await flush();

  const html = el.shadowRoot.innerHTML;
  assert.ok(!html.includes('Loading section...'));
  assert.ok(html.includes('No wiki generated yet'), 'empty state shown');
  assert.equal(el._sectionCache.architecture, undefined, 'empty state not cached');
});

test('F3: switching tabs is instant once loaded (cache preserved, single fetch)', async () => {
  resetEnv();
  sectionResponders.architecture = () => Promise.resolve(ARCH_SECTION);
  const el = mount();
  metaDeferred.resolve(GENERATED_META);
  await flush();

  await el._selectTab('architecture');
  await flush();
  assert.equal(countGets('/api/wiki/architecture'), 1, 'fetched once');

  await el._selectTab('overview');
  await el._selectTab('architecture');
  await flush();
  assert.equal(countGets('/api/wiki/architecture'), 1, 'no refetch on return');
  assert.ok(el.shadowRoot.innerHTML.includes('Entry points flow into key modules.'));
});

// --- Task D ------------------------------------------------------------------

test('D1: valid mermaid renders an SVG into #wiki-diagram (strict securityLevel)', async () => {
  resetEnv();
  sectionResponders.architecture = () =>
    Promise.resolve({ ...ARCH_SECTION, diagram: VALID_MERMAID });
  let initArg = null;
  window.mermaid = {
    initialize: (cfg) => { initArg = cfg; },
    parse: () => Promise.resolve(true),
    render: () => Promise.resolve({ svg: '<svg id="rendered"><g></g></svg>' }),
  };
  const el = mount();
  metaDeferred.resolve(GENERATED_META);
  await flush();
  await el._selectTab('architecture');
  await flush();
  await flush();

  const host = el.shadowRoot.getElementById('wiki-diagram');
  assert.ok(host, '#wiki-diagram exists');
  assert.ok(host.innerHTML.includes('<svg'), 'SVG injected');
  assert.equal(initArg && initArg.securityLevel, 'strict', 'strict securityLevel requested');
  // Prose + sources still shown below the diagram.
  assert.ok(el.shadowRoot.innerHTML.includes('Entry points flow into key modules.'));
  assert.ok(el.shadowRoot.innerHTML.includes('autonomy/run.sh'));
});

test('D3: invalid mermaid falls back to source code block + prose, never throws/blanks', async () => {
  resetEnv();
  sectionResponders['data-flow'] = () => Promise.resolve({
    title: 'Data Flow',
    body: 'A PRD enters via loki start.',
    diagram: INVALID_MERMAID,
    citations: [{ file: 'autonomy/loki', line: 622 }],
  });
  window.mermaid = {
    initialize: () => {},
    parse: () => Promise.reject(new Error('Parse error')),
    render: () => Promise.reject(new Error('should not reach render')),
  };
  const el = mount();
  metaDeferred.resolve(GENERATED_META);
  await flush();
  await el._selectTab('data-flow');
  await flush();
  await flush();

  const html = el.shadowRoot.innerHTML;
  assert.ok(html.includes('diagram-fallback'), 'fallback block shown');
  assert.ok(html.includes('flowchart TD'), 'mermaid source visible');
  assert.ok(html.includes('A PRD enters via loki start.'), 'prose visible');
  assert.ok(html.includes('autonomy/loki'), 'sources visible');
  const host = el.shadowRoot.getElementById('wiki-diagram');
  assert.ok(!host.innerHTML.includes('<svg'), 'no SVG on parse failure');
});

test('D3b: offline (mermaid asset fails to load) shows source fallback, no throw', async () => {
  resetEnv();
  sectionResponders.architecture = () =>
    Promise.resolve({ ...ARCH_SECTION, diagram: VALID_MERMAID });
  // No window.mermaid; force injected <script> to error so _ensureMermaid -> null.
  const origCreate = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = origCreate(tag);
    if (String(tag).toLowerCase() === 'script') {
      setTimeout(() => node.dispatchEvent(new window.Event('error')), 0);
    }
    return node;
  };
  try {
    const el = mount();
    metaDeferred.resolve(GENERATED_META);
    await flush();
    await el._selectTab('architecture');
    await flush(5);
    await flush(5);

    const html = el.shadowRoot.innerHTML;
    assert.ok(html.includes('diagram-fallback'), 'fallback shown offline');
    assert.ok(html.includes('flowchart TD'), 'source visible offline');
    assert.ok(html.includes('Entry points flow into key modules.'), 'prose visible offline');
    const host = el.shadowRoot.getElementById('wiki-diagram');
    assert.ok(!host.innerHTML.includes('<svg'), 'no SVG when mermaid unavailable');
  } finally {
    document.createElement = origCreate;
  }
});

test('D: a fenced ```mermaid diagram field is unwrapped and rendered', async () => {
  resetEnv();
  const fenced = '```mermaid\n' + VALID_MERMAID + '\n```';
  sectionResponders.architecture = () =>
    Promise.resolve({ ...ARCH_SECTION, diagram: fenced });
  let parsedSrc = null;
  window.mermaid = {
    initialize: () => {},
    parse: (s) => { parsedSrc = s; return Promise.resolve(true); },
    render: () => Promise.resolve({ svg: '<svg id="r"></svg>' }),
  };
  const el = mount();
  metaDeferred.resolve(GENERATED_META);
  await flush();
  await el._selectTab('architecture');
  await flush();
  await flush();

  // The fence must be stripped before parse/render.
  assert.ok(parsedSrc && !parsedSrc.includes('```'), 'fence stripped before parse');
  assert.ok(parsedSrc.includes('flowchart TD'), 'inner source preserved');
  const host = el.shadowRoot.getElementById('wiki-diagram');
  assert.ok(host.innerHTML.includes('<svg'), 'SVG rendered from fenced source');
});

test('D: section without a diagram field renders prose only (no diagram region)', async () => {
  resetEnv();
  sectionResponders.architecture = () => Promise.resolve(ARCH_SECTION); // no diagram
  let rendered = false;
  window.mermaid = { initialize: () => {}, parse: () => Promise.resolve(true),
    render: () => { rendered = true; return Promise.resolve({ svg: '<svg></svg>' }); } };
  const el = mount();
  metaDeferred.resolve(GENERATED_META);
  await flush();
  await el._selectTab('architecture');
  await flush();

  assert.equal(el.shadowRoot.getElementById('wiki-diagram'), null, 'no diagram region');
  assert.equal(rendered, false, 'mermaid.render not called without a diagram');
  assert.ok(el.shadowRoot.innerHTML.includes('Entry points flow into key modules.'));
});
