// D50-F2-S1: classify a pytest test-file edit as a pure literal "value-change" or "weakened".
// Pure and fail closed: anything unparsed, non-pytest, structural or doubtful is "weakened".
// Structure (decorators, parametrize row counts, assert counts, everything else) must be
// identical once every literal is normalised to its Python type, and the run and skip counts
// must be exactly equal to base. Never keyed on collected test ids (parametrize ids move).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  items?: { line: number; old: string; new: string }[];
}

const WEAKENED: AssertDeltaResult = { verdict: "weakened", changes: [] };

const PY = String.raw`
import ast, copy, json, sys
d = json.load(sys.stdin)
bt, ht = ast.parse(d["base"]), ast.parse(d["head"])

class Norm(ast.NodeTransformer):
    def visit_Constant(self, n):
        return ast.copy_location(ast.Constant(value="<" + type(n.value).__name__ + ">"), n)

def norm(t):
    return ast.dump(Norm().visit(copy.deepcopy(t)))

def tests(t):
    return [f for f in ast.walk(t) if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)) and f.name.startswith("test")]

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

def out(v, c=(), it=()):
    print(json.dumps({"verdict": v, "changes": list(c), "items": list(it)}))
    sys.exit(0)

sb, sh = stripped(bt), stripped(ht)
if not tests(ht) or norm(sb) != norm(sh):
    out("weakened")
tb, th = tables(bt), tables(ht)
# row-count rule: every parametrize table keeps its number of rows
if any(len(x.elts) != len(y.elts) for x, y in zip(tb, th)):
    out("weakened")
# each row keeps its shape and literal types
if any(norm(r) != norm(q) for x, y in zip(tb, th) for r, q in zip(x.elts, y.elts)):
    out("weakened")
owner2 = {}
for f in tests(sh):
    for n in ast.walk(f):
        owner2[id(n)] = f
pairs = [(b, h, owner2.get(id(h))) for b, h in zip(consts(sb), consts(sh))]
fh = {}
for f in tests(ht):
    for t in tables(f):
        fh[id(t)] = f
for x, y in zip(tb, th):
    for r, q in zip(x.elts, y.elts):
        pairs += [(b, h, fh.get(id(y))) for b, h in zip(consts(r), consts(q))]
# D50-F2r: label only an expected-value literal (assert X == lit, or a parametrize column that an assert compares), never control flow, args, tolerances or decorators
def eqs(f):
    return [a.test for a in ast.walk(f) if isinstance(a, ast.Assert) and isinstance(a.test, ast.Compare)
            and len(a.test.ops) == 1 and isinstance(a.test.ops[0], ast.Eq)]
def dups(t):
    r = {}
    for f in tests(t):
        ds = [ast.dump(a) for a in ast.walk(f) if isinstance(a, ast.Assert)]
        r[f.name] = len(ds) - len(set(ds))
    return r
dh, db = dups(ht), dups(bt)
dup = any(v > db.get(k, 0) for k, v in dh.items())
exp = set()
for f in tests(sh):
    exp |= {id(o) for c in eqs(f) for o in [c.left] + c.comparators if isinstance(o, ast.Constant)}
for f in tests(ht):
    en = {o.id for c in eqs(f) for o in [c.left] + c.comparators if isinstance(o, ast.Name)}
    for c in ast.walk(f):
        if isinstance(c, ast.Call) and getattr(c.func, "attr", "") == "parametrize" and len(c.args) > 1 \
                and isinstance(c.args[0], ast.Constant) and isinstance(c.args[0].value, str) and isinstance(c.args[1], (ast.List, ast.Tuple)):
            cols = [x.strip() for x in c.args[0].value.split(",")]
            for r in c.args[1].elts:
                for i, e in enumerate(r.elts if isinstance(r, (ast.Tuple, ast.List)) else [r]):
                    if isinstance(e, ast.Constant) and i < len(cols) and cols[i] in en:
                        exp.add(id(e))
task = d["task"]
def in_task(v):
    return str(v) != "" and str(v) in task
changes, items, ok = [], [], not dup
for b, h, f in pairs:
    if (type(b.value), repr(b.value)) != (type(h.value), repr(h.value)):
        ok = ok and id(h) in exp and (in_task(b.value) or in_task(h.value))
        changes.append("%s:%d %r -> %r" % (d["path"], h.lineno, b.value, h.value))
        items.append({"line": h.lineno, "old": repr(b.value), "new": repr(h.value)})
out("value-change" if ok and changes else "weakened", changes if ok else [], items if ok else [])
`;

export function classifyAssertDelta(inp: AssertDeltaInput): AssertDeltaResult {
  const f = basename(inp.path);
  if (!/^(test_.*|.*_test)\.py$/.test(f)) return WEAKENED;
  if (inp.headCounts.run !== inp.baseCounts.run || inp.headCounts.skipped !== inp.baseCounts.skipped) return WEAKENED;
  try {
    const raw = execFileSync("python3", ["-c", PY], {
      input: JSON.stringify({ path: inp.path, base: inp.base, head: inp.head, task: inp.task }),
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 20_000,
    });
    const r = JSON.parse(raw) as AssertDeltaResult;
    return r.verdict === "value-change" && r.changes.length > 0 ? r : WEAKENED;
  } catch {
    return WEAKENED;
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
 *  old and new are Python reprs. Counts default to equal; pass real ones to enforce them. */
export function classifyTestEdit(file: string, oldText: string, newText: string, taskText: string, baseCounts: Counts = { run: 0, skipped: 0 }, headCounts: Counts = baseCounts): TestEdit[] {
  const weak: TestEdit[] = [{ kind: "weakened", file, line: 0, old: "", new: "", inTask: false }];
  const r = classifyAssertDelta({ path: file, base: oldText, head: newText, task: taskText, baseCounts, headCounts });
  if (r.verdict !== "value-change" || !r.items?.length) return weak;
  return r.items.map((i) => ({ kind: "literal-only" as const, file, line: i.line, old: i.old, new: i.new, inTask: true }));
}
