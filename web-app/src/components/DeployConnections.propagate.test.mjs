// PO-WEB-DEPLOY-1 (S-228): after a failed getDeployStatus the component holds
// synthesized {connected:false} defaults. The connect/disconnect handlers must
// not spread those into onStatusChange; they propagate only from the last
// status that a successful fetch actually returned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'DeployConnections.tsx'),
  'utf8',
);
const start = src.indexOf('// Connect handlers');
const end = src.indexOf('// Connect callback map');
assert.ok(start > 0 && end > start, 'handler section must exist');
const handlers = src.slice(start, end);

test('handlers never spread the synthesized default state upward', () => {
  assert.doesNotMatch(handlers, /\.\.\.statuses\b/);
});

test('handlers propagate from the last successfully fetched statuses only', () => {
  assert.match(src, /lastFetchedRef\s*=\s*useRef/);
  assert.match(src, /lastFetchedRef\.current\s*=\s*data/);
  const uses = handlers.match(/lastFetchedRef\.current/g) || [];
  assert.ok(uses.length >= 3, 'connect x2 and disconnect must read the ref');
  assert.match(handlers, /if \(base\)/);
});
