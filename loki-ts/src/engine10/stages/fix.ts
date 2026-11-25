// E-17: Fix rounds (ENGINE.md 4, 16). One fix round is one provider session: the fixed rules, the task, the failing tests with their first error lines and the diff of the files the run changed (no plan, repo map or file list, so the session does not reread the repo). The machine loops [Fix -> Fast verify], calling this stage
// again after each failure; MAX_FIX_ROUNDS caps rounds itself (a 3rd call is a no-op stage.skipped, moving to Seal/PARTIAL). Depends on session.ts/verify.ts only through types.ts shapes.
import { withStagePrefix } from "../../features/lean_prefix.ts"; import { FINISH_LINE, fixedRules } from "../../e10ext/context.ts";
import { routedFix, routerActive } from "../../runner/router/unit_model.ts"; import { roleModel } from "../../util/claude_model.ts";
import { cascadeDowngrade, escalationModel } from "../sizing.ts";
import { MAX_FIX_ROUNDS, replanOn, type RunContext, type Stage, type StageResult, taskBlock } from "../types.ts";
import { environmentShaped, type FailureGroup } from "../failures.ts";
import { hooks } from "../hooks.ts";
import { treeFingerprint } from "../../util/anti_loop.ts";
import { buildFixResumeBrief, currentDiff, holdoutNote, runFixSession } from "../../runner/session_resume.ts";
import { capStopOf } from "../session.ts"; import { adjudicateWallConflict, siteHints } from "../../util/conflict_resume.ts"; import { briefCtx, type ReadOnlyFile, restoreReadOnly } from "./implement.ts";
import { adviceBlock, neverStopActive, neverStopBrief, runConsult } from "../../features/opus_consult.ts";
import { installOwned } from "../../project_model/install.ts"; import { relative, resolve } from "node:path"; import { suiteCmdsOpt } from "../../project_model/package_suite.ts";

/** A wall/impacted-test signature, never lint/select-tests (verify.ts's names): E-64 escalates only "on a test failure". */
function isTestFailure(g: FailureGroup): boolean { return !g.signature.startsWith("lint:") && g.signature !== "select-tests"; }

/** VERIFY-PLAN V6: the replan round's block, in the ESCALATED ROUND paragraph's slot. */
export const stepBackBlock = (summaries: readonly string[]): string => [
  "STEP BACK. Earlier fix rounds took one approach and the failing set did not shrink. Their own summaries:",
  ...(summaries.length ? summaries.map((x, i) => `${i + 1}. ${x.slice(0, 600)}`) : ["(no summary was recorded)"]),
  "Do not continue that approach. Re-read the task and the failures above, write one line that names a different approach, then make it.",
  "Fix the whole class of each failure: every caller and every site of the same pattern, not only the line a failure names.",
].join("\n");
/** VERIFY-PLAN V6: the session a fix round resumes. A replan round starts fresh (no session id) on the round's own model. */
export const fixChain = (prior: Record<string, Record<string, unknown> | undefined>, replan: boolean, actualModel: string, runModel: string): { sessionId: string | null; model: string } =>
  replan ? { sessionId: null, model: actualModel } : { sessionId: (prior.fix?.session_id ?? prior.implement?.session_id ?? null) as string | null, model: (prior.fix?.model ?? prior.implement?.model ?? runModel) as string };
export function buildFixBrief(task: string, groups: FailureGroup[], diff: string | null, escalation?: { priorDiagnosis: string | null; stepBack?: string[] }, holdoutFailed = 0, hints: string | null = null): string {
  return withStagePrefix([ // FIXED_RULES leads (the cache-stable prefix implement shares) and FINISH_LINE closes
    fixedRules(), // Z2: same rules block as implement
    ...taskBlock(task),
    "The previous Fast verify run failed. Fix the code these failures name; do not hunt for a different bug and do not edit or delete an existing test. Each sample starts with the command that reruns it:",
    groups.length ? groups.map((g, i) => `${i + 1}. (${g.count}x) ${g.signature}\n   sample: ${g.sample}`).join("\n") : "(no grouped failures were provided)",
    ...holdoutNote(holdoutFailed),
    `Diff of the files this run changed:\n${diff ?? "(the diff is not available)"}`,
    ...(hints ? [hints] : []),
    ...(escalation?.stepBack ? [stepBackBlock(escalation.stepBack)] : escalation ? [`ESCALATED ROUND: the same failure repeated after your previous fix. Re-read the full failure output above, find the root cause, and do not repeat the earlier approach.\nYour previous diagnosis: ${escalation.priorDiagnosis ?? "(none was recorded)"}`] : []),
    FINISH_LINE,
  ].join("\n\n"));
}
/** RW-03 closure round: the session's brief when the checks pass and the label is still held. The same fixed block and task block lead it, so the
 *  cached prefix is the one implement and the fix rounds share. */
export function buildClosureBrief(task: string, items: readonly { kind: string; why: string }[], diff: string | null): string {
  return withStagePrefix([
    fixedRules(),
    ...taskBlock(task),
    "The change passes its checks, but Loki could not yet call it verified. Each item below is what is still open, in Loki's own words. Close every item you can with the smallest change: usually a test that fails without the change and passes with it, or a test that calls the code the item names. Do not weaken, skip or delete an existing test, and do not change behaviour the task did not ask for. If an item cannot be closed by a change in this repository, leave it and say so in one line.",
    items.length ? items.map((g, i) => `${i + 1}. ${g.kind}\n   ${g.why}`).join("\n") : "(no open item was provided)",
    `Diff of the files this run changed:\n${diff ?? "(the diff is not available)"}`,
    FINISH_LINE,
  ].join("\n\n"));
}

/** The fix round's model pick. ROLE-MODELS: escalate= (LOKI_ROLE_ESCALATE) names the repeated-failure model; a dev pin alone never escalates, never
 *  downgrades and never climbs (rolePin). No role set: exactly the pre-role rule (escalationModel on a repeat, the opt-in cascade downgrade otherwise). */
export function fixRoundModel(runModel: string, repeated: boolean, routed: boolean, testFailures: number, env: NodeJS.ProcessEnv = process.env): { devPin?: string; escPin?: string; rolePin?: string; downgrade: ReturnType<typeof cascadeDowngrade>; pinnedModel?: string } {
  const devPin = roleModel("dev", env), escPin = repeated ? roleModel("escalate", env) : undefined, rolePin = escPin ?? devPin;
  const downgrade = routed || rolePin ? null : cascadeDowngrade(runModel, env); // the router replaces the opt-in downgrade list
  const pinnedModel = rolePin ? rolePin : repeated ? escalationModel(runModel) : downgrade && testFailures === 0 ? downgrade.to : undefined;
  return { ...(devPin ? { devPin } : {}), ...(escPin ? { escPin } : {}), ...(rolePin ? { rolePin } : {}), downgrade, ...(pinnedModel ? { pinnedModel } : {}) };
}

export const fixStage: Stage = {
  name: "fix",
  targetS: 90,
  limitS: 180,

  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> {
    const prior = ctx.outputs();
    const priorRound = (prior.fix?.round as number | undefined) ?? 0;
    const routed = routerActive(), stallEsc = routed && prior.fix?.stall_escalated === true; // R1-13: a stall escalation grants one extra round on the next rung
    const replan = prior.fix?.replan_pending === true; // VERIFY-PLAN V6: the one fresh round machine.ts runs past the cap at a stall
    const closure = prior.fix?.closure_pending as { round: number; items: { kind: string; why: string }[] } | undefined; // RW-03: one session on the open items, set by machine.ts closeOpenItems
    if (!replan && !closure && priorRound >= MAX_FIX_ROUNDS + (stallEsc ? 1 : 0)) {
      return { status: "skipped", data: { round: priorRound }, reason: "fix rounds exhausted" };
    }
    const round = priorRound + 1;

    const task = (prior.intake?.task as string | undefined) ?? "";
    const groups: FailureGroup[] = closure ? closure.items.map((i) => ({ signature: i.kind, count: 1, sample: i.why })) : ((prior.verify?.failures_grouped as FailureGroup[] | undefined) ?? []);
    const holdoutFailed = (prior.verify?.holdout_failed as number | undefined) ?? 0;
    const diffStat = currentDiff(ctx.repoDir, ctx.baseSha, 6000, true, installOwned(ctx.repoDir, ctx.outputs().intake?.install_created)); // stat plus bounded hunks every round
    const treeBefore = treeFingerprint(ctx.repoDir, ctx.baseSha); // anti-loop: compared with tree_after in machine.ts
    // L1: escalation only goes up: a repeated test failure gets the strongest model (never below the run's) plus the prior diagnosis, before STALLED.
    const testFailures = groups.filter(isTestFailure);
    const signatures = groups.filter((g) => !g.carried).map((g) => g.signature).sort().join("|"); // L025: a carried (not rerun) failure never makes a round look repeated
    const repeated = testFailures.length > 0 && prior.fix?.signatures === signatures;
    const { devPin, escPin, rolePin, downgrade, pinnedModel } = fixRoundModel(ctx.model, repeated, routed, testFailures.length);
    const reason = testFailures.map((g) => g.signature).join(", ");
    const { pin: routedPin, climbed } = routed && !rolePin ? routedFix(ctx.model, prior, { repeated, stall: prior.fix?.stall_pending === true, groups, reason }) : { pin: undefined, climbed: null };
    const actualModel = routedPin ?? pinnedModel ?? ctx.model;
    if (downgrade && pinnedModel === downgrade.to) process.stderr.write(`${downgrade.note}\n`);
    if (climbed) ctx.emit("route.escalated", "fix", { ...climbed });
    const prevDiag = (prior.fix?.diagnosis as string | undefined) ?? null; const chain = fixChain(prior, replan || !!closure, actualModel, ctx.model); const carried = (prior.fix?.diagnoses as string[] | undefined) ?? []; // VERIFY-PLAN V6
    const effort = hooks.effort?.fix(round, testFailures.length > 0, { model: actualModel, envOnly: environmentShaped(groups.filter((g) => !g.carried)) });
    const sessionBase = { stage: "fix" as const, tier: "development" as const, limitS: fixStage.limitS, signal, cwd: ctx.repoDir, ...suiteCmdsOpt(ctx.repoDir, prior.intake?.testmap), ...(effort ? { effort } : {}), ...(pinnedModel ? { model: pinnedModel } : {}), ...(routedPin ? { model: routedPin } : {}), ...(escPin ? { role: "escalate" as const } : {}) };
    const hints = siteHints(ctx); // LOKI_E10_SITE_HINTS, advisory
    // LOKI_E10_OPUS_CONSULT: a round after a never-stop fix conflict (machine.ts kept going instead of BLOCKED) gets the never-stop brief; a red verify after the first round gets the one consult (trigger stop or red-verify)
    const priorConflict = typeof prior.fix?.spec_conflict_reason === "string" && prior.fix?.exit === "spec_conflict" && neverStopActive() ? prior.fix.spec_conflict_reason : null;
    const advice = round >= 2 && !closure && !signal.aborted ? await runConsult({ runDir: ctx.runDir, repoDir: ctx.repoDir, stage: `fix${round}`, trigger: priorConflict ? "stop" : "red-verify", task, evidence: [...(priorConflict ? [`The previous fix round stopped with LOKI_SPEC_CONFLICT: ${priorConflict}`] : []), ...groups.slice(0, 8).map((g) => `(${g.count}x) ${g.signature}\n${g.sample}`)].join("\n\n"), diff: diffStat, code: (() => { try { const b = briefCtx(ctx, "haiku"); return b.packText ?? b.text; } catch { return ""; } })() }) : null;
    const hintsPlus = [hints, ...(priorConflict ? [neverStopBrief(priorConflict, advice)] : adviceBlock(advice))].filter((x): x is string => !!x).join("\n\n") || null; // the consult advice rides the site-hints slot in both the fresh and the resumed brief
    const fullBrief = closure ? buildClosureBrief(task, closure.items, diffStat) : buildFixBrief(task, groups, diffStat, replan ? { priorDiagnosis: prevDiag, stepBack: carried } : repeated ? { priorDiagnosis: prevDiag } : undefined, holdoutFailed, hintsPlus);
    let r = await runFixSession(ctx, sessionBase, closure ? `${ctx.runId}-closure${closure.round}` : `${ctx.runId}-fix${round}`, (prior.fix?.iteration_ids as string[] | undefined) ?? [], chain, actualModel, fullBrief, buildFixResumeBrief(groups, diffStat, prevDiag, holdoutFailed, [...((prior.implement?.tests_reverted as string[] | undefined) ?? []), ...((prior.fix?.tests_reverted as string[] | undefined) ?? [])].map((f) => relative(ctx.repoDir, resolve(ctx.repoDir, f))), hintsPlus)); // one session per round: a spec conflict starts no retry; the unchanged-tree rule below decides whether it is believed
    const ro = (prior.wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? [], wd = r.session.markers.specConflict && !r.session.killed ? await adjudicateWallConflict(ctx, { ...sessionBase, iterationId: r.ids[r.ids.length - 1]!, brief: fullBrief }, r.session, ro) : null; if (wd) r = { ...r, session: wd.session, ids: [...r.ids, ...wd.ids] }; // FC-WALL-DEFECT-REPORTED-AS-SPEC-CONFLICT
    const testsReverted = restoreReadOnly(ro); // only the Wall is read-only after a fix pass
    const treeAfter = treeFingerprint(ctx.repoDir, ctx.baseSha), conflict =r.session.markers.specConflict && !r.session.killed && treeBefore !== null && treeBefore === treeAfter ? r.session.markers.specConflict : null; // evidence: a claim from a round that edited the tree is work in progress, not an escape from the failure
    ctx.emit("fix.round", "fix", {
      round,
      groups: groups.map((g) => ({ signature: g.signature, count: g.count, sample: g.sample })),
      model: actualModel,
      escalated: (repeated && (!devPin || !!escPin)) || climbed !== null, // ROLE-MODELS: a dev pin with no escalate= stays on the pin, so a repeated round is not an escalation fix_resume: r.mode, cache_read_tokens: r.cacheRead,
      ...(downgrade && pinnedModel === downgrade.to ? { model_downgrade: downgrade.note } : {}),
      ...(repeated && (!devPin || escPin) ? { escalation_reason: reason, escalation_model: actualModel } : {}),
    });

    const capStop = capStopOf(r.session.summary), capNote = capStop ? `fix round ${round} stopped by the harness (${capStop}): the failures it was fed are NOT PROVEN fixed` : null; // E5: a runaway or no-edit fix session is a harness stop, never a believed fix
    return {
      status: "completed",
      // Every round's session id, since each round replaces this stage's output.
      data: { round, signatures, diagnosis: r.session.summary ?? null, groups_fed: groups.length, diff_stat: diffStat, tree_before: treeBefore, tree_after: treeAfter, ...(conflict ? { exit: "spec_conflict", spec_conflict_reason: conflict } : {}), killed: r.session.killed, tests_reverted: testsReverted, cascade: repeated, model: actualModel,
        ...(stallEsc ? { stall_escalated: true } : {}), ...(climbed ? { route_escalation: climbed } : {}), ...(capStop ? { session_cap: capStop } : {}), session_caps: [...((prior.fix?.session_caps as string[] | undefined) ?? []), ...(capStop ? [`fix round ${round}: ${capStop}`] : [])], not_proven: [...((prior.fix?.not_proven as string[] | undefined) ?? []), ...(capNote ? [capNote] : [])], iteration_ids: r.ids, session_id: r.sessionId, fix_resume: r.mode, ...(r.why ? { fix_resume_why: r.why } : {}),
        ...(replanOn() ? { diagnoses: [...carried, String(r.session.summary ?? "").slice(0, 600)].filter(Boolean).slice(-6) } : {}), // VERIFY-PLAN V6: the earlier rounds' own summaries, for a replan brief
        ...(replan ? { replan: true } : {}),
        ...(closure ? { closure: closure.round } : {}),
        fix_rounds: [...((prior.fix?.fix_rounds as unknown[] | undefined) ?? []), { round, fix_resume: r.mode, cache_read_tokens: r.cacheRead, ...(replan ? { replan: true } : {}) }] },
    };
  },
};
export const stage = fixStage;
