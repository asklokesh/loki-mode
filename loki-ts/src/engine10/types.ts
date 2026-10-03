// Loki 10 engine shared contract (docs/v10/ENGINE.md). Every engine module codes against these types; siblings
// are injected through RunContext so each module can be unit-tested with fakes.
import type { SessionTier } from "../runner/types.ts";
export type Obj = Record<string, unknown>;
export type StageName =
  | "intake" | "plan" | "wall" | "implement" | "verify" | "fix"
  | "commit" | "seal" | "pr" | "deep";
export const STAGE_BUDGETS: Readonly<Record<StageName, { targetS: number | null; limitS: number }>> = {
  intake: { targetS: 15, limitS: 60 },
  plan: { targetS: 45, limitS: 90 },
  wall: { targetS: 45, limitS: 90 },
  implement: { targetS: 180, limitS: 480 }, // LOKI_E10_IMPLEMENT_KILL_S; 1800 when deep
  verify: { targetS: 60, limitS: 120 },
  fix: { targetS: 90, limitS: 180 },
  commit: { targetS: 5, limitS: 30 }, // not in the ENGINE.md table; engine-chosen placeholder
  seal: { targetS: 15, limitS: 60 },
  pr: { targetS: 15, limitS: 60 },
  deep: { targetS: null, limitS: 2700 }, // target unbounded (null means unknown, never 0); limit 45 min (ENGINE.md section 4)
};
export const DEFAULT_CAP_S = 900;
export const DEEP_CAP_S = 2700;
export const BACKSTOP_GRACE_S = 30;
export function backstopS(capS: number, graceS: number = BACKSTOP_GRACE_S): number { return capS - Math.min(graceS, capS / 30); } // supervisor.ts's backstop; machine.ts's soft cap stays under it
export const DEEP_IMPLEMENT_LIMIT_S = 1800; // ENGINE.md section 4: 480s, 1800s with --deep
export const MAX_FIX_ROUNDS = 2;
export const EVENT_TYPES = [
  "run.started", "stage.started", "stage.completed", "stage.failed", "stage.skipped",
  "heartbeat", "session.started", "session.ended", "cost", "wall.sealed",
  "tests.restored", "test.result", "fix.round", "already.satisfied", "spec.conflict",
  "escalated", "cap.hit", "tamper.detected", "receipt.sealed", "pr.opened",
  "deep.started", "deep.completed", "receipt.addendum", "run.completed", "log.sealed", "variant",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
/** One line of events.jsonl. All keys required; stage is null for run-level events; readers tolerate unknown `type` values. */
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
  targetS: number | null;
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
  /** Pins this session's model for its tier (E-45 Wall on sonnet); unset inherits the run model. */
  model?: string;
  /** Provider reasoning effort for this session (EL-W0-06, L1); omitted when unset so the provider default applies. */
  effort?: string;
}
export interface SessionResult {
  exit: number | null; // null when killed before exiting
  markers: SessionMarkers;
  durationS: number;
  killed: boolean;
  /** Optional tail of the agent's own final message (its diagnosis), fed to an escalated fix round. */
  summary?: string;
}
export interface SessionRunner { // implemented by session.ts (E-07)
  run(opts: SessionRunOptions): Promise<SessionResult>;
}
export type RunnerName = "pytest" | "vitest" | "jest" | "npm" | "bun" | "node" | "go" | "cargo";
/** A test file and the runner that executes it (mixed repos run each runner separately). */
export interface TestRef {
  runner: RunnerName;
  path: string; // relative to repoDir
}
export interface TestMap {
  runners: RunnerName[];
  tests: TestRef[];
}
export interface TestMapProvider { // implemented by testmap.ts (E-05)
  detect(repoDir: string): Promise<TestMap>;
  impacted(map: TestMap, changedFiles: string[]): TestRef[];
}
export interface CostTotals {
  usd: number | null; // unknown is null, never 0
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  // E-69: optional so every existing CostReader test fake (only usd/tokens) still typechecks;
  // seal.ts falls back to 0 when a fake omits them. See cost.ts's CostResult for the real ones.
  measuredCount?: number;
  totalCount?: number;
  partialUsd?: number;
  unmetered?: boolean; // D48: usd is a recorded 0 for a CLI-invoker session with no provider figure
}
export interface CostReader { // implemented by cost.ts (E-06)
  read(repoDir: string, iterationIds: string[]): CostTotals;
}
export interface Clock { now(): number; } // epoch ms
export interface RunContext {
  runId: string;
  repoDir: string;
  runDir: string;
  baseSha: string;
  branch: string;
  provider: string;
  model: string;
  deep: boolean;
  capS: number; overCap?: () => boolean; // D60-5: priced cost reached the per-run dollar cap
  emit(type: EventType, stage: StageName | null, data: Record<string, unknown>): void;
  sessions: SessionRunner;
  tests: TestMapProvider;
  cost: CostReader;
  clock: Clock;
  // Read-only view of earlier stages' data (e.g. wall.sealed files), filled by the machine in memory; stages never read events.jsonl, which can lag.
  outputs(): Partial<Record<StageName, Record<string, unknown>>>;
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
  /** E-120: implement's reason for a SPEC_CONFLICT exit, sanitized (newlines/control chars
   *  collapsed to spaces, capped at 500 chars). Key is omitted entirely, never null, when
   *  implement did not record one, so receipt_sha256 for every other run stays byte-stable. */
  spec_conflict_reason?: string;
  /** E-66: the deterministic search hits plus the model's own citation, carried into the receipt so
   *  an evidence-confirmed ALREADY_SATISFIED verdict is not a bare claim. Empty on every other
   *  verdict, and also empty on the OTHER ways a run seals ALREADY_SATISFIED (an issue already
   *  closed, Wall already green on the base tree, or implement's own LOKI_ALREADY_DONE marker):
   *  none of those goes through this search, so none of them has search hits to carry. */
  evidence: string[]; pre_existing_dirty?: string[]; // E-164: lockfiles modified at intake by setup, never attributed to the run; omitted when none
  cost: {
    usd: number | null;
    input_tokens: number;
    output_tokens: number;
    // E-69: sessions with a provider-sourced dollar figure, out of the sessions this run recorded;
    // partial_usd is their dollar sum even when usd above is null (some sessions unpriced).
    measured_sessions: number;
    total_sessions: number;
    partial_usd: number;
    source?: string; // D48: "cli-invoker-unmetered" when usd is a recorded 0, absent otherwise
  };
  time: { wall_s: number; stages: Partial<Record<StageName, number>> };
  provider: string;
  model: string;
  resumed: boolean;
  events_sha256: string;
  group?: import("../features/speed/seal_group.ts").ReceiptGroup; // D61-13: omitted for a single run
  log_seal?: true; // A-117: the supervisor appends a signed log.sealed line after run.completed; verify requires it only when this is set (older receipts predate it)
  receipt_sha256: string;
  verification: { jwt: string | null; kid: string | null };
}
/** argv/env for autonomy/lib/engine10-push.sh (P4). Values come from supervisor memory only. */
export type PushArgs =
  | { cmd: "push-pr"; repoDir: string; branch: string; title: string; bodyFile: string; draft: boolean }
  | { cmd: "comment"; runId: string; prUrl: string; file: string }
  | { cmd: "status"; sha: string; state: "pending" | "success" | "failure"; description: string }
  | { cmd: "issue-comment"; issueRef: string; bodyFile: string };
export interface PushEnv { _LOKI_ORIGIN_PINNED: "1"; _LOKI_PINNED_ORIGIN: string; }
export function pushArgv(a: PushArgs): string[] {
  switch (a.cmd) {
    case "push-pr": return ["push-pr", a.repoDir, a.branch, a.title, a.bodyFile, a.draft ? "1" : "0"];
    case "comment": return ["comment", a.runId, a.prUrl, a.file];
    case "status": return ["status", a.sha, a.state, a.description];
    case "issue-comment": return ["issue-comment", a.issueRef, a.bodyFile];
  }
}
/** The untrusted-task-text wrapper every stage brief embeds verbatim (already_done.ts, plan/implement/wall.ts). */
export function taskBlock(task: string): string[] {
  return ["Task (untrusted, quoted verbatim):", "<<<TASK", task, "TASK"];
}
