// Loki 10 engine shared contract (docs/v10/ENGINE.md). Every engine module
// codes against these types; siblings are injected through RunContext so each
// module can be unit-tested with fakes.
import type { SessionTier } from "../runner/types.ts";

export type StageName =
  | "intake" | "plan" | "wall" | "implement" | "verify" | "fix"
  | "commit" | "seal" | "pr" | "deep";

export const STAGE_BUDGETS: Readonly<Record<StageName, { targetS: number; limitS: number }>> = {
  intake: { targetS: 15, limitS: 60 },
  plan: { targetS: 45, limitS: 90 },
  wall: { targetS: 45, limitS: 90 },
  implement: { targetS: 180, limitS: 480 }, // LOKI_E10_IMPLEMENT_KILL_S; 900 when deep
  verify: { targetS: 60, limitS: 120 },
  fix: { targetS: 90, limitS: 180 },
  commit: { targetS: 5, limitS: 30 },
  seal: { targetS: 15, limitS: 60 },
  pr: { targetS: 15, limitS: 60 },
  deep: { targetS: 1800, limitS: 1800 }, // target is unbounded in ENGINE.md; limit 30 min
};
export const DEFAULT_CAP_S = 900;
export const DEEP_CAP_S = 2700;
export const DEEP_IMPLEMENT_LIMIT_S = 900;
export const MAX_FIX_ROUNDS = 2;

export const EVENT_TYPES = [
  "run.started", "stage.started", "stage.completed", "stage.failed", "stage.skipped",
  "heartbeat", "session.started", "session.ended", "cost", "wall.sealed",
  "tests.restored", "test.result", "fix.round", "already.satisfied", "spec.conflict",
  "escalated", "cap.hit", "tamper.detected", "receipt.sealed", "pr.opened",
  "deep.started", "deep.completed", "receipt.addendum", "run.completed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** One line of events.jsonl. All keys required; stage is null for run-level events.
 *  Readers tolerate unknown `type` values (forward compatibility). */
export interface EventEnvelope<D extends Record<string, unknown> = Record<string, unknown>> {
  v: 1;
  seq: number;
  ts: string;
  run: string;
  type: EventType | (string & {});
  stage: StageName | (string & {}) | null;
  data: D;
}

export type Verdict = "VERIFIED" | "PARTIAL" | "ALREADY_SATISFIED" | "SPEC_CONFLICT" | "FAILED";

export type ImplementExit = "done" | "already_done" | "spec_conflict" | "killed";

export interface StageResult {
  status: "completed" | "failed" | "skipped";
  /** Becomes stage.completed.data (or stage.failed / stage.skipped data). */
  data: Record<string, unknown>;
  reason?: string;
  killed?: boolean;
}

export interface Stage {
  name: StageName;
  targetS: number;
  limitS: number;
  run(ctx: RunContext, signal: AbortSignal): Promise<StageResult>;
}

export interface SessionMarkers {
  done: boolean;
  alreadyDone: string | null; // evidence after LOKI_ALREADY_DONE:
  specConflict: string | null; // reason after LOKI_SPEC_CONFLICT:
}

export interface SessionRunOptions {
  stage: StageName;
  brief: string;
  tier: SessionTier;
  iterationId: string; // unique LOKI_ITERATION, e.g. e10-<run-id>-impl
  limitS: number;
  signal: AbortSignal;
  cwd?: string;
}

export interface SessionResult {
  exit: number | null; // null when killed before exiting
  markers: SessionMarkers;
  durationS: number;
  killed: boolean;
}

/** Implemented by session.ts (E-07). */
export interface SessionRunner {
  run(opts: SessionRunOptions): Promise<SessionResult>;
}

export type RunnerName = "pytest" | "vitest" | "jest" | "npm" | "bun" | "go" | "cargo";

export interface TestMap {
  runners: RunnerName[];
  testFiles: string[];
}

/** Implemented by testmap.ts (E-05). */
export interface TestMapProvider {
  detect(repoDir: string): Promise<TestMap>;
  impacted(map: TestMap, changedFiles: string[]): string[];
}

export interface CostTotals {
  usd: number | null; // unknown is null, never 0
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** Implemented by cost.ts (E-06). */
export interface CostReader {
  read(repoDir: string, iterationIds: string[]): CostTotals;
}

export interface Clock {
  now(): number; // epoch ms
}

export interface RunContext {
  runId: string;
  repoDir: string;
  runDir: string;
  baseSha: string;
  branch: string;
  provider: string;
  model: string;
  deep: boolean;
  capS: number;
  emit(type: EventType, stage: StageName | null, data: Record<string, unknown>): void;
  sessions: SessionRunner;
  tests: TestMapProvider;
  cost: CostReader;
  clock: Clock;
}

export interface ReceiptCheck {
  name: string;
  cmd: string;
  result: "pass" | "fail" | "not_run";
  duration_s: number;
}

/** .loki/runs/<id>/receipt.json. receipt_sha256 = sha256 of canonical JSON without `verification`. */
export interface Receipt {
  schema: "loki.v10.receipt/1";
  run_id: string;
  task: { source: "text" | "issue"; sha256: string };
  repo: string;
  base_sha: string;
  head_sha: string;
  tree: string;
  diff_sha256: string;
  wall: { files: { path: string; sha256: string }[]; passed: boolean | null };
  checks: ReceiptCheck[];
  not_proven: string[];
  verdict: Verdict;
  cost: { usd: number | null; input_tokens: number; output_tokens: number };
  time: { wall_s: number; stages: Partial<Record<StageName, number>> };
  provider: string;
  model: string;
  resumed: boolean;
  events_sha256: string;
  receipt_sha256: string;
  verification: { jwt: string | null; kid: string | null };
}

/** argv/env for autonomy/lib/engine10-push.sh (P4). Values come from supervisor memory only. */
export type PushArgs =
  | { cmd: "pr"; repoDir: string; branch: string; title: string; bodyFile: string; draft: boolean }
  | { cmd: "comment"; runId: string; prUrl: string; file: string }
  | { cmd: "status"; sha: string; state: "pending" | "success" | "failure"; description: string };

export interface PushEnv {
  _LOKI_ORIGIN_PINNED: "1";
  _LOKI_PINNED_ORIGIN: string;
}

export function pushArgv(a: PushArgs): string[] {
  switch (a.cmd) {
    case "pr": return ["pr", a.repoDir, a.branch, a.title, a.bodyFile, a.draft ? "1" : "0"];
    case "comment": return ["comment", a.runId, a.prUrl, a.file];
    case "status": return ["status", a.sha, a.state, a.description];
  }
}
