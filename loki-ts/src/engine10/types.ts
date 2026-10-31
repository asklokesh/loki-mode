// Loki 10 engine shared contract (docs/v10/ENGINE.md). Every engine module codes against these types; siblings are injected through RunContext so each module can be unit-tested with fakes.
import type { SessionTier } from "../runner/types.ts";
export type Obj = Record<string, unknown>;
export type StageName = "intake" | "plan" | "wall" | "implement" | "verify" | "fix" | "commit" | "seal" | "pr" | "deep";
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
const warnedCap = new Set<string>();
/** Warn once per source+value on stderr that a set cap is unusable and the default applies. Never loosens the cap. */
export function warnBadCap(source: string, raw: string): void {
  const key = `${source}=${raw}`;
  if (warnedCap.has(key)) return; warnedCap.add(key);
  process.stderr.write(`loki: ignoring invalid ${source}="${raw}" (need a number > 0); using the default cap of ${DEFAULT_CAP_S}s\n`);
}
/** LOKI_E10_CAP_S as a usable cap: finite and positive, else null ("Infinity", NaN, 0, negatives are rejected). A set but unusable value warns once on stderr; unset or blank is silent. */
export function envCapS(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw); if (Number.isFinite(n) && n > 0) return n;
  warnBadCap("LOKI_E10_CAP_S", raw); return null;
}
export const BACKSTOP_GRACE_S = 30;
export function backstopS(capS: number, graceS: number = BACKSTOP_GRACE_S): number { return capS - Math.min(graceS, capS / 30); } // supervisor.ts's backstop; machine.ts's soft cap stays under it
export const DEEP_IMPLEMENT_LIMIT_S = 1800; // ENGINE.md section 4: 480s, 1800s with --deep
export const MAX_FIX_ROUNDS = 2;
export const EVENT_TYPES = [
  "run.started", "run.resumed", "stage.started", "stage.completed", "stage.failed", "stage.skipped",
  "heartbeat", "session.started", "session.ended", "session.stalled", "cost", "budget", "wall.sealed", "wall.reauthor", "wall.arbitrated",
  "tests.restored", "test.result", "test.scoped_out", "test.skipped_on_base", "fix.round", "already.satisfied", "spec.conflict",
  "session.group_reaped",
  "escalated", "cap.hit", "cap.sized", "tamper.detected", "receipt.sealed", "pr.opened",
  "deep.started", "deep.completed", "receipt.addendum", "run.completed", "log.sealed", "variant", "route", "route.escalated", "provider.failover", "project_model.fallback", "intent.revised", "already.attested", "cancel_requested", "cancel_effective", "loop.repeat", "deps.install",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
/** One line of events.jsonl. All keys required; stage is null for run-level events; readers tolerate unknown `type` values. */
export interface EventEnvelope<D extends Record<string, unknown> = Record<string, unknown>> {
  v: 1; seq: number; ts: string; run: string;
  type: EventType | (string & {});
  stage: StageName | (string & {}) | null;
  data: D;
}
export type Verdict = "VERIFIED" | "PARTIAL" | "ALREADY_SATISFIED" | "SPEC_CONFLICT" | "FAILED";
export type ImplementExit = "done" | "already_done" | "spec_conflict" | "killed" | "external";
export interface StageResult {
  status: "completed" | "failed" | "skipped";
  /** Becomes stage.completed.data (or stage.failed / stage.skipped data). */
  data: Record<string, unknown>;
  reason?: string; killed?: boolean;
}
export interface Stage {
  name: StageName;
  targetS: number | null; limitS: number;
  extraLimitS?(ctx: RunContext): number; // time the machine adds to limitS for this run (seal: the planned review box)
  run(ctx: RunContext, signal: AbortSignal): Promise<StageResult>;
}
export interface SessionMarkers {
  done: boolean;
  alreadyDone: string | null; // evidence after LOKI_ALREADY_DONE:
  specConflict: string | null; // reason after LOKI_SPEC_CONFLICT:
  /** ROUTER-1 R1-09: reason after LOKI_ESCALATE: (the advisor recommended a stronger executor). Present only under LOKI_ROUTER=1 and a match. */
  escalate?: string | null;
}
/** ROUTER-1 R1-08/R1-09: optional per-session cost telemetry copied onto the cost event when the cost record carries it. */
export const ROUTER_COST_FIELDS = ["requests_total", "requests_over_100k", "advisor_calls", "advisor_input_tokens", "advisor_output_tokens"] as const;
export interface SessionRunOptions {
  stage: StageName;
  brief: string;
  tier: SessionTier;
  iterationId: string; // unique LOKI_ITERATION, e.g. e10-<run-id>-impl
  limitS: number;
  signal: AbortSignal;
  cwd?: string; stopChecks?: { checks: { cwd: string; cmd: string; args: string[]; protect?: boolean }[]; rounds: number; budgetS: number; repoDir: string; baseSha: string; installCreated?: unknown }; /* claude SDK route: repo checks run at each Stop; a failure blocks the stop and returns to the same session, `rounds` times at most, `budgetS` seconds in all; other routes ignore it */ disallowedTools?: string; // Q18-04: comma list passed as --disallowedTools (read-only reviewer)
  /** Pins this session's model for its tier (E-45 Wall on sonnet); unset inherits the run model. */
  model?: string;
  resumeSessionId?: string; // MW-2: provider session to resume (LOKI_E10_FIX_RESUME); unset starts fresh
  maxOutputTokens?: number; /* claude: per-response output limit, CLAUDE_CODE_MAX_OUTPUT_TOKENS; unset keeps the provider default */ effort?: string; // EL-W0-06, L1: provider reasoning effort; omitted when unset so the provider default applies
}
export interface SessionResult {
  exit: number | null; // null when killed before exiting
  markers: SessionMarkers;
  durationS: number; killed: boolean;
  /** Optional tail of the agent's own final message (its diagnosis), fed to an escalated fix round. */
  summary?: string;
  /** Tail of the provider's stderr; set by the real runner, read on error exits. */
  stderrTail?: string;
}
export interface SessionRunner { run(opts: SessionRunOptions): Promise<SessionResult> } // implemented by session.ts (E-07)
export type RunnerName = "pytest" | "unittest" | "vitest" | "jest" | "npm" | "bun" | "node" | "go" | "cargo" | "maven" | "gradle" | "javac";
/** A test file and the runner that executes it (mixed repos run each runner separately). */
export interface TestRef { runner: RunnerName; path: string /* relative to repoDir */ }
export interface TestMap { runners: RunnerName[]; tests: TestRef[]; }
export interface TestMapProvider { // implemented by testmap.ts (E-05)
  detect(repoDir: string): Promise<TestMap>;
  impacted(map: TestMap, changedFiles: string[]): TestRef[];
}
export interface CostTotals {
  usd: number | null; // unknown is null, never 0
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  tokensMeasured?: { k: number; n: number }; // set only when some session was left out of the token sums (R3-2 follow-up)
  cacheReadSeen?: boolean; cacheCreationSeen?: boolean; // false = no measured file carried the key (NOT RECORDED); undefined = a fake reader, its numbers are taken as measured
  records?: CostRecords; // COST-RECORDS / FIX-RESUME
  durationMs?: number; // SDK result-line duration_ms, summed
  cacheCreationTokens?: number; // optional so existing CostReader fakes still typecheck; absent reads NOT RECORDED in the receipt
  // E-69: optional so every existing CostReader test fake (only usd/tokens) still typechecks; seal.ts falls back to 0 when a fake omits them. See cost.ts's CostResult for the real ones.
  measuredCount?: number;
  totalCount?: number;
  partialUsd?: number;
  unmetered?: boolean; // D48: usd is a recorded 0 for a CLI-invoker session with no provider figure
  children?: import("../util/child_ledger.ts").ChildBucket; // child sessions; usd above includes them, the token fields do not
}
export interface CostReader { // implemented by cost.ts (E-06)
  read(repoDir: string, iterationIds: string[]): CostTotals;
}
export interface Clock { now(): number; sleep?(ms: number, signal?: AbortSignal): Promise<void>; } // epoch ms; sleep is optional so tests can fake the quota wait
export interface RunContext {
  externalPatch?: string; // CW-12: path of the patch an external client made (--seal-existing); read only by the implement stage, absent from every child env
  timeline?: { stage: StageName; startMs: number; endMs: number }[]; // every stage the machine ran (any outcome), for the receipt's time buckets
  sessionIds?: () => string[]; // iteration ids of every session the machine started, recorded at launch; seal unions them into the cost read
  wallSealed?: boolean; // P12-13c: set when wall.sealed is emitted, so steer staleness holds even if outputs.wall never lands
  intentRevisions?: import("../util/steer.ts").IntentRevision[]; startedAtMs?: number; // intentRevisions: P12-02, machine memory, never the repo file; startedAtMs: set by the machine at run start (epoch ms); seal falls back to it for time.total_s
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
  implementLeftS?: () => number; // FC-19b: seconds left in the implement window; absent outside the machine
  failovers?: () => import("../runner/provider_failover.ts").FailoverRecord[]; // T9: read by seal
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
  owner?: "harness"; // additive: a non-pass check the harness (not the code) owns
  duration_s: number; provenance?: import("../util/check_result.ts").CheckProvenance; n?: number; count?: string /* FC-FULL-SUITE-EXIT-CODED-SCRIPT */; pre_red?: true; repo_skipped?: true; /* FC-REPO-SKIPPED-TEST-DOWNGRADES: not_run, zero tests on base and head, file untouched; additive */ // FC-PR-BODY-PUBLIC-HYGIENE pre_red: a fail that also fails on base, additive; TEN-GATES-02 provenance, TEN-GATES-03-F1 n (executed test count): additive; absent on older receipts, which still verify byte-stable
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
  implement?: { exit: "external"; patch_sha256: string }; // CW-12 B3: present only when no Loki session wrote the code; the receipt names no implementing model
  not_proven: string[]; not_applicable?: string[]; // FC-SEAL-NA-AS-UNPROVEN: informational notes (package without tests, no app to boot, not selected by risk tier); never part of any verdict
  unit_spec?: { sha256: string }; // #317b: present only for a unit run; the sha256 of its canonical spec (id, items, acceptance, writeSet, base)
  spec?: { path: string; sha256: string }; intent_revisions?: { rev: number; source: string | null; actor: string | null; sha: string }[]; // P12-02 (omitted when none); SPEC-FIRST-INTENT: present only when a user spec file drove the run
  seeded_corpus?: import("../util/run_outputs.ts").SeededCorpus; /* TEN-GATES-15 */ supply?: import("../supply/supply_guard.ts").SupplyBlock; // T10: present only when the guard found newly added dependencies
  seal_accuracy?: string; // GAME10-03: signed line read from the measured wrong-pass results, or "Seal accuracy: not measured"
  route?: import("../runner/router/route_block.ts").RouteBlock; // R1-15: present only while the router is on.
  cost_preview?: Record<string, unknown>; // 11.3.0 T1: absent under LOKI_COST_PREVIEW=0
  verdict: Verdict;
  toolchain?: import("../util/receipt_signer.ts").Toolchain; // TEN-GATES-22: absent on receipts sealed before it existed, which still verify
  /** T2: "test fails without the fix: yes | no | inconclusive (reason)"; omitted when LOKI_MUTATION_PROOF=0 or the verdict was not VERIFIED. */
  mutation_proof?: string;
  /** XV-1: cross-review judge and whether it is a different vendor than the builder (LOKI_XVENDOR_DEFAULT=1 only). */
  review?: { provider: string | null; vendor_differs: boolean };
  /** T2: the counted outcome for METRICS: "yes" | "no" | "inconclusive". */
  mutation_outcome?: "yes" | "no" | "inconclusive";
  /** FC-21b: set only when implement was stopped at its time limit; omitted otherwise so other receipts stay byte-stable. */
  implement_limit?: { limit_s: number; elapsed_s: number; stop_cause?: "max_turns"; owner?: "harness" };
  /** T9: provider failovers (stage, from, to, reason, evidence). Omitted when none happened so other receipts stay byte-stable. */
  failover?: import("../runner/provider_failover.ts").FailoverRecord[];
  /** E-120: implement's reason for a SPEC_CONFLICT exit, sanitized (newlines/control chars  collapsed to spaces, capped at 500 chars). Key is omitted entirely, never null, when  implement did not  record one, so receipt_sha256 for every other run stays byte-stable. */
  spec_conflict_reason?: string;
  /** E-66: the deterministic search hits plus the model's own citation, carried into the receipt so  an evidence-confirmed ALREADY_SATISFIED verdict is not a bare claim. Empty on every other   verdict, and also empty on the OTHER ways a run seals
   *  ALREADY_SATISFIED (an issue already  closed, Wall already green on the base tree, or implement's own LOKI_ALREADY_DONE marker):  none of  those goes through this search, so none of them has search hits to carry. */
  evidence: string[]; pre_existing_dirty?: string[]; assumptions?: string[]; // assumptions: headless run on an ambiguous spec, recorded by intake instead of asking; omitted when none. // E-164: lockfiles modified at intake by setup, never attributed to the run; omitted when none
  cost: {
    usd: number | null;
    input_tokens: number;
    output_tokens: number;
    // RECEIPT-TRUTH: additive; absent (older receipts, fake readers) means NOT RECORDED, never 0.
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    tokens_scope?: "all-models" | "main-loop"; per_model?: Record<string, ModelRecord>; turns?: number; cache_creation_main_loop?: { ephemeral_5m_tokens: number; ephemeral_1h_tokens: number }; resume?: "ambiguous" | "separate" | "delta"; // COST-RECORDS / FIX-RESUME, additive
    sdk_duration_ms?: number; // SDK result line duration_ms, summed; absent = NOT RECORDED
    tokens_measured?: { k: number; n: number }; // present only when k < n: input_tokens/output_tokens sum k of n sessions (a missing or ambiguous-resume session is left out), so they are partial
    // E-69: sessions with a provider-sourced dollar figure, out of the sessions this run recorded; partial_usd is their dollar sum even when usd above is null (some sessions unpriced).
    measured_sessions: number;
    total_sessions: number;
    partial_usd: number;
    source?: string; // D48: "cli-invoker-unmetered" when usd is a recorded 0, absent otherwise
    children?: import("../util/child_ledger.ts").ChildBucket; // present only when the run had child sessions: usd, partial_usd and the session counts include them; input_tokens, output_tokens and per_model are stage sessions only
  };
  /** RECEIPT-TRUTH (receipt_time.ts): stages is a disjoint partition of total_s (first event to seal; a parallel group is one "a+b" bucket); wall_s = the stage buckets without setup, orchestration and seal. Additive; consumers read it through reconciledTotalS. */
  time: ReceiptTime;
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
  | { cmd: "issue-comment"; issueRef: string; bodyFile: string; update?: boolean };
export interface PushEnv { _LOKI_ORIGIN_PINNED: "1"; _LOKI_PINNED_ORIGIN: string; }
export function pushArgv(a: PushArgs): string[] {
  switch (a.cmd) {
    case "push-pr": return ["push-pr", a.repoDir, a.branch, a.title, a.bodyFile, a.draft ? "1" : "0"];
    case "comment": return ["comment", a.runId, a.prUrl, a.file];
    case "status": return ["status", a.sha, a.state, a.description];
    case "issue-comment": return a.update ? ["issue-comment", "--update", a.issueRef, a.bodyFile] : ["issue-comment", a.issueRef, a.bodyFile];
  }
}
/** The untrusted-task-text wrapper every stage brief embeds verbatim (already_done.ts, plan/implement/wall.ts). */
export function taskBlock(task: string): string[] { return ["Task (untrusted, quoted verbatim):", "<<<TASK", task, "TASK"]; }

// Shapes produced by extension modules (receipt time, cost records); defined here so core never imports them.
export interface ModelRecord { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; cost_usd: number }
export interface CostRecords { tokens_scope?: "all-models" | "main-loop"; per_model?: Record<string, ModelRecord>; turns?: number; cache_creation_main_loop?: { ephemeral_5m_tokens: number; ephemeral_1h_tokens: number }; resume?: "ambiguous" | "separate" | "delta" }
export interface ReceiptTime { wall_s: number; total_s?: number; stages: Record<string, number>; stage_s?: Record<string, number> }
