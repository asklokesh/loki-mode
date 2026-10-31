// L7 shared contract: the single typed source for every field an output producer (PR body, receipt summary, reports) reads.
// A producer that runs outside the worker (the supervisor opens the PR after the worker exits) has no live stage outputs, so it
// rebuilds them here from the recorded run: the last stage.completed event per stage, then issue.json and plan-output.txt as fallbacks.
// Field map (producer reads -> recorded by):
//   intake.task / intake.title      <- intake stage.completed, else issue.json (title + body)
//   plan.plan / plan.relevant_files <- plan stage.completed, else plan-output.txt
//   verify.changed_files / checks   <- verify stage.completed (the diff and the evidence)
//   wall.files / wall.base_run      <- wall stage.completed
import { execFile, spawnSync } from "node:child_process";
import { SAFE_BUN_FLAGS } from "../runner/worker_proc.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { conflictReasonOf, fold, partialCost, readEvents, type Folded } from "../engine10/events.ts";
import { cacheSavings } from "../runner/budget.ts";
import { renderProofCard } from "./receipt_surface.ts";
import { answerMark, answeredTask, blockedCompletion, effectiveEvents } from "./conflict_resume.ts";
import { eventsRelPath, readOriginUrl } from "./engine_origin.ts";
import { runOwnerAlive } from "./run_pid.ts";
import { safeGit } from "./safe_git.ts";
import { currentBranch } from "../e10ext/stop_restore.ts";
import { shapeKeyForRun, sealedOutcomesByTier, tierOfModel, type ShapedReceipt } from "../runner/router/history.ts";
import { formatPreModelLine, formatSummary, plainLine, type Outcome, type TierSeal, type PreModelTiming, type SummaryInput } from "../engine10/output.ts";
import { applyArbitrations } from "./conflict_resume.ts";
import { noteOf } from "./base_guard.ts";
import { sourceId } from "../../../packages/control-plane/src/shipper/ship.ts";
import { redactSecrets } from "./redact.ts";
import { checkpointProblem, onlyWallPublish, resumeCheckpointTail, runStateProblem, verifyLogSeals } from "./seal_drift.ts";
import { readIntentRevisions, type IntentRevision } from "./steer.ts";
import { REPO_ROOT } from "./paths.ts";
import { getVersion } from "../version.ts";
import { resolveClaudeModel } from "./claude_model.ts";
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
export const SEAL_ACCURACY_NOT_MEASURED = "Seal accuracy: not measured";
const SEAL_ACCURACY_MAX_AGE_MS = 7 * 86_400_000, SPEC_PREFIXES = ["spec", "test", "check"];
const LANG_BY_EXT: Record<string, string> = { ".py": "python", ".js": "javascript", ".ts": "typescript", ".go": "go", ".rs": "rust", ".java": "java", ".rb": "ruby", ".sh": "shell" };
/** GAME10-03: the one Seal accuracy line, read from benchmarks/seeded-defects/results/wrong-pass.json (never typed). The stratum is the changed
 *  code's language (first changed file that is not a spec, test or check file, as measure.py picks it), the first passing check's runner, and the
 *  tier of the run measured with this receipt's model. The line says "not measured" for a loki version mismatch, a corpus other than the current
 *  manifest, a missing stratum or a run measured over 7 days ago (its measured_at; missing or unparseable means not measured). The line sits in the signed body, so editing it breaks receipt_sha256. */
export function sealAccuracyLine(changed: readonly string[], checks: readonly { cmd: string; result: string }[], model: string, env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): string {
  try {
    const dir = env["LOKI_SEEDED_DEFECTS_DIR"] || join(REPO_ROOT, "benchmarks", "seeded-defects"), file = join(dir, "results", "wrong-pass.json");
    const corpus = createHash("sha256").update(readFileSync(join(dir, "manifest.json"))).digest("hex");
    const res = JSON.parse(readFileSync(file, "utf8")) as { manifest_sha256?: unknown; runs?: Record<string, unknown>[] };
    if (res.manifest_sha256 !== corpus || !Array.isArray(res.runs)) return SEAL_ACCURACY_NOT_MEASURED;
    const first = changed.map((f) => basename(f)).find((b) => !SPEC_PREFIXES.some((p) => b.startsWith(p)));
    const lang = first === undefined ? "unknown" : LANG_BY_EXT[first.slice(first.lastIndexOf(".")).toLowerCase()] ?? "unknown";
    const runner = checks.find((c) => c.result === "pass")?.cmd.trim().split(/\s+/)[0];
    const run = res.runs.find((r) => typeof r["model"] === "string" && resolveClaudeModel(r["model"]) === resolveClaudeModel(model));
    if (!runner || !run || run["loki_version"] !== getVersion() || run["corpus_sha256"] !== corpus || !Array.isArray(run["strata"])) return SEAL_ACCURACY_NOT_MEASURED;
    const at = typeof run["measured_at"] === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(run["measured_at"]) ? Date.parse(run["measured_at"]) : NaN, age = nowMs - at; // the writer's own timestamp; file mtime resets on checkout
    if (!(age >= 0 && age <= SEAL_ACCURACY_MAX_AGE_MS)) return SEAL_ACCURACY_NOT_MEASURED;
    const row = (run["strata"] as Record<string, unknown>[]).find((r) => r["language"] === lang && r["runner"] === runner);
    const n = row?.["n"], wp = row?.["wrong_pass"], up = row?.["wilson_upper_95"];
    if (typeof n !== "number" || typeof wp !== "number" || typeof up !== "number" || !Number.isInteger(n) || !Number.isInteger(wp) || n < 1 || wp < 0 || wp > n || !(up >= 0 && up <= 1)) return SEAL_ACCURACY_NOT_MEASURED;
    return `Seal accuracy for ${lang}/${runner} at this tier: ${wp} wrong pass${wp === 1 ? "" : "es"} in ${n} seeded defects, 95% upper bound ${(up * 100).toFixed(1)}%, measured on ${getVersion()}`;
  } catch { return SEAL_ACCURACY_NOT_MEASURED; }
}
/** GAME10-03c: the signed accuracy line as a receipt carries it, for the PR body and `loki verify`. A missing or malformed field reads "not measured"; nothing is recomputed. */
export const receiptSealAccuracy = (r: unknown): string => { const v = (r as { seal_accuracy?: unknown } | null)?.seal_accuracy; return typeof v === "string" && /^Seal accuracy[^\x00-\x1f\x7f]{0,300}$/.test(v) ? v : SEAL_ACCURACY_NOT_MEASURED; };
export const sealAccuracyOfFile = (path: string | null): string => { try { return receiptSealAccuracy(JSON.parse(readFileSync(path ?? "", "utf8"))); } catch { return SEAL_ACCURACY_NOT_MEASURED; } };
export function sealAccuracyBlock(changed: readonly string[], checks: readonly { cmd: string; result: string }[], model: string, env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): { seal_accuracy: string } {
  return { seal_accuracy: sealAccuracyLine(changed, checks, model, env, nowMs) };
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
/** A run.completed written by a SIGINT/SIGTERM/loki-cancel stop: it seals the log but is not a finish. */
export const isCancelDone = (e: EventEnvelope): boolean => e.type === "run.completed" && e.data["cancelled"] === true;
/** A run.completed a resume checkpoint seal may follow: a cancel stop, or a BLOCKED (SPEC_CONFLICT) completion. Used by verify only (resumeCheckpointOk, which also demands an answered resume for SPEC_CONFLICT); resumePoint does not use it. */
export const isResumableDone = (e: EventEnvelope): boolean => isCancelDone(e) || (e.type === "run.completed" && e.data["verdict"] === "SPEC_CONFLICT");
export type Phase = "implement" | "verify" | "publish" | "done";

/** RECOVERY: which phase an event log stopped in. "done" means nothing is left to resume. */
export function phaseOf(events: readonly EventEnvelope[]): Phase {
  if (events.some((e) => e.type === "pr.opened")) return "done";
  const s = stageState(events);
  if (s === "ready_to_ship") return "publish";
  if (s === "validating") return "verify";
  return s === "received" || s === "prepared" || s === "planned" || s === "executing" ? "implement" : "done";
}

export interface Interrupted { runId: string; phase: Phase; events: EventEnvelope[]; task: string | null; cancelled?: boolean }

/** SB-12: the harness-owned marker `Discard old run` writes; a marked run is never offered or resumed again. Nothing is deleted. */
const DISCARD_MARK = "discarded";
export const isDiscarded = (runsDir: string, runId: string): boolean => existsSync(join(runsDir, runId, DISCARD_MARK));

function taskOf(events: readonly EventEnvelope[]): string | null {
  const t = events.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data["task"];
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

/** Latest run (by events.jsonl mtime) that stopped before completing and has no live owner; null when none. */
export function findInterrupted(repoDir: string, runId?: string, includeCancelled = false, why?: { reason?: string }): Interrupted | null {
  const no = (reason: string): null => { if (why) why.reason = reason; return null; };
  const root = join(repoDir, ".loki", "runs");
  let ids: string[] = [];
  try { ids = runId ? [runId] : readdirSync(root); } catch { return null; }
  const rows = ids.filter((id) => /^e10-[A-Za-z0-9-]+$/.test(id) && existsSync(join(repoDir, eventsRelPath(id))))
    .map((id) => ({ id, m: statSync(join(repoDir, eventsRelPath(id))).mtimeMs })).sort((a, b) => b.m - a.m);
  const top = rows[0];
  if (!top) return null;
  const events = readEvents(join(repoDir, eventsRelPath(top.id)));
  const doneAt = events.findLastIndex((e) => e.type === "run.completed"), tail = events.slice(doneAt + 1 + (events[doneAt + 1]?.type === "log.sealed" ? 1 : 0));
  const cancelDone = doneAt >= 0 && isCancelDone(events[doneAt]!), cancelled = cancelDone && tail.length === 0; // SB-04d: a cancelled run is resumable; events after its cancel seal mean it was resumed and stopped again (an interrupted run) or were appended by hand (refused below)
  if (cancelled && !includeCancelled) return null;
  const phase = phaseOf(events.filter((e) => !isCancelDone(e)));
  if (phase === "done" || isDiscarded(root, top.id) || runOwnerAlive(join(root, top.id)) || events.length === 0) return null;
  const foreign = events.find((e) => e.run !== top.id); // a log holding another run's events (a copied or symlinked log) is not this run's
  if (foreign) return no(`run ${top.id} holds an event from run ${String(foreign.run)}; its log is not its own`);
  try {
    const raw = readFileSync(join(repoDir, eventsRelPath(top.id)), "utf8"), torn = raw.split("\n").filter((l) => l.trim() !== "").length !== events.length;
    if (torn && phase === "publish") return no(`run ${top.id} has a torn or unparsable event log`); // a publish resume never reaches resumePoint's torn-line check, so a torn or garbage-appended log is refused here
    const bad = torn ? null : verifyLogSeals(raw, events, { sealLast: true });
    if (bad) return no(`run ${top.id} is not resumable: ${bad}`); // a log whose seal does not verify is not resumable; a torn pre-publish log is still reported, and resumePoint refuses it
  } catch { return null; }
  return { runId: top.id, phase, events, task: taskOf(events), ...(cancelled ? { cancelled: true } : {}) };
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
export function resumePoint(allEvents: readonly EventEnvelope[], rawLog?: string, answering = false): ResumePoint {
  const events = allEvents; // integrity checks read the whole log; the stage checks below read `ev`, which hides a blocked attempt when its answer is pending
  if (rawLog !== undefined) {
    const lines = rawLog.split("\n").filter((l) => l.trim() !== "");
    if (lines.length !== events.length) return { ok: false, reason: `event log is torn or corrupt (${lines.length - events.length} unreadable line(s))` };
    if (rawLog.length > 0 && !rawLog.endsWith("\n")) return { ok: false, reason: "event log ends in a torn line" };
  }
  if (events.length === 0) return { ok: false, reason: "event log is empty or unreadable" };
  if (events.some((e, i) => e.seq !== i)) return { ok: false, reason: "event log has a sequence gap" };
  if (new Set(events.map((e) => e.run)).size !== 1) return { ok: false, reason: "event log mixes run ids" };
  if (answering && !blockedCompletion(events, answerMark(events, true))) return { ok: false, reason: "run is not BLOCKED on a spec conflict; nothing to answer" };
  const ev = effectiveEvents(events, answering);
  if (!events.some((e) => e.type === "run.started")) return { ok: false, reason: "no run.started event" };
  if (events.some((e) => e.type === "tamper.detected")) return { ok: false, reason: "event log was flagged as tampered" };
  if (rawLog !== undefined) { const bad = verifyLogSeals(rawLog, events, { sealLast: true }); if (bad) return { ok: false, reason: `event log failed its seal check (${bad})` }; } // FC-RESUME-TRUSTS-UNSEALED-LOG: a resumed supervisor re-hashes the file, so an edit made while stopped would otherwise be signed
  if (ev.some((e) => e.type === "run.completed" && !isCancelDone(e))) return { ok: false, reason: "run already completed; nothing to resume" };
  const intake = ev.findLast((e) => e.type === "stage.completed" && e.stage === "intake");
  if (intake && typeof intake.data["base_sha"] !== "string") return { ok: false, reason: "intake checkpoint has no base_sha" };
  const next = firstIncompleteStage(ev);
  if (next === null) return { ok: false, reason: "every stage settled; nothing to resume" };
  const idx = STAGE_ORDER.indexOf(next as (typeof STAGE_ORDER)[number]);
  const par = next === "plan" || next === "wall"; // plan and wall run in parallel (machine.ts FLOW): either may finish first
  const later = STAGE_ORDER.slice(idx + 1).find((s) => !(par && (s === "plan" || s === "wall")) && ev.some((e) => e.stage === s && e.type === "stage.completed"));
  if (later) return { ok: false, reason: `stage ${later} completed but ${next} never did` };
  // P12-07d/h: durable late-steer state, seeded into ctx on re-entry (seedResumeCtx). Both inputs are worker-forgeable via ingest, so each rule fails closed.
  const byRev = new Map<number, IntentRevision>(); // union of every intent.revised; on a duplicate rev keep the LATEST at (unapplied wins), so a pre-claimed at:0 cannot displace the honest entry
  for (const e of events) if (e.type === "intent.revised" && Array.isArray(e.data["revisions"])) for (const r of e.data["revisions"] as IntentRevision[]) if (typeof r === "object" && r !== null && Number.isInteger(r.rev) && Number.isFinite(r.at)) { const o = byRev.get(r.rev); if (!o || (r.unapplied === true && o.unapplied !== true) || (o.unapplied !== true && r.at > o.at)) byRev.set(r.rev, r); }
  const intentRevisions = [...byRev.values()].sort((x, y) => x.rev - y.rev);
  const starts = ev.filter((e) => e.type === "stage.started" && e.stage === "wall").map((e) => { const m = e.data["start_ms"], seen = Date.parse(e.ts); return typeof m === "number" && Number.isFinite(m) && m >= 0 ? Math.min(m, Number.isFinite(seen) ? seen : 0) : 0; }); // a claimed start is capped at the supervisor's own append time; unknown = 0: every revision stale
  const first = starts.length ? Math.min(...starts) : null, timeline = first === null ? [] : [{ stage: "wall" as const, startMs: first, endMs: first }]; // EARLIEST start only: a later forged start cannot move the freeze point forward
  return { ok: true, stage: next, skip: STAGE_ORDER.slice(0, idx), checkpoints: stageCheckpoints(ev), intentRevisions, timeline };
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
  const all = events; events = effectiveEvents(all); // a pending answer hides the blocked attempt, so its conflicting stage and everything after it re-run
  const done = new Set<string>(STAGE_ORDER.filter((s) => (s === "intake" || s === "plan" || s === "wall" || s === "implement") && settled(events, s))), restored: StageOutputs = {};
  for (const s of done) { const e = events.findLast((x) => x.type === "stage.completed" && x.stage === s); if (e) restored[s] = e.data; }
  if (restored["wall"]) { const wi = events.findLastIndex((x) => x.type === "stage.completed" && x.stage === "wall"); const w = restored["wall"] as Record<string, unknown>; restored["wall"] = { ...w, ...(Array.isArray(w["files"]) ? { files: (w["files"] as object[]).map((x) => ({ ...x })) } : {}), ...(Array.isArray(w["readOnlyFiles"]) ? { readOnlyFiles: (w["readOnlyFiles"] as object[]).map((x) => ({ ...x })) } : {}) }; applyArbitrations(restored["wall"], events.slice(wi + 1)); } // a Wall check arbitrated after its stage settled keeps its replacement hash and disclosure
  // D61-04: a deferred already-done hit lands on intake AFTER its stage.completed was written, so the flag is durable only in the supervisor-written already.attested event (SUPERVISOR_ONLY: a worker line of that type is dropped). It counts only if it precedes implement's stage.completed and no intent.revised follows it (stale evidence). Absent or malformed -> not satisfied (old logs restore as before).
  const hitIdx = events.findLastIndex((x) => x.type === "already.attested" && x.stage === "intake"), hit = hitIdx < 0 ? undefined : events[hitIdx], ev = hit?.data["evidence"];
  const implDone = events.findLastIndex((x) => x.type === "stage.completed" && x.stage === "implement");
  if (restored["intake"] && hit && hit.data["already_satisfied"] === true && Array.isArray(ev) && ev.length > 0 && ev.every((x) => typeof x === "string" && x !== "") && (implDone < 0 || hitIdx < implDone) && !events.slice(hitIdx + 1).some((x) => x.type === "intent.revised")) restored["intake"] = { ...restored["intake"], already_satisfied: true, evidence: ev };
  if (restored["intake"] && typeof restored["intake"]["task"] === "string") restored["intake"] = { ...restored["intake"], task: answeredTask(restored["intake"]["task"], all) }; // the answer joins the locked task text every later stage reads
  const kept = flow.map((st) => typeof st === "string" ? (done.has(st) ? [] : st) : st.filter((n) => !done.has(n))).filter((st) => st.length > 0);
  return { ok: true, flow: kept as (F | readonly F[])[], restored };
}

/** `loki answer`: the newest-first lookup for a run the engine ended BLOCKED (run.completed SPEC_CONFLICT) that no process still owns. */
function findBlocked(repoDir: string, runId?: string): Interrupted | null {
  if (!runId) return null;
  const p = join(repoDir, eventsRelPath(runId));
  if (!existsSync(p) || runOwnerAlive(join(repoDir, ".loki", "runs", runId))) return null;
  const events = readEvents(p);
  return events.length ? { runId, phase: "implement", events, task: taskOf(events) } : null;
}

/** `loki start --resume [run-id]`. The publish phase resumes through resumePublish; an earlier phase re-enters the machine at the resume
 *  point under a fresh supervisor (run.resumed, restored stages not rerun). Exit 2 on a refusal: unreadable state is never a success. Exit 4 when a measured property says the run cannot resume (branch or base commit gone, torn log, nothing settled, provider or model changed). */
/** Exit 4: a measured property of the run says it cannot be resumed. Never a timer. The work stays on its branch; the user starts a new run. */
const cannotResume = (out: (s: string) => void, id: string, reason: string): number => { out(`resume: run ${plainLine(id, 80)} cannot be resumed (${plainLine(reason, 400)}); its work is on branch loki/${plainLine(id, 80)}. Start a new run: loki start <task>\n`); return 4; };

export async function resumeFlag(runId: string | undefined, noPr = false, deps: ResumeDeps = {}, answer?: string): Promise<number> {
  const out = deps.out ?? ((s: string) => { process.stderr.write(s); });
  let repoDir: string;
  try { repoDir = safeGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim(); } catch { out("engine10: --resume: not inside a git repository\n"); return 2; }
  const id = runId && /^e10-[A-Za-z0-9-]+$/.test(runId) ? runId : undefined;
  const why: { reason?: string } = {}, it = answer === undefined ? findInterrupted(repoDir, id, true, why) : findBlocked(repoDir, id); // `loki answer`: a BLOCKED run is complete, so it is not "interrupted"
  if (!it) { out(answer === undefined ? `engine10: --resume: no interrupted engine10 run${why.reason ? ` (${plainLine(why.reason, 400)})` : ""}\n` : "engine10: answer: no such engine10 run\n"); return 3; }
  let raw = "";
  try { raw = readFileSync(join(repoDir, eventsRelPath(it.runId)), "utf8"); } catch { return cannotResume(out, it.runId, "its event log is unreadable"); }
  const tailBad = it.phase === "publish" ? null : cancelTailProblem(it.events);
  if (tailBad) { out(`engine10: --resume refused: run ${it.runId} holds ${tailBad}\n`); return 2; }
  const tl = trustedLog(it.events, raw), rp = resumePoint(tl.events, tl.raw, answer !== undefined);
  if (!rp.ok && /^event log (is torn|ends in a torn)/.test(rp.reason)) return cannotResume(out, it.runId, `its ${rp.reason}`);
  if (!rp.ok) { out(`engine10: --resume refused: ${plainLine(rp.reason, 400)}\n`); return 2; }
  if (it.phase === "publish" && noPr) { out("engine10: --resume refused: --no-pr was given and this run is in its publish phase\n"); return 2; }
  if (it.phase === "publish") return resumePublish(repoDir, it, deps);
  const st1 = (it.events.find((e) => e.type === "run.started")?.data ?? {}) as Record<string, unknown>, wantProv = process.env["LOKI_PROVIDER"], wantModel = process.env["LOKI_MODEL_OVERRIDE"];
  if (wantProv && typeof st1["provider"] === "string" && wantProv !== st1["provider"]) return cannotResume(out, it.runId, `the provider changed since the kill: the run used ${st1["provider"]}, LOKI_PROVIDER is ${wantProv}`);
  if (wantModel && st1["model_override_applied"] !== true && typeof st1["model"] === "string" && wantModel !== st1["model"]) return cannotResume(out, it.runId, `the model changed since the kill: the run used ${st1["model"]}, LOKI_MODEL_OVERRIDE is ${wantModel}`);
  if (rp.skip.length === 0) return cannotResume(out, it.runId, "no stage had settled, so there is nothing to resume from");
  const baseSha = tl.events.findLast((e) => e.type === "stage.completed" && e.stage === "intake")?.data["base_sha"];
  if (typeof baseSha === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(baseSha)) { try { safeGit(repoDir, ["cat-file", "-e", `${baseSha}^{commit}`]); } catch { return cannotResume(out, it.runId, `its base commit ${baseSha.slice(0, 12)} is gone from this repo`); } }
  out(`engine10: resume from stage ${rp.stage} (settled: ${rp.skip.join(", ") || "none"})\n`);
  const br = `loki/${it.runId}`, origBranch = currentBranch(repoDir), pc = partialCost(it.events, false, join(repoDir, ".loki")), st0 = (it.events.find((e) => e.type === "run.started")?.data ?? {}) as Record<string, unknown>;
  if (it.events.some((e) => e.type === "cap.hit")) { out(`engine10: --resume refused: run ${it.runId} already hit its cost or time cap\n`); return 2; }
  let activeS = 0; for (let i = 1; i < it.events.length; i++) { const g = (Date.parse(it.events[i]!.ts) - Date.parse(it.events[i - 1]!.ts)) / 1000; if (g <= 0) continue; const ev = it.events[i]!; if (g <= 120 || ev.type !== "run.resumed") activeS += g; else { const alive = Date.parse(String(ev.data["last_alive_ts"] ?? "")), since = (alive - Date.parse(it.events[i - 1]!.ts)) / 1000; if (since > 0) activeS += Math.min(since, g); } } // P12-07l: a long gap is downtime only when it ends in run.resumed; a long verify (or any quiet running stage) that ends in its own event counts in full; P12-07n: a gap ending in run.resumed counts up to the supervisor's last heartbeat (last_alive_ts) as active, only the rest as downtime
  const capS = Number(st0["cap_s"]) > 0 ? Number(st0["cap_s"]) - activeS : undefined, ceilS = Number(st0["cap_ceiling_s"]) > 0 ? Number(st0["cap_ceiling_s"]) - activeS : undefined;
  if (capS !== undefined && capS < 60) { out(`engine10: --resume refused: run ${it.runId} has under 60s of its time cap left\n`); return 2; }
  if (rp.skip.includes("intake") && origBranch !== br) {
    const dirty = safeGit(repoDir, ["status", "--porcelain", "--", ".", ":(exclude).loki"]).split("\n").filter(Boolean);
    if (dirty.length) { out(`engine10: --resume refused: ${dirty.length} uncommitted or untracked file(s) in your working tree would ride onto ${br}; commit or stash them first\n`); return 2; }
    try { safeGit(repoDir, ["rev-parse", "--verify", "-q", `refs/heads/${br}`]); } catch { // a BLOCKED run that changed nothing drops its empty run branch; the answer recreates it at the base the run recorded
      if (answer === undefined || typeof baseSha !== "string") return cannotResume(out, it.runId, `run branch ${br} is gone`);
      try { safeGit(repoDir, ["branch", br, baseSha]); } catch { return cannotResume(out, it.runId, `run branch ${br} is gone and cannot be recreated`); }
    }
    try { safeGit(repoDir, ["checkout", "-q", br]); } catch { out(`engine10: --resume refused: cannot switch to run branch ${br}\n`); return 2; }
  }
  const st = (it.events.find((e) => e.type === "run.started")?.data ?? {}) as Record<string, unknown>, provider = String(st["provider"] ?? "claude"), model = String(st["model"] ?? ""), deep = st["deep"] === true;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(capS !== undefined ? { LOKI_E10_CAP_S: String(Math.floor(capS)) } : {}), ...(pc.usd > 0 ? { LOKI_E10_SPENT_USD: String(pc.usd) } : {}), ...(Number(st["max_cost_usd"]) >= 0 && st["max_cost_usd"] !== undefined ? { LOKI_E10_MAX_COST_USD: String(st["max_cost_usd"]) } : {}) };
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
  const { exitCodeOf } = await import("../engine10/output.ts");
  const res = await supervise({ runId: it.runId, repoDir, env, resume: true, capS: capS === undefined ? undefined : Math.floor(capS), capCeilingS: ceilS === undefined ? undefined : Math.floor(ceilS), restoreBranch: origBranch, workerArgv: [process.execPath, ...SAFE_BUN_FLAGS, resolve(process.argv[1] ?? ""), "engine10", "worker", it.runId, provider, model, deep ? "deep" : "fast"], started: { ...st, resumed_from: rp.stage, ...(answer !== undefined ? { answered: true, answer: redactSecrets(answer), answer_sha256: createHash("sha256").update(redactSecrets(answer)).digest("hex"), question: String(conflictReasonOf(it.events) ?? "the run is blocked on a spec conflict").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 500) } : {}) }, pr });
  out(`engine10: resumed run ${it.runId}: ${res.outcome}\n`);
  return exitCodeOf(res.outcome);
}

export type RunPrFn = (ctx: Record<string, unknown>, signal: AbortSignal) => Promise<{ status: string; reason?: string; data: Record<string, unknown> }>;
export interface ResumeDeps { fresh?: boolean; tty?: boolean; ask?: (q: string) => Promise<string | null>; runPr?: RunPrFn; out?: (s: string) => void; supervise?: (o: import("../engine10/supervisor.ts").SupervisorOptions) => Promise<{ outcome: Outcome }> }

/** The facts a publish resume trusts, taken from the receipt file after its hash, its binding to the log and its signature check out. The log only locates the receipt:
 *  a forged receipt.sealed line (a second one, or one appended after a cancel seal) is refused, never believed. Fails closed: a missing, unsigned-while-a-key-exists or unverifiable receipt is a problem. */
async function signedReceiptFacts(runDir: string, runId: string, events: readonly EventEnvelope[]): Promise<{ verdict: Verdict; seal: Record<string, unknown>; receipt: Record<string, unknown>; trusted: number } | { problem: string }> {
  const sealedAt = events.flatMap((e, i) => (e.type === "receipt.sealed" ? [i] : [])), lastCancelSeal = events.findLastIndex((e, i) => e.type === "log.sealed" && i > (sealedAt[0] ?? -1) + 1); // the log.sealed right after receipt.sealed is the checkpoint, not a cancel seal
  if (sealedAt.length !== 1) return { problem: `event log holds ${sealedAt.length} receipt.sealed events; a run seals exactly one receipt` };
  const tail = events.slice(lastCancelSeal + 1).filter((e) => !(e.type === "run.resumed" && e.data["phase"] === "publish" && e.data["receipt_reused"] === true)); // only this resume's own marker may follow a seal
  if (lastCancelSeal > sealedAt[0]! && tail.length > 0) return { problem: `event log holds ${tail.length} event(s) after its cancel seal (${tail[0]!.type}); they are unauthenticated` };
  const foreign = events.find((e) => e.run !== runId);
  if (foreign) return { problem: `event log holds an event from run ${String(foreign.run)}, not ${runId}` };
  const file = join(runDir, "receipt.json"), { checkAttestation, computeReceiptHash, checkEventLog } = await import("../engine10/verify_cmd.ts"), { loadSigningKey } = await import("./receipt_signer.ts");
  for (const f of [file, join(runDir, "events.jsonl")]) { try { if (lstatSync(f).isSymbolicLink()) return { problem: `${basename(f)} is a symlink; a run's own files are never links` }; } catch { /* a missing file is reported below */ } }
  let r: Record<string, unknown>;
  try { r = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return { problem: "receipt.json is missing or unreadable" }; }
  if (r["run_id"] !== runId) return { problem: `receipt.json belongs to run ${String(r["run_id"])}, not ${runId}` };
  const hash = computeReceiptHash(r);
  if (r["receipt_sha256"] !== hash || events[sealedAt[0]!]!.data["receipt_sha256"] !== hash) return { problem: "receipt.json does not match its receipt.sealed event" };
  const jwt = ((r["verification"] ?? {}) as { jwt?: unknown }).jwt ?? null;
  if (jwt === null) { if (loadSigningKey(false) !== null) return { problem: "receipt.json is unsigned although a signing key exists" }; }
  else if (typeof jwt !== "string" || checkAttestation(jwt, hash).status !== "verified") return { problem: "receipt.json signature does not verify" };
  const cp = checkpointProblem(runDir, events, r), signed = cp.signed; // the signed checkpoint right after receipt.sealed: without it, or with a tamper flag on it, nothing past the receipt is authenticated
  const stateProblem = runStateProblem(runDir, runId, hash, signed && cp.problem === null); // the supervisor's own verdict lives outside the log tail, so a cut tail cannot hide a tamper or a failed finish; a crash in publish leaves it open, which a valid checkpoint makes safe to resume
  if (stateProblem) return { problem: stateProblem };
  const logProblem = checkEventLog(file, r); // the receipt must bind a line-aligned prefix of THIS run's log
  if (logProblem) return { problem: `receipt.json is not bound to this run's event log (${logProblem})` };
  const ck = sealedAt[0]! + 1;
  if (cp.problem) return { problem: cp.problem };
  const lastCancel = events.findLastIndex((e) => isCancelDone(e));
  if (lastCancel >= 0 && (jwt !== null || r["log_seal"] === true) && events[lastCancel + 1]?.type !== "log.sealed") return { problem: "the cancel run.completed is not followed by its log.sealed line; the seal was removed" };
  const v = r["verdict"], np = r["not_proven"];
  return { receipt: r, trusted: (signed ? ck : sealedAt[0]!) + 1, verdict: v === "VERIFIED" || v === "PARTIAL" || v === "ALREADY_SATISFIED" || v === "SPEC_CONFLICT" ? v : "FAILED", seal: { receipt_sha256: hash, head_sha: r["head_sha"], signed: jwt !== null, path: file, not_proven: Array.isArray(np) ? np.filter((x): x is string => typeof x === "string") : [] } };
}

/** The run branch must still sit on the sealed head_sha, or on commits that pass onlyWallPublish (this run's trailer, only sealed Wall files, byte-equal to the seal). Anything else was added after the seal. */
function branchHeadProblem(repoDir: string, runId: string, receipt: Record<string, unknown>): string | null {
  const sealed = receipt["head_sha"];
  if (typeof sealed !== "string" || !/^[0-9a-f]{40,64}$/.test(sealed)) return "receipt.json carries no head_sha to compare the run branch with";
  let tip = "";
  try { tip = safeGit(repoDir, ["rev-parse", "--verify", "-q", `refs/heads/loki/${runId}^{commit}`]).trim(); } catch { return `run branch loki/${runId} is missing`; }
  if (tip === sealed || onlyWallPublish(repoDir, receipt, sealed, tip)) return null;
  return `run branch loki/${runId} is at ${tip.slice(0, 12)} but the receipt sealed ${sealed.slice(0, 12)}; a commit added after the seal is never published`;
}

/** Resumes the publish phase. Reuses the sealed receipt; appends run.resumed, pr.opened and run.completed. */
export async function resumePublish(repoDir: string, it: Interrupted, deps: ResumeDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => { process.stdout.write(s); });
  const runDir = join(repoDir, ".loki", "runs", it.runId);
  const facts = await signedReceiptFacts(runDir, it.runId, it.events);
  if ("problem" in facts) { out(`resume: refused: ${plainLine(facts.problem, 400)}\n`); return 5; }
  const sealedData: Record<string, unknown> = { ...((it.events.findLast((e) => e.type === "receipt.sealed")?.data ?? {}) as Record<string, unknown>), ...facts.seal }; // verdict, not_proven, hash and path come from the verified receipt file, never from a log line
  const verdict = facts.verdict;
  const started = it.events.find((e) => e.type === "run.started")?.data ?? {};
  const origin = readOriginUrl(repoDir);
  if (!origin) { out("resume: no origin remote; nothing to publish\n"); return 2; }
  const { SupervisorLog } = await import("../engine10/supervisor.ts");
  const gate = prGate(repoDir); // same policy egress as the supervisor pr callback: resume must not bypass autonomy
  if ("deny" in gate) { out(`resume: ${gate.deny}\n`); return 5; }
  const headProblem = branchHeadProblem(repoDir, it.runId, facts.receipt); // a commit added to the run branch after the seal is not what the receipt vouches for
  if (headProblem) { out(`resume: refused: ${headProblem}\n`); return 5; }
  const log = new SupervisorLog(join(repoDir, eventsRelPath(it.runId)), it.runId);
  log.append("run.resumed", null, { phase: "publish", receipt_reused: true, receipt_sha256: sealedData["receipt_sha256"] ?? null });
  const notProven = [...(Array.isArray(sealedData["not_proven"]) ? (sealedData["not_proven"] as string[]) : []), "publish phase resumed after an interruption", ...("note" in gate && gate.note ? [gate.note] : [])];
  const runPr = deps.runPr ?? (async (c, s) => (await import("../engine10/stages/pr.ts")).runPr(c as never, s));
  const allEvents = readEvents(log.path), events = allEvents.slice(0, facts.trusted); // outputs() sees only events up to the signed checkpoint; anything after it is unauthenticated
  const baseSha = it.events.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data["base_sha"];
  const r = await runPr({
    runId: it.runId, repoDir, runDir, branch: `loki/${it.runId}`, pinnedOrigin: origin,
    provider: String(started["provider"] ?? "claude"), model: String(started["model"] ?? ""), baseSha: typeof baseSha === "string" ? baseSha : safeGit(repoDir, ["rev-parse", "HEAD"]).trim(),
    outputs: () => ({ ...loadRunOutputs(runDir, events), seal: { ...sealedData, not_proven: notProven, verdict, receipt_path: sealedData["path"] } }),
    capHit: () => allEvents.some((e) => e.type === "cap.hit"), draft: gate.draft, emit: () => {},
  }, new AbortController().signal);
  const d = r.data as { pr_url?: string; draft?: boolean; existing?: boolean | null };
  if (r.status !== "completed" || !d.pr_url) { out(`resume: publish failed: ${r.reason ?? "no PR url"}\n`); return 5; }
  log.append("pr.opened", "pr", { url: d.pr_url, draft: d.draft === true, existing: d.existing ?? null });
  log.append("run.completed", null, { verdict, pr_url: d.pr_url, not_proven: notProven, resumed: true });
  log.sealLog();
  out(`resumed phase: publish (run ${plainLine(it.runId, 80)}); receipt reused; PR ${d.existing === true ? "reused " : ""}${d.pr_url}\n`);
  return 0;
}

export type RecoveryChoice = "resume" | "fresh" | "discard" | "details";

/** SB-12: maps one typed answer to a choice; "" is the default, null is unparseable (the caller re-asks). Resume is refused when the run is not resumable. */
export function parseRecoveryChoice(raw: string, resumable: boolean): RecoveryChoice | null {
  const a = raw.trim().toLowerCase(), order: RecoveryChoice[] = resumable ? ["resume", "fresh", "discard", "details"] : ["fresh", "discard", "details"];
  if (a === "") return order[0]!;
  if (/^[1-9]$/.test(a)) return order[Number(a) - 1] ?? null;
  if (["f", "s", "fresh", "start", "start fresh"].includes(a)) return "fresh";
  if (["d", "x", "discard", "discard old run"].includes(a)) return "discard";
  if (["i", "?", "details", "show", "show details"].includes(a)) return "details";
  return resumable && ["r", "resume"].includes(a) ? "resume" : null;
}

/** SB-12: what the next `loki start` will do with this run; shared by `loki status` and the end-of-run cancel line. */
export function nextStepText(runId: string, phase: Phase, resumable: boolean, hasBranch: boolean): string {
  const kept = hasBranch ? `old work stays on loki/${runId}` : "no run branch was created";
  return resumable ? `next loki start with the same task offers to ${phase === "publish" ? "finish its pull request step" : "resume it from its settled stages"} (run ${runId}) or start fresh` : `next loki start offers to start fresh; ${kept}`;
}

const branchExists = (repoDir: string, runId: string): boolean => { try { return safeGit(repoDir, ["rev-parse", "--verify", "-q", `refs/heads/loki/${runId}`]).trim() !== ""; } catch { return false; } };

/** SB-04d: the log.sealed line is the last authenticated point of a stopped run (the same checkpoint rule signedReceiptFacts applies to a publish resume): events after the last one were never sealed, so a resume refuses them instead of trusting them. */
function cancelTailProblem(events: readonly EventEnvelope[]): string | null {
  const at = events.findLastIndex((e) => e.type === "log.sealed");
  return at >= 0 && at < events.length - 1 && !resumeCheckpointTail(events) ? `${events.length - 1 - at} event(s) after its last log.sealed (${events[at + 1]!.type}); they are unauthenticated` : null;
}

/** The log a resume decision reasons over: when the last log.sealed is a resume checkpoint, only the log up to it (the killed resumed part after it is unsigned and never read). A torn log is returned whole so the torn-line refusal still fires. */
function trustedLog(events: readonly EventEnvelope[], raw: string): { events: readonly EventEnvelope[]; raw: string } {
  const t = resumeCheckpointTail(events), lines = raw.split("\n").filter((l) => l.trim() !== "");
  return t && lines.length === events.length ? { events: events.slice(0, t.sealAt + 1), raw: lines.slice(0, t.sealAt + 1).join("\n") + "\n" } : { events, raw };
}

/** SB-04d: can `loki start` continue this run from its settled stages (any phase before publish)? Same measured properties resumeFlag refuses on: branch, base commit, an intact sealed log, a settled stage. */
function stagesResumable(repoDir: string, runId: string, events: readonly EventEnvelope[]): boolean {
  if (!branchExists(repoDir, runId) || cancelTailProblem(events)) return false;
  try {
    const tl = trustedLog(events, readFileSync(join(repoDir, eventsRelPath(runId)), "utf8")), rp = resumePoint(tl.events, tl.raw);
    if (!rp.ok || rp.skip.length === 0) return false;
    const base = tl.events.findLast((e) => e.type === "stage.completed" && e.stage === "intake")?.data["base_sha"];
    if (typeof base === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base)) safeGit(repoDir, ["cat-file", "-e", `${base}^{commit}`]);
    return true;
  } catch { return false; }
}

/** The `loki status` next-step line for one run; null when the run is complete, live, discarded or has nothing left to offer. */
export function statusNextStep(repoDir: string, runsDir: string, runId: string, events: readonly EventEnvelope[]): string | null {
  const cancelled = events.findLast((e) => e.type === "run.completed")?.data["cancelled"] === true;
  if (events.some((e) => e.type === "run.completed") && !cancelled) return null;
  const phase = phaseOf(events.filter((e) => !isCancelDone(e)));
  if (phase === "done" || events.length === 0 || isDiscarded(runsDir, runId) || runOwnerAlive(join(runsDir, runId))) return null;
  const hasBranch = branchExists(repoDir, runId);
  return nextStepText(runId, phase, phase === "publish" ? hasBranch && taskOf(events) !== null : stagesResumable(repoDir, runId, events), hasBranch);
}

/** `Discard old run`: writes the harness-owned marker inside the run's own directory, after checking that it is a real directory (not a link) under this repo's runs dir. */
export function discardRun(repoDir: string, runId: string): boolean {
  if (!/^e10-[A-Za-z0-9-]+$/.test(runId)) return false;
  const dir = join(repoDir, ".loki", "runs", runId);
  try { if (!lstatSync(dir).isDirectory()) return false; writeFileSync(join(dir, DISCARD_MARK), `${new Date().toISOString()}\n`, { flag: "wx" }); return true; } catch { return false; } // wx: a pre-planted file or dangling link at the marker path is refused, never followed
}

/** What a reader resolves on Ctrl-C. EOF (null) means the same: no choice was made, so nothing starts and nothing resumes. */
export const RECOVERY_ABORT = "\u0000abort";
const askLine = async (q: string): Promise<string | null> => {
  const rl = (await import("node:readline")).createInterface({ input: process.stdin, output: process.stderr });
  try { return await new Promise<string | null>((res) => { rl.once("close", () => res(null)); rl.once("SIGINT", () => res(RECOVERY_ABORT)); rl.question(q, (a) => res(a)); }); } finally { rl.close(); }
};

/** The run-state half of "resumePublish can finish this run": the record is intact and clean, and a record still open (a crash) is accepted only behind a valid signed checkpoint. */
function publishStateOk(runDir: string, it: Interrupted): boolean {
  const sealedAt = it.events.findIndex((e) => e.type === "receipt.sealed"), hash = String(it.events[sealedAt]?.data["receipt_sha256"] ?? ""), cp = checkpointProblem(runDir, it.events);
  return runStateProblem(runDir, it.runId, hash, cp.signed && cp.problem === null) === null;
}
/** Called by `loki start` before it opens a new run (and by a bare `loki start`, task ""). Returns an exit code when it resumed, null to go on.
 *  A run whose recorded task equals this task (any task when none was given) is resumable, cancelled or interrupted: a publish-phase run needs its origin, branch and
 *  policy; an earlier phase needs its branch, base commit and an intact log with a settled stage, and re-enters at the first unsettled stage. TTY: the user picks. No TTY or LOKI_NONINTERACTIVE=1: a resumable run resumes, else a one-line note.
 *  --fresh (deps.fresh) and LOKI_NO_RESUME=1 skip all of it. */
export async function startRecovery(repoDir: string, task: string, noPr: boolean, deps: ResumeDeps = {}): Promise<number | null> {
  if (process.env["LOKI_NO_RESUME"] === "1" || deps.fresh === true) return null;
  const it = findInterrupted(repoDir, undefined, true);
  if (!it) return null;
  const note = deps.out ?? ((s: string) => { process.stderr.write(s); });
  const hasBranch = branchExists(repoDir, it.runId), t = task.trim();
  const sameTask = it.task !== null && (t === "" || it.task === t), publish = it.phase === "publish";
  const resumable = sameTask && (publish ? !noPr && hasBranch && readOriginUrl(repoDir) !== null && !("deny" in prGate(repoDir)) && publishStateOk(join(repoDir, ".loki", "runs", it.runId), it) : stagesResumable(repoDir, it.runId, it.events)); // offered only when the resume can proceed: publish needs branch, origin, policy and the supervisor's run-state record; earlier phases need branch, base commit, a verified log and a settled stage
  const kept = hasBranch ? `old work is kept on loki/${it.runId}` : "no run branch was created", was = it.cancelled ? "cancelled" : "interrupted";
  const interactive = (deps.tty ?? (process.stdin.isTTY === true && process.stderr.isTTY === true)) && process.env["LOKI_NONINTERACTIVE"] !== "1";
  let began = false;
  const go = async (): Promise<number> => publish ? resumePublish(repoDir, it, deps) : resumeFlag(it.runId, noPr, { ...deps, supervise: async (o) => { began = true; return (deps.supervise ?? (async (x) => (await import("../engine10/supervisor.ts")).runSupervisor(x)))(o); } });
  if (resumable && !interactive) { const rc = await go(); if (publish || began || rc === 0) return rc; note(`note: run ${it.runId} could not be resumed; starting a new run, ${kept}.\n`); return null; } // a refusal before the engine started (dirty tree, cap) never blocks a fresh start
  if (!interactive || (t === "" && !resumable)) {
    note(`note: run ${it.runId} was ${was} in phase ${it.phase}; ${t === "" ? `give a task to start a new run (loki start <task>); ${kept}` : `starting a new run, ${kept}`}.\n`);
    return null;
  }
  const ask = deps.ask ?? askLine, discardItem = "Discard old run (not offered again; nothing is deleted)";
  const menu = resumable ? [publish ? "Resume (finish the pull request step)" : "Resume (continue from the settled stages)", `Start fresh (${kept})`, discardItem, "Show details"] : [`Start fresh (${kept})`, discardItem, "Show details"];
  note(`loki: run ${it.runId} was ${was} in phase ${it.phase}${it.task ? ` (task: ${it.task.replace(/\s+/g, " ").slice(0, 80)})` : ""}.\n`);
  for (let tries = 0; tries < 5; tries++) {
    note(`${menu.map((m, i) => `  ${i + 1}) ${m}${i === 0 ? " [default]" : ""}`).join("\n")}\n`);
    const ans = await ask("choice: ");
    if (ans === null || ans === RECOVERY_ABORT) { note("no choice made; nothing was started or resumed\n"); return 130; } // Ctrl-C or closed input is never a choice
    const c = parseRecoveryChoice(ans, resumable);
    if (c === null) { note(`not a choice: ${ans.trim().slice(0, 40)}\n`); continue; }
    if (c === "details") { note(`  run ${it.runId}: ${it.events.length} events, last seq ${fold(it.events).lastSeq}, phase ${it.phase}, ${was}; ${kept}; ${resumable ? `resumable (same task, ${publish ? "publish phase" : "settled stages kept"})` : "not resumable here (different task, --no-pr, or the branch, base commit, log or a settled stage is missing)"}\n`); continue; }
    if (c === "resume") return go();
    note(c === "discard" ? (discardRun(repoDir, it.runId) ? `Discarded run ${it.runId}: it will not be offered again; ${kept}.\n` : `Could not mark run ${it.runId} as discarded; starting fresh.\n`) : `Starting fresh; ${kept}.\n`);
    return null;
  }
  note("no valid choice; nothing was started or resumed\n");
  return 130;
}

/** `loki resume [run-id]` for engine10 runs. Exit 0 resumed, 3 nothing to resume, 4 phase not auto-resumable, else failure. */
export async function resumeMain(args: string[], deps: ResumeDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => { process.stdout.write(s); });
  let repoDir: string;
  try { repoDir = safeGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim(); } catch { out("resume: not inside a git repository\n"); return 2; }
  const why: { reason?: string } = {}, it = findInterrupted(repoDir, args.find((a) => !a.startsWith("-")), false, why);
  if (!it) { out(`resume: no interrupted engine10 run${why.reason ? ` (${plainLine(why.reason, 400)})` : ""}\n`); return 3; }
  if (it.phase === "publish") return resumePublish(repoDir, it, deps);
  let br = "";
  try { br = safeGit(repoDir, ["rev-parse", "--verify", "-q", `refs/heads/loki/${it.runId}`]).trim(); } catch { /* no run branch */ }
  out(`interrupted run ${plainLine(it.runId, 80)} stopped in phase: ${it.phase} (last seq ${fold(it.events).lastSeq}); ${br ? `work is preserved on branch loki/${plainLine(it.runId, 80)}` : "no run branch was created"}\n`);
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

/** Tier that sealed this run plus this repo shape's sealed record, read from the receipts under .loki/runs. Top-tier cost avoided has no recorded source yet, so it stays null and prints "not measured". Display only. */
export function tierSealFor(repoDir: string, runId: string): TierSeal {
  const root = join(repoDir, ".loki", "runs"), shape = shapeKeyForRun(repoDir, join(root, basename(runId))), receipts: ShapedReceipt[] = [], read = (d: string): Record<string, unknown> | null => { try { const r: unknown = JSON.parse(readFileSync(join(root, d, "receipt.json"), "utf8")); return typeof r === "object" && r !== null ? r as Record<string, unknown> : null; } catch { return null; } };
  let dirs: string[] = []; try { dirs = readdirSync(root).sort().slice(-200); } catch { /* no runs dir */ }
  for (const d of dirs) { const own = shapeKeyForRun(repoDir, join(root, d), true), receipt = own === null ? null : read(d); if (receipt && own !== null) receipts.push({ shape: own, receipt }); } // each receipt joins its own run's shape; an unrecoverable shape is skipped
  const tier = tierOfModel(read(basename(runId))?.["model"]);
  return { tier: tier === "unknown" ? null : tier, topTierCostAvoidedUsd: null, record: shape === null ? null : sealedOutcomesByTier(receipts)[shape] ?? null };
}
/** The summary input main() passes: a TAMPERED run shows no tier. */
export const summaryTier = (repoDir: string, runId: string, tampered: boolean): TierSeal | undefined => tampered ? undefined : tierSealFor(repoDir, runId);
/** The block main() writes to stdout once a run finishes; pure because main() re-spawns process.argv[1] as the worker, so tests cannot drive it. */
export function renderMainOutput(events: EventEnvelope[], summary: SummaryInput, verbose = true): string {
  const c = alreadyDoneTextComment(events), un = unmergedLokiWorkNote(events);
  const pm = (events.findLast((e) => e.type === "run.completed")?.data.pre_model ?? null) as PreModelTiming | null;
  const verify = events.findLast((e) => e.type === "stage.completed" && e.stage === "verify");
  const checks = Array.isArray(verify?.data.checks) ? verify.data.checks.length : 0;
  const seal = events.findLast((e) => e.type === "stage.completed" && e.stage === "seal");
  const mutation = typeof seal?.data.mutation_line === "string" ? seal.data.mutation_line : null;
  const card = renderProofCard({
    verdict: summary.outcome ?? summary.verdict,
    usd: summary.cost.usd,
    wallS: summary.wallS,
    checks,
    mutationProof: mutation,
    sha: summary.receipt?.sha ?? null,
    tampered: summary.receipt?.tampered === true,
  });
  return `${c ? `\n${c}\n` : ""}${un ? `\n${un}\n` : ""}${verbose ? formatPreModelLine(pm) : ""}${formatSummary(summary)}\n${verbose ? `\n${card}\n` : ""}`; // D48: the default stays within 8 lines; the card is --verbose only
}
// E-59: every token field the provider reported, cache included (E-50 found "1k shown for 372k used" when this summed only input+output). The sole place tokens are computed for the Cost line.
export function summaryTokens(f: Folded, sawCost: boolean): number | null {
  return sawCost ? f.cost.inputTokens + f.cost.outputTokens + f.cost.cacheReadTokens + f.cost.cacheCreationTokens : null;
}
/** Summary cache fields from the cost events: tokens times the input minus cache-read price delta; null (printed "cache not measured") unless every cost event carried the key, and for a tampered log. */
export function summaryCache(events: ReturnType<typeof readEvents>, tampered: boolean): { cacheReadTokens: number | null; cacheSavedUsd: number | null } {
  const cs = tampered ? null : cacheSavings(events.filter((e) => e.type === "cost").map((e) => ({ model: typeof e.data.model === "string" ? e.data.model : undefined, cache_read_tokens: typeof e.data.cache_read_tokens === "number" ? e.data.cache_read_tokens : undefined })));
  return { cacheReadTokens: cs ? cs.readTokens : null, cacheSavedUsd: cs ? cs.savedUsd : null };
}

/** A run that ends FAILED before (or without) a model call still leaves one verifiable record: the same receipt hash, signature, receipt.sealed and signed log.sealed lines the seal stage uses, over a run.started / run.completed log, with the refusal reason in not_proven. */
export interface RefusalSeal { repoDir: string; task: string; reason: string; detail?: readonly string[]; provider?: string }
export async function sealRefusal(o: RefusalSeal): Promise<{ runId: string; receiptPath: string } | null> {
  try {
    const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 500);
    const [{ SupervisorLog }, seal, signer, { atomicWriteText }, { githubRepoFromUrl }] = await Promise.all([import("../engine10/supervisor.ts"), import("../engine10/stages/seal.ts"), import("./receipt_signer.ts"), import("./atomic.ts"), import("./engine_origin.ts")]);
    const runId = `e10-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${Math.random().toString(16).slice(2, 6)}`;
    const runDir = join(o.repoDir, ".loki", "runs", runId), provider = o.provider ?? "claude", repo = githubRepoFromUrl(readOriginUrl(o.repoDir));
    mkdirSync(runDir, { recursive: true });
    const log = new SupervisorLog(join(o.repoDir, eventsRelPath(runId)), runId);
    log.append("run.started", null, { task_source: "text", provider, refused: true, origin_repo: repo });
    const git = (a: string[]): string => { try { return safeGit(o.repoDir, a).trim(); } catch { return ""; } };
    const head = git(["rev-parse", "--verify", "--quiet", "HEAD"]), tree = head ? git(["rev-parse", `${head}^{tree}`]) : "";
    const notProven = [clean(o.reason), ...(o.detail ?? []).map(clean).filter(Boolean), "cost not measured (refusal receipt)"];
    const body: Omit<import("../engine10/types.ts").Receipt, "receipt_sha256" | "verification"> = {
      schema: "loki.v10.receipt/1", run_id: runId, task: { source: "text", sha256: seal.sha256(o.task) }, repo: repo ?? "", base_sha: head, head_sha: head, tree, diff_sha256: seal.sha256(""),
      wall: { files: [], passed: null }, checks: [], not_proven: notProven, verdict: "FAILED", evidence: [],
      cost: { usd: null, input_tokens: 0, output_tokens: 0, measured_sessions: 0, total_sessions: 0, partial_usd: 0 },
      time: { wall_s: 0, stages: {} }, provider, model: "", resumed: false,
      events_sha256: seal.sha256(readFileSync(log.path)), log_seal: true, toolchain: signer.collectToolchain(),
    };
    let hash = seal.receiptSha256(body);
    const sig = signer.signReceipt(runId, hash);
    if (!sig.jwt) { body.not_proven = [...notProven, seal.SIGNING_UNAVAILABLE]; hash = seal.receiptSha256(body); }
    const receipt = { ...body, receipt_sha256: hash, verification: { jwt: sig.jwt, kid: sig.kid } };
    const receiptPath = join(runDir, "receipt.json");
    atomicWriteText(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    atomicWriteText(join(runDir, "receipt.md"), seal.renderReceiptMd(receipt));
    log.append("receipt.sealed", "seal", { path: receiptPath, receipt_sha256: hash, signed: sig.jwt !== null, kid: sig.kid, verdict: "FAILED", not_proven: receipt.not_proven });
    log.append("run.completed", null, { verdict: "FAILED", pr_url: null, not_proven: receipt.not_proven, cost_usd: null, wall_s: 0 });
    log.sealLog();
    return { runId, receiptPath };
  } catch { return null; }
}
