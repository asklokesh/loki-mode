// loki-ts/src/engine10/modernize/unit.ts -- M-15: unit runner, card to v10 run with oracle Wall
// and equiv check (docs/v10/MODERNIZE.md section 3.4 "Execute in parallel"). Depends on M-13
// (equiv.ts), M-14 (presealed_wall.ts).
//
// Binding requirements (BOARD.md M-15 notes, M-13/M-14 opus reviews, D42 (3)/(4)):
// (1) sealOracle runs with the card's normalizers BEFORE any implementation exists for the unit.
//     runUnit below calls oracle/seal.ts's sealOracle as its very first step, strictly before the
//     injected `implement` callback -- see runUnit's ordering comment and unit.test.ts's ordering
//     test, which fails an `implement` that runs before the oracle.captured/oracle.flagged event
//     exists in the modernize log.
// (2) verifySeal and verifyPreSealedWall are called before trusting an oracle or a Wall. Both
//     M-13's checkEquivalence and M-14's sealPreSealedWall already call verifySeal internally
//     (never take a caller's word for a seal); runUnit additionally calls verifyPreSealedWall
//     itself, right after sealing the Wall and again before ever calling `implement` or
//     checkEquivalence, so a Wall this run just sealed (or one left over from a crashed resume)
//     is re-checked from disk/log, never trusted from a return value alone.
// (3) The base-run parsing M-14 consumes -- runner, exit code, failedCount -- is this file's job
//     (presealed_wall.ts's own header: "shelling out ... under the target runtime is the unit
//     runner's job (M-15)"). parsePytestOutput below parses real pytest stdout into a
//     presealed_wall.ts BaseRunOutcome, failing closed (no summary line, no parsed integer) on
//     garbled or truncated output rather than guessing.
// (4) A pytest collection error (exit 2) is classified by presealed_wall.ts's classifyBaseRun from
//     the raw output, using the Wall's own rule (pytestCollectionIsRed, imported from stages/wall.ts): no
//     second classifier lives in this file.
// (5) MODERNIZE.md:153/262 no-op ablation: an injected stub runner replaces the new unit with stubs;
//     the oracle cases must then FAIL equivalence, else NOT_PROVEN "oracle does not constrain unit".
// (6) Conformance files (tests, conftest.py, pytest config) and every .py are hashed at Wall-seal time and must be
//     unchanged on the new tree before the post-implement conformance run is trusted.
// (7) FC-24 (docs/v10/FAILURE-CLASSES.md): target conformance is runner_reported. Checks (6) and the per-test
//     identity check stop accidental and low-effort false passes, not unit code that deliberately subverts
//     pytest inside its own process. PROVEN's conformance leg carries that limit in the result and the log.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { ModernizeLog } from "./log.ts";
import { readModernizeEvents } from "./log.ts";
import type { EquivNormalizers, SealedOracle } from "./oracle/seal.ts";
import { sealOracle, verifySeal } from "./oracle/seal.ts";
import type { BaseConformanceRunner, BaseRunOutcome, PreSealedWallResult, PytestCounts, TestOutcome } from "./presealed_wall.ts";
import { classifyBaseRun, sealPreSealedWall, verifyPreSealedWall } from "./presealed_wall.ts";
import type { EquivResult, NewCaseRunner } from "./equiv.ts";
import { checkEquivalence } from "./equiv.ts";
import { oracleDir } from "./types.ts";
import type { ModernizeTarget } from "./types.ts";

// ---------------------------------------------------------------------------------------------
// (3)/(4): real pytest output parsing.
// ---------------------------------------------------------------------------------------------

/** pytest's own summary footer, e.g. "=== 2 failed, 5 passed in 0.31s ===". Matched only as the
 *  LAST such line in the output (pytest can print progress lines mid-run that are not the
 *  footer), and only "failed" is trusted -- any other shape (no footer at all, a footer with no
 *  "failed" clause) returns undefined rather than a guess, per D42 (3)'s fail-closed rule. */
const SUMMARY_RE = /^=+\s(.*)\sin\s[\d.]+s(?:\s\(\d+:\d+:\d+\))?\s=+$/;

function parseFailedCount(stdout: string): number | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    const m = SUMMARY_RE.exec(line);
    if (!m) continue;
    const fm = /(\d+)\s+failed\b/.exec(m[1] ?? "");
    if (!fm) return undefined; // a real footer with no "failed" clause: nothing failed, or garbled
    const n = Number(fm[1]);
    return Number.isInteger(n) && n >= 1 ? n : undefined;
  }
  return undefined; // no footer found at all: truncated output, never guessed at
}

/** Every count clause of the LAST pytest footer, or undefined when there is no footer. "other" is
 *  xfailed + xpassed (collected, neither plainly passed nor failed). deselected/warnings are not tests run. */
export function parseFooterCounts(stdout: string): PytestCounts | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = SUMMARY_RE.exec((lines[i] ?? "").trim());
    if (!m) continue;
    const c: PytestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0, other: 0 };
    for (const [, n, word] of (m[1] ?? "").matchAll(/(\d+)\s+(passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?|rerun)\b/g)) {
      const k = Number(n);
      if (word === "passed") c.passed += k;
      else if (word === "failed") c.failed += k;
      else if (word!.startsWith("error")) c.errors += k;
      else if (word === "skipped") c.skipped += k;
      else if (word === "xfailed" || word === "xpassed") c.other += k;
    }
    return c;
  }
  return undefined;
}

/** Totals from pytest's junit report (written only when the session finishes). */
function parseJunit(xml: string): { tests: number; failures: number; errors: number } | undefined {
  const m = /<testsuite\b[^>]*>/.exec(xml);
  if (!m) return undefined;
  const attr = (a: string): number | undefined => { const r = new RegExp(`\\b${a}="(\\d+)"`).exec(m[0]); return r ? Number(r[1]) : undefined; };
  const tests = attr("tests"), failures = attr("failures"), errors = attr("errors");
  return tests === undefined || failures === undefined || errors === undefined ? undefined : { tests, failures, errors };
}

const unesc = (v: string): string => v.replace(/&(lt|gt|quot|apos|amp|#x?[0-9a-fA-F]+);/g, (_m, e: string) =>
  e === "lt" ? "<" : e === "gt" ? ">" : e === "quot" ? '"' : e === "apos" ? "'" : e === "amp" ? "&"
    : String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const SEVERITY: TestOutcome[] = ["passed", "xpassed", "skipped", "xfailed", "failed", "error"];

/** Per-testcase outcome from the junit report, keyed "classname::name"; a duplicated key keeps its worst outcome. */
function parseJunitCases(xml: string): Record<string, TestOutcome> {
  const out: Record<string, TestOutcome> = {};
  for (const m of xml.matchAll(/<testcase\b((?:[^>"]|"[^"]*")*?)(\/>|>)/g)) {
    const attrs: Record<string, string> = {};
    for (const [, k, v] of (m[1] ?? "").matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[k!] = unesc(v ?? "");
    let body = "";
    if (m[2] === ">") {
      const end = xml.indexOf("</testcase>", (m.index ?? 0) + m[0].length);
      body = xml.slice((m.index ?? 0) + m[0].length, end < 0 ? undefined : end);
    }
    const sk = /<skipped\b([^>]*)>/.exec(body);
    const o: TestOutcome = /<error\b/.test(body) ? "error" : /<failure\b/.test(body) ? "failed"
      : sk ? (/type="pytest\.xfail"/.test(sk[1] ?? "") ? "xfailed" : "skipped") : "passed";
    const key = `${attrs.classname ?? ""}::${attrs.name ?? ""}`;
    const prev = out[key];
    if (prev === undefined || SEVERITY.indexOf(o) > SEVERITY.indexOf(prev)) out[key] = o;
  }
  return out;
}

/** pytest nodeid ("pkg/test_m.py::Cls::test_x[p]") to the junit key ("pkg.test_m.Cls::test_x[p]"). */
export function nodeidKey(nodeid: string): string {
  const br = nodeid.indexOf("[");
  const parts = (br < 0 ? nodeid : nodeid.slice(0, br)).split("::");
  const param = br < 0 ? "" : nodeid.slice(br);
  const file = (parts.shift() ?? "").replace(/\.py$/, "").split("/").join(".");
  const name = (parts.pop() ?? "") + param;
  return `${[file, ...parts].join(".")}::${name}`;
}

/** Footer counts and per-test outcomes, trusted only when the junit report (never written by a process that
 *  dies early) agrees with them, the run never hit pytest.exit, and the report holds at least as many
 *  testcases as pytest said it collected. A printed footer alone never passes: the junit report must exist and
 *  agree. Both the footer and the report come from the pytest process, which runs unit-under-test code, so a
 *  deliberate in-process forgery (rewriting the report, patching pytest's reports) is not detected: FC-24,
 *  recorded as runner_reported. */
function trustedRun(stdout: string, junitXml: string | undefined): { counts: PytestCounts; tests: Record<string, TestOutcome> } | undefined {
  const c = parseFooterCounts(stdout);
  const j = junitXml === undefined ? undefined : parseJunit(junitXml);
  if (!c || !j || junitXml === undefined) return undefined;
  if (j.tests !== c.passed + c.failed + c.errors + c.skipped + c.other) return undefined;
  if (j.failures + j.errors !== c.failed + c.errors) return undefined;
  if (/_pytest\.outcomes\.Exit/.test(stdout)) return undefined;
  const col = [...stdout.matchAll(/^collected (\d+) items?(?:.*?(\d+) selected)?/gm)].pop();
  if (col && j.tests < Number(col[2] ?? col[1])) return undefined;
  const tests = parseJunitCases(junitXml);
  for (const [, id] of stdout.matchAll(/^XPASS\S*\s+(\S+)/gm)) { // a non-strict xpass is a plain pass in junit
    const k = nodeidKey(id!);
    if (tests[k] === "passed") tests[k] = "xpassed";
  }
  return { counts: c, tests };
}

/** Parses one pytest run's raw stdout into presealed_wall.ts's BaseRunOutcome. Pure and
 *  hermetic -- the actual `spawnSync` call lives in makePytestBaseRunner below, so this is
 *  directly testable against captured real pytest output (unit.test.ts). Fails closed by
 *  construction: exit 0/timeout/signal/126/127/3/4/5 need no extra parsing (classifyBaseRun
 *  handles them from exitCode/timedOut alone); exit 1 gets a failedCount only when a real
 *  footer line parses; exit 2 gets a collectionError only when (4) above resolves one. */
export function parsePytestOutput(
  repoDir: string,
  stdout: string,
  exitCode: number | null,
  timedOut: boolean,
  junitXml?: string,
): BaseRunOutcome {
  const outcome: BaseRunOutcome = { runner: "pytest", exitCode, timedOut };
  if (timedOut || exitCode === null) return outcome;
  const run = trustedRun(stdout, junitXml);
  if (run) { outcome.counts = run.counts; outcome.tests = run.tests; }
  // exit 2: hand the raw output to classifyBaseRun, which reuses the Wall's own red/not_run rule.
  if (exitCode === 2) return { ...outcome, output: stdout };
  if (exitCode === 1) {
    const failedCount = parseFailedCount(stdout);
    return failedCount !== undefined ? { ...outcome, failedCount } : outcome;
  }
  return outcome;
}

/** The real conformance runner: shells out to `<pythonBin> -m pytest` in repoDir, under whatever
 *  interpreter the target runtime resolves to on PATH (section 7: "the Wall runs under the target
 *  runtime"), and parses its output with parsePytestOutput above. A spawn that cannot even start
 *  (ENOENT: the interpreter is missing) reports exitCode null, timedOut false -- classifyBaseRun
 *  already treats a null exitCode as not_run, never red. `timeoutMs` bounds a hung run the same
 *  way spawnSync's own `timeout` option does (SIGTERM, then a null exitCode). */
export function makePytestBaseRunner(pythonBin = "python3", timeoutMs = 300_000): BaseConformanceRunner {
  return (_unit: string, repoDir: string): BaseRunOutcome => {
    const { res, junitXml } = spawnPytest(pythonBin, repoDir, timeoutMs, [], true);
    const timedOut = res.signal === "SIGTERM" && res.status === null;
    // pytest's own report (the footer, the collection-error traceback) goes to stdout; stderr is
    // never appended ahead of it -- an unrelated stderr line (a warning, a plugin's own output)
    // must never shadow or precede the real footer this file's parser searches for.
    return parsePytestOutput(repoDir, `${res.stdout ?? ""}\n${res.stderr ?? ""}`, res.status, timedOut, junitXml);
  };
}

/** One pytest child under the pinned configuration. Bytecode must never answer for source: no in-tree .pyc
 *  is read (fresh empty PYTHONPYCACHEPREFIX) or written (PYTHONDONTWRITEBYTECODE), pytest's cache plugin is
 *  off, and xfail is strict (-rX lists the rest). The junit file lives in a fresh mkdtemp dir so no stale
 *  report is ever read. Its path is in the child's argv, so code in the child can read and rewrite it (FC-24). */
function spawnPytest(pythonBin: string, repoDir: string, timeoutMs: number, extra: string[], withJunit: boolean) {
  const pycPrefix = mkdtempSync(join(tmpdir(), "loki-pyc-"));
  const junitDir = mkdtempSync(join(tmpdir(), "loki-junit-"));
  const junit = join(junitDir, "junit.xml");
  let junitXml: string | undefined;
  try {
    let root = repoDir;
    try { root = realpathSync(repoDir); } catch { /* spawn will report it */ }
    // Pin rootdir/confcutdir to the tree and the ini to the tree's own (sealed) config, so no parent-dir
    // ini or conftest.py is ever loaded; none in the tree means an empty config.
    const res = spawnSync(pythonBin, ["-m", "pytest", "-p", "no:cacheprovider", "--rootdir", root, "--confcutdir", root,
      "-c", pytestConfigFor(root), "-o", "xfail_strict=true", "-rX", ...(withJunit ? [`--junitxml=${junit}`] : []), ...extra], {
      cwd: repoDir, encoding: "utf8", timeout: timeoutMs,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPYCACHEPREFIX: pycPrefix },
    });
    if (withJunit) { try { junitXml = readFileSync(junit, "utf8"); } catch { junitXml = undefined; } }
    return { res, junitXml };
  } finally {
    rmSync(pycPrefix, { recursive: true, force: true });
    rmSync(junitDir, { recursive: true, force: true });
  }
}

/** Collects the nodeids of `files` (relative to repoDir) with `pytest --collect-only -q`, or a refusal. */
export type CollectRunner = (unit: string, repoDir: string, files: string[]) => { ok: true; nodeids: string[] } | { ok: false; reason: string };

export function makePytestCollector(pythonBin = "python3", timeoutMs = 300_000): CollectRunner {
  return (_unit, repoDir, files) => {
    const { res } = spawnPytest(pythonBin, repoDir, timeoutMs, ["--collect-only", "-q", ...files], false);
    if (res.status !== 0) return { ok: false, reason: `collect-only exited ${res.status ?? "without a status"}` };
    const out = res.stdout ?? "";
    if (/_pytest\.outcomes\.Exit/.test(out)) return { ok: false, reason: "collect-only hit pytest.exit" };
    const nodeids = out.split("\n").filter((l) => /^\S.*\.py::\S/.test(l) && !l.startsWith("ERROR "));
    const n = /(\d+) tests? collected/.exec(out);
    if (!n || Number(n[1]) !== nodeids.length) return { ok: false, reason: "collect-only count disagrees with its nodeid list" };
    return nodeids.length === 0 ? { ok: false, reason: "collect-only found no sealed tests" } : { ok: true, nodeids };
  };
}

/** The ini pytest itself would pick inside `root` (its documented order and section markers), or
 *  /dev/null: passed with -c so ancestors above the tree are never searched. */
function pytestConfigFor(root: string): string {
  const has = (f: string, marker?: RegExp): boolean => {
    const p = join(root, f);
    if (!existsSync(p)) return false;
    if (!marker) return true;
    try { return marker.test(readFileSync(p, "utf8")); } catch { return false; }
  };
  // pytest 9 order: pytest.ini, .pytest.ini, pytest.toml, .pytest.toml, pyproject.toml, tox.ini, setup.cfg.
  for (const f of ["pytest.ini", ".pytest.ini", "pytest.toml", ".pytest.toml"]) if (has(f)) return join(root, f);
  if (has("pyproject.toml", /^\s*\[tool\.pytest|^\s*(tool\.)?pytest\./m)) return join(root, "pyproject.toml");
  if (has("tox.ini", /^\s*\[pytest\]/m)) return join(root, "tox.ini");
  if (has("setup.cfg", /^\s*\[tool:pytest\]/m)) return join(root, "setup.cfg");
  return "/dev/null";
}

// ---------------------------------------------------------------------------------------------
// (6): conformance-file binding.
// ---------------------------------------------------------------------------------------------
const CONF_EVENT = "unit.conformance_sealed";
const SKIP_DIRS = new Set([".git", ".loki", "node_modules", "__pycache__", ".venv", "venv", ".pytest_cache", ".tox"]);
const skipName = (n: string): boolean => SKIP_DIRS.has(n.toLowerCase());
// Case-insensitive: pytest on a case-insensitive filesystem (macOS APFS) loads pkg/Conftest.py as a conftest.
const TEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/i;
// Anything that can change what `python -m pytest` runs or reports; a NEW one is refused, not just a changed one.
const PYTEST_CFG = /(^|\/)(conftest\.py|\.?pytest\.(ini|toml)|pytest\.py|pyproject\.toml|setup\.cfg|tox\.ini|sitecustomize\.py|usercustomize\.py)$|\.pth$|(^|\/)pytest\//i;

/** True for a path whose NAME can steer what pytest loads or reports (case-insensitively). */
export function isSealedName(rel: string): boolean { return TEST_FILE.test(rel) || PYTEST_CFG.test(rel); }

/** Deletes every __pycache__ under dir (skipping SKIP_DIRS, never following a symlink), so stale or
 *  planted bytecode cannot stand in for a hashed .py. */
export function purgePycache(dir: string): void {
  const walk = (d: string): void => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue; // a symlink is not a directory entry here
      const full = join(d, e.name);
      if (e.name === "__pycache__") rmSync(full, { recursive: true, force: true });
      else if (!skipName(e.name)) walk(full);
    }
  };
  walk(dir);
}

const LINK = "symlink:";
// Only VCS and run state are fully skipped. Everything else, SKIP_DIRS included, is recorded (a norecursedirs
// override or a link makes pytest walk node_modules/venv/.tox): sealed names by content, links by target, other
// entries by name and type. __pycache__ and .pytest_cache hold only purged/disabled caches and are not recorded.
const FULL_SKIP = new Set([".git", ".loki"]);
const CACHE_DIRS = new Set(["__pycache__", ".pytest_cache"]);

/** Digest of what a link points at, for links resolving outside `dir` (inside, the target is hashed under its own path).
 *  Files hash their bytes; directories hash names plus file bytes (nested links by target string); capped, fail closed. */
function outsideTargetDigest(dir: string, full: string): string {
  let real: string;
  try { real = realpathSync(full); } catch { return "dangling"; }
  let root: string;
  try { root = realpathSync(dir); } catch { return "noroot"; }
  if (real === root || real.startsWith(root + sep)) return "inside";
  const h = createHash("sha256");
  let budget = 20_000;
  const walk = (p: string): void => {
    if (budget-- <= 0) { h.update("capped"); return; }
    let st;
    try { st = lstatSync(p); } catch { h.update("unreadable"); return; }
    if (st.isSymbolicLink()) { try { h.update("L" + readlinkSync(p)); } catch { h.update("L?"); } return; }
    if (st.isDirectory()) {
      let names: string[] = [];
      try { names = readdirSync(p).sort(); } catch { h.update("unreadable"); }
      for (const n of names) { h.update("D" + n); walk(join(p, n)); }
      return;
    }
    if (st.isFile()) { try { h.update(readFileSync(p)); } catch { h.update("unreadable"); } }
  };
  walk(real);
  return h.digest("hex");
}

/** sha256 of EVERY regular file under dir (bytes, so fixtures, snapshots and golden data are bound),
 *  keyed by relative path; pyproject.toml, setup.cfg and tox.ini are hashed in full. Under SKIP_DIRS (venvs,
 *  node_modules) sealed names (test files, conftest.py, pytest config, *.pth, sitecustomize.py) are hashed
 *  and every other entry is recorded by name and type ("entry:file" / "entry:dir"). A symlink is never followed: it is recorded as
 *  "symlink:<target>|<digest>" where the digest covers the target bytes when the link resolves outside dir. */
export function conformanceHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rels: string[] = [];
  const walk = (sub: string, inSkip: boolean): void => {
    let ents;
    try { ents = readdirSync(join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (FULL_SKIP.has(e.name.toLowerCase())) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      const cache = CACHE_DIRS.has(e.name.toLowerCase());
      if (e.isSymbolicLink()) { rels.push(rel); continue; } // a link is recorded, never descended
      if (cache) continue;
      const skipped = inSkip || skipName(e.name);
      if (e.isDirectory()) {
        if (skipped) out[rel] = "entry:dir";
        walk(rel, skipped);
      } else if (!skipped || isSealedName(rel)) {
        rels.push(rel);
      } else {
        out[rel] = "entry:file";
      }
    }
  };
  walk("", false);
  for (const rel of rels) {
    let data: Buffer;
    try {
      const st = lstatSync(join(dir, rel));
      if (st.isSymbolicLink()) {
        out[rel] = `${LINK}${readlinkSync(join(dir, rel))}|${outsideTargetDigest(dir, join(dir, rel))}`;
        continue;
      }
      if (!st.isFile()) continue;
      data = readFileSync(join(dir, rel));
    } catch { continue; }
    out[rel] = createHash("sha256").update(data).digest("hex");
  }
  return out;
}

/** Top-level module/package names under `names` that Python resolves OUTSIDE the repo (stdlib or the
 *  target runtime's site-packages). Run from a neutral cwd in isolated mode so the repo cannot answer. */
function importableOutsideRepo(target: string, names: string[]): Set<string> {
  if (names.length === 0) return new Set();
  const code = "import sys,importlib.util as u\nfor n in sys.argv[1:]:\n    try:\n        if n in sys.stdlib_module_names or u.find_spec(n): print(n)\n    except Exception: print(n)\n";
  const r = spawnSync(target, ["-I", "-c", code, ...names], { cwd: tmpdir(), encoding: "utf8", timeout: 30_000 });
  // fail closed: if the probe cannot run, every name counts as shadowing
  return r.status === 0 ? new Set(r.stdout.split("\n").filter(Boolean)) : new Set(names);
}

/** First way `now` departs from the sealed `base` set, or null: a sealed test/config file changed or
 *  removed; a test file or config-class file (conftest.py, pytest config, pytest shim, sitecustomize/
 *  usercustomize, .pth) the base never had; or a .py outside the card's `files` changed, removed or added.
 *  Without `files`, only the importable-outside-repo fallback applies to added modules (a changed
 *  existing module cannot be told apart from the unit's own code). */
function conformanceDrift(base: Record<string, string>, now: Record<string, string>, files: string[] | undefined, target: string): string | null {
  const sealed = (p: string): boolean => TEST_FILE.test(p) || PYTEST_CFG.test(p);
  const listed = (p: string): boolean => !!files?.some((f) => p === f || p.startsWith(f.replace(/\/?$/, "/")));
  const link = (h: string | undefined): boolean => !!h?.startsWith(LINK);
  // Sealed test/config files and any symlink (new or changed, listed or not: pytest follows linked dirs
  // and collects conftest.py inside) are immutable. Otherwise a listed path may change; an unlisted one
  // may not when a file list exists, and without one non-.py data is immutable.
  const immutable = (p: string, linked: boolean): boolean =>
    sealed(p) || linked || (!listed(p) && (!!files || !p.toLowerCase().endsWith(".py")));
  for (const [p, h] of Object.entries(base)) {
    if (now[p] === h) continue;
    if (immutable(p, link(h) || link(now[p]))) return `${p} ${p in now ? "changed" : "removed"}`;
  }
  const added = Object.keys(now).filter((p) => !(p in base));
  for (const p of added) if (immutable(p, link(now[p]))) return `${p} added`;
  if (files) return null;
  const tops = [...new Set(added.map((p) => p.split("/")[0]!.replace(/\.py$/, "")))];
  const bad = importableOutsideRepo(target, tops);
  const hit = added.find((p) => bad.has(p.split("/")[0]!.replace(/\.py$/, "")));
  return hit ? `${hit} added (shadows a module importable outside the repo)` : null;
}

/** Why the post-implement run is not a full pass of the sealed tests, or null. Fails closed. `expected` are the
 *  sealed test identities ("classname::name"); every one must have outcome passed (not skipped, xfailed,
 *  xpassed or error). Identities outside the set never count. */
export function conformanceShortfall(expected: string[] | undefined, now: Pick<BaseRunOutcome, "counts" | "tests"> | undefined): string | null {
  if (!expected || expected.length === 0) return "no sealed test identities were recorded";
  if (!now?.counts || !now.tests) return "no verified pytest footer (the run did not finish or its report disagrees)";
  if (now.counts.failed > 0 || now.counts.errors > 0) return `${now.counts.failed} failed, ${now.counts.errors} errors`;
  const bad = expected.filter((id) => now.tests![id] !== "passed");
  if (bad.length === 0) return null;
  return `${bad.length} of ${expected.length} sealed tests did not pass (${bad.slice(0, 3).map((id) => `${id}: ${now.tests![id] ?? "did not run"}`).join(", ")})`;
}

// ---------------------------------------------------------------------------------------------
// (1)/(2): card to v10 run orchestration.
// ---------------------------------------------------------------------------------------------

/** One unit's card (section 3.3 plan.json / units/<unit>.md), narrowed to what runUnit needs.
 *  `newTreeDir` defaults to `repoDir` (implementation happens in place) -- per-unit worktree
 *  isolation is the scheduler's job (M-17), not this file's. */
export interface UnitCard {
  unit: string;
  repoDir: string;
  mid: string;
  target: ModernizeTarget;
  normalizers: EquivNormalizers;
  /** The unit's own files (paths or directories, relative to the tree); implement may add or change .py only under these. */
  files?: string[];
  newTreeDir?: string;
  baseSha?: string | null;
}

/** Modernizes one unit in place. Receives the card and must leave `newTreeDir` (repoDir, by
 *  default) with the modernized code before returning. runUnit never calls this until the oracle
 *  is sealed and verified and the pre-sealed Wall is sealed and verified (1)/(2) above. */
export type Implementer = (card: UnitCard) => void;

export interface UnitRunResult {
  unit: string;
  verdict: "PROVEN" | "NOT_EQUAL" | "NOT_PROVEN";
  oracle: SealedOracle | null;
  wall: PreSealedWallResult | null;
  equiv: EquivResult | null;
  not_proven: string[];
  /** Set only on PROVEN: the conformance leg is runner_reported under the FC-24 limit. null on every other verdict. */
  conformance: { trust: "runner_reported"; limit: "FC-24"; tests: number } | null;
}

function notProvenUnitResult(
  unit: string,
  reason: string,
  oracle: SealedOracle | null,
  wall: PreSealedWallResult | null,
): UnitRunResult {
  return { unit, verdict: "NOT_PROVEN", oracle, wall, equiv: null, not_proven: [reason], conformance: null };
}

function readOracleSealed(repoDir: string, mid: string, unit: string): SealedOracle {
  return JSON.parse(readFileSync(join(oracleDir(repoDir, mid, unit), "sealed.json"), "utf8")) as SealedOracle;
}

/** True once this unit's oracle already has a sealing event, without needing sealOracle's own
 *  throw -- lets runUnit tell "already sealed from a prior/resumed run" apart from any other
 *  sealOracle failure (missing cases.jsonl/coverage.json), which must still surface. */
function oracleAlreadySealed(repoDir: string, mid: string, unit: string): boolean {
  return readModernizeEvents(repoDir, mid).some(
    (e) => (e.type === "oracle.captured" || e.type === "oracle.flagged") && e.data.unit === unit,
  );
}

/** Card to v10 run: seals the oracle, seals and verifies the pre-sealed Wall against the base
 *  tree, only THEN runs the implementation, and finally checks equivalence -- section 3.4/3.5,
 *  D30. Every step that can fail turns into a NOT_PROVEN result rather than a thrown error, same
 *  discipline as equiv.ts's checkEquivalence: "claims stop exactly where equivalence data stops."
 *
 *  Ordering (1): sealOracle is the very first call in this function, strictly before
 *  `implement(card)` -- nothing on any path below reaches `implement` before it.
 *  Trust (2): verifySeal gates whether the just-sealed (or resumed) oracle is trusted at all;
 *  verifyPreSealedWall gates whether the just-sealed (or resumed) Wall is trusted, both re-read
 *  from disk/log rather than taken from a return value. */
export function runUnit(
  card: UnitCard,
  log: ModernizeLog,
  runConformance: BaseConformanceRunner,
  implement: Implementer,
  runNew: NewCaseRunner,
  /** Runs an oracle case against the unit REPLACED BY STUBS (the no-op ablation). Required for PROVEN. */
  runStub?: NewCaseRunner,
  /** Collects the sealed test files' nodeids after implement; required when the base was a collection error. */
  collect?: CollectRunner,
): UnitRunResult {
  const { repoDir, mid, unit } = card;
  const newTreeDir = card.newTreeDir ?? repoDir;

  // (1) sealOracle first, unconditionally, before implement is ever reachable below.
  if (!oracleAlreadySealed(repoDir, mid, unit)) {
    try {
      sealOracle(repoDir, mid, unit, log, card.normalizers);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return notProvenUnitResult(unit, `sealOracle failed: ${msg}`, null, null);
    }
  }

  // (2) verifySeal before trusting the oracle for anything downstream.
  const oracleCheck = verifySeal(repoDir, mid, unit);
  if (!oracleCheck.ok) {
    return notProvenUnitResult(unit, `oracle seal invalid: ${oracleCheck.reason ?? "unknown"}`, null, null);
  }
  const oracle = readOracleSealed(repoDir, mid, unit);

  // Pre-sealed Wall: runs the conformance check on the base (unmodernized) tree, still before
  // `implement` -- a green or not_run base refuses the seal outright (section 7, D42 (3)).
  let freshSeal = false;
  let expected: string[] | null | undefined; // sealed test identities; null = base never collected, derive post-implement
  try {
    const attempt = sealPreSealedWall(repoDir, mid, unit, card.target, (u, d) => {
      const o = runConformance(u, d);
      expected = o.exitCode === 2 ? null : o.tests && Object.entries(o.tests).filter(([, v]) => v === "passed" || v === "failed" || v === "error").map(([k]) => k);
      return o;
    }, log, card.baseSha ?? null);
    if (!attempt.sealed) {
      return notProvenUnitResult(unit, attempt.reason ?? "presealed wall not sealed", oracle, attempt);
    }
    freshSeal = true;
  } catch (e) {
    // Write-once throw: already sealed from a prior/resumed run. verifyPreSealedWall below is the
    // real trust check regardless of why this call produced no fresh seal.
    void e;
  }

  // (2) verifyPreSealedWall before trusting the Wall, whether just sealed above or resumed --
  // never taken from sealPreSealedWall's own return value alone.
  const wallCheck = verifyPreSealedWall(repoDir, mid, unit);
  if (!wallCheck.ok) {
    return notProvenUnitResult(unit, `presealed wall invalid: ${wallCheck.reason ?? "unknown"}`, oracle, null);
  }
  // Read the classification back from the sealing event itself ("wall.presealed.sealed",
  // duplicated here the same way presealed_wall.ts's own file header duplicates D42 (3) from
  // wall.ts, rather than importing an unexported constant) instead of assuming it. sealPreSealedWall
  // only ever writes a seal on "red", so this is always "red" today, but the B2 ablation check
  // below reads it explicitly rather than trusting that invariant silently across a refactor.
  const sealedEvent = readModernizeEvents(repoDir, mid).find(
    (e) => e.type === "wall.presealed.sealed" && e.data.unit === unit,
  );
  const wall: PreSealedWallResult = {
    unit,
    classification: sealedEvent?.data.classification === "red" ? "red" : "not_run",
    sealed: true,
  };

  // (6) Bind the conformance files to the seal: hashed from the pristine base tree, persisted as an
  // event so a resumed run never re-hashes an already modified tree. No record, no PROVEN.
  const bound = readModernizeEvents(repoDir, mid).find((e) => e.type === CONF_EVENT && e.data.unit === unit);
  let sealedHashes = bound?.data.files as Record<string, string> | undefined;
  if (!sealedHashes) {
    if (!freshSeal) return notProvenUnitResult(unit, "conformance files not bound to the seal (no record from seal time)", oracle, wall);
    sealedHashes = conformanceHashes(repoDir);
    log.append(CONF_EVENT, { unit, files: sealedHashes, expected: expected === undefined ? [] : expected });
  } else {
    expected = bound?.data.expected as string[] | null | undefined;
  }

  // Only now: the actual code change.
  implement(card);
  purgePycache(newTreeDir);

  const equiv = checkEquivalence(repoDir, mid, unit, newTreeDir, card.normalizers, runNew, log);
  if (equiv.verdict !== "PROVEN") {
    return { unit, verdict: equiv.verdict, oracle, wall, equiv, not_proven: equiv.not_proven, conformance: null };
  }

  // No-op ablation (MODERNIZE.md:153, :262): the oracle cases run against the unit replaced by
  // stubs must FAIL equivalence. A logger that discards keeps this probe out of the unit's receipt.
  if (!runStub) return notProvenUnitResult(unit, "ablation not run", oracle, wall);
  const discard = { append: () => ({}) } as unknown as ModernizeLog;
  const ablation = checkEquivalence(repoDir, mid, unit, newTreeDir, card.normalizers, runStub, discard);
  if (ablation.verdict === "PROVEN") {
    return notProvenUnitResult(unit, "oracle does not constrain unit", oracle, wall);
  }
  if (ablation.verdict !== "NOT_EQUAL") {
    return notProvenUnitResult(unit, `ablation inconclusive: ${ablation.not_proven.join("; ")}`, oracle, wall);
  }
  // Conformance files must be byte-identical to the sealed base (tests, conftest.py, pytest config).
  const drift = conformanceDrift(sealedHashes, conformanceHashes(newTreeDir), card.files, card.target);
  if (drift) return notProvenUnitResult(unit, `conformance files changed since the Wall sealed: ${drift}`, oracle, wall);
  // Target conformance: the same check, re-run against the MODERNIZED tree, must now pass (exit
  // 0 / green) -- a unit whose cases match the oracle but whose target-runtime conformance still
  // fails (or cannot even run) has not actually been modernized.
  purgePycache(newTreeDir);
  const newOutcome = runConformance(unit, newTreeDir);
  const newClassification = classifyBaseRun(newOutcome, newTreeDir);
  if (newClassification !== "green") {
    return notProvenUnitResult(
      unit,
      `target conformance did not pass on the modernized tree (classified ${newClassification})`,
      oracle,
      wall,
    );
  }
  // A bare exit 0 is not proof (os._exit(0), pytest.exit, an all-skipped or xfailed run): every sealed test
  // identity must appear in the runner-reported junit report (FC-24) with outcome passed.
  let want = expected ?? undefined;
  if (expected === null) {
    const files = Object.keys(sealedHashes).filter((p) => TEST_FILE.test(p) && !p.split("/").some(skipName) && !sealedHashes![p]!.startsWith(LINK) && !sealedHashes![p]!.startsWith("entry:"));
    if (!collect || files.length === 0) return notProvenUnitResult(unit, "target conformance run is not a full pass: base never collected and no sealed tests can be collected", oracle, wall);
    const col = collect(unit, newTreeDir, files);
    if (!col.ok) return notProvenUnitResult(unit, `target conformance run is not a full pass: ${col.reason}`, oracle, wall);
    want = col.nodeids.map(nodeidKey);
  }
  const shortfall = conformanceShortfall(want, newOutcome);
  if (shortfall) return notProvenUnitResult(unit, `target conformance run is not a full pass: ${shortfall}`, oracle, wall);

  const tests = want!.length; // non-empty: conformanceShortfall refuses an empty or missing set
  log.append("unit.conformance_passed", { unit, trust: "runner_reported", limit: "FC-24", tests });
  return { unit, verdict: "PROVEN", oracle, wall, equiv, not_proven: [], conformance: { trust: "runner_reported", limit: "FC-24", tests } };
}
