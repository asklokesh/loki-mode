#!/usr/bin/env node
'use strict';
// loki-seal: refuse "done" while tests are red or were deleted, skipped or weakened.
// Usage: loki-seal start | stop   (Claude Code hook JSON on stdin). No model calls, no dependencies.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { deriveContract, mapContract, ASSERT } = require('./contract.js');

const mode = process.argv[2];
let ctx = { input: {}, root: process.cwd() };
const REPO = 'https://github.com/asklokesh/loki-mode';
const MAX_BLOCKS = 5; // safety valve: never trap a session in an endless stop loop
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'venv', '.venv', 'dist', 'build', '__pycache__', '.loki']);
const CODE = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs)$/;

const isTest = (p) => CODE.test(p) && (/(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /(^|\/)test_[^/]*\.py$/.test(p) || /_test\.(py|go)$/.test(p));
const isCI = (p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || /^(\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|Jenkinsfile)$/.test(p);

const RX = {
  decl: /^\s*(?:(?:it|test|describe|suite)(?:\.\w+)*\s*\(|(?:async\s+)?def\s+test_|func\s+Test\w*\(|#\[(?:tokio::)?test\b)/gm,
  skip: /\.(?:skip|todo|only)\s*\(|\b(?:xit|xtest|xdescribe)\s*\(|\bskip\s*:\s*true|@pytest\.mark\.(?:skip|skipif|xfail)|\bpytest\.(?:skip|xfail)\s*\(|@unittest\.(?:skip\w*|expectedFailure)|\bt\.Skip\w*\(|#\[ignore/g,
  assert: new RegExp(ASSERT.source, 'gm'), // one assertion definition shared with the contract module
};
const count = (s, rx) => (s.match(rx) || []).length;
const CI_TEST_LINE = /test|pytest|jest|vitest|cargo|lint|check/i;
const CI_SOFTEN = /continue-on-error:\s*true|\|\|\s*true|\bif:\s*false/;

const skippedDirs = [];
const isTestDir = (p) => /(^|\/)(tests?|__tests__)(\/|$)/.test(p) || p.startsWith('.github/');

function walk(root, rel = '', out = {}) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) {
    // An unreadable directory outside test paths (for example a root-owned volume) is skipped and noted.
    if ((e.code === 'EACCES' || e.code === 'EPERM') && !isTestDir(rel)) { skippedDirs.push(rel); return out; }
    throw e;
  }
  for (const e of entries) {
    const p = rel ? rel + '/' + e.name : e.name;
    if (e.isSymbolicLink()) { if (isTest(p) || isCI(p)) out[p] = 'SYMLINK ' + fs.readlinkSync(path.join(root, p)); } // never followed
    else if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(root, p, out); }
    else if (e.isFile() && (isTest(p) || isCI(p)) && fs.lstatSync(path.join(root, p)).size < 1e6) out[p] = fs.readFileSync(path.join(root, p), 'utf8');
  }
  return out;
}

function gitHead(root) {
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  const ls = g('ls-tree', '-r', '--name-only', 'HEAD');
  if (ls.status !== 0) return null;
  const out = {};
  for (const p of ls.stdout.split('\n').filter((x) => x && (isTest(x) || isCI(x)))) out[p] = g('show', 'HEAD:' + p).stdout;
  return out;
}

function scan(base, cur) {
  const f = [];
  for (const [p, old] of Object.entries(base)) {
    if (isCI(p)) {
      if (!(p in cur)) { f.push(`CI config deleted: ${p}`); continue; }
      if (cur[p] === old) continue;
      const nu = new Set(cur[p].split('\n').map((l) => l.trim()));
      const gone = old.split('\n').map((l) => l.trim()).filter((l) => l && !nu.has(l) && CI_TEST_LINE.test(l));
      const was = new Set(old.split('\n').map((l) => l.trim()));
      const soft = cur[p].split('\n').map((l) => l.trim()).filter((l) => !was.has(l) && CI_SOFTEN.test(l));
      if (gone.length || soft.length) f.push(`CI config weakened in ${p} (${gone.length} test/check line(s) removed, ${soft.length} softened)`);
      continue;
    }
    if (!(p in cur)) { f.push(`removed test file: ${p}`); continue; }
    if (cur[p] === old) continue;
    const dd = count(old, RX.decl) - count(cur[p], RX.decl);
    if (dd > 0) f.push(`removed ${dd} test declaration(s) in ${p}`);
    const da = count(old, RX.assert) - count(cur[p], RX.assert);
    if (da > 0) f.push(`assertion count dropped by ${da} in ${p}`);
  }
  for (const [p, s] of Object.entries(cur)) {
    if (!isTest(p)) continue;
    const up = count(s, RX.skip) - (p in base ? count(base[p], RX.skip) : 0);
    if (up > 0) f.push(`added ${up} skip/xfail/only marker(s) in ${p}`);
  }
  return f;
}

function treeHash(files) {
  const h = crypto.createHash('sha256');
  for (const p of Object.keys(files).filter(isTest).sort()) h.update(p + '\0' + crypto.createHash('sha256').update(files[p]).digest('hex') + '\n');
  return h.digest('hex').slice(0, 16);
}

function detect(root, files) {
  const has = (f) => fs.existsSync(path.join(root, f));
  if (has('package.json')) {
    let s = '';
    try { s = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test || ''; } catch { /* no script */ }
    if (s && !/no test specified/.test(s)) {
      const kind = /vitest/.test(s) ? 'vitest' : /jest/.test(s) ? 'jest' : /node\s+--test/.test(s) ? 'node --test' : 'script';
      return { name: `npm test (${kind})`, cmd: ['npm', 'test', '--silent'] };
    }
  }
  if (has('go.mod')) return { name: 'go test', cmd: ['go', 'test', './...', '-v'] };
  if (has('Cargo.toml')) return { name: 'cargo test', cmd: ['cargo', 'test'] };
  if (['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py'].some(has) || Object.keys(files).some((p) => p.endsWith('.py'))) {
    return { name: 'pytest', cmd: ['python3', '-m', 'pytest', '-q'] };
  }
  return null;
}

function counts(out) {
  const sum = (rx, one) => [...out.matchAll(rx)].reduce((a, m) => a + (one ? 1 : +m[1]), 0);
  if (/^\s*[\u2139#]\s*pass\s+\d+/m.test(out)) return { pass: sum(/^\s*[\u2139#]\s*pass\s+(\d+)/gm), fail: sum(/^\s*[\u2139#]\s*fail\s+(\d+)/gm) };
  if (/^\s*--- (PASS|FAIL)/m.test(out)) return { pass: sum(/^\s*--- (PASS)/gm, 1), fail: sum(/^\s*--- (FAIL)/gm, 1) };
  return { pass: sum(/(\d+) passed/g), fail: sum(/(\d+) failed/g) };
}

function stateDir() {
  const dir = process.env.LOKI_SEAL_STATE_DIR || (process.env.CLAUDE_PLUGIN_DATA && path.join(process.env.CLAUDE_PLUGIN_DATA, 'state')) || path.join(os.homedir(), '.loki-seal', 'state');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`state dir is a symlink or not a directory: ${dir}`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`state dir not owned by the current user: ${dir}`);
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
  return dir;
}

function statePath(input, root) {
  return path.join(stateDir(), crypto.createHash('sha1').update(root + '\0' + (input.session_id || '')).digest('hex') + '.json');
}

function writeState(sp, obj) { // exclusive create of a temp name, then atomic rename
  const tmp = `${sp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, sp);
}

function prune(dir) {
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    try { const st = fs.lstatSync(fp); if (st.isFile() && Date.now() - st.mtimeMs > 7 * 864e5) fs.unlinkSync(fp); } catch { /* best effort */ }
  }
}

function failing(out) {
  const ids = new Set();
  for (const m of out.matchAll(/^\s*(?:not ok \d+ - |\u2716 )(.+?)(?: \(\d[\d.]*ms\))?\s*$/gm)) if (!/^failing tests:?$/.test(m[1]) && !/^\d+$/.test(m[1])) ids.add(m[1]);
  for (const m of out.matchAll(/^FAILED (\S+?)(?: - .*)?$/gm)) ids.add(m[1]);
  for (const m of out.matchAll(/^\s*--- FAIL: (\S+)/gm)) ids.add(m[1]);
  for (const m of out.matchAll(/^test (\S+) \.\.\. FAILED/gm)) ids.add(m[1]);
  return [...ids];
}

function runSuite(root, runner, timeout) {
  const env = { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', PYTHONDONTWRITEBYTECODE: '1' };
  delete env.NODE_TEST_CONTEXT; // set when we are launched inside another node --test run
  return new Promise((resolve) => {
    let out = '', timedOut = false, done = false;
    const child = spawn(runner.cmd[0], runner.cmd.slice(1), { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, timeout);
    const add = (d) => { if (out.length < 1 << 26) out += d; };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const finish = (status, error) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ error: timedOut ? { code: 'ETIMEDOUT' } : error, status, ids: failing(out), ...counts(out), tail: out.trim().split('\n').slice(-15).join('\n') });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));
  });
}

async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* hook without JSON */ }
  const root = path.resolve(input.cwd || process.cwd());
  ctx = { input, root };
  const sp = statePath(input, root);
  const cur = walk(root);
  const runner = detect(root, cur);

  if (mode === 'start') {
    if (fs.existsSync(sp)) return; // resume or compact: keep the original baseline
    const b = runner ? await runSuite(root, runner, +process.env.LOKI_SEAL_START_TIMEOUT_MS || 120000) : null;
    const suite = b && !b.error ? { status: b.status, ids: b.ids, pass: b.pass, fail: b.fail } : null;
    writeState(sp, { files: cur, blocks: 0, suite });
    prune(path.dirname(sp));
    const msg = suite ? `loki-seal: baseline recorded, ${suite.pass + suite.fail} tests, ${Math.max(suite.ids.length, suite.fail)} failing`
      : 'loki-seal: baseline recorded (suite not run at start), file snapshot only';
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg } }));
    return;
  }
  if (mode !== 'stop') { process.stderr.write('usage: loki-seal start|stop\n'); process.exit(64); }

  let st = null;
  try { st = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { /* no SessionStart baseline */ }
  const head = st ? null : gitHead(root);
  const base = st ? st.files : head || cur;
  const suite0 = st && st.suite; // failing set at session start, if the suite could run then
  const baseKind = !st ? (head ? 'git HEAD' : 'none') : suite0 ? 'session start' : 'session start files only, suite not run at start';
  const findings = scan(base, cur);
  const tree = treeHash(cur);

  const r = runner ? await runSuite(root, runner, +process.env.LOKI_SEAL_TIMEOUT_MS || 270000) : null;
  const c = r || { pass: 0, fail: 0 };

  const problems = [...findings];
  let already = 0;
  if (runner) {
    const total = c.pass + c.fail;
    const baseTotal = suite0 ? suite0.pass + suite0.fail : 0;
    if (r.error) problems.push(`test run did not complete: ${r.error.code || r.error.message}`);
    else if (r.status !== 0 && total === 0) problems.push(`test run crashed or ran nothing (exit ${r.status}, 0 tests)`);
    else if (r.status !== 0) {
      if (!suite0) problems.push(`tests are red (exit ${r.status})`);
      else {
        already = Math.max(suite0.ids.length, suite0.fail);
        const fresh = r.ids.length ? r.ids.filter((i) => !suite0.ids.includes(i)) : null;
        const isNew = fresh ? fresh.length > 0 : r.fail > suite0.fail || suite0.status === 0 || r.fail === 0;
        if (isNew) problems.push(`new failing tests since session start${fresh && fresh.length ? ': ' + fresh.join(', ') : ''} (exit ${r.status})`);
      }
    } else if (total === 0) problems.push('no tests ran (zero is NOT VERIFIED)');
    if (suite0 && !r.error && total > 0 && total < baseTotal) problems.push(`test count dropped from ${baseTotal} to ${total}`);
  }

  // Delivery contract (A-04c): the request's acceptance items must each map to a passing test.
  const contract = deriveContract(input, root);
  // Contract findings live in their own list and their own release counter (st.cblocks) so a false
  // contract block can never drain the integrity/regression valve (st.blocks).
  const cproblems = [];
  let contractLine, contractNote = null;
  if (contract.status === 'unreadable') {
    contractLine = `contract: NOT VERIFIED: ${contract.reason}`;
    contractNote = `NOT VERIFIED: ${contract.reason}`;
  } else if (contract.status === 'none') {
    contractLine = 'contract: NOT VERIFIED: no contract';
    contractNote = 'NOT VERIFIED: no contract';
  } else {
    const m = mapContract(contract.items, cur);
    // Exact test-id match (runner ids may be "file::name"). An item is red only when every test for it
    // fails now and at least one of them was not already failing at session start (baseline-aware).
    const idOf = (i) => i.split('::').pop();
    const failingNow = (t) => !!(r && r.ids && r.ids.some((i) => i === t || idOf(i) === t));
    const failedAtStart = (t) => !!(suite0 && suite0.ids.some((i) => i === t || idOf(i) === t));
    const red = m.matched.filter((x) => x.tests.every(failingNow) && !x.tests.every(failedAtStart)).map((x) => x.item);
    const bad = [...m.unmatched.map((i) => `no test matches request item: "${i}"`), ...red.map((i) => `every test for request item "${i}" is failing`)];
    contractLine = `contract: ${contract.items.length} item(s), ${m.matched.length - red.length} covered by passing tests` + (bad.length ? `; ${bad.length} not verified` : '');
    if (runner) cproblems.push(...bad.map((b) => 'NOT VERIFIED: ' + b));
    else if (bad.length) contractNote = `NOT VERIFIED: ${bad[0]}`;
  }

  const max = +process.env.LOKI_SEAL_MAX_BLOCKS || MAX_BLOCKS;
  const blocks = (st ? st.blocks : 0) + (problems.length ? 1 : 0);
  const released = problems.length > 0 && blocks > max;
  // Contract-only stop: counted on the separate counter. Without state, a repeated stop releases.
  const cOnly = problems.length === 0 && cproblems.length > 0;
  const cblocks = (st ? st.cblocks || 0 : 0) + (cOnly ? 1 : 0);
  const cReleased = cOnly && (st ? cblocks > max : ctx.input.stop_hook_active === true);
  if (st) {
    st.blocks = problems.length ? blocks : 0;
    if (!problems.length) st.cblocks = cOnly ? cblocks : 0; // integrity blocks leave the contract counter alone
    writeState(sp, st);
  }

  const outcome = !runner ? 'NOT VERIFIED (no test runner detected)'
    : released ? `NOT VERIFIED (released after ${max} blocks)`
    : problems.length ? 'BLOCKED'
    : cReleased ? `NOT VERIFIED (contract released after ${max} blocks)`
    : cOnly ? 'NOT VERIFIED (request item not covered)'
    : contractNote ? contractNote : already ? `PASS (no new failures; ${already} already failing)` : 'PASS';
  const basePart = already ? `baseline: ${already} already failing (not caused by this session)` : `baseline: ${baseKind}`;
  const receipt = [
    `loki-seal: ${outcome}`,
    runner ? `runner: ${runner.name}: ${c.pass} passed, ${c.fail} failed` : 'runner: none',
    `tests-integrity: ${findings.length ? findings.length + ' problem(s)' : 'intact'}; ${basePart}${skippedDirs.length ? `; ${skippedDirs.length} unreadable dir(s) skipped` : ''}`,
    contractLine,
    `tree: ${tree}`,
    problems.length || cproblems.length || !runner || contractNote ? `Not verified by Loki: ${REPO}` : `Verified by Loki ${REPO}`,
  ].join('\n');

  if ((problems.length && !released) || (cOnly && !cReleased)) {
    // Exit 2: stderr is fed back to the model and the stop is blocked.
    process.stderr.write(`${receipt}\n\nDo not finish yet. Fix the code, not the tests:\n- ${[...problems, ...cproblems].join('\n- ')}` + (r && r.tail ? `\n\nLast test output:\n${r.tail}` : '') + '\n');
    process.exit(2);
  }
  // Plain Stop stdout goes only to the debug log; systemMessage is what the docs show to the user.
  process.stdout.write(JSON.stringify({ systemMessage: receipt }));
  try { fs.unlinkSync(errFile()); } catch { /* no counter yet */ }
}

// Hook errors are counted outside the state dir (which may be the thing that is failing), so the
// release valve still fires. One byte is appended per error to a private per-session file.
function errFile() {
  const key = crypto.createHash('sha1').update(ctx.root + '\0' + (ctx.input.session_id || '')).digest('hex');
  return path.join(process.env.LOKI_RUN_TMP || os.tmpdir(), `loki-seal-err-${process.getuid ? process.getuid() : 0}-${key}`);
}

function countHookError() {
  const f = errFile();
  const fd = fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, 'x');
    const st = fs.fstatSync(fd);
    if (process.getuid && st.uid !== process.getuid()) throw new Error('error counter not owned by the current user');
    return st.size;
  } finally { fs.closeSync(fd); }
}

main().catch((e) => {
  const m = (e && e.message) || String(e);
  if (mode === 'start') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `loki-seal: baseline unavailable (${m})` } }));
    process.exit(0);
  }
  const max = +process.env.LOKI_SEAL_MAX_BLOCKS || MAX_BLOCKS;
  let n = 0;
  let counted = true;
  try { n = countHookError(); } catch { counted = false; }
  // Counter unavailable (tmpdir read-only or full): a repeated stop (stop_hook_active) releases instead.
  if (counted ? n > max : ctx.input.stop_hook_active === true) {
    process.stdout.write(JSON.stringify({ systemMessage: `loki-seal: NOT VERIFIED (released after ${counted ? max + ' blocks' : 'a repeated stop'}: hook error)\nlast error: ${m}` }));
    process.exit(0);
  }
  // Fail closed: exit 2 blocks the stop; any other non-zero exit would let it through.
  process.stderr.write(`loki-seal: NOT VERIFIED (hook error: ${m})\n`);
  process.exit(2);
});
