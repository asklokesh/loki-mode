// CCR-06: structured Wall authoring (flag LOKI_E10_WALL_CASES=1, off by default). For a Python repo the Wall author returns
// schema-checked JSON test cases instead of free-form test code; this module validates them and renders the repo's native
// runner file (the repo default Python runner, or unittest when the repo uses it). Malformed JSON or a schema violation is refused with a named reason.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerName } from "../engine10/types.ts";
import { guessRunner } from "../engine10/testmap.ts";
import { plainTestEnv, resolveTool } from "./check_result.ts";

export const WALL_CASES_JSON = "loki_wall_cases.json";
export const WALL_CASE_PREFIX = "loki_wall_case_";
// Run by the repo's own interpreter: every author field must be ONE well-formed piece of code before it is placed in a template.
const PY_CHECK = `import ast, json, sys
def bad(kind, src):
    try:
        t = ast.parse(src.strip(), mode="eval" if kind == "expr" else "exec")
    except Exception:
        return "does not parse as python" if kind == "file" else "is not well-formed python code"
    if kind == "file": return ""
    if kind == "expr" and isinstance(t.body, ast.Tuple): return "is a top-level tuple, not one expression"
    if kind == "stmt" and (len(t.body) != 1 or isinstance(t.body[0], ast.Return)): return "is not exactly one statement that leaves the test running"
    if any(isinstance(n, (ast.Yield, ast.YieldFrom, ast.Await)) for n in ast.walk(t)): return "uses yield or await, which would stop the test body from running"
    return ""
print(json.dumps([bad(k, v) for k, v in json.load(sys.stdin)]))
`;
const KINDS = ["equals", "not_equals", "true", "false", "is_none", "raises"] as const;
type Kind = (typeof KINDS)[number];
interface Case { name: string; kind: Kind; imports: string[]; arrange: string[]; call: string; expected?: string; exception?: string; }
const KEYS = new Set(["name", "kind", "imports", "arrange", "call", "expected", "exception"]);
const IMPORT_RE = /^(?:import [A-Za-z_][\w.]*(?: as [A-Za-z_]\w*)?|from [A-Za-z_.][\w.]* import (?:\*|[A-Za-z_]\w*(?: as [A-Za-z_]\w*)?(?:, ?[A-Za-z_]\w*(?: as [A-Za-z_]\w*)?)*))$/;
const MAX_CASES = 40;

export const wallCasesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_E10_WALL_CASES === "1";
/** The Python runner structured authoring renders for, or null when the flag is off or the detected runners are not purely Python (the free-form path then runs unchanged). Runner detection stays harnessRunners/guessRunner: a runner is Python exactly when guessRunner maps a .py file to it. */
export function wallCasesRunner(runners: RunnerName[], env: NodeJS.ProcessEnv = process.env): RunnerName | null {
  if (!wallCasesEnabled(env) || runners.length === 0 || runners.some((r) => guessRunner("x.py", [r]) !== r)) return null;
  return guessRunner("x.py", runners);
}

export function wallCasesBrief(runners: RunnerName[], env: NodeJS.ProcessEnv = process.env): string {
  const r = wallCasesRunner(runners, env);
  if (!r) return "";
  return `\n\nOutput format override: do NOT write test code. Write exactly one file, ${WALL_CASES_JSON}, holding JSON {"cases":[...]} (at most ${MAX_CASES}). Each case: {"name": python identifier, "kind": one of ${KINDS.join("|")}, "imports": ["from pkg import fn", ...], "arrange": ["x = 1", ...] (single-line statements, optional), "call": single-line python expression, "expected": python expression (equals and not_equals only), "exception": exception class name (raises only)}. The harness renders these to ${r}. No other keys, no other files.`;
}

const testName = (name: string): string => (name.startsWith("test") ? name : `test_${name}`);

function parse(text: string): Case[] | string {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return "wall_cases_malformed_json: the author output is not valid JSON"; }
  const o = doc as { cases?: unknown };
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || Object.keys(doc).some((k) => k !== "cases") || !Array.isArray(o.cases)) return "wall_cases_schema: top level must be exactly {\"cases\": [...]}";
  if (o.cases.length === 0 || o.cases.length > MAX_CASES) return `wall_cases_schema: cases must hold 1 to ${MAX_CASES} entries`;
  const seen = new Set<string>(), out: Case[] = [];
  const line = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && !/[\r\n]/.test(v);
  for (const [i, raw] of (o.cases as unknown[]).entries()) {
    const bad = (m: string): string => `wall_cases_schema: case ${i}: ${m}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("not an object");
    const c = raw as Record<string, unknown>, extra = Object.keys(c).find((k) => !KEYS.has(k));
    if (extra) return bad(`unknown key ${extra}`);
    if (typeof c.name !== "string" || !/^[A-Za-z_]\w*$/.test(c.name)) return bad("name must be a python identifier");
    const rendered = testName(c.name);
    if (seen.has(rendered)) return bad(`duplicate test name ${rendered} (foo and test_foo render to the same name)`);
    seen.add(rendered);
    if (!KINDS.includes(c.kind as Kind)) return bad(`kind must be one of ${KINDS.join(", ")}`);
    const imports = c.imports ?? [], arrange = c.arrange ?? [];
    if (!Array.isArray(imports) || !imports.every((s) => line(s) && IMPORT_RE.test(s))) return bad("imports must be single-line import statements");
    if (!Array.isArray(arrange) || !arrange.every(line)) return bad("arrange must be single-line statements");
    if (!line(c.call)) return bad("call must be a single-line expression");
    if ((c.kind === "equals" || c.kind === "not_equals") && !line(c.expected)) return bad("expected is required for equals and not_equals");
    if (c.kind === "raises" && !(typeof c.exception === "string" && /^[A-Za-z_][\w.]*$/.test(c.exception))) return bad("exception is required for raises");
    out.push({ name: c.name, kind: c.kind as Kind, imports: (imports as string[]).map((x) => x.trim()), arrange: (arrange as string[]).map((x) => x.trim()), call: c.call.trim(), ...(typeof c.expected === "string" ? { expected: c.expected.trim() } : {}), ...(typeof c.exception === "string" ? { exception: c.exception } : {}) });
  }
  return out;
}

/** One file per case, so the holdout (WALL_HOLDOUT_MIN files) and the per-file base run still apply. */
export function renderCase(c: Case, runner: RunnerName): string {
  const py = runner === guessRunner("x.py", []), pad = py ? "" : "    ";
  const head = [...(py ? (c.kind === "raises" ? [`import ${runner}`] : []) : ["import unittest"]), ...new Set(c.imports)];
  const stmt = py
    ? { equals: `assert (${c.call}) == (${c.expected})`, not_equals: `assert (${c.call}) != (${c.expected})`, true: `assert (${c.call})`, false: `assert not (${c.call})`, is_none: `assert (${c.call}) is None`, raises: `with ${runner}.raises(${c.exception}):\n    ${c.call}` }[c.kind]
    : { equals: `self.assertEqual(${c.call}, ${c.expected})`, not_equals: `self.assertNotEqual(${c.call}, ${c.expected})`, true: `self.assertTrue(${c.call})`, false: `self.assertFalse(${c.call})`, is_none: `self.assertIsNone(${c.call})`, raises: `with self.assertRaises(${c.exception}):\n    ${c.call}` }[c.kind];
  const fn = [`def ${testName(c.name)}(${py ? "" : "self"}):`, ...[...c.arrange, ...stmt.split("\n")].map((x) => `    ${x}`)].map((x) => `${pad}${x}`).join("\n");
  const tail = py ? fn : `class TestWallCases(unittest.TestCase):\n${fn}\n\n\nif __name__ == "__main__":\n    unittest.main()`;
  return `${head.join("\n")}\n\n\n${tail}\n`;
}

/** Every author field and every rendered file through ast.parse in the repo's interpreter; null when all are clean, else the named refusal. */
function unsafeCode(cases: Case[], runner: RunnerName, repoDir: string): string | null {
  const [bin, , pre] = resolveTool(repoDir, "python", "python3");
  const run = (items: [string, string][]): string[] | string => {
    const r = spawnSync(bin, [...pre, "-I", "-c", PY_CHECK], { input: JSON.stringify(items), encoding: "utf8", env: plainTestEnv(), timeout: 30_000 });
    try { const v = JSON.parse(r.stdout ?? "") as unknown; if (r.status === 0 && Array.isArray(v) && v.length === items.length) return v as string[]; } catch { /* named below */ }
    return `wall_cases_no_interpreter: could not validate the cases with ${bin} (exit ${r.status ?? "none"})`;
  };
  const fields: [string, string][] = [], where: string[] = [];
  cases.forEach((c, i) => {
    const add = (kind: string, what: string, src: string | undefined): void => { if (src !== undefined) { fields.push([kind, src]); where.push(`case ${i}: ${what}`); } };
    c.arrange.forEach((a, k) => add("stmt", `arrange[${k}]`, a)); add("expr", "call", c.call); add("expr", "expected", c.expected);
  });
  const a = run(fields);
  if (typeof a === "string") return a;
  const hit = a.findIndex((v) => v !== "");
  if (hit >= 0) return `wall_cases_unsafe_code: ${where[hit]} ${a[hit]}`;
  const b = run(cases.map((c) => ["file", renderCase(c, runner)]));
  if (typeof b === "string") return b;
  const bit = b.findIndex((v) => v !== "");
  return bit >= 0 ? `wall_cases_unsafe_code: case ${bit}: the rendered test file ${b[bit]}` : null;
}

/** After the author session in `cwd`: null when structured authoring does not apply or succeeded (one rendered file per case now sits in cwd, the JSON is removed); else the named refusal. Never falls back to free-form code. */
export function ingestWallCases(cwd: string, runners: RunnerName[], repoDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const runner = wallCasesRunner(runners, env);
  if (!runner) return null;
  const stray = readdirSync(cwd).filter((f) => f.startsWith("loki_wall_") && f !== WALL_CASES_JSON);
  if (stray.length > 0) return `wall_cases_free_form_output: the author wrote ${stray.join(", ")} instead of ${WALL_CASES_JSON}`;
  const src = join(cwd, WALL_CASES_JSON);
  if (!existsSync(src)) return `wall_cases_missing: the author wrote no ${WALL_CASES_JSON}`;
  const cases = parse(readFileSync(src, "utf8"));
  if (typeof cases === "string") return cases;
  const unsafe = unsafeCode(cases, runner, repoDir);
  if (unsafe) return unsafe;
  cases.forEach((c, i) => writeFileSync(join(cwd, `${WALL_CASE_PREFIX}${i + 1}_${c.name}.py`), renderCase(c, runner), "utf8"));
  rmSync(src, { force: true });
  return null;
}
