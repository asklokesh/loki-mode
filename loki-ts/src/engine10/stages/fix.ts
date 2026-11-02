// E-17: Fix rounds (ENGINE.md 4, 16). One fix round is one provider session: the fixed rules, the task, the failing tests with their first error lines and the diff of the files the run changed (no plan, repo map or file list, so the session does not reread the repo). The machine loops [Fix -> Fast verify], calling this stage
// again after each failure; MAX_FIX_ROUNDS caps rounds itself (a 3rd call is a no-op stage.skipped, moving to Seal/PARTIAL). Depends on session.ts/verify.ts only through types.ts shapes.
import { withStagePrefix } from "../../features/lean_prefix.ts"; import { FINISH_LINE, FIXED_RULES } from "../../e10ext/context.ts";
import { routedFix, routerActive } from "../../runner/router/unit_model.ts"; import { autoFixRound, autoRouteActive } from "../../runner/router/auto_route.ts";
import { cascadeDowngrade, escalationModel } from "../sizing.ts";
import { MAX_FIX_ROUNDS, type RunContext, type Stage, type StageResult, taskBlock } from "../types.ts";
import type { FailureGroup } from "../failures.ts";
import { hooks } from "../hooks.ts";
import { treeFingerprint } from "../../util/anti_loop.ts";
import { buildFixResumeBrief, currentDiff, holdoutNote, runFixSession } from "../../runner/session_resume.ts";
import { adjudicateWallConflict } from "../../util/conflict_resume.ts"; import { type ReadOnlyFile, restoreReadOnly } from "./implement.ts"; import { restoreBaseTests } from "../../util/test_guard.ts";
import { installOwned } from "../../project_model/install.ts";

/** A wall/impacted-test signature, never lint/select-tests (verify.ts's names): E-64 escalates only "on a test failure". */
function isTestFailure(g: FailureGroup): boolean { return !g.signature.startsWith("lint:") && g.signature !== "select-tests"; }

export function buildFixBrief(task: string, groups: FailureGroup[], diff: string | null, escalation?: { priorDiagnosis: string | null }, holdoutFailed = 0): string {
  return withStagePrefix([ // FIXED_RULES leads (the cache-stable prefix implement shares) and FINISH_LINE closes
    FIXED_RULES,
    ...taskBlock(task),
    "The previous Fast verify run failed. Fix the code these failures name; do not hunt for a different bug and do not edit or delete an existing test. Each sample starts with the command that reruns it:",
    groups.length ? groups.map((g, i) => `${i + 1}. (${g.count}x) ${g.signature}\n   sample: ${g.sample}`).join("\n") : "(no grouped failures were provided)",
    ...holdoutNote(holdoutFailed),
    `Diff of the files this run changed:\n${diff ?? "(the diff is not available)"}`,
    ...(escalation ? [`ESCALATED ROUND: the same failure repeated after your previous fix. Re-read the full failure output above, find the root cause, and do not repeat the earlier approach.\nYour previous diagnosis: ${escalation.priorDiagnosis ?? "(none was recorded)"}`] : []),
    FINISH_LINE,
  ].join("\n\n"));
}

export const fixStage: Stage = {
  name: "fix",
  targetS: 90,
  limitS: 180,

  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> {
    const prior = ctx.outputs();
    const priorRound = (prior.fix?.round as number | undefined) ?? 0;
    const routed = routerActive(), auto = !routed && autoRouteActive(process.env, ctx.provider), stallEsc = (routed || auto) && prior.fix?.stall_escalated === true; // R1-13: a stall escalation grants one extra round on the next rung
    if (priorRound >= MAX_FIX_ROUNDS + (stallEsc ? 1 : 0)) {
      return { status: "skipped", data: { round: priorRound }, reason: "fix rounds exhausted" };
    }
    const round = priorRound + 1;

    const task = (prior.intake?.task as string | undefined) ?? "";
    const groups = (prior.verify?.failures_grouped as FailureGroup[] | undefined) ?? [];
    const holdoutFailed = (prior.verify?.holdout_failed as number | undefined) ?? 0;
    const diffStat = currentDiff(ctx.repoDir, ctx.baseSha, 6000, true, installOwned(ctx.repoDir, ctx.outputs().intake?.install_created)); // stat plus bounded hunks every round
    const treeBefore = treeFingerprint(ctx.repoDir, ctx.baseSha); // anti-loop: compared with tree_after in machine.ts
    // L1: escalation only goes up: a repeated test failure gets the strongest model (never below the run's) plus the prior diagnosis, before STALLED.
    const testFailures = groups.filter(isTestFailure);
    const signatures = groups.map((g) => g.signature).sort().join("|");
    const repeated = testFailures.length > 0 && prior.fix?.signatures === signatures;
    const downgrade = routed ? null : cascadeDowngrade(ctx.model); // the router replaces the opt-in downgrade list
    const reason = testFailures.map((g) => g.signature).join(", ");
    const pinnedModel = auto ? undefined : repeated ? escalationModel(ctx.model) : downgrade && testFailures.length === 0 ? downgrade.to : undefined; // auto routing decides its own climb (Sonnet, never Opus)
    const ar = auto ? autoFixRound(ctx, round, groups, prior.fix?.stall_pending === true) : null; // (b) the advisor on round 1, (c) Sonnet from round 2, code-owned failures only
    const { pin: routedPin, climbed } = routed ? routedFix(ctx.model, prior, { repeated, stall: prior.fix?.stall_pending === true, groups, reason }) : { pin: undefined, climbed: null };
    const actualModel = ar?.model ?? routedPin ?? pinnedModel ?? ctx.model;
    if (downgrade && pinnedModel === downgrade.to) process.stderr.write(`${downgrade.note}\n`);
    if (climbed) ctx.emit("route.escalated", "fix", { ...climbed });
    const prevDiag = (prior.fix?.diagnosis as string | undefined) ?? null; const chain = { sessionId: (prior.fix?.session_id ?? prior.implement?.session_id ?? null) as string | null, model: (prior.fix?.model ?? prior.implement?.model ?? ctx.model) as string };
    const effort = hooks.effort?.fix(round, testFailures.length > 0);
    const sessionBase = { stage: "fix" as const, tier: "development" as const, limitS: fixStage.limitS, signal, cwd: ctx.repoDir, ...(effort ? { effort } : {}), ...(pinnedModel ? { model: pinnedModel } : {}), ...(routedPin ? { model: routedPin } : {}), ...(ar && ar.model !== ctx.model ? { model: ar.model, routeGrant: ar.decision } : {}), ...(ar?.advisor ? { advisorModel: ar.advisor } : {}) };
    const fullBrief = buildFixBrief(task, groups, diffStat, repeated ? { priorDiagnosis: prevDiag } : undefined, holdoutFailed);
    let r = await runFixSession(ctx, sessionBase, `${ctx.runId}-fix${round}`, (prior.fix?.iteration_ids as string[] | undefined) ?? [], chain, actualModel, fullBrief, buildFixResumeBrief(groups, diffStat, prevDiag, holdoutFailed)); // one session per round: a spec conflict starts no retry; the unchanged-tree rule below decides whether it is believed
    const ro = (prior.wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? [], wd = r.session.markers.specConflict && !r.session.killed ? await adjudicateWallConflict(ctx, { ...sessionBase, iterationId: r.ids[r.ids.length - 1]!, brief: fullBrief }, r.session, ro) : null; if (wd) r = { ...r, session: wd.session, ids: [...r.ids, ...wd.ids] }; // FC-WALL-DEFECT-REPORTED-AS-SPEC-CONFLICT
    const testsReverted = [...restoreReadOnly(ro), ...restoreBaseTests(ctx.repoDir, ctx.baseSha, prior.intake)]; // the Wall and pre-existing tests are read-only after any fix pass
    const treeAfter = treeFingerprint(ctx.repoDir, ctx.baseSha), conflict =r.session.markers.specConflict && !r.session.killed && treeBefore !== null && treeBefore === treeAfter ? r.session.markers.specConflict : null; // evidence: a claim from a round that edited the tree is work in progress, not an escape from the failure
    ctx.emit("fix.round", "fix", {
      round,
      groups: groups.map((g) => ({ signature: g.signature, count: g.count, sample: g.sample })),
      model: actualModel,
      escalated: repeated || climbed !== null, fix_resume: r.mode, cache_read_tokens: r.cacheRead,
      ...(downgrade && pinnedModel === downgrade.to ? { model_downgrade: downgrade.note } : {}),
      ...(repeated ? { escalation_reason: reason, escalation_model: actualModel } : {}),
    });

    return {
      status: "completed",
      // Every round's session id, since each round replaces this stage's output.
      data: { round, signatures, diagnosis: r.session.summary ?? null, groups_fed: groups.length, diff_stat: diffStat, tree_before: treeBefore, tree_after: treeAfter, ...(conflict ? { exit: "spec_conflict", spec_conflict_reason: conflict } : {}), killed: r.session.killed, tests_reverted: testsReverted, cascade: repeated, model: actualModel,
        ...(stallEsc ? { stall_escalated: true } : {}), ...(climbed ? { route_escalation: climbed } : {}), iteration_ids: r.ids, session_id: r.sessionId, fix_resume: r.mode, ...(r.why ? { fix_resume_why: r.why } : {}),
        fix_rounds: [...((prior.fix?.fix_rounds as unknown[] | undefined) ?? []), { round, fix_resume: r.mode, cache_read_tokens: r.cacheRead }] },
    };
  },
};
export const stage = fixStage;
