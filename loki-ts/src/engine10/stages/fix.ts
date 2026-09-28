// loki-ts/src/engine10/stages/fix.ts -- E-17 Fix rounds (ENGINE.md sections 4/16). One fix round
// is one provider session, given the same brief rules as implement plus grouped verify failures,
// the plan and the diff stat. The machine loops [Fix -> Fast verify] by calling this stage again
// after each failure; this stage enforces MAX_FIX_ROUNDS itself (via ctx.outputs().fix) so a third
// call is a no-op the machine treats like any stage.skipped, moving to Seal (PARTIAL). Depends on
// session.ts/verify.ts only through their types.ts shapes; neither is imported here.
import { buildImplementBrief, impactedTests } from "./implement.ts";
import { MAX_FIX_ROUNDS } from "../types.ts";
import type { RunContext, Stage, StageResult } from "../types.ts";
import type { FailureGroup } from "../failures.ts";
export function buildFixBrief(
  task: string,
  plan: string | null,
  impactedTests: string[],
  groups: FailureGroup[],
  diffStat: string | null,
): string {
  const base = buildImplementBrief(task, plan, impactedTests);
  const groupsText = groups.length
    ? groups.map((g, i) => `${i + 1}. (${g.count}x) ${g.signature}\n   sample: ${g.sample}`).join("\n")
    : "(no grouped failures were provided)";
  const diffText = diffStat ?? "(diff stat is not available)";
  return [
    base,
    "The previous Fast verify run failed. Fix these grouped failures:",
    groupsText,
    `Diff so far:\n${diffText}`,
  ].join("\n\n");
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
    const groups = (prior.verify?.failures_grouped as FailureGroup[] | undefined) ?? [];
    const diffStat = (prior.implement?.diff_stat as string | undefined) ?? null;
    const session = await ctx.sessions.run({
      stage: "fix",
      brief: buildFixBrief(task, plan, impactedTests(ctx), groups, diffStat),
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
      // Every round's session id, since each round replaces this stage's output.
      data: { round, groups_fed: groups.length, diff_stat: diffStat, killed: session.killed,
        iteration_ids: [...((prior.fix?.iteration_ids as string[] | undefined) ?? []), `${ctx.runId}-fix${round}`] },
    };
  },
};
export const stage = fixStage;
