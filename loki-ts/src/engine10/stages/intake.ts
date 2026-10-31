// loki-ts/src/engine10/stages/intake.ts -- E-04 Intake (ENGINE.md section 4). Deterministic: dirty-tree refusal, branch creation, .git/info/exclude, the issue already-done check, repo map / test map build, plus one cached Project Model discovery session (EL-W1-01). No PRD. Task arrives as literal text (LOKI_E10_TASK_TEXT) or issue.json (LOKI_E10_ISSUE_JSON, default <runDir>/issue.json); outputs task text, title, repo, resumed for later stages.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { STAGE_BUDGETS, type RunContext, type Stage, type StageResult } from "../types.ts";
import { buildRepoMap } from "../repomap.ts";
import { cachedRepoMap, readTestMapCache, repoCacheDir, repoKey, writeTestMapCache } from "../cache.ts";
import { githubRepoFromUrl, readOriginUrl } from "../supervisor.ts";
import { type AlreadyDoneResult, buildAlreadyDoneCommentArgv, checkAlreadyDone, renderAlreadyDoneComment } from "../already_done.ts";
import { deferAlreadyDone, speedEnabled } from "../../features/speed/already_done_async.ts";
import { hooks } from "../hooks.ts";
import { snapshotContract } from "../../features/contract.ts";
import { probeZeroChecks } from "./verify.ts"; import { stackedOnLokiRun, unmergedEvidence, unmergedEvidenceNote } from "../../util/base_guard.ts";
import { ignoreSnapshot } from "../../util/check_result.ts"; import { intakeProjectModel } from "../../project_model/discover.ts"; import { INSTALL_CAP_MS, intakeDeps, type DepsTiming, type IntakeTiming } from "../../project_model/install.ts"; import { sha256 } from "./seal.ts"; import { splitDirty, untrackedAtIntake, snapshotUntracked } from "../../e10ext/preexisting_dirty.ts";
import { safeGit } from "../../util/safe_git.ts"; import { hiddenRunnerConfigs } from "../../features/runner_config.ts"; import { ensureProfile, readinessNotice, repoReadiness, SUITE_BASELINE_BUDGET_S } from "../../runner/repo_profile.ts";
export interface IntakeOptions { taskText?: string; issueJsonPath?: string; }
interface IssueFields { state: string | null; closed_by_merged_pr?: boolean }
/** owner/repo#number, when the issue JSON carries both (GitHub); null for anything else, never guessed. */
function issueRefOf(raw: { repo?: unknown; number?: unknown }): string | null { return typeof raw.repo === "string" && raw.repo && typeof raw.number === "number" ? `${raw.repo}#${raw.number}` : null; }
function git(repoDir: string, args: string[]): string { return safeGit(repoDir, args).trim(); }
/** Tracked-only dirty check: untracked files never block Intake. */
function dirtyTrackedFiles(repoDir: string): string[] {
  const out = git(repoDir, ["status", "--porcelain", "--untracked-files=no"]); return out === "" ? [] : out.split("\n").filter((l) => !/^[ MADRCU?!]{1,2} (.+)$/.exec(l)?.[1]!.split(" -> ").every((f) => /^"?\.loki\//.test(f))); // FC-LOKI-DIR-DIRT: .loki/ is Loki's own state (excluded from every diff and commit); a repo that once committed it is never dirty through it. The caller's trim can eat line 1's leading space, hence the 1-2 char status
}
function ensureBranch(repoDir: string, branch: string, from?: string): void {
  try { safeGit(repoDir, ["checkout", "-b", branch, ...(from ? [from] : [])], { repoDrivers: true }); } catch {
    // Resume, or the branch already exists for another reason: reuse it.
    safeGit(repoDir, ["checkout", branch], { repoDrivers: true });
  }
}
/** Appends ".loki/" to .git/info/exclude, once. Not .gitignore, so it adds no diff. */
function excludeLokiDir(repoDir: string): void {
  // A linked worktree has a .git FILE; ask git where info/exclude lives (the common dir).
  let path = join(repoDir, ".git", "info", "exclude");
  try { path = resolve(repoDir, git(repoDir, ["rev-parse", "--git-path", "info/exclude"])); } catch { /* keep the plain-checkout path */ }
  const existing = existsSync(path) ? readFileSync(path, "utf8") : ""; if (existing.split("\n").some((l) => l.trim() === ".loki/")) return;
  mkdirSync(dirname(path), { recursive: true }); const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${sep}.loki/\n`);
}
function loadIssue(path: string): IssueFields {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return { state: typeof raw.state === "string" ? raw.state.toLowerCase() : null, closed_by_merged_pr: raw.closed_by_merged_pr === true };
}
/** True only on a deterministic, positive signal: a false negative (state unknown) must never claim already-done. */
function isAlreadyDone(issue: IssueFields): boolean { return issue.state === "closed" || issue.closed_by_merged_pr === true; }
export async function runIntake(ctx: RunContext, signal: AbortSignal, opts: IntakeOptions = {}): Promise<StageResult> {
  const held: { fold: string | null } = { fold: null }; // per call: set only when the supervisor would fold the Readiness line into the last line; a failed intake never reaches that line, so it is printed here
  const flush = (): void => { if (held.fold) process.stderr.write(`${held.fold}\n`); held.fold = null; };
  let r: StageResult;
  try { r = await runIntakeBody(ctx, signal, opts, held); } catch (e) { flush(); throw e; }
  if (r.status === "failed") flush();
  return r;
}
async function runIntakeBody(ctx: RunContext, signal: AbortSignal, opts: IntakeOptions, held: { fold: string | null }): Promise<StageResult> {
  const t0 = Date.now(); if (signal.aborted) return { status: "failed", data: {}, reason: "aborted before intake started" };
  const { blocking: dirty, preexisting } = splitDirty(ctx.repoDir, dirtyTrackedFiles(ctx.repoDir));
  if (dirty.length > 0) return { status: "failed", data: { blocker: "dirty_tracked_tree" }, reason: `dirty tracked tree: ${dirty.join(", ")}` }; // AN-08: the class travels in the stage.failed event
  let baseSha = git(ctx.repoDir, ["rev-parse", "HEAD"]); const startBranch = git(ctx.repoDir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  // FC-STACKED-ON-LOKI-RUN (the success note is the start line plus the stacked_loki_skip event data, never raw stderr): HEAD is an earlier run's unaccepted output (every commit past the PR target is a Loki-Run commit): branch from the PR target tip, leave that branch untouched.
  let stacked = stackedOnLokiRun(ctx.repoDir); if (stacked) { try { ensureBranch(ctx.repoDir, ctx.branch, stacked.base_sha); baseSha = stacked.base_sha; ctx.baseSha = baseSha; } catch { stacked = null; process.stderr.write(`${process.stderr.isTTY ? "\r\x1b[2K" : ""}engine10: skip not applied (checkout failed); base stays HEAD\n`); } } if (!stacked) ensureBranch(ctx.repoDir, ctx.branch);
  // SEAL-ASSUME-02: ignore_snapshot is taken at each return below, after the baseline run (ensureProfile) and the dependency install (intakeDeps): the ignored files Loki itself produced are the start state, only the agent's changes are noted.
  const tree = git(ctx.repoDir, ["rev-parse", "HEAD^{tree}"]); excludeLokiDir(ctx.repoDir);
  const issueJsonPath = opts.issueJsonPath ?? process.env.LOKI_E10_ISSUE_JSON ?? join(ctx.runDir, "issue.json");
  const taskText = opts.taskText ?? process.env.LOKI_E10_TASK_TEXT;
  let source: "text" | "issue"; let taskSha256: string;
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
  const evidence = hooks.runtimeEvidence?.(task) ?? null; // GAME10-08a: pasted traces, request/response pairs and tracker URLs, recorded with a content hash; data only, never run
  const common = { ...(evidence ? { runtime_evidence: evidence } : {}), ...(stacked ? { stacked_loki_skip: stacked } : {}), task, title: task.split("\n")[0]!.slice(0, 72), repo: githubRepoFromUrl(origin) ?? origin, resumed: false, contract_snapshot: snapshotContract(ctx.repoDir), preexisting_untracked: untrackedAtIntake(ctx.repoDir), preexisting_untracked_blobs: snapshotUntracked(ctx.repoDir), ...(Object.keys(preexisting).length > 0 ? { preexisting_dirty: preexisting } : {}) };
  if (alreadySatisfied) {
    // Deterministic exit: no repo/test map needed, and never a session/LLM call.
    return { status: "completed", data: { ...common, ignore_snapshot: ignoreSnapshot(ctx.repoDir), task_sha256: taskSha256, source, base_sha: baseSha, tree, branch: ctx.branch, already_satisfied: true } };
  }
  mkdirSync(ctx.runDir, { recursive: true });
  const repomapRef = join(ctx.runDir, "repomap.json");
  const cacheDir = repoCacheDir(repoKey(null, ctx.repoDir)); // same dir sizing.ts and context.ts read; keyed by HEAD^{tree}, so an unchanged tree skips the repo walk and test detection
  const tm: IntakeTiming = {}, lap = (): (() => number) => { const t = Date.now(); return () => Date.now() - t; }; let walkCached = true; const walkEnd = lap();
  const repoMap = cachedRepoMap(cacheDir, tree, () => { walkCached = false; return buildRepoMap(ctx.repoDir); });
  writeFileSync(repomapRef, JSON.stringify(repoMap));
  let testmap = readTestMapCache(cacheDir, tree);
  if (!testmap) { walkCached = false; testmap = await ctx.tests.detect(ctx.repoDir); try { writeTestMapCache(cacheDir, tree, testmap); } catch { /* an unwritable cache only costs the next run a rebuild */ } }
  tm.repo_walk = { ms: walkEnd(), cached: walkCached }; const baselineEnd = lap(), baselineOn = process.env.LOKI_REPO_BASELINE !== "0";
  const built = baselineOn ? ensureProfile(ctx.repoDir) : null, baselineMs = baselineEnd(); // REPOMEM: commands + a baseline test run on the untouched tree, reused while the manifests are unchanged; never throws
  const readiness = built ? readinessNotice(ctx.repoDir, repoReadiness(built.profile)) : null; // once per repo and score: a repo-config grade is not part of every run's outcome
  if (readiness && process.env.LOKI_E10_READINESS_FOLD === "1") held.fold = readiness;
  else if (readiness) process.stderr.write(`${readiness}\n`); // FV-readiness-env-3; D48 default mode: the supervisor folds it into the last line instead
  // E-66: "already implemented" as a first-class outcome. A deterministic evidence search over repoMap/testmap/CHANGELOG, confirmed by one short cheap-model session that must cite files; no candidate evidence means no session call (checkAlreadyDone's own gate).
  const already = speedEnabled() ? null : await checkAlreadyDone(ctx, signal, task, repoMap, testmap); // D61-04: LOKI_SPEED=1 defers it past intake
  const alreadyData = (already: AlreadyDoneResult): Record<string, unknown> => {
    // The comment always exists (there is always something to tell the operator once evidence confirms no change is needed); only an issue run has somewhere to post it, so only that case gets an
    // argv. A text run gets the same body, but printed by the CLI (main(), below) instead -- posting an issue comment for a run with no issue would be meaningless.
    const comment = renderAlreadyDoneComment(already.evidence);
    const bodyFile = join(ctx.runDir, "already-done-comment.md");
    writeFileSync(bodyFile, comment, "utf8");
    const commentArgv = source === "issue" && issueRef ? buildAlreadyDoneCommentArgv(ctx.runId, issueRef, bodyFile) : undefined;
    return { already_satisfied: true, evidence: already.evidence, iteration_ids: [`${ctx.runId}-already-done`], comment, ...(commentArgv ? { comment_argv: commentArgv } : {}) };
  };
  const base = { ...common, task_sha256: taskSha256, source, base_sha: baseSha, tree, branch: ctx.branch, ...(readiness ? { readiness } : {}) };
  // FC-15: the claim rests on the PR target. Evidence only in target..HEAD means no claim; Loki's own work there is reported, never refused.
  const stale = already ? unmergedEvidence(ctx.repoDir, already.paths, startBranch) : null;
  if (already && !stale) return { status: "completed", data: { ...base, ignore_snapshot: ignoreSnapshot(ctx.repoDir), ...alreadyData(already) } };
  if (stale) process.stderr.write(`engine10: ${stale.lokiOwn ? unmergedEvidenceNote(stale) : `evidence for the task is on ${stale.branch ?? "HEAD"} but not on ${stale.target}; implementing`}\n`); // L5/L6: the operator sees it when the run goes on to implement
  const pmEnd = lap(), pm = await intakeProjectModel(ctx, signal, t0, testmap); tm.project_model = Object.keys(pm).length ? { ms: pmEnd(), cached: (pm["project_model"] as { cached?: boolean }).cached === true } : { skipped: "project model disabled or unavailable" }; const dt: DepsTiming = {}, depsData = await intakeDeps(ctx, signal, testmap.runners, dt);
  tm.deps_install = dt.install ?? { skipped: "install step did not run" }; tm.suite_baseline = baselineOn ? { ms: baselineMs + (dt.baseline_ms ?? 0), cached: built?.reused ?? false } : { skipped: "LOKI_REPO_BASELINE=0" };
  const zeroEnd = lap(), zero_baseline = await probeZeroChecks(ctx.repoDir, testmap.tests, signal); tm.zero_probe = testmap.tests.length ? { ms: zeroEnd() } : { skipped: "no detected test files" };
  const data = { ...base, ...(stale?.lokiOwn ? { unmerged_loki_work: { branch: stale.branch, target: stale.target, commits: stale.commits, message: unmergedEvidenceNote(stale) } } : {}), ...pm, ...depsData, zero_baseline, hidden_cfg: (() => { try { return hiddenRunnerConfigs(ctx.repoDir); } catch { return null; } })(), ignore_snapshot: ignoreSnapshot(ctx.repoDir), intake_timing: tm, repomap_ref: repomapRef, testmap, already_satisfied: false };
  if (speedEnabled()) deferAlreadyDone(ctx, signal, task, repoMap, testmap, (a) => { if (unmergedEvidence(ctx.repoDir, a.paths, startBranch)) throw new Error("evidence not on the PR target"); Object.assign(data, alreadyData(a)); });
  return { status: "completed", data };
}
export const stage: Stage = {
  name: "intake",
  ...STAGE_BUDGETS.intake, limitS: STAGE_BUDGETS.intake.limitS + INSTALL_CAP_MS / 1000 + SUITE_BASELINE_BUDGET_S + 120, // one table (types.ts); discovery gets what remains of its limit, plus the FC-DEPS-NOT-INSTALLED install and per-command baseline caps
  run: (ctx, signal) => runIntake(ctx, signal),
};
