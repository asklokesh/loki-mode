// D51-B14r: the start page "Workspace runs" card. Per-repo rows, an
// integration row, a stale badge only when stale is true, and an unreadable
// or failed read shows an error, never an empty card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../dashboard/static/start.html', import.meta.url), 'utf8');

async function boot(runsResponse) {
  const dom = new JSDOM(html, { url: 'http://localhost:57374', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = async (p) => {
        if (p === '/api/operator/workspaces/runs') return runsResponse();
        return { ok: true, status: 200, json: async () => ({ provider: { configured: false, detected: [] }, github: {}, issues: [], concurrency: 0 }) };
      };
      w.setInterval = () => 0;
    } });
  await new Promise((r) => setTimeout(r, 50));
  const body = dom.window.document.getElementById('ws-body');
  assert.ok(body, 'Workspace runs card (#ws-body) must exist');
  return body;
}
const ok = (j) => () => ({ ok: true, status: 200, json: async () => j });

// Row shape copied from dashboard/api_workspaces.py _row (D51-B13r).
const run = (o) => ({ workspace: 'w', run_id: 'r1', state: 'ok', status: 'passed', exit_code: 0, error: null, outcomes: {}, repos: [], ...o });
const repo = (name, o) => ({ repo: name, head: 'abc', current_head: 'abc', stale: false, reason: null, ...o });

test('two runs render with per-repo rows and an integration row', async () => {
  const body = await boot(ok({ runs: [
    run({ status: 'passed', outcomes: { 'o/lib': 'ok', 'o/app': 'FAILED: exit 1' }, repos: [repo('o/lib'), repo('o/app', { stale: true })] }),
    run({ run_id: 'r2', status: 'failed', exit_code: 1, outcomes: { 'o/lib': 'ok' }, repos: [repo('o/lib', { stale: null, current_head: null, reason: 'worktree missing' })] }),
  ], reason: null }));
  assert.equal(body.querySelectorAll('tbody tr').length, 5);
  assert.match(body.textContent, /integration/);
  assert.match(body.textContent, /passed/);
  assert.match(body.textContent, /failed/);
  assert.match(body.textContent, /FAILED: exit 1/);
  assert.match(body.textContent, /worktree missing/);
  assert.match(body.textContent, /w\/r1/);
});

test('stale badge appears only when stale is true', async () => {
  const body = await boot(ok({ runs: [run({ repos: [repo('o/a'), repo('o/b', { stale: true })] })] }));
  assert.equal((body.textContent.match(/stale/g) || []).length, 1);
});

test('an unreadable run shows its error text', async () => {
  const body = await boot(ok({ runs: [run({ run_id: 'bad', state: 'unreadable', status: null, exit_code: null, error: 'corrupt integration.json' })] }));
  assert.match(body.textContent, /corrupt integration\.json/);
  assert.doesNotMatch(body.textContent, /No runs/);
});

test('a 503 shows Could not load, not No runs', async () => {
  const body = await boot(() => ({ ok: false, status: 503, json: async () => ({ detail: 'unavailable' }) }));
  assert.match(body.textContent, /Could not load/);
  assert.doesNotMatch(body.textContent, /No runs/);
});

test('an empty list reads No runs', async () => {
  const body = await boot(ok({ runs: [], reason: 'no workspaces directory' }));
  assert.match(body.textContent, /No runs/);
});
