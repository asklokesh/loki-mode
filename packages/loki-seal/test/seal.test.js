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
  assert.deepStrictEqual(passing('✔ a b (0.3ms)\n  ✔ c d (1ms)\n﹣ e f (0.1ms) # SKIP\n✖ g h (1ms)\n').sort(), ['a b', 'c d']);
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
