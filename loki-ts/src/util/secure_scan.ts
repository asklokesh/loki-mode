// Typed wrapper for autonomy/lib/secure-scan.py. argv spawn (no shell), a
// timeout, and a parsed {ok, findings, error?} result. Exit contract of the
// script: 0 no findings, 1 findings, 2 bad input. Anything else, or output
// that is not the expected JSON, is an error (never a silent pass).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.ts";
import { findPython3 } from "./python.ts";
import { run } from "./shell.ts";

export interface SecureScanFinding {
  rule: string;
  file: string;
  line: number;
  severity: string;
  message: string;
  fix: string;
}

export interface SecureScanResult {
  ok: boolean;
  findings: SecureScanFinding[];
  error?: string;
}

export interface SecureScanOpts {
  scriptPath?: string;
  timeoutMs?: number;
}

export const DEFAULT_SECURE_SCAN_TIMEOUT_MS = 120_000;

function fail(error: string): SecureScanResult {
  return { ok: false, findings: [], error };
}

export async function runSecureScan(targetDir: string, opts: SecureScanOpts = {}): Promise<SecureScanResult> {
  const script = opts.scriptPath ?? join(REPO_ROOT, "autonomy", "lib", "secure-scan.py");
  if (!existsSync(script)) return fail(`secure-scan script not found: ${script}`);
  const py = await findPython3();
  if (!py) return fail("python3 not found");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SECURE_SCAN_TIMEOUT_MS;

  const started = Date.now();
  const res = await run([py, script, targetDir, "--json"], { timeoutMs });
  const elapsed = Date.now() - started;

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    parsed = undefined;
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;

  if ((res.exitCode === 0 || res.exitCode === 1) && obj && Array.isArray(obj.findings)) {
    const findings = obj.findings as SecureScanFinding[];
    // Exit code and payload must agree; a mismatch is a broken scanner.
    if ((res.exitCode === 1) === (findings.length > 0)) return { ok: true, findings };
    return fail(`secure-scan exit ${res.exitCode} disagrees with ${findings.length} findings`);
  }
  if (res.exitCode !== 0 && res.exitCode !== 1 && res.exitCode !== 2 && elapsed >= timeoutMs) {
    return fail(`secure-scan timed out after ${timeoutMs}ms`);
  }
  if (obj && typeof obj.error === "string") return fail(`secure-scan: ${obj.error}`);
  const tail = (res.stderr || res.stdout).trim().split("\n").slice(-3).join(" | ");
  return fail(`secure-scan failed (exit ${res.exitCode}): ${tail}`);
}
