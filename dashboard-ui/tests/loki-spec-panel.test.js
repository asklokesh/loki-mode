/**
 * Tests for Loki Spec Panel component (Task I).
 *
 * The panel must show the ACTIVE spec prominently (PRD / issue / brief /
 * generated spec / codebase-analysis) and a collapsible history of past specs,
 * with honest empty + error states. It must never fabricate a spec: each branch
 * renders only what the API returns.
 */

let specResponder; // () => Promise resolving the /api/spec body
let historyResponder; // () => Promise resolving the /api/spec/history body

const mockApiClient = {
  baseUrl: 'http://localhost:57374',
  _get: jest.fn((endpoint) => {
    if (endpoint === '/api/spec') return specResponder();
    if (endpoint === '/api/spec/history') return historyResponder();
    return Promise.resolve({});
  }),
};

jest.mock('../core/loki-api-client.js', () => ({
  getApiClient: () => mockApiClient,
}));

import { LokiSpecPanel } from '../components/loki-spec-panel.js';

if (!customElements.get('loki-spec-panel')) {
  customElements.define('loki-spec-panel', LokiSpecPanel);
}

function mount() {
  const el = document.createElement('loki-spec-panel');
  document.body.appendChild(el);
  return el;
}

function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  specResponder = () => Promise.resolve({ type: 'none' });
  historyResponder = () => Promise.resolve({ history: [] });
  mockApiClient._get.mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Task I: active spec', () => {
  test('PRD: renders the prd type, path, and content', async () => {
    specResponder = () => Promise.resolve({
      type: 'prd',
      path: '/proj/prd.md',
      content: '# Build a todo app\nWith auth.',
      truncated: false,
    });
    const el = mount();
    await flush();
    await flush();
    const html = el.shadowRoot.innerHTML;
    expect(html).toContain('PRD file');
    expect(html).toContain('/proj/prd.md');
    expect(html).toContain('Build a todo app');
  });

  test('issue: renders the issue type, ref, title, and body', async () => {
    specResponder = () => Promise.resolve({
      type: 'issue',
      ref: 'https://github.com/o/r/issues/42',
      title: 'Add CSV export',
      body: 'Users want to export their data.',
      truncated: false,
    });
    const el = mount();
    await flush();
    await flush();
    const html = el.shadowRoot.innerHTML;
    expect(html).toContain('GitHub issue');
    expect(html).toContain('github.com/o/r/issues/42');
    expect(html).toContain('Add CSV export');
    expect(html).toContain('Users want to export their data.');
  });

  test('brief: renders the one-line brief verbatim', async () => {
    specResponder = () => Promise.resolve({
      type: 'brief',
      text: 'build a discord bot that posts the weather',
      truncated: false,
    });
    const el = mount();
    await flush();
    await flush();
    const html = el.shadowRoot.innerHTML;
    expect(html).toContain('One-line brief');
    expect(html).toContain('build a discord bot that posts the weather');
  });

  test('codebase-analysis: renders the honest no-spec message', async () => {
    specResponder = () => Promise.resolve({ type: 'codebase-analysis' });
    const el = mount();
    await flush();
    await flush();
    const html = el.shadowRoot.innerHTML;
    expect(html).toContain('Codebase analysis');
    expect(html).toContain('building from an analysis of the existing codebase');
  });

  test('none: renders the honest empty state, no history toggle', async () => {
    specResponder = () => Promise.resolve({ type: 'none' });
    const el = mount();
    await flush();
    await flush();
    const html = el.shadowRoot.innerHTML;
    expect(html).toContain('No spec yet');
    // History toggle is hidden in the empty state.
    expect(el.shadowRoot.getElementById('hist-toggle')).toBeNull();
  });

  test('error: failed /api/spec shows an honest error + retry, not a stuck spinner', async () => {
    specResponder = () => Promise.reject(new Error('server down'));
    const el = mount();
    await flush();
    await flush();
    const html = el.shadowRoot.innerHTML;
    expect(html).not.toContain('Loading active spec');
    expect(html).toContain("Couldn't load the spec");
    expect(html).toContain('server down');
    expect(el.shadowRoot.getElementById('spec-retry-btn')).not.toBeNull();
  });
});

describe('Task I: spec history', () => {
  test('history lists rows newest-first as returned, behind a collapsed toggle', async () => {
    specResponder = () => Promise.resolve({ type: 'brief', text: 'newest brief' });
    historyResponder = () => Promise.resolve({
      history: [
        { run_id: 'r2', when: '2026-06-20T10:00:00Z', type: 'brief', summary: 'newest brief' },
        { run_id: 'r1', when: '2026-06-19T10:00:00Z', type: 'issue', summary: 'older issue' },
      ],
    });
    const el = mount();
    await flush();
    await flush();

    // Collapsed by default: rows not in the DOM yet, but the count shows.
    let html = el.shadowRoot.innerHTML;
    expect(html).toContain('Spec history');
    expect(html).toContain('(2)');
    expect(html).not.toContain('older issue');

    // Expand.
    el.shadowRoot.getElementById('hist-toggle').click();
    await flush();
    html = el.shadowRoot.innerHTML;
    expect(html).toContain('newest brief');
    expect(html).toContain('older issue');
    // Newest-first order preserved (r2 before r1 in the markup).
    expect(html.indexOf('newest brief')).toBeLessThan(html.indexOf('older issue'));
  });

  test('empty history: expanding shows the honest empty message', async () => {
    specResponder = () => Promise.resolve({ type: 'brief', text: 'a brief' });
    historyResponder = () => Promise.resolve({ history: [] });
    const el = mount();
    await flush();
    await flush();
    el.shadowRoot.getElementById('hist-toggle').click();
    await flush();
    expect(el.shadowRoot.innerHTML).toContain('No past specs yet');
  });

  test('history failure does not block the active spec; active still renders', async () => {
    specResponder = () => Promise.resolve({ type: 'brief', text: 'still here' });
    historyResponder = () => Promise.reject(new Error('history boom'));
    const el = mount();
    await flush();
    await flush();
    // Active spec rendered despite the history failure.
    expect(el.shadowRoot.innerHTML).toContain('still here');
    // Expanding surfaces the history error honestly.
    el.shadowRoot.getElementById('hist-toggle').click();
    await flush();
    expect(el.shadowRoot.innerHTML).toContain('history boom');
  });
});
