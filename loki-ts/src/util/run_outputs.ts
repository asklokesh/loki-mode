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
import { fold, readEvents } from "../engine10/events.ts";
import { eventsRelPath, readOriginUrl } from "./engine_origin.ts";
import { runOwnerAlive } from "./run_pid.ts";
import { safeGit } from "./safe_git.ts";
import { noteOf } from "./base_guard.ts";
import { redactSecrets } from "./redact.ts";
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

/** Work-item state (docs/v10/ENGINE.md "Work-item state"); lives here, not in engine10/events.ts, to keep the core line budget. */
export type WorkItemState =
  | "received" | "prepared" | "planned" | "executing" | "validating" | "ready_to_ship" | "completed"
  | "waiting_for_input" | "budget_stopped" | "failed" | "cancelled" | "stalled";
export const STALE_S = 30 * 60;

/** The one work-item vocabulary (docs/v10/ENGINE.md "Work-item state"). Pure over the event log. Terminal states come only from run.completed;
 *  `nowMs` (optional) enables "stalled" for an unfinished run with no events for STALE_S. */
export function workItemState(events: readonly EventEnvelope[], nowMs?: number): WorkItemState {
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
  const s = workItemState(events);
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
  const { SupervisorLog } = await import("../engine10/supervisor.ts");
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
  out(`resumed phase: publish (run ${it.runId}); receipt reused; PR ${d.existing === true ? "reused " : ""}${d.pr_url}\n`);
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
export function issueStatusBody(events: readonly EventEnvelope[], o: { runId: string; steerRevs: number; prUrl?: string | null; outcome?: string | null; reason?: string | null }): string {
  const planned = events.some((e) => e.type === "stage.completed" && e.stage === "plan");
  const lines = [STATUS_MARKER, `Loki run \`${o.runId.replace(/[^A-Za-z0-9._-]/g, "")}\``, "", `State: ${o.outcome ?? workItemState(events)}`, `Plan: ${planned ? "ready" : "pending"}`];
  if (o.steerRevs > 0) lines.push(`Operator steers applied: ${o.steerRevs}`);
  if (o.prUrl) lines.push(`Pull request: ${o.prUrl}`);
  if (o.reason) lines.push("", `${o.outcome === "BLOCKED" ? "Question" : "Reason"}: ${plain(o.reason)}`);
  return `${lines.join("\n")}\n`;
}
export type StatusExtra = { prUrl?: string | null; outcome?: string | null; reason?: string | null };
/** Projector for the issue status comment: each call re-reads the run's events, renders the body and upserts it through `issue-comment --update`.
 *  Calls are serialised (two in flight would both see no comment and create twice) and an unchanged body is not re-posted. */
export function issueStatusProjector(o: { pushSh: string; env: NodeJS.ProcessEnv; origin?: string | null; repoDir: string; runDir: string; runId: string; issueRef: string; eventsPath: string }): (x?: StatusExtra) => Promise<{ argv: string[]; ok: boolean } | null> {
  let chain: Promise<unknown> = Promise.resolve(), last = "";
  const env = o.origin ? { ...o.env, _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: o.origin } : o.env; // engine10-push.sh refuses an unpinned origin
  const argvOf = (bodyFile: string): string[] => ["issue-comment", "--update", o.issueRef, bodyFile];
  const once = async (x: StatusExtra): Promise<{ argv: string[]; ok: boolean } | null> => {
    const events = readEvents(o.eventsPath), since = Date.parse(events[0]?.ts ?? "") || 0;
    let revs = 0;
    try { for (const l of readFileSync(join(o.repoDir, ".loki", "intent-revisions.jsonl"), "utf8").split("\n")) if (l) { try { if (Date.parse(String((JSON.parse(l) as { consumed_at?: unknown }).consumed_at)) >= since) revs++; } catch { /* torn line */ } } } catch { /* no steers */ }
    const body = issueStatusBody(events, { runId: o.runId, steerRevs: revs, ...x }), bodyFile = join(o.runDir, "status-comment.md"), argv = argvOf(bodyFile);
    if (body === last) return { argv, ok: true };
    mkdirSync(o.runDir, { recursive: true }); writeFileSync(bodyFile, body);
    const ok = await new Promise<boolean>((res) => { execFile("bash", [o.pushSh, ...argv], { env }, (err) => res(!err)); });
    if (ok) last = body;
    return { argv, ok };
  };
  return (x = {}) => { const r = chain.then(() => once(x), () => once(x)); chain = r.catch(() => null); return r.catch(() => null); };
}
export type PolicyGate = { decision: "allow" | "deny" | "approval"; reason: string };
/** Autonomy/policy gate before an engine10 action (pr). No policy file: allow, byte-identical to before. File present and node or check.js missing: deny (fail-closed, mirrors run.sh check_policy). Exit 0 allow, 2 approval, anything else deny. */
export function policyGate(repoDir: string, action: string, env: NodeJS.ProcessEnv = process.env, checkJs: string = resolve(import.meta.dir, "../../../src/policies/check.js")): PolicyGate {
  if (policyFile(repoDir, env) === null) return { decision: "allow", reason: "no policy file" };
  if (env.LOKI_POLICY_REQUIRE_NODE === "0" && spawnSync("node", ["--version"], { env: { PATH: env.PATH }, encoding: "utf8" }).status !== 0) return { decision: "allow", reason: "node unavailable, enforcement skipped (LOKI_POLICY_REQUIRE_NODE=0)" };
  if (!existsSync(checkJs)) return { decision: "deny", reason: "policy file present but check.js is missing (fail-closed)" };
  const scoped: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: env.HOME, LOKI_PROJECT_DIR: repoDir, ...(env.LOKI_DATA_DIR ? { LOKI_DATA_DIR: env.LOKI_DATA_DIR } : {}) };
  const r = spawnSync("node", [checkJs, "pre_deployment", JSON.stringify({ action })], { env: scoped, encoding: "utf8", timeout: 30000 });
  if (r.error) return { decision: "deny", reason: `policy file present but node is unavailable: cannot evaluate policy (fail-closed)` };
  let why = ""; try { why = String((JSON.parse(r.stdout || "{}") as { reason?: string }).reason ?? ""); } catch { /* keep empty */ }
  return r.status === 0 ? { decision: "allow", reason: why } : r.status === 2 ? { decision: "approval", reason: why } : { decision: "deny", reason: why || "policy check failed (fail-closed)" };
}
/** One PR-egress decision shared by the supervisor pr callback and resumePublish: deny = no PR plus a not-proven line; approval = draft via ctx.draft (never process.env). */
export function prGate(repoDir: string): { deny: string } | { draft: boolean } {
  const gate = policyGate(repoDir, "pr");
  return gate.decision === "deny" ? { deny: `PR not opened: policy denied (${gate.reason})` } : { draft: gate.decision === "approval" };
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
