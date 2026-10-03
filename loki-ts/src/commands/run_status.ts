// CLI-MODERN-2: `loki status` on the Loki 10 engine. Reads only .loki/runs/<id>/events.jsonl (the
// engine's own record), never STATUS.txt or any legacy state.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverControlUrl } from "../../../packages/control-plane/src/shipper/discover.ts";
import { fold, readEvents } from "../engine10/events.ts";
import { formatDuration } from "../engine10/output.ts";
import type { EventEnvelope } from "../engine10/types.ts";

export const NO_RUN_HINT = "No Loki 10 runs here yet. Start one with: loki \"<task>\" or loki owner/repo#N";
const STALE_S = 30 * 60;
const TERMINAL = new Set(["stage.completed", "stage.failed", "stage.skipped"]);

export interface ModernStatus {
  engine: "loki10";
  run_id: string | null;
  ref: string | null;
  stage: string | null;
  elapsed_s: number | null;
  cost_usd: number | null;
  outcome: string | null;
  pr_url: string | null;
  receipt_path: string | null;
  control_plane_url: string | null;
}

export function runsRoot(env: NodeJS.ProcessEnv, repoDir: string): string {
  return env.LOKI_DIR ? join(resolve(repoDir, env.LOKI_DIR), "runs") : join(repoDir, ".loki", "runs");
}

function listRuns(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

const lastTs = (ev: EventEnvelope[]): number => (ev.length ? Date.parse(ev[ev.length - 1]!.ts) : 0);

/** Pure: the status record for one run's events. */
export function summarize(runId: string, events: EventEnvelope[], root: string, nowMs: number): Omit<ModernStatus, "control_plane_url"> {
  const f = fold(events);
  const done = f.run.completed !== null;
  const startMs = f.run.started ? Date.parse(f.run.started.ts) : (events[0] ? Date.parse(events[0].ts) : nowMs);
  const endMs = f.run.completed ? Date.parse(f.run.completed.ts) : nowMs;
  const open = new Set<string>();
  for (const e of events) {
    if (e.stage === null) continue;
    if (e.type === "stage.started") open.add(e.stage);
    else if (TERMINAL.has(e.type)) open.delete(e.stage);
  }
  const issue = f.run.started?.data.issue_ref;
  const pr = events.findLast((e) => e.type === "pr.opened")?.data.url ?? f.run.completed?.data.pr_url;
  const sealed = events.findLast((e) => e.type === "receipt.sealed")?.data.path;
  const receipt = join(root, runId, "receipt.json");
  const stale = !done && nowMs - lastTs(events) > STALE_S * 1000;
  return {
    engine: "loki10",
    run_id: runId,
    ref: typeof issue === "string" && issue ? issue : null,
    stage: !done && open.size ? [...open].sort().join("+") : null,
    elapsed_s: Math.max(0, (endMs - startMs) / 1000),
    cost_usd: f.cost.usd,
    outcome: f.run.verdict ?? (done ? "completed" : stale ? "stalled (no events for 30m+)" : "running"),
    pr_url: typeof pr === "string" && pr ? pr : null,
    receipt_path: typeof sealed === "string" && sealed ? sealed : existsSync(receipt) ? receipt : null,
  };
}

/** The live run if one is recent, else the newest run; null when there are none. */
export function pickRun(root: string, nowMs: number): { id: string; events: EventEnvelope[] } | null {
  const ids = listRuns(root).reverse();
  let newest: { id: string; events: EventEnvelope[] } | null = null;
  for (const id of ids) {
    const events = readEvents(join(root, id, "events.jsonl"));
    if (events.length === 0) continue;
    newest ??= { id, events };
    if (!events.some((e) => e.type === "run.completed") && nowMs - lastTs(events) <= STALE_S * 1000) return { id, events };
  }
  return newest;
}

export function render(s: ModernStatus): string {
  const cost = s.cost_usd === null ? "cost not measured" : `$${s.cost_usd.toFixed(2)}`;
  const lines = [
    `Loki 10 run ${s.run_id}: ${s.outcome}${s.stage ? `, ${s.stage}` : ""}`,
    `  ${s.ref ?? "text task"}, ${formatDuration(s.elapsed_s ?? 0)} elapsed, ${cost}`,
    `  PR: ${s.pr_url ?? "none"}, receipt: ${s.receipt_path ?? "not sealed yet"}`,
  ];
  if (s.control_plane_url) lines.push(`  Control Plane: ${s.control_plane_url}`);
  return lines.join("\n");
}

export async function runModernStatus(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let json = false;
  let wanted: string | null = null;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (!a.startsWith("-") && wanted === null) wanted = a;
    else if (a === "--help" || a === "-h") { process.stdout.write("Usage: loki status [run-id] [--json]\n  Shows the current or latest Loki 10 run.\n"); return 0; }
    else { process.stderr.write(`loki status: unknown flag ${a}\nUsage: loki status [--json]\n`); return 1; }
  }
  const repoDir = env.LOKI_E10_REPO_DIR ?? process.cwd();
  const root = runsRoot(env, repoDir);
  const now = Date.now();
  let hit = pickRun(root, now);
  if (wanted !== null) {
    const events = readEvents(join(root, wanted, "events.jsonl"));
    if (events.length === 0) { process.stderr.write(`loki status: no events for run ${wanted}\n`); return 1; }
    hit = { id: wanted, events };
  }
  let cp: string | null = null;
  try { cp = await discoverControlUrl(env); } catch { cp = null; }
  if (!hit) {
    process.stdout.write(json
      ? `${JSON.stringify({ engine: "loki10", run_id: null, ref: null, stage: null, elapsed_s: null, cost_usd: null, outcome: null, pr_url: null, receipt_path: null, control_plane_url: cp, hint: NO_RUN_HINT })}\n`
      : `${NO_RUN_HINT}\n`);
    return 0;
  }
  const s: ModernStatus = { ...summarize(hit.id, hit.events, root, now), control_plane_url: cp };
  process.stdout.write(json ? `${JSON.stringify(s)}\n` : `${render(s)}\n`);
  return 0;
}
