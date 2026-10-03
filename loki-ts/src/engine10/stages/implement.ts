// E-08: Implement (ENGINE.md 4, 16). One session; the brief marks Wall tests read-only, names only the impacted tests. Afterwards any changed read-only file is restored (tests_reverted) and the exit is classified.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { withStagePrefix } from "../../e10ext/lean_prefix.ts";
import { FINISH_LINE, FIXED_RULES, briefContext } from "../../e10ext/context.ts";
import { cascadeEnabled, cascadeImplementModel, loadRepoMap, namedFiles } from "../sizing.ts";
import { selectRelevantFiles } from "./plan.ts"; import { runnerCmd } from "./verify.ts";
import { classifyExitCause } from "../session.ts"; // E-68 reuse: never re-classify exit codes here
import type { ImplementExit, RunContext, Stage, StageResult, TestMap } from "../types.ts";
import { taskBlock } from "../types.ts";

/** A test file (a sealed Wall test) the implement session must not change: path is absolute, in the repo working tree; content is what to restore if it no longer matches. */
export interface ReadOnlyFile { path: string; content: string; }

/** Impacted tests: the intake test map narrowed to plan's relevant files, falling back to the task's named
 *  files when Plan was skipped or found none (E-64's lean path; E-98c), plus the sealed Wall tests. */
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

export const briefCtx = (ctx: RunContext): string => briefContext(ctx, { select: selectRelevantFiles, cmd: runnerCmd });
export function buildImplementBrief(task: string, plan: string | null, impactedTests: string[], repoMap = ""): string {
  return withStagePrefix([ // FIXED_RULES leads and FINISH_LINE closes, both byte-identical per task
    FIXED_RULES,
    ...taskBlock(task),
    plan ? `Follow this plan:\n${plan}` : "No separate plan was made: plan the change yourself in this session, then implement it.",
    ...(repoMap ? [repoMap] : []),
    impactedTests.length ? `Impacted tests to run: ${impactedTests.join(", ")}.` : "Impacted tests: none known; run the project's full test command.",
    FINISH_LINE,
  ].join("\n\n"));
}

/** Restores any read-only file the session changed or deleted; returns the paths restored, in order given. */
function restoreReadOnly(files: ReadOnlyFile[]): string[] {
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

export const implementStage: Stage = {
  name: "implement",
  targetS: 180,
  limitS: 480,

  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> {
    const prior = ctx.outputs();
    const task = (prior.intake?.task as string | undefined) ?? "";
    const plan = (prior.plan?.plan as string | undefined) ?? null;
    const impacted = impactedTests(ctx);
    const readOnly = (prior.wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? [];
    const cascade = cascadeEnabled(); // E-64: pins this attempt to sonnet (the Wall's E-45 alias); =0 leaves the configured model
    const repoMap = briefCtx(ctx); // S41-10: up to 20 relevant files + impacted test commands, not the first 200 paths

    const session = await ctx.sessions.run({
      stage: "implement",
      brief: buildImplementBrief(task, plan, impacted, repoMap),
      tier: "development",
      iterationId: `${ctx.runId}-impl`,
      limitS: implementStage.limitS,
      signal,
      cwd: ctx.repoDir,
      ...(cascade ? { model: cascadeImplementModel() } : {}),
    });

    const testsReverted = restoreReadOnly(readOnly);
    const iterationId = `${ctx.runId}-impl`;
    // E-68 classifies exit codes; a non-killed, marker-less non-zero exit is an error, never "done".
    let exit: ImplementExit | "error";
    if (session.killed) {
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
      tests_reverted: testsReverted,
      impacted_tests: impacted,
      cascade,
      iteration_ids: [iterationId],
      duration_s: session.durationS,
    };

    if (exit !== "error") return { status: "completed", data };

    const stderrTail = (session as unknown as { stderrTail?: string }).stderrTail ?? "";
    mkdirSync(ctx.runDir, { recursive: true });
    const stderrPath = join(ctx.runDir, `${iterationId}.stderr.log`);
    writeFileSync(stderrPath, stderrTail, "utf8");
    data.stderr_path = stderrPath;

    return { status: "failed", reason: classifyExitCause(session.exit, false), data };
  },
};
export const stage = implementStage;
