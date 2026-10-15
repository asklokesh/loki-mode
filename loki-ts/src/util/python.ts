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
import { accessSync, constants, existsSync, statSync } from "node:fs";
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
