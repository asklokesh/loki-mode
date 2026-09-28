// Loki 10 supervisor (P0, docs/v10/ENGINE.md sections 5, 6, 10): eval marker first, origin pinned once, worker
// spawned with withheld tokens; single writer of events.jsonl (seq, hash, tamper refusal); --resume reuses the run
// id; post-PR: detached deep verify, then Slack notify.
import { execFileSync, spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { withholdGithubTokens } from "../runner/github_token.ts";
import { EventLog, fold, readEvents, tail, type Folded } from "./events.ts";
import { fetchIssueToFile } from "./fetch_issue.ts";
import { formatHeartbeatLine, formatStageLine, formatSummary } from "./output.ts";
import { assertPreflight, PreflightError } from "./preflight.ts";
import { resolveModel } from "./session.ts";
import type { PrContext } from "./stages/pr.ts";
import type { EventEnvelope, PushEnv, StageName, Verdict } from "./types.ts";
import { DEEP_CAP_S, DEFAULT_CAP_S, STAGE_BUDGETS } from "./types.ts";

export const TAMPER_NOT_PROVEN = "event log modified outside the engine";
const SUPERVISOR_ONLY = new Set(["run.started", "run.completed", "tamper.detected", "pr.opened"]); // types only the supervisor may write; same types from the worker are dropped
const VERDICTS = new Set<string>(["VERIFIED", "PARTIAL", "ALREADY_SATISFIED", "SPEC_CONFLICT", "FAILED"]);
const SESSION_EXITS = new Set(["done", "already_done", "spec_conflict", "killed", "error"]);
export const BACKSTOP_NOT_PROVEN = "worker killed by the supervisor backstop (cap plus grace)";
export const BACKSTOP_GRACE_S = 60; // seconds past the cap the worker gets to seal and exit before P0 kills its process group
const DRAIN_MS = 2000; // after the worker exits, how long P0 waits for stdout to drain before closing it

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
  runId: string;
  repoDir: string;
  verdict: Verdict;
}) => Promise<PrOutcome | null>;

export interface SupervisorOptions {
  runId: string;
  repoDir: string;
  workerArgv: string[]; // argv of the worker process, e.g. [bun, cli, "engine10", "worker", ...] (wired by E-12)
  env?: NodeJS.ProcessEnv; // defaults to process.env; never mutated
  started?: Record<string, unknown>; // extra run.started data (task_source, provider, model, ...)
  pr?: PrStep; deepArgv?: string[]; // pr absent means no PR; deepArgv absent means no detached deep verify after pr.opened
  capS?: number; // global cap in seconds (default LOKI_E10_CAP_S, else DEFAULT_CAP_S); the backstop fires at cap plus grace
  graceS?: number; // default BACKSTOP_GRACE_S
}
export interface SupervisorResult {
  verdict: Verdict;
  tampered: boolean;
  notProven: string[];
  prUrl: string | null;
  workerExit: number | null;
}
export function eventsRelPath(runId: string): string {
  return `.loki/runs/${runId}/events.jsonl`;
}
export function writeEngineMarker(repoDir: string, runId: string): void { // EV-1 marker, atomic (temp file in the same dir, then rename)
  const dir = join(repoDir, ".loki");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.engine.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ engine: "v10", run_id: runId, events: eventsRelPath(runId) }) + "\n");
  renameSync(tmp, join(dir, "engine.json"));
}
export function readOriginUrl(repoDir: string): string | null {
  try {
    const url = execFileSync("git", ["-C", repoDir, "config", "--get", "remote.origin.url"], { encoding: "utf8", env: process.env }).trim();
    return url || null;
  } catch {
    return null;
  }
}
export function githubRepoFromUrl(url: string | null): string | null {
  const m = url?.match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m?.[1] ?? null;
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
function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch { /* group already gone */ }
}

// Spawns the worker in its own process group, waits for exit plus stdout drain (DRAIN_MS), and backstops at
// backstopMs with SIGTERM then SIGKILL after 2s; exit is null if it never started or was killed by a signal.
function spawnWorker(
  argv: string[], env: NodeJS.ProcessEnv, cwd: string, backstopMs: number, onLine: (l: string) => void,
): Promise<{ code: number | null; killed: boolean }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd) return resolve({ code: null, killed: false });
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "inherit"], detached: true });
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", onLine);
    let killed = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const onStop = (sig: NodeJS.Signals) => { killGroup(child.pid, "SIGKILL"); process.exit(sig === "SIGINT" ? 130 : 143); }; // the worker no longer shares the terminal's group, so forward a stop to it
    process.once("SIGINT", onStop);
    process.once("SIGTERM", onStop);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onStop);
      process.off("SIGTERM", onStop);
      for (const t of timers) clearTimeout(t);
      rl.close();
      child.stdout?.destroy();
      killGroup(child.pid, "SIGKILL"); // reap anything the worker left in its group
      resolve({ code, killed });
    };
    timers.push(setTimeout(() => {
      killed = true;
      killGroup(child.pid, "SIGTERM");
      timers.push(setTimeout(() => killGroup(child.pid, "SIGKILL"), 2000));
    }, backstopMs));
    child.on("error", () => finish(null));
    child.on("exit", (code) => {
      if (child.stdout?.readableEnded) return finish(code);
      child.stdout?.once("end", () => finish(code));
      timers.push(setTimeout(() => finish(code), DRAIN_MS));
    });
  });
}

export async function runSupervisor(opts: SupervisorOptions): Promise<SupervisorResult> {
  const t0 = Date.now();
  const done = fold(readEvents(join(opts.repoDir, eventsRelPath(opts.runId)))).run.completed?.data; // --resume of a finished run: report it, never re-spawn
  if (done) return { verdict: (done.verdict as Verdict) ?? "FAILED", tampered: false, workerExit: 0, prUrl: (done.pr_url as string | null) ?? null, notProven: Array.isArray(done.not_proven) ? (done.not_proven as string[]) : [] };
  const startedProvider = opts.started?.["provider"]; // E-36: provider read off opts.started, not a dedicated field (main(), below, is the only populater)
  const env = opts.env ?? process.env;
  await assertPreflight({ repoDir: opts.repoDir, provider: typeof startedProvider === "string" ? startedProvider : "claude", pr: opts.pr !== undefined, env });
  writeEngineMarker(opts.repoDir, opts.runId); // first: a failing run still leaves it
  const origin = readOriginUrl(opts.repoDir); // pinned once, before any provider runs
  const log = new SupervisorLog(join(opts.repoDir, eventsRelPath(opts.runId)), opts.runId);
  log.append("run.started", null, { ...opts.started, origin_repo: githubRepoFromUrl(origin) });
  const workerEnv: NodeJS.ProcessEnv = { ...env }; // withholdGithubTokens mutates its argument: always a copy, never env itself
  withholdGithubTokens(workerEnv);
  const envCap = Number(env.LOKI_E10_CAP_S);
  const capS = opts.capS ?? (envCap > 0 ? envCap : DEFAULT_CAP_S);
  const backstopMs = (capS + (opts.graceS ?? BACKSTOP_GRACE_S)) * 1000;
  let sealed: Record<string, unknown> | null = null;
  const worker = await spawnWorker(opts.workerArgv, workerEnv, opts.repoDir, backstopMs, (line) => {
    const e = log.ingest(line);
    if (e?.type === "receipt.sealed") sealed = e.data;
  });
  const workerExit = worker.killed ? null : worker.code;
  const sealedData = sealed as Record<string, unknown> | null;
  const v = sealedData?.verdict;
  const verdict: Verdict = workerExit === 0 && typeof v === "string" && VERDICTS.has(v) ? (v as Verdict) : "FAILED";
  const notProven = Array.isArray(sealedData?.not_proven) ? (sealedData.not_proven as unknown[]).map(String) : [];
  if (worker.killed) notProven.push(BACKSTOP_NOT_PROVEN);
  let prUrl: string | null = null;
  const intact = log.verify(); // unconditional re-check before the PR
  if (!intact) notProven.push(TAMPER_NOT_PROVEN);
  if (opts.pr && intact && origin && verdict !== "FAILED") {
    const pushEnv: PushEnv = { _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: origin };
    const out = await opts.pr({ env, pushEnv, runId: opts.runId, repoDir: opts.repoDir, verdict });
    notProven.push(...(out?.notProven ?? []));
    if (out?.url) {
      prUrl = out.url;
      log.append("pr.opened", "pr", { url: out.url, draft: out.draft, existing: out.existing });
      // E-48: deep verify (stages/deep.ts) runs detached, never keeping the supervisor alive; deep.started records the pid so it is never orphaned untracked.
      if (opts.deepArgv) { const [cmd, ...dArgs] = [...opts.deepArgv, origin], child = cmd ? spawn(cmd, dArgs, { cwd: opts.repoDir, env: workerEnv, stdio: "ignore", detached: true }) : null; child?.on("error", () => {}); if (child?.pid) { child.unref(); log.append("deep.started", "deep", { pid: child.pid }); } else notProven.push("deep verify not spawned"); }
    }
  }

  const allEvents = readEvents(log.path), folded = fold(allEvents), costUsd = log.tampered ? null : folded.cost.usd, wallS = (Date.now() - t0) / 1000; // one read, reused for cost and the Slack summary; unknown cost stays null
  log.append("run.completed", null, { verdict, pr_url: prUrl, not_proven: notProven, cost_usd: costUsd, wall_s: wallS });
  const stages = allEvents.filter((e) => e.type === "stage.completed" && typeof e.data.duration_s === "number").map((e) => ({ label: String(e.stage), seconds: e.data.duration_s as number })), // E-48 notify: Slack when configured, no-op otherwise
    pc = partialCost(allEvents, log.tampered),
    summary = { pr: prUrl ? { url: prUrl, draft: verdict !== "VERIFIED" } : null, verdict, notProven, flaky: [] as string[], wallS, stages, cost: { usd: costUsd, provider: String(opts.started?.provider ?? ""), tokens: allEvents.some((e) => e.type === "cost") ? folded.cost.inputTokens + folded.cost.outputTokens : null, partialUsd: pc.usd, measuredSessions: pc.measured, totalSessions: pc.total } };
  try { const { createSlackAdapter } = await import("./adapters/slack.ts"); await Promise.race([createSlackAdapter(env.LOKI_SLACK_WEBHOOK_URL).notify?.(summary) ?? Promise.resolve(), new Promise<void>((r) => setTimeout(r, Number(env.LOKI_E10_NOTIFY_TIMEOUT_MS) || 5000).unref())]); } catch { /* best-effort: a Slack failure or hang must never affect the verdict */ }
  return { verdict, tampered: log.tampered, notProven, prUrl, workerExit };
}
const ISSUE_RE = /^(?:[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+\/(?:-\/)?issues\/\d+)$/;
// E-59: every token field the provider reported, cache included (E-50 found "1k shown for 372k used" when this summed only input+output). The sole place tokens are computed for the Cost line.
export function summaryTokens(f: Folded, sawCost: boolean): number | null {
  return sawCost ? f.cost.inputTokens + f.cost.outputTokens + f.cost.cacheReadTokens + f.cost.cacheCreationTokens : null;
}
// E-69: per-session measured/total counts and their dollar sum, straight from the raw cost
// events -- not folded.cost.usd, which already collapses to null the moment any one session is
// unpriced. Lets the summary say "partial: $X for N of M sessions" instead of just "not measured".
// `tampered` mirrors the guard runSupervisor already applies to `usd` (costUsd = log.tampered ?
// null : folded.cost.usd): a TAMPERED log's cost events are as untrustworthy as everything else
// in it, so this must report no measured cost too, never a dollar figure sourced from them.
export function partialCost(events: EventEnvelope[], tampered = false): { measured: number; total: number; usd: number } {
  if (tampered) return { measured: 0, total: 0, usd: 0 };
  let measured = 0, total = 0, usd = 0;
  for (const e of events) {
    if (e.type !== "cost") continue;
    total++;
    if (typeof e.data.usd === "number") { measured++; usd += e.data.usd; }
  }
  return { measured, total, usd };
}
export async function main(args: string[]): Promise<number> { // `loki "<task>"` (cli.ts routes every run here): P0 of one run, ending in the 5-line summary
  const words: string[] = [];
  let noPr = false, deep = false, resumeId: string | null = null, provider = process.env.LOKI_PROVIDER || "claude";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-pr") noPr = true;
    else if (a === "--deep") deep = true;
    else if (a === "--provider") provider = args[++i] ?? provider;
    else if (a === "--resume") resumeId = args[++i] ?? "";
    else words.push(a);
  }
  const task = words.join(" ").trim();
  if (!resumeId && !task) { process.stderr.write("engine10: no task given\n"); return 2; }
  let repoDir: string;
  try {
    repoDir = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { process.stderr.write("engine10: not inside a git repository\n"); return 2; }
  if (resumeId && !existsSync(join(repoDir, eventsRelPath(resumeId)))) { process.stderr.write(`engine10: no run to resume: ${resumeId}\n`); return 2; }
  const runId = resumeId || `e10-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${Math.random().toString(16).slice(2, 6)}`;
  const runDir = join(repoDir, ".loki", "runs", runId);
  const isIssue = ISSUE_RE.test(task);
  const model = resolveModel(provider);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (task && !isIssue) env.LOKI_E10_TASK_TEXT = task; // resume with no fresh task: intake falls back to runDir's issue.json, else its own "no task text" reason
  else if (isIssue) {
    mkdirSync(runDir, { recursive: true }); // runDir must exist before the fetch child writes issue.json
    try { fetchIssueToFile(task, join(runDir, "issue.json")); } catch (err) { // P1: deterministic, before any LLM
      process.stderr.write(`engine10: issue fetch failed: ${(err as Error).message.split("\n")[0]}\n`);
      return 2;
    }
  }

  const t0 = Date.now();
  const eventsPath = join(repoDir, eventsRelPath(runId));
  const live = (e: EventEnvelope): void => {
    const clockS = (Date.parse(e.ts) - t0) / 1000;
    const d = e.data;
    if (e.type.startsWith("stage.") && e.type !== "stage.started") {
      const status = e.type === "stage.completed" ? "done" : e.type === "stage.failed" ? "failed" : "skipped";
      const detail = String(d.reason ?? d.summary ?? "");
      process.stdout.write(formatStageLine({ clockS, name: String(e.stage), status, durationS: Number(d.duration_s ?? 0), detail }) + "\n");
    } else if (e.type === "heartbeat") {
      const diff = d.diff as { files: number; insertions: number; deletions: number } | null;
      process.stdout.write(formatHeartbeatLine({ clockS, stage: String(e.stage), waitingOn: `${provider} session`, elapsedS: Number(d.elapsed_s ?? 0), diff }) + "\n");
    }
  };
  let stopTail = (): void => {};
  const tailTimer = setInterval(() => {
    if (existsSync(eventsPath)) { clearInterval(tailTimer); stopTail = tail(eventsPath, live, { intervalMs: 250 }); }
  }, 100);

  const capS = deep ? DEEP_CAP_S : Number(env.LOKI_E10_CAP_S) || DEFAULT_CAP_S;
  const res = await runSupervisor({
    runId, repoDir, env, capS,
    workerArgv: [process.execPath, resolve(process.argv[1]!), "engine10", "worker", runId, provider, model, deep ? "deep" : "fast"], deepArgv: noPr ? undefined : [process.execPath, resolve(process.argv[1]!), "engine10", "deep-worker", runId, provider, model],
    started: {
      task_source: isIssue ? "issue" : "text", issue_ref: isIssue ? task : null, provider, model, deep, cap_s: capS,
      model_override_applied: !!process.env.LOKI_MODEL_OVERRIDE && provider === "claude", branch: `loki/${runId}`,
    },
    pr: noPr ? undefined : async ({ pushEnv, verdict }) => {
      const { runPr } = await import("./stages/pr.ts"); // supervisor-only: the worker never loads pr.ts
      const events = readEvents(eventsPath);
      const sealed = events.findLast((e) => e.type === "receipt.sealed")?.data ?? {};
      const r = await runPr({
        runId, repoDir, runDir, branch: `loki/${runId}`, pinnedOrigin: pushEnv._LOKI_PINNED_ORIGIN,
        outputs: () => ({ seal: { ...sealed, verdict, receipt_path: sealed.path } }),
        capHit: () => events.some((e) => e.type === "cap.hit"),
        emit: () => {}, // pr.opened is appended by runSupervisor from the outcome
      } as unknown as PrContext, new AbortController().signal);
      const d = r.data as { pr_url?: string; draft?: boolean; existing?: boolean | null; not_proven?: string[] };
      if (r.status !== "completed") return { url: null, draft: false, existing: null, notProven: [`PR not opened: ${r.reason}`] };
      return { url: d.pr_url ?? null, draft: d.draft === true, existing: d.existing ?? null, notProven: d.not_proven };
    },
  }).catch((e) => { if (!(e instanceof PreflightError)) throw e; process.stderr.write(`${e.message}\n`); return null; });
  clearInterval(tailTimer);
  if (!res) { stopTail(); return 2; } // preflight refused: exit 2 with the fatal line, before any run state
  await new Promise((r) => setTimeout(r, 300)); // let the tail flush the last lines
  stopTail();

  const events = readEvents(eventsPath);
  const f = fold(events);
  const sawCost = events.some((e) => e.type === "cost");
  const cli = process.env.LOKI_E10_INVOKER === "cli";
  const pc = partialCost(events, res.tampered);
  process.stdout.write(formatSummary({
    pr: res.prUrl ? { url: res.prUrl, draft: res.verdict !== "VERIFIED" } : null,
    verdict: res.verdict, notProven: res.notProven, flaky: [],
    cost: {
      usd: f.cost.usd, provider, tokens: summaryTokens(f, sawCost), note: f.cost.usd === null && cli ? "CLI invoker records no cost" : null,
      partialUsd: pc.usd, measuredSessions: pc.measured, totalSessions: pc.total,
    },
    wallS: Number(f.run.completed?.data.wall_s ?? (Date.now() - t0) / 1000),
    stages: events.filter((e) => e.type === "stage.completed" && typeof e.data.duration_s === "number")
      .map((e) => ({ label: String(e.stage), seconds: e.data.duration_s as number })),
  }) + `\nRun:        ${runId} (${eventsRelPath(runId)})\nModel:      ${model}\n`);
  return res.verdict === "FAILED" ? 1 : 0;
}
