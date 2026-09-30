// E-17: Fix rounds (ENGINE.md 4, 16). One fix round is one provider session with the same brief rules as
// implement, plus grouped verify failures, plan and diff stat. The machine loops [Fix -> Fast verify],
// calling this stage again after each failure; MAX_FIX_ROUNDS caps rounds itself (a 3rd call is a no-op
// stage.skipped, moving to Seal/PARTIAL). Depends on session.ts/verify.ts only through types.ts shapes.
import { briefCtx, buildImplementBrief, impactedTests } from "./implement.ts";
import { cascadeEnabled, cascadeImplementModel, resolveModelAlias } from "../sizing.ts";
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
    // E-64/D31: escalate to the top model only on a genuine test failure, and only when the run has a
    // configured top model to escalate to (never a phantom "sonnet escalates to sonnet"). A round that does
    // NOT escalate must still run on the cheap model, not silently inherit the run's configured model (which
    // may be the top model via LOKI_MODEL_OVERRIDE): D31 gives an unescalated fix round to the cheap model.
    const testFailures = groups.filter(isTestFailure);
    // resolveModelAlias on both sides: ctx.model may be an unresolved alias (e.g. LOKI_MODEL_OVERRIDE=sonnet)
    // while cascadeImplementModel() always resolves through the catalog, so a bare string compare would
    // count "sonnet" vs its own resolved id as an escalation.
    const cascade = cascadeEnabled() && testFailures.length > 0 && resolveModelAlias(ctx.model) !== cascadeImplementModel();
    const reason = testFailures.map((g) => g.signature).join(", ");
    const pinnedModel = cascade ? ctx.model : cascadeEnabled() ? cascadeImplementModel() : undefined;
    // The model this round actually runs on, matching session.ts's own opts.model ?? cfg.model precedence:
    // fix.round must report the model the session was really given, in both the escalated and cheap case.
    const actualModel = pinnedModel ?? ctx.model;

    const session = await ctx.sessions.run({
      stage: "fix",
      brief: buildFixBrief(task, plan, impactedTests(ctx), groups, diffStat, repoMap),
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
      escalated: cascade,
      ...(cascade ? { escalation_reason: reason, escalation_model: actualModel } : {}),
    });

    return {
      status: "completed",
      // Every round's session id, since each round replaces this stage's output.
      data: { round, groups_fed: groups.length, diff_stat: diffStat, killed: session.killed, cascade, model: actualModel,
        iteration_ids: [...((prior.fix?.iteration_ids as string[] | undefined) ?? []), `${ctx.runId}-fix${round}`] },
    };
  },
};
export const stage = fixStage;
