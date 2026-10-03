// S-229 / BACKLOG 114: the preview-info fetch swallowed its error
// (`.catch(() => {})`), so previewInfo stayed null and both the preview
// header and the preview body said "Detecting project type..." forever.
//
// Same approach as ProjectWorkspace.panels.test.mjs: the pure
// previewDetectText() helper is extracted and executed; the wiring (catch
// keeps the error, both null-previewInfo branches render the helper) is
// checked on the source.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./ProjectWorkspace.tsx', import.meta.url), 'utf8');

const HELPER_SIG = 'function previewDetectText(error: string | null): string {';

function loadHelper() {
  const start = src.indexOf(HELPER_SIG);
  assert.ok(start >= 0, 'previewDetectText helper not found');
  const end = src.indexOf('\n}\n', start);
  const js = src.slice(start, end + 3).replace(HELPER_SIG, 'function previewDetectText(error) {');
  return new Function(`${js}; return previewDetectText;`)();
}

test('previewDetectText: a rejected fetch says Could not detect project type with the message', () => {
  const t = loadHelper()('HTTP 500: boom');
  assert.match(t, /^Could not detect project type/);
  assert.ok(t.includes('HTTP 500: boom'), 'message must be shown');
  assert.doesNotMatch(t, /Detecting project type/);
});

test('previewDetectText: a pending request keeps Detecting project type...', () => {
  assert.equal(loadHelper()(null), 'Detecting project type...');
});

test('getPreviewInfo: the rejection is kept, not swallowed', () => {
  const start = src.indexOf('api.getPreviewInfo(');
  assert.ok(start >= 0, 'getPreviewInfo call not found');
  const call = src.slice(src.lastIndexOf('useEffect(', start), src.indexOf('}, [sessionData.id]);', start));
  assert.doesNotMatch(call, /catch\(\(\)\s*=>\s*\{\s*\}\)/, 'catch must not be empty');
  assert.match(call, /catch\(\s*\(?\w+\)?\s*=>[^]*setPreviewError\(/, 'catch must record the error');
  assert.match(call, /setPreviewError\(null\)/, 'a new fetch must clear the previous error');
});

test('both null-previewInfo branches render the helper, never the literal', () => {
  const uses = src.split('previewDetectText(previewError)').length - 1;
  assert.equal(uses, 2, 'header and body must both render previewDetectText(previewError)');
  const helperEnd = src.indexOf('\n}\n', src.indexOf(HELPER_SIG));
  const rest = src.slice(0, src.indexOf(HELPER_SIG)) + src.slice(helperEnd);
  assert.ok(!rest.includes('Detecting project type'), 'the literal must live only in the helper');
});
