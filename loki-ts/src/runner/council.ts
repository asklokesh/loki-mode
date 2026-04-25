// Phase 5 Dev D1 -- first slice of completion-council.sh port.
//
// Bash source: autonomy/completion-council.sh (1771 LOC, 19 functions).
// Spec: loki-ts/docs/phase5-research/completion_council.md
//
// This iteration ports only the two functions the runner currently needs to
// satisfy the dynamic-import contract in autonomous.ts:166,189,201:
//
//   - councilInit(prdPath)        -- bash council_init() (line 111-145)
//   - defaultCouncil.shouldStop   -- bash council_should_stop() (line 1605, stubbed false)
//   - defaultCouncil.trackIteration -- bash council_track_iteration() (line 151-240,
//                                       only the convergence.log append is ported here)
//
// The remaining 17 functions (vote orchestration, evidence gathering, devil's
// advocate, aggregation, report writing, managed-memory shadow, etc.) are
// declared as STUB exports below per BUG-22 lessons-learned: every stub
// throws explicitly so the runner picks them up automatically as they land
// in subsequent iterations and never silently no-ops.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { CouncilHook, RunnerContext } from "./types.ts";
import { lokiDir as defaultLokiDir } from "../util/paths.ts";

// ---------------------------------------------------------------------------
// Atomic write helper (POSIX rename is atomic within a directory).
// Mirrors src/runner/checkpoint.ts:atomicWriteFile so we do not introduce a
// new top-level utility just for this slice.
// ---------------------------------------------------------------------------

let _tmpCounter = 0;
function atomicWriteFile(target: string, contents: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${++_tmpCounter}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// councilInit -- bash council_init() (completion-council.sh:111-145).
//
// Bash version writes a heredoc-literal JSON document. We replicate the
// schema verbatim so downstream consumers (dashboard/server.py and the
// to-be-ported aggregate/report functions) can read either runtime's output.
// ---------------------------------------------------------------------------

export type CouncilState = {
  initialized: true;
  enabled: true;
  total_votes: 0;
  approve_votes: 0;
  reject_votes: 0;
  last_check_iteration: 0;
  consecutive_no_change: 0;
  done_signals: 0;
  convergence_history: [];
  verdicts: [];
  // Phase 5 extension: persist the prd path for evidence-gathering callers.
  prd_path: string | null;
};

export async function councilInit(prdPath: string | undefined): Promise<void> {
  // Honour LOKI_DIR env var the same way paths.lokiDir() does. The runner
  // sets ctx.lokiDir but this function is invoked via the dynamic-import
  // contract with only prdPath; resolve via env to stay aligned with bash.
  const stateDir = resolve(defaultLokiDir(), "council");
  mkdirSync(stateDir, { recursive: true });

  const state: CouncilState = {
    initialized: true,
    enabled: true,
    total_votes: 0,
    approve_votes: 0,
    reject_votes: 0,
    last_check_iteration: 0,
    consecutive_no_change: 0,
    done_signals: 0,
    convergence_history: [],
    verdicts: [],
    prd_path: prdPath ?? null,
  };

  // 2-space indent matches python json.dump(indent=2) so cross-runtime
  // checkpoints stay byte-identical with the bash implementation.
  atomicWriteFile(resolve(stateDir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// defaultCouncil -- minimal CouncilHook the runner uses when the caller
// does not inject one. shouldStop returns false until the full evaluate
// pipeline lands; trackIteration appends a convergence.log row.
//
// Bash source: completion-council.sh:215 -- echo "$timestamp|$ITERATION_COUNT|
//                                            $files_changed|$no_change|$done"
// We emit the same pipe-delimited schema so the existing dashboard parser
// (dashboard/server.py) keeps working when the runner is driven from Bun.
// ---------------------------------------------------------------------------

export const defaultCouncil: CouncilHook = {
  async shouldStop(_ctx: RunnerContext): Promise<boolean> {
    // STUB: full council_should_stop pipeline (council_evaluate +
    // circuit-breaker + report write) lands in Phase 5 next iteration.
    // Returning false keeps the loop running; the runner already has
    // independent termination paths (max_iterations, completion-promise,
    // STOP signal) so this is safe.
    return false;
  },
  async trackIteration(logFile: string): Promise<void> {
    const stateDir = resolve(defaultLokiDir(), "council");
    mkdirSync(stateDir, { recursive: true });
    const convergenceLog = resolve(stateDir, "convergence.log");
    // Schema mirror: timestamp|iteration|files_changed|no_change|done_signals
    // First-slice port: we do not yet shell out to git for diff hashing or
    // tail-grep the agent log for "done" signals -- those land with the full
    // council_track_iteration port. We persist a row keyed off the log file
    // path so the dashboard sees activity and the file shape is correct.
    const timestamp = Math.floor(Date.now() / 1000);
    const iteration = readIterationFromState(stateDir);
    const row = `${timestamp}|${iteration}|0|0|0|${logFile}\n`;
    appendFileSync(convergenceLog, row);
  },
};

function readIterationFromState(stateDir: string): number {
  const f = resolve(stateDir, "state.json");
  if (!existsSync(f)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(f, "utf-8")) as Partial<CouncilState>;
    const v = parsed.last_check_iteration;
    return typeof v === "number" ? v : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// STUB exports -- listed here so consumers see they exist, fail loud if
// invoked, and so the next-iteration porter has a clear checklist. Per
// BUG-22 lessons-learned: do NOT silently no-op, throw with the bash cite.
// ---------------------------------------------------------------------------

export type Vote = {
  role: string;
  verdict: "APPROVE" | "REJECT" | "CANNOT_VALIDATE";
  reason: string;
  issues: { severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; description: string }[];
};

export type AggregateResult = {
  decision: "COMPLETE" | "CONTINUE";
  unanimous: boolean;
  approveCount: number;
  rejectCount: number;
  votes: Vote[];
};

export type CouncilEvaluateContext = {
  ctx: RunnerContext;
  iteration: number;
};

export async function councilEvaluate(_ctx: CouncilEvaluateContext): Promise<AggregateResult> {
  // STUB: Phase 5 next iteration. Bash source: completion-council.sh:1340-1385.
  // Pipeline: reverify_checklist -> checklist_gate -> aggregate_votes ->
  //          (if unanimous) devils_advocate_review -> verdict.
  throw new Error("council.councilEvaluate: STUB -- not yet ported (bash council_evaluate, completion-council.sh:1340)");
}

export async function councilAggregateVotes(_votes: readonly Vote[]): Promise<AggregateResult> {
  // STUB: Phase 5 next iteration. Bash source: completion-council.sh:1137-1221.
  // Polls COUNCIL_SIZE members via council_evaluate_member, computes the
  // 2/3 ceiling threshold, writes round-N.json into the state dir.
  throw new Error("council.councilAggregateVotes: STUB -- not yet ported (bash council_aggregate_votes, completion-council.sh:1137)");
}

export async function councilDevilsAdvocate(_votes: readonly Vote[]): Promise<Vote> {
  // STUB: Phase 5 next iteration. Bash source: completion-council.sh:866-944
  // and the re-evaluation path at completion-council.sh:1236-1327. Triggered
  // when an aggregate vote is unanimous APPROVE; intentionally finds reasons
  // to reject so the council resists sycophancy.
  throw new Error("council.councilDevilsAdvocate: STUB -- not yet ported (bash council_devils_advocate, completion-council.sh:866)");
}

export async function councilWriteReport(_verdicts: readonly AggregateResult[]): Promise<void> {
  // STUB: Phase 5 next iteration. Bash source: completion-council.sh:1714-1752.
  // Writes .loki/council/report.md with convergence data, config and vote
  // history. Called from council_should_stop right before returning STOP.
  throw new Error("council.councilWriteReport: STUB -- not yet ported (bash council_write_report, completion-council.sh:1714)");
}
