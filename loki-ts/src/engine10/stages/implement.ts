// E-08: Implement (ENGINE.md 4, 16). One session; the brief marks Wall tests read-only, names only the impacted tests. Afterwards any changed Wall file is restored (tests_reverted) and the exit is classified.
import { execSpecBriefOf } from "../../features/exec_spec.ts"; import { recoverTournamentUndo, runTournamentGate, tournamentEnabled } from "../../features/tournament.ts"; import { nrdOverlapOn, runNrdGate, startNrdGate } from "../../features/no_regression.ts";
import { installOwned } from "../../project_model/install.ts";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { withStagePrefix } from "../../features/lean_prefix.ts"; import { fragmentWriterOn, outOfRepoReask, outOfRepoTests } from "../../project_model/conventions.ts";
import { learningsBlock, lessonsForBrief, orgKnowledgeBlock } from "../../util/pr_lessons.ts"; export { learningsBlock }; // learningsBlock lives with the other brief-note helpers
import { FINISH_LINE, fixedRules, briefRecord, ISSUE_FINISH_LINE, TEXT_FINISH_LINE, issueRunBrief, pinnedTestUpdateEnabled, PLAN_HINT_LEAD, planHintsOn, proveByRunningBlock, thinImplementBrief, thinRoute, type BriefRecord } from "../../e10ext/context.ts"; import { pinnedTestUpdates } from "../../util/test_guard.ts";
import { fastTierModel } from "../../runner/model_downgrades.ts"; import { noteRoleSkip, resolveClaudeModel, roleModel } from "../../util/claude_model.ts";
import { cascadeDowngrade, loadRepoMap, namedFiles, sizeTask } from "../sizing.ts";
import { attemptModels, attemptsK, type ExtraAttemptsDeps } from "../../features/attempts.ts";
import { selectRelevantFiles } from "./plan.ts"; import { changedFiles, checkExcerpt, commandFor, runCheck, type VerifyCheck } from "./verify.ts"; import { loadProjectApi } from "../../project_model/resolve.ts"; import { suiteCmdsOpt } from "../../project_model/package_suite.ts"; import { planStopChecks } from "../../runner/stop_checks.ts";
import { treeFingerprint } from "../../util/anti_loop.ts"; import { TASK_MEMORY_DIR_ENV, taskMemoryOn } from "../../runner/providers.ts"; import { CARD_BASE_ENV, CARD_RUN_DIR_ENV, compactCardOn, TASK_CARD_ENV, taskCardText } from "../../runner/compact_card.ts"; import { baseFacts, keepProofScript, labelAsks, taskMemoryText, writeTaskMemory, optionalAsk, ruleStatus, writeProofKit, PROOF_SCRIPT, PROVES_NOTHING_FIX, proofBaseCapOn, proofFacts, proofLoopMax, proofOnBase, proofRerunOn, provesNothing, provesNothingReason, rerunProof, unmetBrief, unusedNewFiles, worktreeTree, runSetupScript } from "../proof_rerun.ts"; import { crossReview, handBackReasons, issueLineCheck, modelReviewRan, reviewFixOn, type CrossReview, type LineCheckRecord } from "./xreview.ts"; import { PROOF_SCRIPT_LINE } from "../../e10ext/context.ts"; import { writeExitCleanup, cleanupSessionScratch, createSessionScratch, scratchSessionEnv, type SessionScratch } from "../../runner/worker_proc.ts"; import { envCard } from "../../util/stack_tools.ts"; import { repoCardBrief, settleSetupCheck } from "../../e10ext/repomemory.ts"; import { capStopOf, classifyExitCause, resolveModel } from "../session.ts"; import { MAX_TURNS_EXIT } from "../../runner/worker_proc.ts"; // E-68 reuse: never re-classify exit codes here
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
import { restoreTurnPaths, turnChangedPaths } from "../../features/self_review.ts"; import { runProofAuthor, type ProofAuthorRun } from "./prove.ts"; import type { ProofBase, ProofCheck, ProofRerun } from "../proof_rerun.ts"; // THIN-WRAP (#712)

/** A reviewer's gap on a line that already has a passing check is handed back once per line: `handed` holds the numbers already handed back (and is added to here); a line seen again is a dispute, recorded and not handed back. */
export function gapOnce(handed: Set<number>, gaps: { n: number; line: string; reason: string }[], round: number): { handBack: { n: number; line: string; reason: string }[]; disputes: { line: string; reason: string; round: number }[] } {
  const handBack: { n: number; line: string; reason: string }[] = [], disputes: { line: string; reason: string; round: number }[] = [];
  for (const g of gaps) { if (handed.has(g.n)) disputes.push({ line: g.line, reason: g.reason, round }); else { handed.add(g.n); handBack.push(g); } }
  return { handBack, disputes };
}
/** The one resume text of a proof-loop round: the independent reviewer's whole findings first, then Loki's unmet acceptance lines. "" when both are empty. */
export function combinedHandBack(found: string[], unmetText: string): string {
  const review = found.length ? [`An independent reviewer read your whole change and found ${found.length} problem${found.length === 1 ? "" : "s"}:`, "", ...found.map((n, i) => `${i + 1}. ${n}`), "", "Check each one against the code. Where the reviewer is right, fix the product (and the documentation when the two disagree), add a check for it to $LOKI_SCRATCH/loki-proof.sh under the acceptance item it belongs to, and run the proof again until it passes. Close each finding where the code already is: when a finding says something has no caller, call it at the nearest existing call site or remove it. Add no mechanism the issue does not ask for. When the reviewer gave an input that shows a problem, add that exact input as a test in the repository's own tests, next to the tests for that code, and see it fail before your fix and pass after it. When the code you are fixing reads untrusted input (markup, an address, a query, a path, a file format), use the parser or escaping library this repository already depends on for it; do not replace a library call with matching you wrote yourself, and if the repository has no such dependency, say so in your reply. Where the reviewer is wrong, say why in one line and change nothing for it. Do not remove or loosen an existing check. End with the same finish line as before."].join("\n") : "";
  return [review, unmetText].filter(Boolean).join("\n\n");
}
/** THIN-WRAP (#712): on the thin route the author never writes or repairs the proof. The one fix turn's text is combinedHandBack's with the proof sentence taken
 *  out of the review paragraph and this line after it, so a hand-back of failing checks alone carries it too. "" when there is nothing to hand back. */
export const THIN_FIX_LINE = "Fix the product. Do not edit $LOKI_SCRATCH/loki-proof.sh and do not add checks to it; Loki runs its own copy. If a check is wrong against the issue, say so on a line starting CHECK WRONG <item number>: and leave it.";
const HANDBACK_PROOF_CLAUSE = ", add a check for it to $LOKI_SCRATCH/loki-proof.sh under the acceptance item it belongs to, and run the proof again until it passes";
export function thinHandBack(found: string[], failing: string): string { const t = combinedHandBack(found, failing).replace(HANDBACK_PROOF_CLAUSE, ""); return t ? `${t}\n\n${THIN_FIX_LINE}` : ""; }
/** The failing checks of Loki's own run of the independent proof script, as the author is told them: item, what the check proves, the end of its output. */
export function thinFailingText(checks: ProofCheck[]): string {
  const bad = checks.filter((c) => !c.ok); if (!bad.length) return "";
  return [`Loki ran the independent proof script by itself, in a new empty directory, and ${bad.length} check${bad.length === 1 ? "" : "s"} failed:`, "", ...bad.slice(0, 12).map((c) => `- item ${c.item}: ${c.what}${(c.printed ?? c.out) ? `\n  output: ${(c.printed ?? c.out ?? "").slice(-600).replace(/\n/g, "\n  ")}` : ""}`), "", "End with the same finish line as before."].join("\n");
}
/** THIN-WRAP T6 (#712): the checks that passed in `before` and fail in `after`, keyed by acceptance item and description (proof_rerun.ts checkKey has already
 *  taken run-specific values out of `what`). A check absent from `after`, one failing in both, and one new in `after` are not listed. Pure. */
export function regressedChecks(before: ProofCheck[] | undefined, after: ProofCheck[] | undefined): string[] {
  const key = (c: ProofCheck): string => `${c.item}: ${c.what}`, ok1 = new Map<string, number>(), ok2 = new Map<string, number>(), bad2 = new Set<string>();
  for (const c of before ?? []) if (c.ok) ok1.set(key(c), (ok1.get(key(c)) ?? 0) + 1);
  for (const c of after ?? []) { if (c.ok) ok2.set(key(c), (ok2.get(key(c)) ?? 0) + 1); else bad2.add(key(c)); }
  return [...ok1.keys()].filter((k) => bad2.has(k) && (ok2.get(k) ?? 0) < ok1.get(k)!);
}
/** The CHECK WRONG lines of an author reply (THIN_FIX_LINE asks for them), in order. */
export const checkWrongLines = (reply: string): string[] => reply.split("\n").map((l) => l.trim()).filter((l) => /^CHECK WRONG \d+:/.test(l)).slice(0, 20);

/** Which reader looks at the tree in a passing-proof round (loki-mode#692). "review": the first independent review. "follow": a follow-up review of what the last fix turn changed, while the
 *  last hand-back carried review findings (the caller folds that into changedSinceReview) and fewer than max follow-ups ran. "line-check": the acceptance line check, as before.
 *  max 0 (LOKI_E10_REVIEW_FOLLOW_MAX=0) never follows and the loop runs today's review plus line check in parallel, exactly as before this change. */
export function readerFor(s: { reviewOn: boolean; reviewed: boolean; changedSinceReview: boolean; followUps: number; max: number }): "review" | "follow" | "line-check" {
  if (s.reviewOn && !s.reviewed) return "review";
  if (s.reviewOn && s.reviewed && s.changedSinceReview && s.followUps < s.max) return "follow";
  return "line-check";
}
/** True when the round must also run the acceptance line check: always for the "line-check" reader, and for any reader whose review did not run (no reviewer, no room, a provider without one), so no tree is left unread. */
export const needsLineCheck = (reader: "review" | "follow" | "line-check", reviewRan: boolean): boolean => reader === "line-check" || !reviewRan;
/** LOKI_E10_REVIEW_FOLLOW_MAX: how many times review findings are handed back to the session (default 1; 0 means they are never handed back). Every fix made in answer to one is read again. */
export const followMax = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number((env["LOKI_E10_REVIEW_FOLLOW_MAX"] ?? "").trim()); return (env["LOKI_E10_REVIEW_FOLLOW_MAX"] ?? "").trim() !== "" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 1; };
/** True while the review findings may still be handed back: handBacks counts the hand-backs that carried review findings. An unmet acceptance line is handed back whatever this says. Pure. */
export const mayHandBack = (s: { handBacks: number; max: number }): boolean => s.handBacks < s.max;
/** SEAL-REUSE: the fields of a model read that seal needs to rebuild the review (notes already capped by xreview). */
export interface ReviewRead { notes: string[]; reasons: string[]; provider: string; reviewed_by?: string; reviewer_model?: string }
export const readOf = (xr: CrossReview): ReviewRead => ({ notes: xr.notes, reasons: xr.reasons ?? [], provider: xr.provider, ...(xr.reviewed_by ? { reviewed_by: xr.reviewed_by } : {}), ...(xr.reviewer_model ? { reviewer_model: xr.reviewer_model } : {}) });
/** True when a model review ran in this stage and the tree now differs from the tree the last review read: one more read of reviewedTree..tree is due, and nothing is handed back from it. Pure. */
export const needsClosingRead = (s: { reviewRan: boolean; tree: string; reviewedTree: string }): boolean => s.reviewRan && s.tree !== s.reviewedTree;
const UNTRUSTED_INPUT_RULE = "Code that reads untrusted input uses the parser or escaping library this repository already depends on for that format. Hand-written matching of such input is a defect unless the repository has no such dependency; then say so in your reply.";

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
    UNTRUSTED_INPUT_RULE, // loki-mode#692: one fixed rule line in the cache-stable prefix, before any per-task text
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

/** THIN-WRAP (#712) T1 to T7: the independent proof, one review and at most one fix turn. `author` is the one author turn after the first session (null when no
 *  author session exists, as on --seal-existing): it is given the hand-back text and says whether the session was resumed. The caller owns the review closure
 *  and the closing read (T8). No author turn is ever asked to write or repair the proof. */
export interface ThinProofDeps {
  scratch: SessionScratch; issue: string; cardLine: string | null; knownText: string | null; model?: string; pathAppend?: string[]; limitS: number;
  proofRounds: { exit: number | null; failed: number; seconds: number; base_seconds?: number }[];
  review: (tree: string) => Promise<string[]>; mayHand: () => boolean;
  author: ((found: string[], failing: string, text: string) => Promise<boolean>) | null; reply: () => string;
}
export interface ThinProofResult {
  proof_author: { status: "script" | "no script" | "not run"; reason?: string; iteration_ids: string[]; restored: string[]; created: string[]; rounds: number };
  fix_turn: { undone: boolean; regressed?: string[]; paths: string[] } | null; still_open: string[] | null;
}
export const thinNotRun = (reason: string): ThinProofResult => ({ proof_author: { status: "not run", reason, iteration_ids: [], restored: [], created: [], rounds: 0 }, fix_turn: null, still_open: null });
export async function thinProof(ctx: RunContext, signal: AbortSignal, d: ThinProofDeps): Promise<ThinProofResult> {
  const sd = d.scratch, o = ctx.outputs();
  for (const f of [join(sd.dir, PROOF_SCRIPT), join(ctx.runDir, PROOF_SCRIPT)]) rmSync(f, { force: true }); // the proof Loki counts is the prover's: a script the author left never counts here
  const measure = async (): Promise<{ pr: ProofRerun | null; pb: ProofBase | null }> => { // one run of Loki's own copy, with the same events and round record as the proof loop
    const round = d.proofRounds.length, pr = await rerunProof(ctx.repoDir, ctx.runDir, signal); if (!pr) return { pr: null, pb: null };
    const pb = pr.exit === 0 && pr.failed === 0 ? await proofOnBase(ctx.repoDir, ctx.runDir, ctx.baseSha, pr, signal) : null;
    if (pb) ctx.emit("proof.base", "implement", { round: round + 1, available: pb.available, ...(pb.why ? { why: pb.why } : {}), seconds: pb.seconds, ...(pb.cached ? { cached: true } : {}), base_checks: pb.base_checks, base_proved: pb.base_proved, passing: pb.head_proved, also_pass_on_base: pb.same_total });
    d.proofRounds.push({ exit: pr.exit, failed: pr.failed, seconds: pr.seconds, ...(pb && !pb.cached ? { base_seconds: pb.seconds } : {}) }); { const la0 = labelAsks(ctx.provider, o.intake, o.plan, ctx.repoDir); ctx.emit("proof.rerun", "implement", { round: round + 1, exit: pr.exit, proved: pr.proved, failed: pr.failed, seconds: pr.seconds, ...(pr.restored?.length ? { restored: pr.restored } : {}), source: la0.source, statuses: ruleStatus(la0.asks, pr, proofBaseCapOn() ? pb : null).map((s, i) => ({ line: s.line, status: s.status, checks: pr.lines[String(i + 1)]?.proved ?? 0, ...(s.reason ? { reason: s.reason } : {}) })) }); }
    return { pr, pb };
  };
  const base = { issue: d.issue, cardLine: d.cardLine, knownText: d.knownText, scratch: sd, ...(d.model ? { model: d.model } : {}), ...(d.pathAppend?.length ? { pathAppend: d.pathAppend } : {}), limitS: d.limitS, signal };
  const ids: string[] = [], restored: string[] = [], created: string[] = [], note = (r: ProofAuthorRun): void => { ids.push(r.iterationId); restored.push(...r.restored); created.push(...r.created); };
  // T1: a fresh prover session; it never sees the author's reply and anything it changes in the repository is put back
  const pa1 = await runProofAuthor(ctx, { ...base, extra: "" }); note(pa1); let rounds = 1;
  // T2: Loki keeps its own copy of the prover's script and runs it; the base comparison when it passes in full
  let pr1: ProofRerun | null = null, pb1: ProofBase | null = null;
  if (pa1.script && !signal.aborted && keepProofScript(sd.dir, ctx.runDir)) ({ pr: pr1, pb: pb1 } = await measure());
  // T3: the first review, whether or not the proof passed
  const tree = await worktreeTree(ctx.repoDir), found = tree && !signal.aborted ? await d.review(tree) : [];
  // T4: what the author hears: the review findings (while they may be handed back) and each failing check. A line with no check, and a line whose every
  // passing check also passes on base, go to the prover (T7), never to the author.
  const handFound = d.mayHand() ? found : [], failing = thinFailingText(pr1?.checks ?? []), text = d.author ? thinHandBack(handFound, failing) : "";
  // T5: the one author turn after the first session; T6: Loki's copy again, and the turn is undone when a check that passed before it fails after it
  let fix: ThinProofResult["fix_turn"] = null, stillOpen: string[] | null = null, pr2: ProofRerun | null = null, pb2: ProofBase | null = null, wrong: string[] = [];
  if (text && d.author && !signal.aborted) {
    const pre = snapshotDiff(ctx.repoDir, ctx.baseSha);
    if (await d.author(handFound, failing, text)) {
      const paths = turnChangedPaths(pre, snapshotDiff(ctx.repoDir, ctx.baseSha)); wrong = checkWrongLines(d.reply());
      if (pr1 && !signal.aborted && existsSync(join(ctx.runDir, PROOF_SCRIPT))) ({ pr: pr2, pb: pb2 } = await measure()); // never keepProofScript here: an author edit to the scratch copy never reaches Loki's
      const regressed = pr1 && pr2 ? regressedChecks(pr1.checks, pr2.checks) : [];
      if (regressed.length) { try { restoreTurnPaths(ctx.repoDir, ctx.baseSha, pre, paths); } catch { /* the closing read then reads what is left */ } fix = { undone: true, regressed, paths }; stillOpen = handFound.map((f) => f.slice(0, 300)); }
      else fix = { undone: false, paths };
    }
  }
  // T7: at most one resume of the prover session (never a new one), with what changed and what Loki found
  if (pr1 && !fix?.undone && !signal.aborted) {
    const last = pr2 ?? pr1, lastBase = pr2 ? pb2 : pb1, asks = labelAsks(ctx.provider, o.intake, o.plan, ctx.repoDir).asks;
    const noCheck = asks.flatMap((l, i) => { const e = last.lines[String(i + 1)]; return optionalAsk(l) || (e && e.proved + e.failed > 0) ? [] : [i + 1]; });
    const facts = baseFacts(asks, last, lastBase), lastFailing = (last.checks ?? []).filter((c) => !c.ok);
    const fault = last.refused ? `Loki did not run your script: ${last.refused}.` : last.exit !== 0 && !lastFailing.length ? `Your script did not pass when Loki ran it (exit ${last.exit === null ? "none, it did not finish in time" : last.exit}) and no check failed. The end of its output:\n${last.tail.slice(-2000)}` : "";
    if (fix || noCheck.length || facts.length || fault) {
      const extra = [
        fix && fix.paths.length ? `After your script ran, the author changed: ${fix.paths.slice(0, 30).join(", ")}.` : "",
        wrong.length ? `The author says these checks are wrong against the issue:\n${wrong.join("\n")}` : "",
        lastFailing.length ? thinFailingText(lastFailing).replace(/\n\nEnd with the same finish line as before\.$/, "") : "",
        noCheck.length ? `These acceptance items have no check in your script: ${noCheck.join(", ")}. Give each at least one real check of the product.` : "",
        ...facts, fault,
      ].filter(Boolean).join("\n\n");
      try { copyFileSync(join(ctx.runDir, PROOF_SCRIPT), join(sd.dir, PROOF_SCRIPT)); } catch { /* the prover rewrites it */ } // Loki's own copy back in place of whatever the author left
      const pa2 = await runProofAuthor(ctx, { ...base, extra, prior: { opts: pa1.opts, session: pa1.session } });
      if (pa2.ran) { note(pa2); rounds++; if (!signal.aborted && keepProofScript(sd.dir, ctx.runDir)) await measure(); }
    }
  }
  return { proof_author: { status: pa1.script ? "script" : "no script", iteration_ids: ids, restored: [...new Set(restored)], created: [...new Set(created)], rounds }, fix_turn: fix, still_open: stillOpen };
}

/** THIN-WRAP part 4 (#712): --seal-existing on an issue run (intake gives source "issue" only for an issue reference) goes through the same prover and review
 *  as a session run, so a sealed patch is measured the way a Loki change is. No author session exists, so nothing is handed back (T4 to T6 never run) and the
 *  findings reach the receipt only. Off the route the result is applyExternalPatch's, byte for byte. */
export async function sealExistingThin(ctx: RunContext, signal: AbortSignal, applied: StageResult): Promise<StageResult> {
  const o = ctx.outputs(), task = (o.intake?.task as string | undefined) ?? "", plan = (o.plan?.plan as string | undefined) ?? null, dev = roleModel("dev");
  if (!thinRoute(ctx.provider, o.intake?.source, issueAcceptanceOf(o.intake).length, plan, dev ?? ctx.model) || !proofRerunOn() || signal.aborted) return applied;
  let scratch: SessionScratch; try { scratch = createSessionScratch(ctx.runDir); } catch { return applied; }
  { const sc = scratch, rd = ctx.runDir; process.once("exit", () => { if (existsSync(sc.dir)) writeExitCleanup(rd, cleanupSessionScratch(sc)); }); }
  writeProofKit(scratch.dir, labelAsks(ctx.provider, o.intake, o.plan, ctx.repoDir).asks); // the same kit the session path writes
  const known = repoCardBrief(ctx.repoDir, scratch.dir, process.env, null), card = envCard(ctx);
  let lastRead: { level: string; findings: number; tree: string; read: ReviewRead } | null = null, cost: string | null = null;
  const review = async (tree: string): Promise<string[]> => {
    if (!reviewFixOn()) return [];
    const xr = await crossReview(ctx, "VERIFIED", tree, signal, true); if (xr?.cost_iteration) cost = xr.cost_iteration;
    const found = handBackReasons(xr); ctx.emit("review.early", "implement", { level: xr?.level ?? "not_run", findings: found.length });
    if (modelReviewRan(xr)) lastRead = { level: xr!.level, findings: found.length, tree, read: readOf(xr!) };
    return found;
  };
  const proofRounds: ThinProofDeps["proofRounds"] = [];
  const rec = await thinProof(ctx, signal, { scratch, issue: task, cardLine: card?.line ?? null, knownText: known?.text ?? null, ...(roleModel("test") || !dev ? {} : { model: dev }), ...(card?.pathAppend.length ? { pathAppend: card.pathAppend } : {}), limitS: implementStage.limitS, proofRounds, review, mayHand: () => false, author: null, reply: () => "" });
  const endTree = (await worktreeTree(ctx.repoDir)) ?? "", read = lastRead as { level: string; findings: number; tree: string; read: ReviewRead } | null;
  const reviewState = read ? { level: read.level, findings: read.findings, follow: false, still_open: [], changed_unread: !!endTree && endTree !== read.tree, tree: read.tree, read: read.read } : null;
  const scratchRec = cleanupSessionScratch(scratch), data = (applied.data ?? {}) as Record<string, unknown>;
  return { ...applied, data: { ...data, thin: true, proof_author: rec.proof_author, ...(proofRounds.length ? { proof_rounds: proofRounds } : {}), ...(reviewState ? { review_state: reviewState } : {}), ...(scratchRec.stopped.length || scratchRec.left.length || !scratchRec.removed ? { scratch_cleanup: scratchRec } : {}), iteration_ids: [...((data.iteration_ids as string[] | undefined) ?? []), ...rec.proof_author.iteration_ids, ...(cost ? [cost] : [])] } };
}

export const implementStage: Stage = {
  name: "implement",
  targetS: 180,
  limitS: 480,

  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> {
    rmSync(join(ctx.repoDir, ".loki", "supply-declared.json"), { force: true }); // T10 B3: never judge this run by a stale declaration
    try { recoverTournamentUndo(ctx.repoDir, ctx.runDir); } catch { /* an unreadable record is left for a person */ } // a displacement a kill cut short is undone before any session can write newer edits
    if (ctx.externalPatch) { const applied = applyExternalPatch(ctx, ctx.externalPatch); return applied.status === "completed" && applied.data?.exit === "external" ? sealExistingThin(ctx, signal, applied) : applied; } // THIN-WRAP part 4: an applied patch on the thin route gets the same prover and review
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
    const bc = briefCtx(ctx, routed ? undefined : devPin ?? downgrade?.to ?? ctx.model);

    const spec = specFor(ctx);
    // CH-03: resume plan's session on the same model (never when routed: per-unit models differ). Wall, verify and seal never join the chain. planChain owns eligibility; `!plan` here only keeps plan_chain out of the data when plan was skipped.
    const chain = routed || !plan ? null : devPin || planPin ? planChain(ctx, resolveClaudeModel(devPin ?? ctx.model), resolveClaudeModel(planPin ?? fastTierModel(process.env))) : planChain(ctx, downgrade?.to ?? ctx.model, fastTierModel(process.env)); // ROLE-MODELS: the plan session ran on the plan role, so the chain compares resolved ids
    const own = routed ? null : interruptedSession(ctx, `${ctx.runId}-impl`); // a rerun continues its own killed session before any plan link
    const ownId = own && "id" in own ? own.id : undefined;
    const resumeId = ownId ?? (chain && "id" in chain ? chain.id : undefined);
    let planChainMode: string | undefined = ownId ? "resumed (interrupted session)" : chain ? (resumeId ? "resumed" : `fresh (${(chain as { why: string }).why})`) : undefined;
    let sessionResume: string | undefined = own ? (ownId ? "resumed" : `fresh (${(own as { why: string }).why})`) : undefined;
    const patchModel = devPin ?? downgrade?.to ?? ctx.model ?? resolveModel(ctx.provider); // a named model only: "claude (provider default)" names none for a tool-less call
    const patchOn = patchEnabled() && !plan && !routed && !resumeId && ctx.provider === "claude" && /^[\w.:@/-]+$/.test(patchModel);
    const issue = issueRunBrief(ctx.provider, prior.intake?.source); // candidate 1: issue-run rules, block, lines and card; a text goal and opencode keep today's brief
    let scratch: SessionScratch | null = null; try { scratch = issue ? createSessionScratch(ctx.runDir) : null; } catch { scratch = null; } // Q1 RUN-SCRATCH: the session's own short scratch directory; any error means none
    if (scratch) { const sc = scratch, rd = ctx.runDir; process.once("exit", () => { if (existsSync(sc.dir)) writeExitCleanup(rd, cleanupSessionScratch(sc)); }); } // safety net: an aborted stage still leaves nothing running or on disk
    const attemptsNamed = (process.env.LOKI_E10_ATTEMPT_MODELS ?? "").trim() !== "", firstAttemptModel = attemptsK(devPin ?? ctx.model) > 0 && (!devPin || attemptsNamed) ? attemptModels()[0] : undefined; // ROLE-MODELS: under a dev pin only an explicit LOKI_E10_ATTEMPT_MODELS list (the narrower setting) names attempt 1, never the cascade default // LOKI_E10_ATTEMPT_MODELS entry 1: the first of the best-of-N attempts (a downgrade still wins)
    const implModel = downgrade?.to ?? firstAttemptModel ?? devPin; // the model the first session runs on when one is named (else the run model)
    const thin = thinRoute(ctx.provider, prior.intake?.source, issueAcceptanceOf(prior.intake).length, plan, implModel ?? ctx.model) && !routed && !patchOn && scratch !== null && proofRerunOn(); // THIN-WRAP (#712): LOKI_E10_THIN_WRAP=0 restores the 11.185.0 route
    const lessons = thin ? "" : lessonsForBrief(ctx.repoDir, ctx.runId, task, [...((prior.plan?.relevant_files as string[] | undefined) ?? []), ...impacted], ctx.runDir, ctx.baseSha); // R3: a proposed lesson is read only once approved, approval by merged guidance read from ctx.baseSha. T6: reviewer lessons plus run lessons on the relevant files or their impacted tests (util/pr_lessons.ts), tagged as used by this run and recorded in lessons-injected.json // THIN-WRAP: not sent on the thin route, so not read and not recorded as used
    const repoMap = thin ? "" : bc.text + lessons + learningsBlock(ctx.repoDir) + orgKnowledgeBlock(ctx.repoDir, task, ctx.runDir); // S41-10: up to 20 relevant files + impacted test commands, not the first 200 paths; FR06 org block is off unless LOKI_ORG_GRAPH=1
    const picked = (Array.isArray(prior.intake?.assumptions) ? (prior.intake!.assumptions as unknown[]) : []).filter((a): a is string => typeof a === "string" && runPickedChoice(a)); // LOKI_E10_OPUS_CONSULT trigger open-choice: an either/or the run would settle by itself
    const choiceAdvice = picked.length && !thin && consultEnabled() && !ownId && !signal.aborted ? await runConsult({ runDir: ctx.runDir, repoDir: ctx.repoDir, stage: "implement", trigger: "open-choice", task, evidence: picked.join("\n"), diff: null, code: bc.packText ?? bc.text }) : null;
    const kitAsks = scratch ? labelAsks(ctx.provider, prior.intake, prior.plan, ctx.repoDir).asks : [];
    if (scratch) writeProofKit(scratch.dir, kitAsks); // the check functions and the numbered acceptance lines the proof script must use
    const memText = scratch && !thin && ctx.provider === "claude" && taskMemoryOn() ? taskMemoryText({ title: task.split("\n").map((l) => l.trim()).find(Boolean) ?? "", asks: kitAsks, sites: namedSitesEnabled() ? namedSites(task, ctx.repoDir) : [], ...(namedSitesEnabled() ? { siteRule: NAMED_SITE_LINE } : {}) }) : null;
    const memDir = scratch && memText ? writeTaskMemory(scratch.dir, memText) : null;
    const cardEnv: Record<string, string> = scratch && !thin && ctx.provider === "claude" && compactCardOn() ? { [TASK_CARD_ENV]: taskCardText({ title: task.split("\n").map((l) => l.trim()).find(Boolean) ?? "", asks: kitAsks, sites: namedSitesEnabled() ? namedSites(task, ctx.repoDir) : [], briefPath: join(ctx.runDir, "implement-brief.txt"), finishRule: issue && prior.intake?.source !== "text" ? ISSUE_FINISH_LINE : FINISH_LINE }), [CARD_BASE_ENV]: ctx.baseSha, [CARD_RUN_DIR_ENV]: ctx.runDir } : {}; // COMPACT CARD (runner/compact_card.ts): re-sent with Loki's progress at every compaction, SDK route // TASK MEMORY: read again by Claude Code after each compaction; only a Haiku session loads it (runner/providers.ts taskMemorySettings)
    const setupCheck = issue && !ownId && !signal.aborted ? await settleSetupCheck(ctx.repoDir, ctx.runDir, (s) => runSetupScript(ctx.repoDir, s, signal, process.env, ctx.runDir)) : null; // SETUP CHECK: Loki's own run of the stored setup on this checkout (started beside plan), and the one-file edit that gets it through when it stops
    if (setupCheck) ctx.emit("repo.card", "implement", { when: "checked", result: setupCheck.result, seconds: setupCheck.seconds, trials: setupCheck.trials, ...(setupCheck.file ? { file: setupCheck.file } : {}) });
    const known = issue ? repoCardBrief(ctx.repoDir, scratch?.dir ?? null, process.env, setupCheck) : null; // REPO CARD: what earlier runs here verified (e10ext/repomemory.ts), in the brief and as $LOKI_SCRATCH/loki-setup.sh; LOKI_REPO_CARD=0 opts out
    if (known) { try { writeFileSync(join(ctx.runDir, "repo-card.json"), JSON.stringify(known.record) + "\n"); } catch { /* the record is evidence only */ } ctx.emit("repo.card", "implement", { when: "read", ...known.record }); }
    const card = issue ? envCard(ctx) : null; // the small environment card (util/stack_tools.ts envCard): server binaries off PATH that the repository needs
    const fullBrief = thin ? thinImplementBrief(taskBlock(task).join("\n\n"), card?.line ?? null) : buildImplementBrief(task, plan, impacted, known ? `${repoMap}${repoMap ? "\n\n" : ""}${known.text}` : repoMap, [specBriefBlock(spec), execSpecBriefOf(ctx.runDir), ...adviceBlock(choiceAdvice), proveByRunningBlock(ctx.provider, prior.intake?.source, process.env, card?.line ?? null)].filter(Boolean).join("\n\n") || null, prior.intake?.assumptions, rankedRemedyEnabled() ? prior.intake?.ranked_remedy : undefined, issue && prior.intake?.source === "text" ? "text" : issue); // the advice joins the per-task part of the brief, never the cache-stable prefix // LOKI_E10_EXEC_SPEC: the binding and advisory spec cases the lean Wall stage left
    try { mkdirSync(ctx.runDir, { recursive: true }); writeFileSync(join(ctx.runDir, ATTEMPT_BRIEF_FILE), fullBrief, "utf8"); } catch { /* best effort: without it the machine starts no extra attempt */ } // EXP-0010: the extra attempts after a red verify start from this exact brief
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
      const proofMeasure = async (): Promise<number | null> => { if (thin || !scratch || !proofRerunOn() || !existsSync(join(scratch.dir, PROOF_SCRIPT)) || !keepProofScript(scratch.dir, ctx.runDir)) return null; const pr = await rerunProof(ctx.repoDir, ctx.runDir, signal); return pr ? (pr.exit === 0 ? pr.failed : Math.max(1, pr.failed)) : null; };
      const r = await resumeToFinish(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, { fingerprint: () => treeFingerprint(ctx.repoDir, ctx.baseSha), spentUsd: () => ctx.cost.read(ctx.repoDir, ctx.sessionIds?.() ?? ids).usd, compactions: (xs) => compactionsOf(ctx, xs), signal, normalize: h1n, measure: proofMeasure });
      session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); finish = r.record;
    }
    const incomplete = finish !== undefined && finish.ended !== "finish line";
    if (incomplete) session = { ...session, markers: { ...session.markers, done: false } }; // S1b: an unfinished session is never built on or replaced by a follow-up resume (coverage, remedy, precedence, named sites, -rv all require markers.done)
    let coverage: string | undefined; // L4: lean path only; an attempts run owns its own sessions
    let claimAbsent: string[] | undefined; // site-ledger claimed_change_absent: SITE lines naming a line the coverage turn did not change, re-asked once
    if (!thin) /* THIN-WRAP: no coverage turn and no claim re-ask on the thin route */ if (coverageResumeEnabled() && !plan) { if (patch?.status !== "green" && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { const r = await resumeForCoverage(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); claimAbsent = r.claimAbsent; coverage = "resumed"; } else coverage = patch?.status === "green" ? "skipped (patch green)" : "skipped"; }
    else if (coverageMode() === "fold" && !plan) { // the brief carried COVERAGE_FOLD (buildImplementBrief), so no separate turn; with LOKI_E10_CLAIM_CHECK on, the session's own SITE lines get the claim check
      coverage = patch?.status === "green" ? "skipped (patch green)" : "folded";
      if (patch?.status !== "green" && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { const r = await reaskFoldedClaims(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); claimAbsent = r.claimAbsent; }
    }

    let rankedRemedyRec: RemedyRecord | undefined; // F1 LOKI_E10_RANKED_REMEDY: one tool-less check of the diff against the issue's first-ranked remedy, at most one "-rr" resume
    const remedy = rankedRemedyEnabled() && !thin && typeof prior.intake?.ranked_remedy === "string" ? prior.intake.ranked_remedy as string : null;
    if (remedy && patch?.status !== "green" && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { const r = await resumeForRemedy(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, remedy, currentDiff(ctx.repoDir, ctx.baseSha, 12000, true) ?? ""); session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); rankedRemedyRec = r.record; }
    let precedenceRec: { sites: number; resumed: boolean } | undefined; // F3 LOKI_E10_PRECEDENCE_CHECK: one "-pr" follow-up when the diff widened a check whose function holds other checks
    if (!thin && patch?.status !== "green" && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { const r = await resumeForPrecedence(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); if (r.sites > 0) { session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); precedenceRec = { sites: r.sites, resumed: r.iterationIds.length > 0 }; } }
    let namedRec: NamedSitesRecord | null = null; // R2 LOKI_E10_NAMED_SITES: every named site changed or explained; one "-ns" resume for any that is neither, seal judges the final diff
    if (!thin && patch?.status !== "green" && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { const r = await resumeForNamedSites(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, task); session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); namedRec = r.record; }
    if (!thin && scratch && proofRerunOn() && !existsSync(join(scratch.dir, PROOF_SCRIPT)) && !signal.aborted && !session.killed && session.exit === 0 && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { // PROOF SCRIPT: the session ran the product by hand but left nothing Loki can re-run; one resume asks for the script, the session's own verdict and reply stay
      const r = await resumeForProofScript(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, `Loki found no proof script at $LOKI_SCRATCH/loki-proof.sh, so nothing you ran can count toward the label. Write it now from the commands you already ran in this session. ${PROOF_SCRIPT_LINE} Do not change the product code in this turn unless the script shows a real failure. When it passes, leave it in place and end with the same finish line as before.`);
      if (r.iterationId !== ids[ids.length - 1]) ids.push(r.iterationId);
      if (r.session.summary) session = { ...session, summary: `${session.summary ?? ""}\n\n[proof script turn]\n${r.session.summary}` };
    }
    const lineRounds: { met: number; unmet: number; usd: number | null; reader?: "review" | "follow" }[] = [];
    let reviewedTree = "", lastFound: string[] = [], followUps = 0, lastReviewRan = false, handBacks = 0, pendingFollow = false, lastReadFound: string[] = [], lastRead: { level: string; findings: number; follow: boolean; still_open: string[] | null; tree: string; read: ReviewRead } | null = null; /* handBacks: hand-backs that carried review findings; pendingFollow: the last such hand-back is not read yet; lastRead: the last model read, for review_state */ const reviewFollow: { round: number; level: string; findings: number }[] = [], followCosts: string[] = []; // loki-mode#692: the tree the last review read, what it found, and the follow-ups that read what each fix turn changed
    const proofRounds: { exit: number | null; failed: number; seconds: number; base_seconds?: number }[] = []; // PROOF LOOP: Loki runs the proof itself and hands a failure back with its real output, so a session that is wrong is corrected by evidence, not asked to try harder
    let reviewedEarly = false, earlyReviewCost: string | null = null; let proofFails = 0, lineTurns = 0; const LINE_TURNS_MAX = 2;
    // NO-DEFAULT-BUDGET: with no time limit the proof and acceptance turn counts are not the bound. A round makes progress when Loki's own proof run fails fewer
    // checks, or fewer acceptance lines are unmet, than the best round so far; noProgressRounds() rounds in a row without either end the loop.
    const noBudget = !defaultBudgetsOn(); let proofBest = { failed: Infinity, unmet: Infinity }, proofStill = 0;
    const proofStep = (failed: number, unmet: number): void => { if (failed < proofBest.failed || unmet < proofBest.unmet) { proofBest = { failed: Math.min(failed, proofBest.failed), unmet: Math.min(unmet, proofBest.unmet) }; proofStill = 0; } else proofStill++; }; // the acceptance check has its own two turns: a session that used every proof turn to get the script passing (Haiku did) used to get no acceptance feedback at all
    // One independent review during the run (a read-only call): returns the findings to hand back, [] when it found none, was off or already ran.
    const reviewFound = async (tree: string): Promise<string[]> => {
      // REVIEW-THEN-FIX: the review is read first, with the first passing proof run, so the session hears the reviewer and the acceptance check in one turn.
      if (reviewedEarly || !reviewFixOn()) return [];
      reviewedEarly = true;
      const xr = await crossReview(ctx, "VERIFIED", tree, signal, true); if (xr?.cost_iteration) earlyReviewCost = xr.cost_iteration;
      const found = handBackReasons(xr); // flags too: a reviewer filed "the default search page fails with a 400 on first load" as a flag, and the session can fix or rebut a flag in one turn; the reviewer's whole findings come first, then its UNMET items, bounded by handBackReasons and not by the receipt's cap of 5
      ctx.emit("review.early", "implement", { level: xr?.level ?? "not_run", findings: found.length });
      lastReviewRan = modelReviewRan(xr); lastFound = found; if (lastReviewRan) { reviewedTree = tree; lastReadFound = found; lastRead = { level: xr!.level, findings: found.length, follow: false, still_open: [], tree, read: readOf(xr!) }; }
      return found;
    };
    // A follow-up review of what the last fix turn changed (reviewedTree..tree); the earlier findings are named so the reviewer says which are still open. It ends when it finds nothing (lastFound is then empty).
    const noteFollow = (xr: CrossReview, earlier: string[], found: string[], tree: string): void => { // the follow-up read's record for review_state: which earlier findings it listed as open (null: it gave no STILL OPEN line; [] when there was nothing earlier to list)
      reviewedTree = tree; lastReadFound = found; pendingFollow = false;
      lastRead = { level: xr.level, findings: found.length, follow: true, still_open: earlier.length === 0 ? [] : xr.still_open == null ? null : xr.still_open.map((k) => earlier[k - 1]!.slice(0, 300)), tree, read: readOf(xr) };
    };
    const followFound = async (tree: string, round: number): Promise<string[]> => {
      const n = ++followUps, earlier = lastReadFound;
      const xr = await crossReview(ctx, "VERIFIED", tree, signal, true, { from: reviewedTree, earlier, n }); if (xr?.cost_iteration) followCosts.push(xr.cost_iteration);
      const found = handBackReasons(xr);
      ctx.emit("review.early", "implement", { level: xr?.level ?? "not_run", findings: found.length, follow: n });
      lastReviewRan = modelReviewRan(xr); lastFound = found; if (lastReviewRan) { noteFollow(xr!, earlier, found, tree); reviewFollow.push({ round, level: xr!.level, findings: found.length }); }
      return found;
    };
    // The closing read: one follow-up read of reviewedTree..tree for a change no review has read (a proof-failure turn, a count-only hand-back, a self review turn). It hands nothing back.
    const closingRead = async (tree: string): Promise<void> => {
      const n = ++followUps, earlier = lastReadFound;
      const xr = await crossReview(ctx, "VERIFIED", tree, signal, true, { from: reviewedTree, earlier, n }); if (xr?.cost_iteration) followCosts.push(xr.cost_iteration);
      if (xr === null) { reviewedTree = tree; return; } // an empty diff: nothing changed that a reader could read
      const found = handBackReasons(xr);
      ctx.emit("review.early", "implement", { level: xr.level, findings: found.length, follow: n, closing: true });
      if (modelReviewRan(xr)) { noteFollow(xr, earlier, found, tree); reviewFollow.push({ round: proofRounds.length + 1, level: xr.level, findings: found.length }); }
    };
    // The one hand-back resume: the review's findings and any unmet acceptance lines together; true when the session was resumed and the proof must run again.
    const handBackTurn = async (found: string[], unmetText: string, round: number, given?: string): Promise<boolean> => { // given: the thin route's own text (thinHandBack)
      const text = given ?? combinedHandBack(found, unmetText); if (!text) return false;
      const r3 = await resumeForProofScript(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, text);
      if (r3.iterationId !== ids[ids.length - 1]) ids.push(r3.iterationId); else return false;
      if (found.length) { handBacks++; pendingFollow = true; }
      const tag = found.length && unmetText ? `after the independent review and Loki's acceptance check, round ${round + 1}` : unmetText ? `after Loki's acceptance check, round ${round + 1}` : "after the independent review";
      if (r3.session.summary) session = { ...session, summary: `${session.summary ?? ""}\n\n[${tag}]\n${r3.session.summary}` };
      return true;
    };
    const reviewRound = async (tree: string): Promise<boolean> => { const f = await reviewFound(tree); return handBackTurn(mayHandBack({ handBacks, max: followMax() }) ? f : [], "", 0); }; // the later call sites (turns used up, no unmet line): nothing when the review already ran
    const handedGaps = new Set<number>(), disputes: { line: string; reason: string; round: number }[] = []; // a reviewer gap on a line with a passing check is handed back once per line
    let thinRec: ThinProofResult | null = null; // THIN-WRAP T1 to T7 in place of the proof loop; the loop below is unchanged for every other route
    if (thin) thinRec = scratch && !signal.aborted && !session.killed && session.exit === 0 && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)
      ? await thinProof(ctx, signal, { scratch, issue: task, cardLine: card?.line ?? null, knownText: known?.text ?? null, ...(roleModel("test") || !implModel ? {} : { model: implModel }), ...(card?.pathAppend.length ? { pathAppend: card.pathAppend } : {}), limitS: implementStage.limitS, proofRounds,
          review: reviewFound, mayHand: () => mayHandBack({ handBacks, max: followMax() }), author: (found, failing, text) => handBackTurn(found, failing, 0, text), reply: () => session.summary ?? "" })
      : thinNotRun(session.killed ? "the implement session was stopped" : session.exit !== 0 ? "the implement session did not end cleanly" : session.markers.specConflict ? "the implement session ended with a spec conflict" : session.markers.alreadyDone ? "the implement session said the work was already done" : "the change is empty");
    else for (let round = 0; (noBudget ? proofStill < noProgressRounds() : proofFails < proofLoopMax()) && scratch && proofRerunOn() && existsSync(join(scratch.dir, PROOF_SCRIPT)) && !signal.aborted && !session.killed && session.exit === 0 && !session.markers.specConflict && !session.markers.alreadyDone; round++) {
      if (!keepProofScript(scratch.dir, ctx.runDir)) break;
      const pr = await rerunProof(ctx.repoDir, ctx.runDir, signal); if (!pr) break;
      const pb = pr.exit === 0 && pr.failed === 0 ? await proofOnBase(ctx.repoDir, ctx.runDir, ctx.baseSha, pr, signal) : null; // PROVES THE CHANGE: the same script against the base commit; a check that also passes there proves nothing about this change (proof_rerun.ts proofOnBase)
      if (pb) ctx.emit("proof.base", "implement", { round: round + 1, available: pb.available, ...(pb.why ? { why: pb.why } : {}), seconds: pb.seconds, ...(pb.cached ? { cached: true } : {}), base_checks: pb.base_checks, base_proved: pb.base_proved, passing: pb.head_proved, also_pass_on_base: pb.same_total });
      proofRounds.push({ exit: pr.exit, failed: pr.failed, seconds: pr.seconds, ...(pb && !pb.cached ? { base_seconds: pb.seconds } : {}) }); { const la0 = labelAsks(ctx.provider, prior.intake, prior.plan, ctx.repoDir); ctx.emit("proof.rerun", "implement", { round: round + 1, exit: pr.exit, proved: pr.proved, failed: pr.failed, seconds: pr.seconds, ...(pr.restored?.length ? { restored: pr.restored } : {}), source: la0.source, statuses: ruleStatus(la0.asks, pr, proofBaseCapOn() ? pb : null).map((s, i) => ({ line: s.line, status: s.status, checks: pr.lines[String(i + 1)]?.proved ?? 0, ...(s.reason ? { reason: s.reason } : {}) })) }); } // the live console turns each line green from this
      if (pr.exit === 0 && pr.failed === 0) { // the proof passes when Loki runs it: now check it against every acceptance line, and hand unmet lines back with the reason
        const la = labelAsks(ctx.provider, prior.intake, prior.plan, ctx.repoDir); if (!la.asks.length) break; if (noBudget ? proofStill >= noProgressRounds() : lineTurns >= LINE_TURNS_MAX) { const t = await worktreeTree(ctx.repoDir); if (t && await reviewRound(t)) continue; break; } // the acceptance turns are used up: the review still gets its one round (a run that spent both turns never reached it)
        const tree = await worktreeTree(ctx.repoDir); if (!tree) break;
        const lcRun = (): Promise<LineCheckRecord> => issueLineCheck(ctx, la.asks, tree, [], session.summary ?? "", [...(la.needs.length ? [`This repository needs: ${la.needs.join(", ")}.`] : []), "Loki's verify stage has not run yet at this point, so the check list is empty: a line about tests is met when the output of Loki's own run shows those tests passing.", ...proofFacts(ctx.runDir, pr, true), ...baseFacts(la.asks, pr, pb)]);
        // loki-mode#692: ONE reader per tree. A tree a review (or follow-up) read gets no line check in that round; one the review did not read (no reviewer, no room) still gets it, so no tree is left unread. With LOKI_E10_REVIEW_FOLLOW_MAX=0 the round is today's: review and line check in parallel.
        const reader = readerFor({ reviewOn: reviewFixOn(), reviewed: reviewedEarly, changedSinceReview: pendingFollow && reviewedTree !== "" && tree !== reviewedTree && lastFound.length > 0, followUps, max: Infinity }); // a fix made in answer to review findings is always read; how many times findings are handed back is mayHandBack's bound
        let lc: LineCheckRecord | null = null, found: string[] = [];
        if (reader === "line-check") lc = lastRead ? null : await lcRun(); // after a model review has read a tree no later round runs the line check; the closing read reads what changed
        else if (followMax() === 0) [lc, found] = await Promise.all([lcRun(), reviewFound(tree)]);
        else { found = reader === "review" ? await reviewFound(tree) : await followFound(tree, round + 1); if (needsLineCheck(reader, lastReviewRan) && !lastRead) lc = await lcRun(); }
        if (!mayHandBack({ handBacks, max: followMax() })) found = []; // the review's findings are handed back only while handBacks < max; unmet lines below still are
        const byRule = ruleStatus(la.asks, pr), empty = new Set(provesNothing(la.asks, pr, pb)), unmetAll = la.asks.flatMap<{ line: string; reason: string; gap?: number; raw?: string }>((line, i) => { if (optionalAsk(line)) return []; if (byRule[i]!.status !== "met") return [{ line: `${i + 1}. ${line}`, reason: byRule[i]!.reason ?? "" }]; if (empty.has(i + 1)) return [{ line: `${i + 1}. ${line}`, reason: `${provesNothingReason(pb!, i + 1)}. ${PROVES_NOTHING_FIX}` }]; return lc?.marks && !lc.marks.met.includes(i + 1) ? [{ line: `${i + 1}. ${line}`, reason: `it has a passing check, but a reviewer found a gap: ${lc.reasons?.[String(i + 1)] ?? "not stated"}`, gap: i + 1, raw: lc.reasons?.[String(i + 1)] ?? "not stated" }] : []; }); // the count decides; the reviewer's gaps are handed back too, as advice the session should close
        const go = gapOnce(handedGaps, unmetAll.filter((u) => u.gap !== undefined).map((u) => ({ n: u.gap!, line: u.line, reason: u.raw! })), round + 1), again = new Set(go.handBack.map((g) => g.n)); disputes.push(...go.disputes); // the second time a reviewer names the same line it is recorded, not handed back
        const unmet: { line: string; reason: string }[] = unmetAll.filter((u) => u.gap === undefined || again.has(u.gap)).map((u) => ({ line: u.line, reason: u.reason }));
        const lineUnmet = unmet.length; // the acceptance count is about the lines actually handed back
        proofStep(pr.failed, lineUnmet);
        for (const f of await unusedNewFiles(ctx.repoDir, ctx.baseSha, tree)) unmet.push({ line: `(not an acceptance line) ${f}`, reason: "no other file in the repository imports or names this new file, so a user cannot reach what it does. Mount it where it belongs (a page, a route, a registry, a menu) and prove that path, or remove it" });
        lineRounds.push(lc ? { met: lc.marks?.met.length ?? 0, unmet: unmet.length, usd: lc.usd } : { met: la.asks.length - lineUnmet, unmet: unmet.length, usd: null, ...(reader === "line-check" ? {} : { reader }) }); // no line check ran: the count is the round's own ctx.emit("acceptance.round", "implement", { round: round + 1, met: la.asks.length - lineUnmet, unmet: lineUnmet, ...(empty.size ? { pass_on_base_too: empty.size } : {}), ...(unmet.length > lineUnmet ? { unused_new_files: unmet.length - lineUnmet } : {}), ...(go.disputes.length ? { disputed: go.disputes.length } : {}) });
        if (!unmet.length) { if (await handBackTurn(found, "", round)) { if (found.length) proofStill = 0; continue; } break; } // a hand-back that carried review findings is not a still round: the proof must rerun on the last fix // REVIEW-THEN-FIX, then the proof again on the fixed tree
        const stray = Object.keys(pr.lines).filter((k) => Number(k) > la.asks.length || Number(k) < 1); // checks filed under a number that is no acceptance item
        if (!await handBackTurn(found, unmetBrief(unmet, stray.length ? `Your proof script passes, but ${stray.length} of its check numbers (${stray.slice(0, 6).join(", ")}) are not acceptance item numbers, so those checks count for no item. The first argument of loki_http and loki_cmd is the item's number in $LOKI_SCRATCH/acceptance.txt (1 to ${la.asks.length}), never a line number of the script. Renumber them.` : ""), round)) break;
        if (found.length) proofStill = 0; // as above: review findings were handed back, so the proof reruns before any still-round count
        lineTurns++; // only a hand-back that carried unmet lines counts toward the acceptance turns
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
    { const mode = selfReviewMode(); if (mode !== "off" && !thin && ctx.baseSha && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) {
      const before = selfReviewChecks(ctx.repoDir, ctx.baseSha, treeStaged(ctx.repoDir, ctx.baseSha), task, ctx.outputs(), process.env, ctx.runDir);
      let after: ReviewItem[] | null = null, reply: string | null = null, turn: string | null = null;
      let guard: TurnGuardRecord | null = null, finish: FinishRecord | null = null;
      if (selfReviewWanted(before, mode)) { const fin = verifiedFinishOn() ? verifiedFinishBrief(ctx.repoDir, ctx.baseSha, before, task) : null, preTurn = fin || reviewTurnGuardOn() ? snapshotDiff(ctx.repoDir, ctx.baseSha) : null; const r = fin ? await runVerifiedFinish(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, fin.brief, verifiedFinishMaxTurns()) : await resumeForSelfReview(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, selfReviewBrief(ctx.repoDir, before), selfReviewMaxTurns()); if (fin) finish = { fired: true, iteration: r?.iterationId ?? null, ...fin.record }; /* VF: a fresh finish session on the cut context, always guarded */ if (r) { turn = r.iterationId; if (!ids.includes(r.iterationId)) ids.push(r.iterationId); if (r.session !== session) { reply = r.session.summary ?? ""; guard = preTurn && !signal.aborted ? await reviewTurnGuard(ctx, preTurn, readOnly.map((f) => relative(ctx.repoDir, f.path)), signal) : null; if (!guard?.reverted && !r.session.killed && r.session.exit === 0 && r.session.markers.done && !r.session.markers.specConflict && !r.session.markers.alreadyDone) session = r.session; else session = { ...session, durationS: r.session.durationS }; } after = selfReviewChecks(ctx.repoDir, ctx.baseSha, treeStaged(ctx.repoDir, ctx.baseSha), task, ctx.outputs(), process.env, ctx.runDir); } } // only a clean LOKI_DONE review reply replaces the implement result: a review turn never turns a done run into a conflict; TG: a reverted turn keeps the pre-turn result
      selfReview = { mode, turn, items: settleItems(before, after, guard?.reverted ? null : reply), ...(guard ? { turn_guard: guard } : {}), ...(finish ? { finish } : {}) };
    } }
    const refsRemoved = ctx.baseSha && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done ? stripInventedReleaseRefs(ctx.repoDir, ctx.baseSha, treeStaged(ctx.repoDir, ctx.baseSha), task) : []; // CR: a reference the task never gives never ships, whatever the model wrote
    const pinnedUpdates = pinnedTestUpdateEnabled() && ctx.baseSha ? pinnedTestUpdates(ctx.repoDir, ctx.baseSha, session.summary ?? "", task) : []; // Z2: the UPDATED TEST lines of the final reply, each checked against base, head and the task
    if (process.env.LOKI_E10_REPRO === "1" && !plan && !thin && !signal.aborted && !session.killed && session.exit === 0) { let bad: { name: string; why: string }[] = []; try { bad = outOfRepoTests(ctx.repoDir, changedFiles(ctx.repoDir, ctx.baseSha, installOwned(ctx.repoDir, ctx.outputs().intake?.install_created))); } catch { /* unreadable tree: no re-ask */ } if (bad.length) { const redo = `${first.iterationId}-oor`; ids.push(redo); session = await ctx.sessions.run({ ...unchained(), brief: withStagePrefix(outOfRepoReask("Rewrite these new test files in place, keeping the same names and what they reproduce.", bad)), iterationId: redo }); } } // TEN-QUALITY-44: the repro test gets the Wall's out-of-repo check and one re-ask
    const testsReverted = restoreReadOnly(readOnly);
    const tournament = tournamentEnabled() && !plan ? await runTournamentGate(ctx, signal, session, attemptDeps(ctx, 0, "", 0)) : undefined; // after the Wall files are restored, so candidates are checked against the original Wall and tests; LOKI_E10_TOURNAMENT (Go, lean path, on by default but inert without an exec-spec probe block; =0 opts out): features/tournament.ts
    const overlap = !plan && nrdOverlapOn(); if (overlap) startNrdGate(ctx, signal, session, readOnly.map((f) => relative(ctx.repoDir, f.path))); // SPEED-NRD-OVERLAP: verify (or seal) settles it
    const noRegression = !plan && !overlap ? await runNrdGate(ctx, signal, session, readOnly.map((f) => relative(ctx.repoDir, f.path))) : null; // LOKI_E10_NRD (Go, lean path, default on, =0 opts out): features/no_regression.ts, after the tournament and the Wall restore; the first verify hands its finding to one fix round
    // REVIEW-HOLDS (#698): the last point where the stage can have changed code (after the self review, the Wall restore, the tournament and the no-regression gate). One closing read when a model review ran and the tree is not the tree it read; review_state records what the last read said.
    let reviewState: Record<string, unknown> | null = null;
    if (lastRead) {
      const endTree = (await worktreeTree(ctx.repoDir)) ?? "";
      if (needsClosingRead({ reviewRan: true, tree: endTree, reviewedTree }) && endTree && !signal.aborted && !session.killed) await closingRead(endTree);
      const final = lastRead as { level: string; findings: number; follow: boolean; still_open: string[] | null; tree: string; read: ReviewRead };
      reviewState = { level: final.level, findings: final.findings, follow: final.follow, still_open: final.still_open, changed_unread: !!endTree && endTree !== reviewedTree, tree: final.tree, read: final.read }; // SEAL-REUSE (#702, #691): the tree the last read saw and what it said, so seal can reuse a block read of the sealed tree
      if (thinRec?.still_open) reviewState = { ...reviewState, still_open: thinRec.still_open, changed_unread: false }; // THIN-WRAP T6: the fix turn was undone, so every finding handed back to it is still open (closure.ts reviewHolds)
    }
    const iterationId = ids[ids.length - 1]!;
    // E-68 classifies exit codes; a non-killed, marker-less non-zero exit is an error, never "done".
    if (scratch && !thin) keepProofScript(scratch.dir, ctx.runDir); // THIN-WRAP: Loki already holds the prover's copy; the session's proof script leaves the scratch before it is removed; seal re-runs it
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
      iteration_ids: earlyReviewCost || followCosts.length || thinRec?.proof_author.iteration_ids.length ? [...ids, ...(thinRec?.proof_author.iteration_ids ?? []), ...(earlyReviewCost ? [earlyReviewCost] : []), ...followCosts] : ids, /* THIN-WRAP: the prover sessions are in the receipt's cost, never in ids (the author's resume chain) */ model: rt ? rt.current : downgrade?.to ?? firstAttemptModel ?? devPin ?? ctx.model, ...(rt ? { route_model: rt.current, route_escalations: rt.escalations } : {}), session_id: readSessionId(ctx.repoDir, iterationId), // MW-2
      duration_s: session.durationS, ...(session.exit === MAX_TURNS_EXIT && !session.killed ? { stop_cause: "max_turns", owner: "harness", limit_s: implementStage.limitS, elapsed_s: session.durationS, ...(capStopOf(session.summary) ? { session_cap: capStopOf(session.summary) } : {}) } : {}),
      ...(planChainMode ? { plan_chain: planChainMode } : {}),
      ...(sessionResume ? { session_resume: sessionResume } : {}),
      ...(finish ? { finish: { ...finish, compactions: compactionsOf(ctx, ids) } } : {}),
      ...(proofRounds.length ? { proof_rounds: proofRounds } : {}), ...(lineRounds.length ? { acceptance_rounds: lineRounds } : {}), ...(reviewFollow.length ? { review_follow: reviewFollow } : {}), ...(reviewState ? { review_state: reviewState } : {}), ...(disputes.length ? { acceptance_disputes: disputes } : {}), ...(scratchRec && (scratchRec.stopped.length || scratchRec.left.length || !scratchRec.removed) ? { scratch_cleanup: scratchRec } : {}), // RUN-SCRATCH: recorded only when the harness had to stop something or could not remove the directory // S1b: only when it fired, so an unchanged run's receipt keys stay as they were; compactions are seen on the SDK route only (null on the CLI route)
      ...(coverage ? { coverage_resume: coverage } : {}), ...(rankedRemedyRec ? { ranked_remedy: rankedRemedyRec } : {}), ...(precedenceRec ? { precedence_check: precedenceRec } : {}), ...(namedRec ? { named_sites: namedRec } : {}), ...(memDir && memText ? { task_memory: { bytes: Buffer.byteLength(memText), sha256: sha256(memText) } } : {}), ...(pinConflict ? { pin_conflict: pinConflict } : {}), ...(pinnedUpdates.length ? { pinned_test_updates: pinnedUpdates } : {}), ...(claimAbsent ? { claim_absent: claimAbsent } : {}),
      ...(patch ? { patch: { status: patch.status, seconds: Math.round(patchS * 10) / 10, calls: patch.calls, applied: patch.applied, refused: patch.refused, restored: patch.restored, usd: patch.usd, log: patch.log, ...(patch.check ? { check: patch.check } : {}) } } : {}),
      ...(tournament ? { tournament } : {}),
      ...(thin ? { thin: true, proof_author: thinRec?.proof_author ?? thinNotRun("not reached").proof_author, ...(thinRec?.fix_turn ? { fix_turn: thinRec.fix_turn } : {}) } : {}), // THIN-WRAP (#712): seal reads proof_author (proof_rerun.ts noOwnProofNotes)
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
