// Python test invocation and build fact for the engine10 / TS gate path.
// Mirrors autonomy/run.sh (S3, cost program): _loki_run_pytest_with_timeout
// (python3 -m pytest, unittest fallback on exit 5) and the enforce_build_check
// python3 -m compileall arm. Change both together.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandExists, run } from "./shell.ts";
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

/** Stdlib discovery args after the interpreter; check_result.ts reuses them for the unittest full suite. */
export const UNITTEST_DISCOVER_ARGS: readonly string[] = ["-m", "unittest", "discover", "-p", "test_*.py"];
const UNITTEST_ARGV: readonly string[] = ["python3", ...UNITTEST_DISCOVER_ARGS];

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
  opts: { exec?: PyExec; exists?: (name: string) => Promise<string | null>; timeoutMs?: number } = {},
): Promise<PytestOutcome> {
  const rawExec = opts.exec ?? run;
  const probe = opts.exists ?? commandExists;
  const exists = async (name: string): Promise<string | null> => {
    try {
      return await probe(name);
    } catch {
      return null;
    }
  };
  const timeoutMs = opts.timeoutMs ?? 300_000;
  // A spawn that cannot start (ENOENT) is exit 127, never a thrown error.
  const exec: PyExec = async (argv, o) => {
    try {
      return await rawExec(argv, o);
    } catch (e) {
      return { stdout: "", stderr: String(e), exitCode: 127 };
    }
  };
  const timed = async (argv: readonly string[]): Promise<{ exitCode: number; output: string }> => {
    const t0 = Date.now();
    const r = await exec(argv, { cwd, timeoutMs, env: {} });
    const timedOut = r.exitCode !== 0 && Date.now() - t0 >= timeoutMs;
    return { exitCode: timedOut ? 124 : r.exitCode, output: joinOut(r) };
  };
  // Python < 3.12 exits 0 on "Ran 0 tests"; zero tests is never a pass.
  const unittestRun = async (): Promise<{ exitCode: number; output: string }> => {
    const u = await timed(UNITTEST_ARGV);
    return u.exitCode === 0 && ranZeroTests(u.output) ? { ...u, exitCode: 5 } : u;
  };
  // run.sh `command -v`: a missing python3 proves nothing (exit 5 + zero marker = inconclusive upstream).
  if (!(await exists("python3"))) {
    return { exitCode: 5, output: "[loki] python3 not found\nNO TESTS RAN", runner: "unittest" };
  }
  const importable = (await exec(["python3", "-c", "import pytest"], { cwd, timeoutMs: 30_000, env: {} })).exitCode === 0;
  const haveBin = importable || (await exists("pytest")) !== null;
  if (!haveBin) {
    const u = await unittestRun();
    return { ...u, runner: "unittest" };
  }
  const p = await timed(pytestArgv(importable, args));
  if (p.exitCode !== 5) return { ...p, runner: "pytest" };
  const u = await unittestRun();
  const output = `${p.output}\n[loki] pytest collected 0 tests (exit 5); fell back to python3 -m unittest discover\n${u.output}`;
  return { exitCode: u.exitCode, output, runner: "unittest" };
}

export type PythonBuildFact = {
  status: "verified" | "failed" | "not_applicable";
  command: string;
  exitCode: number | null;
  durationSec?: number | null;
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

const TOKEN_FREE_ENV: Record<string, string> = Object.fromEntries(
  [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
  ].map((k) => [k, ""]),
);

function hasNpmBuildScript(tree: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(tree, "package.json"), "utf8"));
    const b = pkg?.scripts?.build;
    return typeof b === "string" && b.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Build fact for the TS route (mirrors run.sh enforce_build_check): a
 * package.json "build" script runs via `npm run build --if-present` with
 * token variables blanked and a LOKI_GATE_TIMEOUT bound; otherwise the
 * manifest-less python arm; otherwise not_applicable (never verified).
 */
export async function buildFact(
  tree: string,
  pycacheDir: string,
  opts: { exec?: PyExec; timeoutMs?: number } = {},
): Promise<PythonBuildFact> {
  const gateS = Number(process.env.LOKI_GATE_TIMEOUT);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(gateS) && gateS > 0 ? gateS * 1000 : 300_000);
  const t0 = Date.now();
  const withDuration = (f: PythonBuildFact): PythonBuildFact => ({
    ...f,
    durationSec: f.exitCode === null ? null : (Date.now() - t0) / 1000,
  });
  if (hasNpmBuildScript(tree)) {
    const command = "npm run build --if-present";
    const exec = opts.exec ?? run;
    let exitCode: number;
    try {
      const r = await exec(["npm", "run", "build", "--if-present"], { cwd: tree, timeoutMs, env: TOKEN_FREE_ENV });
      exitCode = r.exitCode;
    } catch {
      exitCode = 127;
    }
    return withDuration({ status: exitCode === 0 ? "verified" : "failed", command, exitCode });
  }
  return withDuration(await pythonBuildCheck(tree, pycacheDir, { exec: opts.exec, timeoutMs }));
}

/** Writes .loki/quality/build-results.json in the shape proof-generator.py _collect_build reads. */
export function writeBuildResults(lokiDir: string, fact: PythonBuildFact): void {
  const dir = join(lokiDir, "quality");
  mkdirSync(dir, { recursive: true });
  const na = fact.status === "not_applicable";
  const body = {
    timestamp: new Date().toISOString(),
    command: na ? "" : fact.command,
    ran: !na,
    applicable: !na,
    exit_code: na ? null : fact.exitCode,
    duration_sec: na ? null : (fact.durationSec ?? null),
    status: fact.status,
  };
  writeFileSync(join(dir, "build-results.json"), JSON.stringify(body) + "\n");
}
