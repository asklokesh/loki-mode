// E-16: Plan (ENGINE.md 4). A fast-tier session sees up to 8 relevant files (keyword overlap with the repo map) and writes at most 10 lines to <runDir>/plan-output.txt; the engine reads and truncates it (missing/unreadable is an empty plan, never a crash).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoMap } from "../repomap.ts";
import { selectRelevantFiles } from "../relevant_files.ts";
import { classifyExitCause } from "../session.ts"; // E-68 reuse: never re-classify exit codes here
import { cascadeEnabled, hasRelevantTests, loadRepoMap, planMode, sizeTask, smallTaskPath, wallEnabled, wallModel } from "../sizing.ts";
import type { RunContext, Stage, StageResult, TestMap } from "../types.ts";
import { withStagePrefix } from "../../features/lean_prefix.ts";
import { taskBlock } from "../types.ts";
import { PLAN_SCOPE_FILE } from "../../util/run_cap.ts";
import { loadTaskText } from "./wall.ts";
import { fastTierModel } from "../../runner/model_downgrades.ts";
import { planRoute, ROUTER_UNITS_INSTRUCTION } from "../../runner/router/plan_route.ts";

const MAX_PLAN_LINES = 10;
const PLAN_OUTPUT_FILENAME = "plan-output.txt";

function planOutputPath(runDir: string): string { return join(runDir, PLAN_OUTPUT_FILENAME); }

export { selectRelevantFiles };

/** Truncates the planner's output to at most `max` non-empty lines: engine-side enforcement, since nothing stops a session from writing more. */
export function truncatePlan(raw: string, max: number = MAX_PLAN_LINES): string {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(0, max).join("\n");
}

export function buildPlanBrief(task: string, relevantFiles: string[], outputPath: string, scopePath: string = outputPath.replace(PLAN_OUTPUT_FILENAME, PLAN_SCOPE_FILE), router: boolean = false): string {
  return withStagePrefix([
    "You are the Loki 10 plan stage.",
    ...taskBlock(task),
    relevantFiles.length
      ? `Relevant files (by keyword overlap with the task):\n${relevantFiles.join("\n")}`
      : "No relevant files were found by keyword overlap; use your own judgement.",
    `Write a plan of at most ${MAX_PLAN_LINES} short lines, no other prose, to this exact file path: ${outputPath}`,
    `Also write a JSON object {"files":["<repo-relative path>", ...]} naming every file your plan changes or creates, to this exact file path: ${scopePath}`,
    ...(router ? [ROUTER_UNITS_INSTRUCTION.replace("<scope>", scopePath)] : []),
    "Do not edit any other file. Do not run tests. Do not commit.",
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
    // FC-35: with the router on a small task still plans (Opus must route it); only an explicit LOKI_E10_PLAN=0 skips, and records why.
    const skip = mode === "never" || (mode === "auto" && sz.size === "small" && !pr.routed);
    // E-64: wall.ts makes this same check to skip itself; a forced plan (LOKI_E10_PLAN=always) also forces "wall", since it still gets its own Wall.
    const path = mode === "always" ? "wall" : smallTaskPath(sz.size, hasRelevantTests(task, loaded, testMap, ctx.tests.impacted));
    ctx.emit("variant", null, { size: sz.size, reasons: sz.reasons, plan_mode: mode, plan_skipped: skip, wall_model: wallEnabled() ? wallModel() : null, small_task_path: path, cascade: cascadeEnabled() });
    if (skip) pr.record({ planModel: "none", skipReason: "plan stage skipped (LOKI_E10_PLAN=0)" });
    if (skip) return { status: "skipped", data: { size: sz.size }, reason: mode === "never" ? "LOKI_E10_PLAN=0" : "small task: implementer plans" };

    const relevantFiles = selectRelevantFiles(task, repoMap);
    const outputPath = planOutputPath(ctx.runDir);

    const iterationId = `${ctx.runId}-plan`;
    const runPlan = (onSonnet: boolean) => ctx.sessions.run({
      stage: "plan",
      brief: buildPlanBrief(task, relevantFiles, outputPath, join(ctx.runDir, PLAN_SCOPE_FILE), pr.routed),
      tier: "fast",
      iterationId,
      limitS: planStage.limitS,
      signal,
      cwd: ctx.repoDir,
      ...pr.pinFor(onSonnet),
    });
    let session = await runPlan(false);
    let planModel = pr.planModel(fastTierModel(process.env));
    let planModelNote: string | null = null;
    if (pr.pinOpus && !session.killed && session.exit !== 0) { // Opus unavailable: Sonnet plans, and the receipt says so
      planModel = "sonnet"; planModelNote = `Opus plan session failed (exit ${session.exit}); the plan ran on sonnet`;
      session = await runPlan(true);
    }

    // E-61: a non-killed error exit fails this stage too (never silently read as an
    // empty-but-successful plan). mustJump (machine.ts) still lets the flow continue
    // past a failed plan: implement falls back to planning the change itself.
    if (!session.killed && session.exit !== 0) {
      pr.record({ planModel, planModelNote, skipReason: `plan session failed (exit ${session.exit})` });
      const stderrTail = (session as unknown as { stderrTail?: string }).stderrTail ?? "";
      mkdirSync(ctx.runDir, { recursive: true });
      const stderrPath = join(ctx.runDir, `${iterationId}.stderr.log`);
      writeFileSync(stderrPath, stderrTail, "utf8");
      return { status: "failed", reason: classifyExitCause(session.exit, false), data: { iteration_ids: [iterationId], duration_s: session.durationS, stderr_path: stderrPath } };
    }

    const rawPlan = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    const plan = truncatePlan(rawPlan);
    const route_record = pr.record({ planModel, planModelNote });
    return {
      status: "completed",
      data: {
        plan,
        relevant_files: relevantFiles,
        iteration_ids: [iterationId],
        duration_s: session.durationS,
        ...pr.units(),
        ...(route_record ? { route_record } : {}),
      },
    };
  },
};
export const stage = planStage;
