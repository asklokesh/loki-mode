// Phase 5 Dev D2 -- second slice of completion-council.sh port.
//
// Bash source: autonomy/completion-council.sh (1771 LOC, 19 functions).
// Spec: loki-ts/docs/phase5-research/completion_council.md
//
// First slice (D1) ported councilInit + defaultCouncil.{shouldStop,trackIteration}.
// Second slice (D2) replaces the four STUBs with real implementations:
//
//   - councilEvaluate(ctx)        -- bash council_evaluate (line ~1340)
//   - councilAggregateVotes(votes)-- bash council_aggregate_votes (line ~1137)
//   - councilDevilsAdvocate(votes)-- bash council_devils_advocate +
//                                     council_devils_advocate_review (~866, ~1236)
//   - councilWriteReport(verdicts)-- bash council_write_report (line ~1714)
//
// Voter dispatch is INJECTABLE: callers (and tests) supply the voter
// implementations rather than this module shelling out to a real provider
// CLI. The default voter set in DEFAULT_VOTERS is heuristic-only so the
// module remains usable without a provider, mirroring the bash
// council_heuristic_review fallback path.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import type { CouncilHook, RunnerContext } from "./types.ts";
import { lokiDir as defaultLokiDir } from "../util/paths.ts";

// ---------------------------------------------------------------------------
// Atomic write helper (POSIX rename is atomic within a directory).
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
// (unchanged from D1 slice -- DO NOT TOUCH per task brief.)
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
  prd_path: string | null;
};

export async function councilInit(prdPath: string | undefined): Promise<void> {
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

  atomicWriteFile(resolve(stateDir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// defaultCouncil -- minimal CouncilHook (unchanged from D1 slice -- DO NOT
// TOUCH per task brief).
// ---------------------------------------------------------------------------

export const defaultCouncil: CouncilHook = {
  async shouldStop(_ctx: RunnerContext): Promise<boolean> {
    return false;
  },
  async trackIteration(logFile: string): Promise<void> {
    const stateDir = resolve(defaultLokiDir(), "council");
    mkdirSync(stateDir, { recursive: true });
    const convergenceLog = resolve(stateDir, "convergence.log");
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
// Vote / Verdict types
//
// AgentVerdict is the per-voter verdict shape. Vote is a backwards-compatible
// alias for callers that already imported it from the D1 slice.
// ---------------------------------------------------------------------------

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type AgentVerdict = {
  role: string;
  verdict: "APPROVE" | "REJECT" | "CANNOT_VALIDATE";
  reason: string;
  issues: { severity: Severity; description: string }[];
};

export type Vote = AgentVerdict;

export type AggregateResult = {
  decision: "COMPLETE" | "CONTINUE";
  unanimous: boolean;
  approveCount: number;
  rejectCount: number;
  cannotValidateCount: number;
  threshold: number;
  totalMembers: number;
  blockingSeverity: Severity | null;
  votes: AgentVerdict[];
};

export type Voter = (ctx: CouncilEvaluateContext) => Promise<AgentVerdict>;

export type CouncilEvaluateContext = {
  ctx: RunnerContext;
  iteration: number;
  // Optional injected voter set. When omitted DEFAULT_VOTERS is used so the
  // function is callable from production code with no extra wiring.
  voters?: readonly Voter[];
  // Optional severity threshold override. Default mirrors bash
  // COUNCIL_SEVERITY_THRESHOLD (HIGH) -- any issue at or above this severity
  // forces a CONTINUE verdict regardless of vote count.
  severityThreshold?: Severity;
};

// Severity ordering: lower index = more severe.
const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}
function isAtOrAbove(found: Severity, threshold: Severity): boolean {
  return severityRank(found) <= severityRank(threshold);
}

// ---------------------------------------------------------------------------
// Default voter set -- heuristic-only, deterministic, no provider calls.
// Mirrors the bash council_heuristic_review fallback so the module is usable
// in CI without a provider CLI installed.
// ---------------------------------------------------------------------------

const DEFAULT_VOTER_ROLES = ["requirements_verifier", "test_auditor", "devils_advocate"] as const;

const heuristicVoter = (role: string): Voter => async (cec) => {
  const issues: AgentVerdict["issues"] = [];
  const lokiRoot = cec.ctx.lokiDir;
  const failedFile = resolve(lokiRoot, "queue", "failed.json");
  if (existsSync(failedFile)) {
    try {
      const failed = JSON.parse(readFileSync(failedFile, "utf-8")) as unknown;
      if (Array.isArray(failed)) {
        // Tighten: only count entries that look like real task records --
        // an object with a `task` or `id` field. Garbage entries (strings,
        // numbers, null, objects without task/id) are ignored so a single
        // malformed row cannot trip the REJECT heuristic.
        const validCount = failed.reduce<number>((acc, entry) => {
          if (
            entry !== null &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            ("task" in (entry as Record<string, unknown>) ||
              "id" in (entry as Record<string, unknown>))
          ) {
            return acc + 1;
          }
          return acc;
        }, 0);
        if (validCount > 0) {
          issues.push({ severity: "HIGH", description: `${validCount} tasks in failed queue` });
        }
      }
    } catch (err) {
      const msg = `council heuristic voter: failed to parse ${failedFile}: ${(err as Error).message}`;
      const log = (cec.ctx as Partial<RunnerContext>).log;
      if (typeof log === "function") {
        log(msg);
      } else {
        console.warn(msg);
      }
    }
  }
  if (issues.length > 0) {
    return { role, verdict: "REJECT", reason: "heuristic: failing tasks present", issues };
  }
  return { role, verdict: "APPROVE", reason: "heuristic: no blocking signals", issues: [] };
};

export const DEFAULT_VOTERS: readonly Voter[] = DEFAULT_VOTER_ROLES.map((r) => heuristicVoter(r));

// ---------------------------------------------------------------------------
// councilAggregateVotes -- bash council_aggregate_votes (line ~1137).
//
// Pure function: takes verdicts, computes 2/3 ceiling threshold, performs
// severity-budget gate.
// ---------------------------------------------------------------------------

export async function councilAggregateVotes(
  votes: readonly AgentVerdict[],
  opts: { severityThreshold?: Severity } = {},
): Promise<AggregateResult> {
  const total = votes.length;
  let approve = 0;
  let reject = 0;
  let cannotValidate = 0;
  let blockingSeverity: Severity | null = null;
  const threshold = opts.severityThreshold ?? "HIGH";

  for (const v of votes) {
    if (v.verdict === "APPROVE") approve++;
    else if (v.verdict === "REJECT") reject++;
    else cannotValidate++;
    for (const issue of v.issues) {
      if (isAtOrAbove(issue.severity, threshold)) {
        if (
          blockingSeverity === null ||
          severityRank(issue.severity) < severityRank(blockingSeverity)
        ) {
          blockingSeverity = issue.severity;
        }
      }
    }
  }

  // 2/3 ceiling -- mirrors bash `(( (total * 2 + 2) / 3 ))`.
  const approvalThreshold = total === 0 ? 0 : Math.floor((total * 2 + 2) / 3);
  let decision: "COMPLETE" | "CONTINUE" = "CONTINUE";
  if (total > 0 && approve >= approvalThreshold && blockingSeverity === null) {
    decision = "COMPLETE";
  }
  const unanimous = total > 0 && approve === total;

  return {
    decision,
    unanimous,
    approveCount: approve,
    rejectCount: reject,
    cannotValidateCount: cannotValidate,
    threshold: approvalThreshold,
    totalMembers: total,
    blockingSeverity,
    votes: [...votes],
  };
}

// ---------------------------------------------------------------------------
// councilDevilsAdvocate -- anti-sycophancy on unanimous APPROVE.
// Bash sources: completion-council.sh:866 and :1236.
//
// On unanimous APPROVE, runs a deterministic skeptical scan:
//   1. failed.json present and non-empty
//   2. recent error events in events.jsonl (>0 in last 50 rows)
//   3. test logs missing OR present without pass marker
// On non-unanimous input we return an APPROVE marker (no-op) so callers
// can simply check `.verdict === "REJECT"` to detect a veto.
// ---------------------------------------------------------------------------

export async function councilDevilsAdvocate(
  votes: readonly AgentVerdict[],
  opts: { lokiDir?: string; iteration?: number } = {},
): Promise<AgentVerdict> {
  const total = votes.length;
  const allApprove = total > 0 && votes.every((v) => v.verdict === "APPROVE");

  // Phase 1 (v7.5.0) -- mirror the APPROVE-side anti-sycophancy on REJECT.
  // When all voters REJECT AND a counter-evidence file exists for the
  // iteration, surface the dispute as CANNOT_VALIDATE so the council
  // aggregator does not lock in REJECT silently. The actual judge panel
  // runs in quality_gates.runCodeReview where the per-reviewer findings
  // are available -- this hook only marks "operator disputes; see code
  // review override transcripts." Critical correctness: NEVER return
  // APPROVE based on file presence alone (council review R1 finding D).
  const allReject = total > 0 && votes.every((v) => v.verdict === "REJECT");
  if (allReject && process.env["LOKI_OVERRIDE_COUNCIL"] === "1") {
    const root = opts.lokiDir ?? defaultLokiDir();
    const iter = opts.iteration ?? -1;
    try {
      const ce = await import("./counter_evidence.ts");
      const evidence = ce.loadCounterEvidence(root, iter);
      if (evidence !== null && evidence.evidence.length > 0) {
        return {
          role: "devils_advocate",
          verdict: "CANNOT_VALIDATE",
          reason: `operator-supplied counter-evidence (${evidence.evidence.length} item${evidence.evidence.length === 1 ? "" : "s"}) -- inspect quality/reviews/<id>/override-*.json for judge panel result`,
          issues: [],
        };
      }
    } catch {
      // override path is best-effort; fall through to default no-op behavior
    }
  }

  if (!allApprove) {
    return {
      role: "devils_advocate",
      verdict: "APPROVE",
      reason: "no-op: not unanimous APPROVE, devil's advocate not triggered",
      issues: [],
    };
  }

  const root = opts.lokiDir ?? defaultLokiDir();
  const issues: AgentVerdict["issues"] = [];

  // Check 1: failed-tasks queue
  const failedFile = resolve(root, "queue", "failed.json");
  if (existsSync(failedFile)) {
    try {
      const failed = JSON.parse(readFileSync(failedFile, "utf-8")) as unknown;
      if (Array.isArray(failed) && failed.length > 0) {
        issues.push({ severity: "HIGH", description: `${failed.length} tasks in failed queue` });
      }
    } catch {
      // ignore
    }
  }

  // Check 2: recent error events
  const eventsFile = resolve(root, "events.jsonl");
  if (existsSync(eventsFile)) {
    let lines: string[] | null = null;
    try {
      lines = readFileSync(eventsFile, "utf-8").split("\n").slice(-50);
    } catch (err) {
      console.warn(
        `council devil's advocate: failed to read ${eventsFile}: ${(err as Error).message}`,
      );
      lines = null;
    }
    if (lines !== null) {
      let errors = 0;
      for (const line of lines) {
        if (/"level"\s*:\s*"error"/i.test(line)) errors++;
      }
      if (errors > 0) {
        issues.push({ severity: "MEDIUM", description: `${errors} recent error events` });
      }
    }
  }

  // Check 3: test logs
  const logsDir = resolve(root, "logs");
  let hasTestLog = false;
  let hasPassMarker = false;
  if (existsSync(logsDir)) {
    try {
      for (const entry of readdirSync(logsDir)) {
        if (!/test/i.test(entry) || !entry.endsWith(".log")) continue;
        hasTestLog = true;
        try {
          const full = resolve(logsDir, entry);
          if (statSync(full).isFile()) {
            const tail = readFileSync(full, "utf-8").split("\n").slice(-30).join("\n");
            if (/passed|success|all tests|\bok\b/i.test(tail)) {
              hasPassMarker = true;
            }
          }
        } catch {
          // ignore unreadable
        }
      }
    } catch {
      // ignore
    }
  }
  if (!hasTestLog) {
    issues.push({ severity: "MEDIUM", description: "no test result logs found" });
  } else if (!hasPassMarker) {
    issues.push({ severity: "HIGH", description: "test logs lack a pass marker" });
  }

  if (issues.length === 0) {
    return {
      role: "devils_advocate",
      verdict: "APPROVE",
      reason: "anti-sycophancy: no issues found, COMPLETE upheld",
      issues: [],
    };
  }
  return {
    role: "devils_advocate",
    verdict: "REJECT",
    reason: `anti-sycophancy veto: ${issues.length} issue(s) found`,
    issues,
  };
}

// ---------------------------------------------------------------------------
// councilEvaluate -- bash council_evaluate (line ~1340).
//
// Orchestrates the 3 voters in order, aggregates, and runs the devil's
// advocate when the aggregate is unanimous APPROVE. The DA veto is
// materialized by replacing AggregateResult.decision with CONTINUE and
// appending the contrarian verdict to the votes list.
// ---------------------------------------------------------------------------

export async function councilEvaluate(cec: CouncilEvaluateContext): Promise<AggregateResult> {
  const voters = cec.voters ?? DEFAULT_VOTERS;
  const verdicts: AgentVerdict[] = [];
  for (const voter of voters) {
    // Sequential -- matches bash member loop and keeps logs deterministic.
    const v = await voter(cec);
    verdicts.push(v);
  }

  const aggregate = await councilAggregateVotes(verdicts, {
    severityThreshold: cec.severityThreshold ?? "HIGH",
  });

  if (aggregate.unanimous && aggregate.decision === "COMPLETE") {
    const contrarian = await councilDevilsAdvocate(verdicts, { lokiDir: cec.ctx.lokiDir });
    if (contrarian.verdict === "REJECT") {
      return {
        ...aggregate,
        decision: "CONTINUE",
        unanimous: false,
        rejectCount: aggregate.rejectCount + 1,
        votes: [...aggregate.votes, contrarian],
      };
    }
    return { ...aggregate, votes: [...aggregate.votes, contrarian] };
  }

  return aggregate;
}

// ---------------------------------------------------------------------------
// councilWriteReport -- bash council_write_report (line ~1714).
//
// Writes .loki/council/report.md with convergence data, council config, and
// vote history. The bash version pulls config from $COUNCIL_* env vars; we
// derive equivalents from the AggregateResult list so this stays a pure
// function-of-input and is trivial to test.
// ---------------------------------------------------------------------------

export async function councilWriteReport(
  verdicts: readonly AggregateResult[],
  opts: { lokiDir?: string; iteration?: number } = {},
): Promise<void> {
  const root = opts.lokiDir ?? defaultLokiDir();
  const reportPath = resolve(root, "council", "report.md");
  const last = verdicts.length > 0 ? verdicts[verdicts.length - 1] : null;
  const finalDecision = last?.decision ?? "CONTINUE";
  const iteration = opts.iteration ?? verdicts.length;
  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const lines: string[] = [];
  lines.push("# Completion Council Final Report");
  lines.push("");
  lines.push(`**Date:** ${timestamp}`);
  lines.push(`**Iteration:** ${iteration}`);
  lines.push(`**Verdict:** ${finalDecision === "COMPLETE" ? "APPROVED" : "CONTINUE"}`);
  lines.push("");
  lines.push("## Convergence Data");
  lines.push(`- Total iterations: ${iteration}`);
  lines.push(`- Aggregate rounds recorded: ${verdicts.length}`);
  if (last) {
    lines.push(`- Final approve/reject: ${last.approveCount}/${last.rejectCount}`);
    lines.push(`- Final blocking severity: ${last.blockingSeverity ?? "none"}`);
  }
  lines.push("");
  lines.push("## Council Configuration");
  lines.push(`- Council size: ${last?.totalMembers ?? 0}`);
  lines.push(`- Approval threshold: ${last?.threshold ?? 0}/${last?.totalMembers ?? 0}`);
  lines.push("");
  lines.push("## Vote History");
  if (verdicts.length === 0) {
    lines.push("- No vote history available");
  } else {
    verdicts.forEach((r, i) => {
      lines.push(
        `- Round ${i + 1}: ${r.decision} (${r.approveCount} approve / ${r.rejectCount} reject / ${r.cannotValidateCount} cannot_validate)`,
      );
      for (const v of r.votes) {
        const issueSummary = v.issues.length === 0 ? "no issues" : `${v.issues.length} issue(s)`;
        lines.push(`  - ${v.role}: ${v.verdict} -- ${v.reason} [${issueSummary}]`);
      }
    });
  }
  lines.push("");

  atomicWriteFile(reportPath, lines.join("\n"));
}
