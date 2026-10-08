// Loki 10 supervisor (P0, docs/v10/ENGINE.md sections 5, 6, 10): eval marker first, origin pinned once, worker
// spawned with withheld tokens; single writer of events.jsonl (seq, hash, tamper refusal)
// id; post-PR: detached deep verify, then Slack notify.
import { routeStartLine } from "../runner/router/route_block.ts";
import { execFileSync, spawn, spawnSync } from "node:child_process"; import { currentBranch, restoreBranch } from "../e10ext/stop_restore.ts";
import { createHash, createPublicKey, sign, type Hash } from "node:crypto";
import { resolveRunCapS } from "../util/run_cap.ts"; import { safeGit } from "../util/safe_git.ts";
import { terminalWidth } from "../util/term_width.ts";
import { guardedBackstop, validBase } from "../e10ext/commit_filter.ts";
import { kidOf, loadSigningKey } from "./stages/seal.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadSpecFile, type LoadedSpec } from "../util/spec_file.ts";
import { eventsRelPath, githubRepoFromUrl, readOriginUrl, writeEngineMarker } from "../util/engine_origin.ts";
export { eventsRelPath, githubRepoFromUrl, readOriginUrl, writeEngineMarker }; // re-exported: callers and tests import these from here
import { withholdGithubTokens } from "../runner/github_token.ts"; import { writeRunPid } from "../util/run_pid.ts";
import { EventLog, fold, partialCost, readEvents, tail, type Folded } from "./events.ts";
import { capNote, parseCapUsd, resolveCap, SUBSCRIPTION_NOTE } from "../e10ext/budget_cap.ts";
import { fetchIssueToFile } from "./fetch_issue.ts";
import { fetchTrackerIssueToFile, parseTrackerRef } from "../features/tracker_intake.ts";
import { formatHeartbeatLine, formatStageLine, formatSummary, formatPreModelLine, preModelTiming, type PreModelTiming, EXIT, outcomeOf, reasonOf, type Outcome, type SummaryInput } from "./output.ts";
import { LiveLine } from "../e10ext/liveline.ts";
import { killGroup, spawnWorker } from "../runner/worker_proc.ts";
import { askIntent } from "../util/intent_card.ts";
import { assertPreflight, PreflightError } from "./preflight.ts";
import { resolveModel } from "./session.ts";
import { modelDowngrades } from "../runner/model_downgrades.ts";
import type { PrContext } from "./stages/pr.ts";
import type { EventEnvelope, PushEnv, StageName, Verdict } from "./types.ts";
import { backstopS, BACKSTOP_GRACE_S, DEEP_CAP_S, DEFAULT_CAP_S, pushArgv, STAGE_BUDGETS } from "./types.ts";
import { baseLine, noteOf } from "../util/base_guard.ts";

export { backstopS, BACKSTOP_GRACE_S }; // re-exported: callers import the backstop math from here, its home before r4
import { encodeEstimate, startText } from "../runner/router/cost_preview.ts";
export const START_LINE = "Loki 10 engine";
export const TAMPER_NOT_PROVEN = "event log modified outside the engine";
async function slackEvent(...a: Parameters<typeof import("../e10ext/slack_events.ts").notifyEvent>): Promise<void> { try { await (await import("../e10ext/slack_events.ts")).notifyEvent(...a); } catch { /* best-effort */ } }
const SUPERVISOR_ONLY = new Set(["run.started", "run.completed", "tamper.detected", "pr.opened", "log.sealed"]); // types only the supervisor may write; same types from the worker are dropped
const VERDICTS = new Set<string>(["VERIFIED", "PARTIAL", "ALREADY_SATISFIED", "SPEC_CONFLICT", "FAILED"]);
const SESSION_EXITS = new Set(["done", "already_done", "spec_conflict", "killed", "error"]);
export const BACKSTOP_NOT_PROVEN = "worker killed by the supervisor backstop (cap minus grace)";

const nonNegNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
function dataOk(type: string, d: Record<string, unknown>): boolean { // per-type data checks for events the supervisor itself acts on (section 7 table)
  if (type === "session.ended") {
    return typeof d.session_id === "string" && SESSION_EXITS.has(d.exit as string) && nonNegNum(d.duration_s);
  }
  if (type === "cost") return typeof d.session_id === "string" && (d.usd === null || nonNegNum(d.usd));
  return true;
}
export interface PrOutcome { url: string | null; draft: boolean; existing: boolean | null; notProven?: string[] } // local types (not in types.ts): the PR hook E-11 (stages/pr.ts) plugs into, and the result
export type PrStep = (p: {
  env: NodeJS.ProcessEnv; // the supervisor's own credentialed env (read-only by contract)
  pushEnv: PushEnv; // origin pin from memory, never from the log
  runId: string; repoDir: string; verdict: Verdict;
  notProven: string[]; // accumulated so far (backstop/tamper included): the only place the PR body learns why when a killed worker never sealed a receipt
}) => Promise<PrOutcome | null>;
// Backstop fallback for a FAILED run with no PR (no diff, or no remote): on an issue run, posts a comment naming the reason instead of vanishing.
export type CommentStep = (p: { env: NodeJS.ProcessEnv; runId: string; issueRef: string; reason: string; prUrl?: string | null }) => Promise<{ argv: string[]; ok: boolean } | null>;

export interface SupervisorOptions {
  runId: string;
  repoDir: string;
  workerArgv: string[]; // argv of the worker process, e.g. [bun, cli, "engine10", "worker", ...] (wired by E-12)
  env?: NodeJS.ProcessEnv; // defaults to process.env; never mutated
  started?: Record<string, unknown>; // extra run.started data (task_source, provider, model, issue_ref, ...)
  pr?: PrStep; deepArgv?: string[]; // pr absent means no PR; deepArgv absent means no detached deep verify after pr.opened
  comment?: CommentStep; // absent means no issue-comment fallback (a FAILED, no-diff issue run then only prints)
  capCeilingS?: number; // FC-21b: the backstop is set here (the most the worker's resized cap can reach), not at the initial cap
  capS?: number; // global cap in seconds (default LOKI_E10_CAP_S, else DEFAULT_CAP_S); the backstop fires at cap minus grace
  graceS?: number; // default BACKSTOP_GRACE_S
}
export interface SupervisorResult {
  verdict: Verdict;
  outcome: Outcome; stop: string | null; receiptSha: string | null; // A-110: the ladder input and the --json fields
  tampered: boolean;
  notProven: string[];
  prUrl: string | null;
  workerExit: number | null;
}
export class SupervisorLog { // single writer with a running sha256 of the bytes it appended
  private readonly log: EventLog;
  private readonly hash: Hash;
  tampered = false;
  constructor(readonly path: string, runId: string) {
    this.log = new EventLog(path, runId);
    this.hash = createHash("sha256"); // seed AFTER construction: EventLog may terminate a torn last line
    try { this.hash.update(readFileSync(path)); } catch { /* new file */ }
  }
  append(type: string, stage: StageName | null, data: Record<string, unknown>): EventEnvelope {
    const e = this.log.append(type, stage, data);
    this.hash.update(JSON.stringify(e) + "\n");
    return e;
  }
  ingest(line: string): EventEnvelope | null { // validates one untrusted worker stdout line; returns the appended event or null when dropped
    let x: unknown;
    try { x = JSON.parse(line); } catch { return null; }
    if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
    const { type, stage, data } = x as Record<string, unknown>;
    if (typeof type !== "string" || type === "" || SUPERVISOR_ONLY.has(type)) return null;
    if (stage !== null && (typeof stage !== "string" || !Object.hasOwn(STAGE_BUDGETS, stage))) return null;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    if (!dataOk(type, data as Record<string, unknown>)) return null;
    const e = this.append(type, stage as StageName | null, data as Record<string, unknown>);
    if (type === "session.ended") this.verify();
    return e;
  }
  sealLog(): void { // A-117: signed line after run.completed over every earlier byte, so deleting the tail or the line itself breaks `loki verify`; unsigned runs have no key and skip it
    const key = loadSigningKey(false);
    if (!key) return;
    const sha = this.hash.copy().digest("hex");
    this.append("log.sealed", null, { kid: kidOf(createPublicKey(key)), events_sha256: sha, tampered: this.tampered, sig: sign(null, Buffer.from(`${sha}:${this.tampered}`), key).toString("base64url") });
  }
  verify(): boolean { // re-hashes the file; on mismatch (once) emits tamper.detected; returns true when intact
    if (this.tampered) return false;
    const expected = this.hash.copy().digest("hex");
    let actual = "";
    try { actual = createHash("sha256").update(readFileSync(this.path)).digest("hex"); } catch { /* deleted */ }
    if (actual === expected) return true;
    this.tampered = true;
    this.append("tamper.detected", null, { expected_sha256: expected, actual_sha256: actual });
    return false;
  }
}
export async function runSupervisor(opts: SupervisorOptions): Promise<SupervisorResult> {
  const t0 = Date.now();
  const startedProvider = opts.started?.["provider"]; // E-36: provider read off opts.started, not a dedicated field (main(), below, is the only populater)
  const env = opts.env ?? process.env;
  await assertPreflight({ repoDir: opts.repoDir, provider: typeof startedProvider === "string" ? startedProvider : "claude", pr: opts.pr !== undefined, env });
  writeEngineMarker(opts.repoDir, opts.runId); // first: a failing run still leaves it
  const origin = readOriginUrl(opts.repoDir); const rmRunPid = writeRunPid(join(opts.repoDir, ".loki", "runs", opts.runId), opts.runId); process.once("exit", rmRunPid); // origin pinned once, before any provider runs; CPE-09 run.pid for Control Plane Stop, removed on every exit path
  const log = new SupervisorLog(join(opts.repoDir, eventsRelPath(opts.runId)), opts.runId);
  // P0: a caller-built env (tests pass a minimal one) that omits LOKI_CONTROL inherits the process-level off switch the test preload sets.
  if ((env.LOKI_CONTROL ?? process.env.LOKI_CONTROL) !== "0") void import("../e10ext/ship_hook.ts").then((m) => m.startShip(opts.repoDir, log.path, env)).catch(() => {}); // CP-02: D56 shipper, off with LOKI_CONTROL=0
  log.append("run.started", null, { ...opts.started, origin_repo: githubRepoFromUrl(origin) });
  const workerEnv: NodeJS.ProcessEnv = { ...env }; // withholdGithubTokens mutates its argument: always a copy, never env itself
  withholdGithubTokens(workerEnv);
  // T3: the worker has no terminal; only the supervisor can ask the LOKI_CONFIRM question.
  workerEnv.LOKI_INTENT_TTY = env.LOKI_CONFIRM === "1" && process.stdin.isTTY === true && process.stdout.isTTY === true ? "1" : "0";
  const envCap = Number(env.LOKI_E10_CAP_S);
  const capS = opts.capS ?? (envCap > 0 ? envCap : DEFAULT_CAP_S);
  const ceilingS = Math.max(capS, opts.capCeilingS ?? capS);
  const backstopMs = backstopS(ceilingS, opts.graceS ?? BACKSTOP_GRACE_S) * 1000; // hard SIGKILL safety net for a stage blocking past the worker's own soft cap
  const escalateMs = Math.max(0, Math.min(2000, ceilingS * 1000 - backstopMs)); // SIGTERM->SIGKILL clamped so a trapping worker cannot outlive the cap
  let sealed: Record<string, unknown> | null = null; const origBranch = currentBranch(opts.repoDir), sessionGroups = new Set<number>(); // session children are detached (own group), so the worker's group kill misses them
  const worker = await spawnWorker(opts.workerArgv, workerEnv, opts.repoDir, backstopMs, escalateMs, (line) => {
    const e = log.ingest(line);
    if (e?.type === "session.started" && typeof e.data.pgid === "number") sessionGroups.add(e.data.pgid); if (e?.type === "receipt.sealed") sealed = e.data;
    if (e?.type === "variant" && e.data.intent_confirm === true && workerEnv.LOKI_INTENT_TTY === "1") {
      void askIntent(String(e.data.card ?? ""), join(opts.repoDir, ".loki", "runs", opts.runId));
    }
  }, (stopped) => { for (const g of sessionGroups) killGroup(g, "SIGKILL"); if (stopped) restoreBranch(opts.repoDir, origBranch); });
  const workerExit = worker.killed ? null : worker.code;
  const sealedData = sealed as Record<string, unknown> | null;
  const v = sealedData?.verdict;
  const receiptVerdict = workerExit === 0 && typeof v === "string" && VERDICTS.has(v), verdict: Verdict = receiptVerdict ? (v as Verdict) : "FAILED"; // FC-21b (3): a sealed receipt is the one source of truth for the outcome
  const notProven = Array.isArray(sealedData?.not_proven) ? (sealedData.not_proven as unknown[]).map(String) : [];
  if (worker.killed) notProven.push(BACKSTOP_NOT_PROVEN);
  let prUrl: string | null = null;
  const intact = log.verify(); // unconditional re-check before the PR
  if (!intact) notProven.push(TAMPER_NOT_PROVEN);
  // E-66: already-satisfied opens no PR. E-67: FAILED (including a backstop kill) does not block the
  // PR outright; backstopCommit lands what the kill left uncommitted so the diff below (against
  // intake's base_sha) sees it. No diff falls to the comment/print branch below.
  let hasDiff = false;
  if (verdict === "FAILED") {
    const stages = fold(readEvents(log.path)).stages; // A-104c: a failed commit stage already chose what to exclude (Wall files, lockfiles, pre-run dirt); a blanket `add -A` would undo it
    const baseE = stages["intake"], base = validBase(baseE?.type === "stage.completed" ? baseE.data.base_sha : null); // D50-F4b: a worker-written base is never an option or ref
    if (stages["commit"]?.type !== "stage.failed") { const why = guardedBackstop(intact, opts.repoDir, workerEnv, opts.runId, base, baseE?.type === "stage.completed" ? baseE.data.preexisting_dirty : undefined); if (why) notProven.push(why); } // no completed intake = no run branch: repoDir is still the user's own branch, never `add -A` there
    try { // net diff against base (a revert commit can leave HEAD past base with nothing to publish); any failure counts as a diff
      safeGit(opts.repoDir, ["diff", "--quiet", String(base), "HEAD", "--", ".", ":(exclude).loki"], { env: workerEnv, stdio: "ignore" });
    } catch { hasDiff = base !== null; }
  }
  if (opts.pr && intact && origin && verdict !== "ALREADY_SATISFIED" && (verdict !== "FAILED" || hasDiff)) {
    const pushEnv: PushEnv = { _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: origin };
    const out = await opts.pr({ env, pushEnv, runId: opts.runId, repoDir: opts.repoDir, verdict, notProven });
    notProven.push(...(out?.notProven ?? []));
    if (out?.url) {
      prUrl = out.url;
      log.append("pr.opened", "pr", { url: out.url, draft: out.draft, existing: out.existing });
      await slackEvent(env, "pr_opened", { repo: githubRepoFromUrl(origin) ?? undefined, issue: String(opts.started?.["issue_ref"] ?? ""), prUrl: out.url, outcome: verdict }); // D51-A4
      // E-48: deep verify (stages/deep.ts) runs detached, never keeping the supervisor alive; deep.started records the pid so it is never orphaned untracked.
      if (opts.deepArgv) { const [cmd, ...dArgs] = [...opts.deepArgv, origin], child = cmd ? spawn(cmd, dArgs, { cwd: opts.repoDir, env: workerEnv, stdio: "ignore", detached: true }) : null; child?.on("error", () => {}); if (child?.pid) { child.unref(); log.append("deep.started", "deep", { pid: child.pid }); } else notProven.push("deep verify not spawned"); }
    }
  }
  const allEvents = readEvents(log.path), folded = fold(allEvents), costUsd = log.tampered ? null : folded.cost.usd, wallS = (Date.now() - t0) / 1000; // one read, reused for cost and the Slack summary; unknown cost stays null
  const stopRaw = folded.run.escalated?.data.stop, stop = typeof stopRaw === "string" ? stopRaw : null;
  const outcome = outcomeOf(verdict, allEvents.some((e) => e.type === "cap.hit"), stop, log.tampered, receiptVerdict), blocked = outcome === "BLOCKED";
  if (blocked || (verdict === "FAILED" && prUrl === null)) { // E-67: never vanish silently -- an issue run gets a comment naming the reason, anything else is printed. A-110: BLOCKED always posts its one question
    const why = allEvents.find((e) => e.type === "stage.completed" && e.stage === "implement")?.data.spec_conflict_reason;
    const reason = blocked ? `spec conflict: ${String(why ?? "see the receipt").replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 500)}` : notProven.join("; ") || "run failed", issueRef = opts.started?.["issue_ref"];
    if (blocked) await slackEvent(env, "blocked", { repo: githubRepoFromUrl(origin) ?? undefined, issue: String(opts.started?.["issue_ref"] ?? ""), question: reason }); // D51-A4
    const isIssueWithRef = opts.started?.["task_source"] === "issue" && typeof issueRef === "string" && issueRef !== "";
    if (isIssueWithRef && opts.comment) {
      const out = await opts.comment({ env, runId: opts.runId, issueRef: issueRef as string, reason, prUrl });
      log.append("issue.commented", null, { argv: out?.argv ?? [], ok: out?.ok ?? false, reason });
    } else if (!blocked) process.stderr.write(`engine10: run ${opts.runId} ended FAILED with no PR: ${reason}\n`);
  }
  log.append("run.completed", null, { verdict, pr_url: prUrl, not_proven: notProven, cost_usd: costUsd, wall_s: wallS, pre_model: preModelTiming(allEvents, t0) }); // D61-1
  log.sealLog();
  const stages = allEvents.filter((e) => e.type === "stage.completed" && typeof e.data.duration_s === "number").map((e) => ({ label: String(e.stage), seconds: e.data.duration_s as number })), // E-48 notify: Slack when configured, no-op otherwise
    pc = partialCost(allEvents, log.tampered),
    summary = { pr: prUrl ? { url: prUrl, draft: verdict !== "VERIFIED" } : null, verdict, outcome, notProven, flaky: [] as string[], wallS, stages, cost: { usd: costUsd, provider: String(opts.started?.provider ?? ""), tokens: summaryTokens(folded, allEvents.some((e) => e.type === "cost")), partialUsd: pc.usd, measuredSessions: pc.measured, totalSessions: pc.total } };
  await slackEvent(env, "finished", { summary: formatSummary(summary), outcome: String(outcome), cost: summary.cost.usd != null ? `$${summary.cost.usd.toFixed(2)}` : "not measured", time: `${Math.round(wallS)}s` }); rmRunPid(); process.off("exit", rmRunPid); // D51-A4, replaces E-48 adapters/slack.ts call
  return { verdict, outcome, stop: stop ?? (receiptVerdict && allEvents.some((e) => e.type === "cap.hit") ? "cap" : null), receiptSha: typeof sealedData?.receipt_sha256 === "string" ? sealedData.receipt_sha256 : null, tampered: log.tampered, notProven, prUrl, workerExit };
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
/** The block main() writes to stdout once a run finishes; pure because main() re-spawns process.argv[1] as the worker, so tests cannot drive it. */
export function renderMainOutput(events: EventEnvelope[], summary: SummaryInput, verbose = true): string {
  const c = alreadyDoneTextComment(events), un = unmergedLokiWorkNote(events);
  const pm = (events.findLast((e) => e.type === "run.completed")?.data.pre_model ?? null) as PreModelTiming | null;
  return `${c ? `\n${c}\n` : ""}${un ? `\n${un}\n` : ""}${verbose ? formatPreModelLine(pm) : ""}${formatSummary(summary)}\n`;
}
const ISSUE_RE = /^(?:[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+\/(?:-\/)?issues\/\d+)$/;
// E-59: every token field the provider reported, cache included (E-50 found "1k shown for 372k used" when this summed only input+output). The sole place tokens are computed for the Cost line.
export function summaryTokens(f: Folded, sawCost: boolean): number | null {
  return sawCost ? f.cost.inputTokens + f.cost.outputTokens + f.cost.cacheReadTokens + f.cost.cacheCreationTokens : null;
}
export { partialCost }; // E-69: defined in events.ts, next to fold(); re-exported so existing callers/tests keep importing it from here
export async function main(args: string[]): Promise<number> { // `loki "<task>"` (cli.ts routes every run here): P0 of one run, ending in the 5-line summary
  const words: string[] = [];
  let specFile: string | null = null, maxCost: string | null = null, noPr = false, deep = false, json = false, verbose = false, provider = process.env.LOKI_PROVIDER || "claude";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-pr") noPr = true;
    else if (a === "--deep") deep = true;
    else if (a === "--json") json = true;
    else if (a === "--verbose") verbose = true;
    else if (a.startsWith("--max-cost")) maxCost = a.includes("=") ? a.slice(11) : args[++i] ?? "";
    else if (a === "--provider") provider = args[++i] ?? provider;
    else if (a === "--spec") specFile = args[++i] ?? "";
    else if (a.startsWith("--spec=")) specFile = a.slice(7);
    else if (a === "--resume") { process.stderr.write("engine10: --resume was removed; start a new run\n"); return 2; }
    else words.push(a);
  }
  let task = words.join(" ").trim();
  let spec: LoadedSpec | null = null;
  if (specFile !== null) { // SPEC-FIRST-INTENT: refuse a spec that does not parse (exit 2, with the line) before any run state exists
    try { spec = loadSpecFile(resolve(specFile)); } catch (e) { process.stderr.write(`engine10: ${(e as Error).message}\n`); return 2; }
    if (!task) task = spec.task;
  }
  if (!task) { process.stderr.write("engine10: no task given\n"); return 2; }
  let repoDir: string;
  try {
    repoDir = safeGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  } catch { process.stderr.write("engine10: not inside a git repository\n"); return 2; }
  const runId = `e10-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${Math.random().toString(16).slice(2, 6)}`;
  const runDir = join(repoDir, ".loki", "runs", runId);
  const cap = resolveCap(maxCost, repoDir); if ("error" in cap) { process.stderr.write(`engine10: ${cap.error}\n`); return 2; }
  const trackerRef = parseTrackerRef(task), isIssue = ISSUE_RE.test(task) || trackerRef !== null, model = resolveModel(provider), env: NodeJS.ProcessEnv = { ...process.env };
  { // D61-11b: unit intake first (fails closed, so a unit is never split into a group); its frozen spec and cost cap reach the worker env
    const u = (await import("../features/speed/unit_mode.ts")).unitIntake(process.env, repoDir, cap.usd);
    if (u && !u.ok) { process.stderr.write(`engine10: ${u.note}\n`); return 2; }
    if (u) { Object.assign(env, u.env); cap.usd = parseCapUsd(env.LOKI_E10_MAX_COST_USD) ?? cap.usd; }
  }
  if (process.env.LOKI_SPEED !== "0" && !isIssue) { const g = await (await import("../features/speed/route.ts")).maybeRunGroup(task, repoDir, process.env); if (g.code !== null) return g.code; task = g.task; } // D61-16: group entry; fallback runs on the text the group saw
  if (spec) { // the worker reads the snapshot of exactly the bytes hashed here, never the live file
    mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, "spec.snapshot.md"), spec.raw);
    for (const e of [env, process.env]) { e.LOKI_E10_SPEC_PATH = relative(repoDir, spec.path); e.LOKI_E10_SPEC_SHA256 = spec.sha256; e.LOKI_E10_REPO_DIR = repoDir; }
  }
  env.LOKI_E10_MAX_COST_USD = String(cap.usd); if (!isIssue) env.LOKI_E10_TASK_TEXT = task;
  else if (isIssue) {
    mkdirSync(runDir, { recursive: true }); // runDir must exist before the fetch child writes issue.json
    try { if (trackerRef) await fetchTrackerIssueToFile(trackerRef, join(runDir, "issue.json")); else fetchIssueToFile(task, join(runDir, "issue.json")); } catch (err) { // P1: deterministic, before any LLM
      process.stderr.write(`engine10: issue fetch failed: ${(err as Error).message.split("\n")[0]}\n`);
      return 2;
    }
  }

  const routeStart = routeStartLine(process.env, provider); // FC-35: printed before any stage, so it states the pre-plan state only (route.json does not exist yet). R1-15: null unless LOKI_ROUTER is on, so the start line is byte-identical otherwise
  const costEst = encodeEstimate(process.env, repoDir, undefined, model); if (costEst) env.LOKI_E10_COST_ESTIMATE = costEst; // 11.3.0 T1: null under LOKI_COST_PREVIEW=0
  const downgrades = modelDowngrades(provider); // D86 L1: any downgrade is printed here and recorded on run.started (key only when non-empty, receipt hashes stay stable)
  if (!json) process.stdout.write(`${START_LINE}, ${baseLine(repoDir)}, ${capNote(cap.usd, cap.source)}${downgrades.length ? `; downgrade: ${downgrades.map((d) => `${d.stage} ${d.model} (${d.reason})`).join(", ")}` : ""}${routeStart ? `; ${routeStart}` : ""}${costEst ? `; ${startText(JSON.parse(costEst))}` : ""}\n`); if (verbose && !json && cap.source === "subscription") process.stdout.write(`${SUBSCRIPTION_NOTE}\n`); // D48: one start line naming the engine; provider, model and run id are in the receipt
  const t0 = Date.now();
  const eventsPath = join(repoDir, eventsRelPath(runId));
  const live = (e: EventEnvelope): void => {
    const clockS = (Date.parse(e.ts) - t0) / 1000;
    const d = e.data;
    if (e.type.startsWith("stage.") && e.type !== "stage.started") {
      const status = e.type === "stage.completed" ? "done" : e.type === "stage.failed" ? "failed" : "skipped";
      process.stdout.write(formatStageLine({ clockS, name: String(e.stage), status, durationS: Number(d.duration_s ?? 0), detail: String(d.reason ?? d.summary ?? "") }) + "\n");
    } else if (e.type === "heartbeat") {
      const diff = d.diff as { files: number; insertions: number; deletions: number } | null;
      process.stdout.write(formatHeartbeatLine({ clockS, stage: String(e.stage), waitingOn: `${provider} session`, elapsedS: Number(d.elapsed_s ?? 0), diff }) + "\n");
    }
  };
  let stopTail = (): void => {};
  const tailTimer = setInterval(() => {
    if (verbose && !json && existsSync(eventsPath)) { clearInterval(tailTimer); stopTail = tail(eventsPath, live, { intervalMs: 250 }); }
  }, 100);
  let liveStop = (): void => {}; // D82: quiet-mode progress (verbose already prints stage lines)
  const liveLine = !verbose && !json ? new LiveLine({ tty: !!process.stdout.isTTY, write: (x) => { process.stdout.write(x); }, columns: terminalWidth(), graceS: 3 }) : null;
  if (liveLine) {
    if (process.env.LOKI_CONTROL_PLANE_URL) liveLine.setUrl(process.env.LOKI_CONTROL_PLANE_URL);
    let stopLiveTail = (): void => {}; const tick = setInterval(() => liveLine.tick(), 1000);
    const wait = setInterval(() => { if (existsSync(eventsPath)) { clearInterval(wait); stopLiveTail = tail(eventsPath, (e) => liveLine.onEvent(e), { intervalMs: 250 }); } }, 100);
    liveStop = () => { clearInterval(wait); clearInterval(tick); stopLiveTail(); liveLine.clear(); };
  }
  const sized = deep ? null : resolveRunCapS(repoDir, cap.usd <= 0, env), capS = sized?.capS ?? DEEP_CAP_S;
  if (sized) { env.LOKI_E10_CAP_S = String(capS); if (sized.fixedS) env.LOKI_E10_CAP_FIXED_S = String(sized.fixedS); else delete env.LOKI_E10_CAP_FIXED_S; } // FC-21b: starts at DEFAULT_CAP_S; the worker resizes once after plan from plan-scope.json unless the cap is fixed
  const res = await runSupervisor({
    runId, repoDir, env, capS, capCeilingS: sized?.ceilingS,
    workerArgv: [process.execPath, resolve(process.argv[1]!), "engine10", "worker", runId, provider, model, deep ? "deep" : "fast"], deepArgv: noPr ? undefined : [process.execPath, resolve(process.argv[1]!), "engine10", "deep-worker", runId, provider, model],
    started: {
      task_source: isIssue ? "issue" : "text", issue_ref: isIssue ? task : null, provider, model, deep, cap_s: capS, cap_ceiling_s: sized?.ceilingS ?? capS, max_cost_usd: cap.usd,
      model_override_applied: !!process.env.LOKI_MODEL_OVERRIDE && provider === "claude", branch: `loki/${runId}`,
      ...(downgrades.length ? { downgrades } : {}),
    },
    pr: noPr ? undefined : async ({ pushEnv, verdict, notProven }) => {
      const { loadRunOutputs } = await import("../util/run_outputs.ts"), { runPr } = await import("./stages/pr.ts"); // supervisor-only: the worker never loads pr.ts
      const events = readEvents(eventsPath);
      const sealed: Record<string, unknown> = { ...((events.findLast((e) => e.type === "receipt.sealed")?.data ?? {}) as Record<string, unknown>), not_proven: notProven }; // notProven (backstop/tamper included): a killed worker never sealed a receipt; explicit Record annotation keeps sealed.path typed instead of narrowing to the {} branch of the ?? union (TS2339, E-67 round 5 REJECT finding 2)
      const r = await runPr({
        runId, repoDir, runDir, branch: `loki/${runId}`, pinnedOrigin: pushEnv._LOKI_PINNED_ORIGIN,
        outputs: () => ({ ...loadRunOutputs(runDir, events), seal: { ...sealed, verdict, receipt_path: sealed.path } }), // L7: the PR body reads recorded intake, plan and verify data, not only seal
        capHit: () => events.some((e) => e.type === "cap.hit"),
        emit: () => {}, // pr.opened is appended by runSupervisor from the outcome
      } as unknown as PrContext, new AbortController().signal);
      const d = r.data as { pr_url?: string; draft?: boolean; existing?: boolean | null; not_proven?: string[] };
      if (r.status !== "completed") return { url: null, draft: false, existing: null, notProven: [`PR not opened: ${r.reason}`] };
      return { url: d.pr_url ?? null, draft: d.draft === true, existing: d.existing ?? null, notProven: d.not_proven };
    },
    comment: noPr ? undefined : async ({ issueRef, reason, prUrl }) => { // E-67: a FAILED, no-diff issue run has no PR; comment instead of vanishing
      const { DEFAULT_PUSH_SH } = await import("./stages/pr.ts"); // supervisor-only, same credentialed script as pr
      mkdirSync(runDir, { recursive: true });
      const bodyFile = join(runDir, "backstop-comment.md");
      writeFileSync(bodyFile, `Loki 10 run ${runId} ${prUrl ? `opened draft PR ${prUrl}` : "ended without a PR"}.\n\n${prUrl ? "One question" : "Reason"}: ${reason}\n`);
      const argv = pushArgv({ cmd: "issue-comment", issueRef, bodyFile });
      const r = spawnSync("bash", [DEFAULT_PUSH_SH, ...argv], { env, encoding: "utf8" });
      return { argv, ok: r.status === 0 };
    },
  }).catch((e) => { if (!(e instanceof PreflightError)) throw e; process.stderr.write(`${e.message}\n`); return null; });
  clearInterval(tailTimer);
  if (!res) { stopTail(); liveStop(); return 2; } // preflight refused: exit 2 with the fatal line, before any run state
  await new Promise((r) => setTimeout(r, 300)); // let the tail flush the last lines
  stopTail(); liveStop();

  const events = readEvents(eventsPath), f = fold(events);
  const sawCost = events.some((e) => e.type === "cost"), cli = process.env.LOKI_E10_INVOKER === "cli";
  const pc = partialCost(events, res.tampered), usd = res.tampered ? null : f.cost.usd; // E-69: same tamper guard as costUsd elsewhere -- a TAMPERED run never prints a trusted dollar figure
  const out = json ? `${JSON.stringify({ ok: EXIT[res.outcome] === 0, outcome: res.outcome, stop: res.stop, run_id: runId, receipt_sha256: res.receiptSha })}\n` : renderMainOutput(events, {
    pr: res.prUrl ? { url: res.prUrl, draft: res.verdict !== "VERIFIED" } : null,
    verdict: res.verdict, outcome: res.outcome, reason: reasonOf(events, res.tampered, res.stop, res.outcome), receipt: { sha: res.tampered ? null : res.receiptSha, tampered: res.tampered, signed: res.tampered ? null : (events.findLast((e) => e.type === "receipt.sealed")?.data.signed as boolean | undefined) ?? null }, notProven: res.notProven, flaky: [],
    cost: {
      usd, provider, tokens: summaryTokens(f, sawCost), note: !res.tampered && cli && (usd === null || events.some((e) => e.type === "cost" && e.data.source === "cli-invoker-unmetered")) ? "CLI invoker records no cost" : null,
      partialUsd: pc.usd, measuredSessions: pc.measured, totalSessions: pc.total,
    },
    wallS: Number(f.run.completed?.data.wall_s ?? (Date.now() - t0) / 1000),
    stages: events.filter((e) => e.type === "stage.completed" && typeof e.data.duration_s === "number")
      .map((e) => ({ label: String(e.stage), seconds: e.data.duration_s as number })),
  }, verbose);
  process.stdout.write(out);
  return EXIT[res.outcome];
}
