// E-08: Implement (ENGINE.md 4, 16). One session; the brief marks Wall tests read-only, names only the impacted tests. Afterwards any changed read-only file is restored (tests_reverted) and the exit is classified.
import { installOwned } from "../../project_model/install.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { withStagePrefix } from "../../features/lean_prefix.ts"; import { outOfRepoReask, outOfRepoTests } from "../../project_model/conventions.ts";
import { formatLessonsForBrief, learningsBlock, recordUse, retrieveLessons } from "../../util/pr_lessons.ts"; export { learningsBlock }; // learningsBlock lives with the other brief-note helpers
import { FINISH_LINE, FIXED_RULES, briefContext } from "../../e10ext/context.ts";
import { fastTierModel } from "../../runner/model_downgrades.ts";
import { cascadeDowngrade, haikuFirstDowngrade, loadRepoMap, namedFiles, sizeTask } from "../sizing.ts";
import { attemptsGate, runAttemptsOnCtx } from "../../features/attempts.ts"; // S41-13, default off
import { selectRelevantFiles } from "./plan.ts"; import { changedFiles, commandFor, runCheck, type VerifyCheck } from "./verify.ts"; import { loadProjectApi } from "../../project_model/resolve.ts"; import { planStopChecks } from "../../runner/stop_checks.ts";
import { classifyExitCause } from "../session.ts"; import { MAX_TURNS_EXIT } from "../../runner/worker_proc.ts"; // E-68 reuse: never re-classify exit codes here
import { adjudicateWallConflict, resumeAfterConflict, resumeAfterEmptyDone } from "../../util/conflict_resume.ts"; import type { WallDefect } from "../../util/wall_owned.ts";
import { INTERRUPTED_BRIEF, interruptedSession, planChain, readSessionId } from "../../runner/session_resume.ts";
import { routeEscalate, routeStart } from "../../runner/router/implement_route.ts";
import { routerActive } from "../../runner/router/unit_model.ts";
import { type ImplementExit, type RunContext, type SessionRunOptions, type Stage, type StageResult, type TestMap, taskBlock } from "../types.ts";
import { safeGit } from "../../util/safe_git.ts"; import { sha256 } from "./seal.ts";
import { assumptionsBlock } from "../../features/spec_ambiguity.ts";
import { loadSpecFile, specBriefBlock, type LoadedSpec } from "../../util/spec_file.ts";

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

export const briefCtx = (ctx: RunContext): string => briefContext(ctx, { select: selectRelevantFiles, cmd: (t, repoDir) => { const c = commandFor(t, repoDir, loadProjectApi(repoDir)); return [c.cmd, c.args, c.interpreter, c.pkgRoot]; } });
const REPRO_LINE = "If the task reports a bug, first add a new test function that reproduces it, run it and see it fail, then fix the code and run that test again.";
export function buildImplementBrief(task: string, plan: string | null, impactedTests: string[], repoMap = "", spec: string | null = null, assumptions: unknown = undefined): string {
  return withStagePrefix([ // FIXED_RULES leads and FINISH_LINE closes, both byte-identical per task
    FIXED_RULES,
    ...taskBlock(task),
    ...assumptionsBlock(assumptions),
    ...(spec ? [spec] : []), // SPEC-FIRST-INTENT: the user-edited spec is the authoritative intent; absent adds nothing
    plan ? `Follow this plan:\n${plan}` : "No separate plan was made: plan the change yourself in this session, then implement it." + (process.env.LOKI_E10_REPRO === "1" ? " " + REPRO_LINE : ""), // TEN-QUALITY-08: default off, lean path only
    ...(repoMap ? [repoMap] : []),
    impactedTests.length ? `Impacted tests (a starting hint, not a limit): ${impactedTests.join(", ")}.` : "Impacted tests: none known; run the project's full test command (a starting hint, not a limit).",
    FINISH_LINE,
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

export const implementStage: Stage = {
  name: "implement",
  targetS: 180,
  limitS: 480,

  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> {
    rmSync(join(ctx.repoDir, ".loki", "supply-declared.json"), { force: true }); // T10 B3: never judge this run by a stale declaration
    if (ctx.externalPatch) return applyExternalPatch(ctx, ctx.externalPatch);
    const prior = ctx.outputs();
    const task = (prior.intake?.task as string | undefined) ?? "";
    const plan = (prior.plan?.plan as string | undefined) ?? null;
    const impacted = impactedTests(ctx);
    const readOnly = (prior.wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? [];
    const routed = routerActive();
    const downgrade = routed ? null : cascadeDowngrade(ctx.model) ?? haikuFirstDowngrade(ctx.model); // the router replaces the opt-in downgrade lists; haiku-first (TEN-COST-16) only when the cascade is off
    const cascade = downgrade !== null;
    if (downgrade) process.stderr.write(`${downgrade.note}\n`);
    const lessons = retrieveLessons(ctx.repoDir, task); // T6: reviewer lessons from earlier merged PRs, tagged as used by this run
    try { recordUse(ctx.repoDir, ctx.runId, lessons.map((l) => l.id)); } catch { /* memory is best-effort */ }
    const repoMap = briefCtx(ctx) + formatLessonsForBrief(lessons) + learningsBlock(ctx.repoDir); // S41-10: up to 20 relevant files + impacted test commands, not the first 200 paths

    const spec = specFor(ctx);
    // CH-03: resume plan's session on the same model (never when routed: per-unit models differ). Wall, verify and seal never join the chain. planChain owns eligibility; `!plan` here only keeps plan_chain out of the data when plan was skipped.
    const chain = routed || !plan ? null : planChain(ctx, downgrade?.to ?? ctx.model, fastTierModel(process.env));
    const own = routed || process.env.LOKI_E10_ATTEMPTS === "2" ? null : interruptedSession(ctx, `${ctx.runId}-impl`); // a rerun continues its own killed session before any plan link
    const ownId = own && "id" in own ? own.id : undefined;
    const resumeId = ownId ?? (chain && "id" in chain ? chain.id : undefined);
    let planChainMode: string | undefined = ownId ? "resumed (interrupted session)" : chain ? (resumeId ? "resumed" : `fresh (${(chain as { why: string }).why})`) : undefined;
    let sessionResume: string | undefined = own ? (ownId ? "resumed" : `fresh (${(own as { why: string }).why})`) : undefined;
    const first: SessionRunOptions = {
      stage: "implement",
      brief: ownId ? INTERRUPTED_BRIEF : buildImplementBrief(task, plan, impacted, repoMap, specBriefBlock(spec), prior.intake?.assumptions),
      tier: "development",
      iterationId: `${ctx.runId}-impl`,
      limitS: implementStage.limitS,
      signal,
      cwd: ctx.repoDir,
      ...(downgrade ? { model: downgrade.to } : {}),
      ...(resumeId ? { resumeSessionId: resumeId } : {}), ...planStopChecks(ctx.repoDir, prior, new Set(impacted), implementStage.limitS, ctx.baseSha), // in-session fix rounds, default on (LOKI_E10_STOP_CHECKS=0 off)
    };
    const unchained = (): SessionRunOptions => { const { resumeSessionId: _chained, ...rest } = first; return ownId ? { ...rest, brief: buildImplementBrief(task, plan, impacted, repoMap, specBriefBlock(spec), prior.intake?.assumptions) } : rest; }; // read at call time: the router may rewrite first.model; retries and conflict reruns never inherit the chain link
    // ROUTER-1: per-unit ladder from the plan's route record (runner/router/unit_model.ts). Flag off: none of this runs.
    const rt = routed ? routeStart(ctx, first, prior.plan) : null;
    // S41-13: LOKI_E10_ATTEMPTS=2 on a normal-size task with a non-empty predicted S runs two attempts; the worker env is already token-scrubbed (asserted inside).
    const size = sizeTask(task, loadRepoMap(prior.intake?.repomap_ref as string | undefined), (prior.intake?.testmap as TestMap | undefined) ?? null).size;
    const two = attemptsGate({ size, predictedS: impacted.length }) ? await runAttemptsOnCtx(ctx, first, signal, impacted, { wallPaths: readOnly.map((f) => relative(ctx.repoDir, f.path)), wallContent: Object.fromEntries(readOnly.map((f) => [relative(ctx.repoDir, f.path), f.content])), check: (c, t, sg, out) => { const tc = commandFor(t, c.repoDir, loadProjectApi(c.repoDir)); return runCheck(c, `${t.runner}:${t.path}`, tc.cmd, tc.args, sg, out as VerifyCheck[], { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}) }); } }) : null;
    let session = two ? two.session : await ctx.sessions.run(first);
    const ids = two ? two.ids : [first.iterationId];
    if (resumeId && !session.killed && session.exit !== 0 && session.exit !== MAX_TURNS_EXIT) { // a failed resume reruns fresh with the same full brief
      planChainMode = "fallback (resume failed)";
      if (ownId) { sessionResume = "fallback (resume failed)"; process.stderr.write(`implement: recorded session ${ownId} was not resumable, starting a fresh session\n`); }
      const retry = `${first.iterationId}f`; ids.push(retry);
      session = await ctx.sessions.run({ ...unchained(), iterationId: retry });
    }
    if (rt && !signal.aborted) session = await routeEscalate(ctx, first, session, rt, ids); // triggers b/c: one redo on the next rung
    if (session.markers.specConflict && !session.killed) { const r = await resumeAfterConflict(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); session = r.session; if (r.iterationId !== ids[ids.length - 1]) ids.push(r.iterationId); } // FC-19: one correction, then the conflict is believed
    let wallDefect: WallDefect | null = null; if (session.markers.specConflict && !session.killed && !signal.aborted) { const w = await adjudicateWallConflict(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, readOnly); if (w) { session = w.session; ids.push(...w.ids); wallDefect = w.defect; } } // FC-WALL-DEFECT-REPORTED-AS-SPEC-CONFLICT: a Wall-anchored conflict is Loki's defect
    if (!signal.aborted && !session.killed && session.exit === 0 && !session.markers.specConflict && !session.markers.alreadyDone && treeIsEmpty(ctx)) { const r = await resumeAfterEmptyDone(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); session = r.session; ids.push(r.iterationId); } // FC-43: one correction for a done exit with no change

    if (process.env.LOKI_E10_REPRO === "1" && !plan && !signal.aborted && !session.killed && session.exit === 0) { let bad: { name: string; why: string }[] = []; try { bad = outOfRepoTests(ctx.repoDir, changedFiles(ctx.repoDir, ctx.baseSha, installOwned(ctx.repoDir, ctx.outputs().intake?.install_created))); } catch { /* unreadable tree: no re-ask */ } if (bad.length) { const redo = `${first.iterationId}-oor`; ids.push(redo); session = await ctx.sessions.run({ ...unchained(), brief: withStagePrefix(outOfRepoReask("Rewrite these new test files in place, keeping the same names and what they reproduce.", bad)), iterationId: redo }); } } // TEN-QUALITY-44: the repro test gets the Wall's out-of-repo check and one re-ask
    const testsReverted = restoreReadOnly(readOnly);
    const iterationId = ids[ids.length - 1]!;
    // E-68 classifies exit codes; a non-killed, marker-less non-zero exit is an error, never "done".
    let exit: ImplementExit | "error";
    if (session.killed || session.exit === MAX_TURNS_EXIT) { // a turn-cap stop is harness-owned and ends like a limit stop: PARTIAL, never BLOCKED
      exit = "killed";
    } else if (session.markers.specConflict) {
      exit = "spec_conflict";
    } else if (session.markers.alreadyDone) {
      exit = "already_done";
    } else if (session.exit !== 0) {
      exit = "error";
    } else {
      exit = "done";
    }

    const data: Record<string, unknown> = {
      exit,
      already_done_evidence: session.markers.alreadyDone,
      spec_conflict_reason: session.markers.specConflict,
      tests_reverted: testsReverted, ...(wallDefect ? { wall_defect: wallDefect } : {}),
      impacted_tests: impacted,
      cascade,
      ...(downgrade ? { model_downgrade: downgrade.note } : {}),
      iteration_ids: ids, model: rt ? rt.current : downgrade?.to ?? ctx.model, ...(rt ? { route_model: rt.current, route_escalations: rt.escalations } : {}), session_id: readSessionId(ctx.repoDir, iterationId), // MW-2
      duration_s: session.durationS, ...(session.exit === MAX_TURNS_EXIT && !session.killed ? { stop_cause: "max_turns", owner: "harness", limit_s: implementStage.limitS, elapsed_s: session.durationS } : {}),
      ...(planChainMode ? { plan_chain: planChainMode } : {}),
      ...(sessionResume ? { session_resume: sessionResume } : {}),
      ...(two ? { attempts: two.summary } : {}),
    };

    if (exit !== "error") return { status: "completed", data };

    const stderrTail = session.stderrTail ?? ""; mkdirSync(ctx.runDir, { recursive: true }); const stderrPath = join(ctx.runDir, `${iterationId}.stderr.log`); writeFileSync(stderrPath, stderrTail, "utf8");
    data.stderr_path = stderrPath;

    return { status: "failed", reason: classifyExitCause(session.exit, false), data };
  },
};
export const stage = implementStage;
