// D50-F2-S1: classify a pytest test-file edit as a pure literal "value-change" or "weakened". Pure and fail closed: anything unparsed, non-pytest, structural or doubtful is "weakened".
// Structure (decorators, parametrize row counts, assert counts, everything else) must be identical once every literal is normalised to its Python type, and the run and skip counts
// must be exactly equal to base. Never keyed on collected test ids (parametrize ids move).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basename } from "node:path";
import { safeGit } from "../util/safe_git.ts";
export interface AssertDeltaInput {
  path: string;
  base: string;
  head: string;
  task: string; // a changed literal must appear verbatim in it
  baseCounts: { run: number; skipped: number };
  headCounts: { run: number; skipped: number };
}
export interface AssertDeltaResult {
  verdict: "value-change" | "weakened";
  changes: string[]; // "file:line old -> new"
  items?: { line: number; old: string; new: string; matched: "new" }[];
}
const WEAKENED: AssertDeltaResult = { verdict: "weakened", changes: [] };
const PY = String.raw`
import ast, copy, io, json, re, sys, tokenize
d = json.load(sys.stdin)
bs, hs, task = d["base"], d["head"], d["task"]
def out(v, it=()):
    print(json.dumps({"verdict": v, "items": list(it)}))
    sys.exit(0)
if "\r" in bs or "\r" in hs or "\t" in bs or "\t" in hs:
    out("weakened")
bt, ht = ast.parse(bs), ast.parse(hs)
# every byte outside a literal token (comments, blank lines, spacing, other code) must be identical
def template(src):
    lines = src.split("\n")
    starts, o = [], 0
    for ln in lines:
        starts.append(o)
        o += len(ln) + 1
    spans = [(starts[t.start[0] - 1] + t.start[1], starts[t.end[0] - 1] + t.end[1])
             for t in tokenize.generate_tokens(io.StringIO(src).readline) if t.type in (tokenize.STRING, tokenize.NUMBER)]
    r, pos = [], 0
    for a, b in spans:
        r.append(src[pos:a] + "\0")
        pos = b
    return "".join(r) + src[pos:]
if template(bs) != template(hs):
    out("weakened")
class Norm(ast.NodeTransformer):
    def visit_Constant(self, n):
        return ast.copy_location(ast.Constant(value="<" + type(n.value).__name__ + ">"), n)
def norm(t):
    return ast.dump(Norm().visit(copy.deepcopy(t)))
# only what pytest collects: module-level test functions and methods of Test* classes without __init__
def tests(t):
    r = []
    for n in t.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test"):
            r.append(n)
        elif isinstance(n, ast.ClassDef) and n.name.startswith("Test") \
                and not any(isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and m.name == "__init__" for m in n.body):
            r += [m for m in n.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and m.name.startswith("test")]
    return r
def direct(f):
    return [a for a in f.body if isinstance(a, ast.Assert)]
def tables(t):
    return [n.args[1] for n in ast.walk(t) if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "parametrize"
            and len(n.args) > 1 and isinstance(n.args[1], (ast.List, ast.Tuple))]
def stripped(t):
    c = copy.deepcopy(t)
    for tb in tables(c):
        tb.elts = []
    return c
def consts(t):
    return [n for n in ast.walk(t) if isinstance(n, ast.Constant)]
def shadowed(t):
    for scope in [t] + [n for n in t.body if isinstance(n, ast.ClassDef)]:
        names = [n.name for n in scope.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test")]
        if len(names) != len(set(names)):
            return True
    return False
if shadowed(bt) or shadowed(ht):
    out("weakened")
sb, sh = stripped(bt), stripped(ht)
if not tests(ht) or norm(sb) != norm(sh):
    out("weakened")
for t in (bt, ht):
    if any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "round" for n in ast.walk(t)):
        out("weakened")
tb, th = tables(bt), tables(ht)
if any(len(x.elts) != len(y.elts) for x, y in zip(tb, th)):
    out("weakened")
if any(norm(r) != norm(q) for x, y in zip(tb, th) for r, q in zip(x.elts, y.elts)):
    out("weakened")
owner = {}
for f in tests(sh):
    for n in ast.walk(f):
        owner[id(n)] = f
pairs = [(b, h, owner.get(id(h))) for b, h in zip(consts(sb), consts(sh))]
fh = {}
for f in tests(ht):
    for t in tables(f):
        fh[id(t)] = f
for x, y in zip(tb, th):
    for r, q in zip(x.elts, y.elts):
        pairs += [(b, h, fh.get(id(y))) for b, h in zip(consts(r), consts(q))]
def eqs(f):
    return [a.test for a in direct(f) if isinstance(a.test, ast.Compare) and len(a.test.ops) == 1 and isinstance(a.test.ops[0], ast.Eq)]
def dups(t):
    r = {}
    for f in tests(t):
        ds = [ast.dump(a) for a in direct(f)]
        r[f.name] = len(ds) - len(set(ds))
    return r
dh, db = dups(ht), dups(bt)
ok = not any(v > db.get(k, 0) for k, v in dh.items())
# expected side = the right operand of a direct "assert X == Y"
exp = set()
for f in tests(sh):
    exp |= {id(c.comparators[0]) for c in eqs(f) if isinstance(c.comparators[0], ast.Constant)}
for f in tests(ht):
    rights = {id(c.comparators[0]) for c in eqs(f) if isinstance(c.comparators[0], ast.Name)}
    for c in f.decorator_list:
        if isinstance(c, ast.Call) and getattr(c.func, "attr", "") == "parametrize" and len(c.args) > 1 \
                and isinstance(c.args[0], ast.Constant) and isinstance(c.args[0].value, str) and isinstance(c.args[1], (ast.List, ast.Tuple)):
            cols = [x.strip() for x in c.args[0].value.split(",")]
            # a column counts only if every use of its name in the body is the right operand of a direct eq assert
            if any(kw.arg == "indirect" for kw in c.keywords):
                continue
            deco = {id(m) for dd in f.decorator_list for m in ast.walk(dd)}
            uses = {k: [n for n in ast.walk(f) if isinstance(n, ast.Name) and n.id == k and id(n) not in deco] for k in cols}
            # the column must be read at least once, and only as the right operand of a direct eq assert
            solo = {k for k, u in uses.items() if u and all(id(n) in rights for n in u)}
            for r in c.args[1].elts:
                for i, e in enumerate(r.elts if isinstance(r, (ast.Tuple, ast.List)) else [r]):
                    if isinstance(e, ast.Constant) and i < len(cols) and cols[i] in solo:
                        exp.add(id(e))
def callees(f):
    r = set()
    for c in eqs(f):
        for n in ast.walk(c.left):
            if isinstance(n, ast.Call):
                k = n.func.id if isinstance(n.func, ast.Name) else getattr(n.func, "attr", "")
                if k:
                    r.add(k)
    return r
def generic(v):
    return v is None or isinstance(v, (bool, bytes)) or (isinstance(v, str) and len(v) <= 3) \
        or (isinstance(v, (int, float)) and abs(v) < 10)
def in_task(v, f):
    task0 = d["task"]
    t = v if isinstance(v, str) else repr(v)
    if t == "":
        return False
    # bounded by whitespace, string ends or ,;:()[]{}"' only; never glued to - + or a digit group separator
    tok = r"(?<![^\s,;:()\[\]{}\"'])(?<!\d,)" + re.escape(t) + r"(?:(?=[\s,;:()\[\]{}\"']|$)(?!,\d)|\.(?=\s|$))"
    task = re.sub(r"(?<=\d),(?=\d{3}\b)", "", task0)
    if not generic(v):
        return re.search(tok, task) is not None
    # a generic value counts only right next to the identifier the test calls
    return any(re.search(r"\b" + re.escape(k) + r"\b[^\n]{0,40}?" + tok, task) for k in (callees(f) if f else ()))
items = []
for b, h, f in pairs:
    if (type(b.value), repr(b.value)) != (type(h.value), repr(h.value)):
        hit = in_task(h.value, f)
        ok = ok and id(h) in exp and hit
        items.append({"line": h.lineno, "old": repr(b.value), "new": repr(h.value), "inTask": hit, "matched": "new"})
out("value-change" if ok and items else "weakened", items if ok else [])
`;
// Receipt strings must be short single-line text; anything else is a forged or broken classifier answer.
const okStr = (v: unknown): v is string => typeof v === "string" && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
export function classifyAssertDelta(inp: AssertDeltaInput): AssertDeltaResult {
  const f = basename(inp.path);
  if (!/^(test_.*|.*_test)\.py$/.test(f)) return WEAKENED;
  if (inp.headCounts.run !== inp.baseCounts.run || inp.headCounts.skipped !== inp.baseCounts.skipped) return WEAKENED;
  // -I plus an empty cwd: a copy.py/json.py/ast.py planted in the repo under test cannot shadow the stdlib
  let cwd = "";
  try {
    cwd = mkdtempSync(join(tmpdir(), "loki-ad-"));
    const raw = execFileSync("python3", ["-I", "-c", PY], {
      input: JSON.stringify({ path: inp.path, base: inp.base, head: inp.head, task: inp.task }),
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 20_000,
    });
    const r = JSON.parse(raw) as { verdict?: unknown; items?: unknown };
    if (r.verdict !== "value-change" || !Array.isArray(r.items) || r.items.length === 0) return WEAKENED;
    const items: NonNullable<AssertDeltaResult["items"]> = [];
    for (const i of r.items as Record<string, unknown>[]) {
      if (!i || typeof i !== "object" || !Number.isInteger(i["line"]) || (i["line"] as number) < 1 || !okStr(i["old"]) || !okStr(i["new"]) || i["inTask"] !== true || i["matched"] !== "new") return WEAKENED;
      items.push({ line: i["line"] as number, old: i["old"], new: i["new"], matched: "new" });
    }
    return { verdict: "value-change", changes: items.map((i) => `${inp.path}:${i.line} ${i.old} -> ${i.new}`), items };
  } catch {
    return WEAKENED;
  } finally {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
}
type Counts = { run: number; skipped: number };
/** Receipt lines for an edited pre-existing test: `assertion value changed (not shown to be required by the task): file:line old -> new` per entry on a labelled value-change, else null; callers keep `weakened test` beside them
 *  (the caller keeps `weakened test`). headRef null reads the worktree. Missing counts or any failure is null (fail closed). */
export function assertDeltaNotes(repoDir: string, baseSha: string, headRef: string | null, path: string, task: string, baseCounts?: Counts, headCounts?: Counts): string[] | null {
  if (!baseCounts || !headCounts) return null;
  try {
    const show = (ref: string): string => safeGit(repoDir, ["show", `${ref}:${path}`]);
    const head = headRef ? show(headRef) : readFileSync(join(repoDir, path), "utf8");
    const r = classifyTestEdit(path, show(baseSha), head, task, baseCounts, headCounts);
    return r[0]?.kind ==="literal-only" ? r.map((e) => `assertion value changed (not shown to be required by the task): ${e.file}:${e.line} ${e.old} -> ${e.new}`) : null;
  } catch {
    return null;
  }
}
export interface TestEdit { kind: "literal-only" | "weakened"; file: string; line: number; old: string; new: string; inTask: boolean }
/** D53 gate: pure. One "literal-only" entry per changed expected-value literal (each appears verbatim in the task), else a single "weakened" entry. Any doubt is "weakened".
 *  old and new are Python reprs. Counts are required. */
export function classifyTestEdit(file: string, oldText: string, newText: string, taskText: string, baseCounts: Counts, headCounts: Counts): TestEdit[] {
  const weak: TestEdit[] = [{ kind: "weakened", file, line: 0, old: "", new: "", inTask: false }];
  const r = classifyAssertDelta({ path: file, base: oldText, head: newText, task: taskText, baseCounts, headCounts });
  if (r.verdict !== "value-change" || !r.items?.length) return weak;
  return r.items.map((i) => ({ kind: "literal-only" as const, file, line: i.line, old: i.old, new: i.new, inTask: true }));
}

// FC-WEAKENED-TEST-IMPORT-WIDENING: an edit to a pre-existing test file weakens it only if a non-import, non-comment line was removed, a previously imported name was dropped, or a skip/only/todo marker was added.
// Language-agnostic line classifier; pure and fail closed (an oversized or unreadable diff is weakening).
const COMMENT_LINE = /^(\/\/|#(?![[!])|\/\*|\*|--(?:\s|-|$)|<!--|;+\s*$|;;)/; // `--x` and `;x` are code (a prefix decrement, a leading-semicolon statement), not comments
const IMPORT_START = /^(import\b|from\s+\S+\s+import\b|use\s+[^(\s]|using\s+[^(\s]|#include\b|extern\s+crate\b|require(_relative)?\b|load\s*\(|(const|let|var)\b.*\brequire\s*\()/;
const CALL_CHAIN_IMPORT = /^(?:require|import)\s*\([^)]*\)\s*[.[]/;
const IMPORT_KEYWORDS = new Set(["import", "from", "as", "use", "using", "include", "require", "require_relative", "const", "let", "var", "static", "type", "crate", "extern", "load", "self"]);
const SKIP_MARKER = /\b(xit|xdescribe|xtest|xcontext|fit|fdescribe)\s*\(|\.(skip|only|todo|skipIf|skipUnless|fixme)\b|\b(skipTest|skipif|skipUnless|xfail|expectedFailure)\b|@(skip|Ignore|Ignored|Disabled)\b|#\[ignore\b|\bt\.Skip(Now|f)?\s*\(|\bSkip\s*=|\bpending\s*\(/;
const MAX_DIFF_CELLS = 25_000_000;
const isIgnorable = (l: string): boolean => { const t = l.trim(); return t === "" || COMMENT_LINE.test(t); };
const depth = (l: string): number => { let d = 0; for (const c of l) { if ("([{".includes(c)) d++; else if (")]}".includes(c)) d--; } return d; };
/** Zero-based line indexes inside an import statement (bracket-balanced, so multi-line import lists are covered). */
function importLines(lines: string[]): Set<number> {
  const r = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!IMPORT_START.test(t) || CALL_CHAIN_IMPORT.test(t)) continue; // require("x").y... and import("x").then(...) run code on the live module: not a bare import
    let d = depth(lines[i]!), j = i;
    r.add(i);
    while ((d > 0 || /\\\s*$/.test(lines[j]!)) && j + 1 < lines.length) { j++; d += depth(lines[j]!); r.add(j); }
    i = j;
  }
  return r;
}
const importTokens = (lines: string[], idx: Set<number>): Set<string> => {
  const r = new Set<string>();
  // a quoted module path is one token and a dotted path is one token, so a module segment never stands in for a dropped name
  for (const i of idx) for (const t of lines[i]!.match(/"[^"]*"|'[^']*'|`[^`]*`|<[^<>]*>|[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*/g) ?? []) if (!IMPORT_KEYWORDS.has(t)) r.add(t);
  return r;
};
/** Indexes of base lines absent from head and head lines absent from base (LCS over trimmed-prefix/suffix-stripped lines), or null when too large to diff. */
function lineDelta(a: string[], b: string[]): { removed: number[]; added: number[] } | null {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length, eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - lo, m = eb - lo;
  if (n * m > MAX_DIFF_CELLS) return null;
  const w = m + 1, t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = a[lo + i] === b[lo + j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  const removed: number[] = [], added: number[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[lo + i] === b[lo + j]) { i++; j++; } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) removed.push(lo + i++); else added.push(lo + j++);
  }
  while (i < n) removed.push(lo + i++);
  while (j < m) added.push(lo + j++);
  return { removed, added };
}
// An added line is only safe as part of a new top-level test block. These are weakening wherever they sit: an early exit before the
// asserts, a mock or patch of the code under test, a comment or docstring opener that can swallow asserts, a shadowing of the
// assertion API, or a duplicate of an existing test name that replaces it.
const EARLY_EXIT = /\breturn\b\s*;?\s*[})]*\s*$|\bif\b[^\n]*\breturn\b|\b(process\.exit|sys\.exit|os\._exit|exit)\s*\(/;
const MOCKING = /\b(jest|vi)\.(mock|doMock|spyOn|stubGlobal)\b|\bmock\.patch\b|@(mock\.)?patch\b|\bpatch(\.object)?\s*\(|\bsinon\.(stub|replace|fake)\b|\.mock(Implementation|ReturnValue|Resolved)\w*\s*\(|\bunittest\.mock\b|\bgomock\b|\bmockito\b/;
const COMMENT_OPENER = /\/\*|\*\/|"""|'''|=begin\b|<!--/;
const API_NAMES = "expect|assert|assertEqual|assertThat|should|test|it|describe|require";
const SHADOWING = new RegExp(`\\b(const|let|var|def|function|class|func|fn|val)\\s+(${API_NAMES})\\b|\\b(${API_NAMES})\\s*=[^=>]|\\bas\\s+(${API_NAMES})\\b`);
const TEST_NAME = /^\s*(?:async\s+)?(?:def|func|fn)\s+(\w+)|\b(?:test|it|describe)(?:\.\w+)?\s*\(\s*(["'`])(.+?)\2/;
const testNames = (lines: string[]): Set<string> => {
  const r = new Set<string>();
  for (const l of lines) { const m = TEST_NAME.exec(l); const n = m?.[1] ?? m?.[3]; if (n) r.add(n); }
  return r;
};
/** Bracket depth before each line and whether the line starts inside a block comment or triple-quoted string; strings and // comments do not count. */
function scanDepth(lines: string[]): { depthBefore: number[]; inBlock: boolean[]; minInLine: number[] } {
  const depthBefore: number[] = [], inBlock: boolean[] = [], minInLine: number[] = [];
  let d = 0, block: string | null = null;
  for (const line of lines) {
    depthBefore.push(d); inBlock.push(block !== null); let lo = d;
    for (let i = 0; i < line.length; i++) {
      if (block) { if (line.startsWith(block, i)) { i += block.length - 1; block = null; } continue; }
      const c = line[i]!;
      if (line.startsWith("/*", i)) { block = "*/"; i++; continue; }
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) { block = line.slice(i, i + 3); i += 2; continue; }
      if (line.startsWith("//", i) || (c === "#" && (i === 0 || /\s/.test(line[i - 1]!)))) break;
      if (c === '"' || c === "'" || c === "`") { let j = i + 1; while (j < line.length && line[j] !== c) { if (line[j] === "\\") j++; j++; } i = j; continue; }
      if ("([{".includes(c)) d++; else if (")]}".includes(c)) { d--; if (d < lo) lo = d; }
    }
    minInLine.push(lo);
  }
  return { depthBefore, inBlock, minInLine };
}
const indentOf = (l: string): number => l.length - l.trimStart().length;
/** Runs of added head lines as [start, end] head indexes with the base line index each run is inserted before. */
function addedRuns(aLen: number, bLen: number, d: { removed: number[]; added: number[] }): Array<{ from: number; to: number; before: number }> {
  const rem = new Set(d.removed), add = new Set(d.added);
  const runs: Array<{ from: number; to: number; before: number }> = [];
  let i = 0, j = 0;
  while (i < aLen || j < bLen) {
    if (i < aLen && rem.has(i)) i++;
    else if (j < bLen && add.has(j)) {
      const last = runs[runs.length - 1];
      if (last && last.to === j - 1 && last.before === i) last.to = j; else runs.push({ from: j, to: j, before: i });
      j++;
    } else { i++; j++; }
  }
  return runs;
}
/** A diff places an inserted run at one of several equivalent positions when its edge lines repeat a neighbour (a closing brace, a blank line); the run is a new block if ANY equivalent placement is. */
function runPlacedAsNewBlock(base: string[], head: string[], run: { from: number; to: number; before: number }, scan: ReturnType<typeof scanDepth>): boolean {
  for (let k = 0; ; k++) {
    const r = { from: run.from - k, to: run.to - k, before: run.before - k };
    if (r.before < 0 || r.from < 0) break;
    if (runIsNewBlock(base, head, r, scan)) return true;
    if (head[r.from - 1] !== head[r.to]) break;
  }
  for (let k = 1; ; k++) {
    const r = { from: run.from + k, to: run.to + k, before: run.before + k };
    if (r.to >= head.length || r.before > base.length) break;
    if (head[r.from - 1] !== head[r.to]) break;
    if (runIsNewBlock(base, head, r, scan)) return true;
  }
  return false;
}
// Structural allowlist for added test code. A statement is accepted only when it is one of:
//   JS/TS: test/it(literal name, arrow or function with plain parameters[, number]) or describe(literal name, arrow or function) holding only such calls;
//   Python: def test_* with a plain signature, class Test* holding only defs, and pytest.mark parametrize/asyncio decorators (xfail stays flagged by SKIP_MARKER) with literal arguments.
// Every argument of a test call runs at collection time, so a name, a table, a default or an extra argument that is not a literal is weakening.
// Everything else (const/let/var, function, class, bare calls, assignments, hooks, fixtures, other marks) is weakening.
// A new block is accepted only after the last base test: top-level, or appended at the end of the last existing describe or class Test*.
const JS_NAME = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`[^`$\\\n]*`/.source;
const JS_FN_HEAD = new RegExp(String.raw`^\(\s*(?:${JS_NAME})\s*,\s*(?:async\s+)?(?:\(\s*[\w$,\s]*\)\s*=>|[\w$]+\s*=>|function\s*\w*\s*\(\s*[\w$,\s]*\)\s*(?=\{))\s*`);
const DESCRIBE_HEAD = new RegExp(String.raw`^describe(?:\.(?:concurrent|sequential))*\s*\(\s*(?:${JS_NAME})\s*,\s*(?:async\s+)?(?:\(\s*\)\s*=>|function\s*\w*\s*\(\s*\))\s*\{\s*$`);
const CLOSERS_ONLY = /^[})\]]+\s*(?:,\s*[\d_]+\s*)?[)\]}]*\s*;?\s*$/;
const PY_SIG = /^(?:async\s+)?def\s+(\w+)\s*\(([\w\s,*/]*)\)\s*:/;
const PY_CLASS = /^class\s+Test\w*\s*(?:\(\s*\))?\s*:\s*$/;
const PY_CLASS_ANY = /^class\s+Test\w*\s*(?:\([^)]*\))?\s*:\s*$/;
const PY_MARK = /^@pytest\.mark\.(parametrize|asyncio)\s*(?:\(([\s\S]*)\))?\s*$/;
const SIMPLE_REGEX = /(?<![\w)\]$])\/(?![\/*])(?:\\.|[\w\s.^$*+?|\\-])+\/[gimsuy]*/g;
/** Index just past the balanced parenthesis group opening at i within one line, or -1 when it does not close there. */
function groupEnd(s: string, i: number): number {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j]!;
    if (s.startsWith("//", j)) return -1;
    if (c === '"' || c === "'" || c === "`") { let k = j + 1; while (k < s.length && s[k] !== c) { if (s[k] === "\\") k++; k++; } if (k >= s.length) return -1; j = k; continue; }
    if (c === "(") d++; else if (c === ")" && --d === 0) return j + 1;
  }
  return -1;
}
/** Only literals: strings, numbers, true/false/null/None/True/False, containers of those, keyword names. A name, call, attribute or lambda is not. */
function literalOnly(inner: string): boolean {
  const t = inner.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "0").replace(/\b(?:True|False|None|true|false|null)\b/g, "0").replace(/\b[A-Za-z_]\w*\s*=(?!=)/g, "");
  return /^[\s\d.,:[\](){}+\-_]*$/.test(t);
}
/** Arguments after the function: nothing, or one numeric timeout. A top-level comma elsewhere, or an unterminated string, is a hidden argument. */
function argsEndOk(body: string): boolean {
  let d = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '"' || c === "'" || c === "`") { let j = i + 1; while (j < body.length && body[j] !== c) { if (body[j] === "\\") j++; j++; } if (j >= body.length) return false; i = j; continue; }
    if ("([{".includes(c)) d++; else if (")]}".includes(c)) d--;
    else if (c === "," && d === 0) return /^\s*\d+\s*$/.test(body.slice(i + 1));
  }
  return d === 0;
}
/** JS lines with simple regex literals replaced by 0; null when a slash is left that a bracket scan cannot read (a division, a complex regex, a block comment). */
function jsClean(lines: string[]): string[] | null {
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.replace(SIMPLE_REGEX, "0");
    for (let i = 0; i < l.length; i++) {
      const c = l[i]!;
      if (c === '"' || c === "'" || c === "`") { let j = i + 1; while (j < l.length && l[j] !== c) { if (l[j] === "\\") j++; j++; } i = j; continue; }
      if (c === "/") { if (l[i + 1] === "/") break; return null; }
    }
    out.push(l);
  }
  return out;
}
/** For a line starting with a test/it/describe call: its name and, when the call closes on this line, whatever follows it. Null when any argument is not on the allowlist. */
function jsCall(line: string): { name: string; closed: boolean; rest: string } | null {
  const t = line.trim();
  const m = /^(test|it|describe)((?:\.(?:concurrent|sequential|failing|each))*)(?![\w$.])/.exec(t);
  if (!m) return null;
  let k = m[0].length;
  if (m[2]!.endsWith(".each")) {
    while (t[k] === " ") k++;
    if (t[k] !== "(") return null;
    const e = groupEnd(t, k);
    if (e < 0 || !literalOnly(t.slice(k + 1, e - 1))) return null;
    k = e;
  }
  while (t[k] === " ") k++;
  if (t[k] !== "(") return null;
  const h = JS_FN_HEAD.exec(t.slice(k));
  if (!h) return null;
  const e = groupEnd(t, k);
  if (e < 0) return /\{\s*$/.test(t) ? { name: m[1]!, closed: false, rest: "" } : null;
  if (!argsEndOk(t.slice(k + h[0].length, e - 1))) return null;
  return { name: m[1]!, closed: true, rest: t.slice(e) };
}
const restOk = (r: string): boolean => /^\s*;?\s*(?:\/\/.*)?$/.test(r);
/** A JS statement: one test/it call, or a multi-line call whose function closes only on its last line. A describe holds only more such statements. */
function jsStatementOk(raw: string[]): boolean {
  const lines = jsClean(raw);
  if (!lines) return false;
  const first = jsCall(lines[0]!);
  if (!first) return false;
  if (first.closed) return first.name !== "describe" && lines.length === 1 && restOk(first.rest); // a describe never closes on one line: its body must be checked statement by statement
  if (lines.length < 2 || !CLOSERS_ONLY.test(lines[lines.length - 1]!.trim()) || depth(lines[0]!) !== 2) return false;
  const sc = scanDepth(lines);
  for (let k = 1; k < lines.length - 1; k++) if (sc.minInLine[k]! < 2) return false; // the function must not close before the last line
  if (first.name !== "describe") return true;
  if (!DESCRIBE_HEAD.test(lines[0]!.trim())) return false;
  const kids: string[][] = [];
  for (let k = 1; k < lines.length - 1; k++) {
    const l = lines[k]!;
    if (l.trim() === "" || isIgnorable(l)) continue;
    if (sc.depthBefore[k] === 2 && !sc.inBlock[k]) kids.push([l]);
    else if (kids.length === 0) return false;
    else kids[kids.length - 1]!.push(l);
  }
  return kids.every(jsStatementOk);
}
const pyDecoratorOk = (text: string): boolean => { const m = PY_MARK.exec(text.trim()); return m !== null && (m[2] === undefined || literalOnly(m[2])); };
const joined = (ls: string[]): string => ls.map((l) => l.trim()).join(" ");
/** Split lines into top-level statements: a statement starts at a non-blank line with no indent, outside brackets and comments. */
function statements(lines: string[]): string[][] | null {
  const sc = scanDepth(lines), out: string[][] = [];
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]!;
    if (l.trim() === "" || isIgnorable(l)) continue;
    if (sc.depthBefore[k] === 0 && !sc.inBlock[k] && indentOf(l) === 0 && !/^[})\]]/.test(l)) out.push([l]);
    else if (out.length === 0) return null;
    else out[out.length - 1]!.push(l);
  }
  return out;
}
/** Python members at the first member's indent: defs (only test_* when onlyTests), each optionally behind allowlisted marks, and nothing else. */
function pyMembersOk(body: string[], onlyTests: boolean): boolean {
  const sc = scanDepth(body);
  const first = body.findIndex((l, k) => l.trim() !== "" && !isIgnorable(l) && sc.depthBefore[k] === 0 && !sc.inBlock[k]);
  if (first < 0) return false;
  const bi = indentOf(body[first]!);
  let pending = false;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.trim() === "" || isIgnorable(l) || sc.depthBefore[k] !== 0 || sc.inBlock[k]) continue;
    const ind = indentOf(l);
    if (ind < bi) return false;
    if (ind > bi) continue;
    let end = k + 1; while (end < body.length && (sc.depthBefore[end]! > 0 || sc.inBlock[end]! || indentOf(body[end]!) > bi || body[end]!.trim() === "")) end++;
    const stmt = joined(body.slice(k, end));
    if (stmt.startsWith("@")) { if (!pyDecoratorOk(stmt)) return false; pending = true; continue; }
    const m = PY_SIG.exec(stmt);
    if (!m || (onlyTests && !m[1]!.startsWith("test_"))) return false;
    pending = false;
  }
  return !pending;
}
/** class Test*: its body holds only defs, optionally behind allowlisted marks. */
const pyClassOk = (lines: string[]): boolean => PY_CLASS.test(lines[0]!.trim()) && lines.length >= 2 && pyMembersOk(lines.slice(1), false);
/** True when every top-level statement of an added run is on the allowlist above. */
function topLevelAllowed(body: string[]): boolean {
  const stmts = statements(body);
  if (!stmts || stmts.length === 0) return false;
  let pending = false;
  for (const st of stmts) {
    const t = st[0]!.trim();
    if (t.startsWith("@")) { if (!pyDecoratorOk(joined(st))) return false; pending = true; continue; }
    if (/^(?:async\s+)?def\s/.test(t)) { const m = PY_SIG.exec(joined(st)); if (!m || !m[1]!.startsWith("test_")) return false; pending = false; continue; }
    if (pending) return false;
    if (t.startsWith("class ")) { if (!pyClassOk(st)) return false; continue; }
    if (!jsStatementOk(st)) return false;
  }
  return !pending;
}
// CLASS: a write whose target is not a local of the added code. Applied to every added line at any nesting, so the body of an allowed block is checked too.
const NEVER_IN_ADDED = /\b__(?:setattr|dict|class|code|defaults|globals|builtins|proto)__\b|\.prototype\b|\bsys\.modules\b|\b(?:__)?builtins(?:__)?\b|\bglobalThis\b|\bwindow\b|\bglobal\s+\w|\bautouse\b|\bimportlib\b|\b__import__\b|\bctypes\b|\b(?:eval|exec)\s*\(|\bnew\s+Function\s*\(|\bpytest_plugins\b|\bpytest\.hookimpl\b/;
const ROOT = String.raw`([A-Za-z_$][\w$]*)`;
const ASSIGN_TARGET = new RegExp(String.raw`^\s*(?:await\s+)?${ROOT}((?:\s*\.\s*[\w$]+|\s*\[[^\]]*\]|\s*\(\s*\))*)\s*(?:[-+*/%&|^]|\*\*|//|<<|>>|\?\?|\|\||&&)?=(?![=>])`);
const CALL_WRITE = new RegExp(String.raw`\b(?:setattr|delattr|Object\.(?:defineProperty|defineProperties|assign|setPrototypeOf)|Reflect\.(?:set|defineProperty|deleteProperty|setPrototypeOf))\s*\(\s*([^,)\s]*)`, "g");
const DELETE_STMT = new RegExp(String.raw`\b(?:del|delete)\s+${ROOT}\s*[.\[]`, "g");
const MUTATOR_CALL = /(?<![\w$.])([A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)+\s*\.\s*(?:set|add|update|clear|splice|push|pop|shift|unshift|delete|remove|append|extend|insert|setdefault|popitem|discard|sort|reverse|fill|copyWithin|assign|defineProperty)\s*\(/g;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
const LOCAL_FREE = new Set(["self", "this", "cls"]);
/** Names a module owns: imported names plus base top-level declarations. A local never excuses a write to one of these. */
function moduleNames(a: string[], b: string[]): Set<string> {
  const r = new Set<string>();
  // identifiers only: a quoted module specifier or <header> is not a name, and a dotted path contributes its root segment
  for (const t of importTokens(b, importLines(b))) { const h = t.split(".")[0]!; if (IDENT.test(h)) r.add(h); }
  for (const l of a) { const m = /^(?:async\s+)?(?:def|class|function)\s+(\w+)|^(?:export\s+)?(?:const|let|var)\s+(\w+)|^(\w+)\s*=/.exec(l); const n = m?.[1] ?? m?.[2] ?? m?.[3]; if (n && IDENT.test(n)) r.add(n); }
  return r;
}
const idents = (list: string): string[] => list.split(",").map((x) => /^\s*\.{0,3}\s*([A-Za-z_$][\w$]*)/.exec(x)?.[1] ?? "").filter(Boolean);
/** Names the added lines declare: const/let/var, plain assignment, loop and with/except/catch bindings, def/function/arrow parameters. */
function declaredNames(lines: string[], own: Set<string>): Set<string> {
  const r = new Set<string>();
  for (const l of lines) {
    for (const m of l.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) r.add(m[1]!);
    for (const m of l.matchAll(/\b(?:def|function)\s*\w*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>/g)) for (const n of idents(m[1] ?? m[2] ?? "")) r.add(n);
    for (const m of l.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) r.add(m[1]!);
    for (const m of l.matchAll(/\bfor\s*\(?\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*(?:in|of)\b|\b(?:as|catch\s*\()\s*([A-Za-z_$][\w$]*)/g)) r.add(m[1] ?? m[2]!);
    const pa = /^\s*([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?![=>])/.exec(l); if (pa) r.add(pa[1]!);
  }
  for (const n of own) r.delete(n);
  return r;
}
/** True when an added line writes to something that is not a local of the added code. */
function externalWrite(line: string, locals: Set<string>, own: Set<string>): boolean {
  if (NEVER_IN_ADDED.test(line)) return true;
  const isLocal = (n: string): boolean => LOCAL_FREE.has(n) || locals.has(n);
  for (const seg of line.split(/[;{]|=>/)) {
    const m = ASSIGN_TARGET.exec(seg);
    if (!m) continue;
    if (m[2]!.trim() === "" ? own.has(m[1]!) : !isLocal(m[1]!)) return true;
  }
  for (const m of line.matchAll(CALL_WRITE)) {
    const arg = m[1]!; if (/^[{["'`]/.test(arg)) continue;
    const root = /^([A-Za-z_$][\w$]*)/.exec(arg)?.[1];
    if (!root || !isLocal(root)) return true;
  }
  for (const m of line.matchAll(DELETE_STMT)) if (!isLocal(m[1]!)) return true;
  for (const m of line.matchAll(MUTATOR_CALL)) if (!isLocal(m[1]!)) return true; // a container mutator on a non-local chain, e.g. sut.cache.set(...)
  return false;
}
const BASE_TEST_START = /^\s*(?:(?:async\s+)?(?:def|func|fn)\s+\w|(?:test|it|describe)\b|class\s+\w|@\w)/;
const dedent = (ls: string[]): string[] => { const m = Math.min(...ls.filter((l) => l.trim() !== "").map(indentOf)); return ls.map((l) => (l.trim() === "" ? "" : l.slice(m))); };
/** Which existing block an indented run is appended to: the end of a base `describe(...)` chain (js) or of a base `class Test*:` (py); null when the insertion point is neither. */
function appendFrame(base: string[], i: number, scan: ReturnType<typeof scanDepth>, k: number): "js" | "py" | null {
  const d = i < base.length ? scan.depthBefore[i]! : (scan.depthBefore[base.length - 1] ?? 0) + depth(base[base.length - 1] ?? "");
  if (d === 0) {
    let j = i - 1;
    while (j >= 0 && (base[j]!.trim() === "" || isIgnorable(base[j]!) || indentOf(base[j]!) >= k)) j--;
    if (j < 0 || indentOf(base[j]!) >= k || !PY_CLASS_ANY.test(base[j]!.trim())) return null;
    for (let n = i; n < base.length; n++) if (base[n]!.trim() !== "" && !isIgnorable(base[n]!) && indentOf(base[n]!) >= k) return null; // the next base line is still inside a member body
    return "py";
  }
  let cur = d, j = i - 1;
  while (cur > 0) {
    while (j >= 0 && (scan.depthBefore[j]! >= cur || scan.inBlock[j])) j--;
    if (j < 0 || !DESCRIBE_HEAD.test(base[j]!.trim()) || cur - scan.depthBefore[j]! !== 2 || depth(base[j]!) !== 2) return null;
    cur = scan.depthBefore[j]!; j--;
  }
  return "js";
}
/** True when every added line of the run sits after the last base test: top-level, or appended at the end of the last existing describe or class Test*; outside any comment, balanced, and not inside a base member body. */
function runIsNewBlock(base: string[], head: string[], run: { from: number; to: number; before: number }, scan: ReturnType<typeof scanDepth>): boolean {
  const i = run.before;
  if (i < base.length && scan.inBlock[i]) return false;
  if (base.slice(i).some((l) => BASE_TEST_START.test(l))) return false; // a new block goes only after the last base test
  const body = head.slice(run.from, run.to + 1);
  const first = body.find((l) => l.trim() !== "");
  const inner = scanDepth(body);
  let end = 0; for (const l of body) end += depth(l);
  if (end !== 0 || !inner.depthBefore.every((x) => x >= 0)) return false;
  const k = first === undefined ? 0 : indentOf(first);
  if (k === 0) {
    if (i < base.length && scan.depthBefore[i] !== 0) return false;
    if (i >= base.length && (scan.depthBefore[base.length - 1] ?? 0) !== 0) return false;
    let next = i; while (next < base.length && base[next]!.trim() === "") next++;
    if (next < base.length && indentOf(base[next]!) > 0) return false; // the next base line is still inside an indented body
    return topLevelAllowed(body);
  }
  const frame = appendFrame(base, i, scan, k);
  if (frame === "py") return pyMembersOk(body, true);
  if (frame === "js") { const ls = dedent(body), st = statements(ls); return st !== null && st.length > 0 && st.every(jsStatementOk); }
  return false;
}
// CLASS: added code that reaches a module-owned mutable object. A denylist of mutator shapes cannot close this (list.append(sut.RULES, f), vars(sut).update, [].push.call(rules, f), x = sut.RULES; x.clear()), so the rule is positive: a reference to an owned name that is not itself called may only be an argument of a pure reader (len, sorted, expect, assert*), of a call into the module, or sit outside an assignment. Anything else is doubt.
const PURE_CALLEE = /^(?:len|sorted|list|tuple|set|frozenset|dict|str|repr|bool|int|float|isinstance|issubclass|type|sum|min|max|any|all|print|enumerate|zip|reversed|abs|round|hash|id|callable|hasattr|format|expect|assert\w*|approx|raises|warns|to[A-Z]\w*|String|Number|Boolean|Array|from|isArray|stringify|keys|values|entries)$/;
const MUTATOR_NAME = /^(?:set|add|update|clear|splice|push|pop|shift|unshift|delete|remove|append|extend|insert|setdefault|popitem|discard|sort|reverse|fill|copyWithin|assign|defineProperty|__init__|__setitem__|__delitem__|__setattr__|__iadd__|__ior__|__imul__)$/;
const stripStrings = (l: string): string => l.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""').replace(/(?:^|\s)#.*$|\/\/.*$/, "");
/** Names bound as a whole module (import x, import * as x, x = require(...)): a one-dot call on one of these is a call into the module, not a method on an owned object. */
function moduleAliases(lines: string[]): Set<string> {
  const r = new Set<string>();
  for (const l of lines) {
    for (const m of l.matchAll(/^\s*import\s+([\w.,\s]+?)\s*$/gm)) for (const part of m[1]!.split(",")) { const t = part.trim().split(/\s+as\s+/); const n = (t[1] ?? t[0]!.split(".")[0]!).trim(); if (n) r.add(n); }
    for (const m of l.matchAll(/\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\b/g)) r.add(m[1]!);
    for (const m of l.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(/g)) r.add(m[1]!);
  }
  return r;
}
const PSEUDO_ROOT = /\b(?:require|import)\s*\(\s*(?:""|'')?\s*\)|\b(?:globals|vars)\s*\(\s*\)/;
const MUTATOR_ALT = "set|add|update|clear|splice|push|pop|shift|unshift|delete|remove|append|extend|insert|setdefault|popitem|discard|sort|reverse|fill|copyWithin|assign|defineProperty|__init__|__setitem__|__delitem__|__setattr__";
const MUTATOR_CALL_ANY = new RegExp(String.raw`\.\s*(?:${MUTATOR_ALT})\s*\(`);
const MEMBER_WRITE = /(?:\.\s*[\w$]+|\])\s*(?:(?:[-+*/%&|^]|\*\*|\/\/|\?\?|\|\||&&)?=(?![=>])|\+\+|--)/;
/** What follows the closing paren of a call on an owned name: the result is a live owned object, so a mutator call or member write on it is a write. */
const RESULT_MUTATION = new RegExp(String.raw`^(?:\s*\.\s*[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?|\s*\[[^\]]*\])*?\s*(?:\.\s*(?:${MUTATOR_ALT})\s*\(|(?:\.\s*[\w$]+|\])\s*(?:[-+*/%&|^]|\*\*|\/\/|\?\?|\|\||&&)?=(?![=>]))`);
const SCALAR_PURE = "len|str|repr|bool|int|float|isinstance|issubclass|type|sum|min|max|any|all|abs|round|hash|id|callable|hasattr|format|String|Number|Boolean";
/** Index of the paren matching the one at `open`, or -1. */
function matchParen(st: string, open: number): number {
  let d = 0;
  for (let i = open; i < st.length; i++) { const c = st[i]!; if (c === "(") d++; else if (c === ")") { d--; if (d === 0) return i; } }
  return -1;
}
/** `text` with every call to a name matching `nameAlt` (balanced arguments included) removed. */
function removeCalls(text: string, nameAlt: string, guard?: (inner: string) => boolean): string {
  const re = new RegExp(String.raw`(?<![\w$.])(?:${nameAlt})\s*\(`, "g");
  let out = "", at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = m.index + m[0].length - 1, close = matchParen(text, open);
    if (close < 0 || m.index < at) continue;
    if (guard && !guard(text.slice(open + 1, close))) continue;
    out += text.slice(at, m.index); at = close + 1; re.lastIndex = at;
  }
  return out + text.slice(at);
}
/** pytest's monkeypatch and mocker fixtures undo themselves when the test ends, so a call on them cannot weaken another test; unless an argument itself mutates something. */
const AUTO_UNDONE = String.raw`(?:monkeypatch|mocker)\s*\.\s*(?:setattr|setitem|setenv|delattr|delitem|delenv|chdir|syspath_prepend|patch(?:\s*\.\s*\w+)?|spy|stub)`;
const stripAutoUndone = (text: string): string => removeCalls(text, AUTO_UNDONE, (inner) => !MUTATOR_CALL_ANY.test(inner) && !MEMBER_WRITE.test(removeCalls(inner, "lambda|function")));
const RUNNER_NAME = new RegExp(`^(?:${API_NAMES}|beforeEach|afterEach|beforeAll|afterAll|pytest|unittest|bench|suite|spec|specify)$`);
const mentionsRoot = (text: string, all: Set<string>): boolean => { const names = new Set([...all].filter((n) => !RUNNER_NAME.test(n))); return names.size > 0 && new RegExp(String.raw`(?<![\w$.])(?:${[...names].map(escapeRe).join("|")})(?![\w$])`).test(text); };
/** Names bound to something derived from an owned object: assignment targets, loop targets, callback parameters and with-targets of any statement that mentions an owned (or already derived) name or a live-module root. A write through one of these is a write to the owned object. */
function derivedNames(stmts: string[], own: Set<string>): Set<string> {
  const D = new Set<string>();
  for (let pass = 0; pass <= stmts.length; pass++) {
    const before = D.size, tainted = new Set([...own, ...D]);
    const live = (t: string): boolean => PSEUDO_ROOT.test(t) || mentionsRoot(removeCalls(t, SCALAR_PURE), tainted);
    for (const st of stmts) {
      if (!live(st)) continue;
      const am = /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*(?::[^=]+)?=(?![=>])([\s\S]*)$/.exec(st);
      if (am && live(am[2]!)) for (const n of am[1]!.split(",")) D.add(n.trim());
      const fm = /^\s*(?:async\s+)?for\s*\(?\s*(?:(?:const|let|var)\s+)?\(?([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\)?\s+(?:in|of)\s+([\s\S]*)$/.exec(st);
      if (fm && live(fm[2]!)) for (const n of fm[1]!.split(",")) D.add(n.trim());
      // a callback parameter is derived only when the call that receives the callback starts from an owned object (sut.rules.forEach(cb), import("x").then(cb)), not when it is merely passed to an unrelated runner such as test.each
      for (const m of st.matchAll(/\(([^()]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>|\blambda\s+([^:]*):|\bfunction\s*[\w$]*\s*\(([^)]*)\)|\bas\s+([A-Za-z_$][\w$]*)/g)) {
        if (!live(st.slice(0, m.index).split(/[;{\n]/).pop()!)) continue;
        for (const n of idents(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "")) D.add(n);
      }
    }
    if (D.size === before) break;
  }
  for (const n of own) D.delete(n);
  return D;
}
/** Joins added lines into logical statements (brackets balanced), strings and comments removed. */
function logicalStatements(lines: string[]): string[] {
  const out: string[] = []; let cur = "", d = 0;
  for (const raw of lines) { const l = stripStrings(raw); cur += (cur ? "\n" : "") + l.trim(); d += depth(l); if (d <= 0) { if (cur) out.push(cur); cur = ""; d = 0; } }
  if (cur) out.push(cur);
  return out;
}
/** True when a logical statement hands an owned object to code that may mutate it. */
const PURE_QUALIFIER = /(?<![\w$.])(?:Object|Array|JSON|Number|String|Math|Boolean|pytest|self|unittest)\s*\.\s*[\w$]+\s*$/;
/** The file's import statements, one string each (continuation lines joined), so a runner-module import never excuses its neighbour. */
function importStatements(lines: string[]): string[] {
  const idx = importLines(lines), out: string[] = [];
  let cur = "";
  for (let i = 0; i < lines.length; i++) {
    if (!idx.has(i)) { if (cur) { out.push(cur); cur = ""; } continue; }
    if (cur && IMPORT_START.test(lines[i]!.trim()) && depth(cur) <= 0 && !/\\\s*$/.test(cur)) { out.push(cur); cur = ""; }
    cur += (cur ? " " : "") + lines[i]!.trim();
  }
  if (cur) out.push(cur);
  return out;
}
/** Modules whose imports are the test runner itself: importing expect or pytest from them is not a rebinding of a pure name. */
const RUNNER_MODULE = /^(?:bun:test|vitest|@jest\/globals|node:test|node:assert(?:\/strict)?|assert|chai|pytest|unittest|unittest\.mock)$/;
/**
 * Every name the file binds anywhere (def, function, class, assignment of any operator, const/let/var, destructuring, import or from-import,
 * parameters, arrow and lambda parameters, for targets, with/except/catch/as, walrus), over-approximated: a name that appears in any
 * binding position counts. Imports from a test runner module do not count. A pure allowlist entry is trusted only when the file never
 * binds it, so a local rebinding cannot launder an owned object. Returns null when the scan cannot be trusted; null means every name is bound.
 */
function boundNames(lines: string[]): Set<string> | null {
  try {
    const bound = new Set<string>(), add = (list: string): void => { for (const m of list.matchAll(/[A-Za-z_$][\w$]*/g)) bound.add(m[0]); };
    const imp = importLines(lines);
    for (const stmt of importStatements(lines)) {
      const text = stmt.replace(/#.*$/, ""), mod = /(?:from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|^\s*from\s+([.\w]+)\s+import|^\s*import\s+([\w.]+)\s*$)/.exec(text), name = mod?.[1] ?? mod?.[2] ?? mod?.[3] ?? mod?.[4] ?? "";
      if (!RUNNER_MODULE.test(name)) add(text.replace(/\bas\b/g, " "));
    }
    for (let i = 0; i < lines.length; i++) {
      if (imp.has(i)) continue;
      const l = stripStrings(lines[i]!);
      for (const m of l.matchAll(/\b(?:def|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]!);
      for (const m of l.matchAll(/\b(?:def|function\*?)\s*[\w$]*\s*\(/g)) { const o = m.index! + m[0].length - 1, c = matchParen(l, o); add(l.slice(o + 1, c < 0 ? l.length : c).replace(/^\s*self\s*,?/, "")); if (c < 0) return null; }
      for (const m of l.matchAll(/\b(?:const|let|var|global|nonlocal)\s+([^=;]*)/g)) add(m[1]!);
      for (const m of l.matchAll(/\b(?:as|catch)\s*\(?\s*([A-Za-z_$][\w$]*)/g)) bound.add(m[1]!);
      for (const m of l.matchAll(/\bfor\s*\(?\s*(?:(?:const|let|var)\s+)?([^;]*?)\s+(?:in|of)\b/g)) add(m[1]!);
      for (const m of l.matchAll(/\blambda\b([^:]*):/g)) add(m[1]!);
      for (const m of l.matchAll(/(\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]!);
      for (const m of l.matchAll(/([A-Za-z_$][\w$]*)\s*:=/g)) bound.add(m[1]!);
      for (const m of l.matchAll(/(?:^|[;,({\s])((?:[A-Za-z_$][\w$]*|\[[^\]]*\]|\{[^}]*\})(?:\s*,\s*(?:[A-Za-z_$][\w$]*|\[[^\]]*\]|\{[^}]*\}))*)\s*(?:[-+*/%&|^@]|\*\*|\/\/|<<|>>|\?\?|&&|\|\|)?=(?![=>])/g)) add(m[1]!);
    }
    return bound;
  } catch { return null; }
}
/** Python standard library top-level modules: importing one of these cannot rebind a builtin by itself (the rebinding modules are listed in PY_REBINDERS). */
const PY_STDLIB = new Set(("abc argparse array ast asyncio base64 bisect calendar cmath collections colorsys concurrent configparser contextlib copy csv dataclasses datetime decimal difflib dis email enum errno fnmatch fractions functools getpass glob gzip hashlib heapq hmac html http io ipaddress itertools json keyword linecache locale logging math mimetypes multiprocessing numbers operator os pathlib pickle platform pprint queue random re secrets select selectors shlex shutil signal socket sqlite3 ssl stat statistics string struct subprocess sys tempfile textwrap threading time timeit tokenize traceback types typing unittest urllib uuid warnings weakref xml zipfile zlib zoneinfo").split(" "));
/** Standard library modules that can rebind names for everything imported after them. */
const PY_REBINDERS = new Set(["builtins", "__builtin__", "importlib", "imp", "runpy", "ctypes", "gc", "site", "sitecustomize", "usercustomize", "pkgutil", "code", "codeop", "pdb", "inspect"]);
/** Fixtures pytest undoes by itself or that carry no test-visible state: a test taking only these cannot inherit a mutation from a conftest fixture. */
const PY_AUTO_FIXTURES = new Set(["self", "cls", "monkeypatch", "mocker", "tmp_path", "tmp_path_factory", "tmpdir", "tmpdir_factory", "capsys", "capfd", "caplog", "request", "recwarn", "capsysbinary", "capfdbinary"]);
/**
 * True when pure-callee trust must be OFF for a Python test file (rev-237 r8): code the file imports or a fixture it requests can rebind
 * a builtin before the added call runs, and a lexical scan of the file cannot see that. Fail-safe, judged on the HEAD file: a star import;
 * an import of a rebinding stdlib module; an import that is not stdlib, not a test runner and not referenced in the file's code (a
 * side-effect import, pre-existing or added); a dynamic import, autouse or usefixtures anywhere; or an added def that takes a fixture
 * parameter other than the self-undoing ones and the names a parametrize decorator supplies. JS files are never affected here.
 */
function pythonLaunderRisk(b: string[], addedCode: number[]): boolean {
  const imp = importLines(b), pyImp = importStatements(b).map((t) => t.replace(/#.*$/, "")).filter((t) => /^\s*(?:from\s+[\w.]+\s+import\b|import\s+[A-Za-z_][\w.]*(?:\s+as\s+\w+)?(?:\s*,|\s*$))/.test(t));
  const isPy = pyImp.length > 0 || b.some((l) => /^\s*def\s+\w+\s*\(/.test(l));
  if (!isPy) return false;
  const code = b.filter((_, i) => !imp.has(i)).map(stripStrings).join("\n");
  if (/\b(?:__import__|importlib|builtins|__builtin__|exec|eval|pytest_plugins|autouse|usefixtures|sitecustomize|usercustomize)\b/.test(code)) return true;
  const used = (n: string): boolean => new RegExp(String.raw`(?<![\w$.])${escapeRe(n)}(?![\w$])`).test(code);
  const rootUsed = new Map<string, boolean>(), rootsOf: string[] = [];
  for (const t of pyImp) {
    if (/^\s*from\s+[.\w]+\s+import\s+\*/.test(t)) return true;
    const fm = /^\s*from\s+([.\w]+)\s+import\s+([\s\S]*)$/.exec(t), im = fm ? null : /^\s*import\s+([\s\S]*)$/.exec(t);
    const mods = fm ? [fm[1]!] : im![1]!.split(",").map((x) => x.trim().split(/\s+as\s+/)[0]!.trim());
    const bound = fm ? fm[2]!.replace(/[()]/g, "").split(",").map((x) => (x.trim().split(/\s+as\s+/).pop() ?? "").trim()).filter(Boolean) : im![1]!.split(",").map((x) => { const p = x.trim().split(/\s+as\s+/); return (p[1] ?? p[0]!.split(".")[0]!).trim(); });
    for (const m of mods) if (PY_REBINDERS.has(m.split(".")[0]!)) return true;
    for (const m of mods) {
      const root = m.replace(/^\.+/, "").split(".")[0] || bound.join(",");
      if (RUNNER_MODULE.test(m) || PY_STDLIB.has(root)) continue;
      if (bound.length === 0) return true;
      rootsOf.push(root); rootUsed.set(root, (rootUsed.get(root) ?? false) || bound.some(used));
    }
  }
  return rootsOf.some((r) => !rootUsed.get(r)); // a repo or third-party package none of whose imported names the file uses is imported for its side effects
}
/**
 * The names in PY_AUTO_FIXTURES that the text rebinds (rev-237 r9). pytest resolves a fixture name from the nearest definition, so a
 * def, class, assignment, import, name= argument or star import of `caplog` in the test file or in any conftest.py above it replaces the
 * builtin with code the lexical scan did not see. One mechanism for both: the HEAD test file and every conftest on its path go through it,
 * and a pytest_plugins list or a star import can supply any name.
 */
function shadowedAutoFixtures(text: string): Set<string> {
  const code = text.split("\n").map((l) => l.replace(/#.*$/, "")).join("\n");
  if (/\bpytest_plugins\b|^\s*from\s+[\w.]+\s+import\s+\*/m.test(code)) return new Set(PY_AUTO_FIXTURES);
  const out = new Set<string>();
  for (const n of PY_AUTO_FIXTURES) {
    if (new RegExp(String.raw`\b(?:def|class)\s+${n}\b|\bname\s*=\s*["']${n}["']|^\s*${n}\s*(?:=(?!=)|,\s*$|\)?\s*$)|\bimport\b[^\n]*\b${n}\b`, "m").test(code)) out.add(n);
  }
  return out;
}
/** Attribute reads of `request` that cannot reach another fixture, the config or the session (rev-237 r9). */
const REQUEST_READ = /^\s*\.\s*(?:param|param_index|fixturename|scope|node\s*\.\s*(?:name|nodeid)|function\s*\.\s*__name__)\s*(?:[,)\]}:]|==|!=|<=?|>=?|\b(?:and|or|in|is|not)\b|$)/;
/** True when `line` uses `request` other than as a read of an allowlisted attribute: a getattr, an alias, a call through it, a write, any other attribute. */
function requestUsedBeyondReads(line: string): boolean {
  const code = line.replace(/^\s*(?:async\s+)?def\s+\w+\s*\([^)]*\)/, "def _()");
  for (const m of code.matchAll(/(?<![\w$.])request(?![\w$])/g)) if (!REQUEST_READ.test(code.slice(m.index! + m[0].length))) return true;
  return false;
}
/** True when an added Python test or fixture pulls state in from outside the file: a fixture parameter (other than the self-undoing ones that nothing shadows, and parametrize names), usefixtures, pytestmark, indirect parametrization, getfixturevalue, or any use of `request` beyond reading an allowlisted attribute. The fixture body lives in a conftest the lexical scan cannot see. `shadowed` holds the self-undoing names a conftest rebinds. */
function pythonFixtureLaunder(b: string[], addedCode: number[], shadowed: ReadonlySet<string>): boolean {
  const param = new Set<string>(), mine = shadowedAutoFixtures(b.join("\n"));
  for (const l of b) for (const m of l.matchAll(/parametrize\s*\(\s*(\([^)]*\)|\[[^\]]*\]|["'][^"']*["'])/g)) for (const q of m[1]!.matchAll(/["']([^"']*)["']/g)) for (const n of q[1]!.split(",")) param.add(n.trim());
  const trusted = (n: string): boolean => PY_AUTO_FIXTURES.has(n) && !mine.has(n) && !shadowed.has(n);
  for (const i of addedCode) {
    const l = stripStrings(b[i]!);
    if (/\b(?:usefixtures|pytestmark|getfixturevalue|getfuncargvalue)\b|\bindirect\s*=/.test(l)) return true;
    if (requestUsedBeyondReads(l)) return true;
    const m = /^\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/.exec(b[i]!); if (!m) continue;
    if (!/^test/i.test(m[1]!) && !/^\s*@(?:pytest\.)?fixture\b/.test(b[i - 1] ?? "")) continue; // a helper's parameters are ordinary arguments
    for (const n of idents(m[2]!)) if (!trusted(n) && !param.has(n)) return true;
  }
  return false;
}
/** Exported for the release-gate measurement: true when pure-callee trust is off for this edit. */
export function pureTrustOff(baseText: string, headText: string): boolean {
  const a = baseText.split("\n"), b = headText.split("\n"), d = lineDelta(a, b), bImp = importLines(b);
  return pythonLaunderRisk(b, d ? d.added.filter((i) => !bImp.has(i)) : []);
}
/** True when the callee ending `pre` is on the explicit read-only allowlist and the file never rebinds it: a bare builtin or runner name, a matcher on an expect() or assert receiver, or a member of a known read-only namespace. */
function pureCallee(pre: string, name: string, bound: Set<string> | null): boolean {
  if (!PURE_CALLEE.test(name) || !bound) return false;
  const member = /\.\s*[A-Za-z_$][\w$]*\s*$/.test(pre);
  if (!member) return !bound.has(name);
  const recv = pre.replace(/\.\s*[A-Za-z_$][\w$]*\s*$/, "");
  if (/^(?:to[A-Z]|assert)/.test(name)) { // a matcher is pure only on a receiver that starts at expect(...) or assert
    const ex = /(?<![\w$.])expect\s*\(/.exec(recv);
    if (ex && !bound.has("expect")) { const close = matchParen(recv, ex.index + ex[0].length - 1); if (close >= 0 && /^(?:\s*\.\s*(?:not|resolves|rejects))*\s*$/.test(recv.slice(close + 1))) return true; }
    const root = /(?<![\w$.])(assert|self)\s*$/.exec(recv);
    return root !== null && !bound.has(root[1]!);
  }
  const q = PURE_QUALIFIER.exec(pre);
  return q !== null && !bound.has(/^[\w$]+/.exec(q[0].trim())![0]) && !bound.has(name);
}
function reachesOwned(st: string, own: Set<string>, mods: Set<string>, bound: Set<string> | null): boolean {
  if (PSEUDO_ROOT.test(st) && (MUTATOR_CALL_ANY.test(st) || MEMBER_WRITE.test(st))) return true; // require(), import(), globals(), vars() hand back live module objects
  if (own.size === 0) return false;
  const alts = [...own].map(escapeRe).join("|");
  const re = new RegExp(String.raw`(?<![\w$.])(${alts})((?:\s*\.\s*[A-Za-z_$][\w$]*)*)`, "g");
  for (const m of st.matchAll(re)) {
    const at = m.index!, end = at + m[0].length, segs = 1 + (m[2]!.match(/\./g)?.length ?? 0), last = segs > 1 ? m[2]!.split(".").pop()!.trim() : m[1]!;
    if (/^\s*(?:\+\+|--)/.test(st.slice(end)) || /(?:\+\+|--)\s*$/.test(st.slice(0, at))) return true; // sut.n++ and --sut.n write the owned object
    if (/^(?:\s*\[[^\]]*\])+\s*(?:\?\.\s*)?(?:\.\s*(?:call|apply|bind)\s*)?\(/.test(st.slice(end))) return true; // sut.rules[k](1): the key is computed, so the callee may be a mutator
    if (/^\s*\(/.test(st.slice(end))) { const close = matchParen(st, end + st.slice(end).indexOf("(")); if (close >= 0 && RESULT_MUTATION.test(st.slice(close + 1))) return true; if (segs >= 2 && MUTATOR_NAME.test(last) && !(segs === 2 && mods.has(m[1]!))) return true; continue; } // a call: a mutator on an owned object is a write
    if (segs >= 2 && MUTATOR_NAME.test(last) && !(segs === 2 && mods.has(m[1]!))) return true; // a mutator referenced as a value (bound, mapped, partial) is still a write
    let d = 0, j = at - 1, open = -1;
    for (; j >= 0; j--) { const c = st[j]!; if (")]}".includes(c)) d++; else if ("([{".includes(c)) { if (d === 0) { if (c === "(") { open = j; break; } if (c === "{" && /(?:=>|\)|\belse|\btry)\s*$/.test(st.slice(0, j))) break; } else d--; } }
    if (open >= 0) {
      const pre = st.slice(0, open), last2 = /([A-Za-z_$][\w$]*)\s*$/.exec(pre)?.[1] ?? "";
      if (/\b(?:def|function|new)\s+[\w$]*\s*$/.test(pre)) return true;
      if ((!own.has(last2) || RUNNER_NAME.test(last2)) && pureCallee(pre, last2, bound)) continue; // fail-safe: an owned value handed to any other call (an owned callee, an in-body import, operator.iadd, heapq.heappop) is a write
      return true;
    }
    const head = st.slice(0, at), eq = /(?<![=!<>])=(?![=>])/.exec(head.slice(Math.max(head.lastIndexOf(";"), head.lastIndexOf("{"), head.lastIndexOf("}"), head.lastIndexOf("\n")) + 1));
    if (eq) return true; // an owned object bound to a local: later writes through the alias are invisible
  }
  return false;
}
/** True when the edit from baseText to headText removes or loosens a test (a removed non-import line, a dropped imported name, an added skip/only/todo marker). Doubt is true. */
export function testEditWeakens(baseText: string, headText: string, opts?: { sharedFixture?: boolean; shadowedFixtures?: ReadonlySet<string> }): boolean {
  try { return analyzeEdit(baseText, headText, opts); } catch (e) { throw new AnalyzerError(e); }
}
/** A throw inside the analyzer: the caller stays fail-safe (not verified) but must label it, so a crash is never read as a finding about the test. */
export class AnalyzerError extends Error {
  constructor(readonly cause0: unknown) { super(`analyzer_error: ${cause0 instanceof Error ? cause0.message : String(cause0)}`); this.name = "AnalyzerError"; }
}
function analyzeEdit(baseText: string, headText: string, opts?: { sharedFixture?: boolean; shadowedFixtures?: ReadonlySet<string> }): boolean {
  const a = baseText.split("\n"), b = headText.split("\n");
  const d = lineDelta(a, b);
  if (!d) return true;
  const aImp = importLines(a), bImp = importLines(b);
  if (d.removed.some((i) => !aImp.has(i) && !isIgnorable(a[i]!))) return true;
  const names = testNames(a);
  const addedCode = d.added.filter((i) => !bImp.has(i));
  if (opts?.sharedFixture && addedCode.some((i) => !isIgnorable(b[i]!))) return true; // conftest and global setup run for every test: any code change there weakens
  const own = moduleNames(a, b), locals = declaredNames(addedCode.map((i) => b[i]!), own), mods = moduleAliases(b);
  const stmts = logicalStatements(addedCode.filter((i) => !isIgnorable(b[i]!)).map((i) => b[i]!)).map(stripAutoUndone);
  const derived = derivedNames(stmts, own), owned = new Set([...own, ...derived]);
  for (const n of derived) locals.delete(n); // a name bound from an owned object is not a free local: a write through it is a write to the owned object
  const bound = pythonLaunderRisk(b, addedCode) ? null : boundNames(b);
  if (stmts.some((st) => reachesOwned(st, owned, mods, bound))) return true;
  if (pythonFixtureLaunder(b, addedCode, opts?.shadowedFixtures ?? new Set())) return true;
  for (const i of addedCode) {
    const l = stripAutoUndone(b[i]!);
    if (COMMENT_OPENER.test(l)) return true;
    if (isIgnorable(l)) continue;
    if (SKIP_MARKER.test(l) || EARLY_EXIT.test(l) || MOCKING.test(l) || SHADOWING.test(l) || externalWrite(l, locals, own)) return true;
    const m = TEST_NAME.exec(l); const n = m?.[1] ?? m?.[3];
    if (n && names.has(n)) return true;
  }
  if (addedCode.some((i) => !isIgnorable(b[i]!))) {
    const scan = scanDepth(a);
    for (const run of addedRuns(a.length, b.length, d)) {
      if (run.from <= run.to && d.added.slice().some((i) => i >= run.from && i <= run.to && !bImp.has(i) && !isIgnorable(b[i]!)) && !runPlacedAsNewBlock(a, b, run, scan)) return true;
    }
  }
  const had = importTokens(a, aImp), has = importTokens(b, bImp);
  for (const t of had) if (!has.has(t)) return true;
  for (const t of has) if (!had.has(t) && /^(expect|assert|assertEqual|assertThat|should)$/.test(t)) return true; // a newly imported name that shadows the assertion API
  return false;
}
const SHARED_FIXTURE = /(?:^|\/)(?:conftest\.py|(?:jest|vitest)\.setup\.\w+|setupTests\.\w+|setup[-_]tests\.\w+)$/;
/** The self-undoing pytest fixture names that a conftest.py on the path from the repo root to `path` rebinds, read at base AND head (rev-237 r9). A conftest that cannot be read throws, so the caller stays fail-safe. */
function conftestShadows(repoDir: string, baseSha: string, headRef: string | null, path: string): Set<string> {
  const out = new Set<string>(), parts = path.split("/").slice(0, -1);
  for (let k = 0; k <= parts.length; k++) {
    const f = [...parts.slice(0, k), "conftest.py"].join("/"), texts: string[] = [];
    if (safeGit(repoDir, ["ls-tree", "--name-only", baseSha, "--", f]).trim()) texts.push(safeGit(repoDir, ["show", `${baseSha}:${f}`]));
    if (headRef) { if (safeGit(repoDir, ["ls-tree", "--name-only", headRef, "--", f]).trim()) texts.push(safeGit(repoDir, ["show", `${headRef}:${f}`])); }
    else if (existsSync(join(repoDir, f))) texts.push(readFileSync(join(repoDir, f), "utf8"));
    for (const t of texts) for (const n of shadowedAutoFixtures(t)) out.add(n);
  }
  return out;
}
/** testEditWeakens on a pre-existing test file read from git (headRef null reads the worktree); any read failure weakens. */
export function testFileWeakened(repoDir: string, baseSha: string, headRef: string | null, path: string): boolean {
  let head: string, base: string;
  try {
    head = headRef ? safeGit(repoDir, ["show", `${headRef}:${path}`]) : readFileSync(join(repoDir, path), "utf8");
    base = safeGit(repoDir, ["show", `${baseSha}:${path}`]);
  } catch (e) {
    process.stderr.write(`assert_delta: read_error ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
    return true;
  }
  let shadowedFixtures: Set<string>;
  try {
    shadowedFixtures = conftestShadows(repoDir, baseSha, headRef, path);
  } catch (e) {
    process.stderr.write(`assert_delta: read_error conftest for ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
    return true;
  }
  try {
    return testEditWeakens(base, head, { sharedFixture: SHARED_FIXTURE.test(path), shadowedFixtures });
  } catch (e) {
    process.stderr.write(`assert_delta: ${e instanceof AnalyzerError ? e.message : `analyzer_error: ${String(e)}`} (${path}); treated as not verified, not as a finding about the test\n`);
    return true;
  }
}
