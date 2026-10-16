// Python test invocation and build fact for the engine10 / TS gate path.
// Mirrors autonomy/run.sh (S3, cost program): _loki_run_pytest_with_timeout
// (python3 -m pytest, unittest fallback on exit 5) and the enforce_build_check
// python3 -m compileall arm. Change both together.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "./shell.ts";
import type { ShellOpts, ShellResult } from "./shell.ts";

export type PyExec = (argv: readonly string[], opts: ShellOpts) => Promise<ShellResult>;

export type PytestOutcome = {
  exitCode: number;
  output: string;
  runner: "pytest" | "unittest";
};

const SKIP_DIRS = new Set([".loki", ".git", "node_modules", ".venv", "venv", "__pycache__"]);
const ZERO_TESTS_MARKER = /^(Ran 0 tests|NO TESTS RAN$)/m;

/** True when output positively says zero tests ran (run.sh grep -qE '^(Ran 0 tests|NO TESTS RAN$)'). */
export function ranZeroTests(output: string): boolean {
  return ZERO_TESTS_MARKER.test(output);
}

function walk(dir: string, depth: number, pred: (name: string) => boolean): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && pred(e.name)) return true;
  }
  if (depth <= 0) return false;
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && walk(join(dir, e.name), depth - 1, pred)) return true;
  }
  return false;
}

/** Python test files within two levels (run.sh #139 shape: root test_*.py, tests/ dir). */
export function hasPythonTests(cwd: string): boolean {
  return walk(cwd, 2, (n) => /^test_.*\.py$/.test(n) || /_test\.py$/.test(n) || n === "conftest.py");
}

/** Any .py file within four levels, outside tooling dirs (run.sh build-check find -maxdepth 4). */
export function hasPythonSources(cwd: string): boolean {
  return walk(cwd, 3, (n) => n.endsWith(".py"));
}

/**
 * Pytest argv. Bare `pytest` does not put the cwd on sys.path, so root-level
 * modules imported from tests/ raise ModuleNotFoundError (a false RED);
 * `python3 -m pytest` adds cwd. Bare binary only when python3 cannot import pytest.
 */
export function pytestArgv(pytestImportable: boolean, args: readonly string[]): string[] {
  return pytestImportable ? ["python3", "-m", "pytest", ...args] : ["pytest", ...args];
}

const UNITTEST_ARGV: readonly string[] = ["python3", "-m", "unittest", "discover", "-p", "test_*.py"];

const joinOut = (r: ShellResult): string => [r.stdout, r.stderr].filter((s) => s.length > 0).join("\n");

/**
 * Runs the project's python tests. pytest first; on pytest exit 5 (collected
 * zero items) falls back to stdlib unittest discovery. Zero tests from BOTH
 * stays exit 5 (caller records inconclusive); exit 5 without a positive zero
 * marker is a plain failure for the caller. Timeout yields exit 124.
 */
export async function runPythonTests(
  cwd: string,
  args: readonly string[] = ["--tb=short"],
  opts: { exec?: PyExec; timeoutMs?: number } = {},
): Promise<PytestOutcome> {
  const exec = opts.exec ?? run;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const timed = async (argv: readonly string[]): Promise<{ exitCode: number; output: string }> => {
    const t0 = Date.now();
    const r = await exec(argv, { cwd, timeoutMs });
    const timedOut = r.exitCode !== 0 && Date.now() - t0 >= timeoutMs;
    return { exitCode: timedOut ? 124 : r.exitCode, output: joinOut(r) };
  };
  const importable = (await exec(["python3", "-c", "import pytest"], { cwd, timeoutMs: 30_000 })).exitCode === 0;
  const haveBin = importable || (await exec(["pytest", "--version"], { cwd, timeoutMs: 30_000 })).exitCode === 0;
  if (!haveBin) {
    const u = await timed(UNITTEST_ARGV);
    return { ...u, runner: "unittest" };
  }
  const p = await timed(pytestArgv(importable, args));
  if (p.exitCode !== 5) return { ...p, runner: "pytest" };
  const u = await timed(UNITTEST_ARGV);
  const output = `${p.output}\n[loki] pytest collected 0 tests (exit 5); fell back to python3 -m unittest discover\n${u.output}`;
  if (u.exitCode === 0 && ranZeroTests(u.output)) return { exitCode: 5, output, runner: "unittest" };
  return { exitCode: u.exitCode, output, runner: "unittest" };
}

export type PythonBuildFact = {
  status: "verified" | "failed" | "not_applicable";
  command: string;
  exitCode: number | null;
};

/**
 * Build fact for a manifest-less python tree: byte-compile every module
 * (syntax and import-time constants), pycache redirected out of the repo.
 * A tree with package.json or no python sources is not_applicable here; the
 * caller keeps its own honest not_run for other stacks.
 */
export async function pythonBuildCheck(
  tree: string,
  pycacheDir: string,
  opts: { exec?: PyExec; timeoutMs?: number } = {},
): Promise<PythonBuildFact> {
  const command = "python3 -m compileall -q .";
  if (existsSync(join(tree, "package.json")) || !hasPythonSources(tree)) {
    return { status: "not_applicable", command, exitCode: null };
  }
  const exec = opts.exec ?? run;
  const r = await exec(
    ["python3", "-m", "compileall", "-q", "-x", "(^|/)(\\.loki|\\.git|node_modules|\\.venv|venv)(/|$)", "."],
    { cwd: tree, timeoutMs: opts.timeoutMs ?? 120_000, env: { PYTHONPYCACHEPREFIX: pycacheDir } },
  );
  return { status: r.exitCode === 0 ? "verified" : "failed", command, exitCode: r.exitCode };
}
