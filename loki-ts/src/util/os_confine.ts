// #334 AC6: wrap a provider launch in the OS confinement built by
// autonomy/lib/os_sandbox.py (the one profile builder; this file never builds a profile).
// Mirrors run.sh _loki_os_confine_init: default off (issue #334), LOKI_OS_SANDBOX=auto|on opts in,
// unavailable confinement runs unconfined and says so (status file plus a stderr line).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "./paths.ts";

export interface ConfineResult {
  cmd: string;
  args: string[];
  active: boolean;
  kind: string;
  warning: string | null;
}

interface ArgvJson { argv_prefix?: string[]; kind?: string; reason?: string; mode?: string }

// Providers that apply their own sandbox; a nested sandbox_apply is refused, so they run unwrapped (kind none).
export function confineSpawn(
  cmd: string,
  args: string[],
  opts: { workspace: string; runDir: string; provider: string; env?: NodeJS.ProcessEnv; extraRead?: string[]; statusFile?: string | null },
): ConfineResult {
  const env = opts.env ?? process.env;
  const bare: ConfineResult = { cmd, args, active: false, kind: "none", warning: null };
  const statusFile = opts.statusFile === undefined ? join(opts.runDir, "state", "os-sandbox.json") : opts.statusFile;
  const argv = ["-m", "autonomy.lib.os_sandbox", "argv", "--workspace", opts.workspace, "--run-dir", opts.runDir, "--provider", opts.provider, "--format", "json"];
  for (const p of opts.extraRead ?? []) argv.push("--extra-read", p);
  if (statusFile) { mkdirSync(dirname(statusFile), { recursive: true }); argv.push("--status-file", statusFile); }
  const r = spawnSync("python3", argv, { cwd: REPO_ROOT, env: { ...env }, encoding: "utf8", timeout: 30_000 });
  let parsed: ArgvJson = {};
  try { parsed = JSON.parse(r.stdout || "{}") as ArgvJson; } catch { /* handled below */ }
  const prefix = parsed.argv_prefix ?? [];
  if (r.status === 0 && prefix.length > 0) {
    return { cmd: prefix[0]!, args: [...prefix.slice(1), cmd, ...args], active: true, kind: parsed.kind ?? "unknown", warning: null };
  }
  if ((env["LOKI_OS_SANDBOX"] ?? "off") === "on") {
    throw new Error(`LOKI_OS_SANDBOX=on but confinement is unavailable: ${(r.stderr || parsed.reason || "unknown").toString().trim()}`);
  }
  const reason = parsed.reason ?? (r.stderr || "").trim().split("\n").pop() ?? "";
  const off = (env["LOKI_OS_SANDBOX"] ?? "off") === "off";
  const warning = off || opts.provider === "codex" ? null : `OS confinement unavailable, running unconfined${reason ? `: ${reason}` : ""}`;
  if (statusFile && r.status !== 0) {
    try { writeFileSync(statusFile, JSON.stringify({ kind: "none", mode: env["LOKI_OS_SANDBOX"] ?? "off", provider: opts.provider, reason }) + "\n"); } catch { /* best effort */ }
  }
  return { ...bare, warning };
}
