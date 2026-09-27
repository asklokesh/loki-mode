// loki-ts/src/engine10/stages/intake.ts
//
// E-04: Intake (ENGINE.md section 4 "Intake (no PRD, no LLM)"). Deterministic:
// dirty-tree refusal, branch creation, .git/info/exclude, the issue already-
// done check, and the repo map / test map build. No LLM call, no PRD.
//
// Depends on machine.ts (E-02) and testmap.ts (E-05) ONLY through the
// RunContext/TestMapProvider interfaces in types.ts (E-01), so this is unit
// tested with fakes and needs neither sibling to exist yet.
//
// Contract-gap note: RunContext (types.ts) carries no task/issue field, so
// where the task comes from is a local convention here, documented in the
// report: literal text via IntakeOptions.taskText (or LOKI_E10_TASK_TEXT),
// or an issue.json path via IntakeOptions.issueJsonPath (or
// LOKI_E10_ISSUE_JSON, default "<runDir>/issue.json" per section 4 step 5).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { RunContext, Stage, StageResult } from "../types.ts";
import { buildRepoMap } from "../repomap.ts";

export interface IntakeOptions {
  taskText?: string;
  issueJsonPath?: string;
}

interface IssueFields {
  state: string | null;
  closed_by_merged_pr?: boolean;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", env: process.env }).trim();
}

/** Tracked-only dirty check: untracked files never block Intake. */
function dirtyTrackedFiles(repoDir: string): string[] {
  const out = git(repoDir, ["status", "--porcelain", "--untracked-files=no"]);
  return out === "" ? [] : out.split("\n");
}

function ensureBranch(repoDir: string, branch: string): void {
  try {
    execFileSync("git", ["checkout", "-b", branch], { cwd: repoDir, stdio: "pipe", env: process.env });
  } catch {
    // Resume, or the branch already exists for another reason: reuse it.
    execFileSync("git", ["checkout", branch], { cwd: repoDir, stdio: "pipe", env: process.env });
  }
}

/** Appends ".loki/" to .git/info/exclude, once. Not .gitignore, so it adds no diff. */
function excludeLokiDir(repoDir: string): void {
  const path = join(repoDir, ".git", "info", "exclude");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.split("\n").some((l) => l.trim() === ".loki/")) return;
  mkdirSync(dirname(path), { recursive: true });
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${sep}.loki/\n`);
}

function loadIssue(path: string): IssueFields {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return {
    state: typeof raw.state === "string" ? raw.state.toLowerCase() : null,
    closed_by_merged_pr: raw.closed_by_merged_pr === true,
  };
}

/** True only on a deterministic, positive signal: a false negative (state
 *  unknown) must never claim already-done. */
function isAlreadyDone(issue: IssueFields): boolean {
  return issue.state === "closed" || issue.closed_by_merged_pr === true;
}

export async function runIntake(ctx: RunContext, signal: AbortSignal, opts: IntakeOptions = {}): Promise<StageResult> {
  if (signal.aborted) return { status: "failed", data: {}, reason: "aborted before intake started" };

  const dirty = dirtyTrackedFiles(ctx.repoDir);
  if (dirty.length > 0) {
    return { status: "failed", data: {}, reason: `dirty tracked tree: ${dirty.join(", ")}` };
  }

  const baseSha = git(ctx.repoDir, ["rev-parse", "HEAD"]);
  const tree = git(ctx.repoDir, ["rev-parse", "HEAD^{tree}"]);
  ensureBranch(ctx.repoDir, ctx.branch);
  excludeLokiDir(ctx.repoDir);

  const issueJsonPath = opts.issueJsonPath ?? process.env.LOKI_E10_ISSUE_JSON ?? join(ctx.runDir, "issue.json");
  const taskText = opts.taskText ?? process.env.LOKI_E10_TASK_TEXT;

  let source: "text" | "issue";
  let taskSha256: string;
  let alreadySatisfied = false;
  if (existsSync(issueJsonPath)) {
    source = "issue";
    const raw = readFileSync(issueJsonPath, "utf8");
    taskSha256 = sha256(raw);
    alreadySatisfied = isAlreadyDone(loadIssue(issueJsonPath));
  } else if (taskText !== undefined) {
    source = "text";
    taskSha256 = sha256(taskText);
  } else {
    return { status: "failed", data: {}, reason: "no task text and no issue.json: nothing to intake" };
  }

  if (alreadySatisfied) {
    // Deterministic exit: no repo/test map needed, and never a session/LLM call.
    return {
      status: "completed",
      data: { task_sha256: taskSha256, source, base_sha: baseSha, tree, branch: ctx.branch, already_satisfied: true },
    };
  }

  mkdirSync(ctx.runDir, { recursive: true });
  const repomapRef = join(ctx.runDir, "repomap.json");
  writeFileSync(repomapRef, JSON.stringify(buildRepoMap(ctx.repoDir)));
  const testmap = await ctx.tests.detect(ctx.repoDir);

  return {
    status: "completed",
    data: {
      task_sha256: taskSha256,
      source,
      base_sha: baseSha,
      tree,
      branch: ctx.branch,
      repomap_ref: repomapRef,
      testmap,
      already_satisfied: false,
    },
  };
}

export const intakeStage: Stage = {
  name: "intake",
  targetS: 15,
  limitS: 60,
  run: (ctx, signal) => runIntake(ctx, signal),
};
