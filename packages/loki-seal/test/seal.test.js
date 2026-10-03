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
  const d = repo(nodeRepo(ADD_OK, T_NEG.replace('add(-1, -2), -3', 'add(-1, -2), 99')));
  seal('start', d);
  const r = seal('stop', d, { transcript_path: transcript(d, REQ_NEG) });
  assert.strictEqual(r.status, 2, r.raw);
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
  assert.match(r.stdout, /NOT VERIFIED \(released after 1 blocks\)/);
});

test('contract: the module has no network or process imports', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'contract.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"](?:https?|net|dns|child_process)['"]\)|\bfetch\s*\(/);
});
