// E-17: Fix rounds (ENGINE.md 4, 16). One fix round is one provider session with the same brief rules as
// implement, plus grouped verify failures, plan and diff stat. The machine loops [Fix -> Fast verify],
// calling this stage again after each failure; MAX_FIX_ROUNDS caps rounds itself (a 3rd call is a no-op
// stage.skipped, moving to Seal/PARTIAL). Depends on session.ts/verify.ts only through types.ts shapes.
import { buildImplementBrief, impactedTests } from "./implement.ts";
import { cascadeEnabled } from "../sizing.ts";
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
    // E-64: a fix round only runs after a fast-verify failure (machine.ts's loop gates on it), so cascade
    // escalates every round to ctx.model (the run's configured model, e.g. LOKI_MODEL_OVERRIDE=claude-opus-5-5).
    const cascade = cascadeEnabled();
    const reason = groups.map((g) => g.signature).join(", ") || "verify failed";

    const session = await ctx.sessions.run({
      stage: "fix",
      brief: buildFixBrief(task, plan, impactedTests(ctx), groups, diffStat),
      tier: "development",
      iterationId: `${ctx.runId}-fix${round}`,
      limitS: fixStage.limitS,
      signal,
      cwd: ctx.repoDir,
      ...(cascade ? { model: ctx.model } : {}),
    });

    ctx.emit("fix.round", "fix", {
      round,
      groups: groups.map((g) => ({ signature: g.signature, count: g.count, sample: g.sample })),
      ...(cascade ? { escalated: true, escalation_reason: reason, escalation_model: ctx.model } : {}),
    });

    return {
      status: "completed",
      // Every round's session id, since each round replaces this stage's output.
      data: { round, groups_fed: groups.length, diff_stat: diffStat, killed: session.killed, cascade,
        iteration_ids: [...((prior.fix?.iteration_ids as string[] | undefined) ?? []), `${ctx.runId}-fix${round}`] },
    };
  },
};
export const stage = fixStage;
