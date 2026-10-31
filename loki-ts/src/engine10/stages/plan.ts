// E-16: Plan (ENGINE.md 4). A fast-tier session sees up to 8 relevant files (keyword overlap with the repo map) and writes at most 10 lines to <runDir>/plan-output.txt; the engine reads and truncates it (missing/unreadable is an empty plan, never a crash).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoMap } from "../repomap.ts";
import { selectRelevantFiles } from "../relevant_files.ts";
import { MAX_TURNS_EXIT } from "../../runner/worker_proc.ts"; import { classifyExitCause } from "../session.ts"; // E-68 reuse: never re-classify exit codes here
import { cascadeEnabled, hasRelevantTests, loadRepoMap, namedFiles, planMode, sizeTask, smallTaskPath, wallEnabled, wallFirstModel, wallModel } from "../sizing.ts";
import { type RunContext, type Stage, type StageResult, type TestMap, taskBlock } from "../types.ts";
import { withStagePrefix } from "../../features/lean_prefix.ts";
import { PLAN_SCOPE_FILE, outOfRepoInstruction, planOutOfRepo, seedPlanScope } from "../../util/run_cap.ts";
import { assumptionsBlock } from "../../features/spec_ambiguity.ts";
import { loadTaskText } from "./wall.ts";
import { fastTierModel } from "../../runner/model_downgrades.ts";
import { planFallbackModel, planRoute, ROUTER_UNITS_INSTRUCTION } from "../../runner/router/plan_route.ts";
import { applyIntent, confirmRequested, intentCardEnabled, INTENT_CARD_INSTRUCTION } from "../../util/intent_card.ts";
import { loadProjectApi } from "../../project_model/resolve.ts";
import { behaviorChangeInstruction, mutationStrict, readBehaviorChange } from "../../util/mutation_proof.ts";
import { reviewerBriefEnabled } from "../../util/reviewer_brief.ts";

const MAX_PLAN_LINES = 10;
const PLAN_OUTPUT_FILENAME = "plan-output.txt";

function planOutputPath(runDir: string): string { return join(runDir, PLAN_OUTPUT_FILENAME); }

export { selectRelevantFiles };

/** The plan session is also the consent gate and the cap sizer. LOKI_CONFIRM keeps it at every size; for a normal task it is also kept when the intent card is shown on a terminal, or when the task names no files in a multi-package repo (nothing else would size the run cap). A small task never plans. The counts are lazy: they are read only when reached. */
export function keepsPlanForConsentOrCap(env: NodeJS.ProcessEnv, tty: boolean, size: string, named: () => number, packages: () => number): boolean {
  if (confirmRequested(env)) return true;
  return size === "normal" && ((intentCardEnabled(env) && tty) || (named() === 0 && packages() > 1));
}

/** Truncates the planner's output to at most `max` non-empty lines: engine-side enforcement, since nothing stops a session from writing more. */
export function truncatePlan(raw: string, max: number = MAX_PLAN_LINES): string {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(0, max).join("\n");
}

export function buildPlanBrief(task: string, relevantFiles: string[], outputPath: string, scopePath: string = outputPath.replace(PLAN_OUTPUT_FILENAME, PLAN_SCOPE_FILE), router: boolean = false, intentCard: boolean = false, behaviorChange: boolean = false, riskDecl: boolean = false, assumptions: unknown = undefined): string {
  return withStagePrefix([
    "You are the Loki 10 plan stage.",
    ...taskBlock(task),
    ...assumptionsBlock(assumptions), // headless ambiguous spec: the same assumptions the receipt records
    relevantFiles.length
      ? `Relevant files (by keyword overlap with the task):\n${relevantFiles.join("\n")}`
      : "No relevant files were found by keyword overlap; use your own judgement.",
    `Write a plan of at most ${MAX_PLAN_LINES} short lines, no other prose, to this exact file path: ${outputPath}`,
    `Also write a JSON object {"files":["<repo-relative path>", ...]} naming every file your plan changes or creates, to this exact file path: ${scopePath}`,
    ...(router ? [ROUTER_UNITS_INSTRUCTION.replace("<scope>", scopePath)] : []),
    ...(intentCard ? [INTENT_CARD_INSTRUCTION] : []),
    ...(behaviorChange ? [behaviorChangeInstruction(scopePath)] : []), // T2: strict only
    ...(riskDecl ? [`In the same JSON object (${scopePath}) also add "risky_hunks": up to 3 objects {"path":"<repo-relative path>","risk":<1 to 3, 3 highest>,"why":"<one short sentence>"} naming where a reviewer should look first.`] : []), // REVIEWER-BRIEF-V2
    outOfRepoInstruction(scopePath), "Do not edit any other file. Do not run tests. Do not commit.",
  ].join("\n\n"));
}

export const planStage: Stage = {
  name: "plan",
  targetS: 45,
  limitS: 90,

  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> {
    const prior = ctx.outputs();
    const task = loadTaskText(ctx, prior.intake?.task as string | undefined);
    const repomapRef = prior.intake?.repomap_ref as string | undefined;
    const loaded = loadRepoMap(repomapRef);
    const repoMap: RepoMap = loaded ?? { files: [], entries: [], truncated: false };
    const testMap = (prior.intake?.testmap as TestMap | undefined) ?? null;

    const sz = sizeTask(task, loaded, testMap); // E-45: a small task skips this session and the implementer plans
    const mode = planMode();
    const pr = await planRoute(ctx.runDir, ctx.provider, process.env, ctx.repoDir); // R1-10 (runner/router/plan_route.ts): flag off adds nothing
    // FC-35: with the router on a task still plans (Opus must route it); only an explicit LOKI_E10_PLAN=0 skips, and records why. A large task keeps the plan session; small and normal fold the plan into the implement brief.
    const skip = mode === "never" || (mode === "auto" && sz.size !== "large" && !pr.routed && !keepsPlanForConsentOrCap(process.env, process.stderr.isTTY === true, sz.size, () => namedFiles(task, loaded).length, () => loadProjectApi(ctx.repoDir)?.packages().length ?? 0));
    // E-64: wall.ts makes this same check to skip itself; a forced plan (LOKI_E10_PLAN=always) also forces "wall", since it still gets its own Wall.
    const path = mode === "always" ? "wall" : smallTaskPath(sz.size, hasRelevantTests(task, loaded, testMap, ctx.tests.impacted));
    ctx.emit("variant", null, { size: sz.size, reasons: sz.reasons, plan_mode: mode, plan_skipped: skip, wall_model: wallEnabled() ? wallFirstModel(sz.size) : null, wall_model_reauthor: wallEnabled() ? wallModel() : null, small_task_path: path, cascade: cascadeEnabled() });
    if (skip) pr.record({ planModel: "none", skipReason: "plan stage skipped (LOKI_E10_PLAN=0)" });
    if (skip && mode === "auto") seedPlanScope(ctx.runDir, namedFiles(task, loaded)); // the scope guard reads plan-scope.json
    if (skip) return { status: "skipped", data: { size: sz.size }, reason: mode === "never" ? "LOKI_E10_PLAN=0" : `${sz.size === "small" ? "small" : "normal"} task: implementer plans` };

    const relevantFiles = selectRelevantFiles(task, repoMap, undefined, ctx.repoDir);
    const outputPath = planOutputPath(ctx.runDir);

    const iterationId = `${ctx.runId}-plan`;
    const cardOn = intentCardEnabled(process.env);
    const runPlan = (onSonnet: boolean) => ctx.sessions.run({
      stage: "plan",
      brief: buildPlanBrief(task, relevantFiles, outputPath, join(ctx.runDir, PLAN_SCOPE_FILE), pr.routed, cardOn, mutationStrict(), reviewerBriefEnabled(), prior.intake?.assumptions),
      tier: "fast",
      iterationId,
      limitS: planStage.limitS,
      signal,
      cwd: ctx.repoDir,
      ...pr.pinFor(onSonnet, ctx.model),
    });
    let session = await runPlan(false);
    let planModel = pr.planModel(fastTierModel(process.env));
    let planModelNote: string | null = null;
    if (pr.pinOpus && !session.killed && session.exit !== 0) { // Opus unavailable: the fallback plans (never below the run model), and the receipt says so
      planModel = planFallbackModel(ctx.model); planModelNote = `Opus plan session failed (${session.exit === MAX_TURNS_EXIT ? "turn cap reached" : `exit ${session.exit}`}); the plan ran on ${planModel}`;
      session = await runPlan(true);
    }

    // E-61: a non-killed error exit fails this stage (never read as an empty plan); mustJump (machine.ts) still lets the flow continue: implement falls back to planning the change itself.
    if (!session.killed && session.exit !== 0) {
      pr.record({ planModel, planModelNote, skipReason: `plan session failed (exit ${session.exit})` });
      mkdirSync(ctx.runDir, { recursive: true });
      const stderrPath = join(ctx.runDir, `${iterationId}.stderr.log`);
      writeFileSync(stderrPath, session.stderrTail ?? "", "utf8");
      return { status: "failed", reason: classifyExitCause(session.exit, false), data: { iteration_ids: [iterationId], duration_s: session.durationS, stderr_path: stderrPath } };
    }

    const rawPlan = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    // T3: empty plan or LOKI_INTENT_CARD=0 is silent and changes nothing.
    const ic = await applyIntent(rawPlan, cardOn, ctx.runDir, (d) => ctx.emit("variant", "plan", d));
    const plan = truncatePlan(ic.rest);
    const route_record = pr.record({ planModel, planModelNote }), oor = planOutOfRepo(ctx.runDir); // FC-OUT-OF-REPO: ends the run as BLOCKED before implement/fix spend anything
    return {
      status: "completed",
      data: {
        plan,
        relevant_files: relevantFiles,
        iteration_ids: [iterationId],
        duration_s: session.durationS,
        ...ic.data,
        ...pr.units(), ...(oor ? { out_of_repo: true, spec_conflict_reason: `out-of-repo: ${oor.reason}` } : {}),
        ...(route_record ? { route_record } : {}),
        ...readBehaviorChange(ctx.runDir), // T2: model-declared, strict only
      },
    };
  },
};
export const stage = planStage;
