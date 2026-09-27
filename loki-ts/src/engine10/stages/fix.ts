// loki-ts/src/engine10/stages/fix.ts
//
// E-17: Fix rounds (docs/v10/ENGINE.md sections 4 and 16). One fix round is
// exactly one provider session, given the same brief rules as implement plus
// the grouped verify failures, the plan and the diff stat. The machine loops
// [Fix -> Fast verify] by calling this stage again after each Fast verify
// failure; this stage enforces the MAX_FIX_ROUNDS cap itself (via the prior
// round number in ctx.outputs().fix) so a third call is a no-op the machine
// can treat like any other stage.skipped and move straight to Seal, which
// records PARTIAL. Depends on E-07 (session.ts) and E-09 (verify.ts) only
// through their types.ts interfaces/output shapes: both are in rework and not
// imported here.
import { buildImplementBrief } from "./implement.ts";
import { MAX_FIX_ROUNDS } from "../types.ts";
import type { RunContext, Stage, StageResult } from "../types.ts";
import type { FailureGroup } from "../failures.ts";

export function buildFixBrief(
  task: string,
  plan: string | null,
  impactedTests: string[],
  groups: FailureGroup[],
): string {
  const base = buildImplementBrief(task, plan, impactedTests);
  const groupsText = groups.length
    ? groups.map((g, i) => `${i + 1}. (${g.count}x) ${g.signature}\n   sample: ${g.sample}`).join("\n")
    : "(no grouped failures were provided)";
  return [base, "The previous Fast verify run failed. Fix these grouped failures:", groupsText].join("\n\n");
}

export const fixStage: Stage = {
  name: "fix",
  targetS: 90,
  limitS: 180,

  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> {
    const prior = ctx.outputs();
    const priorRound = (prior.fix?.round as number | undefined) ?? 0;
    if (priorRound >= MAX_FIX_ROUNDS) {
      return { status: "skipped", data: { round: priorRound }, reason: "fix rounds exhausted" };
    }
    const round = priorRound + 1;

    const task = (prior.intake?.task as string | undefined) ?? "";
    const plan = (prior.plan?.plan as string | undefined) ?? null;
    const impactedTests = (prior.intake?.impacted_tests as string[] | undefined) ?? [];
    const groups = (prior.verify?.failures_grouped as FailureGroup[] | undefined) ?? [];
    const diffStat = (prior.implement?.diff_stat as string | undefined) ?? "";

    const session = await ctx.sessions.run({
      stage: "fix",
      brief: buildFixBrief(task, plan, impactedTests, groups),
      tier: "development",
      iterationId: `${ctx.runId}-fix${round}`,
      limitS: fixStage.limitS,
      signal,
      cwd: ctx.repoDir,
    });

    ctx.emit("fix.round", "fix", {
      round,
      groups: groups.map((g) => ({ signature: g.signature, count: g.count, sample: g.sample })),
    });

    return {
      status: "completed",
      data: { round, groups_fed: groups.length, diff_stat: diffStat, killed: session.killed },
    };
  },
};
