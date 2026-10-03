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
process.env.LOKI_RUN_TMP = root; // child hooks write loki-seal-err-* counters here, never the real tmpdir
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
// On pass the receipt is JSON {"systemMessage"} (documented way to show a Stop hook message to the user).
function msg(out) { try { return JSON.parse(out).systemMessage || out; } catch { return out; } }
// Delivery contract fixtures: a Claude Code style JSONL transcript whose first user message is the request.
function transcript(dir, text) {
  const f = path.join(root, 'tx-' + path.basename(dir) + '-' + n++ + '.jsonl');
  const lines = [{ type: 'summary', summary: 'x' }, { type: 'user', message: { role: 'user', content: text } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const DEFAULT_REQUEST = 'Fix the adder.\n- adds zero\n';
function seal(cmd, dir, extra = {}) {
  const tp = 'transcript_path' in extra ? {} : { transcript_path: transcript(dir, DEFAULT_REQUEST) };
  const r = spawnSync('node', [SEAL, cmd], {
    input: JSON.stringify({ session_id: 's-' + path.basename(dir), cwd: dir, ...tp, ...extra }),
    env: { ...process.env, LOKI_SEAL_STATE_DIR: path.join(root, 'state') },
    encoding: 'utf8',
  });
  // Contract: block = exit 2 + reason on stderr; pass = exit 0 + receipt on stdout.
  return { status: r.status, out: { decision: r.status === 2 ? 'block' : undefined, reason: r.stderr, systemMessage: msg(r.stdout) }, raw: r.stdout + r.stderr };
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

test('unchanged green passes with a 6-line receipt', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  const r = seal('stop', d);
  assert.ok(!blocked(r), r.raw);
  const lines = r.out.systemMessage.trim().split('\n');
  assert.strictEqual(lines.length, 6);
  assert.match(lines[5], /Verified by Loki .*github\.com\/asklokesh\/loki-mode/);
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
  const r = seal('stop', d, { transcript_path: transcript(d, 'Fix calc.\n- zero calc\n') });
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

test('c2: with a red baseline, changing the test script to run nothing is blocked', () => {
  const d = repo(nodeRepo(ADD_BAD, T2));
  seal('start', d);
  put(d, { 'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node --test nothing' } }) });
  const r = seal('stop', d);
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /crashed or ran nothing|test count dropped/);
});

test('e: process.exit(0) prepended to a test file is blocked by the total-count drop', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  put(d, { 'test/a.test.js': 'process.exit(0);\n' + T2 });
  const r = seal('stop', d);
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /test count dropped/);
});

test('PASS with a red baseline says so on line 1', () => {
  const d = repo(nodeRepo(ADD_BAD, T2));
  seal('start', d);
  const r = seal('stop', d);
  assert.strictEqual(r.status, 0, r.raw);
  assert.match(r.out.systemMessage.split('\n')[0], /^loki-seal: PASS \(no new failures; 1 already failing\)$/);
});

test('pass output is JSON with systemMessage', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  const r = spawnSync('node', [SEAL, 'stop'], { input: JSON.stringify({ session_id: 's-' + path.basename(d), cwd: d, transcript_path: transcript(d, DEFAULT_REQUEST) }), env: { ...process.env, LOKI_SEAL_STATE_DIR: path.join(root, 'state') }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /^loki-seal: PASS/);
});

const sealEnv = (d, env, cmd = 'stop', tp) => spawnSync('node', [SEAL, cmd], {
  input: JSON.stringify({ session_id: 's-' + path.basename(d), cwd: d, ...(tp ? { transcript_path: tp } : {}) }),
  env: { ...process.env, LOKI_SEAL_STATE_DIR: path.join(root, 'state'), ...env }, encoding: 'utf8',
});
const isRoot = process.getuid && process.getuid() === 0;

test('fail closed: dangling symlink named *.test.js never exits 1', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  fs.symlinkSync(path.join(d, 'does-not-exist'), path.join(d, 'test', 'ghost.test.js'));
  const r = seal('stop', d);
  assert.ok(r.status === 0 || r.status === 2, r.raw);
});

test('fail closed: unreadable directory blocks with NOT VERIFIED, never exit 1', { skip: isRoot && 'root ignores modes' }, () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  fs.mkdirSync(path.join(d, 'test', 'locked'));
  fs.chmodSync(path.join(d, 'test', 'locked'), 0o000);
  try {
    const r = seal('stop', d);
    assert.strictEqual(r.status, 2, r.raw);
    assert.match(r.out.reason, /NOT VERIFIED \(hook error: /);
  } finally { fs.chmodSync(path.join(d, 'test', 'locked'), 0o755); }
});

test('start survives an internal error and reports baseline unavailable', { skip: isRoot && 'root ignores modes' }, () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  fs.mkdirSync(path.join(d, 'test', 'locked'));
  fs.chmodSync(path.join(d, 'test', 'locked'), 0o000);
  try {
    const r = sealEnv(d, {}, 'start');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /baseline unavailable/);
  } finally { fs.chmodSync(path.join(d, 'test', 'locked'), 0o755); }
});

test('state dir that is a symlink is refused, stop fails closed', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  const real = path.join(root, 'realstate'); fs.mkdirSync(real);
  const link = path.join(root, 'linkstate'); fs.symlinkSync(real, link);
  const r = sealEnv(d, { LOKI_SEAL_STATE_DIR: link });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /NOT VERIFIED \(hook error: .*state/);
});

test('state dir is 0700 and state files older than 7 days are pruned', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  const sd = path.join(root, 'fresh-state');
  fs.mkdirSync(sd, { mode: 0o755 });
  const old = path.join(sd, 'old.json'); fs.writeFileSync(old, '{}');
  const t = Date.now() / 1000 - 8 * 86400; fs.utimesSync(old, t, t);
  sealEnv(d, { LOKI_SEAL_STATE_DIR: sd }, 'start');
  assert.ok(!fs.existsSync(old));
  assert.strictEqual(fs.statSync(sd).mode & 0o777, 0o700);
});

test('a hung suite is killed at the internal timeout and blocks', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'sleep 30' } }), 'test/a.test.js': T2 });
  seal('start', d);
  const t0 = Date.now();
  const r = sealEnv(d, { LOKI_SEAL_TIMEOUT_MS: '1500' });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.ok(Date.now() - t0 < 15000);
});

test('skill frontmatter declares no hooks (plugin is the enforcing install)', () => {
  const k = fs.readFileSync(path.join(__dirname, '..', 'skills', 'loki-seal', 'SKILL.md'), 'utf8');
  assert.ok(!/^hooks:/m.test(k));
});

test('an unreadable non-test directory does not block a clean session', { skip: isRoot && 'root ignores modes' }, () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  fs.mkdirSync(path.join(d, 'docker-volume'));
  fs.chmodSync(path.join(d, 'docker-volume'), 0o000);
  try {
    seal('start', d);
    const r = seal('stop', d);
    assert.strictEqual(r.status, 0, r.raw);
    assert.match(r.out.systemMessage, /1 unreadable dir\(s\) skipped/);
  } finally { fs.chmodSync(path.join(d, 'docker-volume'), 0o755); }
});

test('a failing state dir releases after LOKI_SEAL_MAX_BLOCKS hook errors', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  const real = path.join(root, 'realstate2'); fs.mkdirSync(real);
  const link = path.join(root, 'linkstate2'); fs.symlinkSync(real, link);
  const tmp = path.join(root, 'errtmp'); fs.mkdirSync(tmp);
  const env = { LOKI_SEAL_STATE_DIR: link, LOKI_SEAL_MAX_BLOCKS: '3', TMPDIR: tmp };
  const codes = [];
  let last;
  for (let i = 0; i < 5; i++) { last = sealEnv(d, env); codes.push(last.status); }
  assert.deepStrictEqual(codes.slice(0, 3), [2, 2, 2]);
  assert.strictEqual(codes[3], 0, codes.join(','));
  assert.match(last.stdout, /NOT VERIFIED \(released after 3 blocks: hook error\)/);
});

test('a successful stop resets the hook-error counter', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  const real = path.join(root, 'realstate3'); fs.mkdirSync(real);
  const link = path.join(root, 'linkstate3'); fs.symlinkSync(real, link);
  const tmp = path.join(root, 'errtmp3'); fs.mkdirSync(tmp);
  const bad = { LOKI_SEAL_STATE_DIR: link, LOKI_SEAL_MAX_BLOCKS: '2', LOKI_RUN_TMP: tmp };
  const good = { LOKI_SEAL_STATE_DIR: path.join(root, 'state3'), LOKI_SEAL_MAX_BLOCKS: '2', LOKI_RUN_TMP: tmp };
  assert.deepStrictEqual([sealEnv(d, bad).status, sealEnv(d, bad).status], [2, 2]);
  assert.strictEqual(sealEnv(d, good).status, 0);
  assert.strictEqual(sealEnv(d, bad).status, 2, 'counter must restart after a good stop');
});

test('an unusable error-counter dir falls back to stop_hook_active', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  const real = path.join(root, 'realstate4'); fs.mkdirSync(real);
  const link = path.join(root, 'linkstate4'); fs.symlinkSync(real, link);
  const env = { ...process.env, LOKI_SEAL_STATE_DIR: link, LOKI_RUN_TMP: path.join(root, 'no-such-dir') };
  const go = (extra) => spawnSync('node', [SEAL, 'stop'], { input: JSON.stringify({ session_id: 's4', cwd: d, ...extra }), env, encoding: 'utf8' });
  assert.strictEqual(go({}).status, 2);
  const r = go({ stop_hook_active: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /NOT VERIFIED \(released after a repeated stop: hook error/);
});

test('a FIFO named *.test.js does not hang Stop', () => {
  // the fixture suite runs one explicit file so the runner itself never opens the FIFO
  const d = repo({ ...nodeRepo(ADD_OK, T2), 'package.json': JSON.stringify({ scripts: { test: 'node test/a.test.js' } }) });
  const mk = spawnSync('mkfifo', [path.join(d, 'test', 'pipe.test.js')]);
  if (mk.status !== 0) return;
  const r0 = spawnSync('node', [SEAL, 'start'], { input: JSON.stringify({ session_id: 's-' + path.basename(d), cwd: d }), env: { ...process.env, LOKI_SEAL_STATE_DIR: path.join(root, 'state') }, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r0.status, 0, 'start hung or failed');
  const r = spawnSync('node', [SEAL, 'stop'], { input: JSON.stringify({ session_id: 's-' + path.basename(d), cwd: d }), env: { ...process.env, LOKI_SEAL_STATE_DIR: path.join(root, 'state') }, encoding: 'utf8', timeout: 30000 });
  assert.ok(r.status === 0 || r.status === 2, `status ${r.status} ${r.error}`);
});

// ---- A-04c: delivery contract ----
const REQ_NEG = 'Please fix the calculator.\nIt must handle negative numbers.\n';
const T_NO_NEG = T2; // green suite that never tests negative numbers
const T_NEG = T2 + "test('handles negative numbers', () => { assert.strictEqual(add(-1, -2), -3); });\n";

test('contract (a): green suite that never tests the requested behavior is NOT VERIFIED and names it', () => {
  const d = repo(nodeRepo(ADD_OK, T_NO_NEG));
  seal('start', d);
  const r = seal('stop', d, { transcript_path: transcript(d, REQ_NEG) });
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /^loki-seal: NOT VERIFIED/);
  assert.match(r.out.reason, /no test matches request item: "It must handle negative numbers\."/);
  assert.doesNotMatch(r.out.reason, /^loki-seal: PASS/m);
});

test('contract (b): same session with a passing test for the behavior is PASS', () => {
  const d = repo(nodeRepo(ADD_OK, T_NEG));
  seal('start', d);
  const r = seal('stop', d, { transcript_path: transcript(d, REQ_NEG) });
  assert.strictEqual(r.status, 0, r.raw);
  assert.match(r.out.systemMessage.split('\n')[0], /^loki-seal: PASS$/);
  assert.match(r.out.systemMessage, /contract: 1 item\(s\), 1 covered by passing tests/);
});

test('contract: a failing test for the item does not count as covered', () => {
  const d = repo(nodeRepo(ADD_OK, T_NEG));
  seal('start', d);
  put(d, { 'test/a.test.js': T_NEG.replace('add(-1, -2), -3', 'add(-1, -2), 99') });
  const r = seal('stop', d, { transcript_path: transcript(d, REQ_NEG) });
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /every test for request item .* is failing/);
});

test('contract (c): a request with no derivable contract says NOT VERIFIED: no contract', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  const r = seal('stop', d, { transcript_path: transcript(d, 'hey, can you look at this repo?') });
  assert.strictEqual(r.status, 0, r.raw);
  assert.match(r.out.systemMessage.split('\n')[0], /^loki-seal: NOT VERIFIED: no contract$/);
  assert.match(r.out.systemMessage, /Not verified by Loki/);
});

test('contract (d): missing, unreadable or non-file transcript_path is NOT VERIFIED with the reason and exits cleanly', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  for (const extra of [{ transcript_path: path.join(root, 'nope.jsonl') }, { transcript_path: root }, { transcript_path: 42 }, { transcript_path: '' }]) {
    const r = seal('stop', d, extra);
    assert.strictEqual(r.status, 0, r.raw);
    assert.match(r.out.systemMessage.split('\n')[0], /^loki-seal: NOT VERIFIED: (transcript not readable|no transcript_path)/);
  }
  const r = spawnSync('node', [SEAL, 'stop'], { input: JSON.stringify({ session_id: 's-' + path.basename(d), cwd: d }), env: { ...process.env, LOKI_SEAL_STATE_DIR: path.join(root, 'state') }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).systemMessage, /no transcript_path in hook input/);
});

test('contract: garbage transcript lines are tolerated', () => {
  const d = repo(nodeRepo(ADD_OK, T_NEG));
  seal('start', d);
  const f = path.join(root, 'garbage-' + n++ + '.jsonl');
  fs.writeFileSync(f, '{not json\n\u0000\u0001\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: REQ_NEG }] } }) + '\n');
  const r = seal('stop', d, { transcript_path: f });
  assert.strictEqual(r.status, 0, r.raw);
  assert.match(r.out.systemMessage, /^loki-seal: PASS/);
});

test('contract: a linked local spec file adds items; URLs and escaping paths are not read', () => {
  const d = repo({ ...nodeRepo(ADD_OK, T_NEG), 'docs/spec.md': '# Spec\n- rejects overflow values\n' });
  fs.writeFileSync(path.join(root, 'outside-spec.md'), '- must explode\n');
  seal('start', d);
  const req = `Implement docs/spec.md and see https://example.com/remote.md and ${path.join(root, 'outside-spec.md')}`;
  const r = seal('stop', d, { transcript_path: transcript(d, req) });
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /request item: "rejects overflow values"/);
  assert.doesNotMatch(r.out.reason, /explode/);
});

test('contract: block valve still releases a contract block after LOKI_SEAL_MAX_BLOCKS', () => {
  const d = repo(nodeRepo(ADD_OK, T_NO_NEG));
  seal('start', d);
  const tp = transcript(d, REQ_NEG);
  const run = () => sealEnv(d, { LOKI_SEAL_MAX_BLOCKS: '1' }, 'stop', tp);
  assert.strictEqual(run().status, 2);
  const r = run();
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /NOT VERIFIED \(contract released after 1 blocks\)/);
});

test('contract: the module has no network or process imports', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'contract.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"](?:https?|net|dns|child_process)['"]\)|\bfetch\s*\(/);
});

// ---- A-04c round 2 regressions ----
test('B1: contract blocks never drain the integrity valve; a later skip still blocks', () => {
  const d = repo(nodeRepo(ADD_OK, T_NO_NEG));
  seal('start', d);
  const tp = transcript(d, REQ_NEG);
  const env = { LOKI_SEAL_MAX_BLOCKS: '2' };
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push(sealEnv(d, env, 'stop', tp).status);
  assert.deepStrictEqual(codes, [2, 2, 0, 0], 'contract valve releases on its own counter');
  put(d, { 'test/a.test.js': T_NO_NEG.replace("test('adds',", "test.skip('adds',") });
  const r = sealEnv(d, env, 'stop', tp);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /^loki-seal: BLOCKED/);
  assert.match(r.stderr, /skip/);
});

test('B1: the reviewer probe (a plain explain request) never blocks', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  const tp = transcript(d, 'Can you explain how lib.js works? It should be quick, I only need a short summary.');
  for (let i = 0; i < 7; i++) assert.strictEqual(sealEnv(d, {}, 'stop', tp).status, 0);
  put(d, { 'test/a.test.js': T2.replace("test('adds',", "test.skip('adds',") });
  assert.strictEqual(sealEnv(d, {}, 'stop', tp).status, 2);
});

test('B2a: conversational should/make sure/never, pasted status lines and 1-keyword bullets are not requirements', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  const req = 'I think this should work now. Make sure it is tidy and never ugly.\n' +
    '- modified: lib.js\n- M test/a.test.js\n- 12:01:33 error: boom\n- tidy\n';
  const r = seal('stop', d, { transcript_path: transcript(d, req) });
  assert.strictEqual(r.status, 0, r.raw);
  assert.match(r.out.systemMessage.split('\n')[0], /^loki-seal: NOT VERIFIED: no contract$/);
});

test('B2b: a bare mention of README.md is not a spec', () => {
  const d = repo({ ...nodeRepo(ADD_OK, T2), 'README.md': '# Lib\n- supports streaming uploads\n- handles retries gracefully\n- exports metrics\n' });
  seal('start', d);
  const r = seal('stop', d, { transcript_path: transcript(d, 'Fix the typo in README.md please') });
  assert.strictEqual(r.status, 0, r.raw);
  assert.match(r.out.systemMessage.split('\n')[0], /no contract/);
});

test('B2b: an explicitly marked spec ("per", "spec:") is read', () => {
  for (const req of ['Build it per docs/spec.md', 'spec: docs/spec.md']) {
    const d = repo({ ...nodeRepo(ADD_OK, T2), 'docs/spec.md': '- rejects overflow values\n' });
    seal('start', d);
    const r = seal('stop', d, { transcript_path: transcript(d, req) });
    assert.strictEqual(r.status, 2, req + r.raw);
    assert.match(r.out.reason, /rejects overflow values/);
  }
});

test('B3: a test with no assertion does not satisfy an item', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  put(d, { 'test/a.test.js': T2 + "test('validates email addresses', () => {});\n" });
  const r = seal('stop', d, { transcript_path: transcript(d, 'Add email validation.\n- must validate email addresses\n') });
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /no test matches request item: "must validate email addresses"/);
  put(d, { 'test/a.test.js': T2 + "test('validates email addresses', () => { assert.ok(true); });\n" });
  assert.strictEqual(seal('stop', d, { transcript_path: transcript(d, 'Add email validation.\n- must validate email addresses\n') }).status, 0);
});

test('minor: red-item matching is exact, not substring', () => {
  const extra = "test('handles negative numbers in bulk', () => { assert.strictEqual(1, 2); });\n";
  const d = repo(nodeRepo(ADD_OK, T_NEG));
  seal('start', d);
  put(d, { 'test/a.test.js': T_NEG + extra });
  const r = seal('stop', d, { transcript_path: transcript(d, REQ_NEG) });
  assert.strictEqual(r.status, 2, r.raw); // the new failing test blocks, and it matches the item (R4-B2: any failing match blocks)
  assert.match(r.out.reason, /a test for request item .* is failing: handles negative numbers in bulk$/m);
  assert.doesNotMatch(r.out.reason, /is failing:.*handles negative numbers(?:,|$)/m); // the item's own passing test is not called failing
});

test('F1: an item whose only test was red at session start and is still red blocks (never PASS)', () => {
  const bad = T2 + "test('handles negative numbers', () => { assert.strictEqual(add(-1, -2), 99); });\n";
  const d = repo(nodeRepo(ADD_OK, bad));
  seal('start', d);
  const r = seal('stop', d, { transcript_path: transcript(d, REQ_NEG) });
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /^loki-seal: NOT VERIFIED/);
  assert.match(r.out.reason, /every test for request item .* is failing \(already failing at session start, still not fixed\)/);
  assert.match(r.out.reason, /contract: 1 item\(s\), 0 covered by passing tests/);
  assert.doesNotMatch(r.raw, /Verified by Loki https/);
});

test('F2: ordinary chat with modal words yields no contract', () => {
  const chat = [
    'I have to leave soon, can you refactor the parser?',
    'I cannot get the build to pass on my laptop, please take a look.',
    'Node 20 is required for this repo; bump the eslint config.',
    'It needs to be done before the release meeting.',
  ];
  for (const req of chat) {
    const d = repo(nodeRepo(ADD_OK, T2));
    seal('start', d);
    const r = seal('stop', d, { transcript_path: transcript(d, req) });
    assert.strictEqual(r.status, 0, req + '\n' + r.raw);
    assert.match(r.out.systemMessage.split('\n')[0], /^loki-seal: NOT VERIFIED: no contract$/, req);
  }
});

test('F2: a behavior sentence with a modal is still an item', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  const r = seal('stop', d, { transcript_path: transcript(d, 'The parser must reject empty input.') });
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /request item: "The parser must reject empty input\."/);
});

test('assertion scan: commented-out and quoted asserts do not count; testify, pytest.raises, chai should do', () => {
  const { testNames } = require('../bin/contract.js');
  const asserts = (src) => testNames({ 'x.test.js': src })[0].asserts;
  assert.strictEqual(asserts("test('a b', () => {\n  // assert.ok(true)\n});\n"), false);
  assert.strictEqual(asserts("test('a b', () => {\n  const s = 'assert.ok(1)';\n});\n"), false);
  assert.strictEqual(asserts("test('a b', () => { x.should.equal(1); });\n"), true);
  assert.strictEqual(testNames({ 'x_test.go': 'func TestA(t *testing.T) {\n\trequire.Equal(t, 1, 1)\n}\n' })[0].asserts, true);
  assert.strictEqual(testNames({ 't.py': 'def test_a():\n    # assert x\n    pass\n' })[0].asserts, false);
  assert.strictEqual(testNames({ 't.py': 'def test_a():\n    with pytest.raises(ValueError):\n        f()\n' })[0].asserts, true);
});

// ---- A-04c round 4: four false greens ----
const NEG_REQ_ITEM = '- handles negative numbers\n';

test('R4-B1: real promises containing before/by/release/version/you/your/ci are items', () => {
  const { extractItems } = require('../bin/contract.js');
  for (const s of [
    'Passwords must be hashed before they are stored.',
    'The CLI must print the version with --version.',
    'Signup must reject a request by an unauthenticated user.',
    'The lock must release after a timeout.',
    'Users must be able to download your invoices.',
    'Rate limiting must apply to the CI webhook endpoint.',
  ]) assert.strictEqual(extractItems(s).length, 1, s);
});

test('R4-B1: end to end, a modal sentence with "before" is not dropped (never a silent PASS)', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  const r = seal('stop', d, { transcript_path: transcript(d, 'Fix the adder.\n- adds zero\nNegative sums must be rejected before they are returned.') });
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /no test matches request item: "Negative sums must be rejected before they are returned\."/);
});

test('R4-B1: a sentence filtered as chat is reported in the receipt, not dropped silently', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  seal('start', d);
  const r = seal('stop', d, { transcript_path: transcript(d, 'I have to leave soon, can you refactor the parser?') });
  assert.strictEqual(r.status, 0, r.raw);
  assert.match(r.out.systemMessage, /filtered as chat: 1 sentence\(s\): "I have to leave soon"/);
});

test('R4-B2: a partly red item (one matched test fails, another passes) blocks', () => {
  const src = T2 + "test('handles negative numbers', () => { assert.strictEqual(add(-1, -2), 99); });\n" +
    "test('negative numbers render', () => { assert.strictEqual(add(-1, -2), -3); });\n";
  const d = repo(nodeRepo(ADD_OK, src));
  seal('start', d);
  const r = seal('stop', d, { transcript_path: transcript(d, NEG_REQ_ITEM) });
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /a test for request item "handles negative numbers" is failing: handles negative numbers/);
  assert.match(r.out.reason, /contract: 1 item\(s\), 0 covered by passing tests/);
});

test('R4-B3: a skipped test (already present at start) never covers an item', () => {
  const src = T2 + "test.skip('handles negative numbers', () => { assert.strictEqual(add(-1, -2), -3); });\n";
  const d = repo(nodeRepo(ADD_OK, src));
  seal('start', d);
  const r = seal('stop', d, { transcript_path: transcript(d, NEG_REQ_ITEM) });
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /no test matches request item: "handles negative numbers"/);
});

test('R4-B3: skip, todo, xit, describe.skip, option skip, pytest and rust ignore markers are flagged skipped', () => {
  const { testNames } = require('../bin/contract.js');
  const sk = (p, src) => testNames({ [p]: src }).map((t) => t.skipped);
  assert.deepStrictEqual(sk('a.test.js', "it.skip('a b', () => { assert.ok(1); });\n"), [true]);
  assert.deepStrictEqual(sk('a.test.js', "test.todo('a b');\n"), [true]);
  assert.deepStrictEqual(sk('a.test.js', "xit('a b', () => { assert.ok(1); });\n"), [true]);
  assert.deepStrictEqual(sk('a.test.js', "test('a b', { skip: true }, () => { assert.ok(1); });\n"), [true]);
  assert.deepStrictEqual(sk('a.test.js', "test('a b', { skip: false }, () => { assert.ok(1); });\n"), [false]);
  assert.deepStrictEqual(sk('a.test.js', "describe.skip('grp', () => {\n  it('a b', () => { assert.ok(1); });\n});\nit('c d', () => { assert.ok(1); });\n"), [true, false]);
  assert.deepStrictEqual(sk('t.py', "@pytest.mark.skip(reason='x')\ndef test_a():\n    assert 1\n\ndef test_b():\n    assert 1\n"), [true, false]);
  assert.deepStrictEqual(sk('t.py', "def test_a():\n    pytest.skip('x')\n    assert 1\n"), [true]);
  assert.deepStrictEqual(sk('x.rs', "#[test]\n#[ignore]\nfn a() { assert!(true); }\n"), [true]);
  assert.deepStrictEqual(sk('x_test.go', "func TestA(t *testing.T) {\n\tt.Skip(\"x\")\n\trequire.Equal(t, 1, 1)\n}\n"), [true]);
  assert.deepStrictEqual(sk('a.test.js', "it('a b', () => { assert.ok(1); });\n"), [false]);
});

test('R4-B4: block comments and python docstrings are not assertions', () => {
  const { testNames } = require('../bin/contract.js');
  const asserts = (p, src) => testNames({ [p]: src })[0].asserts;
  assert.strictEqual(asserts('a.test.js', "test('handles negative numbers',()=>{ /* assert.strictEqual(add(-1,-2),-3) */ });\n"), false);
  assert.strictEqual(asserts('a.test.js', "test('a b', () => {\n  /*\n   assert.ok(1);\n   expect(2)\n  */\n});\n"), false);
  assert.strictEqual(asserts('a.test.js', "test('a b', () => {\n  /* note */ assert.ok(1);\n});\n"), true);
  assert.strictEqual(asserts('t.py', 'def test_a():\n    """\n    assert x == 1\n    """\n'), false);
  assert.strictEqual(asserts('t.py', "def test_a():\n    '''\n    assert x == 1\n    '''\n"), false);
  assert.strictEqual(asserts('t.py', 'def test_a():\n    """doc"""\n    assert x == 1\n'), true);
});

test('R4-B4: end to end, a block-commented assertion leaves the item uncovered', () => {
  const src = T2 + "test('handles negative numbers',()=>{ /* assert.strictEqual(add(-1,-2),-3) */ });\n";
  const d = repo(nodeRepo(ADD_OK, src));
  seal('start', d);
  const r = seal('stop', d, { transcript_path: transcript(d, NEG_REQ_ITEM) });
  assert.strictEqual(r.status, 2, r.raw);
  assert.match(r.out.reason, /no test matches request item: "handles negative numbers"/);
});

test('R5-N1b: a filtered chat sentence that carries a modal is still listed and never silently dropped', () => {
  const r = negRun(nodeRepo(ADD_OK, T2), 'Fix the adder.\n- adds zero\nWe must reject negative sums.');
  assert.strictEqual(r.status, 0, r.raw);
  assert.match(r.out.systemMessage, /filtered as chat: 1 sentence\(s\): "We must reject negative sums\."/);
});

test('R5: passing ids come from tap, spec, pytest -rA, go and cargo output only when the test passed', () => {
  const { passing } = require('../bin/contract.js');
  assert.deepStrictEqual(passing('ok 1 - a b\n    ok 2 - c d\nok 3 - e f # SKIP\nnot ok 4 - g h\nok 5 - t # TODO x\n').sort(), ['a b', 'c d']);
  assert.deepStrictEqual(passing('\u2714 a b (0.3ms)\n  \u2714 c d (1ms)\n\ufe63 e f (0.1ms) # SKIP\n\u2716 g h (1ms)\n').sort(), ['a b', 'c d']);
  assert.deepStrictEqual(passing('PASSED test_a.py::TestX::test_one\nSKIPPED [1] test_a.py:3: x\nFAILED test_a.py::test_two - boom\n'), ['test_a.py::TestX::test_one']);
  assert.deepStrictEqual(passing('--- PASS: TestA (0.00s)\n    --- PASS: TestA/sub (0.00s)\n--- SKIP: TestB (0.00s)\n--- FAIL: TestC (0.00s)\n').sort(), ['TestA', 'TestA/sub']);
  assert.deepStrictEqual(passing('test a::b ... ok\ntest c ... ignored\ntest d ... FAILED\n'), ['a::b']);
});

const notVerified = (r) => { assert.strictEqual(r.status, 2, r.raw); assert.match(r.out.reason, /NOT VERIFIED/); };
const negRun = (files, req = NEG_REQ_ITEM) => {
  const d = repo(files);
  seal('start', d);
  return seal('stop', d, { transcript_path: transcript(d, req) });
};
const PYT = (body) => ({ 'pytest.ini': '[pytest]\n', 'lib.py': 'def add(a,b):\n    return a+b\n', 'test_a.py': 'import pytest, unittest\nfrom lib import add\n' + body });
const NEG_PASS = "test('handles negative numbers', () => { assert.strictEqual(add(-1,-2), -3); });\n";

test('R5-N1: You / Our / Please modal sentences stay requirement items and block when untested', () => {
  for (const s of ['You must reject negative sums with a RangeError.', 'Our API must return 404 for missing users.', 'Please note the adder must reject negative sums.']) {
    const r = negRun(nodeRepo(ADD_OK, T2), 'Fix the adder.\n- adds zero\n' + s);
    notVerified(r);
    assert.match(r.out.reason, /no test matches request item/, s);
  }
});

test('R5-N2: an assert inside a multi-line template literal is not an assertion', () => {
  const { testNames } = require('../bin/contract.js');
  assert.strictEqual(testNames({ 'a.test.js': "test('a b', () => { const note = `\n  assert.strictEqual(add(-1,-2), -3)\n`; });\n" })[0].asserts, false);
  assert.strictEqual(testNames({ 'a.test.js': "test('a b', () => { const x = `${1}`; assert.ok(x); });\n" })[0].asserts, true);
  notVerified(negRun(nodeRepo(ADD_OK, T2 + "test('handles negative numbers', () => { const note = `\n  assert.strictEqual(add(-1,-2), -3)\n`; });\n")));
});

test('R5-N3: a quote inside a regex literal does not open a string that hides a comment', () => {
  const { testNames } = require('../bin/contract.js');
  assert.strictEqual(testNames({ 'a.test.js': "test('a b', () => { const r = /'/; /* it's assert.ok(1) */ });\n" })[0].asserts, false);
  assert.strictEqual(testNames({ 'a.test.js': "const re = /[/*]/;\ntest('a b', () => { assert.ok(1); });\n" })[0].asserts, true);
  assert.strictEqual(testNames({ 'a.test.js': "test('a b', () => { const s = '/*'; assert.ok(1); });\n" })[0].asserts, true);
  assert.strictEqual(testNames({ 'a.test.js': "test('a b', () => { assert.strictEqual(4 / 2, 2); });\n" })[0].asserts, true);
  notVerified(negRun(nodeRepo(ADD_OK, T2 + "test('handles negative numbers', () => { const r = /'/; /* it's assert.strictEqual(add(-1,-2), 99) */ });\n")));
});

test('R5-N4: a test in a file the runner never ran never covers an item', () => {
  notVerified(negRun({ ...nodeRepo(ADD_OK, T2), 'spec/neg.spec.js': "const test = require('node:test'); const assert = require('node:assert');\ntest('handles negative numbers', () => { assert.strictEqual(1, 99); });\n" }));
});

test('R5-N5: ctx.skip() and a skip passed through a variable options object never cover an item', () => {
  notVerified(negRun(nodeRepo(ADD_OK, T2 + "test('handles negative numbers', (ctx) => { ctx.skip(); assert.strictEqual(add(-1,-2), 99); });\n")));
  notVerified(negRun(nodeRepo(ADD_OK, T2 + "const opts = { skip: true };\ntest('handles negative numbers', opts, () => { assert.strictEqual(add(-1,-2), 99); });\n")));
});

test('R5-N6: a describe.skip with unindented nested tests never covers an item', () => {
  const H = "const test = require('node:test'); const assert = require('node:assert'); const add = require('../lib.js');\nconst { describe, it } = require('node:test');\n";
  notVerified(negRun(nodeRepo(ADD_OK, H + "it('adds', () => { assert.strictEqual(add(1,2), 3); });\ndescribe.skip('neg', () => {\nit('handles negative numbers', () => { assert.strictEqual(add(-1,-2), 99); });\n});\n")));
});

test('R5-N7: a pytest class-level skip never covers an item', { skip: !havePytest && 'pytest missing' }, () => {
  notVerified(negRun(PYT("@pytest.mark.skip(reason='x')\nclass TestNeg:\n    def test_handles_negative_numbers(self):\n        assert add(-1,-2) == -3\n\ndef test_adds():\n    assert add(1,2) == 3\n")));
  notVerified(negRun(PYT("@unittest.skip('x')\nclass TestNeg(unittest.TestCase):\n    def test_handles_negative_numbers(self):\n        self.assertEqual(add(-1,-2), -3)\n\ndef test_adds():\n    assert add(1,2) == 3\n")));
  notVerified(negRun(PYT("pytestmark = pytest.mark.skip(reason='x')\n\ndef test_handles_negative_numbers():\n    assert add(-1,-2) == -3\n")));
});

test('R5-N7: a real passing test still covers the item (node, pytest)', { skip: !havePytest && 'pytest missing' }, () => {
  const r = negRun(nodeRepo(ADD_OK, T2 + NEG_PASS));
  assert.strictEqual(r.status, 0, r.raw);
  assert.match(r.out.systemMessage, /1 item\(s\), 1 covered by passing tests/);
  const p = negRun(PYT("class TestNeg:\n    def test_handles_negative_numbers(self):\n        assert add(-1,-2) == -3\n"));
  assert.strictEqual(p.status, 0, p.raw);
  assert.match(p.out.systemMessage, /1 item\(s\), 1 covered by passing tests/);
});

// SEAL-FORGED-LINES: a runner whose own summary counts contradict the pass lines it printed is never VERIFIED.
const printRepo = (text, code) => ({
  'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node run.js' } }),
  'run.js': `process.stdout.write(${JSON.stringify(text)}); process.exit(${code});\n`,
});
const inconsistent = (r) => { notVerified(r); assert.match(r.out.reason, /runner output inconsistent/); };

test('forged lines (a): TAP ok line printed by a test body with summary pass 0 / fail 1 is inconsistent', () => {
  inconsistent(negRun(printRepo('ok 1 - x\n# tests 1\n# pass 0\n# fail 1\n', 1)));
});

test('forged lines (b): pytest PASSED line with "1 failed, 0 passed" is inconsistent', () => {
  inconsistent(negRun(printRepo('PASSED test_x.py::test_x\n1 failed, 0 passed in 0.01s\n', 1)));
});

test('forged lines (c): an id reported both passed and failed is inconsistent', () => {
  inconsistent(negRun(printRepo('ok 1 - x\nnot ok 2 - x\n# tests 2\n# pass 1\n# fail 1\n', 1)));
});

test('forged lines: a consistent runner summary and a runner with no summary line are unchanged', () => {
  const ok = negRun(printRepo('ok 1 - adds\nok 2 - adds zero\n# tests 2\n# pass 2\n# fail 0\n', 0));
  assert.doesNotMatch(ok.raw, /runner output inconsistent/);
  assert.match(ok.raw, /2 passed, 0 failed/);
  const none = negRun(printRepo('ok 1 - adds zero\n', 0));
  assert.doesNotMatch(none.raw, /runner output inconsistent/);
});

// Real node:test describe() and nested t.test() output: suites and parents are not leaves in the summary.
const NESTED_TEST = "const { describe, it, test } = require('node:test'); const assert = require('node:assert'); const add = require('../lib.js');\n" +
  "describe('adder', () => { it('adds', () => { assert.strictEqual(add(1,2), 3); }); it('adds zero', () => { assert.strictEqual(add(0,0), 0); }); });\n" +
  "test('parent', async (t) => { await t.test('child', () => { assert.strictEqual(add(1,1), 2); }); });\n";
const nestedRepo = (script) => ({ ...nodeRepo(ADD_OK, NESTED_TEST), 'package.json': JSON.stringify({ name: 'fx', scripts: { test: script } }) });

test('forged lines: honest node describe() and nested t.test() stay VERIFIED (default reporter)', () => {
  const r = negRun(nestedRepo('node --test'), 'Fix the adder.\n- adds zero\n');
  assert.strictEqual(r.status, 0, r.raw);
  assert.doesNotMatch(r.raw, /runner output inconsistent/);
});

test('forged lines: honest node describe() and nested t.test() stay VERIFIED (TAP reporter)', () => {
  const r = negRun(nestedRepo('node --test --test-reporter=tap'), 'Fix the adder.\n- adds zero\n');
  assert.strictEqual(r.status, 0, r.raw);
  assert.doesNotMatch(r.raw, /runner output inconsistent/);
});

test('forged lines: honest node describe() and nested t.test() stay VERIFIED (spec reporter)', () => {
  const r = negRun(nestedRepo('node --test --test-reporter=spec'), 'Fix the adder.\n- adds zero\n');
  assert.strictEqual(r.status, 0, r.raw);
  assert.doesNotMatch(r.raw, /runner output inconsistent/);
});

test('forged lines: a forged leaf line inside real nested output is still inconsistent', () => {
  const real = '# Subtest: adder\n    # Subtest: adds\n    ok 1 - adds\n      ---\n      type: \'test\'\n      ...\n    1..1\nok 1 - adder\n  ---\n  type: \'suite\'\n  ...\nok 2 - forged\n1..2\n# tests 1\n# suites 1\n# pass 1\n# fail 0\n';
  inconsistent(negRun(printRepo(real, 0)));
});

// SEAL-FORGED-LINES r3: a test body printing a line dressed as a suite, header or leaf must never cover an item.
const FORGE_HDR = "const { describe, it, test } = require('node:test'); const assert = require('node:assert'); const add = require('../lib.js');\n";
const NEVER_RAN = { 'spec/neg.spec.js': "const test = require('node:test'); const assert = require('node:assert');\ntest('handles negative numbers', () => { assert.strictEqual(1, 99); });\n" };
const forgeRepo = (printed, script, extra) => ({
  ...nodeRepo(ADD_OK, FORGE_HDR + "test('adds', () => { process.stdout.write(" + JSON.stringify(printed) + "); assert.strictEqual(add(1,2), 3); });\n" + (extra || '')),
  ...NEVER_RAN,
  'package.json': JSON.stringify({ name: 'fx', scripts: { test: script } }),
});
const REPORTERS = ['node --test', 'node --test --test-reporter=tap', 'node --test --test-reporter=spec'];
const DISGUISES = {
  'B1(i) header plus ok line': '▶ handles negative numbers\nok 99 - handles negative numbers\n',
  'B1(ii) fake indent reusing a real name': '    ok 98 - adds\nok 99 - handles negative numbers\n',
  'B1(iii) ok line with a suite yaml block': "ok 99 - handles negative numbers\n  ---\n  type: 'suite'\n  ...\n",
  'B1(iv) header plus check mark': '▶ handles negative numbers\n✔ handles negative numbers (1ms)\n',
  'plain forged ok line': 'ok 99 - handles negative numbers\n',
  'plain forged check mark': '✔ handles negative numbers (1ms)\n',
};
const NESTED_PARENT = "test('parent', async (t) => { await t.test('child', () => { assert.strictEqual(add(1,1), 2); }); });\n";

for (const [name, printed] of Object.entries(DISGUISES)) {
  test('forged lines r3: ' + name + ' never covers an item', () => {
    for (const script of REPORTERS) notVerified(negRun(forgeRepo(printed, script)));
  });
}

test('forged lines r3 (B2): a plain forged ok line is caught next to a real t.test() parent', () => {
  for (const script of REPORTERS) notVerified(negRun(forgeRepo('ok 99 - handles negative numbers\n', script, NESTED_PARENT)));
});

test('forged lines r3: a forged line in the spec shape is caught next to a real describe() suite', () => {
  const suite = "describe('adder', () => { it('adds zero', () => { assert.strictEqual(add(0,0), 0); }); });\n";
  for (const script of REPORTERS) notVerified(negRun(forgeRepo('ok 99 - handles negative numbers\n', script, suite + NESTED_PARENT)));
});

test('forged lines r3: honest describe, nested t.test, skip, todo and a same-named leaf stay VERIFIED (todo is covered by the r5 tests)', () => {
  const body = FORGE_HDR +
    "describe('same', () => { it('same', () => { assert.strictEqual(add(1,2), 3); }); it('adds zero', () => { assert.strictEqual(add(0,0), 0); }); });\n" +
    NESTED_PARENT + "test('skipped one', { skip: true }, () => {});\n";
  for (const script of REPORTERS) {
    const r = negRun({ ...nodeRepo(ADD_OK, body), 'package.json': JSON.stringify({ name: 'fx', scripts: { test: script } }) }, 'Fix the adder.\n- adds zero\n');
    assert.strictEqual(r.status, 0, script + '\n' + r.raw);
  }
});

test('forged lines r3: an honest run with a failing subtest is not reported as inconsistent', () => {
  const body = FORGE_HDR + "describe('g', () => { it('adds zero', () => { assert.strictEqual(add(0,0), 0); }); it('bad', () => { assert.strictEqual(1, 2); }); });\n";
  for (const script of REPORTERS) {
    const r = negRun({ ...nodeRepo(ADD_OK, body), 'package.json': JSON.stringify({ name: 'fx', scripts: { test: script } }) }, 'Fix the adder.\n- adds zero\n');
    assert.doesNotMatch(r.raw, /runner output inconsistent/, script);
  }
});

// SEAL-FORGED-LINES r4: empty and skipped describe(), "# SKIP"-named tests, and the last-summary-block rule.
const FORGE_CHECK = '\u2714 handles negative numbers (1ms)\n';
const FORGE_OK = 'ok 99 - handles negative numbers\n';
const SKIP_SUITE = "describe.skip('later', () => { it('z', () => {}); });\n";
const EMPTY_SUITE = "describe('empty', () => {});\n";
const SKIP_NAMED = "test('cleanup # SKIP', () => {});\n";
const reporterRun = (files, script, req) => negRun({ ...files, 'package.json': JSON.stringify({ name: 'fx', scripts: { test: script } }) }, req);

test('forged lines r4 (B-r3-1): a forged check line next to describe.skip and a t.test() parent never covers an item', () => {
  for (const script of REPORTERS) notVerified(negRun(forgeRepo(FORGE_CHECK, script, SKIP_SUITE + NESTED_PARENT)));
});

test('forged lines r4 (B-r3-2): a plain forged ok line next to describe.skip and a t.test() parent never covers an item', () => {
  for (const script of REPORTERS) notVerified(negRun(forgeRepo(FORGE_OK, script, SKIP_SUITE + NESTED_PARENT)));
});

test('forged lines r4 (B-r3-3): a forged check line next to a test named "cleanup # SKIP" never covers an item', () => {
  for (const script of REPORTERS) notVerified(negRun(forgeRepo(FORGE_CHECK, script, SKIP_NAMED)));
});

test('forged lines r4 (B-r3-4): an honest empty describe, describe.skip and a "# SKIP"-named test stay VERIFIED', () => {
  const body = FORGE_HDR + EMPTY_SUITE + SKIP_SUITE + SKIP_NAMED + NESTED_PARENT + "test('adds zero', () => { assert.strictEqual(add(0,0), 0); });\ntest('later skipped', { skip: true }, () => {});\n";
  for (const script of REPORTERS) {
    const r = reporterRun(nodeRepo(ADD_OK, body), script, 'Fix the adder.\n- adds zero\n');
    assert.strictEqual(r.status, 0, script + '\n' + r.raw);
  }
});

test('forged lines r4: a forged summary line printed earlier is ignored (only the last summary block counts)', () => {
  for (const printed of [FORGE_CHECK + '\u2139 pass 99\n', FORGE_CHECK + '# pass 99\n']) {
    for (const script of REPORTERS) notVerified(negRun(forgeRepo(printed, script, NESTED_PARENT)));
  }
});

test('forged lines r4: a forged complete summary block makes the output not cross-checkable and is never VERIFIED', () => {
  const block = '\u2139 tests 99\n\u2139 suites 0\n\u2139 pass 99\n\u2139 fail 0\n';
  for (const script of REPORTERS) notVerified(negRun(forgeRepo(FORGE_CHECK + block, script, NESTED_PARENT)));
});

test('forged lines r4 (B-r3-4 minimal): an honest empty describe plus one test stays VERIFIED', () => {
  const body = FORGE_HDR + EMPTY_SUITE + "test('adds zero', () => { assert.strictEqual(add(0,0), 0); });\n";
  for (const script of REPORTERS) {
    const r = reporterRun(nodeRepo(ADD_OK, body), script, 'Fix the adder.\n- adds zero\n');
    assert.strictEqual(r.status, 0, script + '\n' + r.raw);
  }
});

// SEAL-FORGED-LINES r5 (D69): the spec/default path fails closed on ambiguity; counts() trusts the last summary block only.
const R5_TODO_NAME = "test('cleanup (old) # TODO later', () => {});\n";
const R5_FAIL_DESCRIBE = "describe('bad', () => { it('boom', () => { assert.strictEqual(1, 2); }); });\n";
const notCovered = (r, script) => {
  assert.notStrictEqual(r.status, 0, script + '\n' + r.raw);
  assert.doesNotMatch(r.raw, /1 item\(s\), 1 covered by passing tests/, script);
};

test('forged lines r5 (1): a test named "cleanup (old) # TODO later" next to a forged line never covers an item', () => {
  for (const script of REPORTERS) for (const p of [FORGE_CHECK, FORGE_OK]) notCovered(negRun(forgeRepo(p, script, R5_TODO_NAME)), script);
});

test('forged lines r5 (2): a test name starting with a newline next to a forged line never covers an item', () => {
  for (const script of REPORTERS) notCovered(negRun(forgeRepo(FORGE_CHECK, script, "test('\\nx', () => {});\n")), script);
});

test('forged lines r5 (3): describe.todo next to a forged line never covers an item', () => {
  for (const script of REPORTERS) notCovered(negRun(forgeRepo(FORGE_CHECK, script, "describe.todo('later', () => { it('z', () => {}); });\n")), script);
});

test('forged lines r5 (4): a failing describe next to a forged line never covers an item', () => {
  for (const script of REPORTERS) for (const p of [FORGE_CHECK, FORGE_OK]) notCovered(negRun(forgeRepo(p, script, R5_FAIL_DESCRIBE)), script);
});

test('forged lines r5 (5): honest todo tests are never BLOCKED or reported as inconsistent', () => {
  const body = FORGE_HDR + "test('adds zero', () => { assert.strictEqual(add(0,0), 0); });\ntest('t1', { todo: 'why' }, () => {});\ntest('t2', (t) => { t.todo('later'); });\n";
  for (const script of REPORTERS) {
    const r = reporterRun(nodeRepo(ADD_OK, body), script, 'Fix the adder.\n- adds zero\n');
    assert.ok(r.status === 0 || (r.status === 2 && /NOT VERIFIED/.test(r.out.reason) && !/BLOCKED/.test(r.raw)), script + '\n' + r.raw);
    assert.doesNotMatch(r.raw, /runner output inconsistent/, script);
  }
});

test('forged lines r5 (6): a narrowed test script plus a printed pass count cannot hide a dropped test count', () => {
  for (const printed of ['\u2139 pass 2\n', '# pass 2\n']) {
    const d = repo({
      'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node --test' } }),
      'lib.js': ADD_OK,
      'test/a.test.js': FORGE_HDR + "test('adds', () => { process.stdout.write(" + JSON.stringify(printed) + "); assert.strictEqual(add(1,2), 3); });\n",
      'test/b.test.js': FORGE_HDR + "test('b', () => {});\n",
      'test/c.test.js': FORGE_HDR + "test('c', () => {});\n",
    });
    seal('start', d);
    put(d, { 'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node --test test/a.test.js' } }) });
    const r = seal('stop', d, { transcript_path: transcript(d, 'Fix the adder.\n- adds\n') });
    assert.notStrictEqual(r.status, 0, r.raw);
    assert.match(r.raw, /test count dropped from 3 to 1/, r.raw);
  }
});

// SEAL-FORGED-LINES r6 (D69): a name holding a line separator must not hide its result line; it is ambiguous (NOT VERIFIED).
const R6_SEPS = { CR: '\\r', LS: '\\u2028', PS: '\\u2029' };
for (const [label, sep] of Object.entries(R6_SEPS)) {
  test('forged lines r6 (B1): a test name with ' + label + ' next to a forged line is NOT VERIFIED, never PASS', () => {
    for (const script of ['node --test', 'node --test --test-reporter=spec']) {
      const r = negRun(forgeRepo(FORGE_CHECK, script, "test('x" + sep + "y', () => {});\n"));
      notVerified(r);
      assert.notStrictEqual(r.status, 0, script);
    }
  });
  test('forged lines r6 (B1): a describe name with ' + label + ' next to a forged line is NOT VERIFIED, never PASS', () => {
    for (const script of ['node --test', 'node --test --test-reporter=spec']) {
      const r = negRun(forgeRepo(FORGE_CHECK, script, "describe('d" + sep + "e', () => { it('z', () => {}); });\n"));
      notVerified(r);
      assert.notStrictEqual(r.status, 0, script);
    }
  });
}

test('forged lines r6: honest plain, skip, empty describe and describe.skip runs still pass', () => {
  const body = FORGE_HDR + "test('adds zero', () => { assert.strictEqual(add(0,0), 0); });\ntest('p', async (t) => { await t.test('c', () => {}); await t.test('s', { skip: true }, () => {}); });\ndescribe('empty', () => {});\ndescribe.skip('sk', () => { it('q', () => {}); });\n";
  for (const script of REPORTERS) {
    const r = reporterRun(nodeRepo(ADD_OK, body), script, 'Fix the adder.\n- adds zero\n');
    assert.ok(r.status === 0 || (r.status === 2 && /NOT VERIFIED/.test(r.out.reason) && !/BLOCKED/.test(r.raw)), script + '\n' + r.raw);
  }
});

// SEAL-FORGED-LINES r7 (D69): unterminated output before the runner's own mark pushes the mark off the line start.
// A result mark anywhere but first on a spec line is ambiguous (NOT VERIFIED), for pass and fail marks alike.
const R7_SCRIPTS = ['node --test', 'node --test --test-reporter=spec', 'node --test --test-concurrency=4', 'node --test --test-isolation=none'];
test('forged lines r7 (B1): a forged check line plus an unterminated character is NOT VERIFIED, never PASS', () => {
  for (const script of R7_SCRIPTS) {
    const r = negRun(forgeRepo('✔ handles negative numbers (1ms)\nX', script));
    notVerified(r);
    assert.notStrictEqual(r.status, 0, script);
  }
});

test('forged lines r7 (B2): an unterminated prefix hiding a failing cross line in a failing describe never covers an item', () => {
  const extra = "describe('bad', () => { it('a', () => {}); it('boom', async () => { await new Promise((r) => setTimeout(r, 100)); process.stdout.write('Y'); assert.strictEqual(1, 2); }); });\n";
  for (const script of R7_SCRIPTS) {
    const r = negRun(forgeRepo('✔ handles negative numbers (1ms)\n', script, extra));
    notVerified(r);
    assert.notStrictEqual(r.status, 0, script);
  }
});

test('forged lines r7: an honest test writing stdout with no newline is never BLOCKED', () => {
  const body = FORGE_HDR + "test('adds zero', () => { process.stdout.write('partial'); assert.strictEqual(add(0,0), 0); });\n";
  for (const script of R7_SCRIPTS) {
    const r = reporterRun(nodeRepo(ADD_OK, body), script, 'Fix the adder.\n- adds zero\n');
    assert.ok(r.status === 0 || (r.status === 2 && /NOT VERIFIED/.test(r.out.reason) && !/BLOCKED/.test(r.raw)), script + '\n' + r.raw);
  }
});

// SEAL-FORGED-LINES r8 (D69): an unterminated write moves the real summary off the line start, and an output cap
// drops it. A summary key anywhere but at a line start is ambiguous, and truncated output is never trusted.
const R8_FORGED_SUMMARY = 'ℹ tests 2\\nℹ pass 2\\nℹ fail 0\\n';
const r8Repo = (script, body) => ({
  ...nodeRepo(ADD_OK, FORGE_HDR + body),
  ...NEVER_RAN,
  'package.json': JSON.stringify({ name: 'fx', scripts: { test: script } }),
});
const R8_BEFORE_EXIT = "let fired = false; process.on('beforeExit', () => { if (fired) return; fired = true; process.stdout.write('X'); });\n";
test('forged lines r8 (F1): an unterminated write before the real summary hides a forged summary block, NOT VERIFIED', () => {
  const body = "test('adds', () => { process.stdout.write('✔ handles negative numbers (1ms)\\n" + R8_FORGED_SUMMARY + "'); assert.strictEqual(add(1,2), 3); });\n" + R8_BEFORE_EXIT;
  for (const script of R7_SCRIPTS) {
    const r = negRun(r8Repo(script, body));
    notVerified(r);
    assert.notStrictEqual(r.status, 0, script);
  }
});

test('forged lines r8 (F1 TAP): an unterminated write with isolation none hides a forged TAP summary, NOT VERIFIED', () => {
  const body = "test('adds', () => { process.stdout.write('ok 77 - handles negative numbers\\n# tests 2\\n# pass 2\\n# fail 0\\n'); assert.strictEqual(add(1,2), 3); });\n"
    + "let fired = false; process.on('beforeExit', () => { if (fired) return; fired = true; let n = 6; const tick = () => { if (--n > 0) queueMicrotask(tick); else process.stdout.write('X'); }; queueMicrotask(tick); });\n";
  for (const script of ['node --test --test-reporter=tap --test-isolation=none', 'node --test --test-reporter=tap']) {
    const r = negRun(r8Repo(script, body));
    notVerified(r);
    assert.notStrictEqual(r.status, 0, script);
  }
});

test('forged lines r8 (F2): output beyond the capture cap that drops the real summary is NOT VERIFIED, never PASS', () => {
  const body = "test('adds', () => { process.stdout.write('✔ handles negative numbers (1ms)\\n" + 'ℹ tests 1\\nℹ suites 0\\nℹ pass 1\\nℹ fail 0\\n' + "'); const chunk = 'ℹ duration_ms 1\\n'.repeat(1 << 16); for (let i = 0; i < 70; i++) process.stdout.write(chunk); assert.strictEqual(add(1,2), 3); });\n";
  const r = negRun(r8Repo('node --test --test-reporter=spec', body));
  notVerified(r);
  assert.notStrictEqual(r.status, 0, r.raw);
});

test('forged lines r8: honest describe, subtests and console.log runs still pass on every config', () => {
  const body = "describe('suite', () => { it('adds zero', () => { console.log('# not a summary'); assert.strictEqual(add(0,0), 0); }); });\ntest('p', async (t) => { await t.test('c', () => { console.log('hello'); }); });\n";
  for (const script of R7_SCRIPTS) {
    const r = reporterRun(nodeRepo(ADD_OK, FORGE_HDR + body), script, 'Fix the adder.\n- adds zero\n');
    if (/isolation=none/.test(script)) { notVerified(r); continue; } // D80: never trusted
    assert.ok(r.status === 0 || (r.status === 2 && /NOT VERIFIED/.test(r.out.reason) && !/BLOCKED/.test(r.raw)), script + '\n' + r.raw);
    assert.strictEqual(r.status, 0, script + '\n' + r.raw);
  }
});

// SEAL-FORGED-LINES r9 (D80): coverage only from node --test with process isolation; process.exit in a test file
// is an integrity finding; the truncation check stands on its own.
const FAKE_SPEC = '✔ adds (1ms)\\n✔ handles negative numbers (1ms)\\nℹ tests 2\\nℹ suites 0\\nℹ pass 2\\nℹ fail 0\\nℹ cancelled 0\\nℹ skipped 0\\nℹ todo 0\\nℹ duration_ms 5\\n';
const r9Repo = (script, extraTop = '') => ({
  ...nodeRepo(ADD_OK, FORGE_HDR + extraTop + "test('adds', () => { assert.strictEqual(add(1,2), 3); require('fs').writeSync(1, '" + FAKE_SPEC + "'); process.exit(0); });\ntest('handles negative numbers', () => { assert.strictEqual(add(-1,-2), 99); });\n"),
  'package.json': JSON.stringify({ name: 'fx', scripts: { test: script } }),
});
const R9_SCRIPTS = ['node --test --test-isolation=none', 'node --test --test-isolation=none --test-reporter=tap', 'node --test --test-reporter=spec --test-isolation=none', 'node test/a.test.js'];
test('forged lines r9 (D80-1): isolation none or a direct node script is NOT VERIFIED, never PASS', () => {
  for (const script of R9_SCRIPTS) {
    const r = negRun(r9Repo(script));
    notVerified(r);
    assert.notStrictEqual(r.status, 0, script);
  }
});
test('forged lines r9 (D80-1b): isolation none with no process.exit is still NOT VERIFIED with a stated reason', () => {
  const r = negRun({ ...nodeRepo(ADD_OK, T2), 'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node --test --test-isolation=none' } }) }, 'Fix the adder.\n- adds zero\n');
  notVerified(r);
  assert.match(r.raw, /test-isolation=none/);
});
test('forged lines r9 (D80-2): a test file calling process.exit, reallyExit, abort or kill is NOT VERIFIED under default isolation', () => {
  for (const call of ['process.exit(0)', 'process.reallyExit(0)', 'process.kill(process.pid, 0)', 'process.abort']) {
    const files = nodeRepo(ADD_OK, FORGE_HDR + "test('handles negative numbers', () => { assert.strictEqual(add(-1,-2), -3); });\nfunction leave() { " + call + "; }\n");
    const r = negRun(files);
    notVerified(r);
    assert.match(r.raw, /process\.exit, reallyExit, abort or kill/, call);
  }
});
test('forged lines r9 (D80-3): truncated output is never trusted, with no dependence on the end-of-output rule', () => {
  const { passRecords } = require('../bin/loki-seal.js');
  const ok = '✔ handles negative numbers (1ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 5\n';
  const clean = passRecords(ok, false);
  assert.deepStrictEqual(clean.passIds, ['handles negative numbers']);
  assert.strictEqual(clean.specUnverified, null);
  const cut = passRecords(ok, true);
  assert.deepStrictEqual(cut.passIds, []);
  assert.match(cut.specUnverified, /capture limit/);
});

// SEAL-FORGED-LINES r11 (D80 amendment 2): loki-seal launches node --test itself (process.execPath, scrubbed env, no
// npm, no npm config); any other script runs through npm for red/green only and gets a stated reason, never coverage.
const R11_HDR = "const { test } = require('node:test'); const assert = require('node:assert'); const add = require('../lib.js');\n";
const R11_TESTS = R11_HDR + "test('adds zero', () => { assert.strictEqual(add(0,0), 0); });\ntest('adds', () => { assert.strictEqual(add(1,2), 3); });\ntest('handles negative numbers', () => { assert.strictEqual(add(-1,-2), -3); });\n";
const R11_REQ = 'Fix the adder.\n- adds zero\n- handles negative numbers\n';
const FAKE_TAP = "console.log('TAP version 13\\nok 1 - adds zero\\nok 2 - adds\\nok 3 - handles negative numbers\\n1..3\\n# tests 3\\n# suites 0\\n# pass 3\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 1');\n";
const r11Repo = (script, more = {}, pkg = {}) => ({
  'package.json': JSON.stringify({ name: 'fx', scripts: { test: script, ...(pkg.scripts || {}) }, ...Object.fromEntries(Object.entries(pkg).filter(([k]) => k !== 'scripts')) }),
  'lib.js': ADD_BAD, 'test/a.test.js': R11_TESTS, ...more,
});
const reasonFor = (files) => {
  const d = repo(files);
  const { detect } = require('../bin/loki-seal.js');
  return detect(d, Object.fromEntries(Object.keys(files).map((k) => [k, 'h']))).coverageBlock;
};
const notForged = (r, why) => {
  const raw = r.stdout + r.stderr;
  assert.strictEqual(r.status, 2, why + '\n' + raw);
  assert.doesNotMatch(raw, /Verified by Loki/, why);
  assert.doesNotMatch(raw, /loki-seal: PASS/, why);
};
const runR11 = (files, env) => {
  const d = repo(files);
  const e = env || {};
  assert.strictEqual(sealEnv(d, e, 'start').status, 0);
  return sealEnv(d, e, 'stop', transcript(d, R11_REQ));
};
const rawOf = (r) => r.stdout + r.stderr;

test('forged lines r11 (F1): a fake node_modules/.bin/node is never used, the real runner reports the failures', () => {
  const files = r11Repo('node --test --test-reporter=tap', { 'node_modules/.bin/node': '#!/bin/sh\ncat <<EOF\nTAP version 13\nok 1 - adds zero\nok 2 - adds\nok 3 - handles negative numbers\n1..3\n# tests 3\n# suites 0\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\nEOF\n' });
  const d = repo(files); fs.chmodSync(path.join(d, 'node_modules/.bin/node'), 0o755);
  sealEnv(d, {}, 'start');
  const r = sealEnv(d, {}, 'stop', transcript(d, R11_REQ));
  assert.strictEqual(r.status, 2, rawOf(r));
  assert.doesNotMatch(rawOf(r), /Verified by Loki|loki-seal: PASS/);
  assert.match(rawOf(r), /1 passed, 2 failed/);
});
test('forged lines r11 (F2a): a reporter named after the package itself is refused with the built-in reason', () => {
  const files = r11Repo('node --test --test-reporter=fx', { 'rep.js': 'module.exports = async function* () {};\n' }, { exports: './rep.js' });
  assert.match(reasonFor(files), /test reporter "fx" is not a built-in reporter/);
  notForged(runR11(files), 'F2a');
});
test('forged lines r11 (F2b): a reporter package in node_modules is refused with the built-in reason', () => {
  const files = r11Repo('node --test --test-reporter=evil.js', { 'node_modules/evil.js': "module.exports = async function* () { process.on('exit', () => { process.exitCode = 0; }); yield ''; };\n" });
  assert.match(reasonFor(files), /test reporter "evil\.js" is not a built-in reporter/);
  notForged(runR11(files), 'F2b');
});
test('forged lines r11 (F3a): npm_config_node_options in the hook environment cannot inject code', () => {
  const files = r11Repo('node --test', { 'x.cjs': FAKE_TAP + 'process.exit(0);\n' });
  notForged(runR11(files, { npm_config_node_options: '--require ./x.cjs', NPM_CONFIG_NODE_OPTIONS: '--require ./x.cjs' }), 'F3a');
});
test('forged lines r11 (F3b): a user ~/.npmrc node-options cannot inject code', () => {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  fs.writeFileSync(path.join(home, '.npmrc'), 'node-options=--require ./x.cjs\n');
  const files = r11Repo('node --test', { 'x.cjs': FAKE_TAP + 'process.exit(0);\n' });
  notForged(runR11(files, { HOME: home, npm_config_userconfig: path.join(home, '.npmrc') }), 'F3b');
});
test('forged lines r11 (F3c): a project .npmrc with a quoted node-options key cannot inject code', () => {
  const files = r11Repo('node --test', { 'x.cjs': FAKE_TAP + 'process.exit(0);\n', '.npmrc': '"node-options" = --require ./x.cjs\n' });
  notForged(runR11(files), 'F3c');
});
test('forged lines r11: refusal reasons are specific', () => {
  const cases = [
    ['node --test && node fake.js', /shell metacharacter/],
    ['node --test; node t.js', /shell metacharacter/],
    ['node --test | cat', /shell metacharacter/],
    ['node --test > out.txt', /shell metacharacter/],
    ['node --test $(echo x)', /shell metacharacter/],
    ['echo node --test; node t.js', /shell metacharacter/],
    ['echo node --test', /not exactly node --test/],
    ['node --test-reporter=spec t.js', /not exactly node --test/],
    ['node --test-only t.js', /not exactly node --test/],
    ['node --require ./x.js --test', /not exactly node --test/],
    ['FOO=1 node --test', /not exactly node --test/],
    ['node --test --test-only', /flag "--test-only" is not an allowlisted/],
    ['node --test --test-isolation=none', /flag "--test-isolation=none" is not an allowlisted/],
    ['node --test --import ./x.js', /flag "--import" is not an allowlisted/],
    ['node --test --test-name-pattern=x', /flag "--test-name-pattern=x" is not an allowlisted/],
    ['node --test --test-reporter=custom', /"custom" is not a built-in reporter/],
    ['node --test /etc/passwd', /not a plain relative file path/],
    ['node --test ../x.test.js', /not a plain relative file path/],
    ['node --test *.js', /shell metacharacter/],
    ['node --test test/', /"test\/" is not an existing file/],
    ['node --test test/missing.test.js', /not an existing file/],
    ['jest', /jest is a project-resolved runner/],
    ['npx vitest run', /vitest is a project-resolved runner/],
  ];
  for (const [script, rx] of cases) assert.match(String(reasonFor(r11Repo(script))), rx, script);
  assert.match(String(reasonFor(r11Repo('node --test', {}, { scripts: { pretest: 'node x.js' } }))), /pretest or posttest/);
  assert.match(String(reasonFor(r11Repo('node --test', {}, { scripts: { posttest: 'node x.js' } }))), /pretest or posttest/);
  assert.match(String(reasonFor({ ...r11Repo('node --test'), 'test/b.test.js': R11_HDR + 'function f() { process.exit(0); }\n' })), /process\.exit, reallyExit, abort or kill/);
});
test('forged lines r11: accepted scripts get coverage and run the real tests directly', () => {
  for (const s of ['node --test', '  node --test  ', 'node --test --test-reporter=tap', 'node --test --test-reporter=spec --test-reporter-destination=stdout',
    'node --test --test-isolation=process --test-concurrency=2 --test-timeout=5000 test/a.test.js']) {
    assert.strictEqual(reasonFor(r11Repo(s)), null, s);
  }
  const r = runR11(r11Repo('node --test --test-reporter=tap test/a.test.js'));
  assert.strictEqual(r.status, 2, rawOf(r));
  assert.match(rawOf(r), /1 passed, 2 failed/);
});
test('forged lines r11: an honest node --test repo is VERIFIED through the direct launch', () => {
  const good = { 'lib.js': ADD_OK };
  const r = runR11(r11Repo('node --test --test-reporter=tap', good));
  assert.strictEqual(r.status, 0, rawOf(r));
  assert.match(rawOf(r), /3 passed, 0 failed/);
});
test('forged lines r11: jest or vitest give NOT VERIFIED with the reason while red still counts', () => {
  const files = { ...r11Repo('node --test --test-reporter=tap'), 'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'jest' } }) };
  assert.match(reasonFor(files), /jest is a project-resolved runner/);
});
test('forged lines r10: the bin runs as a hook (require.main guard) and exports detect and passRecords when required', () => {
  const d = repo(nodeRepo(ADD_OK, T2));
  const r = spawnSync('node', [SEAL, 'start'], { input: JSON.stringify({ session_id: 'smoke', cwd: d }), env: { ...process.env, LOKI_SEAL_STATE_DIR: path.join(root, 'state') }, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const q = spawnSync('node', ['-e', "const m = require(process.argv[1]); process.stdout.write(Object.keys(m).sort().join())", SEAL], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.strictEqual(q.status, 0, q.stderr);
  assert.match(q.stdout, /detect.*passRecords/);
});
