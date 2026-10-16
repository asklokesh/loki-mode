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

/** Called at a stage boundary. Blocks while paused; returns true when the run must stop (cancel), emitting the lifecycle events in order. */
export async function runControlBoundary(runDir: string, emit: (type: string) => void, sleep: () => Promise<void> = () => wait(1000)): Promise<boolean> {
  let a = readRunControl(runDir);
  while (a === "pause") { await sleep(); a = readRunControl(runDir); }
  if (a !== "cancel") return false;
  emit("cancel_requested"); emit("cancel_effective");
  return true;
}
