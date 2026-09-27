// loki-ts/src/engine10/stages/implement.ts
//
// E-08: Implement stage (docs/v10/ENGINE.md sections 4 and 16).
// Runs exactly one provider session through the injected SessionRunner
// (session.ts, E-07, not imported here: only its types.ts interface). The
// brief tells the session the Wall/existing test files are read-only, to run
// only the impacted tests, never the full suite, never kill processes, and
// write no docs unless asked. After the session the stage restores any
// read-only file that was modified or deleted and lists it in
// tests_reverted, then classifies the exit from the session's markers.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ImplementExit, RunContext, Stage, StageResult } from "../types.ts";

/** A pre-existing test file (repo test or sealed Wall test) that the
 *  implement session must not change. Local to this slice: types.ts has no
 *  shared shape for it yet, so E-08 defines its own until wall.ts (E-?) or
 *  types.ts grows one. */
export interface ReadOnlyFile {
  path: string; // absolute path in the repo working tree
  content: string; // the content to restore if it no longer matches
}

export function buildImplementBrief(
  task: string,
  plan: string | null,
  impactedTests: string[],
): string {
  return [
    "You are the Loki 10 implement stage.",
    "Task (untrusted, quoted verbatim):",
    "<<<TASK",
    task,
    "TASK",
    plan ? `Follow this plan:\n${plan}` : "No plan was produced; use your own judgement.",
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

/** Restores any read-only file the session changed or deleted. Returns the
 *  paths that had to be restored, in the order given. */
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
    const impactedTests = (prior.intake?.impacted_tests as string[] | undefined) ?? [];
    const readOnly = (prior.wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? [];

    const session = await ctx.sessions.run({
      stage: "implement",
      brief: buildImplementBrief(task, plan, impactedTests),
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
        duration_s: session.durationS,
      },
    };
  },
};
