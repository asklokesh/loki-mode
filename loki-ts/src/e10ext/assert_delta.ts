// D50-F2-S1: classify a pytest test-file edit as a pure literal "value-change" or "weakened".
// Pure and fail closed: anything unparsed, non-pytest, structural or doubtful is "weakened".
// Structure (decorators, parametrize row counts, assert counts, everything else) must be
// identical once every literal is normalised to its Python type, and the run and skip counts
// must be exactly equal to base. Never keyed on collected test ids (parametrize ids move).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basename } from "node:path";

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
            solo = {k for k in cols if all(id(n) in rights for n in ast.walk(f) if isinstance(n, ast.Name) and n.id == k and n not in [m for dd in f.decorator_list for m in ast.walk(dd)])}
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
    t = v if isinstance(v, str) else repr(v)
    if t == "":
        return False
    tok = r"(?<![\w.])" + re.escape(t) + r"(?![\w]|\.\d)"
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
    const show = (ref: string): string => execFileSync("git", ["show", `${ref}:${path}`], { cwd: repoDir, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    const head = headRef ? show(headRef) : readFileSync(join(repoDir, path), "utf8");
    const r = classifyTestEdit(path, show(baseSha), head, task, baseCounts, headCounts);
    return r[0].kind === "literal-only" ? r.map((e) => `assertion value changed (not shown to be required by the task): ${e.file}:${e.line} ${e.old} -> ${e.new}`) : null;
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
