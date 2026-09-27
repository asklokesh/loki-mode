// Loki 10 supervisor (P0, docs/v10/ENGINE.md sections 5, 6 and 10).
// - Writes the eval marker .loki/engine.json first, so even a failing run leaves it.
// - Pins remote.origin.url once, in memory, before any provider runs.
// - Spawns the worker with a COPY of its env passed through withholdGithubTokens.
// - Is the single writer of events.jsonl: validates worker stdout lines, stamps
//   seq, and keeps a running sha256 of every byte it appended. After each
//   session.ended and before the PR it re-hashes the file; a mismatch emits
//   tamper.detected and the push is refused.
import { execFileSync, spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { withholdGithubTokens } from "../runner/github_token.ts";
import { EventLog, fold, readEvents } from "./events.ts";
import type { EventEnvelope, PushEnv, StageName, Verdict } from "./types.ts";
import { DEFAULT_CAP_S, STAGE_BUDGETS } from "./types.ts";

export const TAMPER_NOT_PROVEN = "event log modified outside the engine";
/** Types only the supervisor may write; the same types arriving from the worker are dropped. */
const SUPERVISOR_ONLY = new Set(["run.started", "run.completed", "tamper.detected", "pr.opened"]);
const VERDICTS = new Set<string>(["VERIFIED", "PARTIAL", "ALREADY_SATISFIED", "SPEC_CONFLICT", "FAILED"]);
const SESSION_EXITS = new Set(["done", "already_done", "spec_conflict", "killed", "error"]);
export const BACKSTOP_NOT_PROVEN = "worker killed by the supervisor backstop (cap plus grace)";
/** Seconds past the cap the worker gets to seal and exit before P0 kills its process group. */
export const BACKSTOP_GRACE_S = 60;
/** After the worker exits, how long P0 waits for stdout to drain before closing it. */
const DRAIN_MS = 2000;

const nonNegNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
/** Per-type data checks for the events the supervisor itself acts on (section 7 table). */
function dataOk(type: string, d: Record<string, unknown>): boolean {
  if (type === "session.ended") {
    return typeof d.session_id === "string" && SESSION_EXITS.has(d.exit as string) && nonNegNum(d.duration_s);
  }
  if (type === "cost") return typeof d.session_id === "string" && (d.usd === null || nonNegNum(d.usd));
  return true;
}

// Local types (not in types.ts): the PR hook E-11 (stages/pr.ts) plugs into, and the result.
export interface PrOutcome { url: string; draft: boolean; existing: boolean }
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
  /** argv of the worker process, e.g. [bun, cli, "engine10", "worker", ...] (wired by E-12). */
  workerArgv: string[];
  env?: NodeJS.ProcessEnv; // defaults to process.env; never mutated
  started?: Record<string, unknown>; // extra run.started data (task_source, provider, model, ...)
  pr?: PrStep; // absent means no PR (for example --no-pr)
  /** Global cap in seconds (default LOKI_E10_CAP_S, else DEFAULT_CAP_S). The backstop fires at cap plus grace. */
  capS?: number;
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

/** EV-1 marker, atomic (temp file in the same dir, then rename). */
export function writeEngineMarker(repoDir: string, runId: string): void {
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

/** Single writer with a running sha256 of the bytes it appended. */
export class SupervisorLog {
  private readonly log: EventLog;
  private readonly hash: Hash;
  tampered = false;

  constructor(readonly path: string, runId: string) {
    this.log = new EventLog(path, runId);
    // Seed AFTER construction: EventLog may terminate a torn last line.
    this.hash = createHash("sha256");
    try { this.hash.update(readFileSync(path)); } catch { /* new file */ }
  }

  append(type: string, stage: StageName | null, data: Record<string, unknown>): EventEnvelope {
    const e = this.log.append(type, stage, data);
    this.hash.update(JSON.stringify(e) + "\n");
    return e;
  }

  /** Validates one untrusted worker stdout line; returns the appended event or null when dropped. */
  ingest(line: string): EventEnvelope | null {
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

  /** Re-hashes the file. On mismatch (once) emits tamper.detected. Returns true when intact. */
  verify(): boolean {
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

/**
 * Spawns the worker in its own process group. Resolves once the worker has exited
 * and stdout has closed or DRAIN_MS has passed (a surviving grandchild holding the
 * pipe cannot stall P0). At backstopMs the whole group gets SIGTERM, then SIGKILL
 * after 2s. Exit is null when the worker could not start or was killed by a signal.
 */
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
    // The worker no longer shares the terminal's group, so forward a stop to it.
    const onStop = (sig: NodeJS.Signals) => { killGroup(child.pid, "SIGKILL"); process.exit(sig === "SIGINT" ? 130 : 143); };
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
  writeEngineMarker(opts.repoDir, opts.runId); // first: a failing run still leaves it
  const env = opts.env ?? process.env;
  const origin = readOriginUrl(opts.repoDir); // pinned once, before any provider runs
  const log = new SupervisorLog(join(opts.repoDir, eventsRelPath(opts.runId)), opts.runId);
  log.append("run.started", null, { ...opts.started, origin_repo: githubRepoFromUrl(origin) });

  // withholdGithubTokens mutates its argument: always a copy, never env itself.
  const workerEnv: NodeJS.ProcessEnv = { ...env };
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
    if (out) {
      prUrl = out.url;
      log.append("pr.opened", "pr", { url: out.url, draft: out.draft, existing: out.existing });
    }
  }

  // Unknown cost stays null (fold returns null unless every session was measured).
  const costUsd = log.tampered ? null : fold(readEvents(log.path)).cost.usd;
  log.append("run.completed", null, {
    verdict, pr_url: prUrl, not_proven: notProven, cost_usd: costUsd, wall_s: (Date.now() - t0) / 1000,
  });
  return { verdict, tampered: log.tampered, notProven, prUrl, workerExit };
}
