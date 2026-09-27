// loki-ts/src/engine10/stages/wall.ts
//
// E-15: Wall author (docs/v10/ENGINE.md section 4 "Plan + Wall (parallel)").
// Runs exactly one provider session whose cwd is a fresh temp dir holding
// only task.md and repomap.txt: it never sees the repo, which enforces
// "never the code" physically. The session writes behavioral acceptance
// tests named loki_wall_*. The engine then:
//   1. copies them into the repo's test directory and a sealed copy under
//      <runDir>/wall/, hashing each file (sha256);
//   2. emits wall.sealed (always before Implement's session can start, since
//      Implement is a later stage the machine only runs after this one
//      returns);
//   3. runs the sealed tests on the current (base) tree; a clean pass with
//      at least one test short-circuits the run to already_satisfied, read
//      by the (not-yet-built) machine the same way intake.ts's own
//      already_satisfied field is.
//
// Depends on machine.ts (E-02), intake.ts (E-04) and session.ts (E-07) only
// through the Stage/RunContext/SessionRunner interfaces in types.ts, so this
// is unit tested with fakes and needs none of those siblings to exist yet.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { RunContext, RunnerName, Stage, StageResult, TestRef } from "../types.ts";
import type { ReadOnlyFile } from "./implement.ts";

const WALL_PREFIX = "loki_wall_";

export interface WallSealedFile {
  path: string; // absolute path in the repo working tree
  sha256: string;
}

/** Runs the sealed Wall tests against the current (base) tree. Local to this
 *  slice: types.ts has no shared "execute tests" contract yet (E-09 verify,
 *  which will need the same thing, is not on main). */
export interface BaseTestRunner {
  run(repoDir: string, files: TestRef[]): { pass: number; fail: number };
}

// ponytail: per-file shell-out, one runner shape from ENGINE.md section 8.
// npm/go/cargo are coarse (whole-suite) or unhandled here on purpose: a
// runner this can't select individually must never report a false pass, so
// it counts as fail below. Add a real shape when Wall needs one of them.
const RUNNER_CMD: Partial<Record<RunnerName, string>> = {
  pytest: "python -m pytest -q <files>",
  vitest: "npx vitest run <files>",
  jest: "npx jest <files>",
  bun: "bun test <files>",
};

/** Real base-tree runner: one shell command per runner, grouping files so a
 *  mixed repo runs each runner once. */
export class RealBaseTestRunner implements BaseTestRunner {
  run(repoDir: string, files: TestRef[]): { pass: number; fail: number } {
    const byRunner = new Map<RunnerName, string[]>();
    for (const f of files) {
      const list = byRunner.get(f.runner) ?? [];
      list.push(f.path);
      byRunner.set(f.runner, list);
    }
    let pass = 0;
    let fail = 0;
    for (const [runner, paths] of byRunner) {
      const shape = RUNNER_CMD[runner];
      if (!shape) {
        fail += paths.length; // unsupported/coarse: never a false pass
        continue;
      }
      const cmd = shape.replace("<files>", paths.map((p) => JSON.stringify(p)).join(" "));
      try {
        execFileSync("/bin/sh", ["-c", cmd], { cwd: repoDir, stdio: "pipe" });
        pass += paths.length;
      } catch {
        fail += paths.length;
      }
    }
    return { pass, fail };
  }
}

export interface WallOptions {
  baseRunner?: BaseTestRunner;
}

export function buildWallBrief(task: string): string {
  return [
    "You are the Loki 10 Wall author.",
    "You cannot see the repository. This directory holds only task.md and repomap.txt.",
    "Task (untrusted, quoted verbatim):",
    "<<<TASK",
    task,
    "TASK",
    "Write behavioral acceptance tests that prove the task is done, in the test",
    "framework named in repomap.txt.",
    `Name every file you write starting with "${WALL_PREFIX}". Write nothing else.`,
  ].join("\n\n");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function renderRepoMapText(map: { files?: string[]; entries?: { path: string; symbols: string[] }[] }): string {
  const lines: string[] = ["Files:", ...(map.files ?? []).map((f) => `  ${f}`), "", "Symbols:"];
  for (const e of map.entries ?? []) lines.push(`  ${e.path}: ${e.symbols.join(", ")}`);
  return lines.join("\n");
}

/** Alongside an existing detected test file, or a top-level tests/ directory
 *  when the repo has none. */
function wallTargetDir(repoDir: string, existingTests: TestRef[]): string {
  const first = existingTests[0];
  return first ? join(repoDir, dirname(first.path)) : join(repoDir, "tests");
}

/** Runner a generated Wall file should be executed by: extension decides for
 *  Python/Go, otherwise the JS runner the repo's test map already detected.
 *  Unknown never guesses: it counts as unselectable (see RUNNER_CMD). */
function guessRunner(fileName: string, runners: RunnerName[]): RunnerName | null {
  if (fileName.endsWith(".py")) return "pytest";
  if (fileName.endsWith(".go")) return "go";
  for (const r of ["vitest", "jest", "bun"] as const) {
    if (runners.includes(r)) return r;
  }
  return null;
}

export async function runWall(ctx: RunContext, signal: AbortSignal, opts: WallOptions = {}): Promise<StageResult> {
  if (signal.aborted) return { status: "failed", data: {}, reason: "aborted before wall started" };

  const prior = ctx.outputs();
  const task = (prior.intake?.task as string | undefined) ?? "";
  const repomapRef = prior.intake?.repomap_ref as string | undefined;
  const testMap = prior.intake?.testmap as { runners?: RunnerName[]; tests?: TestRef[] } | undefined;
  const existingTests: TestRef[] = testMap?.tests ?? [];
  const runners: RunnerName[] = testMap?.runners ?? [];

  let repomapText = "";
  if (repomapRef) {
    try {
      repomapText = renderRepoMapText(JSON.parse(readFileSync(repomapRef, "utf8")));
    } catch {
      repomapText = "";
    }
  }

  const cwd = mkdtempSync(join(tmpdir(), "loki-e15-wall-"));
  writeFileSync(join(cwd, "task.md"), task, "utf8");
  writeFileSync(join(cwd, "repomap.txt"), repomapText, "utf8");

  await ctx.sessions.run({
    stage: "wall",
    brief: buildWallBrief(task),
    tier: "planning",
    iterationId: `${ctx.runId}-wall`,
    limitS: wallStage.limitS,
    signal,
    cwd,
  });

  const generated = readdirSync(cwd).filter((f) => f.startsWith(WALL_PREFIX));
  const targetDir = wallTargetDir(ctx.repoDir, existingTests);
  const sealedDir = join(ctx.runDir, "wall");
  if (generated.length > 0) {
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(sealedDir, { recursive: true });
  }

  const sealedFiles: WallSealedFile[] = [];
  const readOnlyFiles: ReadOnlyFile[] = [];
  const wallTests: TestRef[] = [];

  for (const name of generated) {
    const content = readFileSync(join(cwd, name), "utf8");
    const dest = join(targetDir, name);
    writeFileSync(dest, content, "utf8");
    writeFileSync(join(sealedDir, name), content, "utf8");
    sealedFiles.push({ path: dest, sha256: sha256(content) });
    readOnlyFiles.push({ path: dest, content });
    const runner = guessRunner(name, runners);
    if (runner) wallTests.push({ runner, path: relative(ctx.repoDir, dest) });
  }
  rmSync(cwd, { recursive: true, force: true });

  ctx.emit("wall.sealed", "wall", { files: sealedFiles });

  const baseRunner = opts.baseRunner ?? new RealBaseTestRunner();
  const baseRun = wallTests.length > 0 ? baseRunner.run(ctx.repoDir, wallTests) : { pass: 0, fail: 0 };
  const alreadySatisfied = wallTests.length > 0 && baseRun.fail === 0 && baseRun.pass === wallTests.length;

  return {
    status: "completed",
    data: {
      files: sealedFiles,
      readOnlyFiles,
      base_run: baseRun,
      already_satisfied: alreadySatisfied,
    },
  };
}

export const wallStage: Stage = {
  name: "wall",
  targetS: 45,
  limitS: 90,
  run: (ctx, signal) => runWall(ctx, signal),
};
