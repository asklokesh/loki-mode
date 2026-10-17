// CLI-MODERN-2: `loki status` on the Loki 10 engine. Reads only .loki/runs/<id>/events.jsonl (the
// engine's own record), never STATUS.txt or any legacy state.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverControlUrl } from "../../../packages/control-plane/src/shipper/discover.ts";
import { fold, readEvents } from "../engine10/events.ts";
import { formatDuration } from "../engine10/output.ts";
import type { EventEnvelope } from "../engine10/types.ts";
import { STALE_S, controlRunLink, workItemBlockers, workItemId, workItemState, type WorkItemState } from "../util/run_outputs.ts";
import { readRunControl, writeRunControl, type RunControlAction } from "../util/run_control.ts";
import { INTENT_ANSWER_FILE, renderIntent } from "../util/intent_card.ts";

export const NO_RUN_HINT = "No Loki 10 runs here yet. Start one with: loki \"<task>\" or loki owner/repo#N";
const TERMINAL = new Set(["stage.completed", "stage.failed", "stage.skipped"]);

export interface ModernStatus {
  engine: "loki10";
  run_id: string | null;
  ref: string | null;
  state: WorkItemState;
  work_item_id: string | null;
  blockers: string[];
  stage: string | null;
  elapsed_s: number | null;
  cost_usd: number | null;
  outcome: string | null;
  pr_url: string | null;
  receipt_path: string | null;
  control_plane_url: string | null;
  last_event_ago_s: number | null;
  last_event_seq: number | null;
  control_plane_run_url?: string | null;
}

export function runsRoot(env: NodeJS.ProcessEnv, repoDir: string): string {
  return env.LOKI_DIR ? join(resolve(repoDir, env.LOKI_DIR), "runs") : join(repoDir, ".loki", "runs");
}

/** Run ids under a runs root, sorted. Ids embed a sortable UTC timestamp (e10-<ISO-ish>-<rand>), so the last is the newest. */
export function listRunIds(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export function latestRunId(root: string): string | null {
  const ids = listRunIds(root);
  return ids.length ? ids[ids.length - 1]! : null;
}

export function eventsPath(root: string, runId: string): string {
  return join(root, runId, "events.jsonl");
}

const lastTs = (ev: EventEnvelope[]): number => (ev.length ? Date.parse(ev[ev.length - 1]!.ts) : 0);

/** Pure: the status record for one run's events. */
export function summarize(runId: string, events: EventEnvelope[], root: string, nowMs: number): Omit<ModernStatus, "control_plane_url" | "control_plane_run_url"> {
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
  const state = workItemState(events, nowMs);
  return {
    engine: "loki10",
    run_id: runId,
    ref: typeof issue === "string" && issue ? issue : null,
    state,
    work_item_id: workItemId(events),
    blockers: workItemBlockers(events),
    stage: !done && open.size ? [...open].sort().join("+") : null,
    elapsed_s: Math.max(0, (endMs - startMs) / 1000),
    cost_usd: f.cost.usd,
    outcome: state === "cancelled" ? "cancelled" : f.run.verdict ?? (done ? "completed" : state === "stalled" ? "stalled (no events for 30m+)" : "running"),
    pr_url: typeof pr === "string" && pr ? pr : null,
    last_event_ago_s: events.length && Number.isFinite(lastTs(events)) ? Math.max(0, Math.round((nowMs - lastTs(events)) / 1000)) : null,
    last_event_seq: events.length ? events[events.length - 1]!.seq : null,
    receipt_path: typeof sealed === "string" && sealed ? sealed : existsSync(receipt) ? receipt : null,
  };
}

/** The live run if one is recent, else the newest run; null when there are none. */
export function pickRun(root: string, nowMs: number): { id: string; events: EventEnvelope[] } | null {
  const ids = listRunIds(root).reverse();
  let newest: { id: string; events: EventEnvelope[] } | null = null;
  for (const id of ids) {
    const events = readEvents(eventsPath(root, id));
    if (events.length === 0) continue;
    newest ??= { id, events };
    if (!events.some((e) => e.type === "run.completed") && nowMs - lastTs(events) <= STALE_S * 1000) return { id, events };
  }
  return newest;
}

export function render(s: ModernStatus): string {
  const cost = s.cost_usd === null ? "cost not measured" : `$${s.cost_usd.toFixed(2)}`;
  const lines = [
    `Loki 10 run ${s.run_id}: ${s.state}${s.outcome !== null && s.outcome !== s.state && /^[A-Z_]+$/.test(s.outcome) ? ` (${s.outcome})` : ""}${s.stage ? `, ${s.stage}` : ""}`,
    `  ${s.ref ?? "text task"}, ${formatDuration(s.elapsed_s ?? 0)} elapsed, ${cost}`,
    `  PR: ${s.pr_url ?? "none"}, receipt: ${s.receipt_path ?? "not sealed yet"}`,
  ];
  if (s.last_event_seq !== null && s.last_event_ago_s !== null) lines.push(`  last event ${s.last_event_ago_s}s ago (seq ${s.last_event_seq})`);
  if (s.blockers.length) lines.push(`  Blockers: ${s.blockers.join("; ")}`);
  if (s.control_plane_url) lines.push(`  Control Plane: ${s.control_plane_url}`);
  if (s.control_plane_run_url) lines.push(`  Control Plane run: ${s.control_plane_run_url}`);
  return lines.join("\n");
}

const CONTROL_DEFAULT_PORT = 47821; // mirrors commands/control.ts DEFAULT_PORT

/** Fallback when instance.json is missing or stale (a CP started outside `loki control serve`): probe the configured loopback port and accept it only if /health says loki-control. */
async function probeConfiguredControl(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env.LOKI_CONTROL === "0") return null;
  const port = env.LOKI_CONTROL_PORT || String(CONTROL_DEFAULT_PORT);
  if (!/^\d+$/.test(port)) return null;
  const url = `http://127.0.0.1:${port}`;
  try {
    const h = (await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(300) })).json()) as { service?: string };
    return h.service === "loki-control" ? url : null;
  } catch { return null; }
}

export async function runModernStatus(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.includes("--badge")) return (await import("./status.ts")).runStatus(["--badge"]);
  if (argv.includes("--probe")) return (await import("./status.ts")).runStatus(["--probe"]);
  let json = false;
  let wanted: string | null = null;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (!a.startsWith("-") && wanted === null) wanted = a;
    else if (a === "--help" || a === "-h") { process.stdout.write("Usage: loki status [run-id] [--json|--badge|--probe]\n  Shows the current or latest Loki 10 run.\n"); return 0; }
    else { process.stderr.write(`loki status: unknown flag ${a}\nUsage: loki status [--json]\n`); return 1; }
  }
  const repoDir = env.LOKI_E10_REPO_DIR ?? process.cwd();
  const root = runsRoot(env, repoDir);
  const now = Date.now();
  let hit = pickRun(root, now);
  if (wanted !== null) {
    const events = readEvents(eventsPath(root, wanted));
    if (events.length === 0) { process.stderr.write(`loki status: no events for run ${wanted}\n`); return 1; }
    hit = { id: wanted, events };
  }
  let cp: string | null = null;
  try { cp = await discoverControlUrl(env); } catch { cp = null; }
  if (cp === null) cp = await probeConfiguredControl(env);
  if (!hit) {
    process.stdout.write(json
      ? `${JSON.stringify({ engine: "loki10", run_id: null, ref: null, state: null, stage: null, elapsed_s: null, cost_usd: null, outcome: null, pr_url: null, receipt_path: null, control_plane_url: cp, last_event_ago_s: null, last_event_seq: null, control_plane_run_url: null, hint: NO_RUN_HINT })}\n`
      : `${NO_RUN_HINT}\n${cp ? `  Control Plane: ${cp}\n` : ""}`);
    return 0;
  }
  const s: ModernStatus = { ...summarize(hit.id, hit.events, root, now), control_plane_url: cp, control_plane_run_url: controlRunLink(cp, repoDir, hit.id) };
  process.stdout.write(json ? `${JSON.stringify(s)}\n` : `${render(s)}\n`);
  return 0;
}

/** `loki intent show <run>`: read-only view of a past run's intent card and the user's answer. */
export async function runIntentShow(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [sub, id] = argv;
  if (sub !== "show" || !id) { process.stderr.write("Usage: loki intent show <run-id>\n"); return 1; }
  const root = runsRoot(env, env.LOKI_E10_REPO_DIR ?? process.cwd());
  const events = readEvents(eventsPath(root, id));
  if (events.length === 0) { process.stderr.write(`loki intent: no such run ${id}\n`); return 1; }
  const plan = [...events].reverse().find((e) => e.type === "stage.completed" && e.stage === "plan");
  const raw = plan?.data.intent_card;
  const card = Array.isArray(raw) ? raw.map(String) : null;
  const lines = [renderIntent(card)];
  if (card) {
    try {
      const ans = readFileSync(join(root, id, INTENT_ANSWER_FILE), "utf8").trim();
      if (ans) lines.push(`answered: ${ans}`);
    } catch { /* no answer recorded */ }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/** `loki pause|resume|cancel`: writes the request into the newest run dir; the engine acts at the next stage boundary (P12-10).
 * A finished run takes no request, and resume needs a pending pause, so the bash CLI can fall through to the legacy session verbs. */
export function runControlVerb(verb: RunControlAction, env: NodeJS.ProcessEnv = process.env, repoDir: string = env.LOKI_E10_REPO_DIR ?? process.cwd()): number {
  const root = runsRoot(env, repoDir), id = latestRunId(root);
  if (id === null) { process.stderr.write(`loki ${verb}: ${NO_RUN_HINT}\n`); return 1; }
  if (readEvents(eventsPath(root, id)).some((e) => e.type === "run.completed")) { process.stderr.write(`loki ${verb}: run ${id} already finished; nothing to ${verb}\n`); return 1; }
  if (verb === "resume" && readRunControl(join(root, id)) !== "pause") { process.stderr.write(`loki resume: run ${id} is not paused\n`); return 1; }
  writeRunControl(join(root, id), verb);
  process.stdout.write(`${verb} requested for run ${id}; it takes effect at the next stage boundary\n`);
  return 0;
}
