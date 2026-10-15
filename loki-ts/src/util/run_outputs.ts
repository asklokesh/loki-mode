// L7 shared contract: the single typed source for every field an output producer (PR body, receipt summary, reports) reads.
// A producer that runs outside the worker (the supervisor opens the PR after the worker exits) has no live stage outputs, so it
// rebuilds them here from the recorded run: the last stage.completed event per stage, then issue.json and plan-output.txt as fallbacks.
// Field map (producer reads -> recorded by):
//   intake.task / intake.title      <- intake stage.completed, else issue.json (title + body)
//   plan.plan / plan.relevant_files <- plan stage.completed, else plan-output.txt
//   verify.changed_files / checks   <- verify stage.completed (the diff and the evidence)
//   wall.files / wall.base_run      <- wall stage.completed
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fold, readEvents } from "../engine10/events.ts";
import { eventsRelPath, readOriginUrl } from "./engine_origin.ts";
import { runOwnerAlive } from "./run_pid.ts";
import { safeGit } from "./safe_git.ts";
import { noteOf } from "./base_guard.ts";
import type { EventEnvelope, Verdict } from "../engine10/types.ts";

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

// RECOVERY: find an interrupted engine10 run, name the phase it died in, and resume the publish phase without
// duplicating a side effect (design: docs/v10/ENGINE.md "Recovery of an interrupted run").
export type Phase = "implement" | "verify" | "publish" | "done";

/** RECOVERY: which phase an event log stopped in. "done" means nothing is left to resume. */
export function phaseOf(events: readonly EventEnvelope[]): Phase {
  if (events.some((e) => e.type === "run.completed" || e.type === "pr.opened")) return "done";
  if (events.some((e) => e.type === "receipt.sealed")) return "publish";
  const completed = new Set(events.filter((e) => e.type === "stage.completed").map((e) => String(e.stage)));
  return completed.has("implement") ? "verify" : "implement";
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

export type RunPrFn = (ctx: Record<string, unknown>, signal: AbortSignal) => Promise<{ status: string; reason?: string; data: Record<string, unknown> }>;
export interface ResumeDeps { runPr?: RunPrFn; out?: (s: string) => void }

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
  const { SupervisorLog, prGate } = await import("../engine10/supervisor.ts");
  const gate = prGate(repoDir); // same policy egress as the supervisor pr callback: resume must not bypass autonomy
  if ("deny" in gate) { out(`resume: ${gate.deny}\n`); return 5; }
  const log = new SupervisorLog(join(repoDir, eventsRelPath(it.runId)), it.runId);
  log.append("run.resumed", null, { phase: "publish", receipt_reused: true, receipt_sha256: sealedData["receipt_sha256"] ?? null });
  const notProven = [...(Array.isArray(sealedData["not_proven"]) ? (sealedData["not_proven"] as string[]) : []), "publish phase resumed after an interruption"];
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
  out(`resumed phase: publish (run ${it.runId}); receipt reused; PR ${d.pr_url}\n`);
  return 0;
}

/** Called by `loki start` before it opens a new run. Returns an exit code when it resumed, null to start fresh.
 *  Only a publish-phase run whose recorded task equals this task is resumed; any other interrupted run is just announced. */
export async function startRecovery(repoDir: string, task: string, noPr: boolean, deps: ResumeDeps = {}): Promise<number | null> {
  if (process.env["LOKI_NO_RESUME"] === "1") return null;
  const it = findInterrupted(repoDir);
  if (!it) return null;
  if (it.phase === "publish" && !noPr && it.task !== null && it.task === task.trim()) return resumePublish(repoDir, it, deps);
  const note = deps.out ?? ((s: string) => { process.stderr.write(s); });
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
  out(`interrupted run ${it.runId} stopped in phase: ${it.phase} (last seq ${fold(it.events).lastSeq}); ${br ? `work is preserved on branch loki/${it.runId}` : "no run branch was created"}\n`);
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
