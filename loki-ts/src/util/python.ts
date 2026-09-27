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
