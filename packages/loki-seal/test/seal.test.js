'use strict';
// Fixture-repo tests for loki-seal. Repos are generated under LOKI_RUN_TMP (or os.tmpdir()).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SEAL = path.join(__dirname, '..', 'bin', 'loki-seal.js');
const root = fs.mkdtempSync(path.join(process.env.LOKI_RUN_TMP || os.tmpdir(), 'seal-fx-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
function repo(files) {
  const dir = path.join(root, 'r' + n++);
  put(dir, files);
  return dir;
}
function put(dir, files) {
  for (const [f, c] of Object.entries(files)) {
    if (c === null) { fs.rmSync(path.join(dir, f), { force: true }); continue; }
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
}
function seal(cmd, dir, extra = {}) {
  const r = spawnSync('node', [SEAL, cmd], {
    input: JSON.stringify({ session_id: 's-' + path.basename(dir), cwd: dir, ...extra }),
    env: { ...process.env, LOKI_SEAL_STATE_DIR: path.join(root, 'state') },
    encoding: 'utf8',
  });
  // Contract: block = exit 2 + reason on stderr; pass = exit 0 + receipt on stdout.
  return { status: r.status, out: { decision: r.status === 2 ? 'block' : undefined, reason: r.stderr, systemMessage: r.stdout }, raw: r.stdout + r.stderr };
}
const blocked = (r) => r.out.decision === 'block';

const nodeRepo = (lib, tst) => ({
  'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node --test' } }),
  'lib.js': lib,
  'test/a.test.js': tst,
});
const ADD_BAD = 'module.exports = (a, b) => a - b;\n';
const ADD_OK = 'module.exports = (a, b) => a + b;\n';
const T2 = `const test = require('node:test'); const assert = require('node:assert'); const add = require('../lib.js');
test('adds', () => { assert.strictEqual(add(1, 2), 3); });
test('adds zero', () => { assert.strictEqual(add(0, 0), 0); });
`;

test('unchanged green passes with a 5-line receipt', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  const r = seal('stop', d);
  assert.ok(!blocked(r), r.raw);
  const lines = r.out.systemMessage.trim().split('\n');
  assert.strictEqual(lines.length, 5);
  assert.match(lines[4], /Verified by Loki .*github\.com\/asklokesh\/loki-mode/);
  assert.match(lines[1], /2 passed, 0 failed/);
});

test('red tests block', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  put(d, { 'lib.js': ADD_BAD });
  const r = seal('stop', d);
  assert.ok(blocked(r), r.raw);
  assert.match(r.out.reason, /red|fail/i);
});

test('deleting a failing test is blocked', () => {
  const d = repo(nodeRepo(ADD_BAD, T2));
  seal('start', d);
  put(d, { 'test/a.test.js': T2.replace(/^test\('adds',.*\n/m, '') });
  const r = seal('stop', d);
  assert.ok(blocked(r), r.raw);
  assert.match(r.out.reason, /removed 1 test/);
});

test('deleting the whole test file is blocked', () => {
  const d = repo(nodeRepo(ADD_BAD, T2));
  seal('start', d);
  put(d, { 'test/a.test.js': null, 'test/b.test.js': "require('node:test')('x', () => {});\n" });
  const r = seal('stop', d);
  assert.ok(blocked(r), r.raw);
  assert.match(r.out.reason, /removed test file/);
});

test('adding .skip is blocked even when the suite is then green', () => {
  const d = repo(nodeRepo(ADD_BAD, T2));
  seal('start', d);
  put(d, { 'test/a.test.js': T2.replace("test('adds',", "test.skip('adds',") });
  const r = seal('stop', d);
  assert.ok(blocked(r), r.raw);
  assert.match(r.out.reason, /skip/);
});

test('dropping an assertion is blocked', () => {
  const d = repo(nodeRepo(ADD_BAD, T2));
  seal('start', d);
  put(d, { 'test/a.test.js': T2.replace('assert.strictEqual(add(1, 2), 3);', '') });
  const r = seal('stop', d);
  assert.ok(blocked(r), r.raw);
  assert.match(r.out.reason, /assertion/);
});

test('editing a CI workflow test step is blocked', () => {
  const wf = 'jobs:\n  t:\n    steps:\n      - run: npm test\n      - run: echo done\n';
  const d = repo({ ...nodeRepo(ADD_OK, T2), '.github/workflows/ci.yml': wf });
  seal('start', d);
  put(d, { '.github/workflows/ci.yml': wf.replace('npm test', 'echo skipped') });
  const r = seal('stop', d);
  assert.ok(blocked(r), r.raw);
  assert.match(r.out.reason, /CI/);
});

test('a real code fix passes', () => {
  const d = repo(nodeRepo(ADD_BAD, T2));
  seal('start', d);
  put(d, { 'lib.js': ADD_OK });
  const r = seal('stop', d);
  assert.ok(!blocked(r), r.raw);
  assert.match(r.out.systemMessage, /PASS/);
});

test('adding a new test file passes', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  put(d, { 'test/c.test.js': T2 });
  assert.ok(!blocked(seal('stop', d)));
});

const PYFIX = (body) => ({
  'pytest.ini': '[pytest]\n',
  'calc.py': body,
  'tests/test_calc.py': 'from calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n\ndef test_zero():\n    assert add(0, 0) == 0\n',
});
const havePytest = spawnSync('python3', ['-m', 'pytest', '--version']).status === 0;

test('pytest: red blocks, real fix passes', { skip: !havePytest && 'pytest missing' }, () => {
  const d = repo(PYFIX('def add(a, b):\n    return a + b\n'));
  seal('start', d);
  put(d, { 'calc.py': 'def add(a, b):\n    return a - b\n' });
  assert.ok(blocked(seal('stop', d)));
  put(d, { 'calc.py': 'def add(a, b):\n    return a + b\n' });
  const r = seal('stop', d);
  assert.ok(!blocked(r), r.raw);
  assert.match(r.out.systemMessage, /pytest/);
});

test('pytest: deleting a test and adding skip/xfail are blocked', { skip: !havePytest && 'pytest missing' }, () => {
  const d = repo(PYFIX('def add(a, b):\n    return a - b\n'));
  seal('start', d);
  const t = fs.readFileSync(path.join(d, 'tests/test_calc.py'), 'utf8');
  put(d, { 'tests/test_calc.py': t.replace('def test_add():\n    assert add(1, 2) == 3\n\n', '') });
  assert.match(seal('stop', d).out.reason, /removed 1 test/);
  put(d, { 'tests/test_calc.py': 'import pytest\n' + t.replace('def test_add', '@pytest.mark.xfail\ndef test_add') });
  assert.match(seal('stop', d).out.reason, /skip/);
});

test('no runner detected is not a block', () => {
  const d = repo({ 'README.md': 'x' });
  seal('start', d);
  const r = seal('stop', d);
  assert.ok(!blocked(r));
  assert.match(r.out.systemMessage, /NOT VERIFIED/);
});

test('exit code is 2 on block and 0 on pass', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  put(d, { 'lib.js': ADD_BAD });
  assert.strictEqual(seal('stop', d).status, 2);
  put(d, { 'lib.js': ADD_OK });
  assert.strictEqual(seal('stop', d).status, 0);
});

test('stop_hook_active=true with still-red tests blocks again', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  put(d, { 'lib.js': ADD_BAD });
  assert.strictEqual(seal('stop', d).status, 2);
  assert.strictEqual(seal('stop', d, { stop_hook_active: true }).status, 2);
});

test('pre-existing red test at session start does not block', () => {
  const d = repo(nodeRepo(ADD_BAD, T2));
  seal('start', d);
  put(d, { 'README.md': 'unrelated change' });
  const r = seal('stop', d);
  assert.strictEqual(r.status, 0, r.raw);
  assert.match(r.out.systemMessage, /baseline: \d+ already failing \(not caused by this session\)/);
});

test('a new failure on top of a pre-existing one blocks', () => {
  const d = repo(nodeRepo(ADD_BAD, T2));
  seal('start', d);
  put(d, { 'test/b.test.js': "const test = require('node:test'); const assert = require('node:assert');\ntest('new thing', () => { assert.strictEqual(1, 2); });\n" });
  const r = seal('stop', d);
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /new failing|new failure/i);
});

test('block valve releases after LOKI_SEAL_MAX_BLOCKS with an explicit receipt', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  put(d, { 'test/a.test.js': T2.replace("test('adds',", "test.skip('adds',") });
  const env = { LOKI_SEAL_MAX_BLOCKS: '2' };
  const run = () => spawnSync('node', [SEAL, 'stop'], { input: JSON.stringify({ session_id: 's-' + path.basename(d), cwd: d }), env: { ...process.env, LOKI_SEAL_STATE_DIR: path.join(root, 'state'), ...env }, encoding: 'utf8' });
  assert.strictEqual(run().status, 2);
  assert.strictEqual(run().status, 2);
  const r = run();
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /NOT VERIFIED \(released after 2 blocks\)/);
});

test('start emits additionalContext', () => {
  const d = repo(nodeRepo(ADD_BAD, T2));
  const r = seal('start', d);
  assert.match(JSON.parse(r.out.systemMessage).hookSpecificOutput.additionalContext, /baseline recorded, \d+ tests, 1 failing/);
});
