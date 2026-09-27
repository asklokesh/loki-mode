// S-206 / BACKLOG 114: a failed status or git fetch left those props null, and
// the action panel then said "The working tree is clean", "Nothing to push"
// and "No run in progress": claims about data that never loaded.
//
// FinalActions.tsx is JSX and imports ../api/client (browser-only at module
// load), so plain `node --test` cannot import it. ponytail: the test lifts the
// pure disabledReasons function out of the source, strips types with
// node:module and evaluates it. If it moves into its own .ts module, import it.
// Run: node --test web-app/src/cockpit/FinalActions.reasons.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const src = fs.readFileSync(new URL('./FinalActions.tsx', import.meta.url), 'utf8');
const start = src.indexOf('export function disabledReasons');
assert.ok(start >= 0, 'disabledReasons not found in FinalActions.tsx');
const end = src.indexOf('\n}\n', start);
assert.ok(end > start, 'disabledReasons end not found');
const disabledReasons = new Function(
  `${stripTypeScriptTypes(src.slice(start + 'export '.length, end + 2))}\nreturn disabledReasons;`,
)();

const liveStatus = { running: true, paused: false };
const base = { isLive: true, status: liveStatus, git: { ahead: 0, files: [] }, changedFiles: [], prTitle: '' };
const all = (r) => Object.values(r).filter(Boolean).join('\n');

test('git null: commit, push and PR say not loaded, never clean or nothing to push', () => {
  const r = disabledReasons({ ...base, git: null });
  for (const k of ['commit', 'push', 'pr']) assert.equal(r[k], 'Working tree status not loaded', k);
  assert.doesNotMatch(all(r), /The working tree is clean/);
  assert.doesNotMatch(all(r), /Nothing to push/);
});

test('status null: pause, resume and stop say not loaded, never no run in progress', () => {
  const r = disabledReasons({ ...base, isLive: false, status: null });
  for (const k of ['pause', 'resume', 'stop']) assert.equal(r[k], 'Run status not loaded', k);
  assert.doesNotMatch(all(r), /No run in progress/);
});

test('real data: {ahead:0} with no files keeps both sentences', () => {
  const r = disabledReasons(base);
  assert.equal(r.commit, 'The working tree is clean');
  assert.equal(r.push, 'Nothing to push: no commits ahead of the remote');
  assert.equal(r.pr, 'Nothing to open a pull request for');
});

test('real data: a loaded status with no live run keeps No run in progress', () => {
  const r = disabledReasons({ ...base, isLive: false, status: { running: false, paused: false } });
  for (const k of ['pause', 'resume', 'stop']) assert.equal(r[k], 'No run in progress for this session', k);
});

test('real data: live, paused, changes, ahead and a title enable the right actions', () => {
  const r = disabledReasons({
    ...base,
    status: { running: true, paused: true },
    git: { ahead: 2, files: [] },
    changedFiles: [{ path: 'a.ts' }],
    prTitle: 'x',
  });
  assert.deepEqual(r, { pause: 'Already paused', resume: null, stop: null, commit: null, push: null, pr: null });
});
