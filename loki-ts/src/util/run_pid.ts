// CPE-09: <run dir>/run.pid, written by the supervisor so the Control Plane can stop exactly this run and nothing else.
// The process start time is the guard against PID reuse: a recycled pid has a different start time.
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunPid { pid: number; start: string; argv: string[]; run_id: string }
export type Verified = { ok: true; pid: number } | { ok: false; reason: string };

export const runPidPath = (runDir: string): string => join(runDir, "run.pid");

/** Start time of a live process as the OS reports it (`ps lstart`, C locale), or null when the pid is not alive. */
export function processStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().replace(/\s+/g, " ") || null;
  } catch { return null; }
}

/** Writes run.pid atomically (0600) and returns a remover that only deletes a file this process wrote. Never throws. */
export function writeRunPid(runDir: string, runId: string, pid: number = process.pid, argv: string[] = process.argv): () => void {
  const path = runPidPath(runDir);
  try {
    const start = processStartTime(pid);
    if (start) {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ pid, start, argv, run_id: runId } satisfies RunPid) + "\n", { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    }
  } catch { /* best effort: a missing run.pid only means Stop is unavailable */ }
  return () => {
    try { if ((JSON.parse(readFileSync(path, "utf8")) as { pid?: number }).pid === pid) rmSync(path, { force: true }); } catch { /* gone */ }
  };
}

export function readRunPid(runDir: string): RunPid | null {
  try {
    const j = JSON.parse(readFileSync(runPidPath(runDir), "utf8")) as Partial<RunPid>;
    if (!Number.isInteger(j.pid) || (j.pid as number) <= 1 || typeof j.start !== "string" || typeof j.run_id !== "string" || !Array.isArray(j.argv)) return null;
    return { pid: j.pid as number, start: j.start, argv: j.argv.map(String), run_id: j.run_id };
  } catch { return null; }
}

/** All three checks must hold: the file belongs to this run, the pid is alive, and its live start time equals the recorded one. */
export function verifyRunPid(runDir: string, runId: string, startOf: (pid: number) => string | null = processStartTime): Verified {
  const rec = readRunPid(runDir);
  if (!rec) return { ok: false, reason: "no run.pid for this run (it is not running, or it was started before run control existed)" };
  if (rec.run_id !== runId) return { ok: false, reason: "run.pid belongs to a different run" };
  if (rec.pid === process.pid) return { ok: false, reason: "refusing to signal the calling process" };
  const live = startOf(rec.pid);
  if (live === null) return { ok: false, reason: "the recorded process is no longer running (stale run.pid)" };
  if (live !== rec.start) return { ok: false, reason: "the pid now belongs to a different process (start time differs)" };
  return { ok: true, pid: rec.pid };
}
