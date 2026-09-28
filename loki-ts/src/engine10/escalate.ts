// loki-ts/src/engine10/escalate.ts -- E-29 Escalation (ENGINE.md section 13): decides whether a
// run needs --deep-level resources, and logs it. Depends on machine.ts/plan.ts only through the
// RunContext shape (types.ts), the same fake-friendly pattern eta.ts uses.
// ponytail: no caller wires decide()/apply() in yet; wiring point is after intake+plan, before
// Implement (the first stage whose limit already reads ctx.deep, machine.ts:99).
import { DEEP_CAP_S, DEEP_IMPLEMENT_LIMIT_S, DEFAULT_CAP_S, STAGE_BUDGETS } from "./types.ts";
import type { RunContext } from "./types.ts";
/** Section 13: "the repo has more than 20,000 tracked files". */
export const REPO_FILE_TRIGGER = 20_000;
/** Section 13: "the plan names more than 12 files". */
export const PLAN_FILE_TRIGGER = 12;
/** Section 13: "the issue carries an `epic` or `large` label". */
export const ESCALATION_LABELS: readonly string[] = ["epic", "large"];
export type EscalationReason = "deep-flag" | "repo-size" | "plan-files" | "issue-label";
export interface EscalationInput {
  /** `--deep` on the CLI. */
  deepFlag: boolean;
  /** Tracked-file count of the target repo. */
  repoFileCount: number;
  /** plan.ts's stage.completed.data.relevant_files (section 4). */
  planFiles: readonly string[];
  /** Issue labels, when the run is issue-mode. */
  issueLabels?: readonly string[];
}
export interface EscalationDecision {
  escalate: boolean;
  reason: EscalationReason | null;
  capS: number;
  implementLimitS: number;
  fullSuite: boolean;
}
/** Pure decision. Checked in this order so `reason` names the first trigger
 *  that held; section 13 does not rank its triggers, so first-match is as
 *  good as any and keeps the result deterministic. */
export function decide(input: EscalationInput): EscalationDecision {
  const labels = input.issueLabels ?? [];
  const reason: EscalationReason | null = input.deepFlag
    ? "deep-flag"
    : input.repoFileCount > REPO_FILE_TRIGGER
      ? "repo-size"
      : input.planFiles.length > PLAN_FILE_TRIGGER
        ? "plan-files"
        : labels.some((l) => ESCALATION_LABELS.includes(l.toLowerCase()))
          ? "issue-label"
          : null;
  const escalate = reason !== null;
  return {
    escalate,
    reason,
    capS: escalate ? DEEP_CAP_S : DEFAULT_CAP_S,
    implementLimitS: escalate ? DEEP_IMPLEMENT_LIMIT_S : STAGE_BUDGETS.implement.limitS,
    fullSuite: escalate,
  };
}
/** Section 13: "always logged as an `escalated` event and shown in the
 *  summary". Emits only when decide() triggers; never mutates `ctx` --
 *  the (future) caller applies capS/deep to the RunContext it builds. */
export function apply(ctx: Pick<RunContext, "emit">, input: EscalationInput): EscalationDecision {
  const decision = decide(input);
  if (decision.escalate) {
    ctx.emit("escalated", null, {
      reason: decision.reason,
      cap_s: decision.capS,
      implement_limit_s: decision.implementLimitS,
    });
  }
  return decision;
}
