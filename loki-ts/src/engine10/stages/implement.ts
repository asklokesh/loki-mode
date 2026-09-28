// E-08: Implement (ENGINE.md 4, 16). One session; the brief marks Wall tests read-only, names only the impacted tests. Afterwards any changed read-only file is restored (tests_reverted) and the exit is classified.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cascadeEnabled, cascadeImplementModel, loadRepoMap, namedFiles, repoMapText } from "../sizing.ts";
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

export function buildImplementBrief(task: string, plan: string | null, impactedTests: string[], repoMap = ""): string {
  return [
    "You are the Loki 10 implement stage.",
    ...taskBlock(task),
    plan ? `Follow this plan:\n${plan}` : "No separate plan was made: plan the change yourself in this session, then implement it.",
    ...(repoMap ? [`Repository paths (repomap.txt):\n${repoMap}`] : []),
    "Rules:",
    "- The Wall tests are read-only: do not edit or delete them. Existing test files are append-only: you may add new test functions, but never edit or delete an existing one.",
    `- Run only these impacted tests: ${impactedTests.length ? impactedTests.join(", ") : "(none known)"}.`,
    "- Never run the full test suite, an E2E suite, or a long-lived server.",
    "- Never kill processes.",
    "- Write no documentation unless the task explicitly asks for it.",
    "- Do not commit or push.",
    "Finish with exactly one line: LOKI_DONE, or LOKI_ALREADY_DONE: <file:line evidence>, " +
      "or LOKI_SPEC_CONFLICT: <reason>.",
  ].join("\n\n");
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
    const repoMap = repoMapText(ctx.repoDir, prior.intake?.tree as string | undefined, prior.intake?.repomap_ref as string | undefined); // E-64: cached repo map, same source as Wall's brief

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

    // E-68 already classifies exit codes; this only adds the missing branch: a session that
    // neither was killed nor left a marker but exited non-zero is an error, never "done"
    // (incident: implement reported done after exit "error" in 1s with 0 tokens).
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
