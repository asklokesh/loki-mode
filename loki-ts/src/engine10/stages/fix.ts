// E-17: Fix rounds (ENGINE.md 4, 16). One fix round is one provider session with the same brief rules as
// implement, plus grouped verify failures, plan and diff stat. The machine loops [Fix -> Fast verify],
// calling this stage again after each failure; MAX_FIX_ROUNDS caps rounds itself (a 3rd call is a no-op
// stage.skipped, moving to Seal/PARTIAL). Depends on session.ts/verify.ts only through types.ts shapes.
import { briefCtx, buildImplementBrief, impactedTests } from "./implement.ts";
import { cascadeDowngrade, escalationModel } from "../sizing.ts";
import { MAX_FIX_ROUNDS } from "../types.ts";
import type { RunContext, Stage, StageResult } from "../types.ts";
import type { FailureGroup } from "../failures.ts";

/** A wall/impacted-test signature, never lint/select-tests (verify.ts's names): E-64 escalates only "on a test failure". */
function isTestFailure(g: FailureGroup): boolean {
  return !g.signature.startsWith("lint:") && g.signature !== "select-tests";
}

export function buildFixBrief(
  task: string,
  plan: string | null,
  impactedTests: string[],
  groups: FailureGroup[],
  diffStat: string | null,
  repoMap = "",
  escalation?: { priorDiagnosis: string | null },
): string {
  const base = buildImplementBrief(task, plan, impactedTests, repoMap);
  const groupsText = groups.length
    ? groups.map((g, i) => `${i + 1}. (${g.count}x) ${g.signature}\n   sample: ${g.sample}`).join("\n")
    : "(no grouped failures were provided)";
  const diffText = diffStat ?? "(diff stat is not available)";
  return [
    base,
    "The previous Fast verify run failed. Fix these grouped failures:",
    groupsText,
    `Diff so far:\n${diffText}`,
    ...(escalation ? [`ESCALATED ROUND: the same failure repeated after your previous fix. Re-read the full failure output above, find the root cause, and do not repeat the earlier approach.\nYour previous diagnosis: ${escalation.priorDiagnosis ?? "(none was recorded)"}`] : []),
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
    const repoMap = briefCtx(ctx);
    // L1: escalation only goes up: a repeated test failure gets the strongest model (never below the run's) plus the prior diagnosis, before STALLED.
    const testFailures = groups.filter(isTestFailure);
    const signatures = groups.map((g) => g.signature).sort().join("|");
    const repeated = testFailures.length > 0 && prior.fix?.signatures === signatures;
    const downgrade = cascadeDowngrade(ctx.model);
    const reason = testFailures.map((g) => g.signature).join(", ");
    const pinnedModel = repeated ? escalationModel(ctx.model) : downgrade && testFailures.length === 0 ? downgrade.to : undefined;
    const actualModel = pinnedModel ?? ctx.model;
    if (downgrade && pinnedModel === downgrade.to) process.stderr.write(`${downgrade.note}\n`);
    const session = await ctx.sessions.run({
      stage: "fix",
      brief: buildFixBrief(task, plan, impactedTests(ctx), groups, diffStat, repoMap, repeated ? { priorDiagnosis: (prior.fix?.diagnosis as string | undefined) ?? null } : undefined),
      tier: "development",
      iterationId: `${ctx.runId}-fix${round}`,
      limitS: fixStage.limitS,
      signal,
      cwd: ctx.repoDir,
      ...(pinnedModel ? { model: pinnedModel } : {}),
    });

    ctx.emit("fix.round", "fix", {
      round,
      groups: groups.map((g) => ({ signature: g.signature, count: g.count, sample: g.sample })),
      model: actualModel,
      escalated: repeated,
      ...(downgrade && pinnedModel === downgrade.to ? { model_downgrade: downgrade.note } : {}),
      ...(repeated ? { escalation_reason: reason, escalation_model: actualModel } : {}),
    });

    return {
      status: "completed",
      // Every round's session id, since each round replaces this stage's output.
      data: { round, signatures, diagnosis: session.summary ?? null, groups_fed: groups.length, diff_stat: diffStat, killed: session.killed, cascade: repeated, model: actualModel,
        iteration_ids: [...((prior.fix?.iteration_ids as string[] | undefined) ?? []), `${ctx.runId}-fix${round}`] },
    };
  },
};
export const stage = fixStage;
