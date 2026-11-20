// E-08: Implement (ENGINE.md 4, 16). One session; the brief marks Wall tests read-only, names only the impacted tests. Afterwards any changed Wall file is restored (tests_reverted) and the exit is classified.
import { execSpecBriefOf } from "../../features/exec_spec.ts"; import { recoverTournamentUndo, runTournamentGate, tournamentEnabled } from "../../features/tournament.ts"; import { nrdOverlapOn, runNrdGate, startNrdGate } from "../../features/no_regression.ts";
import { installOwned } from "../../project_model/install.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { withStagePrefix } from "../../features/lean_prefix.ts"; import { fragmentWriterOn, outOfRepoReask, outOfRepoTests } from "../../project_model/conventions.ts";
import { learningsBlock, lessonsForBrief, orgKnowledgeBlock } from "../../util/pr_lessons.ts"; export { learningsBlock }; // learningsBlock lives with the other brief-note helpers
import { FINISH_LINE, fixedRules, briefRecord, ISSUE_FINISH_LINE, TEXT_FINISH_LINE, issueRunBrief, pinnedTestUpdateEnabled, PLAN_HINT_LEAD, planHintsOn, proveByRunningBlock, type BriefRecord } from "../../e10ext/context.ts"; import { pinnedTestUpdates } from "../../util/test_guard.ts";
import { fastTierModel } from "../../runner/model_downgrades.ts"; import { noteRoleSkip, resolveClaudeModel, roleModel } from "../../util/claude_model.ts";
import { cascadeDowngrade, loadRepoMap, namedFiles, sizeTask } from "../sizing.ts";
import { attemptModels, attemptsK, type ExtraAttemptsDeps } from "../../features/attempts.ts";
import { selectRelevantFiles } from "./plan.ts"; import { changedFiles, checkExcerpt, commandFor, runCheck, type VerifyCheck } from "./verify.ts"; import { loadProjectApi } from "../../project_model/resolve.ts"; import { suiteCmdsOpt } from "../../project_model/package_suite.ts"; import { planStopChecks } from "../../runner/stop_checks.ts";
import { treeFingerprint } from "../../util/anti_loop.ts"; import { TASK_MEMORY_DIR_ENV, taskMemoryOn } from "../../runner/providers.ts"; import { CARD_BASE_ENV, CARD_RUN_DIR_ENV, compactCardOn, TASK_CARD_ENV, taskCardText } from "../../runner/compact_card.ts"; import { baseFacts, keepProofScript, labelAsks, taskMemoryText, writeTaskMemory, optionalAsk, ruleStatus, writeProofKit, PROOF_SCRIPT, PROVES_NOTHING_FIX, proofBaseCapOn, proofFacts, proofLoopMax, proofOnBase, proofRerunOn, provesNothing, provesNothingReason, rerunProof, unmetBrief, unusedNewFiles, worktreeTree, runSetupScript } from "../proof_rerun.ts"; import { crossReview, isUnmetNote, issueLineCheck, reviewFixOn } from "./xreview.ts"; import { PROOF_SCRIPT_LINE } from "../../e10ext/context.ts"; import { writeExitCleanup, cleanupSessionScratch, createSessionScratch, scratchSessionEnv, type SessionScratch } from "../../runner/worker_proc.ts"; import { envCard } from "../../util/stack_tools.ts"; import { repoCardBrief, settleSetupCheck } from "../../e10ext/repomemory.ts"; import { capStopOf, classifyExitCause, resolveModel } from "../session.ts"; import { MAX_TURNS_EXIT } from "../../runner/worker_proc.ts"; // E-68 reuse: never re-classify exit codes here
import { NAMED_SITE_LINE, namedSites, namedSitesEnabled, type ContinueRecord, asUnfinishedConflict, compactionsOf, conflictNeedsTestOn, lacksFinishLine, resumeToFinish, type NamedSitesRecord, type RemedyRecord, resumeForNamedSites, resumeForPrecedence, resumeForRemedy, adjudicateWallConflict, coverageFoldLines, coverageMode, coverageResumeEnabled, reaskFoldedClaims, resumeAfterAlreadyDone, resumeForProofScript, resumeForSelfReview, resumeNeverStop, resumeAfterConflict, resumeAfterEmptyDone, resumeForCoverage, runVerifiedFinish } from "../../util/conflict_resume.ts";
import { INTERRUPTED_BRIEF, interruptedSession, planChain, readSessionId } from "../../runner/session_resume.ts"; import { issueAcceptanceCapOn, issueAcceptanceOf } from "../../util/intent_card.ts";
import { routeEscalate, routeStart } from "../../runner/router/implement_route.ts";
import { routerActive } from "../../runner/router/unit_model.ts";
import { defaultBudgetsOn, noProgressRounds, type ImplementExit, type RunContext, type SessionResult, type SessionRunOptions, type Stage, type StageResult, type TestMap, type TestRef, taskBlock } from "../types.ts";
import { safeGit } from "../../util/safe_git.ts"; import { runPickedChoice, sha256 } from "./seal.ts";
import { adviceBlock, assumptionOf, consultEnabled, neverStopActive, runConsult, type NeverStopRecord } from "../../features/opus_consult.ts"; import { currentDiff } from "../../runner/session_resume.ts";
import { assumptionsBlock, rankedRemedyBlock, rankedRemedyEnabled } from "../../features/spec_ambiguity.ts";
import { loadSpecFile, specBriefBlock, type LoadedSpec } from "../../util/spec_file.ts";
import { appliedTests, buildPatchBrief, patchCallFor, patchEnabled, runPatchProtocol, testConventions, type PatchCall, type PatchCheck, type PatchOutcome } from "../../features/patch_protocol.ts";
import { isTestFile } from "../../util/test_file_text.ts";
import { type FinishRecord, guardReviewTurn, type ReviewItem, reviewTurnGuardOn, selfReviewBrief, verifiedFinishBrief, verifiedFinishMaxTurns, verifiedFinishOn, selfReviewChecks, selfReviewMaxTurns, selfReviewMode, selfReviewWanted, settleItems, stripInventedReleaseRefs, treeStaged, type TurnGuardRecord } from "../../features/self_review.ts";
import { type DiffEntry, snapshotDiff } from "../../e10ext/treeswap.ts";

/** A test file (a sealed Wall test) the implement session must not change: path is absolute, in the repo working tree; content is what to restore if it no longer matches. */
export interface ReadOnlyFile { path: string; content: string; }

/** Impacted tests: the intake test map narrowed to plan's relevant files, falling back to the task's named  files when Plan was skipped or found none (E-64's lean path; E-98c), plus the sealed Wall tests. */
export function impactedTests(ctx: RunContext): string[] {
  const o = ctx.outputs();
  const map = o.intake?.testmap as TestMap | undefined;
  const task = (o.intake?.task as string | undefined) ?? "";
  const relevantFiles = o.plan?.relevant_files as string[] | undefined;
  const relevant = relevantFiles?.length ? relevantFiles : namedFiles(task, loadRepoMap(o.intake?.repomap_ref as string | undefined));
  const fromMap = map ? ctx.tests.impacted(map, relevant).map((t) => t.path) : [];
  const wall = ((o.wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? []).map((f) => relative(ctx.repoDir, f.path));
  return [...new Set([...fromMap, ...wall])];
}

export const briefCtx = (ctx: RunContext, model?: string): BriefRecord => briefRecord(ctx, { select: selectRelevantFiles, cmd: (t, repoDir) => { const c = commandFor(t, repoDir, loadProjectApi(repoDir)); return [c.cmd, c.args, c.interpreter, c.pkgRoot]; } }, model); // L021: a haiku or sonnet model adds the context pack
// Plan skipped: fixed lines (this one, then the folded coverage line), no per-task text, placed right after FIXED_RULES so every skipped-plan brief shares the same cache-stable prefix.
export const FOLD_PLAN_INSTRUCTION = "Before editing, write the files you will change and the test you will run, in at most 10 lines, then proceed.";
const REPRO_LINE = "If the task reports a bug, first add a new test function that reproduces it, run it and see it fail, then fix the code and run that test again.";
export function buildImplementBrief(task: string, plan: string | null, impactedTests: string[], repoMap = "", spec: string | null = null, assumptions: unknown = undefined, remedy: unknown = undefined, issue: boolean | "text" = false): string {
  return withStagePrefix([ // FIXED_RULES leads and FINISH_LINE closes, both byte-identical per task
    fixedRules(process.env, issue), // Z2: the pinned-test rule, or the v11.139.0 text with LOKI_E10_PINNED_TEST_UPDATE=0; issue: the issue-run rules constant (e10ext/context.ts issueRules)
    ...(plan ? [] : [FOLD_PLAN_INSTRUCTION, ...coverageFoldLines()]), // LOKI_E10_COVERAGE_RESUME fold (default): fixed bytes before any per-task text; turn and off add nothing (main's brief)
    ...taskBlock(task),
    ...assumptionsBlock(assumptions),
    ...rankedRemedyBlock(remedy), // F1 LOKI_E10_RANKED_REMEDY: per-task, after the task block; nothing when intake found no ranked remedy
    ...(spec ? [spec] : []), // SPEC-FIRST-INTENT: the user-edited spec is the authoritative intent; absent adds nothing
    plan ? (planHintsOn() ? `${PLAN_HINT_LEAD}\n${plan}` : `Follow this plan:\n${plan}`) : "No separate plan was made: plan the change yourself in this session, then implement it." + (process.env.LOKI_E10_REPRO === "1" ? " " + REPRO_LINE : ""), // TEN-QUALITY-08: default off, lean path only
    ...(repoMap ? [repoMap] : []),
    impactedTests.length ? `Impacted tests (a starting hint, not a limit): ${impactedTests.join(", ")}.` : "Impacted tests: none known; run the targeted tests for the code you change (the harness runs the full suite after you stop when the diff's risk tier is medium or high).",
    issue === "text" ? TEXT_FINISH_LINE : issue ? ISSUE_FINISH_LINE : FINISH_LINE, // "text": a text task on the work road is sent the road's lines with "task" for "issue" (types.ts taskWording)
  ].join("\n\n"));
}

/** Restores any read-only file the session changed or deleted; returns the paths restored, in order given. */
export function restoreReadOnly(files: ReadOnlyFile[]): string[] {
  const reverted: string[] = [];
  for (const f of files) {
    const current = existsSync(f.path) ? readFileSync(f.path, "utf8") : null;
    if (current !== f.content) {
      writeFileSync(f.path, f.content, "utf8");
      reverted.push(f.path);
    }
  }
  return reverted;
}

/** FC-43: the exact set verify.ts judges "empty diff" on; an unreadable tree is "not empty" so the resume never fires on a guess. */
function treeIsEmpty(ctx: RunContext): boolean {
  try { return changedFiles(ctx.repoDir, ctx.baseSha, installOwned(ctx.repoDir, ctx.outputs().intake?.install_created)).length === 0; } catch { return false; }
}

/** The supervisor snapshots the spec it hashed into the run dir; read that copy, never the live file the user may still be editing. */
function specFor(ctx: RunContext): LoadedSpec | null {
  if (!process.env.LOKI_E10_SPEC_SHA256) return null;
  try { return loadSpecFile(join(ctx.runDir, "spec.snapshot.md")); } catch { return null; }
}

/** CW-12: the changes were made by an external client and arrive as a patch. Apply it to the tree the Wall already sealed against; no session runs and the exit is "external". */
export function applyExternalPatch(ctx: RunContext, patchPath: string): StageResult {
  try { safeGit(ctx.repoDir, ["apply", "--binary", "--whitespace=nowarn", patchPath]); } catch (e) { return { status: "failed", data: { exit: "error", external: true }, reason: `external patch does not apply: ${(e as Error).message.split("\n")[0]}` }; }
  const testsReverted = restoreReadOnly((ctx.outputs().wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? []);
  return { status: "completed", data: { exit: "external", external: true, patch_sha256: sha256(readFileSync(patchPath, "utf8")), tests_reverted: testsReverted, impacted_tests: impactedTests(ctx), iteration_ids: [] } };
}

/** EXP-0010: the exact brief the first implement session got (saved by the stage); null when it was not saved. */
export const ATTEMPT_BRIEF_FILE = "implement-brief.txt";
export function savedImplementBrief(ctx: RunContext): string | null { try { return readFileSync(join(ctx.runDir, ATTEMPT_BRIEF_FILE), "utf8") || null; } catch { return null; } }
/** EXP-0010: what the extra attempts need beyond the brief, shared with the machine: the impacted-test set, the Wall's bytes, and verify's own runner for one test. */
export function attemptDeps(ctx: RunContext, k: number, brief: string, limitS: number, model?: string): ExtraAttemptsDeps {
  const readOnly = (ctx.outputs().wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? [];
  return {
    k, brief, limitS, impacted: impactedTests(ctx), ...(model ? { model } : {}),
    wallPaths: readOnly.map((f) => relative(ctx.repoDir, f.path)), wallContent: Object.fromEntries(readOnly.map((f) => [relative(ctx.repoDir, f.path), f.content])),
    check: (c, t, sg, out) => { const tc = commandFor(t, c.repoDir, loadProjectApi(c.repoDir)); return runCheck(c, `${t.runner}:${t.path}`, tc.cmd, tc.args, sg, out as VerifyCheck[], { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}) }); },
  };
}

/** LOKI_E10_PATCH: the patch protocol's harness-run check. The impacted tests of the applied files plus every applied test file (its runner from a mapped file with the same extension), at most PATCH_MAX_CHECKS, run by verify's own runner with no events emitted. */
const PATCH_MAX_CHECKS = 6;
export function patchCheckRefs(ctx: RunContext, applied: string[], impacted: string[]): TestRef[] {
  const map = ctx.outputs().intake?.testmap as TestMap | undefined;
  const ext = (p: string): string => p.slice(p.lastIndexOf("."));
  const fromMap = map ? [...ctx.tests.impacted(map, applied.filter((f) => !isTestFile(f))), ...map.tests.filter((t) => impacted.includes(t.path) || applied.includes(t.path))] : [];
  const extra = appliedTests(applied).filter((f) => !fromMap.some((t) => t.path === f)).flatMap((f): TestRef[] => { const r = map?.tests.find((t) => ext(t.path) === ext(f))?.runner ?? (map?.runners.length === 1 ? map.runners[0] : undefined); return r ? [{ runner: r, path: f }] : []; });
  const seen = new Set<string>();
  return [...extra, ...fromMap].filter((t) => !seen.has(t.path) && !!seen.add(t.path)).slice(0, PATCH_MAX_CHECKS);
}
export function patchCheck(ctx: RunContext, impacted: string[], wall: string[], signal: AbortSignal): (applied: string[]) => Promise<PatchCheck> {
  return async (applied) => {
    const refs = patchCheckRefs(ctx, applied, impacted), quiet = Object.assign(Object.create(ctx) as RunContext, { emit: () => undefined }), out: VerifyCheck[] = [];
    const map = ctx.outputs().intake?.testmap as TestMap | undefined;
    if (!refs.some((t) => impacted.includes(t.path) || (map?.tests ?? []).some((m) => m.path === t.path))) return { ok: false, ran: 0, names: refs.map((t) => `patch:${t.runner}:${t.path}=own test only`), digest: "no test that existed before the change covers it; the model's own new test alone is no proof" }; // never green on the model's own test alone: fall back
    for (const t of refs) { const tc = commandFor(t, ctx.repoDir, loadProjectApi(ctx.repoDir)); await runCheck(quiet, `patch:${t.runner}:${t.path}`, tc.cmd, tc.args, signal, out, { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}), wall: new Set(wall) }); }
    const ran = out.filter((c) => c.result === "pass" || c.result === "fail" || c.result === "flaky");
    return { ok: ran.length > 0 && ran.length === out.length && out.every((c) => c.result === "pass"), ran: ran.length, names: out.map((c) => `${c.name}=${c.result}`), digest: out.filter((c) => c.result !== "pass").map((c) => `${c.name}: ${c.result}${c.reason ? ` (${c.reason})` : ""}\n${checkExcerpt(c) || c.first_error || ""}`).join("\n").slice(0, 1500) };
  };
}
/** TG: reruns the tests of the review turn's edits (patchCheckRefs: the impacted tests of its paths plus its test files, capped) and takes the turn back when one
 * that passes without it fails with it. Runs quietly through verify's own runner. */
export async function reviewTurnGuard(ctx: RunContext, pre: DiffEntry[], wall: string[], signal: AbortSignal): Promise<TurnGuardRecord | null> {
  const quiet = Object.assign(Object.create(ctx) as RunContext, { emit: () => undefined });
  return guardReviewTurn(ctx.repoDir, ctx.baseSha!, pre, (paths) => patchCheckRefs(ctx, paths, impactedTests(ctx)), async (t) => {
    const tc = commandFor(t, ctx.repoDir, loadProjectApi(ctx.repoDir)), out: VerifyCheck[] = [];
    await runCheck(quiet, `turn:${t.runner}:${t.path}`, tc.cmd, tc.args, signal, out, { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}), wall: new Set(wall) });
    const res = out[out.length - 1]?.result; return res === "fail" ? "fail" : res === "pass" || res === "flaky" ? "pass" : "not_run";
  });
}
/** The patch brief: the context pack's code (the haiku pack), the impacted tests' heads and the exact check commands. */
export function patchBrief(ctx: RunContext, task: string, impacted: string[]): string {
  const bc = briefCtx(ctx, "haiku"), code = bc.packText ?? "";
  const refs = patchCheckRefs(ctx, bc.files.filter((f) => !isTestFile(f)), impacted); // the tests of the code the dossier shows, not only the task's named files
  const tests = [...new Set([...impacted.filter((p) => isTestFile(p)), ...refs.map((t) => t.path)])], cmds = refs.map((t) => { const c = commandFor(t, ctx.repoDir, loadProjectApi(ctx.repoDir)); return `${c.pkgRoot !== "." ? `cd ${c.pkgRoot} && ` : ""}${[c.cmd.startsWith(`${ctx.repoDir}/`) ? relative(ctx.repoDir, c.cmd) : c.cmd, ...c.args].join(" ")}`; });
  return buildPatchBrief(task, code || bc.text, testConventions(ctx.repoDir, tests), cmds);
}
/** Test seam: the e2e drives the protocol with a recorded reply instead of a model. */
let patchCallOverride: PatchCall | null = null;
export function __setPatchCallForTests(c: PatchCall | null): void { patchCallOverride = c; }

export const implementStage: Stage = {
  name: "implement",
  targetS: 180,
  limitS: 480,

  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> {
    rmSync(join(ctx.repoDir, ".loki", "supply-declared.json"), { force: true }); // T10 B3: never judge this run by a stale declaration
    try { recoverTournamentUndo(ctx.repoDir, ctx.runDir); } catch { /* an unreadable record is left for a person */ } // a displacement a kill cut short is undone before any session can write newer edits
    if (ctx.externalPatch) return applyExternalPatch(ctx, ctx.externalPatch);
    const prior = ctx.outputs();
    const task = (prior.intake?.task as string | undefined) ?? "";
    const plan = (prior.plan?.plan as string | undefined) ?? null;
    const impacted = impactedTests(ctx);
    const readOnly = (prior.wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? [];
    const devPin = roleModel("dev"), planPin = roleModel("plan"); // ROLE-MODELS: a dev pin is exact (no router ladder, no cascade downgrade); unset, nothing changes
    const routed = routerActive() && !devPin;
    const downgrade = routed || devPin ? null : cascadeDowngrade(ctx.model); // the router (LOKI_ROUTER=auto for Haiku first) replaces the opt-in downgrade list
    const cascade = downgrade !== null;
    if (downgrade) process.stderr.write(`${downgrade.note}\n`);
    const lessons = lessonsForBrief(ctx.repoDir, ctx.runId, task, [...((prior.plan?.relevant_files as string[] | undefined) ?? []), ...impacted], ctx.runDir); // T6: reviewer lessons plus run lessons on the relevant files or their impacted tests (util/pr_lessons.ts), tagged as used by this run and recorded in lessons-injected.json
    const bc = briefCtx(ctx, routed ? undefined : devPin ?? downgrade?.to ?? ctx.model), repoMap = bc.text + lessons + learningsBlock(ctx.repoDir) + orgKnowledgeBlock(ctx.repoDir, task, ctx.runDir); // S41-10: up to 20 relevant files + impacted test commands, not the first 200 paths; FR06 org block is off unless LOKI_ORG_GRAPH=1

    const spec = specFor(ctx);
    // CH-03: resume plan's session on the same model (never when routed: per-unit models differ). Wall, verify and seal never join the chain. planChain owns eligibility; `!plan` here only keeps plan_chain out of the data when plan was skipped.
    const chain = routed || !plan ? null : devPin || planPin ? planChain(ctx, resolveClaudeModel(devPin ?? ctx.model), resolveClaudeModel(planPin ?? fastTierModel(process.env))) : planChain(ctx, downgrade?.to ?? ctx.model, fastTierModel(process.env)); // ROLE-MODELS: the plan session ran on the plan role, so the chain compares resolved ids
    const own = routed ? null : interruptedSession(ctx, `${ctx.runId}-impl`); // a rerun continues its own killed session before any plan link
    const ownId = own && "id" in own ? own.id : undefined;
    const resumeId = ownId ?? (chain && "id" in chain ? chain.id : undefined);
    let planChainMode: string | undefined = ownId ? "resumed (interrupted session)" : chain ? (resumeId ? "resumed" : `fresh (${(chain as { why: string }).why})`) : undefined;
    let sessionResume: string | undefined = own ? (ownId ? "resumed" : `fresh (${(own as { why: string }).why})`) : undefined;
    const picked = (Array.isArray(prior.intake?.assumptions) ? (prior.intake!.assumptions as unknown[]) : []).filter((a): a is string => typeof a === "string" && runPickedChoice(a)); // LOKI_E10_OPUS_CONSULT trigger open-choice: an either/or the run would settle by itself
    const choiceAdvice = picked.length && consultEnabled() && !ownId && !signal.aborted ? await runConsult({ runDir: ctx.runDir, repoDir: ctx.repoDir, stage: "implement", trigger: "open-choice", task, evidence: picked.join("\n"), diff: null, code: bc.packText ?? bc.text }) : null;
    const issue = issueRunBrief(ctx.provider, prior.intake?.source); // candidate 1: issue-run rules, block, lines and card; a text goal and opencode keep today's brief
    let scratch: SessionScratch | null = null; try { scratch = issue ? createSessionScratch(ctx.runDir) : null; } catch { scratch = null; } // Q1 RUN-SCRATCH: the session's own short scratch directory; any error means none
    const kitAsks = scratch ? labelAsks(ctx.provider, prior.intake, prior.plan, ctx.repoDir).asks : [];
    if (scratch) writeProofKit(scratch.dir, kitAsks); // the check functions and the numbered acceptance lines the proof script must use
    const memText = scratch && ctx.provider === "claude" && taskMemoryOn() ? taskMemoryText({ title: task.split("\n").map((l) => l.trim()).find(Boolean) ?? "", asks: kitAsks, sites: namedSitesEnabled() ? namedSites(task, ctx.repoDir) : [], ...(namedSitesEnabled() ? { siteRule: NAMED_SITE_LINE } : {}) }) : null;
    const memDir = scratch && memText ? writeTaskMemory(scratch.dir, memText) : null;
    const cardEnv: Record<string, string> = scratch && ctx.provider === "claude" && compactCardOn() ? { [TASK_CARD_ENV]: taskCardText({ title: task.split("\n").map((l) => l.trim()).find(Boolean) ?? "", asks: kitAsks, sites: namedSitesEnabled() ? namedSites(task, ctx.repoDir) : [], briefPath: join(ctx.runDir, "implement-brief.txt"), finishRule: issue && prior.intake?.source !== "text" ? ISSUE_FINISH_LINE : FINISH_LINE }), [CARD_BASE_ENV]: ctx.baseSha, [CARD_RUN_DIR_ENV]: ctx.runDir } : {}; // COMPACT CARD (runner/compact_card.ts): re-sent with Loki's progress at every compaction, SDK route // TASK MEMORY: read again by Claude Code after each compaction; only a Haiku session loads it (runner/providers.ts taskMemorySettings)
    if (scratch) { const sc = scratch, rd = ctx.runDir; process.once("exit", () => { if (existsSync(sc.dir)) writeExitCleanup(rd, cleanupSessionScratch(sc)); }); } // safety net: an aborted stage still leaves nothing running or on disk
    const setupCheck = issue && !ownId && !signal.aborted ? await settleSetupCheck(ctx.repoDir, ctx.runDir, (s) => runSetupScript(ctx.repoDir, s, signal)) : null; // SETUP CHECK: Loki's own run of the stored setup on this checkout (started beside plan), and the one-file edit that gets it through when it stops
    if (setupCheck) ctx.emit("repo.card", "implement", { when: "checked", result: setupCheck.result, seconds: setupCheck.seconds, trials: setupCheck.trials, ...(setupCheck.file ? { file: setupCheck.file } : {}) });
    const known = issue ? repoCardBrief(ctx.repoDir, scratch?.dir ?? null, process.env, setupCheck) : null; // REPO CARD: what earlier runs here verified (e10ext/repomemory.ts), in the brief and as $LOKI_SCRATCH/loki-setup.sh; LOKI_REPO_CARD=0 opts out
    if (known) { try { writeFileSync(join(ctx.runDir, "repo-card.json"), JSON.stringify(known.record) + "\n"); } catch { /* the record is evidence only */ } ctx.emit("repo.card", "implement", { when: "read", ...known.record }); }
    const card = issue ? envCard(ctx) : null; // the small environment card (util/stack_tools.ts envCard): server binaries off PATH that the repository needs
    const fullBrief = buildImplementBrief(task, plan, impacted, known ? `${repoMap}${repoMap ? "\n\n" : ""}${known.text}` : repoMap, [specBriefBlock(spec), execSpecBriefOf(ctx.runDir), ...adviceBlock(choiceAdvice), proveByRunningBlock(ctx.provider, prior.intake?.source, process.env, card?.line ?? null)].filter(Boolean).join("\n\n") || null, prior.intake?.assumptions, rankedRemedyEnabled() ? prior.intake?.ranked_remedy : undefined, issue && prior.intake?.source === "text" ? "text" : issue); // the advice joins the per-task part of the brief, never the cache-stable prefix // LOKI_E10_EXEC_SPEC: the binding and advisory spec cases the lean Wall stage left
    try { mkdirSync(ctx.runDir, { recursive: true }); writeFileSync(join(ctx.runDir, ATTEMPT_BRIEF_FILE), fullBrief, "utf8"); } catch { /* best effort: without it the machine starts no extra attempt */ } // EXP-0010: the extra attempts after a red verify start from this exact brief
    const attemptsNamed = (process.env.LOKI_E10_ATTEMPT_MODELS ?? "").trim() !== "", firstAttemptModel = attemptsK(devPin ?? ctx.model) > 0 && (!devPin || attemptsNamed) ? attemptModels()[0] : undefined; // ROLE-MODELS: under a dev pin only an explicit LOKI_E10_ATTEMPT_MODELS list (the narrower setting) names attempt 1, never the cascade default // LOKI_E10_ATTEMPT_MODELS entry 1: the first of the best-of-N attempts (a downgrade still wins)
    const first: SessionRunOptions = {
      stage: "implement",
      brief: ownId ? INTERRUPTED_BRIEF : fullBrief,
      tier: "development",
      iterationId: `${ctx.runId}-impl`,
      ...(card?.pathAppend.length ? { pathAppend: card.pathAppend } : {}),
      ...(scratch ? { sessionEnv: { ...scratchSessionEnv(scratch), ...(memDir ? { [TASK_MEMORY_DIR_ENV]: memDir } : {}), ...cardEnv } } : {}), // RUN-SCRATCH: resumes inherit it (resumeWith spreads first) // appended to this session's PATH and every resume's (resumeWith spreads first)
      limitS: implementStage.limitS,
      signal,
      cwd: ctx.repoDir,
      ...(downgrade ? { model: downgrade.to } : firstAttemptModel ? { model: firstAttemptModel, ...(devPin ? { pinSource: "specific" as const } : {}) } : {}),
      ...suiteCmdsOpt(ctx.repoDir, prior.intake?.testmap), ...(resumeId ? { resumeSessionId: resumeId } : {}), ...planStopChecks(ctx.repoDir, prior, new Set(impacted), implementStage.limitS, ctx.baseSha), // in-session fix rounds, default on (LOKI_E10_STOP_CHECKS=0 off)
    };
    const unchained = (): SessionRunOptions => { const { resumeSessionId: _chained, ...rest } = first; return ownId ? { ...rest, brief: fullBrief } : rest; }; // read at call time: the router may rewrite first.model; retries and conflict reruns never inherit the chain link
    // ROUTER-1: per-unit ladder from the plan's route record (runner/router/unit_model.ts). Flag off: none of this runs.
    const size = sizeTask(task, loadRepoMap(prior.intake?.repomap_ref as string | undefined), (prior.intake?.testmap as TestMap | undefined) ?? null).size;
    const rt = routed ? routeStart(ctx, first, prior.plan, size) : null;
    // LOKI_E10_PATCH (default off): lean path only (no plan, no router, no session to continue). Green skips the agentic session; anything else restored the tree and the session below runs as today.
    let patch: PatchOutcome | undefined, patchS = 0, patchNote = ""; // patchNote: the patch reply's lines before its first edit block (its root cause), the green session's summary
    const patchModel = devPin ?? downgrade?.to ?? ctx.model ?? resolveModel(ctx.provider); // a named model only: "claude (provider default)" names none for a tool-less call
    const patchOn = patchEnabled() && !plan && !routed && !resumeId && ctx.provider === "claude" && /^[\w.:@/-]+$/.test(patchModel);
    if (patchEnabled() && ctx.provider !== "claude") noteRoleSkip("implement-patch", `LOKI_E10_PATCH: the patch protocol runs on the claude provider only (this run: ${ctx.provider})`); // recorded in the receipt's tool_calls_skipped
    if (patchOn && !signal.aborted) {
      const started = Date.now();
      try { patch = await runPatchProtocol({ rules: { repoDir: ctx.repoDir, readOnly: readOnly.map((f) => relative(ctx.repoDir, f.path)), task }, brief: patchBrief(ctx, task, impacted), iterationId: `${ctx.runId}-impl-p`, signal,
        call: patchCallOverride ?? patchCallFor(patchModel, join(ctx.repoDir, ".loki")), check: patchCheck(ctx, impacted, readOnly.map((f) => relative(ctx.repoDir, f.path)), signal),
        record: (n, prompt, reply) => { if (reply && n === 1) patchNote = reply.split(/^FILE:/m)[0]!.trim(); mkdirSync(ctx.runDir, { recursive: true }); writeFileSync(join(ctx.runDir, `implement-patch-${n}.txt`), `${prompt}\n\n=== REPLY ===\n${reply ?? "(call failed)"}\n`, "utf8"); } });
      } catch (e) { patch = { status: "error", calls: 0, applied: [], refused: [], restored: [], log: [`error before any edit: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200)}`], usd: null }; } // the brief or the call setup threw (the protocol restores its own writes): the agentic session runs
      patchS = (Date.now() - started) / 1000;
    }
    let session: SessionResult = patch?.status === "green" ? { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: patchS, killed: false, summary: patchNote || patch.log.join("\n") } : await ctx.sessions.run(first);
    const ids = patch?.status === "green" ? [`${ctx.runId}-impl-p`] : [first.iterationId];
    { const blockMs = Number(process.env["LOKI_E10_TEST_BLOCK_AFTER_SESSION_MS"] ?? 0); if (blockMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs); } // tests only (tests/min/engine10-e2e-stub.sh BACKSTOP-SEAL): a worker whose event loop is blocked, as dev4 gitoxide's was
    if (patch?.status !== "green" && resumeId && !session.killed && session.exit !== 0 && session.exit !== MAX_TURNS_EXIT) { // a failed resume reruns fresh with the same full brief
      planChainMode = "fallback (resume failed)";
      if (ownId) { sessionResume = "fallback (resume failed)"; process.stderr.write(`implement: recorded session ${ownId} was not resumable, starting a fresh session\n`); }
      const retry = `${first.iterationId}f`; ids.push(retry);
      session = await ctx.sessions.run({ ...unchained(), iterationId: retry });
    }
    if (rt && !signal.aborted) session = await routeEscalate(ctx, first, session, rt, ids, () => treeIsEmpty(ctx)); // triggers b/c (and, under the preset, a no-diff already-done claim): one redo on the next rung
    let pinConflict: string | undefined; // Z1 (LOKI_E10_PINNED_TEST_UPDATE): the cited test that pins the reported behavior, when the correction named it
    const h1 = issueRunBrief(ctx.provider, prior.intake?.source) && conflictNeedsTestOn(), h1n = (x: SessionResult): SessionResult => (h1 ? asUnfinishedConflict(x) : x); // H1: decided before the conflict correction, so a no-test conflict never gets the -r turn and is resumed once, by S1b
    session = h1n(session);
    if (session.markers.specConflict && !session.killed) { const r = await resumeAfterConflict(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); session = r.session; pinConflict = r.pinnedTest; if (r.iterationId !== ids[ids.length - 1]) ids.push(r.iterationId); } // FC-19: one correction, then the conflict is believed
    session = h1n(session); // H1: a -r reply that answers with a no-test conflict is unfinished, not a believed conflict
    if (session.markers.specConflict && !session.killed && !signal.aborted) { const w = await adjudicateWallConflict(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, readOnly); if (w) { session = w.session; ids.push(...w.ids); } } // FC-WALL-DEFECT-REPORTED-AS-SPEC-CONFLICT: a Wall-anchored conflict goes to the referee (record: outputs.wall.arbitrated)
    let neverStop: NeverStopRecord | undefined; // LOKI_E10_OPUS_CONSULT never-stop: a headless run does not end BLOCKED on a conflict it can settle; one consult, then one resume that implements the most likely intent
    if (session.markers.specConflict && !session.killed && !signal.aborted && neverStopActive()) {
      const reason = session.markers.specConflict;
      const advice = await runConsult({ runDir: ctx.runDir, repoDir: ctx.repoDir, stage: "implement", trigger: "stop", task, evidence: `The agent stopped with LOKI_SPEC_CONFLICT: ${reason}\n\nIts last message:\n${(session.summary ?? "").slice(-1500)}`, diff: currentDiff(ctx.repoDir, ctx.baseSha, 6000, true), code: bc.packText ?? bc.text });
      const r = await resumeNeverStop(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, reason, advice); session = r.session; if (r.iterationId !== ids[ids.length - 1]) ids.push(r.iterationId);
      if (!session.markers.specConflict) neverStop = { stage: "implement", conflict: reason, assumption: assumptionOf(session.summary), consulted: advice !== null };
    }
    // HONEST-ALREADY-DONE: an already-done claim gets one challenge before it is believed, including a claim made in reply to the empty-done correction; after a challenge no empty-done correction follows (one extra session at most).
    // A no-diff claim the router already redid on the next rung (routeEscalate, trigger already_done_claim) was challenged in that redo's brief; an empty-done correction after it carries the challenge too.
    let challenged = false; const routerRedid = rt?.escalations.some((e) => e.trigger === "already_done_claim") ?? false;
    const challenge = async (): Promise<void> => { if (signal.aborted || session.killed || !session.markers.alreadyDone || session.markers.specConflict || challenged || routerRedid || process.env.LOKI_E10_ALREADY_DONE_CHALLENGE === "0") return; challenged = true; const r = await resumeAfterAlreadyDone(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); session = r.session; ids.push(r.iterationId); };
    await challenge();
    if (!challenged && !signal.aborted && !session.killed && session.exit === 0 && !session.markers.specConflict && !session.markers.alreadyDone && treeIsEmpty(ctx)) { const r = await resumeAfterEmptyDone(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, routerRedid); session = r.session; ids.push(r.iterationId); await challenge(); } // FC-43: one correction for a done exit with no change

    let finish: Omit<ContinueRecord, "compactions"> | undefined; // S1b FINISH-LINE (claude only): a session whose final text has no finish line is resumed before every follow-up gate
    if (patch?.status !== "green" && !session.killed && session.exit === 0 && !signal.aborted && lacksFinishLine(ctx.provider, session)) {
      // G5: where Loki's own proof script exists, a continue's progress is its measured failing count, not the reply's words (resumeToFinish o.measure).
      const proofMeasure = async (): Promise<number | null> => { if (!scratch || !proofRerunOn() || !existsSync(join(scratch.dir, PROOF_SCRIPT)) || !keepProofScript(scratch.dir, ctx.runDir)) return null; const pr = await rerunProof(ctx.repoDir, ctx.runDir, signal); return pr ? (pr.exit === 0 ? pr.failed : Math.max(1, pr.failed)) : null; };
      const r = await resumeToFinish(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, { fingerprint: () => treeFingerprint(ctx.repoDir, ctx.baseSha), spentUsd: () => ctx.cost.read(ctx.repoDir, ctx.sessionIds?.() ?? ids).usd, compactions: (xs) => compactionsOf(ctx, xs), signal, normalize: h1n, measure: proofMeasure });
      session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); finish = r.record;
    }
    const incomplete = finish !== undefined && finish.ended !== "finish line";
    if (incomplete) session = { ...session, markers: { ...session.markers, done: false } }; // S1b: an unfinished session is never built on or replaced by a follow-up resume (coverage, remedy, precedence, named sites, -rv all require markers.done)
    let coverage: string | undefined; // L4: lean path only; an attempts run owns its own sessions
    let claimAbsent: string[] | undefined; // site-ledger claimed_change_absent: SITE lines naming a line the coverage turn did not change, re-asked once
    if (coverageResumeEnabled() && !plan) { if (patch?.status !== "green" && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { const r = await resumeForCoverage(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); claimAbsent = r.claimAbsent; coverage = "resumed"; } else coverage = patch?.status === "green" ? "skipped (patch green)" : "skipped"; }
    else if (coverageMode() === "fold" && !plan) { // the brief carried COVERAGE_FOLD (buildImplementBrief), so no separate turn; with LOKI_E10_CLAIM_CHECK on, the session's own SITE lines get the claim check
      coverage = patch?.status === "green" ? "skipped (patch green)" : "folded";
      if (patch?.status !== "green" && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { const r = await reaskFoldedClaims(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); claimAbsent = r.claimAbsent; }
    }

    let rankedRemedyRec: RemedyRecord | undefined; // F1 LOKI_E10_RANKED_REMEDY: one tool-less check of the diff against the issue's first-ranked remedy, at most one "-rr" resume
    const remedy = rankedRemedyEnabled() && typeof prior.intake?.ranked_remedy === "string" ? prior.intake.ranked_remedy as string : null;
    if (remedy && patch?.status !== "green" && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { const r = await resumeForRemedy(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, remedy, currentDiff(ctx.repoDir, ctx.baseSha, 12000, true) ?? ""); session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); rankedRemedyRec = r.record; }
    let precedenceRec: { sites: number; resumed: boolean } | undefined; // F3 LOKI_E10_PRECEDENCE_CHECK: one "-pr" follow-up when the diff widened a check whose function holds other checks
    if (patch?.status !== "green" && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { const r = await resumeForPrecedence(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); if (r.sites > 0) { session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); precedenceRec = { sites: r.sites, resumed: r.iterationIds.length > 0 }; } }
    let namedRec: NamedSitesRecord | null = null; // R2 LOKI_E10_NAMED_SITES: every named site changed or explained; one "-ns" resume for any that is neither, seal judges the final diff
    if (patch?.status !== "green" && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { const r = await resumeForNamedSites(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, task); session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); namedRec = r.record; }
    if (scratch && proofRerunOn() && !existsSync(join(scratch.dir, PROOF_SCRIPT)) && !signal.aborted && !session.killed && session.exit === 0 && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { // PROOF SCRIPT: the session ran the product by hand but left nothing Loki can re-run; one resume asks for the script, the session's own verdict and reply stay
      const r = await resumeForProofScript(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, `Loki found no proof script at $LOKI_SCRATCH/loki-proof.sh, so nothing you ran can count toward the label. Write it now from the commands you already ran in this session. ${PROOF_SCRIPT_LINE} Do not change the product code in this turn unless the script shows a real failure. When it passes, leave it in place and end with the same finish line as before.`);
      if (r.iterationId !== ids[ids.length - 1]) ids.push(r.iterationId);
      if (r.session.summary) session = { ...session, summary: `${session.summary ?? ""}\n\n[proof script turn]\n${r.session.summary}` };
    }
    const lineRounds: { met: number; unmet: number; usd: number | null }[] = [];
    const proofRounds: { exit: number | null; failed: number; seconds: number; base_seconds?: number }[] = []; // PROOF LOOP: Loki runs the proof itself and hands a failure back with its real output, so a session that is wrong is corrected by evidence, not asked to try harder
    let reviewedEarly = false, earlyReviewCost: string | null = null; let proofFails = 0, lineTurns = 0; const LINE_TURNS_MAX = 2;
    // NO-DEFAULT-BUDGET: with no time limit the proof and acceptance turn counts are not the bound. A round makes progress when Loki's own proof run fails fewer
    // checks, or fewer acceptance lines are unmet, than the best round so far; noProgressRounds() rounds in a row without either end the loop.
    const noBudget = !defaultBudgetsOn(); let proofBest = { failed: Infinity, unmet: Infinity }, proofStill = 0;
    const proofStep = (failed: number, unmet: number): void => { if (failed < proofBest.failed || unmet < proofBest.unmet) { proofBest = { failed: Math.min(failed, proofBest.failed), unmet: Math.min(unmet, proofBest.unmet) }; proofStill = 0; } else proofStill++; }; // the acceptance check has its own two turns: a session that used every proof turn to get the script passing (Haiku did) used to get no acceptance feedback at all
    // One independent review during the run, with its findings handed back; true when the session was resumed and the proof must run again.
    const reviewRound = async (tree: string): Promise<boolean> => {
      // REVIEW-THEN-FIX: every item is met by count and by the acceptance check. One independent review now, while the session can still act on it.
      if (reviewedEarly || !reviewFixOn()) return false;
      reviewedEarly = true;
      const xr = await crossReview(ctx, "VERIFIED", tree, signal, true); if (xr?.cost_iteration) earlyReviewCost = xr.cost_iteration;
      const found = xr && (xr.level === "block" || xr.level === "flag") ? xr.notes.filter((n) => /^cross-review (block|flag) /.test(n) || isUnmetNote(n)).slice(0, 8) : []; // flags too: a reviewer filed "the default search page fails with a 400 on first load" as a flag, and the session can fix or rebut a flag in one turn
      ctx.emit("review.early", "implement", { level: xr?.level ?? "not_run", findings: found.length });
      if (!found.length) return false;
      const r3 = await resumeForProofScript(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, [`An independent reviewer read your whole change and found ${found.length} problem${found.length === 1 ? "" : "s"}:`, "", ...found.map((n, i) => `${i + 1}. ${n.replace(/^cross-review \w+ \([^)]*\):\s*/, "")}`), "", "Check each one against the code. Where the reviewer is right, fix the product (and the documentation when the two disagree), add a check for it to $LOKI_SCRATCH/loki-proof.sh under the acceptance item it belongs to, and run the proof again until it passes. Where the reviewer is wrong, say why in one line and change nothing for it. Do not remove or loosen an existing check. End with the same finish line as before."].join("\n"));
      if (r3.iterationId !== ids[ids.length - 1]) ids.push(r3.iterationId); else return false;
      if (r3.session.summary) session = { ...session, summary: `${session.summary ?? ""}\n\n[after the independent review]\n${r3.session.summary}` };
      return true;
    };
    for (let round = 0; (noBudget ? proofStill < noProgressRounds() : proofFails < proofLoopMax()) && scratch && proofRerunOn() && existsSync(join(scratch.dir, PROOF_SCRIPT)) && !signal.aborted && !session.killed && session.exit === 0 && !session.markers.specConflict && !session.markers.alreadyDone; round++) {
      if (!keepProofScript(scratch.dir, ctx.runDir)) break;
      const pr = await rerunProof(ctx.repoDir, ctx.runDir, signal); if (!pr) break;
      const pb = pr.exit === 0 && pr.failed === 0 ? await proofOnBase(ctx.repoDir, ctx.runDir, ctx.baseSha, pr, signal) : null; // PROVES THE CHANGE: the same script against the base commit; a check that also passes there proves nothing about this change (proof_rerun.ts proofOnBase)
      if (pb) ctx.emit("proof.base", "implement", { round: round + 1, available: pb.available, ...(pb.why ? { why: pb.why } : {}), seconds: pb.seconds, ...(pb.cached ? { cached: true } : {}), base_checks: pb.base_checks, base_proved: pb.base_proved, passing: pb.head_proved, also_pass_on_base: pb.same_total });
      proofRounds.push({ exit: pr.exit, failed: pr.failed, seconds: pr.seconds, ...(pb && !pb.cached ? { base_seconds: pb.seconds } : {}) }); { const la0 = labelAsks(ctx.provider, prior.intake, prior.plan, ctx.repoDir); ctx.emit("proof.rerun", "implement", { round: round + 1, exit: pr.exit, proved: pr.proved, failed: pr.failed, seconds: pr.seconds, source: la0.source, statuses: ruleStatus(la0.asks, pr, proofBaseCapOn() ? pb : null).map((s, i) => ({ line: s.line, status: s.status, checks: pr.lines[String(i + 1)]?.proved ?? 0, ...(s.reason ? { reason: s.reason } : {}) })) }); } // the live console turns each line green from this
      if (pr.exit === 0 && pr.failed === 0) { // the proof passes when Loki runs it: now check it against every acceptance line, and hand unmet lines back with the reason
        const la = labelAsks(ctx.provider, prior.intake, prior.plan, ctx.repoDir); if (!la.asks.length) break; if (noBudget ? proofStill >= noProgressRounds() : lineTurns >= LINE_TURNS_MAX) { const t = await worktreeTree(ctx.repoDir); if (t && await reviewRound(t)) continue; break; } // the acceptance turns are used up: the review still gets its one round (a run that spent both turns never reached it)
        const tree = await worktreeTree(ctx.repoDir); if (!tree) break;
        const lc = await issueLineCheck(ctx, la.asks, tree, [], session.summary ?? "", [...(la.needs.length ? [`This repository needs: ${la.needs.join(", ")}.`] : []), "Loki's verify stage has not run yet at this point, so the check list is empty: a line about tests is met when the output of Loki's own run shows those tests passing.", ...proofFacts(ctx.runDir, pr, true), ...baseFacts(la.asks, pr, pb)]);
        const byRule = ruleStatus(la.asks, pr), empty = new Set(provesNothing(la.asks, pr, pb)), unmet = la.asks.flatMap((line, i) => { if (optionalAsk(line)) return []; if (byRule[i]!.status !== "met") return [{ line: `${i + 1}. ${line}`, reason: byRule[i]!.reason ?? "" }]; if (empty.has(i + 1)) return [{ line: `${i + 1}. ${line}`, reason: `${provesNothingReason(pb!, i + 1)}. ${PROVES_NOTHING_FIX}` }]; return lc.marks && !lc.marks.met.includes(i + 1) ? [{ line: `${i + 1}. ${line}`, reason: `it has a passing check, but a reviewer found a gap: ${lc.reasons?.[String(i + 1)] ?? "not stated"}` }] : []; }); // the count decides; the reviewer's gaps are handed back too, as advice the session should close
        const lineUnmet = unmet.length; // the acceptance count is about the lines only
        proofStep(pr.failed, lineUnmet);
        for (const f of await unusedNewFiles(ctx.repoDir, ctx.baseSha, tree)) unmet.push({ line: `(not an acceptance line) ${f}`, reason: "no other file in the repository imports or names this new file, so a user cannot reach what it does. Mount it where it belongs (a page, a route, a registry, a menu) and prove that path, or remove it" });
        lineRounds.push({ met: lc.marks?.met.length ?? 0, unmet: unmet.length, usd: lc.usd }); ctx.emit("acceptance.round", "implement", { round: round + 1, met: la.asks.length - lineUnmet, unmet: lineUnmet, ...(empty.size ? { pass_on_base_too: empty.size } : {}), ...(unmet.length > lineUnmet ? { unused_new_files: unmet.length - lineUnmet } : {}) });
        if (!unmet.length) { if (await reviewRound(tree)) continue; break; } // REVIEW-THEN-FIX, then the proof again on the fixed tree
        const stray = Object.keys(pr.lines).filter((k) => Number(k) > la.asks.length || Number(k) < 1); // checks filed under a number that is no acceptance item
        const r2 = await resumeForProofScript(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, unmetBrief(unmet, stray.length ? `Your proof script passes, but ${stray.length} of its check numbers (${stray.slice(0, 6).join(", ")}) are not acceptance item numbers, so those checks count for no item. The first argument of loki_http and loki_cmd is the item's number in $LOKI_SCRATCH/acceptance.txt (1 to ${la.asks.length}), never a line number of the script. Renumber them.` : ""));
        if (r2.iterationId !== ids[ids.length - 1]) ids.push(r2.iterationId); else break;
        lineTurns++;
        if (r2.session.summary) session = { ...session, summary: `${session.summary ?? ""}\n\n[after Loki's acceptance check, round ${round + 1}]\n${r2.session.summary}` };
        continue;
      }
      proofStep(Math.max(1, pr.failed), Infinity); if (noBudget && proofStill >= noProgressRounds()) break; // the proof keeps failing the same number of checks
      const r = await resumeForProofScript(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, `Loki ran your proof script ($LOKI_SCRATCH/loki-proof.sh) by itself, in a new empty directory, and it did not pass: exit ${pr.exit === null ? "none (it did not finish in time)" : pr.exit}, ${pr.proved} PROVED and ${pr.failed} FAILED line(s). This is the real end of its output:\n\n${pr.tail.slice(-4000)}\n\nFind out why it fails when it starts from nothing. A script that passed for you and fails for Loki usually depends on something your earlier commands left behind (a database, a file, a running server, an environment variable). Fix the product if the product is wrong, or the script if the script is wrong, run it yourself with a new empty directory as its argument until it exits 0, leave it in place, and end with the same finish line.`);
      if (r.iterationId !== ids[ids.length - 1]) ids.push(r.iterationId); else break; // no room left to resume
      proofFails++;
      if (r.session.summary) session = { ...session, summary: `${session.summary ?? ""}\n\n[after Loki's own run of the proof failed, round ${round + 1}]\n${r.session.summary}` };
    }
    const preReviewReply = session.summary ?? ""; // the implement session's own last reply, with its per-item proof list; the review turn below replaces session.summary with its checklist answers
    let selfReview: Record<string, unknown> | null = null; // SR LOKI_E10_SELF_REVIEW: deterministic pre-delivery checks, then at most one bounded "-rv" review resume
    { const mode = selfReviewMode(); if (mode !== "off" && ctx.baseSha && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) {
      const before = selfReviewChecks(ctx.repoDir, ctx.baseSha, treeStaged(ctx.repoDir, ctx.baseSha), task, ctx.outputs(), process.env, ctx.runDir);
      let after: ReviewItem[] | null = null, reply: string | null = null, turn: string | null = null;
      let guard: TurnGuardRecord | null = null, finish: FinishRecord | null = null;
      if (selfReviewWanted(before, mode)) { const fin = verifiedFinishOn() ? verifiedFinishBrief(ctx.repoDir, ctx.baseSha, before, task) : null, preTurn = fin || reviewTurnGuardOn() ? snapshotDiff(ctx.repoDir, ctx.baseSha) : null; const r = fin ? await runVerifiedFinish(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, fin.brief, verifiedFinishMaxTurns()) : await resumeForSelfReview(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, selfReviewBrief(ctx.repoDir, before), selfReviewMaxTurns()); if (fin) finish = { fired: true, iteration: r?.iterationId ?? null, ...fin.record }; /* VF: a fresh finish session on the cut context, always guarded */ if (r) { turn = r.iterationId; if (!ids.includes(r.iterationId)) ids.push(r.iterationId); if (r.session !== session) { reply = r.session.summary ?? ""; guard = preTurn && !signal.aborted ? await reviewTurnGuard(ctx, preTurn, readOnly.map((f) => relative(ctx.repoDir, f.path)), signal) : null; if (!guard?.reverted && !r.session.killed && r.session.exit === 0 && r.session.markers.done && !r.session.markers.specConflict && !r.session.markers.alreadyDone) session = r.session; else session = { ...session, durationS: r.session.durationS }; } after = selfReviewChecks(ctx.repoDir, ctx.baseSha, treeStaged(ctx.repoDir, ctx.baseSha), task, ctx.outputs(), process.env, ctx.runDir); } } // only a clean LOKI_DONE review reply replaces the implement result: a review turn never turns a done run into a conflict; TG: a reverted turn keeps the pre-turn result
      selfReview = { mode, turn, items: settleItems(before, after, guard?.reverted ? null : reply), ...(guard ? { turn_guard: guard } : {}), ...(finish ? { finish } : {}) };
    } }
    const refsRemoved = ctx.baseSha && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done ? stripInventedReleaseRefs(ctx.repoDir, ctx.baseSha, treeStaged(ctx.repoDir, ctx.baseSha), task) : []; // CR: a reference the task never gives never ships, whatever the model wrote
    const pinnedUpdates = pinnedTestUpdateEnabled() && ctx.baseSha ? pinnedTestUpdates(ctx.repoDir, ctx.baseSha, session.summary ?? "", task) : []; // Z2: the UPDATED TEST lines of the final reply, each checked against base, head and the task
    if (process.env.LOKI_E10_REPRO === "1" && !plan && !signal.aborted && !session.killed && session.exit === 0) { let bad: { name: string; why: string }[] = []; try { bad = outOfRepoTests(ctx.repoDir, changedFiles(ctx.repoDir, ctx.baseSha, installOwned(ctx.repoDir, ctx.outputs().intake?.install_created))); } catch { /* unreadable tree: no re-ask */ } if (bad.length) { const redo = `${first.iterationId}-oor`; ids.push(redo); session = await ctx.sessions.run({ ...unchained(), brief: withStagePrefix(outOfRepoReask("Rewrite these new test files in place, keeping the same names and what they reproduce.", bad)), iterationId: redo }); } } // TEN-QUALITY-44: the repro test gets the Wall's out-of-repo check and one re-ask
    const testsReverted = restoreReadOnly(readOnly);
    const tournament = tournamentEnabled() && !plan ? await runTournamentGate(ctx, signal, session, attemptDeps(ctx, 0, "", 0)) : undefined; // after the Wall files are restored, so candidates are checked against the original Wall and tests; LOKI_E10_TOURNAMENT (Go, lean path, on by default but inert without an exec-spec probe block; =0 opts out): features/tournament.ts
    const overlap = !plan && nrdOverlapOn(); if (overlap) startNrdGate(ctx, signal, session, readOnly.map((f) => relative(ctx.repoDir, f.path))); // SPEED-NRD-OVERLAP: verify (or seal) settles it
    const noRegression = !plan && !overlap ? await runNrdGate(ctx, signal, session, readOnly.map((f) => relative(ctx.repoDir, f.path))) : null; // LOKI_E10_NRD (Go, lean path, default on, =0 opts out): features/no_regression.ts, after the tournament and the Wall restore; the first verify hands its finding to one fix round
    const iterationId = ids[ids.length - 1]!;
    // E-68 classifies exit codes; a non-killed, marker-less non-zero exit is an error, never "done".
    if (scratch) keepProofScript(scratch.dir, ctx.runDir); // the session's proof script leaves the scratch before it is removed; seal re-runs it
    const scratchRec = scratch ? cleanupSessionScratch(scratch) : null; // RUN-SCRATCH: implement and its resumes have ended; stop what is left and remove the directory
    if (scratchRec && (scratchRec.stopped.length || scratchRec.left.length || !scratchRec.removed)) ctx.emit("scratch.cleanup", "implement", { when: "after the implement session", stopped: scratchRec.stopped, left: scratchRec.left, removed: scratchRec.removed, ...(scratchRec.kept ? { kept: scratchRec.kept } : {}) }); // Q1 SCRATCH-FINAL: the event on a normal run too; the receipt entry below
    let exit: ImplementExit | "error";
    if (session.killed || session.exit === MAX_TURNS_EXIT) { // a turn-cap stop is harness-owned and ends like a limit stop: PARTIAL, never BLOCKED
      exit = "killed";
    } else if (incomplete && session.exit === 0) { // S1b: the final text still has no finish line after the resumes: kept and sealed PARTIAL (seal unfinishedNotes), never VERIFIED
      exit = "incomplete";
    } else if (session.markers.specConflict) {
      exit = "spec_conflict";
    } else if (session.markers.alreadyDone && treeIsEmpty(ctx)) { // an already-done claim over edits is a change, never "already satisfied": the edits are verified and kept, not discarded by commit
      exit = "already_done";
    } else if (session.markers.alreadyDone) {
      exit = "done";
    } else if (session.exit !== 0) {
      exit = "error";
    } else {
      exit = "done";
    }

    const data: Record<string, unknown> = {
      exit,
      already_done_evidence: session.markers.alreadyDone,
      spec_conflict_reason: session.markers.specConflict,
      tests_reverted: testsReverted,
      impacted_tests: impacted, ...(known ? { repo_card: known.record } : {}), ...(plan && planHintsOn() ? { plan_hints: true } : {}), brief_files: bc.files, ...(bc.pack ? { context_pack: bc.pack } : {}), // L022: the exact files the brief named; L021: pack paths and line ranges
      cascade,
      ...(downgrade ? { model_downgrade: downgrade.note } : {}),
      iteration_ids: earlyReviewCost ? [...ids, earlyReviewCost] : ids, model: rt ? rt.current : downgrade?.to ?? firstAttemptModel ?? devPin ?? ctx.model, ...(rt ? { route_model: rt.current, route_escalations: rt.escalations } : {}), session_id: readSessionId(ctx.repoDir, iterationId), // MW-2
      duration_s: session.durationS, ...(session.exit === MAX_TURNS_EXIT && !session.killed ? { stop_cause: "max_turns", owner: "harness", limit_s: implementStage.limitS, elapsed_s: session.durationS, ...(capStopOf(session.summary) ? { session_cap: capStopOf(session.summary) } : {}) } : {}),
      ...(planChainMode ? { plan_chain: planChainMode } : {}),
      ...(sessionResume ? { session_resume: sessionResume } : {}),
      ...(finish ? { finish: { ...finish, compactions: compactionsOf(ctx, ids) } } : {}),
      ...(proofRounds.length ? { proof_rounds: proofRounds } : {}), ...(lineRounds.length ? { acceptance_rounds: lineRounds } : {}), ...(scratchRec && (scratchRec.stopped.length || scratchRec.left.length || !scratchRec.removed) ? { scratch_cleanup: scratchRec } : {}), // RUN-SCRATCH: recorded only when the harness had to stop something or could not remove the directory // S1b: only when it fired, so an unchanged run's receipt keys stay as they were; compactions are seen on the SDK route only (null on the CLI route)
      ...(coverage ? { coverage_resume: coverage } : {}), ...(rankedRemedyRec ? { ranked_remedy: rankedRemedyRec } : {}), ...(precedenceRec ? { precedence_check: precedenceRec } : {}), ...(namedRec ? { named_sites: namedRec } : {}), ...(memDir && memText ? { task_memory: { bytes: Buffer.byteLength(memText), sha256: sha256(memText) } } : {}), ...(pinConflict ? { pin_conflict: pinConflict } : {}), ...(pinnedUpdates.length ? { pinned_test_updates: pinnedUpdates } : {}), ...(claimAbsent ? { claim_absent: claimAbsent } : {}),
      ...(patch ? { patch: { status: patch.status, seconds: Math.round(patchS * 10) / 10, calls: patch.calls, applied: patch.applied, refused: patch.refused, restored: patch.restored, usd: patch.usd, log: patch.log, ...(patch.check ? { check: patch.check } : {}) } } : {}),
      ...(tournament ? { tournament } : {}),
      ...(noRegression ? { no_regression: noRegression } : {}),
      ...(neverStop ? { never_stop: [neverStop] } : {}),
      ...(issueAcceptanceCapOn() && (issueAcceptanceOf(prior.intake).length || issue) && session.summary ? { final_reply: (preReviewReply && preReviewReply !== session.summary ? `${preReviewReply.slice(-12000)}\n\n[then, after the review turn]\n${session.summary.slice(-4000)}` : session.summary.slice(-16000)) } : {}), // Q1 ISSUE-ACCEPTANCE: the final reply the seal's line check reads
      ...(selfReview ? { self_review: selfReview } : {}), ...(refsRemoved.length ? { changelog_refs_removed: refsRemoved } : {}),
      ...(fragmentWriterOn() && session.summary ? { summary_tail: session.summary.slice(-1500) } : {}), // the release-note writer reads the final message
    };

    if (exit !== "error") return { status: "completed", data };

    const stderrTail = session.stderrTail ?? ""; mkdirSync(ctx.runDir, { recursive: true }); const stderrPath = join(ctx.runDir, `${iterationId}.stderr.log`); writeFileSync(stderrPath, stderrTail, "utf8");
    data.stderr_path = stderrPath;

    return { status: "failed", reason: classifyExitCause(session.exit, false, undefined, stderrTail, ctx.provider), data };
  },
};
export const stage = implementStage;
