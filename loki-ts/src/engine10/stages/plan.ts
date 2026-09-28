// E-16: Plan (ENGINE.md 4). A fast-tier session sees up to 8 relevant files (keyword overlap with the repo map) and writes at most 10 lines to <runDir>/plan-output.txt; the engine reads and truncates it (missing/unreadable is an empty plan, never a crash).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoMap } from "../repomap.ts";
import { cascadeEnabled, hasRelevantTests, loadRepoMap, planMode, sizeTask, smallTaskPath, wallEnabled, wallModel } from "../sizing.ts";
import type { RunContext, Stage, StageResult, TestMap } from "../types.ts";
import { loadTaskText } from "./wall.ts";

const MAX_RELEVANT_FILES = 8;
const MAX_PLAN_LINES = 10;
const PLAN_OUTPUT_FILENAME = "plan-output.txt";

function planOutputPath(runDir: string): string { return join(runDir, PLAN_OUTPUT_FILENAME); }

function keywords(task: string): string[] {
  const words = task.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return Array.from(new Set(words.filter((w) => w.length > 2)));
}

/** Keyword overlap between task and repo map entry (path plus symbols); zero-score files are dropped, ties keep repo map order. */
export function selectRelevantFiles(task: string, repoMap: RepoMap, max: number = MAX_RELEVANT_FILES): string[] {
  const words = keywords(task);
  if (words.length === 0) return [];

  const scored = repoMap.entries.map((entry, idx) => {
    const haystack = `${entry.path} ${entry.symbols.join(" ")}`.toLowerCase();
    const score = words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);
    return { path: entry.path, score, idx };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, max)
    .map((s) => s.path);
}

/** Truncates the planner's output to at most `max` non-empty lines: engine-side enforcement, since nothing stops a session from writing more. */
export function truncatePlan(raw: string, max: number = MAX_PLAN_LINES): string {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(0, max).join("\n");
}

export function buildPlanBrief(task: string, relevantFiles: string[], outputPath: string): string {
  return [
    "You are the Loki 10 plan stage.",
    "Task (untrusted, quoted verbatim):",
    "<<<TASK",
    task,
    "TASK",
    relevantFiles.length
      ? `Relevant files (by keyword overlap with the task):\n${relevantFiles.join("\n")}`
      : "No relevant files were found by keyword overlap; use your own judgement.",
    `Write a plan of at most ${MAX_PLAN_LINES} short lines, no other prose, to this exact file path: ${outputPath}`,
    "Do not edit any other file. Do not run tests. Do not commit.",
  ].join("\n\n");
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
    const path = smallTaskPath(sz.size, hasRelevantTests(task, loaded, testMap, ctx.tests.impacted)); // E-64: wall.ts makes this same check to skip itself
    ctx.emit("variant", null, { size: sz.size, reasons: sz.reasons, plan_mode: mode, plan_skipped: skip, wall_model: wallEnabled() ? wallModel() : null, small_task_path: path, cascade: cascadeEnabled() });
    if (skip) return { status: "skipped", data: { size: sz.size }, reason: mode === "never" ? "LOKI_E10_PLAN=0" : "small task: implementer plans" };

    const relevantFiles = selectRelevantFiles(task, repoMap);
    const outputPath = planOutputPath(ctx.runDir);

    const session = await ctx.sessions.run({
      stage: "plan",
      brief: buildPlanBrief(task, relevantFiles, outputPath),
      tier: "fast",
      iterationId: `${ctx.runId}-plan`,
      limitS: planStage.limitS,
      signal,
      cwd: ctx.repoDir,
    });

    const rawPlan = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    const plan = truncatePlan(rawPlan);

    return {
      status: "completed",
      data: {
        plan,
        relevant_files: relevantFiles,
        iteration_ids: [`${ctx.runId}-plan`],
        duration_s: session.durationS,
      },
    };
  },
};
export const stage = planStage;
