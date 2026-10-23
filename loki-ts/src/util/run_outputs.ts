// L7 shared contract: the single typed source for every field an output producer (PR body, receipt summary, reports) reads.
// A producer that runs outside the worker (the supervisor opens the PR after the worker exits) has no live stage outputs, so it
// rebuilds them here from the recorded run: the last stage.completed event per stage, then issue.json and plan-output.txt as fallbacks.
// Field map (producer reads -> recorded by):
//   intake.task / intake.title      <- intake stage.completed, else issue.json (title + body)
//   plan.plan / plan.relevant_files <- plan stage.completed, else plan-output.txt
//   verify.changed_files / checks   <- verify stage.completed (the diff and the evidence)
//   wall.files / wall.base_run      <- wall stage.completed
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { conflictReasonOf, fold, partialCost, readEvents } from "../engine10/events.ts";
import { eventsRelPath, readOriginUrl } from "./engine_origin.ts";
import { runOwnerAlive } from "./run_pid.ts";
import { safeGit } from "./safe_git.ts";
import { currentBranch } from "../e10ext/stop_restore.ts";
import type { Outcome } from "../engine10/output.ts";
import { noteOf } from "./base_guard.ts";
import { sourceId } from "../../../packages/control-plane/src/shipper/ship.ts";
import { redactSecrets } from "./redact.ts";
import { readIntentRevisions, type IntentRevision } from "./steer.ts";
import { REPO_ROOT } from "./paths.ts";
import type { EventEnvelope, Verdict } from "../engine10/types.ts";

/** Receipt field (A04): the operator intent revisions this run consumed. Omitted when none so other receipts stay byte-stable. */
export function intentRevisionsBlock(revs: readonly IntentRevision[] | undefined): { intent_revisions?: { rev: number; source: string | null; actor: string | null; sha: string }[] } {
  const r = (revs ?? []).filter((r) => r.unapplied !== true).map(({ rev, source, actor, sha }) => ({ rev, source, actor, sha }));
  return r.length ? { intent_revisions: r } : {};
}

/** Receipt field (TEN-GATES-15): the harness-shipped seeded-defect corpus (benchmarks/seeded-defects, or LOKI_SEEDED_DEFECTS_DIR set by the
 *  operator) and its recorded catch rate. Harness metadata only: it states which corpus backs the ablation gate's calibration, never that a
 *  gate ran in this run. It reads NOTHING under the agent's repoDir, so no file the agent under test can write decides its presence or value.
 *  Present whenever the manifest is readable. corpus_version is the sha256 of the manifest bytes. catch_rate is the worst run's
 *  NOT_SEALED / defects, and only when results/wrong-pass.json measured THIS manifest under the p4 results contract (exactly one top and one
 *  floor run, each with an outcome for every manifest id and no other id, each SEALED or NOT_SEALED); anything else is null. The block sits
 *  in the signed receipt body, so editing any value breaks receipt_sha256 and `loki verify` reports TAMPERED. */
export interface SeededCorpus { corpus_version: string; corpus_defects: number; catch_rate: number | null }
export function seededCorpusBlock(env: NodeJS.ProcessEnv = process.env): { seeded_corpus?: SeededCorpus } {
  const dir = env["LOKI_SEEDED_DEFECTS_DIR"] || join(REPO_ROOT, "benchmarks", "seeded-defects");
  try {
    const bytes = readFileSync(join(dir, "manifest.json")), version = createHash("sha256").update(bytes).digest("hex");
    const ids = ((JSON.parse(bytes.toString("utf8")) as { defects?: { id?: unknown }[] }).defects ?? []).map((d) => d.id);
    let rate: number | null = null;
    try {
      const res = JSON.parse(readFileSync(join(dir, "results", "wrong-pass.json"), "utf8")) as { manifest_sha256?: unknown; runs?: { setup?: unknown; outcomes?: Record<string, unknown> }[] };
      const runs = res.manifest_sha256 === version && Array.isArray(res.runs) ? res.runs : [];
      const complete = (o: Record<string, unknown> | undefined): boolean => !!o && Object.keys(o).length === ids.length && ids.every((id) => typeof id === "string" && (o[id] === "SEALED" || o[id] === "NOT_SEALED"));
      const top = runs.filter((r) => r.setup === "top"), floor = runs.filter((r) => r.setup === "floor");
      if (ids.length > 0 && new Set(ids).size === ids.length && top.length === 1 && floor.length === 1 && [top[0], floor[0]].every((r) => complete(r!.outcomes))) {
        const rates = [top[0]!, floor[0]!].map((r) => ids.filter((id) => r.outcomes![id as string] === "NOT_SEALED").length / ids.length);
        rate = Math.round(Math.min(...rates) * 10000) / 10000;
      }
    } catch { /* no usable results: catch_rate stays null */ }
    return { seeded_corpus: { corpus_version: version, corpus_defects: ids.length, catch_rate: rate } };
  } catch { return {}; }
}

const REVERTED = "unrelated edit reverted:";
export type StageOutputs = Partial<Record<string, Record<string, unknown>>>;

export function outputsFromEvents(events: readonly EventEnvelope[]): StageOutputs {
  const out: StageOutputs = {};
  for (const e of events) if (e.type === "stage.completed" && typeof e.stage === "string") out[e.stage] = e.data;
  return out;
}
function readText(path: string): string | null {
  try { return existsSync(path) ? readFileSync(path, "utf8") : null; } catch { return null; }
}
/** Rebuilds stage outputs for a finished run. Never throws; an absent source stays absent so the producer prints "not recorded". */
export function loadRunOutputs(runDir: string, events: readonly EventEnvelope[]): StageOutputs {
  const out = outputsFromEvents(events);
  // the commit stage reverts unrelated edits (scope_notes "unrelated edit reverted: PATH"); they are not part of the change
  const reverted = new Set(((out["commit"]?.["scope_notes"] as unknown[] | undefined) ?? []).map(String).filter((n) => n.startsWith(REVERTED)).map((n) => n.slice(REVERTED.length).trim()));
  const verify = out["verify"];
  if (verify && Array.isArray(verify["changed_files"]) && reverted.size > 0) out["verify"] = { ...verify, changed_files: (verify["changed_files"] as unknown[]).filter((f) => !reverted.has(String(f))) };
  const intake = { ...(out["intake"] ?? {}) };
  if (typeof intake["task"] !== "string" || !(intake["task"] as string).trim()) {
    const raw = readText(join(runDir, "issue.json"));
    if (raw) {
      try {
        const j = JSON.parse(raw) as { title?: unknown; body?: unknown };
        const title = typeof j.title === "string" ? j.title : "", body = typeof j.body === "string" ? j.body : "";
        const task = [title, body].filter(Boolean).join("\n\n");
        if (task) { intake["task"] = task; if (title && typeof intake["title"] !== "string") intake["title"] = title; }
      } catch { /* unreadable issue.json: leave the field absent */ }
    }
  }
  if (Object.keys(intake).length > 0) out["intake"] = intake;
  const plan = { ...(out["plan"] ?? {}) };
  if (typeof plan["plan"] !== "string" || !(plan["plan"] as string).trim()) {
    const txt = readText(join(runDir, "plan-output.txt"));
    if (txt && txt.trim()) plan["plan"] = txt.trim();
  }
  if (Object.keys(plan).length > 0) out["plan"] = plan;
  return out;
}

/** Work-item state (docs/v10/ENGINE.md "Work-item state"); lives here, not in engine10/events.ts, to keep the core line budget. */
export type WorkItemState =
  | "received" | "prepared" | "planned" | "executing" | "validating" | "ready_to_ship" | "completed"
  | "waiting_for_input" | "budget_stopped" | "failed" | "cancelled" | "stalled"
  | "delivering" | "observing";
export const STALE_S = 30 * 60;

/** The one work-item vocabulary (docs/v10/ENGINE.md "Work-item state"). Pure over the event log. Terminal states come only from run.completed;
 *  `nowMs` (optional) enables "stalled" for an unfinished run with no events for STALE_S. */
export function workItemState(events: readonly EventEnvelope[], nowMs?: number): WorkItemState {
  // delivering = pr.opened (supervisor); observing = the detached post-PR deep verify has started (deep.started, supervisor).
  if (!events.some((e) => e.type === "run.completed") && !(nowMs !== undefined && events.length > 0 && nowMs - Date.parse(events[events.length - 1]!.ts) > STALE_S * 1000) && events.some((e) => e.type === "pr.opened"))
    return events.some((e) => e.type === "deep.started") ? "observing" : "delivering";
  return stageState(events, nowMs);
}

/** Blockers live in their own field, never in the state string. The only blocker the engine writes is an implement spec conflict (stage.completed spec_conflict_reason on a SPEC_CONFLICT run). */
export function workItemBlockers(events: readonly EventEnvelope[]): string[] {
  if (events.findLast((e) => e.type === "run.completed")?.data["verdict"] !== "SPEC_CONFLICT") return [];
  const why = conflictReasonOf(events);
  return [`spec_conflict: ${typeof why === "string" && why ? why.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 500) : "unspecified"}`];
}

/** One work item spans runs: keyed by the issue ref on run.started; null for a text task. */
export function workItemId(events: readonly EventEnvelope[]): string | null {
  const d = events.find((e) => e.type === "run.started")?.data ?? {};
  const k = d["issue_ref"];
  return typeof k === "string" && k ? k : null;
}

function stageState(events: readonly EventEnvelope[], nowMs?: number): WorkItemState {
  const done = events.findLast((e) => e.type === "run.completed");
  if (done) {
    const v = done.data.verdict;
    if (done.data.cancelled === true) return "cancelled";
    if (v === "SPEC_CONFLICT") return "waiting_for_input";
    if (v === "FAILED" || v === "PARTIAL") return events.some((e) => e.type === "cap.hit") ? "budget_stopped" : v === "FAILED" ? "failed" : "completed";
    return "completed";
  }
  if (nowMs !== undefined && events.length > 0 && nowMs - Date.parse(events[events.length - 1]!.ts) > STALE_S * 1000) return "stalled";
  const seen = new Set<string>(), finished = new Set<string>();
  for (const e of events) {
    if (e.stage === null) continue;
    seen.add(e.stage);
    if (e.type === "stage.completed") finished.add(e.stage);
  }
  if (events.some((e) => e.type === "receipt.sealed")) return "ready_to_ship";
  if (finished.has("implement") || ["verify", "fix", "commit", "seal", "pr", "deep"].some((s) => seen.has(s))) return "validating";
  if (seen.has("implement")) return "executing";
  if (finished.has("plan") || seen.has("wall")) return "planned";
  if (finished.has("intake")) return "prepared";
  return "received";
}

// RECOVERY: find an interrupted engine10 run, name the phase it died in, and resume the publish phase without
// duplicating a side effect (design: docs/v10/ENGINE.md "Recovery of an interrupted run").
export type Phase = "implement" | "verify" | "publish" | "done";

/** RECOVERY: which phase an event log stopped in. "done" means nothing is left to resume. */
export function phaseOf(events: readonly EventEnvelope[]): Phase {
  if (events.some((e) => e.type === "pr.opened")) return "done";
  const s = stageState(events);
  if (s === "ready_to_ship") return "publish";
  if (s === "validating") return "verify";
  return s === "received" || s === "prepared" || s === "planned" || s === "executing" ? "implement" : "done";
}

export interface Interrupted { runId: string; phase: Phase; events: EventEnvelope[]; task: string | null }

function taskOf(events: readonly EventEnvelope[]): string | null {
  const t = events.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data["task"];
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

/** Latest run (by events.jsonl mtime) that stopped before completing and has no live owner; null when none. */
export function findInterrupted(repoDir: string, runId?: string): Interrupted | null {
  const root = join(repoDir, ".loki", "runs");
  let ids: string[] = [];
  try { ids = runId ? [runId] : readdirSync(root); } catch { return null; }
  const rows = ids.filter((id) => /^e10-[A-Za-z0-9-]+$/.test(id) && existsSync(join(repoDir, eventsRelPath(id))))
    .map((id) => ({ id, m: statSync(join(repoDir, eventsRelPath(id))).mtimeMs })).sort((a, b) => b.m - a.m);
  const top = rows[0];
  if (!top) return null;
  const events = readEvents(join(repoDir, eventsRelPath(top.id)));
  const phase = phaseOf(events);
  if (phase === "done" || runOwnerAlive(join(root, top.id)) || events.length === 0) return null;
  return { runId: top.id, phase, events, task: taskOf(events) };
}

// P12-07: per-stage checkpoints and the resume point. The append-only event log is the durable checkpoint store; a checkpoint is the
// last stage.completed per stage with a sha of its inputs (earlier stages' outputs) and of its own outputs. Resume fails closed.
export const STAGE_ORDER = ["intake", "plan", "wall", "implement", "verify", "commit", "seal", "pr"] as const;
export interface Checkpoint { stage: string; seq: number; inputs_sha: string; outputs_sha: string }
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v) ?? "null").digest("hex");
const settled = (events: readonly EventEnvelope[], s: string): boolean => events.some((e) => e.stage === s && (e.type === "stage.completed" || e.type === "stage.skipped"));

/** One checkpoint per completed stage, in flow order; inputs_sha covers every earlier stage's recorded outputs. */
export function stageCheckpoints(events: readonly EventEnvelope[]): Checkpoint[] {
  const last = new Map<string, EventEnvelope>();
  for (const e of events) if (e.type === "stage.completed" && typeof e.stage === "string") last.set(e.stage, e);
  const out: Checkpoint[] = [], prior: unknown[] = [];
  for (const s of STAGE_ORDER) {
    const e = last.get(s);
    if (!e) continue;
    out.push({ stage: s, seq: e.seq, inputs_sha: sha(prior), outputs_sha: sha(e.data) });
    prior.push([s, e.data]);
  }
  return out;
}

/** First flow stage with no stage.completed (or stage.skipped, unless completedOnly); null when every stage settled. Pure and lenient (handoff text only). */
export function firstIncompleteStage(events: readonly EventEnvelope[], completedOnly = false): string | null {
  return STAGE_ORDER.find((s) => !(completedOnly ? events.some((e) => e.stage === s && e.type === "stage.completed") : settled(events, s))) ?? null;
}

export type ResumePoint = { ok: true; stage: string; skip: string[]; checkpoints: Checkpoint[]; intentRevisions: IntentRevision[]; timeline: { stage: "wall"; startMs: number; endMs: number }[] } | { ok: false; reason: string };

/** The stage a resumed run re-enters at. Fail closed: a torn or unreadable log, a seq gap, a finished run, a mixed run id or a stage
 *  recorded as done while an earlier one never settled all refuse. rawLog (the file text) lets a corrupt line be detected. */
export function resumePoint(events: readonly EventEnvelope[], rawLog?: string): ResumePoint {
  if (rawLog !== undefined) {
    const lines = rawLog.split("\n").filter((l) => l.trim() !== "");
    if (lines.length !== events.length) return { ok: false, reason: `event log is torn or corrupt (${lines.length - events.length} unreadable line(s))` };
    if (rawLog.length > 0 && !rawLog.endsWith("\n")) return { ok: false, reason: "event log ends in a torn line" };
  }
  if (events.length === 0) return { ok: false, reason: "event log is empty or unreadable" };
  if (events.some((e, i) => e.seq !== i)) return { ok: false, reason: "event log has a sequence gap" };
  if (new Set(events.map((e) => e.run)).size !== 1) return { ok: false, reason: "event log mixes run ids" };
  if (!events.some((e) => e.type === "run.started")) return { ok: false, reason: "no run.started event" };
  if (events.some((e) => e.type === "tamper.detected")) return { ok: false, reason: "event log was flagged as tampered" };
  if (events.some((e) => e.type === "run.completed")) return { ok: false, reason: "run already completed; nothing to resume" };
  const intake = events.findLast((e) => e.type === "stage.completed" && e.stage === "intake");
  if (intake && typeof intake.data["base_sha"] !== "string") return { ok: false, reason: "intake checkpoint has no base_sha" };
  const next = firstIncompleteStage(events);
  if (next === null) return { ok: false, reason: "every stage settled; nothing to resume" };
  const idx = STAGE_ORDER.indexOf(next as (typeof STAGE_ORDER)[number]);
  const par = next === "plan" || next === "wall"; // plan and wall run in parallel (machine.ts FLOW): either may finish first
  const later = STAGE_ORDER.slice(idx + 1).find((s) => !(par && (s === "plan" || s === "wall")) && events.some((e) => e.stage === s && e.type === "stage.completed"));
  if (later) return { ok: false, reason: `stage ${later} completed but ${next} never did` };
  // P12-07d/h: durable late-steer state, seeded into ctx on re-entry (seedResumeCtx). Both inputs are worker-forgeable via ingest, so each rule fails closed.
  const byRev = new Map<number, IntentRevision>(); // union of every intent.revised; on a duplicate rev keep the LATEST at (unapplied wins), so a pre-claimed at:0 cannot displace the honest entry
  for (const e of events) if (e.type === "intent.revised" && Array.isArray(e.data["revisions"])) for (const r of e.data["revisions"] as IntentRevision[]) if (typeof r === "object" && r !== null && Number.isInteger(r.rev) && Number.isFinite(r.at)) { const o = byRev.get(r.rev); if (!o || (r.unapplied === true && o.unapplied !== true) || (o.unapplied !== true && r.at > o.at)) byRev.set(r.rev, r); }
  const intentRevisions = [...byRev.values()].sort((x, y) => x.rev - y.rev);
  const starts = events.filter((e) => e.type === "stage.started" && e.stage === "wall").map((e) => { const m = e.data["start_ms"], seen = Date.parse(e.ts); return typeof m === "number" && Number.isFinite(m) && m >= 0 ? Math.min(m, Number.isFinite(seen) ? seen : 0) : 0; }); // a claimed start is capped at the supervisor's own append time; unknown = 0: every revision stale
  const first = starts.length ? Math.min(...starts) : null, timeline = first === null ? [] : [{ stage: "wall" as const, startMs: first, endMs: first }]; // EARLIEST start only: a later forged start cannot move the freeze point forward
  return { ok: true, stage: next, skip: STAGE_ORDER.slice(0, idx), checkpoints: stageCheckpoints(events), intentRevisions, timeline };
}

/** P12-07h: seeds a re-entered run's ctx with the durable steer state; the machine does `ctx.timeline ??= []`, so a seeded array is used as is. */
export function seedResumeCtx(ctx: { intentRevisions?: IntentRevision[]; timeline?: { stage: "wall"; startMs: number; endMs: number }[] }, rp: Extract<ResumePoint, { ok: true }>): void {
  ctx.intentRevisions = [...rp.intentRevisions]; ctx.timeline = [...rp.timeline];
}

/** P12-07i: the worker-side re-entry. Computes the resume point from the durable log (fail closed), seeds ctx via seedResumeCtx, and returns the
 *  flow without settled stages plus their recorded outputs, so a restored stage never reruns and later stages still see its data. */
export function resumeMachineOpts<F extends string>(ctx: Parameters<typeof seedResumeCtx>[0], events: readonly EventEnvelope[], raw: string | undefined, flow: readonly (F | readonly F[])[]): { ok: true; flow: (F | readonly F[])[]; restored: StageOutputs } | { ok: false; reason: string } {
  const rp = resumePoint(events, raw);
  if (!rp.ok) return rp;
  seedResumeCtx(ctx, rp);
  const done = new Set<string>(STAGE_ORDER.filter((s) => (s === "intake" || s === "plan" || s === "wall" || s === "implement") && settled(events, s))), restored: StageOutputs = {};
  for (const s of done) { const e = events.findLast((x) => x.type === "stage.completed" && x.stage === s); if (e) restored[s] = e.data; }
  // D61-04: a deferred already-done hit lands on intake AFTER its stage.completed was written, so the flag is durable only in the supervisor-written already.attested event (SUPERVISOR_ONLY: a worker line of that type is dropped). It counts only if it precedes implement's stage.completed and no intent.revised follows it (stale evidence). Absent or malformed -> not satisfied (old logs restore as before).
  const hitIdx = events.findLastIndex((x) => x.type === "already.attested" && x.stage === "intake"), hit = hitIdx < 0 ? undefined : events[hitIdx], ev = hit?.data["evidence"];
  const implDone = events.findLastIndex((x) => x.type === "stage.completed" && x.stage === "implement");
  if (restored["intake"] && hit && hit.data["already_satisfied"] === true && Array.isArray(ev) && ev.length > 0 && ev.every((x) => typeof x === "string" && x !== "") && (implDone < 0 || hitIdx < implDone) && !events.slice(hitIdx + 1).some((x) => x.type === "intent.revised")) restored["intake"] = { ...restored["intake"], already_satisfied: true, evidence: ev };
  const kept = flow.map((st) => typeof st === "string" ? (done.has(st) ? [] : st) : st.filter((n) => !done.has(n))).filter((st) => st.length > 0);
  return { ok: true, flow: kept as (F | readonly F[])[], restored };
}

/** `loki start --resume [run-id]`. The publish phase resumes through resumePublish; an earlier phase re-enters the machine at the resume
 *  point under a fresh supervisor (run.resumed, restored stages not rerun). Exit 2 on a refusal: unreadable state is never a success. */
export async function resumeFlag(runId: string | undefined, noPr = false, deps: ResumeDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => { process.stderr.write(s); });
  let repoDir: string;
  try { repoDir = safeGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim(); } catch { out("engine10: --resume: not inside a git repository\n"); return 2; }
  const id = runId && /^e10-[A-Za-z0-9-]+$/.test(runId) ? runId : undefined;
  const it = findInterrupted(repoDir, id);
  if (!it) { out("engine10: --resume: no interrupted engine10 run\n"); return 3; }
  let raw = "";
  try { raw = readFileSync(join(repoDir, eventsRelPath(it.runId)), "utf8"); } catch { out(`engine10: --resume refused: run ${it.runId} event log unreadable\n`); return 2; }
  const rp = resumePoint(it.events, raw);
  if (!rp.ok) { out(`engine10: --resume refused: ${rp.reason}\n`); return 2; }
  { const fc = flagConflict(it.events, deps.flags ?? {}); if (fc) { out(`engine10: --resume refused: ${fc} differs from the crashed run ${it.runId}; drop the flag to resume it as it was\n`); return 2; } }
  if (it.phase === "publish" && noPr) { out("engine10: --resume refused: --no-pr was given and this run is in its publish phase\n"); return 2; }
  if (it.phase === "publish") return resumePublish(repoDir, it, deps);
  out(`engine10: resume from stage ${rp.stage} (settled: ${rp.skip.join(", ") || "none"})\n`);
  const br = `loki/${it.runId}`, origBranch = currentBranch(repoDir), pc = partialCost(it.events), st0 = (it.events.find((e) => e.type === "run.started")?.data ?? {}) as Record<string, unknown>;
  if (it.events.some((e) => e.type === "cap.hit")) { out(`engine10: --resume refused: run ${it.runId} already hit its cost or time cap\n`); return 2; }
  let activeS = 0; for (let i = 1; i < it.events.length; i++) { const g = (Date.parse(it.events[i]!.ts) - Date.parse(it.events[i - 1]!.ts)) / 1000; if (g <= 0) continue; const ev = it.events[i]!; if (g <= 120 || ev.type !== "run.resumed") activeS += g; else { const alive = Date.parse(String(ev.data["last_alive_ts"] ?? "")), since = (alive - Date.parse(it.events[i - 1]!.ts)) / 1000; if (since > 0) activeS += Math.min(since, g); } } // P12-07l: a long gap is downtime only when it ends in run.resumed; a long verify (or any quiet running stage) that ends in its own event counts in full; P12-07n: a gap ending in run.resumed counts up to the supervisor's last heartbeat (last_alive_ts) as active, only the rest as downtime
  const capS = Number(st0["cap_s"]) > 0 ? Number(st0["cap_s"]) - activeS : undefined, ceilS = Number(st0["cap_ceiling_s"]) > 0 ? Number(st0["cap_ceiling_s"]) - activeS : undefined;
  if (capS !== undefined && capS < 60) { out(`engine10: --resume refused: run ${it.runId} has under 60s of its time cap left\n`); return 2; }
  if (rp.skip.includes("intake") && origBranch !== br) {
    const dirty = safeGit(repoDir, ["status", "--porcelain", "--", ".", ":(exclude).loki"]).split("\n").filter(Boolean);
    if (dirty.length) { out(`engine10: --resume refused: ${dirty.length} uncommitted or untracked file(s) in your working tree would ride onto ${br}; commit or stash them first\n`); return 2; }
    try { safeGit(repoDir, ["checkout", "-q", br]); } catch { out(`engine10: --resume refused: cannot switch to run branch ${br}\n`); return 2; }
  }
  const st = (it.events.find((e) => e.type === "run.started")?.data ?? {}) as Record<string, unknown>, capUsd = resumeCapUsd(st["max_cost_usd"], deps.flags?.maxCostUsd), provider = String(st["provider"] ?? "claude"), model = String(st["model"] ?? ""), deep = st["deep"] === true;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(capS !== undefined ? { LOKI_E10_CAP_S: String(Math.floor(capS)) } : {}), ...(pc.usd > 0 ? { LOKI_E10_SPENT_USD: String(pc.usd) } : {}), ...(capUsd !== undefined ? { LOKI_E10_MAX_COST_USD: String(capUsd) } : {}) };
  const runDir = join(repoDir, ".loki", "runs", it.runId), eventsPath = join(repoDir, eventsRelPath(it.runId));
  const pr = noPr ? undefined : async ({ pushEnv, verdict, notProven }: { pushEnv: { _LOKI_PINNED_ORIGIN: string }; verdict: Verdict; notProven: string[] }) => {
    const gate = prGate(repoDir);
    if ("deny" in gate) return { url: null, draft: false, existing: null, notProven: [gate.deny] };
    const evs = readEvents(eventsPath), sealed: Record<string, unknown> = { ...((evs.findLast((e) => e.type === "receipt.sealed")?.data ?? {}) as Record<string, unknown>), not_proven: "note" in gate && gate.note ? [...notProven, gate.note] : notProven }, base = evs.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data["base_sha"];
    const r = await (await import("../engine10/stages/pr.ts")).runPr({ runId: it.runId, repoDir, runDir, branch: br, pinnedOrigin: pushEnv._LOKI_PINNED_ORIGIN, provider, model, baseSha: typeof base === "string" ? base : "", outputs: () => ({ ...loadRunOutputs(runDir, evs), seal: { ...sealed, verdict, receipt_path: sealed["path"] } }), capHit: () => evs.some((e) => e.type === "cap.hit"), draft: gate.draft, emit: () => {} } as never, new AbortController().signal);
    const d = r.data as { pr_url?: string; draft?: boolean; existing?: boolean | null; not_proven?: string[] };
    return r.status !== "completed" ? { url: null, draft: false, existing: null, notProven: [`PR not opened: ${r.reason}`] } : { url: d.pr_url ?? null, draft: d.draft === true, existing: d.existing ?? null, notProven: d.not_proven };
  };
  const supervise = deps.supervise ?? (async (o) => (await import("../engine10/supervisor.ts")).runSupervisor(o));
  const { EXIT } = await import("../engine10/output.ts");
  const res = await supervise({ runId: it.runId, repoDir, env, resume: true, capS: capS === undefined ? undefined : Math.floor(capS), capCeilingS: ceilS === undefined ? undefined : Math.floor(ceilS), restoreBranch: origBranch, workerArgv: [process.execPath, resolve(process.argv[1] ?? ""), "engine10", "worker", it.runId, provider, model, deep ? "deep" : "fast"], started: { ...st, resumed_from: rp.stage }, pr });
  out(`engine10: resumed run ${it.runId}: ${res.outcome}\n`);
  return EXIT[res.outcome];
}

export type RunPrFn = (ctx: Record<string, unknown>, signal: AbortSignal) => Promise<{ status: string; reason?: string; data: Record<string, unknown> }>;
/** The start flags the user typed on this command line (FC-AUTORESUME-DROPS-START-FLAGS). provider is set only when --provider was explicit. */
export interface StartFlags { maxCostUsd?: number | null; provider?: string | null; deep?: boolean; spec?: boolean }
/** The first flag that differs from the crashed run, or null. --spec is not recorded on run.started, so any --spec cannot be shown to match. */
export function flagConflict(events: readonly EventEnvelope[], f: StartFlags): string | null {
  const st = (events.find((e) => e.type === "run.started")?.data ?? {}) as Record<string, unknown>, was = String(st["provider"] ?? "claude");
  if (f.spec) return "--spec (the crashed run's spec is not recorded)";
  if (f.provider && f.provider !== was) return `--provider ${f.provider} (the crashed run used ${was})`;
  if (f.deep && st["deep"] !== true) return "--deep (the crashed run was not deep)";
  return null;
}
/** A resumed run's cap: the crashed run's recorded cap, tightened to --max-cost when given; a given cap never loosens a recorded one. */
export function resumeCapUsd(recorded: unknown, given: number | null | undefined): number | undefined {
  const rec = recorded !== undefined && Number(recorded) >= 0 ? Number(recorded) : undefined;
  return given !== null && given !== undefined && given > 0 ? (rec !== undefined && rec > 0 ? Math.min(rec, given) : given) : rec;
}
export interface ResumeDeps { flags?: StartFlags; runPr?: RunPrFn; out?: (s: string) => void; supervise?: (o: import("../engine10/supervisor.ts").SupervisorOptions) => Promise<{ outcome: Outcome }> }

/** Resumes the publish phase. Reuses the sealed receipt; appends run.resumed, pr.opened and run.completed. */
export async function resumePublish(repoDir: string, it: Interrupted, deps: ResumeDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => { process.stdout.write(s); });
  const runDir = join(repoDir, ".loki", "runs", it.runId);
  const sealedEv = it.events.findLast((e) => e.type === "receipt.sealed");
  const sealedData = (sealedEv?.data ?? {}) as Record<string, unknown>;
  const rawV = sealedData["verdict"], verdict: Verdict = rawV === "VERIFIED" || rawV === "PARTIAL" || rawV === "ALREADY_SATISFIED" || rawV === "SPEC_CONFLICT" ? rawV : "FAILED";
  const started = it.events.find((e) => e.type === "run.started")?.data ?? {};
  const origin = readOriginUrl(repoDir);
  if (!origin) { out("resume: no origin remote; nothing to publish\n"); return 2; }
  const { SupervisorLog } = await import("../engine10/supervisor.ts");
  const gate = prGate(repoDir); // same policy egress as the supervisor pr callback: resume must not bypass autonomy
  if ("deny" in gate) { out(`resume: ${gate.deny}\n`); return 5; }
  const log = new SupervisorLog(join(repoDir, eventsRelPath(it.runId)), it.runId);
  log.append("run.resumed", null, { phase: "publish", receipt_reused: true, receipt_sha256: sealedData["receipt_sha256"] ?? null });
  const notProven = [...(Array.isArray(sealedData["not_proven"]) ? (sealedData["not_proven"] as string[]) : []), "publish phase resumed after an interruption", ...("note" in gate && gate.note ? [gate.note] : [])];
  const runPr = deps.runPr ?? (async (c, s) => (await import("../engine10/stages/pr.ts")).runPr(c as never, s));
  const events = readEvents(log.path);
  const baseSha = it.events.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data["base_sha"];
  const r = await runPr({
    runId: it.runId, repoDir, runDir, branch: `loki/${it.runId}`, pinnedOrigin: origin,
    provider: String(started["provider"] ?? "claude"), model: String(started["model"] ?? ""), baseSha: typeof baseSha === "string" ? baseSha : safeGit(repoDir, ["rev-parse", "HEAD"]).trim(),
    outputs: () => ({ ...loadRunOutputs(runDir, events), seal: { ...sealedData, not_proven: notProven, verdict, receipt_path: sealedData["path"] } }),
    capHit: () => events.some((e) => e.type === "cap.hit"), draft: gate.draft, emit: () => {},
  }, new AbortController().signal);
  const d = r.data as { pr_url?: string; draft?: boolean; existing?: boolean | null };
  if (r.status !== "completed" || !d.pr_url) { out(`resume: publish failed: ${r.reason ?? "no PR url"}\n`); return 5; }
  log.append("pr.opened", "pr", { url: d.pr_url, draft: d.draft === true, existing: d.existing ?? null });
  log.append("run.completed", null, { verdict, pr_url: d.pr_url, not_proven: notProven, resumed: true });
  log.sealLog();
  out(`resumed phase: publish (run ${it.runId}); receipt reused; PR ${d.existing === true ? "reused " : ""}${d.pr_url}\n`);
  return 0;
}

/** Called by `loki start` before it opens a new run. Returns an exit code when it resumed, null to start fresh.
 *  An interrupted run whose recorded task equals this task is resumed (publish phase via resumePublish, any earlier phase via resumeFlag unless LOKI_NO_AUTO_RESUME=1); any other interrupted run is just announced. */
export async function startRecovery(repoDir: string, task: string, noPr: boolean, deps: ResumeDeps = {}): Promise<number | null> {
  if (process.env["LOKI_NO_RESUME"] === "1") return null;
  const it = findInterrupted(repoDir);
  if (!it) return null;
  if (it.phase === "publish" && !noPr && it.task !== null && it.task === task.trim()) return resumePublish(repoDir, it, deps);
  const note = deps.out ?? ((s: string) => { process.stderr.write(s); });
  { const fc = it.phase !== "publish" && it.task !== null && it.task === task.trim() && deps.flags ? flagConflict(it.events, deps.flags) : null;
    if (fc) { note(`not resuming interrupted run ${it.runId}: ${fc} differs from it; starting a new run (LOKI_NO_AUTO_RESUME=1 always starts a new run)\n`); return null; } } // FC-AUTORESUME-DROPS-START-FLAGS
  if (it.phase !== "publish" && it.task !== null && it.task === task.trim() && process.env["LOKI_NO_AUTO_RESUME"] !== "1") { // FC-CRASH-WORK-READ-AS-PREEXISTING: same task after a crash re-enters at the first unsettled stage
    let raw = ""; try { raw = readFileSync(join(repoDir, eventsRelPath(it.runId)), "utf8"); } catch { /* resumePoint refuses an unreadable log below */ }
    const rp = resumePoint(it.events, raw);
    if (rp.ok) {
      note(`resuming interrupted run ${it.runId} from stage ${rp.stage} (LOKI_NO_AUTO_RESUME=1 starts a new run)\n`);
      let refusal = ""; const rc = await resumeFlag(it.runId, noPr, { ...deps, out: (m: string) => { if (/--resume refused/.test(m)) refusal = m; note(m); } });
      if (rc !== 2 || !refusal) return rc;
      note("could not resume; starting a new run.\n"); return null; // a refusal happens before any stage runs, so a new run loses nothing
    }
  }
  note(`note: run ${it.runId} was interrupted in phase ${it.phase}; "loki resume" ${it.phase === "publish" ? "finishes it" : "reports what is preserved"}. Starting a new run.\n`);
  return null;
}

/** `loki resume [run-id]` for engine10 runs. Exit 0 resumed, 3 nothing to resume, 4 phase not auto-resumable, else failure. */
export async function resumeMain(args: string[], deps: ResumeDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => { process.stdout.write(s); });
  let repoDir: string;
  try { repoDir = safeGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim(); } catch { out("resume: not inside a git repository\n"); return 2; }
  const it = findInterrupted(repoDir, args.find((a) => !a.startsWith("-")));
  if (!it) { out("resume: no interrupted engine10 run\n"); return 3; }
  if (it.phase === "publish") return resumePublish(repoDir, it, deps);
  let br = "";
  try { br = safeGit(repoDir, ["rev-parse", "--verify", "-q", `refs/heads/loki/${it.runId}`]).trim(); } catch { /* no run branch */ }
  const base = it.events.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data["base_sha"];
  let ahead = 0; if (br && typeof base === "string") { try { ahead = Number(safeGit(repoDir, ["rev-list", "--count", `${base}..${br}`]).trim()) || 0; } catch { /* unknown: claim nothing */ } }
  let loose: string[] = []; if (ahead === 0) { try { loose = safeGit(repoDir, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).loki"]).split("\n").filter(Boolean).map((l) => l.slice(3)); } catch { /* unreadable tree */ } }
  const where = ahead > 0 ? `work is preserved on branch loki/${it.runId} (${ahead} commit${ahead === 1 ? "" : "s"})` : loose.length > 0 ? `no commits yet; uncommitted files in the working tree: ${loose.slice(0, 10).join(", ")}${loose.length > 10 ? ` (+${loose.length - 10} more)` : ""}` : br ? "no work was written" : "no run branch was created"; // FC-CRASH-WORK-READ-AS-PREEXISTING: never claim a branch holds work it does not
  out(`interrupted run ${it.runId} stopped in phase: ${it.phase} (last seq ${fold(it.events).lastSeq}); ${where}\n`);
  out(`phase ${it.phase} is not auto-resumable (stage state is in memory); start a new run${it.task ? " with the same task" : ""}: loki start\n`);
  return 4;
}
/** E-66: a text run confirmed already-done has no issue to comment on (no comment_argv, intake.ts);
 *  main() prints intake's comment body instead so the no-change decision is not swallowed. */
export function alreadyDoneTextComment(events: EventEnvelope[]): string | null {
  const d = events.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data;
  return d?.source === "text" && d?.already_satisfied === true && typeof d.comment === "string" ? d.comment : null;
}
/** FC-15 (L5/L6): intake's harness-owned "work exists on <branch>, not on <target>" note, null when absent. */
export function unmergedLokiWorkNote(events: EventEnvelope[]): string | null {
  return noteOf(events.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data);
}

// Moved from engine10/supervisor.ts (core line budget); supervisor re-exports both.
/** The policies file policyGate reads (first of repo .loki, then the data dir; json before yaml), or null when there is none. */
export function policyFile(repoDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dataDir = env.LOKI_DATA_DIR || join(env.HOME ?? "", ".loki");
  for (const d of [join(repoDir, ".loki"), dataDir]) for (const f of ["policies.json", "policies.yaml"]) if (existsSync(join(d, f))) return join(d, f);
  return null;
}
/** run.started intent record: who asked (LOKI_ACTOR, else the repo user.name), under which policy (sha256 of the policies file, null when none) and,
 *  for `loki answer`, which BLOCKED run this run resolves (LOKI_PARENT_RUN) and the sha256 of the answer. Redacted; absent keys stay null. */
export function runIntent(repoDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  let actor = (env.LOKI_ACTOR ?? "").trim();
  if (!actor) { try { actor = safeGit(repoDir, ["config", "user.name"]).trim(); } catch { /* no identity configured */ } }
  const pf = policyFile(repoDir, env);
  let policy: string | null = null;
  if (pf) { try { policy = createHash("sha256").update(readFileSync(pf)).digest("hex"); } catch { /* unreadable: leave null */ } }
  const parent = /^[A-Za-z0-9._-]{1,128}$/.test(env.LOKI_PARENT_RUN ?? "") ? env.LOKI_PARENT_RUN! : null;
  const ans = /^[0-9a-f]{64}$/.test(env.LOKI_ANSWER_SHA ?? "") ? env.LOKI_ANSWER_SHA! : null;
  return { actor: actor ? redactSecrets(actor).slice(0, 200) : null, policy_revision: policy, parent_run: parent, answered_run: parent, answer_sha256: parent ? ans : null };
}
export const STATUS_MARKER = "<!-- loki-status -->";
const plain = (t: string): string => t.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/[<>`@]/g, " ").slice(0, 500); // a reason can echo worker text: no markup, no mentions
/** The single status comment an issue run keeps current (FV-gh-steer-3). Built only from harness-owned event fields and the PR url; the only worker-derived text is the
 *  blocked/failed reason, flattened by `plain`. `steerRevs` counts operator revisions consumed since this run started. */
/** P12-19 (D06): the Control Plane page for one run, `<base>/#/runs/<sourceId>/<runId>`. null unless base is an http(s) url. */
export function controlRunLink(base: string | null | undefined, repoDir: string, runId: string): string | null {
  if (!base || !/^https?:\/\//.test(base) || !runId) return null;
  return `${base.replace(/\/+$/, "")}/#/runs/${encodeURIComponent(sourceId(repoDir))}/${encodeURIComponent(runId)}`;
}
export function issueStatusBody(events: readonly EventEnvelope[], o: { runId: string; steerRevs: number; prUrl?: string | null; outcome?: string | null; reason?: string | null; controlUrl?: string | null }): string {
  const planned = events.some((e) => e.type === "stage.completed" && e.stage === "plan");
  const lines = [STATUS_MARKER, `Loki run \`${o.runId.replace(/[^A-Za-z0-9._-]/g, "")}\``, "", `State: ${o.outcome ?? workItemState(events)}`, `Plan: ${planned ? "ready" : "pending"}`];
  if (o.steerRevs > 0) lines.push(`Operator steers applied: ${o.steerRevs}`);
  if (o.prUrl) lines.push(`Pull request: ${o.prUrl}`);
  if (o.controlUrl) lines.push(`Control Plane: ${o.controlUrl}`);
  const last = events[events.length - 1]; // seq only: a relative age would change the body every call and defeat the unchanged-body skip
  if (last) lines.push(`Last event: seq ${last.seq}`);
  if (o.reason) lines.push("", `${o.outcome === "BLOCKED" ? "Question" : "Reason"}: ${plain(o.reason)}`);
  return `${lines.join("\n")}\n`;
}
export type StatusExtra = { prUrl?: string | null; outcome?: string | null; reason?: string | null };
/** Projector for the issue status comment: each call re-reads the run's events, renders the body and upserts it through `issue-comment --update`.
 *  Calls are serialised (two in flight would both see no comment and create twice) and an unchanged body is not re-posted. */
export function issueStatusProjector(o: { pushSh: string; env: NodeJS.ProcessEnv; origin?: string | null; repoDir: string; runDir: string; runId: string; issueRef: string; eventsPath: string }): (x?: StatusExtra) => Promise<{ argv: string[]; ok: boolean; skipped?: boolean } | null> {
  let chain: Promise<unknown> = Promise.resolve(), last = "";
  const env = o.origin ? { ...o.env, _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: o.origin } : o.env; // engine10-push.sh refuses an unpinned origin
  const argvOf = (bodyFile: string): string[] => ["issue-comment", "--update", o.issueRef, bodyFile];
  const once = async (x: StatusExtra): Promise<{ argv: string[]; ok: boolean; skipped?: boolean } | null> => {
    const events = readEvents(o.eventsPath), since = Date.parse(events[0]?.ts ?? "") || 0;
    const revs = readIntentRevisions(o.repoDir, since).length;
    const body = issueStatusBody(events, { runId: o.runId, steerRevs: revs, controlUrl: controlRunLink(o.env.LOKI_CONTROL_PLANE_URL || o.env.LOKI_CONTROL_URL, o.repoDir, o.runId), ...x }), bodyFile = join(o.runDir, "status-comment.md"), argv = argvOf(bodyFile);
    if (body === last) return { argv, ok: true };
    mkdirSync(o.runDir, { recursive: true }); writeFileSync(bodyFile, body);
    const [ok, skipped] = await new Promise<[boolean, boolean]>((res) => { execFile("bash", [o.pushSh, ...argv], { env }, (err, out) => res([!err, /^skipped: /m.test(String(out))])); });
    if (ok) last = body;
    return { argv, ok, ...(skipped ? { skipped: true } : {}) };
  };
  return (x = {}) => { const r = chain.then(() => once(x), () => once(x)); chain = r.catch(() => null); return r.catch(() => null); };
}
export type PolicyGate = { decision: "allow" | "deny" | "approval"; reason: string };
/** Autonomy/policy gate before an engine10 action (pr). No policy file: allow, byte-identical to before. File present and node or check.js missing: deny (fail-closed, mirrors run.sh check_policy). Exit 0 allow, 2 approval, anything else deny. */
export function policyGate(repoDir: string, action: string, env: NodeJS.ProcessEnv = process.env, checkJs: string = resolve(import.meta.dir, "../../../src/policies/check.js"), timeoutMs: number = 30000): PolicyGate {
  if (policyFile(repoDir, env) === null) return { decision: "allow", reason: "no policy file" };
  if (env.LOKI_POLICY_REQUIRE_NODE === "0" && spawnSync("node", ["--version"], { env: { PATH: env.PATH }, encoding: "utf8" }).status !== 0) return { decision: "allow", reason: "policy NOT evaluated: node unavailable, enforcement skipped (LOKI_POLICY_REQUIRE_NODE=0)" };
  if (!existsSync(checkJs)) return { decision: "deny", reason: "policy file present but check.js is missing (fail-closed)" };
  const scoped: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: env.HOME, LOKI_PROJECT_DIR: repoDir, ...(env.LOKI_DATA_DIR ? { LOKI_DATA_DIR: env.LOKI_DATA_DIR } : {}) };
  const r = spawnSync("node", [checkJs, "pre_deployment", JSON.stringify({ action })], { env: scoped, encoding: "utf8", timeout: timeoutMs });
  if (r.error) return (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? { decision: "deny", reason: `policy check timed out after ${timeoutMs}ms: cannot evaluate policy (fail-closed)` } : { decision: "deny", reason: `policy file present but node is unavailable: cannot evaluate policy (fail-closed)` };
  let why = ""; try { why = String((JSON.parse(r.stdout || "{}") as { reason?: string }).reason ?? ""); } catch { /* keep empty */ }
  return r.status === 0 ? { decision: "allow", reason: why } : r.status === 2 ? { decision: "approval", reason: why } : { decision: "deny", reason: why || "policy check failed (fail-closed)" };
}
/** One PR-egress decision shared by the supervisor pr callback and resumePublish: deny = no PR plus a not-proven line; approval = draft via ctx.draft (never process.env). */
export function prGate(repoDir: string): { deny: string } | { draft: boolean; note?: string } {
  const gate = policyGate(repoDir, "pr");
  if (gate.decision === "deny") return { deny: `PR not opened: policy denied (${gate.reason})` };
  return gate.decision === "allow" && gate.reason.startsWith("policy NOT evaluated") ? { draft: false, note: gate.reason } : { draft: gate.decision === "approval" };
}
/** MASS-2: a stacked slice's PR targets its parent slice's run branch (LOKI_PR_BASE, set by `loki issues run`).
 *  undefined = no stacking (the default branch); null = set but not a safe branch name, so the stage fails closed. */
export function stackBase(env: NodeJS.ProcessEnv): string | null | undefined {
  const b = env.LOKI_PR_BASE;
  if (b === undefined || b === "") return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(b) && !b.includes("..") && !b.includes("//") && !b.endsWith("/") && !b.endsWith(".lock") ? b : null;
}
/** MASS-2: a slice run has no issue.json, so `loki issues run` names the epic it belongs to (LOKI_PR_REFS=owner/repo#N).
 *  A slice never closes its epic, so this is always "Refs"; a strict ref or nothing reaches the body. */
export function stackSection(env: NodeJS.ProcessEnv, base: string | undefined, hasIssueLink: boolean): string {
  const r = env.LOKI_PR_REFS ?? "";
  const refs = !hasIssueLink && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/.test(r) ? `\nRefs ${r}\n` : "";
  return refs + (base ? `\nStacked on \`${base}\`: review and merge that pull request first.\n` : "");
}
