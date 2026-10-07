// E-16: Plan (ENGINE.md 4). A fast-tier session sees up to 8 relevant files (keyword overlap with the repo map) and writes at most 10 lines to <runDir>/plan-output.txt; the engine reads and truncates it (missing/unreadable is an empty plan, never a crash).
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { routerEnabled } from "../../runner/router/flag.ts";
import { envOverride, parseUnits } from "../../runner/router/decision.ts";
import { probeAdvisor } from "../../runner/router/advisor_probe.ts";
import { claudeCodeVersionForRoute } from "../../runner/providers.ts";

const MAX_PLAN_LINES = 10;
const MAX_SCOPE_BYTES = 256 * 1024;
const PLAN_OUTPUT_FILENAME = "plan-output.txt";

function planOutputPath(runDir: string): string { return join(runDir, PLAN_OUTPUT_FILENAME); }

export { selectRelevantFiles };

/** Truncates the planner's output to at most `max` non-empty lines: engine-side enforcement, since nothing stops a session from writing more. */
export function truncatePlan(raw: string, max: number = MAX_PLAN_LINES): string {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(0, max).join("\n");
}

// R1-10: Opus is the router. The model picks each unit's executor; the harness only validates the schema (L0).
const ROUTER_UNITS_INSTRUCTION = 'In the same JSON file (<scope>) also add "units": [{"id":"<unit id>","kind":"<short kind>","executor":"sonnet"|"haiku","reason":"<=200 chars"}], one entry per work unit of your plan. The default executor is sonnet. Assign haiku to a unit only when you judge it safe for that unit and say why in reason. Give the Wall acceptance-test unit the id "wall".';

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
    const skip = mode === "never" || (mode === "auto" && sz.size === "small");
    // E-64: wall.ts makes this same check to skip itself; a forced plan (LOKI_E10_PLAN=always) also forces "wall", since it still gets its own Wall.
    const path = mode === "always" ? "wall" : smallTaskPath(sz.size, hasRelevantTests(task, loaded, testMap, ctx.tests.impacted));
    ctx.emit("variant", null, { size: sz.size, reasons: sz.reasons, plan_mode: mode, plan_skipped: skip, wall_model: wallEnabled() ? wallModel() : null, small_task_path: path, cascade: cascadeEnabled() });
    if (skip) return { status: "skipped", data: { size: sz.size }, reason: mode === "never" ? "LOKI_E10_PLAN=0" : "small task: implementer plans" };

    const relevantFiles = selectRelevantFiles(task, repoMap);
    const outputPath = planOutputPath(ctx.runDir);

    const iterationId = `${ctx.runId}-plan`;
    // R1-10: flag off adds nothing (no probe, no model key, brief byte-identical). Advisor unavailable: Opus plans itself.
    const routed = routerEnabled(process.env);
    const advisorAvailable = routed ? probeAdvisor(process.env, ctx.provider, await claudeCodeVersionForRoute(process.env), ctx.runDir).available : false;
    // Opus plans itself only on a Claude run, and never over the user's model bypass.
    const pinOpus = routed && !advisorAvailable && ctx.provider === "claude" && envOverride(process.env) === null;
    const session = await ctx.sessions.run({
      stage: "plan",
      brief: buildPlanBrief(task, relevantFiles, outputPath, join(ctx.runDir, PLAN_SCOPE_FILE), routed),
      tier: "fast",
      iterationId,
      limitS: planStage.limitS,
      signal,
      cwd: ctx.repoDir,
      ...(pinOpus ? { model: "opus" } : {}),
    });

    // E-61: a non-killed error exit fails this stage too (never silently read as an
    // empty-but-successful plan). mustJump (machine.ts) still lets the flow continue
    // past a failed plan: implement falls back to planning the change itself.
    if (!session.killed && session.exit !== 0) {
      const stderrTail = (session as unknown as { stderrTail?: string }).stderrTail ?? "";
      mkdirSync(ctx.runDir, { recursive: true });
      const stderrPath = join(ctx.runDir, `${iterationId}.stderr.log`);
      writeFileSync(stderrPath, stderrTail, "utf8");
      return { status: "failed", reason: classifyExitCause(session.exit, false), data: { iteration_ids: [iterationId], duration_s: session.durationS, stderr_path: stderrPath } };
    }

    const rawPlan = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    const plan = truncatePlan(rawPlan);
    let route: Record<string, unknown> = {};
    if (routed) {
      const scopePath = join(ctx.runDir, PLAN_SCOPE_FILE);
      let scope: string | null = null; let tooBig = false; let notFile = false;
      try {
        if (existsSync(scopePath)) { const st = lstatSync(scopePath); if (!st.isFile()) notFile = true; else if (st.size > MAX_SCOPE_BYTES) tooBig = true; else scope = readFileSync(scopePath, "utf8"); }
      } catch { scope = null; }
      const parsed = notFile ? { units: [], notProven: [`NOT PROVEN (owner model): ${PLAN_SCOPE_FILE} is not a regular file; default sonnet`] } : tooBig ? { units: [], notProven: [`NOT PROVEN (owner model): ${PLAN_SCOPE_FILE} exceeds ${MAX_SCOPE_BYTES} bytes; default sonnet`] } : parseUnits(scope, advisorAvailable);
      route = { units: parsed.units, route_not_proven: parsed.notProven };
    }

    return {
      status: "completed",
      data: {
        plan,
        relevant_files: relevantFiles,
        iteration_ids: [iterationId],
        duration_s: session.durationS,
        ...route,
      },
    };
  },
};
export const stage = planStage;
