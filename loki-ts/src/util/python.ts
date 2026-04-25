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
import { existsSync } from "node:fs";

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

// Test-only reset for the cache. Used by python.test.ts.
export function _resetPythonCacheForTests(): void {
  _pythonCache = undefined;
}
