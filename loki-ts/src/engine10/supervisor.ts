// Loki 10 supervisor (P0, docs/v10/ENGINE.md sections 5, 6, 10): eval marker first, origin pinned once, worker spawned with withheld tokens; single writer of events.jsonl (seq, hash, tamper refusal) id; post-PR: detached deep verify, then Slack notify.
import { routeStartLine } from "../runner/router/route_block.ts";
import { execFileSync, spawn, spawnSync } from "node:child_process"; import { currentBranch, restoreBranch } from "../e10ext/stop_restore.ts";
import { createHash, createPublicKey, sign, type Hash } from "node:crypto";
import { redactEventData } from "../util/redact.ts"; import { localBranchNote, resolveRunCapS } from "../util/run_cap.ts"; import { safeGit } from "../util/safe_git.ts";
import { terminalWidth } from "../util/term_width.ts";
import { diffStat, formatRunSummary, handoffSection, readRiskSummary, writeHandoff, withNextLine, withRiskLine, nextOf, resultOf, summaryObject, useColor } from "../util/run_summary.ts"; // OC-OUTPUT, RISKTIER
import { guardedBackstop, validBase } from "../e10ext/commit_filter.ts";
import { kidOf, loadSigningKey } from "./stages/seal.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path"; import { writeRunState } from "../util/seal_drift.ts";
import { loadSpecFile, type LoadedSpec } from "../util/spec_file.ts";
import { eventsRelPath, githubRepoFromUrl, readOriginUrl, writeEngineMarker } from "../util/engine_origin.ts";
export { eventsRelPath, githubRepoFromUrl, readOriginUrl, writeEngineMarker }; // re-exported: callers and tests import these from here
import { stageCapability, workerStages } from "./worker.ts"; import { withholdGithubTokens } from "../runner/github_token.ts"; import { readAliveBeat, writeAliveBeat, writeRunPid } from "../util/run_pid.ts";
import { EventLog, conflictReasonOf, fold, partialCost, runCostUsd, summaryCost, readEvents, tail } from "./events.ts"; import { stageShareText } from "../util/cost_breakdown.ts";
import { disclosureLine } from "../providers/provider_guard.ts";
import { budgetNext, capNote, groupEnv, parseCapUsd, priorSpend, resolveCap, SUBSCRIPTION_NOTE, unenforceableNote, writeBudgetStop } from "../e10ext/budget_cap.ts";
import { fetchIssueToFile } from "./fetch_issue.ts";
import { fetchTrackerIssueToFile, parseTrackerRef } from "../features/tracker_intake.ts";
import { formatHeartbeatLine, formatStageLine, formatSummary, preModelTiming, EXIT, outcomeOf, reasonOf, type Outcome } from "./output.ts";
import { LiveLine } from "../e10ext/liveline.ts";
import { SAFE_BUN_FLAGS, envWithPwd, killGroup, spawnWorker, ulimitArgv } from "../runner/worker_proc.ts";
import { askIntent } from "../util/intent_card.ts";
import { assertPreflight, PreflightError } from "./preflight.ts"; import { noteRefusal, noteRefusalFromEvents, type PreflightBlocker } from "../util/funnel.ts";
import { resolveModel } from "./session.ts";
import { cleanTreeId, failedCheckNames, recordFingerprints } from "../util/failure_memory.ts";
import { modelDowngrades } from "../runner/model_downgrades.ts";
import { runIdentity } from "../util/run_identity.ts";
import type { PrContext } from "./stages/pr.ts";
import { type EventEnvelope, type PushEnv, type StageName, type Verdict, backstopS, BACKSTOP_GRACE_S, DEEP_CAP_S, DEFAULT_CAP_S, envCapS, pushArgv, STAGE_BUDGETS } from "./types.ts";
import { baseLine, dropEmptyRunBranch } from "../util/base_guard.ts";
import { alreadyDoneTextComment, policyGate, prGate, renderMainOutput, runIntent, summaryCache, summaryTokens, unmergedLokiWorkNote, type PolicyGate } from "../util/run_outputs.ts";

export { backstopS, BACKSTOP_GRACE_S }; // re-exported: callers import the backstop math from here, its home before r4
import { createStuckWatch, stuckMinutes } from "../util/slack_events.ts";
import { encodeEstimate, startText } from "../runner/router/cost_preview.ts";
export const START_LINE = "Loki 10 engine";
export const TAMPER_NOT_PROVEN = "event log modified outside the engine";
async function slackEvent(...a: Parameters<typeof import("../util/slack_events.ts").notifyEvent>): Promise<void> { try { await (await import("../util/slack_events.ts")).notifyEvent(...a); } catch { /* best-effort */ } }
const SUPERVISOR_ONLY = new Set(["run.started", "run.completed", "tamper.detected", "run.resumed", "pr.opened", "log.sealed", "deep.started", "already.attested", "capability.recorded"]); // types only the supervisor may write; same types from the worker are dropped
const VERDICTS = new Set<string>(["VERIFIED", "PARTIAL", "ALREADY_SATISFIED", "SPEC_CONFLICT", "FAILED"]);
const ALIVE_BEAT_MS = 15_000;
const SESSION_EXITS = new Set(["done", "already_done", "spec_conflict", "killed", "error"]);
export const BACKSTOP_NOT_PROVEN = "worker killed by the supervisor backstop (cap minus grace)";

const isRev = (r: unknown): boolean => typeof r === "object" && r !== null && Number.isInteger((r as { rev?: unknown }).rev) && nonNegNum((r as { at?: unknown }).at);
const nonNegNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
function dataOk(type: string, d: Record<string, unknown>): boolean { // per-type data checks for events the supervisor itself acts on (section 7 table)
  if (type === "session.ended") {
    return typeof d.session_id === "string" && SESSION_EXITS.has(d.exit as string) && nonNegNum(d.duration_s);
  }
  if (type === "stage.started" && d.start_ms !== undefined) return nonNegNum(d.start_ms) && (d.start_ms as number) <= Date.now() + 1000; // P12-07d: a forged far-future Wall start is dropped
  if (type === "intent.revised") return Array.isArray(d.revisions) && d.revisions.every(isRev);
  if (type === "cost") return typeof d.session_id === "string" && (d.usd === null || nonNegNum(d.usd));
  return true;
}
export interface PrOutcome { url: string | null; draft: boolean; existing: boolean | null; notProven?: string[] } // local types (not in types.ts): the PR hook E-11 (stages/pr.ts) plugs into, and the result
export type PrStep = (p: {
  env: NodeJS.ProcessEnv; // the supervisor's own credentialed env (read-only by contract)
  pushEnv: PushEnv; // origin pin from memory, never from the log
  recordSpawnEnv: (spawnEnv: NodeJS.ProcessEnv) => void; // GAME10-05a: the pr stage hands over the exact env object it spawns the push script with; the capability record is read from it
  runId: string; repoDir: string; verdict: Verdict;
  notProven: string[]; // accumulated so far (backstop/tamper included): the only place the PR body learns why when a killed worker never sealed a receipt
}) => Promise<PrOutcome | null>;
// Backstop fallback for a FAILED run with no PR (no diff, or no remote): on an issue run, posts a comment naming the reason instead of vanishing.
export type CommentStep = (p: { env: NodeJS.ProcessEnv; runId: string; issueRef: string; reason: string; prUrl?: string | null }) => Promise<{ argv: string[]; ok: boolean; skipped?: boolean } | null>;
export type StatusStep = (p: { prUrl?: string | null; outcome?: string; reason?: string }) => Promise<{ argv: string[]; ok: boolean; skipped?: boolean } | null>; // FV-gh-steer-3: upserts the one status comment on the issue
export interface SupervisorOptions {
  runId: string;
  repoDir: string;
  workerArgv: string[]; // argv of the worker process, e.g. [bun, cli, "engine10", "worker", ...] (wired by E-12)
  env?: NodeJS.ProcessEnv; // defaults to process.env; never mutated
  started?: Record<string, unknown>; // extra run.started data (task_source, provider, model, issue_ref, ...)
  pr?: PrStep; deepArgv?: string[]; // pr absent means no PR; deepArgv absent means no detached deep verify after pr.opened
  comment?: CommentStep; status?: StatusStep; // comment absent = no issue-comment fallback (a FAILED, no-diff issue run then only prints); status (issue runs) replaces it, the failure reason rides in the status comment
  capCeilingS?: number; // FC-21b: the backstop is set here (the most the worker's resized cap can reach), not at the initial cap
  capS?: number; // global cap in seconds (default LOKI_E10_CAP_S, else DEFAULT_CAP_S); the backstop fires at cap minus grace
  graceS?: number; // default BACKSTOP_GRACE_S
  restoreBranch?: string | null; // P12-07i: the user's branch before a resume checkout, restored on stop instead of the run branch
  resume?: boolean; // P12-07i: re-enter an interrupted run: appends run.resumed instead of run.started and tells the worker to restore settled stages
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
  constructor(readonly path: string, private readonly runId: string) {
    this.log = new EventLog(path, runId);
    this.hash = createHash("sha256"); // seed AFTER construction: EventLog may truncate a torn last line
    try { this.hash.update(readFileSync(path)); } catch { /* new file */ }
  }
  private implementOpen = false; // P12-07j: implement started and not yet settled; the only window a deferred already-done hit can be genuine
  append(type: string, stage: StageName | null, data: Record<string, unknown>): EventEnvelope {
    const e = this.log.append(type, stage, redactEventData(type, data) as Record<string, unknown>); // EL-FC08b: redact before the line is written, hashed and sealed, so the CP hashes the same bytes; seal crypto fields are exempt by type
    this.hash.update(JSON.stringify(e) + "\n");
    if (stage === "implement") { if (type === "stage.started") this.implementOpen = true; else if (type === "stage.completed" || type === "stage.failed" || type === "stage.skipped") this.implementOpen = false; }
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
    // P12-07j (D61-04): resume trusts only the supervisor-written already.attested. The worker's already.satisfied is attested here, and only for a well-formed deferred hit on intake while implement is in flight; anything else stays an inert note.
    const d = data as Record<string, unknown>, ev = d["evidence"];
    if (type === "already.satisfied" && stage === "intake" && this.implementOpen && d["deferred"] === true && d["already_satisfied"] === true && Array.isArray(ev) && ev.length > 0 && ev.every((x) => typeof x === "string" && x !== "")) this.append("already.attested", "intake", { already_satisfied: true, evidence: ev });
    return e;
  }
  sealLog(): void { // A-117: signed line after run.completed over every earlier byte, so deleting the tail or the line itself breaks `loki verify`; unsigned runs have no key and skip it
    const key = loadSigningKey(false);
    if (!key) return;
    const sha = this.hash.copy().digest("hex");
    this.append("log.sealed", null, { kid: kidOf(createPublicKey(key)), events_sha256: sha, tampered: this.tampered, sig: sign(null, Buffer.from(`${sha}:${this.tampered}`), key).toString("base64url") });
  }
  receiptSha: string | null = null; state(s: "open" | "closed", outcome?: string): void { writeRunState(dirname(this.path), this.runId, { state: s, tampered: this.tampered, receipt_sha256: this.receiptSha, outcome }); } // run.state.json: the supervisor's integrity verdict, outside the truncatable log tail
  checkpoint(sha: unknown): void { this.receiptSha = typeof sha === "string" ? sha : null; this.verify(); this.sealLog(); this.state("open"); } // right after receipt.sealed: a signed log.sealed carrying the tamper flag, so a publish resume trusts nothing past it and a cut tail cannot turn a tampered run into a clean one
  verify(): boolean { // re-hashes the file; on mismatch (once) emits tamper.detected; returns true when intact
    if (this.tampered) return false;
    const expected = this.hash.copy().digest("hex");
    let actual = "";
    try { actual = createHash("sha256").update(readFileSync(this.path)).digest("hex"); } catch { /* deleted */ }
    if (actual === expected) return true;
    this.tampered = true;
    this.append("tamper.detected", null, { expected_sha256: expected, actual_sha256: actual }); this.state("closed", "TAMPERED");
    return false;
  }
}
/** P12-07l: the worker cap env. A deep worker reads the same cap env as fast, never a stale user value; a sized (fast) run also pins or clears the fixed-cap marker. */
export function applyCapEnv(env: NodeJS.ProcessEnv, capS: number, sized: { fixedS?: number } | null): void {
  env.LOKI_E10_CAP_S = String(capS);
  if (sized) { if (sized.fixedS) env.LOKI_E10_CAP_FIXED_S = String(sized.fixedS); else delete env.LOKI_E10_CAP_FIXED_S; }
}
export async function runSupervisor(opts: SupervisorOptions): Promise<SupervisorResult> {
  const t0 = Date.now();
  const startedProvider = opts.started?.["provider"]; // E-36: provider read off opts.started, not a dedicated field (main(), below, is the only populater)
  const env = opts.env ?? process.env;
  await assertPreflight({ repoDir: opts.repoDir, provider: typeof startedProvider === "string" ? startedProvider : "claude", pr: opts.pr !== undefined, env, runDir: join(opts.repoDir, ".loki", "runs", opts.runId) });
  writeEngineMarker(opts.repoDir, opts.runId); // first: a failing run still leaves it
  const origin = readOriginUrl(opts.repoDir); const rmRunPid = writeRunPid(join(opts.repoDir, ".loki", "runs", opts.runId), opts.runId); process.once("exit", rmRunPid); // origin pinned once, before any provider runs; CPE-09 run.pid for Control Plane Stop, removed on every exit path
  const log = new SupervisorLog(join(opts.repoDir, eventsRelPath(opts.runId)), opts.runId);
  // P0: a caller-built env (tests pass a minimal one) that omits LOKI_CONTROL inherits the process-level off switch the test preload sets.
  if ((env.LOKI_CONTROL ?? process.env.LOKI_CONTROL) !== "0") void import("../e10ext/ship_hook.ts").then((m) => m.startShip(opts.repoDir, log.path, env)).catch(() => {}); // CP-02: D56 shipper, off with LOKI_CONTROL=0
  const aliveDir = join(opts.repoDir, ".loki", "runs", opts.runId), lastAlive = opts.resume ? readAliveBeat(aliveDir) : null; // P12-07n: read before the first fresh beat overwrites it
  log.append(opts.resume ? "run.resumed" : "run.started", null, { ...opts.started, ...(opts.resume ? { phase: "stage", ...(lastAlive ? { last_alive_ts: new Date(lastAlive).toISOString() } : {}) } : {}), origin_repo: githubRepoFromUrl(origin) }); if (!opts.resume) void import("../integrations/writeback.ts").then((m) => m.writeBack({ phase: "started", verdict: "", prUrl: null, receiptSha256: null, task: "" }, env)); // P12-18: opt-in tracker "started" comment + transition, never throws
  const stuck = createStuckWatch(stuckMinutes(env), Date.now(), (f) => { // PG-24: one alert per silence, stderr always, Slack when configured
    process.stderr.write(`engine10: no event for ${stuckMinutes(env)} min; last stage ${f.stage} at ${f.lastEventAt}; ${f.action}\n`); void slackEvent(env, "stuck", f); });
  writeAliveBeat(aliveDir); const beat = setInterval(() => { writeAliveBeat(aliveDir); stuck.tick(Date.now()); }, ALIVE_BEAT_MS); beat.unref(); // cheap heartbeat for quiet stages (a long verify emits no events)
  const workerEnv: NodeJS.ProcessEnv = { ...env }; // withholdGithubTokens mutates its argument: always a copy, never env itself
  withholdGithubTokens(workerEnv); if (opts.resume) workerEnv.LOKI_E10_RESUME = "1";
  // T3: the worker has no terminal; only the supervisor can ask the LOKI_CONFIRM question.
  workerEnv.LOKI_INTENT_TTY = env.LOKI_CONFIRM === "1" && process.stdin.isTTY === true && process.stdout.isTTY === true ? "1" : "0";
  const capS = opts.capS ?? envCapS(env.LOKI_E10_CAP_S) ?? DEFAULT_CAP_S;
  const ceilingS = Math.max(capS, opts.capCeilingS ?? capS);
  const backstopMs = backstopS(ceilingS, opts.graceS ?? BACKSTOP_GRACE_S) * 1000; // hard SIGKILL safety net for a stage blocking past the worker's own soft cap
  const escalateMs = Math.max(0, Math.min(2000, ceilingS * 1000 - backstopMs)); // SIGTERM->SIGKILL clamped so a trapping worker cannot outlive the cap
  let spawnArgv: string[] = opts.workerArgv; try { spawnArgv = ulimitArgv(opts.workerArgv, workerEnv); } catch { /* spawnWorker refuses the same input */ } log.append("capability.recorded", null, { stages: workerStages().map((st) => stageCapability(st, envWithPwd(workerEnv, opts.repoDir), spawnArgv)) }); // GAME10-05a: worker stages are read from the env and argv spawnWorker is given; pr is recorded by recordSpawnEnv at its own spawn
  let sealed: Record<string, unknown> | null = null; const origBranch = opts.restoreBranch !== undefined ? opts.restoreBranch : currentBranch(opts.repoDir), sessionGroups = new Set<number>(); // session children are detached (own group), so the worker's group kill misses them
  const worker = await spawnWorker(opts.workerArgv, workerEnv, opts.repoDir, backstopMs, escalateMs, (line) => {
    const e = log.ingest(line); if (e) stuck.event(String(e.stage ?? "unknown"), Date.now());
    if (e?.type === "session.started" && typeof e.data.pgid === "number") sessionGroups.add(e.data.pgid); if (e?.type === "receipt.sealed") { sealed = e.data; log.checkpoint(e.data["receipt_sha256"]); }
    if (e?.type === "variant" && e.data.intent_confirm === true && workerEnv.LOKI_INTENT_TTY === "1") {
      void askIntent(String(e.data.card ?? ""), join(opts.repoDir, ".loki", "runs", opts.runId));
    }
  }, (stopped) => { for (const g of sessionGroups) killGroup(g, "SIGKILL"); if (stopped) restoreBranch(opts.repoDir, origBranch); }).finally(() => clearInterval(beat)); // a rejected spawn also stops the beat
  const workerExit = worker.killed ? null : worker.code;
  const sealedData = sealed as Record<string, unknown> | null;
  const v = sealedData?.verdict;
  const receiptVerdict = workerExit === 0 && typeof v === "string" && VERDICTS.has(v), verdict: Verdict = receiptVerdict ? (v as Verdict) : "FAILED"; // FC-21b (3): a sealed receipt is the one source of truth for the outcome
  const notProven = Array.isArray(sealedData?.not_proven) ? (sealedData.not_proven as unknown[]).map(String) : [];
  if (worker.killed) notProven.push(BACKSTOP_NOT_PROVEN); const cancelled: string | null = worker.cancelled ?? (readEvents(log.path).some((e) => e.type === "cancel_effective") ? "request" : null); /* P12-10b: a loki cancel honoured at a stage boundary completes as cancelled too */ if (cancelled) notProven.push(`run cancelled by ${cancelled}`); // SIGINT/SIGTERM: usage so far is kept, no PR or backstop commit
  let prUrl: string | null = null;
  const intact = log.verify(); // unconditional re-check before the PR
  if (!intact) notProven.push(TAMPER_NOT_PROVEN);
  // E-66: already-satisfied opens no PR. E-67: FAILED (including a backstop kill) does not block the PR outright; backstopCommit lands what the kill left uncommitted so the diff below (against intake's base_sha) sees it. No diff falls to the comment/print branch below.
  let hasDiff = false; // P1: every verdict needs a net diff to publish; a SPEC_CONFLICT or PARTIAL that changed nothing must not push an empty branch
  if (!cancelled) {
    const stages = fold(readEvents(log.path)).stages; // A-104c: a failed commit stage already chose what to exclude (Wall files, lockfiles, pre-run dirt); a blanket `add -A` would undo it
    const baseE = stages["intake"], base = validBase(baseE?.type === "stage.completed" ? baseE.data.base_sha : null); // D50-F4b: a worker-written base is never an option or ref
    if (verdict === "FAILED" && stages["commit"]?.type !== "stage.failed") { const why = guardedBackstop(intact, opts.repoDir, workerEnv, opts.runId, base, baseE?.type === "stage.completed" ? baseE.data.preexisting_dirty : undefined, baseE?.type === "stage.completed" ? baseE.data.install_created : undefined, baseE?.type === "stage.completed" ? baseE.data.preexisting_untracked_blobs : undefined); if (why) notProven.push(why); } // no completed intake = no run branch: repoDir is still the user's own branch, never `add -A` there
    if (base === null && verdict !== "FAILED") hasDiff = true; else try { // no recorded base: nothing to compare, keep the pre-P1 behaviour; otherwise // net diff against base (a revert commit can leave HEAD past base with nothing to publish); any failure counts as a diff
      safeGit(opts.repoDir, ["diff", "--quiet", String(base), "HEAD", "--", ".", ":(exclude).loki"], { env: workerEnv, stdio: "ignore" });
    } catch { hasDiff = base !== null; }
  }
  if (!cancelled && verdict !== "VERIFIED") { const ib = fold(readEvents(log.path)).stages["intake"], ibd = ib?.type === "stage.completed" ? ib.data : null, note = dropEmptyRunBranch(opts.repoDir, origBranch, ibd?.branch, validBase(ibd?.base_sha ?? null)); if (note) process.stderr.write(note); } // FC-EMPTY-RUN-BRANCH-LEFT-CHECKED-OUT: a terminal run that committed nothing restores the user's branch and drops its empty run branch
  if (opts.pr && !cancelled && intact && origin && verdict !== "ALREADY_SATISFIED" && verdict !== "VERIFIED" && hasDiff) process.stderr.write(localBranchNote(opts.runId, verdict, opts.repoDir)); // FC-NO-PUSH-UNVERIFIED
  if (opts.pr && !cancelled && intact && origin && verdict === "VERIFIED" && hasDiff) { // FC-NO-PUSH-UNVERIFIED: only a verified success leaves the machine; ALREADY_SATISFIED opens no PR (E-66)
    const pushEnv: PushEnv = { _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: origin };
    const out = await opts.pr({ env, pushEnv, runId: opts.runId, repoDir: opts.repoDir, verdict, notProven, recordSpawnEnv: (spawnEnv) => { log.append("capability.recorded", "pr", { stages: [stageCapability("pr", spawnEnv)] }); } });
    notProven.push(...(out?.notProven ?? []));
    if (out?.url) {
      prUrl = out.url;
      log.append("pr.opened", "pr", { url: out.url, draft: out.draft, existing: out.existing });
      await opts.status?.({ prUrl: out.url }); await slackEvent(env, "pr_opened", { repo: githubRepoFromUrl(origin) ?? undefined, issue: String(opts.started?.["issue_ref"] ?? ""), prUrl: out.url, outcome: verdict }); // D51-A4
      // E-48: deep verify (stages/deep.ts) runs detached, never keeping the supervisor alive; deep.started records the pid so it is never orphaned untracked.
      if (opts.deepArgv) { let argv: string[] | null = null; try { argv = ulimitArgv([...opts.deepArgv, origin], workerEnv); } catch (e) { notProven.push(`deep verify not spawned: ${(e as Error).message}`); } const [cmd, ...dArgs] = argv ?? [], child = argv && cmd ? spawn(cmd, dArgs, { cwd: opts.repoDir, env: workerEnv, stdio: "ignore", detached: true }) : null; child?.on("error", () => {}); if (child?.pid) { child.unref(); log.append("capability.recorded", "deep", { stages: [stageCapability("deep", workerEnv, argv ?? [])] }); log.append("deep.started", "deep", { pid: child.pid }); } else if (argv) notProven.push("deep verify not spawned"); }
    }
  }
  const allEvents = readEvents(log.path), folded = fold(allEvents), lokiRoot = join(opts.repoDir, ".loki"), costUsd = runCostUsd(allEvents, log.tampered, lokiRoot), wallS = (Date.now() - t0) / 1000; // one read, reused for cost and the Slack summary; unknown cost stays null
  const stopRaw = folded.run.escalated?.data.stop, stop = typeof stopRaw === "string" ? stopRaw : null;
  const outcome: Outcome = cancelled ? "CANCELLED" : outcomeOf(verdict, allEvents.some((e) => e.type === "cap.hit"), stop, log.tampered, receiptVerdict), blocked = outcome === "BLOCKED"; let statusReason: string | undefined;
  if (blocked || (verdict === "FAILED" && prUrl === null && !cancelled)) { // E-67: never vanish silently -- an issue run gets a comment naming the reason, anything else is printed. A-110: BLOCKED always posts its one question
    const why = conflictReasonOf(allEvents);
    const reason = blocked ? `spec conflict: ${String(why ?? "see the receipt").replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 500)}` : notProven.join("; ") || "run failed", issueRef = opts.started?.["issue_ref"]; await (await import("../integrations/writeback.ts")).writeBack({ phase: blocked ? "blocked" : "failed", reason, verdict, prUrl, receiptSha256: null, task: "" }, env); // opt-in tracker writeback (key from LOKI_WRITEBACK_ISSUE), never throws
    if (blocked) await slackEvent(env, "blocked", { repo: githubRepoFromUrl(origin) ?? undefined, issue: String(opts.started?.["issue_ref"] ?? ""), question: reason }); // D51-A4
    const isIssueWithRef = opts.started?.["task_source"] === "issue" && typeof issueRef === "string" && issueRef !== ""; if (opts.status) statusReason = reason;
    if (isIssueWithRef && opts.comment && !opts.status) {
      const out = await opts.comment({ env, runId: opts.runId, issueRef: issueRef as string, reason, prUrl });
      log.append("issue.commented", null, { argv: out?.argv ?? [], ok: out?.ok ?? false, ...(out?.skipped ? { skipped: true } : {}), reason });
    } else if (!blocked) process.stderr.write(`engine10: run ${opts.runId} ended FAILED with no PR: ${reason}\n`);
  }
  if (opts.status) { const st = await opts.status({ prUrl, outcome: String(outcome), reason: statusReason }); log.append("issue.commented", null, { argv: st?.argv ?? [], ok: st?.ok ?? false, ...(st?.skipped ? { skipped: true } : {}), reason: statusReason ?? String(outcome) }); }
  log.append("run.completed", null, { verdict, ...(cancelled ? { cancelled: true, signal: cancelled, outcome: "CANCELLED" } : {}), pr_url: prUrl, not_proven: notProven, cost_usd: costUsd, wall_s: wallS, pre_model: preModelTiming(allEvents, t0) }); // D61-1
  log.sealLog(); log.state("closed", outcome); recordFingerprints(join(opts.repoDir, ".loki", "state"), opts.runId, "failed", failedCheckNames(folded.stages["verify"]?.data.checks, folded.stages["verify"]?.data.pre_red_checks as string[] | undefined), cleanTreeId(opts.repoDir)); // Q17-03/FC-LINT-PRE-RED: real failing checks minus base-red, read by decideRecovery so a flaky check does not mask them
  const stages = allEvents.filter((e) => e.type === "stage.completed" && typeof e.data.duration_s === "number").map((e) => ({ label: String(e.stage), seconds: e.data.duration_s as number })), // E-48 notify: Slack when configured, no-op otherwise
    pc = partialCost(allEvents, log.tampered, lokiRoot),
    summary = { pr: prUrl ? { url: prUrl, draft: verdict !== "VERIFIED" } : null, verdict, outcome, notProven, flaky: recordFingerprints(join(opts.repoDir, ".loki", "state"), opts.runId, "flaky", folded.stages["verify"]?.data.flaky, cleanTreeId(opts.repoDir)), wallS, stages, cost: { usd: costUsd, provider: String(opts.started?.provider ?? ""), tokens: summaryTokens(folded, allEvents.some((e) => e.type === "cost")), ...summaryCache(allEvents, log.tampered), partialUsd: pc.usd, measuredSessions: pc.measured, totalSessions: pc.total, stageShares: log.tampered ? null : stageShareText(allEvents), capUsd: Number(opts.started?.["max_cost_usd"]) > 0 ? Number(opts.started?.["max_cost_usd"]) : undefined } };
  await slackEvent(env, "finished", { summary: formatSummary(summary), outcome: String(outcome), cost: summary.cost.usd != null ? `$${summary.cost.usd.toFixed(2)}` : "not measured", time: `${Math.round(wallS)}s`, receipt: log.tampered ? "TAMPERED" : receiptVerdict ? verdict : undefined }); rmRunPid(); process.off("exit", rmRunPid); // D51-A4, replaces E-48 adapters/slack.ts call
  return { verdict, outcome, stop: stop ?? (receiptVerdict && allEvents.some((e) => e.type === "cap.hit") ? "cap" : null), receiptSha: typeof sealedData?.receipt_sha256 === "string" ? sealedData.receipt_sha256 : null, tampered: log.tampered, notProven, prUrl, workerExit };
}
export { alreadyDoneTextComment, policyGate, prGate, renderMainOutput, summaryCache, summaryTokens, unmergedLokiWorkNote, type PolicyGate }; // moved to util/run_outputs.ts (line budget); re-exported for existing callers
const ISSUE_RE = /^(?:[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+\/(?:-\/)?issues\/\d+)$/;
export { partialCost }; // E-69: defined in events.ts, next to fold(); re-exported so existing callers/tests keep importing it from here
/** The end-of-run summary cost inputs, read with the run's .loki root so child sessions join. */
export const runSummaryCost = (events: EventEnvelope[], tampered: boolean, repoDir: string): ReturnType<typeof summaryCost> => summaryCost(events, tampered, join(repoDir, ".loki"));
export async function main(args: string[]): Promise<number> { // `loki "<task>"` (cli.ts routes every run here): P0 of one run, ending in the 5-line summary
  const words: string[] = [];
  let eoo = false, resume = false, fresh = false, quiet = false, specFile: string | null = null, maxCost: string | null = null, noPr = false, sealPatch: string | null = null, deep = false, json = false, verbose = false, provider = process.env.LOKI_PROVIDER || "claude";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-pr") noPr = true;
    else if (a === "--deep") deep = true;
    else if (a === "--json") json = true;
    else if (a === "--verbose") verbose = true;
    else if (a === "--quiet") quiet = true; // OC-OUTPUT: unified summary only
    else if (a === "--max-cost") { const v = args[i + 1]; if (v === undefined || v === "" || v.startsWith("-")) { process.stderr.write("engine10: --max-cost needs a value\n"); noteRefusal("unsupported_flag"); return 2; } maxCost = v; i++; } // TEN-STABILITY-63: a missing or flag-shaped value exits 2 instead of becoming ""
    else if (a.startsWith("--max-cost=")) maxCost = a.slice(11); // TEN-STABILITY-38: exact flag only, so --max-costly is an unknown flag
    else if (a === "--provider") { const v = args[i + 1]; if (v === undefined || v === "" || v.startsWith("-")) { process.stderr.write("engine10: --provider needs a value\n"); noteRefusal("unsupported_flag"); return 2; } provider = v; i++; } // TEN-UX-33: a missing or flag-shaped value never silently keeps the env provider or eats the next flag
    else if (a === "--spec") { const v = args[i + 1]; if (v === undefined || v === "" || v.startsWith("-")) { process.stderr.write("engine10: --spec needs a value\n"); noteRefusal("unsupported_flag"); return 2; } specFile = v; i++; } // TEN-STABILITY-63
    else if (a.startsWith("--spec=")) specFile = a.slice(7);
    else if (a === "--resume") resume = true;
    else if (a === "--fresh") fresh = true; // SB-12: skip the interrupted-run offer
    else if (a === "--seal-existing") { const v = args[i + 1]; if (v === undefined || v === "" || v.startsWith("-")) { process.stderr.write("engine10: --seal-existing needs a patch file\n"); noteRefusal("unsupported_flag"); return 2; } sealPatch = resolve(v); noPr = true; i++; } // CW-12: the changes already exist as this patch; implement applies it instead of running a session, and no PR is ever opened
    else if (a === "--" && !eoo) eoo = true; // TEN-STABILITY-37: `--` ends options, the rest is task text
    else if (!eoo && /^--?[A-Za-z][\w-]*(=\S*)?$/.test(a)) { process.stderr.write(`engine10: unknown flag ${a}\nusage: loki "<task>" [--no-pr] [--deep] [--json] [--verbose] [--quiet] [--max-cost N] [--provider P] [--spec F] [--seal-existing PATCH] [--resume] [--fresh] [-- <task>]\n`); noteRefusal("unsupported_flag"); return 2; } // flag-shaped only: a PRD body starting with "- item" or "---" has whitespace and stays task text
    else words.push(a);
  }
  let task = words.join(" ").trim(); if (resume) return (await import("../util/run_outputs.ts")).resumeFlag(words[0], noPr);
  let spec: LoadedSpec | null = null;
  if (specFile !== null) { // SPEC-FIRST-INTENT: refuse a spec that does not parse (exit 2, with the line) before any run state exists
    try { spec = loadSpecFile(resolve(specFile)); } catch (e) { process.stderr.write(`engine10: ${(e as Error).message}\n`); noteRefusal("prd_missing"); return 2; }
    if (!task) task = spec.task;
  }
  if (!task && !fresh) { const rr = (await import("../util/run_outputs.ts")).startRecovery; try { const rd = safeGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim(), rec = await rr(rd, "", noPr); if (rec !== null) return rec; } catch { /* not a repo: the no-task error below */ } } // SB-12: a bare `loki start` offers or resumes an interrupted run
  if (!task) { process.stderr.write("engine10: no task given\n"); noteRefusal("prd_missing"); return 2; }
  let repoDir: string;
  try {
    repoDir = safeGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  } catch { // TEN-UX-01-F1: the one shared first-run mechanism (empty folder only) runs before the repo check, not only in preflight
    const i = await (await import("../util/first_run_repo.ts")).initEmptyRepo(process.cwd(), process.env);
    if (!i.notice) { process.stderr.write(`engine10: ${i.fatal ?? "not inside a git repository"}\n`); noteRefusal("not_a_repo"); return 2; }
    process.stderr.write(`engine10: ${i.notice}\n`);
    try { repoDir = safeGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim(); } catch { process.stderr.write("engine10: not inside a git repository\n"); noteRefusal("not_a_repo"); return 2; }
  }
  { const rec = await (await import("../util/run_outputs.ts")).startRecovery(repoDir, task, noPr, { fresh }); if (rec !== null) return rec; } // RECOVERY: an interrupted publish for this same task resumes (a TTY is offered the choice) instead of starting over
  const runId = `e10-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${Math.random().toString(16).slice(2, 6)}`;
  const runDir = join(repoDir, ".loki", "runs", runId);
  const cap = resolveCap(maxCost, repoDir); if ("error" in cap) { process.stderr.write(`engine10: ${cap.error}\n`); return 2; }
  const trackerRef = parseTrackerRef(task), isIssue = ISSUE_RE.test(task) || trackerRef !== null, model = resolveModel(provider), env: NodeJS.ProcessEnv = { ...process.env, ...(!quiet && !verbose && !json ? { LOKI_E10_READINESS_FOLD: "1" } : {}) };
  if (quiet || verbose || json) delete env.LOKI_E10_READINESS_FOLD; // an inherited fold flag would hide the Readiness line outside default mode
  if (trackerRef && !process.env.LOKI_WRITEBACK_ISSUE) { process.env.LOKI_WRITEBACK_ISSUE = env.LOKI_WRITEBACK_ISSUE = trackerRef.key; process.env.LOKI_WRITEBACK_KIND = env.LOKI_WRITEBACK_KIND = trackerRef.source; } // writeback keys off the intake ref (direct `loki jira:KEY` path)
  { // D61-11b: unit intake first (fails closed, so a unit is never split into a group); its frozen spec and cost cap reach the worker env
    const u = (await import("../features/speed/unit_mode.ts")).unitIntake(process.env, repoDir, cap.usd);
    if (u && !u.ok) { process.stderr.write(`engine10: ${u.note}\n`); return 2; }
    if (u?.ok && u.note) process.stderr.write(`engine10: ${u.note}\n`);
    if (u) { Object.assign(env, u.env); cap.usd = parseCapUsd(env.LOKI_E10_MAX_COST_USD) ?? cap.usd; }
  }
  if (process.env.LOKI_SPEED !== "0" && !isIssue) { const [rt, sl, vc] = await Promise.all([import("../features/speed/route.ts"), import("./stages/seal.ts"), import("./verify_cmd.ts")]); const g = await rt.maybeRunGroup(task, repoDir, groupEnv(process.env, cap.usd, repoDir), { provider, seal: { receiptSha256: sl.receiptSha256, verifyReceipt: vc.verifyReceipt } }); if (g.code !== null) return g.code; task = g.task; } // D61-16: group entry; fallback runs on the text the group saw
  if (spec) { // the worker reads the snapshot of exactly the bytes hashed here, never the live file
    mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, "spec.snapshot.md"), spec.raw);
    for (const e of [env, process.env]) { e.LOKI_E10_SPEC_PATH = relative(repoDir, spec.path); e.LOKI_E10_SPEC_SHA256 = spec.sha256; e.LOKI_E10_REPO_DIR = repoDir; }
  }
  env.LOKI_E10_MAX_COST_USD = String(cap.usd); const seed = cap.usd > 0 ? priorSpend(repoDir, task) : 0; if (seed > 0) env.LOKI_E10_SPENT_USD = String(seed); if (sealPatch !== null) { if (!existsSync(sealPatch)) { process.stderr.write(`engine10: --seal-existing patch not found: ${sealPatch}\n`); return 2; } env.LOKI_E10_SEAL_EXISTING_PATCH = sealPatch; } if (!isIssue) env.LOKI_E10_TASK_TEXT = task;
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
  if (!json) process.stdout.write(`${START_LINE}, ${baseLine(repoDir)}, ${capNote(cap.usd, cap.source)}${downgrades.length ? `; downgrade: ${downgrades.map((d) => `${d.stage} ${d.model} (${d.reason})`).join(", ")}` : ""}${routeStart ? `; ${routeStart}` : ""}${costEst ? `; ${startText(JSON.parse(costEst), cap.usd)}` : ""}\n`); if (verbose && !json && cap.source === "subscription") process.stdout.write(`${SUBSCRIPTION_NOTE}\n`); // D48: one start line naming the engine; provider, model and run id are in the receipt
  if (costEst && process.env.LOKI_COST_CONFIRM === "1" && process.stdin.isTTY && !json && !(await (await import("../commands/issues_run.ts")).askYesNo("Proceed with this run? [y/N] "))) { process.stdout.write("Run cancelled before start (LOKI_COST_CONFIRM).\n"); return 1; }
  const capLine = !json ? [disclosureLine(provider), unenforceableNote(provider, cap.usd)].filter(Boolean).join("\n") : null; if (capLine) process.stdout.write(`${capLine}\n`); // LM-004: one line when the provider lacks a guarantee claude has; claude prints nothing extra
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
  let reqMap: { requirements: { id: string; text: string; status: string }[] } | null | undefined; // REQTRACE: computed once, before the PR stage, from intake/spec plus verify results; undefined = not yet computed
  const reqOnce = async (evs: ReturnType<typeof readEvents>): Promise<NonNullable<typeof reqMap> | null> => { if (reqMap === undefined) { const rq = await import("../features/contract.ts"); reqMap = rq.writeFromEngine10(repoDir, join(repoDir, ".loki"), runDir, isIssue ? null : task, evs); } return reqMap; }; // also removes a prior run's stale map when this run has no requirements
  const sized = deep ? null : resolveRunCapS(repoDir, cap.usd <= 0, env), capS = sized?.capS ?? DEEP_CAP_S;
  applyCapEnv(env, capS, sized); // FC-21b: starts at DEFAULT_CAP_S; the worker resizes once after plan from plan-scope.json unless the cap is fixed
  const statusStep = noPr || !ISSUE_RE.test(task) ? undefined : (await import("../util/run_outputs.ts")).issueStatusProjector({ pushSh: (await import("./stages/pr.ts")).DEFAULT_PUSH_SH, env, origin: readOriginUrl(repoDir), repoDir, runDir, runId, issueRef: task, eventsPath }), stopPlan = statusStep ? tail(eventsPath, (e) => { if (e.type === "stage.completed" && e.stage === "plan") void statusStep(); }, { intervalMs: 500 }) : () => {};
  let refusedAs: PreflightBlocker = "other"; // AN-08
  const res = await runSupervisor({
    runId, repoDir, env, capS, capCeilingS: sized?.ceilingS,
    workerArgv: [process.execPath, ...SAFE_BUN_FLAGS, resolve(process.argv[1]!), "engine10", "worker", runId, provider, model, deep ? "deep" : "fast"], deepArgv: noPr ? undefined : [process.execPath, ...SAFE_BUN_FLAGS, resolve(process.argv[1]!), "engine10", "deep-worker", runId, provider, model], status: statusStep,
    started: {
      task_source: isIssue ? "issue" : "text", issue_ref: isIssue ? task : null, provider, model, deep, cap_s: capS, cap_ceiling_s: sized?.ceilingS ?? capS, max_cost_usd: cap.usd,
      model_override_applied: !!process.env.LOKI_MODEL_OVERRIDE && provider === "claude", branch: `loki/${runId}`, ...runIntent(repoDir),
      ...(downgrades.length ? { downgrades } : {}), ...runIdentity(repoDir, process.env, model),
    },
    pr: noPr ? undefined : async ({ pushEnv, verdict, notProven, recordSpawnEnv }) => {
      const gate = prGate(repoDir); // autonomy ladder: deny = no PR plus a not-proven line; require_approval = draft PR
      if ("deny" in gate) return { url: null, draft: false, existing: null, notProven: [gate.deny] };
      const { loadRunOutputs } = await import("../util/run_outputs.ts"), { runPr } = await import("./stages/pr.ts"); // supervisor-only: the worker never loads pr.ts
      const events = readEvents(eventsPath);
      const sealed: Record<string, unknown> = { ...((events.findLast((e) => e.type === "receipt.sealed")?.data ?? {}) as Record<string, unknown>), not_proven: "note" in gate && gate.note ? [...notProven, gate.note] : notProven }; // notProven (backstop/tamper included): a killed worker never sealed a receipt; explicit Record annotation keeps sealed.path typed instead of narrowing to the {} branch of the ?? union (TS2339, E-67 round 5 REJECT finding 2)
      const hbase = events.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data.base_sha, hpc = partialCost(events, false, join(repoDir, ".loki")); // HANDOFF: the PR body carries the same handoff
      const handoffMd = handoffSection({ requirements: (await reqOnce(events))?.requirements ?? null, sinceMs: t0, repoDir, runId, events, outcome: String(verdict), usd: runCostUsd(events, false, join(repoDir, ".loki")), partialUsd: hpc.usd, measuredSessions: hpc.measured, totalSessions: hpc.total, elapsedS: null, notProven, baseSha: typeof hbase === "string" ? hbase : null, stats: diffStat(repoDir, typeof hbase === "string" ? hbase : null) });
      const r = await runPr({
        runId, repoDir, runDir, branch: `loki/${runId}`, pinnedOrigin: pushEnv._LOKI_PINNED_ORIGIN, handoffMd,
        outputs: () => ({ ...loadRunOutputs(runDir, events), seal: { ...sealed, verdict, receipt_path: sealed.path } }), // L7: the PR body reads recorded intake, plan and verify data, not only seal
        capHit: () => events.some((e) => e.type === "cap.hit"), draft: gate.draft,
        emit: () => {}, // pr.opened is appended by runSupervisor from the outcome
      } as unknown as PrContext, new AbortController().signal, { onSpawnEnv: recordSpawnEnv });
      const d = r.data as { pr_url?: string; draft?: boolean; existing?: boolean | null; not_proven?: string[] };
      if (r.status !== "completed") return { url: null, draft: false, existing: null, notProven: [`PR not opened: ${r.reason}`] };
      return { url: d.pr_url ?? null, draft: d.draft === true, existing: d.existing ?? null, notProven: d.not_proven };
    },
    comment: noPr ? undefined : async ({ issueRef, reason, prUrl }) => { // E-67: a FAILED, no-diff issue run has no PR; comment instead of vanishing
      const { DEFAULT_PUSH_SH } = await import("./stages/pr.ts"); // supervisor-only, same credentialed script as pr
      mkdirSync(runDir, { recursive: true });
      const bodyFile = join(runDir, "backstop-comment.md");
      writeFileSync(bodyFile, `<!-- loki-backstop -->\nLoki 10 run ${runId} ${prUrl ? `opened draft PR ${prUrl}` : "ended without a PR"}.\n\n${prUrl ? "One question" : "Reason"}: ${reason}\n`);
      const argv = pushArgv({ cmd: "issue-comment", issueRef, bodyFile });
      const origin = readOriginUrl(repoDir), r = spawnSync("bash", [DEFAULT_PUSH_SH, ...argv], { env: origin ? { ...env, _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: origin } : env, encoding: "utf8" }); // the push script refuses an unpinned origin
      return { argv, ok: r.status === 0, ...(/^skipped: /m.test(String(r.stdout)) ? { skipped: true } : {}) };
    },
  }).catch((e) => { if (!(e instanceof PreflightError)) throw e; process.stderr.write(`${e.message}\n`); refusedAs = e.blocker; return null; });
  clearInterval(tailTimer); stopPlan();
  if (!res) { stopTail(); liveStop(); noteRefusal(refusedAs); return 2; } // preflight refused: exit 2 with the fatal line, before any run state
  await new Promise((r) => setTimeout(r, 300)); // let the tail flush the last lines
  stopTail(); liveStop();

  const events = readEvents(eventsPath), f = fold(events); noteRefusalFromEvents(events); // AN-08: an intake refusal (dirty tracked tree) is named by the failed intake event
  const sawCost = events.some((e) => e.type === "cost"), cli = process.env.LOKI_E10_INVOKER === "cli";
  const { usd, pc } = runSummaryCost(events, res.tampered, repoDir); // E-69: same tamper guard as costUsd elsewhere -- a TAMPERED run never prints a trusted dollar figure
  const out = json ? `${JSON.stringify({ ok: EXIT[res.outcome] === 0, outcome: res.outcome, stop: res.stop, run_id: runId, receipt_sha256: res.receiptSha })}\n` : renderMainOutput(events, {
    pr: res.prUrl ? { url: res.prUrl, draft: res.verdict !== "VERIFIED" } : null,
    verdict: res.verdict, outcome: res.outcome, reason: reasonOf(events, res.tampered, res.stop, res.outcome), receipt: { sha: res.tampered ? null : res.receiptSha, tampered: res.tampered, signed: res.tampered ? null : (events.findLast((e) => e.type === "receipt.sealed")?.data.signed as boolean | undefined) ?? null }, notProven: res.notProven, flaky: ((f.stages["verify"]?.data.flaky as unknown[] | undefined) ?? []).filter((n): n is string => typeof n === "string"),
    cost: {
      usd, provider, tokens: summaryTokens(f, sawCost), ...summaryCache(events, res.tampered), note: !res.tampered && cli && (usd === null || events.some((e) => e.type === "cost" && e.data.source === "cli-invoker-unmetered")) ? "CLI invoker records no cost" : null,
      partialUsd: pc.usd, measuredSessions: pc.measured, totalSessions: pc.total, stageShares: res.tampered ? null : stageShareText(events),
    },
    wallS: Number(f.run.completed?.data.wall_s ?? (Date.now() - t0) / 1000),
    stages: events.filter((e) => e.type === "stage.completed" && typeof e.data.duration_s === "number")
      .map((e) => ({ label: String(e.stage), seconds: e.data.duration_s as number })),
  }, verbose);
  const rmap = await reqOnce(events), uncovered = rmap ? rmap.requirements.filter((r) => r.status === "uncovered").length : 0; // REQTRACE: same map the PR body used (or computed now when no PR stage ran)
  const baseSha = events.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data.base_sha, hbs = typeof baseSha === "string" ? baseSha : null, ds = diffStat(repoDir, hbs);
  let handoffRef = ""; if (!json) { handoffRef = writeHandoff({ requirements: rmap?.requirements ?? null, sinceMs: t0, repoDir, runId, events, outcome: res.outcome, reason: reasonOf(events, res.tampered, res.stop, res.outcome), prUrl: res.prUrl, draft: res.verdict !== "VERIFIED", usd, partialUsd: pc.usd, measuredSessions: pc.measured, totalSessions: pc.total, elapsedS: Number(f.run.completed?.data.wall_s ?? (Date.now() - t0) / 1000), notProven: res.notProven, task, baseSha: hbs, stats: ds }) ? "review: .loki/review/HANDOFF.md" : ""; } // HANDOFF: written on every outcome; the pointer folds into the last line (D48 cap)
  // OC-OUTPUT: unified run summary, same format as the legacy engine (autonomy/lib/run-summary.sh)
  const rr = resultOf(res.outcome); if (res.outcome === "BUDGET_STOP" && cap.usd > 0) writeBudgetStop(repoDir, runId, { task: task.trim(), cap_usd: cap.usd, spent_usd: seed + (usd ?? 0), source: cap.source });
  const ui = { result: rr, filesChanged: ds?.files ?? null, insertions: ds?.ins, deletions: ds?.del, costUsd: usd, elapsedS: Number(f.run.completed?.data.wall_s ?? (Date.now() - t0) / 1000), receiptPath: res.receiptSha ? join(runDir, "receipt.json") : null, next: res.outcome === "BUDGET_STOP" && cap.usd > 0 ? budgetNext(seed + (usd ?? 0), cap.usd) : nextOf(rr, ds?.files ?? null, reasonOf(events, res.tampered, res.stop, res.outcome), provider, runId), uncovered }; 
  const rdy = events.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data.readiness, foldTail = [handoffRef, typeof rdy === "string" ? rdy : ""].filter(Boolean).join("; "); // FV-readiness-env-3: D48 default mode folds readiness into the last line
  const riskLine = readRiskSummary(repoDir, t0); // RISKTIER: this run's recorded tier, deferred checks stated as not run
  process.stdout.write(json ? `${JSON.stringify({ ...JSON.parse(out), summary: { ...summaryObject(ui), ...(riskLine ? { risk: riskLine } : {}) } })}\n` : quiet ? withRiskLine(formatRunSummary(ui, { color: useColor() }), riskLine, 99) + (handoffRef ? `${handoffRef}\n` : "") : verbose ? `${out}\n${withRiskLine(formatRunSummary(ui, { color: useColor() }), riskLine, 99)}${handoffRef ? `${handoffRef}\n` : ""}` : withRiskLine(foldTail ? withNextLine(out, ui).replace(/\n$/, `; ${foldTail}\n`) : withNextLine(out, ui), riskLine, 7, capLine ? 1 : 0)); // D48: default output stays within 8 lines, so the summary collapses to one line
  if (!json && res.outcome === "VERIFIED") await import("../util/satisfaction.ts").then((m) => m.maybeAsk({ runId, env: process.env, isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true })).catch(() => {});
  return res.outcome === "CANCELLED" && res.notProven.some((n) => n.endsWith("SIGTERM")) ? 143 : EXIT[res.outcome]; // a SIGTERM cancel keeps the conventional 128+15
}
