#!/usr/bin/env node
'use strict';
// loki-seal: refuse "done" while tests are red or were deleted, skipped or weakened.
// Usage: loki-seal start | stop   (Claude Code hook JSON on stdin). No model calls, no dependencies.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

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
  assert: /\bassert\w*\s*[.(]|^\s*assert\s|\bexpect\s*\(|\bself\.assert\w+|\bt\.(?:Error|Fatal|Fail)\w*\(|\bassert\w*!\s*\(/gm,
};
const count = (s, rx) => (s.match(rx) || []).length;
const CI_TEST_LINE = /test|pytest|jest|vitest|cargo|lint|check/i;
const CI_SOFTEN = /continue-on-error:\s*true|\|\|\s*true|\bif:\s*false/;

function walk(root, rel = '', out = {}) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(root, p, out); }
    else if ((isTest(p) || isCI(p)) && fs.statSync(path.join(root, p)).size < 1e6) out[p] = fs.readFileSync(path.join(root, p), 'utf8');
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
  if (/^\s*[ℹ#]\s*pass\s+\d+/m.test(out)) return { pass: sum(/^\s*[ℹ#]\s*pass\s+(\d+)/gm), fail: sum(/^\s*[ℹ#]\s*fail\s+(\d+)/gm) };
  if (/^\s*--- (PASS|FAIL)/m.test(out)) return { pass: sum(/^\s*--- (PASS)/gm, 1), fail: sum(/^\s*--- (FAIL)/gm, 1) };
  return { pass: sum(/(\d+) passed/g), fail: sum(/(\d+) failed/g) };
}

function statePath(input, root) {
  const dir = process.env.LOKI_SEAL_STATE_DIR || path.join(os.tmpdir(), 'loki-seal-state');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, crypto.createHash('sha1').update(root + '\0' + (input.session_id || '')).digest('hex') + '.json');
}

function main() {
  const mode = process.argv[2];
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* hook without JSON */ }
  const root = path.resolve(input.cwd || process.cwd());
  const sp = statePath(input, root);
  const cur = walk(root);

  if (mode === 'start') {
    if (!fs.existsSync(sp)) fs.writeFileSync(sp, JSON.stringify({ files: cur, blocks: 0 }));
    return;
  }
  if (mode !== 'stop') { process.stderr.write('usage: loki-seal start|stop\n'); process.exit(64); }

  let st = null;
  try { st = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { /* no SessionStart baseline */ }
  const baseKind = st ? 'session start' : gitHead(root) ? 'git HEAD' : 'none';
  const base = st ? st.files : gitHead(root) || cur;
  const findings = scan(base, cur);
  const tree = treeHash(cur);

  const runner = detect(root, cur);
  let res = null, c = { pass: 0, fail: 0 }, tail = '';
  if (runner) {
    const env = { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', PYTHONDONTWRITEBYTECODE: '1' };
    delete env.NODE_TEST_CONTEXT; // set when we are launched inside another node --test run
    res = spawnSync(runner.cmd[0], runner.cmd.slice(1), {
      cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, timeout: +process.env.LOKI_SEAL_TIMEOUT_MS || 600000,
      env,
    });
    const out = (res.stdout || '') + (res.stderr || '');
    c = counts(out);
    tail = out.trim().split('\n').slice(-15).join('\n');
  }

  const problems = [...findings];
  if (runner) {
    if (res.error) problems.push(`test run did not complete: ${res.error.code || res.error.message}`);
    else if (res.status !== 0) problems.push(`tests are red (exit ${res.status})`);
    else if (c.pass + c.fail === 0) problems.push('no tests ran (zero is NOT VERIFIED)');
  }

  const blocks = (st ? st.blocks : 0) + (problems.length ? 1 : 0);
  if (st) { st.blocks = problems.length ? blocks : 0; fs.writeFileSync(sp, JSON.stringify(st)); }
  const released = problems.length && blocks > MAX_BLOCKS;

  const outcome = !runner ? 'NOT VERIFIED (no test runner detected)'
    : released ? 'NOT VERIFIED (block limit reached, released)'
    : problems.length ? 'BLOCKED' : 'PASS';
  const receipt = [
    `loki-seal: ${outcome}`,
    runner ? `runner: ${runner.name}: ${c.pass} passed, ${c.fail} failed` : 'runner: none',
    `tests-integrity: ${findings.length ? findings.length + ' problem(s)' : 'intact'} (baseline: ${baseKind})`,
    `tree: ${tree}`,
    problems.length || !runner ? `Not verified by Loki: ${REPO}` : `Verified by Loki ${REPO}`,
  ].join('\n');

  if (problems.length && !released) {
    const reason = `${receipt}\n\nDo not finish yet. Fix the code, not the tests:\n- ${problems.join('\n- ')}` + (tail ? `\n\nLast test output:\n${tail}` : '');
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  } else {
    process.stdout.write(JSON.stringify({ systemMessage: receipt }));
  }
}

main();
