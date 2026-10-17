// P12-10: pause / resume / cancel requests for a Loki 10 run. `loki pause|resume|cancel` write one small request file in the
// run dir; the engine reads it at stage boundaries only (never mid-stage). A cancel records cancel_requested then
// cancel_effective. An unknown or malformed request is ignored. No existing module owns run-control requests (grepped src/).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RUN_CONTROL_FILE = "control-request.json";
export type RunControlAction = "pause" | "resume" | "cancel";
const ACTIONS: ReadonlySet<string> = new Set(["pause", "resume", "cancel"]);

/** Atomic write (tmp + rename) so the engine never reads a half-written request. */
export function writeRunControl(runDir: string, action: RunControlAction, ts: number = Date.now()): void {
  const p = join(runDir, RUN_CONTROL_FILE), tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ action, ts }));
  renameSync(tmp, p);
}

/** The pending request, or null when absent, unreadable or not a known action. */
export function readRunControl(runDir: string): RunControlAction | null {
  const p = join(runDir, RUN_CONTROL_FILE);
  if (!existsSync(p)) return null;
  try {
    const a = (JSON.parse(readFileSync(p, "utf8")) as { action?: unknown }).action;
    return typeof a === "string" && ACTIONS.has(a) ? (a as RunControlAction) : null;
  } catch { return null; }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const PAUSE_TIMEOUT_DEFAULT_S = 3600;
const PARENT_PID = process.ppid;
/** True while the process that started this worker is still the parent and alive; a dead supervisor must not leave a paused worker polling forever. */
function parentAlive(): boolean {
  if (process.ppid !== PARENT_PID) return false;
  try { process.kill(PARENT_PID, 0); return true; } catch { return false; }
}
export interface BoundaryOpts { sleep?: () => Promise<void>; alive?: () => boolean; timeoutMs?: number; now?: () => number }
/** Pause timeout in ms: LOKI_PAUSE_TIMEOUT_S (seconds, 0 = unlimited), default one hour. */
export function pauseTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LOKI_PAUSE_TIMEOUT_S, n = Number(raw);
  const ok = raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0;
  if (!ok && raw !== undefined && raw !== "" && !pauseTimeoutWarned.has(raw)) {
    pauseTimeoutWarned.add(raw);
    process.stderr.write(`loki: LOKI_PAUSE_TIMEOUT_S="${raw}" is not a non-negative number of seconds; using the default ${PAUSE_TIMEOUT_DEFAULT_S}s\n`);
  }
  return (ok ? n : PAUSE_TIMEOUT_DEFAULT_S) * 1000;
}
const pauseTimeoutWarned = new Set<string>();

/** Called at a stage boundary. Blocks while paused; returns true when the run must stop (cancel, or a pause that outlived its timeout or its run), emitting the lifecycle events in order. */
export async function runControlBoundary(runDir: string, emit: (type: string, data?: Record<string, unknown>) => void, o: BoundaryOpts | (() => Promise<void>) = {}): Promise<boolean> {
  const opts: BoundaryOpts = typeof o === "function" ? { sleep: o } : o;
  const sleep = opts.sleep ?? (() => wait(1000)), alive = opts.alive ?? parentAlive, now = opts.now ?? Date.now, limit = opts.timeoutMs ?? pauseTimeoutMs();
  const t0 = now();
  let a = readRunControl(runDir), abandoned: "timeout_abandon" | "owner_gone" | null = null;
  while (a === "pause") {
    if (!alive()) { abandoned = "owner_gone"; break; }
    if (limit > 0 && now() - t0 >= limit) { abandoned = "timeout_abandon"; break; }
    await sleep(); a = readRunControl(runDir);
  }
  if (a !== "cancel" && !abandoned) return false;
  const data = abandoned ? { reason: abandoned } : undefined; // abandoned pause is distinct from a user cancel
  emit("cancel_requested", data); emit("cancel_effective", data);
  return true;
}
