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

// D80 amendment 2: coverage is granted only from a runner loki-seal launches itself. The npm test script must be
// exactly `node --test` plus allowlisted flags and plain relative file paths; loki-seal then does NOT run npm. It
// spawns process.execPath (absolute, no PATH lookup) with those arguments, cwd at the project root, and NODE_OPTIONS,
// NODE_PATH, NODE_TEST_CONTEXT and every npm_* variable removed. No npm config (project, user, global) is read.
// Anything else (a chained script, another flag, a pretest or posttest script, jest, vitest or any project-resolved
// runner) still runs through npm test so red and green count, but coverage is withheld with a stated reason.
// A test file that calls process.exit, reallyExit, abort or kill is withheld too (defense in depth, not the boundary).
const BUILTIN_REPORTERS = ['spec', 'tap', 'dot', 'junit', 'lcov'];
const SHELL_META = /[;&|$`'"#<>\\(){}*?~!\n\r]/;
const PLAIN_REL_PATH = /^(?!\/)[\w@.-][\w@./-]*$/;
// Returns { args } for a script loki-seal may launch itself, or { reason } when it may not.
function parseNodeTest(root, script, pkgScripts) {
  const t = script.trim();
  if (SHELL_META.test(t)) return { reason: 'the npm test script contains a shell metacharacter' };
  const tok = t.split(/\s+/);
  if (/^(npx\s+)?(jest|vitest)\b/.test(t)) return { reason: `${/vitest/.test(t) ? 'vitest' : 'jest'} is a project-resolved runner (node_modules/.bin, config, reporters and setup files), so it grants no coverage; its red or green result still counts` };
  if (tok[0] !== 'node' || tok[1] !== '--test') return { reason: `the npm test script ("${t.slice(0, 80)}") is not exactly node --test plus allowlisted flags and plain relative file paths` };
  if (pkgScripts && (pkgScripts.pretest || pkgScripts.posttest)) return { reason: 'a pretest or posttest script exists and could change what npm test runs' };
  const args = ['--test'];
  for (const a of tok.slice(2)) {
    let m;
    if ((m = /^--test-reporter=(.+)$/.exec(a))) {
      if (!BUILTIN_REPORTERS.includes(m[1])) return { reason: `the test reporter "${m[1].slice(0, 40)}" is not a built-in reporter (spec, tap, dot, junit, lcov), so it could be project code` };
    } else if (a.startsWith('-')) {
      if (!/^--(?:test-reporter-destination=stdout|test-isolation=process|test-concurrency=\d+|test-timeout=\d+)$/.test(a)) return { reason: `the flag "${a.slice(0, 40)}" is not an allowlisted node --test flag` };
    } else {
      if (!PLAIN_REL_PATH.test(a) || a.split('/').includes('..')) return { reason: `the argument "${a.slice(0, 40)}" is not a plain relative file path` };
      let st = null;
      try { st = fs.statSync(path.join(root, a)); } catch { /* missing */ }
      if (!st || !st.isFile()) return { reason: `the path "${a.slice(0, 40)}" is not an existing file (a directory or missing path does not run tests under node --test)` };
    }
    args.push(a);
  }
  return { args };
}

function exitFinding(root, files) {
  for (const p of Object.keys(files).filter((f) => isTest(f) && /\.[cm]?[jt]sx?$/.test(f))) {
    let c = '';
    try { c = fs.readFileSync(path.join(root, p), 'utf8'); } catch { continue; }
    if (/\bprocess\s*(?:\.\s*(?:exit|reallyExit|abort|kill)\b|\[)/.test(c)) return `${p} calls process.exit, reallyExit, abort or kill (or indexes process dynamically), an integrity finding`;
  }
  return null;
}

function detect(root, files) {
  const has = (f) => fs.existsSync(path.join(root, f));
  if (has('package.json')) {
    let s = '', pkgScripts = null;
    try { pkgScripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts; s = pkgScripts.test || ''; } catch { /* no script */ }
    if (s && !/no test specified/.test(s)) {
      const parsed = parseNodeTest(root, s, pkgScripts);
      if (parsed.args) {
        return { name: 'node --test (direct)', cmd: [process.execPath, ...parsed.args], clean: true, coverageBlock: exitFinding(root, files) };
      }
      const kind = /vitest/.test(s) ? 'vitest' : /jest/.test(s) ? 'jest' : 'script';
      return { name: `npm test (${kind})`, cmd: ['npm', 'test', '--silent'], coverageBlock: parsed.reason };
    }
  }
  if (has('go.mod')) return { name: 'go test', cmd: ['go', 'test', './...', '-v'] };
  if (has('Cargo.toml')) return { name: 'cargo test', cmd: ['cargo', 'test'] };
  if (['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py'].some(has) || Object.keys(files).some((p) => p.endsWith('.py'))) {
    return { name: 'pytest', cmd: ['python3', '-m', 'pytest', '-q', '-rA'] };
  }
  return null;
}

// The last runner summary block (from the last "tests N" line to the end), or null. A test can print anything
// earlier, so only this block is trusted. blocks > 1 is reported and fails closed in passRecords().
function nodeBlock(out) {
  const lines = out.split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (/^\s*[ℹ#]\s*tests\s+\d+\s*$/.test(l)) starts.push(i); });
  if (!starts.length) return null;
  const block = lines.slice(starts[starts.length - 1]).join('\n');
  const num = (name) => { const x = new RegExp('^\\s*[ℹ#]\\s*' + name + '\\s+(\\d+)', 'm').exec(block); return x ? +x[1] : null; };
  return { blocks: starts.length, spec: /^\s*ℹ\s*tests\s/m.test(block), tests: num('tests'), pass: num('pass'), fail: num('fail'), suites: num('suites'), skipped: num('skipped'), todo: num('todo'), cancelled: num('cancelled') };
}

function counts(out) {
  const sum = (rx, one) => [...out.matchAll(rx)].reduce((a, m) => a + (one ? 1 : +m[1]), 0);
  const nb = nodeBlock(out);
  if (nb && nb.pass !== null) return { summary: true, pass: nb.pass, fail: nb.fail || 0 };
  if (/^\s*[ℹ#]\s*pass\s+\d+/m.test(out)) return { summary: true, pass: sum(/^\s*[ℹ#]\s*pass\s+(\d+)/gm), fail: sum(/^\s*[ℹ#]\s*fail\s+(\d+)/gm) };
  if (/^\s*--- (PASS|FAIL)/m.test(out)) return { summary: false, pass: sum(/^\s*--- (PASS)/gm, 1), fail: sum(/^\s*--- (FAIL)/gm, 1) };
  return { summary: /\d+ (passed|failed)/.test(out), pass: sum(/(\d+) passed/g), fail: sum(/(\d+) failed/g) };
}

// Passing test records parsed line by line. Coverage (passIds) and the summary cross-check (passCount) use
// the SAME records, so a printed line that is excluded from one is excluded from both.
//  - TAP: an ok line is a record unless its YAML block says type: 'suite' (a describe() suite, which the
//    runner's pass count leaves out) or it carries a SKIP or TODO marker. t.test() parents are records.
//    More passing lines than the summary counts is a contradiction (BLOCKED).
//  - Node spec (the default reporter in a terminal): a describe() suite prints a check-mark line that is not
//    in the runner's pass count, and the shapes around it (todo, cancelled, failing, empty names, directives
//    after the duration, skipped suites) are too ambiguous to reconcile by arithmetic. So the spec path fails
//    closed: unless the output is free of every ambiguous shape AND check lines minus attributable suites
//    (suites - (dash lines - skipped tests)) equal the summary pass exactly, NO coverage is granted from it
//    (specUnverified), which gives NOT VERIFIED and never BLOCKED. TAP is sound; use --test-reporter=tap.
//  - Everything else (PASSED, --- PASS, cargo) is a record.
// Detect a result mark first (any line separator can sit inside a name), then parse the body with [^] so no
// character can hide a line. A pass-mark line that does not parse, or whose name has a control character, is odd.
const PASS_PREFIX = /^\s*[\u2714\u2713√]/;
const SPEC_MARK = /^(\s*)([\u2714\u2713√]) ([^]+?)\s*$/;
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const ANY_MARK = /[\u2714\u2713√\u2716﹣▶]/;
const SUM_KEY = /[ℹ#]\s*(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/g;
const SUM_LINE = /^\s*[ℹ#]\s*(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/;
function passRecords(out, truncated) {
  const lines = out.split('\n');
  const leaf = [];
  let specLines = 0;
  let dash = 0;
  let cross = 0;
  const lastSum = lines.findLastIndex((l) => /^\s*[ℹ#]\s*tests\s+\d+\s*$/.test(l));
  const sumAt = lastSum < 0 ? lines.length : lastSum;
  const odd = [];
  let brokenSummary = truncated ? 'the output exceeded the capture limit, so the real summary may be missing' : null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    // Unterminated output before the runner's own line pushes its mark off the line start ("X\u2714 name"), so a
    // result mark anywhere but first after the indent makes the line ambiguous, pass and fail marks alike.
    const lead = ln.search(/\S/);
    if (lead >= 0 && ANY_MARK.test(ln) && !ANY_MARK.test(ln[lead])) odd.push('a result mark that is not first on its line');
    // The same holds for a summary key: one anywhere but at the line start may be a real summary line pushed off
    // its start, hiding it behind a forged block.
    for (const k of ln.matchAll(SUM_KEY)) if (k.index !== lead) { brokenSummary = 'a runner summary key that is not at the start of its line'; break; }
    if (/^\s*[\u2714\u2713√\u2716﹣]\s*$/.test(ln)) { odd.push('a result line with an empty name'); continue; }
    if (/^\s*\u2716/.test(ln)) { if (i < sumAt) cross++; continue; }
    let m = SPEC_MARK.exec(ln);
    if (!m && PASS_PREFIX.test(ln)) { odd.push('a result line that does not parse'); continue; }
    if (m) {
      const body = m[3];
      if (CTRL.test(ln)) odd.push('a result line whose name has a control or line-separator character');
      const name = body.replace(/\s+\(?\d[\d.]*\s?ms\)?$/, '').trim();
      if (!name || /^\(?\d[\d.]*\s?ms\)?$/.test(name)) odd.push('a result line with an empty name');
      if (/\)\s+#/.test(body)) odd.push('a result line carrying a # directive');
      specLines++;
      leaf.push(name.split(' > ').pop().trim());
      continue;
    }
    if (/^\s*﹣ /.test(ln)) { dash++; continue; }
    m = /^\s*ok \d+ - (.+?)\s*$/.exec(ln);
    if (m) {
      if (/\s#\s*(?:SKIP|TODO)\b/i.test(m[1])) continue;
      let suite = false;
      if (/^\s*---\s*$/.test(lines[i + 1] || '')) {
        for (let j = i + 2; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) if (/^\s*type: 'suite'\s*$/.test(lines[j])) { suite = true; break; }
      }
      if (!suite) leaf.push(m[1].trim());
      continue;
    }
    if ((m = /^PASSED (\S+)/.exec(ln)) || (m = /^\s*--- PASS: (\S+)/.exec(ln)) || (m = /^test (\S+) \.\.\. ok$/.exec(ln))) leaf.push(m[1].trim());
  }
  const node = nodeBlock(out);
  let passCount = leaf.length;
  let unverified = null;
  if (!brokenSummary && node && !node.fail) {
    // The trusted block must be complete and end the output: only summary lines may follow its first line.
    const first = lines.findLastIndex((l) => /^\s*[ℹ#]\s*tests\s+\d+\s*$/.test(l));
    if (lines.slice(first).some((l) => l.trim() && !SUM_LINE.test(l))) brokenSummary = 'the runner summary block is not the last thing in the output';
  }
  if (brokenSummary) unverified = brokenSummary;
  else if (node && node.blocks > 1) unverified = 'the output has more than one runner summary block';
  else if (node && node.spec) {
    const n0 = (v) => v || 0;
    const skippedSuites = dash - n0(node.skipped);
    const sp = n0(node.suites) - skippedSuites;
    if (node.pass === null) unverified = 'the summary has no pass count';
    else if (odd.length) unverified = odd[0];
    else if (cross !== n0(node.fail)) unverified = `${cross} failing (cross-mark) line(s) do not equal the ${n0(node.fail)} failed in the summary`;
    else if (n0(node.todo) || n0(node.cancelled)) unverified = 'the summary has todo or cancelled tests';
    else if (node.tests !== node.pass + n0(node.fail) + n0(node.skipped) + n0(node.todo) + n0(node.cancelled)) unverified = 'the summary counts do not add up';
    else if (leaf.length !== specLines) unverified = 'pass lines in another shape (ok N, PASSED, --- PASS) appear in spec output';
    else if (skippedSuites < 0 || sp < 0 || sp > specLines) unverified = 'the suite count cannot be attributed to output lines';
    else if (specLines - sp !== node.pass) unverified = `${specLines - sp} passing line(s) do not equal the ${node.pass} passed in the summary`;
    passCount = specLines - sp + (leaf.length - specLines);
  }
  return { passIds: unverified ? [] : [...new Set(leaf)], passCount, node, specUnverified: unverified };
}

// Runner output whose pass lines contradict its own summary counts (a test printing forged lines).
// With no summary line there is nothing to cross-check and this returns null. Spec output is never
// BLOCKED here: ambiguity withholds coverage instead (see passRecords).
function inconsistency(r) {
  if (r.error) return null;
  const clash = (r.rawPassIds || r.passIds || []).filter((i) => (r.ids || []).includes(i));
  if (clash.length) return `the runner reports the same test as both passed and failed: ${clash.slice(0, 3).join(', ')}`;
  if (!r.summary) return null;
  if (r.node) {
    if (r.node.spec || r.node.blocks > 1) return null;
    if (r.node.pass !== null && (r.passCount || 0) > r.node.pass) return `${r.passCount} passing test line(s) but the runner summary counts ${r.node.pass} passed`;
    return null;
  }
  if ((r.passCount || 0) > r.pass) return `${r.passCount} passing test line(s) but the runner summary counts ${r.pass} passed`;
  return null;
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

// The environment a test run gets. A clean (directly launched node --test) run loses NODE_OPTIONS, NODE_PATH and every
// npm_* variable, matched case-insensitively, so no inherited setting can inject code into the runner (D80).
function childEnv(runner, base = process.env) {
  const env = { ...base, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', PYTHONDONTWRITEBYTECODE: '1' };
  delete env.NODE_TEST_CONTEXT; // set when we are launched inside another node --test run
  if (runner.clean) for (const k of Object.keys(env)) if (/^node_(?:options|path)$/i.test(k) || /^npm_/i.test(k)) delete env[k];
  return env;
}

function runSuite(root, runner, timeout) {
  const env = childEnv(runner);
  return new Promise((resolve) => {
    let out = '', timedOut = false, done = false, truncated = false;
    const child = spawn(runner.cmd[0], runner.cmd.slice(1), { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, timeout);
    const add = (d) => { if (out.length < 1 << 26) out += d; else truncated = true; };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const finish = (status, error) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const pr = passRecords(out, truncated);
      if (runner.coverageBlock) { pr.rawPassIds = pr.passIds; pr.passIds = []; pr.specUnverified = runner.coverageBlock; }
      resolve({ error: timedOut ? { code: 'ETIMEDOUT' } : error, status, ids: failing(out), ...pr, ...counts(out), tail: out.trim().split('\n').slice(-15).join('\n') });
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
    const clash = r.error ? null : inconsistency(r);
    if (clash) problems.push(`NOT VERIFIED: runner output inconsistent: ${clash}`);
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
  // Modal sentences dropped as chat are listed so a real promise filtered by mistake is visible.
  const chatNote = contract.filtered && contract.filtered.length
    ? `; filtered as chat: ${contract.filtered.length} sentence(s): ${contract.filtered.slice(0, 3).map((f) => `"${f}"`).join(', ')}` : '';
  let contractLine, contractNote = null;
  if (contract.status === 'unreadable') {
    contractLine = `contract: NOT VERIFIED: ${contract.reason}`;
    contractNote = `NOT VERIFIED: ${contract.reason}`;
  } else if (contract.status === 'none') {
    contractLine = 'contract: NOT VERIFIED: no contract' + chatNote;
    contractNote = 'NOT VERIFIED: no contract';
  } else {
    const m = mapContract(contract.items, cur);
    // Exact test-id match (runner ids may be "file::name"). An item is red whenever ANY test matched to it
    // fails NOW, whatever the start state: a delivery cannot be verified while one of its tests is red.
    // Failing at session start only changes the wording.
    const idOf = (i) => i.split('::').pop();
    const failingNow = (t) => !!(r && r.ids && r.ids.some((i) => i === t || idOf(i) === t));
    const failedAtStart = (t) => !!(suite0 && suite0.ids.some((i) => i === t || idOf(i) === t));
    // Coverage needs a runner-reported pass: a matched test the runner never ran, skipped or did not list is not coverage.
    const passedNow = (t) => !!(r && r.passIds && r.passIds.some((i) => i === t || idOf(i).replace(/\[.*\]$/, '') === t || i.startsWith(t + '/')));
    const redX = m.matched.filter((x) => x.tests.some(failingNow));
    const red = redX.map((x) => x.item);
    const redSet = new Set(redX);
    const unpassed = m.matched.filter((x) => !redSet.has(x) && !x.tests.some(passedNow));
    const bad = [...m.unmatched.map((i) => `no test matches request item: "${i}"`),
      ...redX.map((x) => x.tests.every(failingNow)
        ? `every test for request item "${x.item}" is failing${x.tests.every(failedAtStart) ? ' (already failing at session start, still not fixed)' : ''}`
        : `a test for request item "${x.item}" is failing: ${[...new Set(x.tests.filter(failingNow))].join(', ')}`),
      ...unpassed.map((x) => `no test for request item "${x.item}" was reported as passed by the runner (not run, skipped, or not listed)${r && r.specUnverified ? `; the runner output could not be trusted (${r.specUnverified}), so coverage was withheld; use node --test with its default process isolation (and --test-reporter=tap for the exact check)` : ''}: ${x.tests.slice(0, 3).join(', ')}`)];
    contractLine = `contract: ${contract.items.length} item(s), ${m.matched.length - red.length - unpassed.length} covered by passing tests` + (bad.length ? `; ${bad.length} not verified` : '') + chatNote;
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

module.exports = { passRecords, detect, childEnv };
if (require.main === module) main().catch((e) => {
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
