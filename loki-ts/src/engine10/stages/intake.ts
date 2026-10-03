// loki-ts/src/engine10/stages/intake.ts -- E-04 Intake (ENGINE.md section 4). Deterministic:
// dirty-tree refusal, branch creation, .git/info/exclude, the issue already-done check, repo map /
// test map build. No LLM call, no PRD. Task arrives as literal text (LOKI_E10_TASK_TEXT) or
// issue.json (LOKI_E10_ISSUE_JSON, default <runDir>/issue.json); outputs task text, title, repo,
// resumed for later stages.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RunContext, Stage, StageResult } from "../types.ts";
import { buildRepoMap } from "../repomap.ts";
import { githubRepoFromUrl, readOriginUrl } from "../supervisor.ts";
import { type AlreadyDoneResult, buildAlreadyDoneCommentArgv, checkAlreadyDone, renderAlreadyDoneComment } from "../already_done.ts";
import { deferAlreadyDone, speedEnabled } from "../../features/speed/already_done_async.ts";
import { snapshotContract } from "../../features/contract.ts";
import { sha256 } from "./seal.ts"; import { splitDirty, untrackedAtIntake, snapshotUntracked } from "../../e10ext/preexisting_dirty.ts";
export interface IntakeOptions {
  taskText?: string;
  issueJsonPath?: string;
}
interface IssueFields {
  state: string | null;
  closed_by_merged_pr?: boolean;
}
/** owner/repo#number, when the issue JSON carries both (GitHub); null for anything else, never guessed. */
function issueRefOf(raw: { repo?: unknown; number?: unknown }): string | null {
  return typeof raw.repo === "string" && raw.repo && typeof raw.number === "number" ? `${raw.repo}#${raw.number}` : null;
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
  // A linked worktree has a .git FILE; ask git where info/exclude lives (the common dir).
  let path = join(repoDir, ".git", "info", "exclude");
  try {
    path = resolve(repoDir, git(repoDir, ["rev-parse", "--git-path", "info/exclude"]));
  } catch { /* keep the plain-checkout path */ }
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.split("\n").some((l) => l.trim() === ".loki/")) return;
  mkdirSync(dirname(path), { recursive: true });
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${sep}.loki/\n`);
}
function loadIssue(path: string): IssueFields {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return { state: typeof raw.state === "string" ? raw.state.toLowerCase() : null, closed_by_merged_pr: raw.closed_by_merged_pr === true };
}
/** True only on a deterministic, positive signal: a false negative (state
 *  unknown) must never claim already-done. */
function isAlreadyDone(issue: IssueFields): boolean {
  return issue.state === "closed" || issue.closed_by_merged_pr === true;
}
export async function runIntake(ctx: RunContext, signal: AbortSignal, opts: IntakeOptions = {}): Promise<StageResult> {
  if (signal.aborted) return { status: "failed", data: {}, reason: "aborted before intake started" };
  const { blocking: dirty, preexisting } = splitDirty(ctx.repoDir, dirtyTrackedFiles(ctx.repoDir));
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
  let task = taskText ?? "";
  let alreadySatisfied = false;
  let issueRef: string | null = null;
  if (existsSync(issueJsonPath)) {
    source = "issue";
    const raw = readFileSync(issueJsonPath, "utf8");
    taskSha256 = sha256(raw);
    const i = JSON.parse(raw) as { title?: unknown; body?: unknown; repo?: unknown; number?: unknown };
    task = [i.title, i.body].filter((x) => typeof x === "string" && x !== "").join("\n\n");
    alreadySatisfied = isAlreadyDone(loadIssue(issueJsonPath));
    issueRef = issueRefOf(i);
  } else if (taskText !== undefined) {
    source = "text";
    taskSha256 = sha256(taskText);
  } else {
    return { status: "failed", data: {}, reason: "no task text and no issue.json: nothing to intake" };
  }
  const origin = readOriginUrl(ctx.repoDir);
  // resumed is constant false: the engine has no resume.
  const common = { task, title: task.split("\n")[0]!.slice(0, 72), repo: githubRepoFromUrl(origin) ?? origin, resumed: false, contract_snapshot: snapshotContract(ctx.repoDir), preexisting_untracked: untrackedAtIntake(ctx.repoDir), preexisting_untracked_blobs: snapshotUntracked(ctx.repoDir), ...(Object.keys(preexisting).length > 0 ? { preexisting_dirty: preexisting } : {}) };
  if (alreadySatisfied) {
    // Deterministic exit: no repo/test map needed, and never a session/LLM call.
    return { status: "completed", data: { ...common, task_sha256: taskSha256, source, base_sha: baseSha, tree, branch: ctx.branch, already_satisfied: true } };
  }
  mkdirSync(ctx.runDir, { recursive: true });
  const repomapRef = join(ctx.runDir, "repomap.json");
  const repoMap = buildRepoMap(ctx.repoDir);
  writeFileSync(repomapRef, JSON.stringify(repoMap));
  const testmap = await ctx.tests.detect(ctx.repoDir);
  // E-66: "already implemented" as a first-class outcome. A deterministic evidence search over
  // repoMap/testmap/CHANGELOG, confirmed by one short cheap-model session that must cite files;
  // no candidate evidence means no session call (checkAlreadyDone's own gate).
  const already = speedEnabled() ? null : await checkAlreadyDone(ctx, signal, task, repoMap, testmap); // D61-04: LOKI_SPEED=1 defers it past intake
  const alreadyData = (already: AlreadyDoneResult): Record<string, unknown> => {
    // The comment always exists (there is always something to tell the operator once evidence
    // confirms no change is needed); only an issue run has somewhere to post it, so only that case
    // gets an argv. A text run gets the same body, but printed by the CLI (main(), below) instead --
    // posting an issue comment for a run with no issue would be meaningless.
    const comment = renderAlreadyDoneComment(already.evidence);
    const bodyFile = join(ctx.runDir, "already-done-comment.md");
    writeFileSync(bodyFile, comment, "utf8");
    const commentArgv = source === "issue" && issueRef ? buildAlreadyDoneCommentArgv(ctx.runId, issueRef, bodyFile) : undefined;
    return { already_satisfied: true, evidence: already.evidence, iteration_ids: [`${ctx.runId}-already-done`], comment, ...(commentArgv ? { comment_argv: commentArgv } : {}) };
  };
  const base = { ...common, task_sha256: taskSha256, source, base_sha: baseSha, tree, branch: ctx.branch };
  if (already) return { status: "completed", data: { ...base, ...alreadyData(already) } };
  const data = { ...base, repomap_ref: repomapRef, testmap, already_satisfied: false };
  if (speedEnabled()) deferAlreadyDone(ctx, signal, task, repoMap, testmap, (a) => { Object.assign(data, alreadyData(a)); });
  return { status: "completed", data };
}
export const intakeStage: Stage = {
  name: "intake",
  targetS: 15,
  limitS: 60,
  run: (ctx, signal) => runIntake(ctx, signal),
};
export const stage = intakeStage;
