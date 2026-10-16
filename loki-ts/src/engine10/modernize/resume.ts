// loki-ts/src/engine10/modernize/resume.ts -- M-22: unit-level resume after a coordinator crash
// (docs/v10/MODERNIZE.md sections 3.7 and 5, D30). Everything is recovered by folding the modernize
// log (the only durable record). Units with unit.completed or unit.not_proven are skipped; a unit
// that started but never finished resumes through its recorded run id (E-39, `loki --resume`) or
// restarts cleanly; a unit that never started is dispatched fresh. A merge that landed before the
// coordinator wrote unit.completed is adopted, never repeated. A corrupt log or plan.json fails
// closed with a reason: the append-side reader (events.ts readEvents) silently skips bad lines,
// which is right for append but wrong for deciding what NOT to run again.
import { existsSync, readFileSync } from "node:fs";
import type { EventEnvelope } from "../types.ts";
import { validateEnvelope } from "../events.ts";
import type { ClusterResult } from "./cluster.ts";
import { mergeOnce, schedule } from "./scheduler.ts";
import type { ScheduleReport, SchedulerOpts } from "./scheduler.ts";
import { modernizeEventsPath, planPath } from "./types.ts";

export interface InFlightUnit {
  unit: string;
  /** The engine10 run id stamped on unit.started, when the attempt had one. */
  runId: string | null;
  model: string | null;
  variant: number | null;
}
export interface ResumeState {
  completed: Set<string>;
  notProven: Set<string>;
  inFlight: Map<string, InFlightUnit>;
  lastSeq: number;
}
export type ResumeLoad = { ok: true; state: ResumeState } | { ok: false; reason: string };

const unitOf = (e: EventEnvelope): string | null => (typeof e.data.unit === "string" && e.data.unit !== "" ? e.data.unit : null);

/** Strict read: a torn LAST line (crash mid-append) is tolerated; any other bad line, a foreign run id or a
 *  non-increasing seq refuses the resume. */
export function loadResumeState(repoDir: string, mid: string): ResumeLoad {
  const path = modernizeEventsPath(repoDir, mid);
  if (!existsSync(path)) return { ok: false, reason: `no modernize log at ${path}` };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, reason: `modernize log unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const pj = planPath(repoDir, mid);
  if (existsSync(pj)) {
    try {
      JSON.parse(readFileSync(pj, "utf8"));
    } catch {
      return { ok: false, reason: `plan.json is corrupt or partial: ${pj}` };
    }
  }
  const lines = text.split("\n");
  const tornTail = !text.endsWith("\n");
  const events: EventEnvelope[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const last = i === lines.length - 1;
    let x: unknown;
    try {
      x = JSON.parse(line);
    } catch {
      if (last && tornTail) continue;
      return { ok: false, reason: `modernize log line ${i + 1} is not valid JSON` };
    }
    const bad = validateEnvelope(x);
    if (bad !== null) {
      if (last && tornTail) continue;
      return { ok: false, reason: `modernize log line ${i + 1} is invalid: ${bad}` };
    }
    const e = x as EventEnvelope;
    if (e.run !== mid) return { ok: false, reason: `modernize log line ${i + 1} belongs to run ${e.run}, not ${mid}` };
    const prev = events[events.length - 1];
    if (prev && e.seq <= prev.seq) return { ok: false, reason: `modernize log line ${i + 1} seq ${e.seq} does not follow ${prev.seq}` };
    events.push(e);
  }
  const state: ResumeState = { completed: new Set(), notProven: new Set(), inFlight: new Map(), lastSeq: -1 };
  for (const e of events) {
    state.lastSeq = e.seq;
    const id = unitOf(e);
    if (id === null) continue;
    if (e.type === "unit.completed") {
      state.completed.add(id);
      state.inFlight.delete(id);
    } else if (e.type === "unit.not_proven") {
      state.notProven.add(id);
      state.inFlight.delete(id);
    } else if (e.type === "unit.started" && !state.completed.has(id) && !state.notProven.has(id)) {
      state.inFlight.set(id, {
        unit: id,
        runId: typeof e.data.run_id === "string" && e.data.run_id !== "" ? e.data.run_id : null,
        model: typeof e.data.model === "string" ? e.data.model : null,
        variant: typeof e.data.variant === "number" ? e.data.variant : null,
      });
    }
  }
  return { ok: true, state };
}

export type ResumeAction =
  | { unit: string; action: "resume"; runId: string }
  | { unit: string; action: "restart" }
  | { unit: string; action: "fresh" };
export interface ResumePlan {
  /** Units not dispatched again (completed or not proven). */
  skipped: string[];
  actions: ResumeAction[];
  /** The input plan with skipped units removed; wave order is kept, empty waves are dropped. */
  plan: ClusterResult;
}

export function planResume(plan: ClusterResult, state: ResumeState): ResumePlan {
  const skipped: string[] = [];
  const actions: ResumeAction[] = [];
  const waves: string[][] = [];
  for (const ids of plan.waves) {
    const keep: string[] = [];
    for (const id of ids) {
      if (state.completed.has(id) || state.notProven.has(id)) {
        skipped.push(id);
        continue;
      }
      const f = state.inFlight.get(id);
      actions.push(f ? (f.runId ? { unit: id, action: "resume", runId: f.runId } : { unit: id, action: "restart" }) : { unit: id, action: "fresh" });
      keep.push(id);
    }
    if (keep.length > 0) waves.push(keep);
  }
  const dropped = new Set(skipped);
  return { skipped, actions, plan: { ...plan, units: plan.units.filter((x) => !dropped.has(x.id)), waves } };
}

export { mergeOnce } from "./scheduler.ts";
export type { MergeOps, MergeResult } from "./scheduler.ts";

export type ResumeRun = { ok: true; skipped: string[]; actions: ResumeAction[]; report: ScheduleReport } | { ok: false; reason: string };

/** Loads state (failing closed), adopts any unit whose merge landed before its unit.completed write, then runs the
 *  scheduler over the units still owed. In-flight units that logged a run id resume through it (the scheduler reattaches
 *  the worktree or logs unit.resume_fallback). opts.log is a fresh writer, which continues seq from the file's max. */
export async function resumeSchedule(plan: ClusterResult, opts: SchedulerOpts): Promise<ResumeRun> {
  const loaded = loadResumeState(opts.repoDir, opts.mid);
  if (!loaded.ok) return loaded;
  const state = loaded.state;
  if (opts.merge) {
    for (const id of [...state.inFlight.keys()]) {
      if (mergeOnce(id, opts.merge, opts.log, state.completed) === "adopted") {
        state.completed.add(id);
        state.inFlight.delete(id);
      }
    }
  }
  const rp = planResume(plan, state);
  const resumeRuns = new Map<string, string>();
  for (const a of rp.actions) if (a.action === "resume") resumeRuns.set(a.unit, a.runId);
  const report = await schedule(rp.plan, { ...opts, completed: state.completed, resumeRuns });
  return { ok: true, skipped: rp.skipped, actions: rp.actions, report };
}
