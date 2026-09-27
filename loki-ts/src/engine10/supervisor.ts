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
import { STAGE_BUDGETS } from "./types.ts";

export const TAMPER_NOT_PROVEN = "event log modified outside the engine";
/** Types only the supervisor may write; the same types arriving from the worker are dropped. */
const SUPERVISOR_ONLY = new Set(["run.started", "run.completed", "tamper.detected", "pr.opened"]);

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
    const url = execFileSync("git", ["-C", repoDir, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
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

/** Spawns the worker; resolves on `close` (all stdout delivered), with null exit when it could not start. */
function spawnWorker(argv: string[], env: NodeJS.ProcessEnv, cwd: string, onLine: (l: string) => void): Promise<number | null> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd) return resolve(null);
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
    createInterface({ input: child.stdout }).on("line", onLine);
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
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

  let sealed: Record<string, unknown> | null = null;
  const workerExit = await spawnWorker(opts.workerArgv, workerEnv, opts.repoDir, (line) => {
    const e = log.ingest(line);
    if (e?.type === "receipt.sealed") sealed = e.data;
  });

  const sealedData = sealed as Record<string, unknown> | null;
  const verdict: Verdict = workerExit === 0 && typeof sealedData?.verdict === "string" ? (sealedData.verdict as Verdict) : "FAILED";
  const notProven = Array.isArray(sealedData?.not_proven) ? (sealedData.not_proven as unknown[]).map(String) : [];

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
