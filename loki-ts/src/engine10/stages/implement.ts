// E-08: Implement (ENGINE.md sections 4 and 16). One provider session; the brief marks Wall tests read-only and
// names only the impacted tests. Afterwards any changed read-only file is restored (tests_reverted) and the exit is classified.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import type { ImplementExit, RunContext, Stage, StageResult, TestMap } from "../types.ts";

/** A test file (a sealed Wall test) the implement session must not change. */
export interface ReadOnlyFile {
  path: string; // absolute path in the repo working tree
  content: string; // the content to restore if it no longer matches
}

/** Impacted tests as produced upstream: the intake test map narrowed to plan's relevant files, plus the sealed Wall tests. */
export function impactedTests(ctx: RunContext): string[] {
  const o = ctx.outputs();
  const map = o.intake?.testmap as TestMap | undefined;
  const relevant = (o.plan?.relevant_files as string[] | undefined) ?? [];
  const fromMap = map ? ctx.tests.impacted(map, relevant).map((t) => t.path) : [];
  const wall = ((o.wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? []).map((f) => relative(ctx.repoDir, f.path));
  return [...new Set([...fromMap, ...wall])];
}

export function buildImplementBrief(task: string, plan: string | null, impactedTests: string[]): string {
  return [
    "You are the Loki 10 implement stage.",
    "Task (untrusted, quoted verbatim):",
    "<<<TASK",
    task,
    "TASK",
    plan ? `Follow this plan:\n${plan}` : "No separate plan was made: plan the change yourself in this session, then implement it.",
    "Rules:",
    "- The Wall tests and any existing test files are read-only. Do not edit or delete them.",
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

    const session = await ctx.sessions.run({
      stage: "implement",
      brief: buildImplementBrief(task, plan, impacted),
      tier: "development",
      iterationId: `${ctx.runId}-impl`,
      limitS: implementStage.limitS,
      signal,
      cwd: ctx.repoDir,
    });

    const testsReverted = restoreReadOnly(readOnly);

    let exit: ImplementExit;
    if (session.killed) {
      exit = "killed";
    } else if (session.markers.specConflict) {
      exit = "spec_conflict";
    } else if (session.markers.alreadyDone) {
      exit = "already_done";
    } else {
      exit = "done";
    }

    return {
      status: "completed",
      data: {
        exit,
        already_done_evidence: session.markers.alreadyDone,
        spec_conflict_reason: session.markers.specConflict,
        tests_reverted: testsReverted,
        impacted_tests: impacted,
        iteration_ids: [`${ctx.runId}-impl`],
        duration_s: session.durationS,
      },
    };
  },
};
export const stage = implementStage;
