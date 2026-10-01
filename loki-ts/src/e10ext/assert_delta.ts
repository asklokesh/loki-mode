// D50-F2-S1: classify a pytest test-file edit as a pure literal "value-change" or "weakened".
// Pure and fail closed: anything unparsed, non-pytest, structural or doubtful is "weakened".
// Structure (decorators, parametrize row counts, assert counts, everything else) must be
// identical once every literal is normalised to its Python type, and the run and skip counts
// must be exactly equal to base. Never keyed on collected test ids (parametrize ids move).
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface AssertDeltaInput {
  path: string;
  base: string;
  head: string;
  names: string[]; // symbols the task mentions
  baseCounts: { run: number; skipped: number };
  headCounts: { run: number; skipped: number };
}
export interface AssertDeltaResult {
  verdict: "value-change" | "weakened";
  changes: string[]; // "file:line old -> new"
}

const WEAKENED: AssertDeltaResult = { verdict: "weakened", changes: [] };

const PY = String.raw`
import ast, copy, json, sys
d = json.load(sys.stdin)
names = set(d["names"])
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

def out(v, c=()):
    print(json.dumps({"verdict": v, "changes": list(c)}))
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
changes, ok = [], True
for b, h, f in pairs:
    if (type(b.value), repr(b.value)) != (type(h.value), repr(h.value)):
        called = f is not None and any(
            isinstance(c, ast.Call) and (getattr(c.func, "id", None) in names or getattr(c.func, "attr", None) in names)
            for c in ast.walk(f))
        ok = ok and called
        changes.append("%s:%d %r -> %r" % (d["path"], h.lineno, b.value, h.value))
out("value-change" if ok and changes else "weakened", changes if ok else [])
`;

export function classifyAssertDelta(inp: AssertDeltaInput): AssertDeltaResult {
  const f = basename(inp.path);
  if (!/^(test_.*|.*_test)\.py$/.test(f)) return WEAKENED;
  if (inp.headCounts.run !== inp.baseCounts.run || inp.headCounts.skipped !== inp.baseCounts.skipped) return WEAKENED;
  try {
    const raw = execFileSync("python3", ["-c", PY], {
      input: JSON.stringify({ path: inp.path, base: inp.base, head: inp.head, names: inp.names }),
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
