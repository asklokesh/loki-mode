// Python subprocess wrapper.
// Loki's memory/, mcp/, and dashboard/ packages stay in Python; the Bun
// runner shells out exactly the way bash does today.
//
// Detection priority mirrors autonomy/run.sh's expectations:
//   1. /opt/homebrew/bin/python3.12  (macOS, required by chromadb / sentence-transformers)
//   2. python3.12 on PATH
//   3. python3 on PATH (fallback for distros where 3.12 is the system default)
import { commandExists, run } from "./shell.ts";
import type { ShellResult } from "./shell.ts";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tokenFreeEnv } from "./safe_git.ts";
import type { BaseConformanceRunner, BaseRunOutcome, PytestCounts, TestOutcome } from "../engine10/modernize/presealed_wall.ts";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

let _pythonCache: string | null | undefined;

export async function findPython3(): Promise<string | null> {
  if (_pythonCache !== undefined) return _pythonCache;

  const homebrew = "/opt/homebrew/bin/python3.12";
  if (existsSync(homebrew)) {
    _pythonCache = homebrew;
    return homebrew;
  }

  const py312 = await commandExists("python3.12");
  if (py312) {
    _pythonCache = py312;
    return py312;
  }

  const py3 = await commandExists("python3");
  _pythonCache = py3;
  return py3;
}

export async function pythonAvailable(): Promise<boolean> {
  return (await findPython3()) !== null;
}

// Run a Python module: equivalent to `python3 -m <module> <args>`.
export async function runModule(
  module: string,
  args: readonly string[] = [],
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ShellResult> {
  const py = await findPython3();
  if (!py) {
    return {
      stdout: "",
      stderr: `python3 not found (looked for /opt/homebrew/bin/python3.12, python3.12, python3)`,
      exitCode: 127,
    };
  }
  return run([py, "-m", module, ...args], opts);
}

// Run an inline Python script: equivalent to `python3 -c '<source>'`.
// Use this for the small inline blocks that bash uses today (e.g., budget gauge,
// JSON aggregation in cmd_status_json, cmd_stats, cmd_doctor_json).
export async function runInline(
  source: string,
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ShellResult> {
  const py = await findPython3();
  if (!py) {
    return {
      stdout: "",
      stderr: "python3 not found",
      exitCode: 127,
    };
  }
  return run([py, "-c", source], opts);
}

// Resolve an interpreter the way autonomy/run.sh _loki_snapshot_py_tool does:
// /usr/bin/python3 and /bin/python3 first, then python3 in each ABSOLUTE PATH
// dir, each probed with `-I -S -c ''`. Callers run it with -I -S so neither
// PYTHON* env, the cwd, nor a user-site .pth can load code. Not cached: the
// answer depends on PATH at call time.
const ISOLATED_FIXED = ["/usr/bin/python3", "/bin/python3"];
let _isolatedFixed: readonly string[] = ISOLATED_FIXED;

export async function findIsolatedPython3(): Promise<string | null> {
  const dirs = (process.env["PATH"] ?? "").split(":").filter((d) => d.startsWith("/"));
  for (const c of [..._isolatedFixed, ...dirs.map((d) => `${d}/python3`)]) {
    try {
      if (!statSync(c).isFile()) continue;
      accessSync(c, constants.X_OK);
      const r = await run([c, "-I", "-S", "-c", ""], { timeoutMs: 10000 });
      if (r.exitCode === 0) return c;
    } catch {
      /* missing, not executable, or unspawnable: try the next one */
    }
  }
  return null;
}

// Test-only override of the fixed candidates (null restores the default).
export function _setIsolatedPythonFixedForTests(c: readonly string[] | null): void {
  _isolatedFixed = c ?? ISOLATED_FIXED;
}

// Test-only reset for the cache. Used by python.test.ts.
export function _resetPythonCacheForTests(): void {
  _pythonCache = undefined;
}

// Signature-only python heads for the Wall manifest (moved from features/wall_manifest.ts to keep features under its D66 cap).
const PY_TIMEOUT_MS = 5000;
const PY_SCRIPT = `
import ast, sys, json, re
def u(n): return ast.unparse(n)
def chain(n):
    if isinstance(n, ast.Name): return n.id
    if isinstance(n, ast.Attribute):
        c = chain(n.value)
        return None if c is None else c + "." + n.attr
    return None
def deco(d):
    if isinstance(d, ast.Call):
        c = chain(d.func)
        return "@" + c + "(...)" if c else "@..."
    c = chain(d)
    return "@" + c if c else "@..."
def lit(n):
    if isinstance(n, ast.Constant): return u(n)
    if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.USub) and isinstance(n.operand, ast.Constant): return u(n)
    if isinstance(n, ast.Tuple):
        p = [lit(e) for e in n.elts]
        return None if None in p else ", ".join(p)
    return chain(n)
def ann(n):
    if isinstance(n, (ast.Name, ast.Attribute)): return chain(n)
    if isinstance(n, ast.Constant): return u(n) if (n.value is None or n.value is Ellipsis) else None
    if isinstance(n, ast.BinOp) and isinstance(n.op, ast.BitOr):
        l, r = ann(n.left), ann(n.right)
        return None if l is None or r is None else l + " | " + r
    if isinstance(n, ast.List):
        p = [ann(e) for e in n.elts]
        return None if None in p else "[" + ", ".join(p) + "]"
    if isinstance(n, ast.Tuple):
        p = [ann(e) for e in n.elts]
        return None if None in p else ", ".join(p)
    if isinstance(n, ast.Subscript):
        v = chain(n.value)
        if v is None: return None
        last = v.split(".")[-1]
        if last == "Literal":
            s = lit(n.slice)
            return None if s is None else v + "[" + s + "]"
        if last == "Annotated" and isinstance(n.slice, ast.Tuple) and n.slice.elts:
            first = ann(n.slice.elts[0])
            return None if first is None else v + "[" + first + ", ...]"
        s = ann(n.slice)
        return None if s is None else v + "[" + s + "]"
    return None
def a_or_dots(n):
    r = ann(n)
    return "..." if r is None else r
def clean(n):
    r = ann(n)
    return "..." if r is None else r
def arg(a, has_default):
    t = a.arg
    if a.annotation is not None: t += ": " + a_or_dots(a.annotation)
    if has_default: t += " = ..." if a.annotation is not None else "=..."
    return t
def args(a):
    pos = list(a.posonlyargs) + list(a.args)
    first_default = len(pos) - len(a.defaults)
    out = []
    for i, x in enumerate(pos):
        out.append(arg(x, i >= first_default))
        if a.posonlyargs and i == len(a.posonlyargs) - 1: out.append("/")
    if a.vararg is not None: out.append("*" + arg(a.vararg, False))
    elif a.kwonlyargs: out.append("*")
    for x, d in zip(a.kwonlyargs, a.kw_defaults): out.append(arg(x, d is not None))
    if a.kwarg is not None: out.append("**" + arg(a.kwarg, False))
    return ", ".join(out)
def fn(n, ind):
    r = [ind + deco(d) for d in n.decorator_list]
    h = ind + ("async def " if isinstance(n, ast.AsyncFunctionDef) else "def ") + n.name + "(" + args(n.args) + ")"
    if n.returns is not None: h += " -> " + a_or_dots(n.returns)
    return r + [h + ":"]
def cls(n):
    r = [deco(d) for d in n.decorator_list]
    parts = [clean(b) for b in n.bases] + [(k.arg + "=" + clean(k.value)) if k.arg else "**..." for k in n.keywords]
    return r + ["class " + n.name + ("(" + ", ".join(parts) + ")" if parts else "") + ":"]
tree = ast.parse(sys.stdin.read())
out = []
for n in tree.body:
    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and not n.name.startswith("_"):
        out += fn(n, "")
    elif isinstance(n, ast.ClassDef) and not n.name.startswith("_"):
        out += cls(n)
        for m in n.body:
            if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and (not m.name.startswith("_") or re.fullmatch(r"__\\w+__", m.name)):
                out += fn(m, "    ")
    else:
        t = n.targets[0] if isinstance(n, ast.Assign) and len(n.targets) == 1 else (n.target if isinstance(n, ast.AnnAssign) else None)
        if isinstance(t, ast.Name) and re.fullmatch(r"[A-Z][A-Z0-9_]*", t.id): out.append(t.id + " = ...")
print(json.dumps(out))
`;

// Python signatures from the stdlib ast, run in an isolated interpreter (-I -S) from a neutral cwd with the
// source on stdin. Any parse error, missing python3, or timeout yields no signatures for the file.
// Trusted interpreter boundary: an absolute PATH entry (for example a venv) is trusted; relative entries are not.
function resolvePython3(): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir || !dir.startsWith("/")) continue;
    const cand = `${dir}/python3`;
    try { accessSync(cand, constants.X_OK); if (statSync(cand).isFile()) return cand; } catch { /* next */ }
  }
  return null;
}

export function pySignatures(src: string): string[] {
  try {
    const py = resolvePython3();
    if (!py) return [];
    const r = spawnSync(py, ["-I", "-S", "-c", PY_SCRIPT], {
      input: src.replace(/\r\n?/g, "\n"), cwd: tmpdir(), timeout: PY_TIMEOUT_MS, encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"],
    });
    if (r.error || r.status !== 0) return [];
    const parsed: unknown = JSON.parse(r.stdout);
    return Array.isArray(parsed) && parsed.every((l) => typeof l === "string") ? (parsed as string[]) : [];
  } catch { return []; }
}

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
      env: { ...tokenFreeEnv(), PYTHONDONTWRITEBYTECODE: "1", PYTHONPYCACHEPREFIX: pycPrefix },
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
